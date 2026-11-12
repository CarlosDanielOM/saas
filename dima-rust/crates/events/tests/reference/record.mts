// Records what the reference journal really writes, for `tests/recorded.rs`: the real producers
// (`ingestDomainEvent` with the Twitch, Polar and custom goal producers, `journalDomainEvent`),
// the real dispatcher (`dispatchDomainEvents` over `DOMAIN_EVENT_CONSUMERS`) and the real durable
// cron-job intents (`createDurableCronJobs`), run against a throwaway MongoDB database.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DOMAIN_EVENTS_WAKEUPS_ENABLED=false node_modules/.bin/tsx \
//     /path/to/dima-rust/crates/events/tests/reference/record.mts \
//     /path/to/dima-rust/crates/events/tests/fixtures/recorded.json
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference
// (commit 0c71108e). The script works in `dima_test_events_rec_<random>` and drops it at the end,
// also after a failure. Dragonfly is never touched: wakeups are disabled and the cron intents get
// a recording stand-in for the cache (only the arguments are recorded).
//
// Determinism: the clock is frozen at NOW_MS while a case runs (and moved explicitly in the
// cron-intent scenario); the Rust test writes at the same instants. Inputs are recorded as they
// were given, so the random parts of `generateTestPayload` are recorded once. Values that JSON
// cannot hold are tagged: `{"$date": ms | "NaN"}`, `{"$undefined": true}`,
// `{"$number": "NaN" | "Infinity" | "-Infinity" | "-0"}`. Stored documents are read without
// promotion and written as canonical Extended JSON (stored types kept); generated ObjectIds are left as stored and mapped by the Rust test.
import { createHash, randomInt } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const NOW_MS = Date.UTC(2026, 10, 11, 10, 20, 30, 456);
let frozen: number | null = null;
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0) super(frozen ?? RealDate.now());
        else super(...(args as [any]));
    }
    static now() {
        return frozen ?? RealDate.now();
    }
}
Object.defineProperty(FrozenDate, 'name', { value: 'Date' });
(globalThis as any).Date = FrozenDate;

const out = process.argv[2];
if (!out) throw new Error('usage: record.mts <out.json>');
if (process.env.TZ !== 'UTC') throw new Error('run with TZ=UTC');
if (process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED !== 'false') throw new Error('run with DOMAIN_EVENTS_WAKEUPS_ENABLED=false');
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');
const root = process.cwd();
const imported = async (file: string) => import(pathToFileURL(path.join(root, file)).href);
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
const { EJSON, ObjectId } = mongoose.mongo.BSON;

const database = `dima_test_events_rec_${randomInt(1e9)}`;
const loaded = new Set<string>();
const load = async (file: string) => { loaded.add(file); return imported(file); };

function encode(value: unknown): unknown {
    if (value === undefined) return { $undefined: true };
    if (value === null) return null;
    if (value instanceof RealDate) return { $date: Number.isFinite(value.getTime()) ? value.getTime() : 'NaN' };
    if (typeof value === 'number') {
        if (Object.is(value, -0)) return { $number: '-0' };
        return Number.isFinite(value) ? value : { $number: String(value) };
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(encode);
    if (typeof value === 'object') {
        if ((value as any)._bsontype === 'ObjectId') return { $oid: String(value) };
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, encode(v)]));
    }
    throw new Error(`cannot record a ${typeof value}`);
}
const canonical = (doc: unknown) => JSON.parse(EJSON.stringify(doc, { relaxed: false }));
// Stored BSON types as stored: without promotion, EJSON prints each value's real type.
const RAW = { promoteValues: false, promoteLongs: false, promoteBuffers: false };
const failure = (error: unknown) => ({ name: (error as Error)?.name ?? 'Error', message: (error as Error)?.message ?? String(error) });

await mongoose.connect(uri, { dbName: database });
const result: Record<string, unknown> = { nowMs: NOW_MS, database: 'dima_test_events_rec_<random>' };
try {
    const { DOMAIN_EVENT_PRODUCERS, ingestDomainEvent } = await load('src/domain_events/domain_event_producers.ts');
    const { normalizeTwitchEventsubDomainEvent } = await load('src/domain_events/twitch_eventsub_events.ts');
    const { normalizePolarDomainEvent } = await load('src/domain_events/polar_events.ts');
    const { customGoalProducer, ingestCustomGoalContribution } = await load('src/domain_events/goal_custom_events.ts');
    const { journalDomainEvent } = await load('src/utils/domain_events.ts');
    const { dispatchDomainEvents } = await load('src/utils/domain_event_consumer.ts');
    const { DOMAIN_EVENT_CONSUMERS } = await load('src/domain_events/domain_event_consumers.ts');
    const { generateTestPayload } = await load('src/utils/eventsub.test-data.ts');
    const { restoreContext } = await load('src/utils/observability/telemetry.ts');
    const { DomainEventSchema } = await load('src/schemas/domain_event.schema.ts');
    const { DomainEventDeliverySchema } = await load('src/schemas/domain_event_delivery.schema.ts');
    const UsersSchema = (await load('src/schemas/users.schema.ts')).default;
    const { createDurableCronJobs } = await load('src/utils/durable_cron_jobs.ts');
    const { CronJobIntentSchema } = await load('src/schemas/cron_job_intent.schema.ts');
    await Promise.all([DomainEventSchema.init(), DomainEventDeliverySchema.init(), CronJobIntentSchema.init()]);

    // Owners: raw inserts, so the Rust test seeds the same documents.
    const externalId = '0123456789abcdef01234567';
    const users = [
        { _id: new ObjectId('64b000000000000000000001'), accounts: [{ type: 'twitch', id: '1001' }], polar_sh_customer_id: null },
        { _id: new ObjectId('64b000000000000000000002'), accounts: [], polar_sh_customer_id: 'customer-linked' },
        { _id: new ObjectId(externalId), accounts: [], polar_sh_customer_id: null },
        { _id: new ObjectId('64b000000000000000000004'), accounts: [{ type: 'twitch', id: 'legacy-twitch-id' }], polar_sh_customer_id: '' },
        { _id: new ObjectId('64b000000000000000000005'), accounts: [], polar_sh_customer_id: 'customer-other' }
    ];
    await UsersSchema.collection.insertMany(users);
    result.users = users.map(canonical);

    type Case = { name: string; kind: 'twitch' | 'polar' | 'goal' | 'journal'; input: any; observability?: any };
    const cases: Case[] = [];
    frozen = NOW_MS;
    // Every journaled subscription type, from the reference's own fixture generator.
    const { TWITCH_DOMAIN_EVENT_TYPES } = await load('src/domain_events/domain_event_contracts.ts');
    for (const type of Object.keys(TWITCH_DOMAIN_EVENT_TYPES)) {
        const fixture = generateTestPayload(['channel.cheer', 'channel.bit.use'].includes(type) ? 'channel.bits.use' : type, '1001');
        fixture.subscription.type = type;
        cases.push({ name: `fixture ${type}`, kind: 'twitch', input: {
            messageId: `fixture-${type}`, messageTimestamp: '2026-11-11T10:20:29.123456789Z', messageRetry: 0, staleRetry: false,
            subscription: fixture.subscription, event: fixture.event, durableChatHandled: true, durableDefenseHandled: true
        } });
    }
    const twitch = (name: string, input: any) => cases.push({ name, kind: 'twitch', input });
    twitch('bits from the tests', { messageId: 'message-1', messageTimestamp: '2026-08-28T10:00:00Z',
        subscription: { id: 'sub-1', type: 'channel.bits.use', version: '1' }, event: { broadcaster_user_id: '1234', bits: 500, user_id: '5678' } });
    twitch('the same bits again', { messageId: 'message-1', messageTimestamp: '2026-08-28T10:00:00Z',
        subscription: { id: 'sub-1', type: 'channel.bits.use', version: '1' }, event: { broadcaster_user_id: '1234', bits: 500, user_id: '5678' } });
    twitch('gift without a timestamp', { messageId: 'message-2', subscription: { type: 'channel.subscription.gift', version: '1' },
        event: { broadcaster_user_id: '1234', total: 50, tier: '1000' } });
    twitch('stream online', { messageId: 'message-3', subscription: { type: 'stream.online', version: '1' },
        event: { id: 'stream-9', broadcaster_user_id: '1234', started_at: '2026-08-28T11:00:00Z' } });
    twitch('chat message is not journaled', { messageId: 'message-4', subscription: { type: 'channel.chat.message', version: '1' },
        event: { broadcaster_user_id: '1234', message: { text: 'hello' } } });
    twitch('follow without a channel', { messageId: 'message-5', subscription: { type: 'channel.follow', version: '2' }, event: { user_id: '5678' } });
    twitch('raid received', { messageId: 'raid-receipt', messageTimestamp: '2026-09-05T12:00:00Z', durableDefenseHandled: true,
        subscription: { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '1001', from_broadcaster_user_id: '' } },
        event: { to_broadcaster_user_id: '1001', from_broadcaster_user_id: 'raider', viewers: 12 } });
    twitch('raid sent', { messageId: 'raid-sent', messageTimestamp: '2026-09-05T12:00:01Z', durableDefenseHandled: true, durableChatHandled: true,
        subscription: { type: 'channel.raid', version: '1', condition: { from_broadcaster_user_id: '1001' } },
        event: { to_broadcaster_user_id: '2002', from_broadcaster_user_id: '1001', viewers: 3 } });
    twitch('stale retry of a follow', { messageId: 'message-stale-retry', messageTimestamp: '2026-08-28T10:00:00Z', messageRetry: 2, staleRetry: true,
        subscription: { type: 'channel.follow', version: '2' }, event: { broadcaster_user_id: '1234', user_id: '5678', followed_at: '2026-08-28T09:59:59.987654321Z' } });
    twitch('test source', { messageId: 'test-1', source: 'twitch-eventsub-test', messageTimestamp: '2026-08-28T10:00:00Z', durableDefenseHandled: true,
        subscription: { type: 'channel.follow', version: '2' }, event: { broadcaster_user_id: '1001', user_id: '5678' } });
    twitch('invalid source', { messageId: 'x', source: 'other', subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: '1' } });
    twitch('blank message id', { messageId: ' ', subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: '1' } });
    twitch('missing subscription type', { messageId: 'x', subscription: {}, event: { broadcaster_user_id: '1' } });
    twitch('event is an array', { messageId: 'x', subscription: { type: 'channel.follow' }, event: [] });
    twitch('shared chat copy is not journaled', { messageId: 'shared', subscription: { type: 'channel.chat.notification', version: '1' },
        event: { broadcaster_user_id: '1001', source_broadcaster_user_id: '2002' } });
    twitch('contract failure at ingest', { messageId: 'bad-bits', messageTimestamp: '2026-08-28T10:00:00Z',
        subscription: { type: 'channel.cheer', version: '1' }, event: { broadcaster_user_id: '1234', bits: 0 } });
    twitch('emoji and right-to-left text kept as sent', { messageId: 'unicode-👋', messageTimestamp: '2026-08-28T10:00:00.5+02:00',
        subscription: { id: 'sub-ü', type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: '1001' }, cost: 0 },
        event: { broadcaster_user_id: '1001', user_id: '77', user_name: 'שלום 👋🏽', tier: '1000', cumulative_months: 3,
            message: { text: 'é́ مرحبا', emotes: [] }, nested: {}, list: [{}], big: 3000000000, half: 0.5, '10': 'index', '2': 'index' } });
    twitch('numeric broadcaster id', { messageId: 'numeric', messageTimestamp: '2026-08-28T10:00:00Z',
        subscription: { type: 'stream.offline', version: '1' }, event: { broadcaster_user_id: 1001 } });
    twitch('offset message timestamp', { messageId: 'offset', messageTimestamp: '2026-08-28T12:00:00.999999+02:00',
        subscription: { type: 'channel.subscription.end', version: '1' }, event: { broadcaster_user_id: '1001', user_id: '9', tier: 'Prime' } });
    cases.push({ name: 'with a trace context', kind: 'twitch', observability: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true, channel: '1001' }, input: {
        messageId: 'traced', messageTimestamp: '2026-08-28T10:00:00Z', subscription: { type: 'stream.offline', version: '1' }, event: { broadcaster_user_id: '1001' } } });

    // Polar, SDK-shaped as in `polar_events.test.ts`.
    const timestamp = new Date('2026-09-04T10:00:00Z');
    const periodEnd = new Date('2027-09-04T10:00:00Z');
    const order = { id: 'order-1', customerId: 'customer-1', productId: 'product-1', subscriptionId: 'subscription-1', paid: true, status: 'paid', totalAmount: 600 };
    const subscription = { id: 'subscription-1', customerId: 'customer-1', productId: 'product-1', status: 'active', recurringInterval: 'year', currentPeriodEnd: periodEnd, endsAt: null, endedAt: null };
    const polar = (name: string, webhookId: string, type: any, data: unknown, at: unknown = timestamp) =>
        cases.push({ name, kind: 'polar', input: { webhookId, event: { type, timestamp: at, data } } });
    polar('paid order', 'wh-1', 'order.paid', { ...order, subscription,
        customer: { id: 'customer-1', externalId, email: 'private@example.test', metadata: { twitch_id: 'twitch-1' } },
        metadata: { twitch_id: 'twitch-2', externalId: 'not-the-owner' }, product: { name: 'Monthly Premium' }, billingName: 'Private Name' });
    polar('paid order again', 'wh-1', 'order.paid', { ...order, subscription, customer: { id: 'customer-1', externalId } });
    polar('one-time order', 'wh-2', 'order.paid', { ...order, customerId: 'customer-linked', subscriptionId: null, productId: null, subscription: null, metadata: { twitch_id: 'twitch-1' } });
    polar('zero trial', 'wh-3', 'order.paid', { ...order, customerId: 'customer-other', totalAmount: 0, subscription });
    polar('negative amount', 'wh-4', 'order.paid', { ...order, totalAmount: -1, subscription });
    polar('legacy twitch hint', 'wh-5', 'order.paid', { ...order, customerId: 'customer-legacy', subscription, customer: { metadata: { twitch_user_id: 'legacy-twitch-id' } } });
    polar('subscription updated', 'wh-6', 'subscription.updated', { ...subscription, recurringInterval: 'month', customer: { externalId, email: 'private@example.test' } });
    polar('canceled subscription', 'wh-7', 'subscription.updated', { ...subscription, status: 'canceled', endsAt: null, endedAt: new Date('2026-09-05T10:00:00Z') });
    polar('weekly interval', 'wh-8', 'subscription.updated', { ...subscription, recurringInterval: 'week' });
    polar('customer state', 'wh-9', 'customer.state_changed', { id: 'customer-1', externalId, email: 'private@example.test',
        activeMeters: [{ id: 'customer-meter-1', createdAt: timestamp, modifiedAt: null, meterId: 'meter-1', consumedUnits: 12.5, creditedUnits: 10, balance: -2.5 }],
        metadata: { twitch_id: 'twitch-1' }, activeSubscriptions: [{ ...subscription, trialStart: new Date('2026-08-01T00:00:00Z'), trialEnd: null }],
        grantedBenefits: [{ id: 'grant-1', benefitId: 'benefit-1', secret: 'omit' }] });
    polar('customer state, legacy meters only', 'wh-10', 'customer.state_changed', { id: 'customer-unknown', activeMeters: [{ meterId: 'meter-1', balance: 0 }] });
    polar('partial entitlements', 'wh-11', 'customer.state_changed', { id: 'customer-1', activeMeters: [], activeSubscriptions: [] });
    polar('unmapped product', 'wh-12', 'product.created', { id: 'product-1', createdAt: timestamp, nested: { dates: [periodEnd] }, name: 'New Product', absent: undefined });
    polar('unmapped order refund', 'wh-13', 'order.refunded', { id: 'order-1', customerId: 'customer-1', customer: { externalId } });
    polar('unmapped customer update', 'wh-14', 'customer.updated', { id: 'customer-1', externalId });
    polar('unmapped checkout', 'wh-15', 'checkout.updated', { id: 'checkout-1', customer: { id: 'customer-1', externalId } });
    polar('benefit grant cycled', 'wh-16', 'benefit_grant.cycled', { id: 'grant-9', customerId: 'customer-linked', customer: { id: 'customer-linked', externalId } });
    polar('lossy provider data', 'wh-17', 'product.created', { id: 'product', value: Number.MAX_SAFE_INTEGER + 1 });
    polar('invalid timestamp', 'wh-18', 'product.created', { id: 'product' }, new Date(NaN));
    polar('blank webhook id', ' ', 'product.created', { id: 'product' });
    polar('customer id mismatch', 'wh-19', 'order.paid', { ...order, subscription, customer: { id: 'other' } });

    const goal = (name: string, input: any) => cases.push({ name, kind: 'goal', input });
    goal('goal contribution', { channelID: '123', receiptIdentity: JSON.stringify(['origin', 'chat', 'm-1', 'add']), itemKey: 'sticker', quantity: 3, occurredAt: new Date('2026-01-01T00:00:00Z') });
    goal('same receipt again', { channelID: '123', receiptIdentity: JSON.stringify(['origin', 'chat', 'm-1', 'add']), itemKey: 'sticker', quantity: 3, occurredAt: new Date('2026-01-02T00:00:00Z') });
    goal('same receipt, other quantity', { channelID: '123', receiptIdentity: JSON.stringify(['origin', 'chat', 'm-1', 'add']), itemKey: 'sticker', quantity: 4, occurredAt: new Date('2026-01-01T00:00:00Z') });
    goal('receipt with emoji', { channelID: '456', receiptIdentity: JSON.stringify(['explicit', 'cmd', 'r-👋 "']), itemKey: 'big_gift', quantity: 1000000000, occurredAt: new Date('2026-01-01T00:00:00Z') });
    goal('invalid item key', { channelID: '123', receiptIdentity: 'r', itemKey: 'Bad-Key', quantity: 1, occurredAt: new Date('2026-01-01T00:00:00Z') });

    const journal = (name: string, input: any) => cases.push({ name, kind: 'journal', input });
    journal('source with surrounding whitespace', { source: ' extension ', sourceEventId: 'receipt-0', type: 'extension.event', topic: 'activity',
        subject: { provider: 'extension', kind: 'resource', id: 'subject' }, payload: {} });
    journal('activity event with fractional retention', { source: 'extension', sourceEventId: 'receipt:1/2', type: 'extension.event', topic: 'activity',
        subject: { provider: 'extension', kind: 'resource', id: 'subject' }, payload: { nested: {}, kept: [{}], n: 1.5, big: 3e9, neg: -0, text: 'a\u0000b' },
        metadata: {}, retentionSeconds: 100.5, occurredAt: '2026-11-11T12:00:00.000123+01:00' });
    journal('owner only, uppercase', { source: 'extension', sourceEventId: 'receipt-2', type: 'extension.event', topic: 'telemetry',
        ownerUserId: '0123456789ABCDEF01234567', payload: { a: 1 }, schemaVersion: 3, occurredAt: new Date('2026-11-10T00:00:00Z'), retentionSeconds: 30 });
    journal('no subject or owner', { source: 'extension', sourceEventId: 'receipt-3', type: 'extension.event', topic: 'domain', payload: {} });
    journal('channel topic with a stream id', { source: 'extension', sourceEventId: 'receipt-4', type: 'extension.event', topic: 'channel',
        channelID: '1001', streamID: 'stream-1', payload: { x: null } });

    const records: unknown[] = [];
    for (const item of cases) {
        frozen = NOW_MS;
        const record: Record<string, unknown> = { name: item.name, kind: item.kind, input: encode(item.input), observability: item.observability ?? null };
        try {
            const normalized = item.kind === 'twitch' ? normalizeTwitchEventsubDomainEvent(item.input)
                : item.kind === 'polar' ? normalizePolarDomainEvent(item.input)
                : item.kind === 'goal' ? customGoalProducer.normalize(item.input) : item.input;
            record.normalized = encode(normalized);
        } catch (error) {
            record.normalizeError = failure(error);
        }
        const run = async () => {
            if (item.kind === 'twitch') return ingestDomainEvent(DOMAIN_EVENT_PRODUCERS.twitch, item.input);
            if (item.kind === 'polar') return ingestDomainEvent(DOMAIN_EVENT_PRODUCERS.polar, item.input);
            if (item.kind === 'goal') return ingestCustomGoalContribution(item.input, undefined, async () => {});
            return journalDomainEvent(item.input);
        };
        try {
            const outcome = item.observability
                ? await restoreContext(item.observability, item.observability.channel, run)
                : await run();
            record.outcome = outcome ? { inserted: outcome.inserted, eventKey: outcome.event.eventKey } : null;
        } catch (error) {
            record.outcome = { error: failure(error) };
        }
        records.push(record);
    }
    result.cases = records;
    result.events = (await DomainEventSchema.collection.find({}, RAW).sort({ eventKey: 1 }).toArray()).map(canonical);

    // The dispatcher's fan-out, at a later instant (ephemeral consumers skip old events).
    frozen = NOW_MS + 60_000;
    const dispatched = [await dispatchDomainEvents(DOMAIN_EVENT_CONSUMERS, 500), await dispatchDomainEvents(DOMAIN_EVENT_CONSUMERS, 500)];
    result.dispatch = {
        nowMs: frozen, dispatched,
        deliveries: (await DomainEventDeliverySchema.collection.find({}, RAW).sort({ consumer: 1, eventKey: 1 }).toArray()).map(canonical),
        pending: (await DomainEventSchema.collection.find({ dispatchPending: true }).toArray()).length
    };
    // The admin health report on that state (one delivery made processing and one retry first).
    const { getDomainEventHealth } = await load('src/utils/domain_event_health.ts');
    await DomainEventDeliverySchema.collection.updateOne({ consumer: 'stream-analytics-v1' }, { $set: { status: 'processing', lockedUntil: new RealDate(NOW_MS + 30_000) } });
    await DomainEventDeliverySchema.collection.updateOne({ consumer: 'polar-credits-v1' }, { $set: { status: 'retry', nextAttemptAt: new RealDate(NOW_MS), lastErrorCode: 'prerequisite_missing', lastPrerequisiteKind: 'owner', lastAttemptDurationMs: 12.5 } });
    await DomainEventSchema.collection.updateOne({ eventKey: 'twitch-eventsub:message-1:channel.bits.received' }, { $set: { dispatchPending: true } });
    const healthAt = new RealDate(NOW_MS + 120_000);
    result.health = { nowMs: healthAt.getTime(),
        all: await getDomainEventHealth(undefined, healthAt), widget: await getDomainEventHealth('widget-actions-v1', healthAt),
        credits: await getDomainEventHealth('polar-credits-v1', healthAt), empty: await getDomainEventHealth('', healthAt) };
    await DomainEventSchema.collection.updateOne({ eventKey: 'twitch-eventsub:message-1:channel.bits.received' }, { $set: { dispatchPending: false } });

    // Durable cron-job intents, with a recording stand-in for Dragonfly.
    let clock = NOW_MS;
    let uuids = 0;
    const calls: unknown[] = [];
    const scripts: Record<string, string> = {};
    const { PUBLISH_DURABLE_CRON_JOB } = await load('src/utils/durable_cron_jobs.ts');
    scripts[PUBLISH_DURABLE_CRON_JOB] = 'PUBLISH_DURABLE_CRON_JOB';
    let reply = 1;
    const durable = createDurableCronJobs({
        now: () => new RealDate(clock), uuid: () => `uuid-${++uuids}`,
        cache: async () => ({ eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
            calls.push({ script: scripts[script] ?? 'unknown', keys: options.keys, arguments: options.arguments });
            return reply;
        } })
    });
    const queue = 'cron:stream-memory:queue';
    // Jobs in the property order `enqueueCronJob` builds (and the production intents show).
    const job = (id: string, extra: Record<string, unknown> = {}) => ({ id, job: 'stream-memory-summary', requestedAt: new RealDate(clock).toISOString(),
        channelID: '1001', data: { reason: 'manual' }, dedupeKey: 'cron:jobs:dedupe:stream-memory-summary:1001', ...extra });
    const steps: unknown[] = [];
    const step = async (name: string, action: () => Promise<unknown>) => {
        frozen = clock;
        const before = calls.length;
        let value: unknown;
        try { value = encode(await action()); } catch (error) { value = { error: failure(error) }; }
        steps.push({ name, nowMs: clock, value, calls: calls.slice(before) });
    };
    const a = job('job-a');
    await step('prepare a', () => durable.prepare(a, queue, { dedupeSeconds: 43200 }));
    await step('prepare a duplicate with another id', () => durable.prepare(job('job-a2'), queue, { dedupeSeconds: 43200 }));
    await step('publish a', () => durable.publish(a, queue));
    reply = 0;
    await step('publish a while queued', () => durable.publish(a, queue));
    reply = 1;
    const automatic = job('job-auto', { dedupeKey: 'cron:jobs:dedupe:session:auto-1', data: { source: 'stream_offline', sessionID: 's-1' } });
    await step('prepare automatic', () => durable.prepare(automatic, queue, { dedupeSeconds: 43200, acceptanceKey: 'cron:jobs:accepted:stream-memory-summary:1001:s-1' }));
    await step('prepare automatic with a wrong acceptance key', () => durable.prepare(job('job-auto-x', { data: { source: 'stream_offline', sessionID: 's-9' } }), queue, { dedupeSeconds: 60, acceptanceKey: 'cron:jobs:accepted:x' }));
    const legacy = job('job-legacy', { dedupeKey: 'cron:jobs:dedupe:session:legacy', data: { source: 'stream_offline', sessionID: 's-2' } });
    await step('prepare legacy accepted', () => durable.prepare(legacy, queue, { dedupeSeconds: 43200, acceptanceKey: 'cron:jobs:accepted:stream-memory-summary:1001:s-2', legacyAccepted: true }));
    await step('claim a', () => durable.claim(a, queue, 'owner-1'));
    const claimA = (steps.at(-1) as any).value.claim;
    const decode = (claim: any) => claim;
    clock += 1000;
    await step('renew a', () => durable.renew(decode(claimA)));
    await step('assert a', () => durable.assertActive(decode(claimA)));
    await step('retry a in a minute', () => durable.retry(decode(claimA), { ...a, data: { reason: 'manual', attempt: 2 } }, new RealDate(clock + 60_000)));
    await step('claim a before it is due', () => durable.claim(a, queue, 'owner-2'));
    clock += 61_000;
    await step('recover publishes a', () => durable.recover(queue, { limit: 10 }));
    await step('claim a when due', () => durable.claim(a, queue, 'owner-2'));
    const claimA2 = (steps.at(-1) as any).value.claim;
    await step('complete with the old claim', () => durable.complete(decode(claimA)));
    await step('complete a', () => durable.complete(decode(claimA2)));
    await step('claim a after completion', () => durable.claim(a, queue, 'owner-3'));
    await step('claim legacy payload adopts it', () => durable.claim(legacy, queue, 'owner-4'));
    await step('claim automatic', () => durable.claim(automatic, queue, 'owner-5'));
    const claimAuto = (steps.at(-1) as any).value.claim;
    await step('dead automatic', () => durable.dead(decode(claimAuto), 'boom'));
    clock += 5 * 60_000 + 1;
    await step('recover marks the stale legacy lease uncertain', () => durable.recover(queue, { limit: 10 }));
    const later = job('job-later', { dedupeKey: 'cron:jobs:dedupe:later', data: { notBeforeUnix: Math.floor(clock / 1000) + 120 } });
    await step('prepare a job due later', () => durable.prepare(later, queue, { dedupeSeconds: 60 }));
    await step('publish before due', () => durable.publish(later, queue));
    await step('claim unknown job adopts it', () => durable.claim(job('job-adopted', { dedupeKey: undefined, job: 'memory-maintenance-weekly', data: undefined }), queue, 'owner-6'));
    const claimAdopted = (steps.at(-1) as any).value.claim;
    await step('uncertain adopted', () => durable.uncertain(decode(claimAdopted), 'external effect unknown'));
    clock += 121_000;
    await step('recover publishes the later job', () => durable.recover(queue, { limit: 10 }));
    await step('claim later', () => durable.claim(later, queue, 'owner-7'));
    const claimLater = (steps.at(-1) as any).value.claim;
    await step('complete later', () => durable.complete(decode(claimLater)));
    await step('new job reuses an expired dedupe key', () => durable.prepare(job('job-later-2', { dedupeKey: 'cron:jobs:dedupe:later' }), queue, { dedupeSeconds: 60 }));
    await step('invalid recovery scope', () => durable.recover(queue, { limit: 0 }));
    await step('invalid dedupe duration', () => durable.prepare(job('job-z'), queue, { dedupeSeconds: 0 }));
    result.jobs = { queue, steps, intents: (await CronJobIntentSchema.collection.find({}, RAW).sort({ jobID: 1 }).toArray()).map(canonical) };

    // Provenance: the reference commit and the hash of every file the recording loaded.
    const sources: Record<string, string> = {};
    for (const file of [...loaded].sort()) sources[file] = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
    result.reference = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: root }).toString().trim();
    result.sources = sources;
    writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
    console.log(`recorded ${records.length} cases, ${(result.events as unknown[]).length} events, ${(result.dispatch as any).deliveries.length} deliveries, ${steps.length} job steps`);
} finally {
    frozen = null;
    await mongoose.connection.db?.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
}
process.exit(0);
