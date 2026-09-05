import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import {
    DOMAIN_EVENT_MAX_JSON_BYTES, DomainEventContractError, getPolarBillingPayload,
    getTwitchEventsubPayload, TWITCH_DOMAIN_EVENT_TYPES, validateDomainEventContract
} from './domain_event_contracts.js';
import type { DomainEventEnvelope, JournalDomainEventInput } from './domain_event.types.js';
import { DOMAIN_EVENT_RETENTION_SECONDS } from './domain_event.types.js';
import { normalizeTwitchEventsubDomainEvent } from './twitch_eventsub_events.js';
import { normalizePolarDomainEvent } from './polar_events.js';
import { generateTestPayload } from '../utils/eventsub.test-data.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';

const timestamp = '2026-09-05T12:00:00.000Z';

test('producer retention cannot exceed the bounded topic horizon', () => {
    for (const topic of ['channel', 'activity', 'telemetry', 'domain'] as const) {
        const input: JournalDomainEventInput = {
            source: 'extension', sourceEventId: 'receipt', type: 'extension.event', topic,
            channelID: 'channel', subject: { provider: 'extension', kind: 'resource', id: 'subject' },
            payload: {}, retentionSeconds: DOMAIN_EVENT_RETENTION_SECONDS[topic]
        };
        assert.doesNotThrow(() => validateDomainEventContract(input, 'ingest'));
        assert.throws(() => validateDomainEventContract({ ...input, retentionSeconds: input.retentionSeconds! + 1 }, 'ingest'), /topic retention limit/);
        assert.throws(() => validateDomainEventContract({ ...input, retentionSeconds: 8e12 }, 'ingest'), /topic retention limit/);
    }
});

function twitch(type = 'channel.follow', event: Record<string, unknown> = { broadcaster_user_id: 'channel', user_id: 'follower' }): JournalDomainEventInput {
    return normalizeTwitchEventsubDomainEvent({
        messageId: 'receipt', subscription: { type, version: type === 'channel.follow' ? '2' : '1' }, event
    })!;
}

function polar(type = 'order.paid', data: Record<string, unknown> = {
    id: 'order', customerId: 'customer', paid: true, status: 'paid'
}): JournalDomainEventInput {
    return normalizePolarDomainEvent({ webhookId: 'receipt', event: { type, timestamp: new Date(timestamp), data } });
}

test('pre-75e22ef retained Twitch rows remain valid without inventing a subject or owner', () => {
    // Shape emitted by ffda5a9/e290bbc and persisted by the pre-75e22ef journal.
    for (const source of ['twitch-eventsub', 'twitch-eventsub-test']) {
        for (const type of Object.keys(TWITCH_DOMAIN_EVENT_TYPES).filter(type => type !== 'channel.raid')) {
            const fixture = generateTestPayload(['channel.cheer', 'channel.bit.use'].includes(type) ? 'channel.bits.use' : type, 'channel');
            fixture.subscription.type = type;
            const raw = { ...fixture.event } as Record<string, unknown>;
            const retained: DomainEventEnvelope = {
                _id: new Types.ObjectId(), eventKey: `${source}:legacy-receipt:${TWITCH_DOMAIN_EVENT_TYPES[type as keyof typeof TWITCH_DOMAIN_EVENT_TYPES]}`,
                source, sourceEventId: 'legacy-receipt', type: TWITCH_DOMAIN_EVENT_TYPES[type as keyof typeof TWITCH_DOMAIN_EVENT_TYPES],
                topic: 'channel', schemaVersion: 1, channelID: 'channel',
                ...(type === 'stream.online' ? { streamID: String(raw.id) } : {}),
                occurredAt: new Date(String(type === 'channel.follow' ? raw.followed_at : type === 'stream.online' ? raw.started_at : timestamp)),
                journaledAt: new Date(timestamp), expiresAt: new Date('2026-12-04T12:00:00Z'),
                payload: { subscription: { ...fixture.subscription }, event: raw },
                metadata: { originalEventType: type, subscriptionID: fixture.subscription.id,
                    subscriptionVersion: fixture.subscription.version, messageTimestamp: timestamp }
            };
            const before = structuredClone(retained);
            validateDomainEventContract(retained);
            assert.throws(() => validateDomainEventContract(retained, 'ingest'), DomainEventContractError);
            assert.equal(getTwitchEventsubPayload(retained), retained.payload);
            validateDomainEventContract(new DomainEventSchema(retained));
            assert.deepEqual(structuredClone(retained), before);
            assert.equal('subject' in retained, false);
            assert.equal('ownerUserId' in retained, false);
            validateDomainEventContract({ ...retained, metadata: { ...retained.metadata, messageRetry: 2, staleRetry: true } } as DomainEventEnvelope);

            for (const mutate of [
                (input: DomainEventEnvelope) => { (input.payload.event as Record<string, unknown>).broadcaster_user_id = 'other'; },
                (input: DomainEventEnvelope) => { input.payload.event = {}; },
                (input: DomainEventEnvelope) => { input.metadata.originalEventType = 'channel.raid'; },
                (input: DomainEventEnvelope) => { input.metadata.durableChatHandled = true; },
                (input: DomainEventEnvelope) => { input.metadata.durableDefenseHandled = true; },
                (input: DomainEventEnvelope) => { input.subject = { provider: 'twitch', kind: 'streaming-account', id: 'other' }; },
                (input: DomainEventEnvelope) => { input.eventKey = 'different-receipt'; },
                (input: DomainEventEnvelope) => { input.journaledAt = new Date(NaN); },
                (input: DomainEventEnvelope) => { input.schemaVersion = 2; }
            ]) {
                const malformed = { ...retained, payload: structuredClone(retained.payload), metadata: { ...retained.metadata } };
                mutate(malformed);
                assert.throws(() => validateDomainEventContract(malformed), DomainEventContractError);
            }
            const { _id, eventKey, journaledAt, expiresAt, ...ingress } = retained;
            assert.throws(() => validateDomainEventContract(ingress), DomainEventContractError);
        }
    }
});

test('all shipped Twitch fixture types and legacy bits aliases satisfy schema 1 unchanged', () => {
    for (const type of Object.keys(TWITCH_DOMAIN_EVENT_TYPES)) {
        const fixture = generateTestPayload(['channel.cheer', 'channel.bit.use'].includes(type) ? 'channel.bits.use' : type, 'channel');
        fixture.subscription.type = type;
        const input = normalizeTwitchEventsubDomainEvent({
            messageId: type, subscription: { ...fixture.subscription }, event: { ...fixture.event }, source: 'twitch-eventsub-test'
        })!;
        const before = structuredClone(input);
        assert.doesNotThrow(() => validateDomainEventContract(input), type);
        assert.equal(getTwitchEventsubPayload(input), input.payload);
        assert.deepEqual(input, before);
    }
});

test('follow time fallback permits no timestamps, message time, or nanosecond provider time', () => {
    const missing = twitch();
    validateDomainEventContract(missing);
    assert.equal(missing.occurredAt, undefined);
    const fallback = normalizeTwitchEventsubDomainEvent({
        messageId: 'receipt', messageTimestamp: timestamp, subscription: { type: 'channel.follow' },
        event: { broadcaster_user_id: 'channel', user_id: 'follower' }
    })!;
    validateDomainEventContract(fallback);
    assert.equal(fallback.occurredAt, timestamp);
    const precise = twitch('channel.follow', {
        broadcaster_user_id: 'channel', user_id: 'follower', followed_at: '2026-09-05T12:00:00.123456789Z'
    });
    validateDomainEventContract(precise);
    const retained: DomainEventEnvelope = {
        ...precise, _id: new Types.ObjectId(), eventKey: 'key', schemaVersion: 1,
        occurredAt: new Date(precise.occurredAt!), journaledAt: new Date(timestamp),
        expiresAt: new Date(timestamp), metadata: precise.metadata!
    };
    validateDomainEventContract(retained);
    validateDomainEventContract(new DomainEventSchema(retained));
    const retainedWithoutProviderTime = { ...retained, ...missing };
    assert.throws(() => validateDomainEventContract(retainedWithoutProviderTime), DomainEventContractError,
        'only pre-journal inputs may omit occurrence time');
    assert.throws(() => validateDomainEventContract({ ...retained, journaledAt: new Date(NaN) } as DomainEventEnvelope), DomainEventContractError);
});

test('anonymous gifts preserve missing total and nullable SDK cumulative totals without defaulting payload', () => {
    const input = twitch('channel.subscription.gift', {
        broadcaster_user_id: 'channel', is_anonymous: true, user_id: null,
        user_login: null, user_name: null, cumulative_total: null
    });
    validateDomainEventContract(input);
    assert.equal((input.payload.event as Record<string, unknown>).total, undefined);
});

test('known source envelope integrity and unsupported versions fail with permanent contract errors', () => {
    const mutations: Array<(input: JournalDomainEventInput) => void> = [
        input => { input.source = 'polar-webhook'; },
        input => { input.type = 'channel.bits.received'; },
        input => { input.topic = 'domain'; },
        input => { input.schemaVersion = 2; },
        input => { input.subject!.id = 'other'; },
        input => { input.subject!.provider = 'polar'; },
        input => { input.subject!.kind = 'customer'; },
        input => { input.channelID = 'other'; },
        input => { input.metadata!.originalEventType = 'channel.raid'; },
        input => { delete input.metadata!.originalEventType; },
        input => { input.metadata!.subscriptionVersion = '99'; },
        input => { (input.payload.subscription as Record<string, unknown>).version = '99'; },
        input => { (input.payload.subscription as Record<string, unknown>).type = 'channel.raid'; },
        input => { (input.payload.subscription as Record<string, unknown>).condition = { broadcaster_user_id: 'other' }; },
        input => { input.payload.event = []; },
        input => { (input.payload.event as Record<string, unknown>).user_id = 123; },
        input => { (input.payload.event as Record<string, unknown>).user_id = ''; },
        input => { input.metadata!.messageRetry = 1.5; },
        input => { input.metadata!.durableChatHandled = 'true'; }
    ];
    for (const mutate of mutations) {
        const input = twitch();
        mutate(input);
        assert.throws(() => validateDomainEventContract(input), (error: unknown) => {
            assert.ok(error instanceof DomainEventContractError);
            assert.equal(error.permanent, true);
            return true;
        });
    }
    for (const input of [twitch(), polar(), polar('product.created', { id: 'product' })]) {
        input.schemaVersion = 99;
        const before = structuredClone(input);
        assert.throws(() => validateDomainEventContract(input), DomainEventContractError);
        assert.deepEqual(input, before, 'unsupported retained rows are not modified or removed');
    }
});

test('raid requires destination, raider and safe integer viewers; stream online requires matching stream ID', () => {
    const raid = twitch('channel.raid', { to_broadcaster_user_id: 'channel', from_broadcaster_user_id: 'raider', viewers: 0 });
    validateDomainEventContract(raid);
    for (const field of ['to_broadcaster_user_id', 'from_broadcaster_user_id', 'viewers']) {
        const invalid = structuredClone(raid);
        delete (invalid.payload.event as Record<string, unknown>)[field];
        assert.throws(() => validateDomainEventContract(invalid), DomainEventContractError);
    }
    const stream = twitch('stream.online', { broadcaster_user_id: 'channel', id: 'stream', started_at: timestamp });
    validateDomainEventContract(stream);
    for (const streamID of [undefined, 'other']) assert.throws(() => validateDomainEventContract({ ...stream, streamID }), DomainEventContractError);
    delete (stream.payload.event as Record<string, unknown>).id;
    assert.throws(() => validateDomainEventContract(stream), DomainEventContractError);
});

test('Twitch counts are never coerced, rounded or stored with lost integer precision', () => {
    for (const [type, field, base] of [
        ['channel.bits.use', 'bits', { broadcaster_user_id: 'channel' }],
        ['channel.subscription.gift', 'total', { broadcaster_user_id: 'channel' }],
        ['channel.raid', 'viewers', { to_broadcaster_user_id: 'channel', from_broadcaster_user_id: 'raider' }]
    ] as const) {
        for (const value of ['1', null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => validateDomainEventContract(twitch(type, { ...base, [field]: value })), DomainEventContractError, `${field}=${value}`);
        }
        validateDomainEventContract(twitch(type, { ...base, [field]: Number.MAX_SAFE_INTEGER }));
    }
});

test('present Twitch dates must be real RFC3339 times consistent with occurrence time', () => {
    for (const value of ['', 'tomorrow', '2026-02-30T12:00:00Z', '2026-09-05', '2026-09-05T24:00:00Z', 123, null]) {
        assert.throws(() => validateDomainEventContract(twitch('channel.follow', {
            broadcaster_user_id: 'channel', user_id: 'follower', followed_at: value
        })), DomainEventContractError);
    }
    const input = twitch('channel.follow', { broadcaster_user_id: 'channel', user_id: 'follower', followed_at: timestamp });
    input.occurredAt = '2026-09-04T12:00:00Z';
    assert.throws(() => validateDomainEventContract(input), DomainEventContractError);
});

test('flat Polar payload guards accept one-time paid orders, subscriptions and fractional negative meters', () => {
    for (const input of [
        polar(),
        polar('subscription.updated', { id: 'sub', customerId: 'customer', productId: 'product', status: 'canceled', recurringInterval: 'year', currentPeriodEnd: null }),
        polar('customer.state_changed', { id: 'customer', activeMeters: [{ meterId: 'meter', consumedUnits: 12.5, creditedUnits: 10, balance: -2.5 }] })
    ]) {
        validateDomainEventContract(input);
        assert.equal(getPolarBillingPayload(input), input.payload);
        assert.throws(() => getTwitchEventsubPayload(input), DomainEventContractError);
    }
    assert.throws(() => getPolarBillingPayload(twitch()), DomainEventContractError);
    assert.throws(() => getPolarBillingPayload(polar('product.created', { id: 'product' })), DomainEventContractError);
});

test('malformed retained flat Polar contracts cannot reach billing through casts', () => {
    for (const mutate of [
        (input: JournalDomainEventInput) => { input.payload.customerId = 'other'; },
        (input: JournalDomainEventInput) => { input.payload.paid = 'true'; },
        (input: JournalDomainEventInput) => { delete input.payload.orderId; },
        (input: JournalDomainEventInput) => { input.payload.status = {}; },
        (input: JournalDomainEventInput) => { input.payload.periodEnd = '2026-02-30T12:00:00Z'; },
        (input: JournalDomainEventInput) => { input.payload.cadence = 'weekly'; },
        (input: JournalDomainEventInput) => { input.payload.subscriptionId = 'sub'; },
        (input: JournalDomainEventInput) => { input.channelID = 'fabricated'; },
        (input: JournalDomainEventInput) => { input.metadata!.originalEventType = 'order.refunded'; },
        (input: JournalDomainEventInput) => { input.metadata!.unmapped = true; },
        (input: JournalDomainEventInput) => { input.payload = { data: input.payload }; },
        (input: JournalDomainEventInput) => { input.payload.meters = [{ meter_id: 'meter', balance: '1' }]; }
    ]) {
        const input = polar();
        mutate(input);
        assert.throws(() => getPolarBillingPayload(input), DomainEventContractError);
    }
    for (const value of [NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
        const input = polar('customer.state_changed', { id: 'customer', activeMeters: [] });
        input.payload.meters = [{ meter_id: 'meter', consumed_units: value }];
        assert.throws(() => getPolarBillingPayload(input), DomainEventContractError);
    }
});

test('unknown Polar provider events remain extensible but retain source, subject, type and schema integrity', () => {
    const valid = polar('new.resource.changed', { id: 'resource', arbitrary: [true, { text: 'hello' }] });
    validateDomainEventContract(valid);
    for (const mutate of [
        (input: JournalDomainEventInput) => { input.type = 'billing.order.paid'; },
        (input: JournalDomainEventInput) => { input.subject!.id = 'other'; },
        (input: JournalDomainEventInput) => { input.metadata!.unmapped = false; },
        (input: JournalDomainEventInput) => { input.payload.providerData = {}; }
    ]) {
        const input = structuredClone(valid);
        mutate(input);
        assert.throws(() => validateDomainEventContract(input), DomainEventContractError);
    }
});

test('unknown producer sources permit arbitrary event types and future integer schemas with generic envelope checks', () => {
    const input: JournalDomainEventInput = {
        source: 'extension', sourceEventId: 'receipt', type: 'billing.order.paid', topic: 'domain', schemaVersion: 42,
        subject: { provider: 'extension', kind: 'integration-account', id: 'account' }, payload: { arbitrary: [1.25, true, null] }
    };
    validateDomainEventContract(input);
    for (const schemaVersion of [0, -1, 1.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => validateDomainEventContract({ ...input, schemaVersion } as JournalDomainEventInput), DomainEventContractError);
    }
    for (const change of [{ topic: 'unknown' }, { subject: undefined }, { sourceEventId: 123 }, { ownerUserId: 'channel' }]) {
        assert.throws(() => validateDomainEventContract({ ...input, ...change } as JournalDomainEventInput), DomainEventContractError);
    }
});

test('payload and metadata enforce bounded JSON without cycles, prototypes, accessors or lossy values', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 35; i++) deep = { nested: deep };
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 'unsafe'; } });
    const invalid: unknown[] = [
        undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, Symbol('bad'), () => {}, new Date(),
        new Map(), new Set(), Object.create({ inherited: true }), cycle, deep, accessor,
        JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: {} }, { toJSON() { assert.fail('must not execute'); } },
        new Array(2), Object.assign([], { extra: true }), { [Symbol('bad')]: 1 },
        Object.defineProperty({}, 'hidden', { value: 1 }), 'x'.repeat(DOMAIN_EVENT_MAX_JSON_BYTES),
        '\u{1f600}'.repeat(DOMAIN_EVENT_MAX_JSON_BYTES / 4)
    ];
    for (const value of invalid) {
        const input: JournalDomainEventInput = { source: 'test', sourceEventId: 'receipt', type: 'test', topic: 'channel', channelID: 'channel', payload: { value } };
        assert.throws(() => validateDomainEventContract(input), DomainEventContractError);
        assert.throws(() => validateDomainEventContract({ ...input, payload: {}, metadata: { value } }), DomainEventContractError);
    }
    assert.equal(getterCalls, 0);
    const shared = { value: 1 };
    validateDomainEventContract({ source: 'test', sourceEventId: 'receipt', type: 'test', topic: 'channel', channelID: 'channel', payload: { first: shared, second: shared, plain: Object.create(null) } });
});
