// Records what the reference consumer runtime really writes, for `tests/recorded_consumer.rs`:
// the real `drainDomainEvents`, `dispatchDomainEvents` and `replayDeadDomainEvent`
// (`utils/domain_event_consumer.ts`) with scripted handlers, over a set of journaled events,
// against a throwaway MongoDB database. After every step it dumps the deliveries and the
// checkpoints, the drain's result (or the error it threw) and the handler calls in order.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DOMAIN_EVENTS_WAKEUPS_ENABLED=false node_modules/.bin/tsx \
//     /path/to/dima-rust/crates/events/tests/reference/record_consumer.mts \
//     /path/to/dima-rust/crates/events/tests/fixtures/recorded_consumer.json
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference
// (commit 0c71108e). The script works in `dima_test_events_rec_<random>` and drops it at the
// end, also after a failure. Dragonfly is never touched (wakeups disabled).
//
// Determinism: `Date` is frozen at each step's instant (a handler may move it, as time passing
// during its run); `performance.now()` is a counter only the `slow` handler moves, so attempt
// durations are exact. Lease tokens are random on both sides and compared as "a string".
// Generated delivery and checkpoint ids are mapped by the Rust test; event ids are recorded and
// the Rust test inserts the same events.
//
// Scripted handlers (by `payload.script`): `ok` returns; `flaky` throws on its first call and
// then returns; `poison` always throws; `contract` throws a DomainEventContractError; `owner`
// and `metric` throw a DomainEventPrerequisiteMissingError (`owner:…`, `metric-session:…`);
// `late-ok` misses a prerequisite once and then returns; `slow` takes 75 ms (monotonic) and
// returns; `long` throws an error longer than the stored 8,000 units, with emoji; `outlive`
// runs past its lease (the clock moves 60,001 ms during it) and then returns. The replayed
// analytics consumer throws until the replay step, then returns.
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
let monotonic = 1000;
(globalThis.performance as any).now = () => monotonic;

const out = process.argv[2];
if (!out) throw new Error('usage: record_consumer.mts <out.json>');
if (process.env.TZ !== 'UTC') throw new Error('run with TZ=UTC');
if (process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED !== 'false') throw new Error('run with DOMAIN_EVENTS_WAKEUPS_ENABLED=false');
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');
const root = process.cwd();
const imported = async (file: string) => import(pathToFileURL(path.join(root, file)).href);
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
const { EJSON } = mongoose.mongo.BSON;

const database = `dima_test_events_rec_${randomInt(1e9)}`;
const loaded = new Set<string>();
const load = async (file: string) => { loaded.add(file); return imported(file); };
const canonical = (doc: unknown) => JSON.parse(EJSON.stringify(doc, { relaxed: false }));
const RAW = { promoteValues: false, promoteLongs: false, promoteBuffers: false };

await mongoose.connect(uri, { dbName: database });
const result: Record<string, unknown> = { nowMs: NOW_MS, database: 'dima_test_events_rec_<random>' };
try {
    const { journalDomainEvent } = await load('src/utils/domain_events.ts');
    const { DOMAIN_EVENT_PRODUCERS, ingestDomainEvent } = await load('src/domain_events/domain_event_producers.ts');
    const { dispatchDomainEvents, drainDomainEvents, replayDeadDomainEvent } = await load('src/utils/domain_event_consumer.ts');
    const { DOMAIN_EVENT_CONSUMERS } = await load('src/domain_events/domain_event_consumers.ts');
    const { DomainEventPrerequisiteMissingError } = await load('src/domain_events/domain_event.types.ts');
    const { DomainEventContractError } = await load('src/domain_events/domain_event_contracts.ts');
    const { DomainEventSchema } = await load('src/schemas/domain_event.schema.ts');
    const { DomainEventDeliverySchema } = await load('src/schemas/domain_event_delivery.schema.ts');
    const { DomainEventCheckpointSchema } = await load('src/schemas/domain_event_checkpoint.schema.ts');
    await Promise.all([DomainEventSchema.init(), DomainEventDeliverySchema.init(), DomainEventCheckpointSchema.init()]);

    // The journal, at NOW.
    frozen = NOW_MS;
    const subject = { provider: 'recorder', kind: 'resource', id: 'r' };
    const journal = (source: string, id: string, script: string, extra: Record<string, unknown> = {}) =>
        journalDomainEvent({ source, sourceEventId: id, type: 'recorder.event', topic: 'domain', subject, payload: { script }, ...extra });
    for (const [id, script] of [['e01', 'ok'], ['e02', 'flaky'], ['e03', 'poison'], ['e04', 'contract'], ['e05', 'owner'],
        ['e06', 'metric'], ['e07', 'slow'], ['e08', 'long']] as const) {
        await journal('recorder', id, script);
    }
    await journal('recorder', 'e09', 'ok', { schemaVersion: 2 });
    await journal('recorder', 'e10', 'ok');
    await journal('recorder', 'e11', 'late-ok');
    await journal('recorder-ephemeral', 'x01', 'ok');
    await journal('recorder-ephemeral', 'x02', 'ok', { occurredAt: new Date(NOW_MS - 400_000) });
    await journal('recorder-ephemeral', 'x03', 'poison', { occurredAt: new Date(NOW_MS - 295_000) });
    await journal('recorder-lease', 'i01', 'outlive');
    // A Twitch follow, through the real producer, for the replayed registry consumer.
    const follow = await ingestDomainEvent(DOMAIN_EVENT_PRODUCERS.twitch, {
        messageId: 'replay-follow', messageTimestamp: '2026-11-11T10:20:29.123Z', messageRetry: 0, staleRetry: false,
        subscription: { id: 'sub', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '1001' } },
        event: { broadcaster_user_id: '1001', user_id: '7', followed_at: '2026-11-11T10:20:29Z' },
        durableChatHandled: true, durableDefenseHandled: true
    });
    // A Twitch event whose stored payload breaks its contract (written raw: no producer makes it).
    const brokenKey = 'twitch-eventsub:broken-follow:channel.follow.received';
    await DomainEventSchema.collection.insertOne({
        eventKey: brokenKey, source: 'twitch-eventsub', sourceEventId: 'broken-follow', type: 'channel.follow.received',
        topic: 'channel', schemaVersion: 1, subject: { provider: 'twitch', kind: 'streaming-account', id: '1001' },
        channelID: '1001', occurredAt: new RealDate(NOW_MS), journaledAt: new RealDate(NOW_MS),
        payload: {}, metadata: { originalEventType: 'channel.follow' }, dispatchPending: true,
        expiresAt: new RealDate(NOW_MS + 90 * 86_400_000)
    });
    result.events = (await DomainEventSchema.collection.find({}, RAW).sort({ _id: 1 }).toArray()).map(canonical);
    result.followKey = follow.event.eventKey;
    result.brokenKey = brokenKey;

    // Scripted handlers.
    const calls: string[] = [];
    const counts = new Map<string, number>();
    let analyticsReplayed = false;
    const scripted = async (event: any) => {
        calls.push(event.eventKey);
        const n = (counts.get(event.eventKey) ?? 0) + 1;
        counts.set(event.eventKey, n);
        switch (event.payload?.script) {
            case 'ok': return;
            case 'flaky': if (n === 1) throw new Error('flaky failure'); return;
            case 'poison': throw new Error('poison');
            case 'contract': throw new DomainEventContractError('scripted invalid payload');
            case 'owner': throw new DomainEventPrerequisiteMissingError('owner:recorder owner missing');
            case 'metric': throw new DomainEventPrerequisiteMissingError('metric-session:1001');
            case 'late-ok': if (n === 1) throw new DomainEventPrerequisiteMissingError('stream-session'); return;
            case 'slow': monotonic += 75; return;
            case 'long': throw new Error('é👋 '.repeat(3000));
            case 'outlive': frozen = (frozen ?? NOW_MS) + 60_001; return;
            default: if (!analyticsReplayed) throw new Error('analytics down'); return;
        }
    };
    const scriptFilter = { source: 'recorder' };
    const consumers: Record<string, any> = {
        script: { consumer: 'rec-script-v1', topics: ['domain'], schemaVersions: [1], eventFilter: scriptFilter, handler: scripted },
        ephemeral: { consumer: 'rec-ephemeral-v1', topics: ['domain'], schemaVersions: [1], maxEventAgeMs: 300_000,
            eventFilter: { source: 'recorder-ephemeral' }, handler: scripted },
        lease: { consumer: 'rec-lease-v1', topics: ['domain'], schemaVersions: [1], maxAttempts: 2,
            eventFilter: { source: 'recorder-lease' }, handler: scripted },
        analytics: { ...DOMAIN_EVENT_CONSUMERS.find((c: any) => c.consumer === 'stream-analytics-v1'), maxAttempts: 2, handler: scripted }
    };
    // The dispatch admits every schema version for the script consumer (an older registry did),
    // so the version-2 event gets a delivery that the current policy then refuses.
    const permissive = { ...consumers.script, schemaVersions: undefined };

    const leaseLost: string[] = [];
    const steps: unknown[] = [];
    const dump = async () => ({
        deliveries: (await DomainEventDeliverySchema.collection.find({}, RAW).sort({ consumer: 1, eventKey: 1 }).toArray()).map(canonical),
        checkpoints: (await DomainEventCheckpointSchema.collection.find({}, RAW).sort({ consumer: 1, topic: 1 }).toArray()).map(canonical)
    });
    const step = async (name: string, at: number, action: any) => {
        frozen = at;
        const before = calls.length;
        let value: unknown;
        try {
            if (action.kind === 'drain') {
                value = await drainDomainEvents({ ...consumers[action.consumer], runtime: { leaseLost: (e: Error) => leaseLost.push(e.message) } });
            } else if (action.kind === 'dispatch') {
                value = await dispatchDomainEvents(action.consumers.map((c: string) => c === 'permissive' ? permissive : consumers[c]), 500);
            } else if (action.kind === 'replay') {
                value = await replayDeadDomainEvent(action.consumer, action.eventKey);
                if (value === true) analyticsReplayed = true;
            } else if (action.kind === 'delete') {
                value = (await DomainEventSchema.collection.deleteOne({ eventKey: action.eventKey })).deletedCount;
            }
        } catch (error) {
            value = { error: (error as Error).message };
        }
        steps.push({ name, at, action, value, calls: calls.slice(before), after: frozen, ...(await dump()) });
    };

    const key = (id: string, source = 'recorder') => `${source}:${id}:recorder.event`;
    const DAY = 86_400_000;
    await step('dispatch the script and analytics events', NOW_MS, { kind: 'dispatch', consumers: ['permissive', 'analytics'] });
    await step('the journal loses an event', NOW_MS, { kind: 'delete', eventKey: key('e10') });
    await step('first pass of the script consumer', NOW_MS, { kind: 'drain', consumer: 'script' });
    await step('flaky and poison retry after 5 s', NOW_MS + 5_000, { kind: 'drain', consumer: 'script' });
    await step('prerequisites come back after 30 s', NOW_MS + 35_000, { kind: 'drain', consumer: 'script' });
    await step('past the prerequisite horizons', NOW_MS + DAY + 1, { kind: 'drain', consumer: 'script' });
    await step('poison reaches the attempt limit', NOW_MS + DAY + 1 + 1_800_000, { kind: 'drain', consumer: 'script' });
    await step('nothing left', NOW_MS + DAY + 1 + 1_800_000, { kind: 'drain', consumer: 'script' });
    await step('ephemeral first pass', NOW_MS, { kind: 'drain', consumer: 'ephemeral' });
    await step('ephemeral retry is too old', NOW_MS + 5_000, { kind: 'drain', consumer: 'ephemeral' });
    await step('a handler outlives its lease', NOW_MS, { kind: 'drain', consumer: 'lease' });
    await step('claimed again after the lease, outlives it again', NOW_MS + 60_001, { kind: 'drain', consumer: 'lease' });
    await step('the interrupted final attempt is retired', NOW_MS + 120_002, { kind: 'drain', consumer: 'lease' });
    await step('analytics first pass', NOW_MS, { kind: 'drain', consumer: 'analytics' });
    await step('analytics dead after two attempts', NOW_MS + 5_000, { kind: 'drain', consumer: 'analytics' });
    await step('replay denied: consumer without replay', NOW_MS + 5_000, { kind: 'replay', consumer: 'chat-announcements-v1', eventKey: follow.event.eventKey });
    await step('replay denied: unknown consumer', NOW_MS + 5_000, { kind: 'replay', consumer: 'rec-script-v1', eventKey: key('e03') });
    await step('replay denied: no dead delivery', NOW_MS + 5_000, { kind: 'replay', consumer: 'stream-analytics-v1', eventKey: 'nope' });
    await step('replay denied: invalid contract', NOW_MS + 5_000, { kind: 'replay', consumer: 'stream-analytics-v1', eventKey: brokenKey });
    await step('replay allowed', NOW_MS + 5_000, { kind: 'replay', consumer: ' stream-analytics-v1 ', eventKey: follow.event.eventKey });
    await step('replayed delivery runs', NOW_MS + 6_000, { kind: 'drain', consumer: 'analytics' });
    await step('replay denied once it succeeded', NOW_MS + 6_000, { kind: 'replay', consumer: 'stream-analytics-v1', eventKey: follow.event.eventKey });
    result.steps = steps;
    result.leaseLost = leaseLost;

    // The admin listing, as the route builds it (`GET /admin-site/domain-events`), on the final state.
    frozen = NOW_MS + 7_000;
    const listing = async (status: string, consumer: string, limit: number) => {
        const filter: Record<string, unknown> = {};
        if (status) filter.status = status;
        if (consumer) filter.consumer = consumer;
        const [deliveries, total, statusCounts] = await Promise.all([
            DomainEventDeliverySchema.find(filter).sort({ updatedAt: -1 }).limit(limit).lean(),
            DomainEventDeliverySchema.countDocuments(filter),
            DomainEventDeliverySchema.aggregate([{ $match: consumer ? { consumer } : {} }, { $group: { _id: '$status', count: { $sum: 1 } } }])
        ]);
        const events = await DomainEventSchema.find({ _id: { $in: deliveries.map((d: any) => d.eventID) } })
            .select('_id type channelID occurredAt journaledAt').lean();
        const byID = new Map(events.map((e: any) => [String(e._id), e]));
        return JSON.parse(JSON.stringify({
            total, statusCounts: Object.fromEntries(statusCounts.map((e: any) => [e._id, e.count])),
            deliveries: deliveries.map((d: any) => ({ ...d, event: byID.get(String(d.eventID)) || null }))
        }));
    };
    result.listings = [
        { status: '', consumer: '', limit: 100, data: await listing('', '', 100) },
        { status: 'dead', consumer: '', limit: 100, data: await listing('dead', '', 100) },
        { status: '', consumer: 'rec-script-v1', limit: 3, data: await listing('', 'rec-script-v1', 3) }
    ];

    const sources: Record<string, string> = {};
    for (const file of [...loaded].sort()) sources[file] = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
    result.reference = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: root }).toString().trim();
    result.sources = sources;
    writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
    console.log(`recorded ${steps.length} steps, ${(result.events as unknown[]).length} events`);
} finally {
    frozen = null;
    await mongoose.connection.db?.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
}
process.exit(0);
