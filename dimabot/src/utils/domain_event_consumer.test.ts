import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { dispatchDomainEvents, drainDomainEvents, replayDeadDomainEvent, type DomainEventConsumerOptions } from './domain_event_consumer.js';
import { DOMAIN_EVENT_CONSUMERS } from '../domain_events/domain_event_consumers.js';
import { DomainEventContractError } from '../domain_events/domain_event_contracts.js';

function queryResult<T>(value: T) {
    const query = {
        sort() { return query; },
        limit() { return query; },
        select() { return query; },
        lean: async () => value,
        then<TResult1 = T, TResult2 = never>(
            onfulfilled?: ((result: T) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
            return Promise.resolve(value).then(onfulfilled, onrejected);
        }
    };
    return query;
}

for (const existingCheckpoint of [false, true]) {
    test(existingCheckpoint
        ? 'chat consumer resumes marked events after its existing checkpoint'
        : 'first chat drain recovers marked events journaled before worker startup', async (context) => {
        const lastEventID = existingCheckpoint ? new Types.ObjectId() : new Types.ObjectId('000000000000000000000000');
        const event = new DomainEventSchema({
            eventKey: 'event:stream-started',
            source: 'twitch-eventsub',
            sourceEventId: 'stream-started',
            topic: 'channel',
            type: 'stream.started',
            channelID: 'channel-1',
            streamID: 'stream-1',
            subject: { provider: 'twitch', kind: 'streaming-account', id: 'channel-1' },
            occurredAt: new Date('2026-09-03T12:00:00Z'),
            journaledAt: new Date('2026-09-03T12:00:01Z'),
            payload: { subscription: { type: 'stream.online' }, event: { broadcaster_user_id: 'channel-1', id: 'stream-1' } },
            metadata: { durableChatHandled: true, originalEventType: 'stream.online' },
            expiresAt: new Date('2026-12-03T12:00:00Z')
        });
        const handled: string[] = [];
        const checkpointUpdates: Array<Record<string, unknown>> = [];
        const deliveryUpdates: Array<Record<string, unknown>> = [];

        context.mock.method(DomainEventDeliverySchema, 'find', (() => queryResult([])) as never);
        context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => queryResult(
            existingCheckpoint ? { lastEventID } : null
        )) as never);
        context.mock.method(DomainEventSchema, 'findOne', (() => {
            assert.fail('Consumer must not move its checkpoint to the startup-time tail');
        }) as never);
        context.mock.method(DomainEventSchema, 'find', ((filter: Record<string, unknown>) => {
            assert.deepEqual(filter, {
                'metadata.durableChatHandled': true,
                type: { $in: ['stream.started', 'stream.ended'] },
                topic: 'channel',
                _id: { $gt: lastEventID }
            });
            return queryResult([event]);
        }) as never);
        context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: unknown, update: Record<string, unknown>) => {
            return Promise.resolve({
                _id: new Types.ObjectId(),
                status: update.$setOnInsert ? 'pending' : 'processing',
                attempts: update.$setOnInsert ? 0 : 1,
                leaseToken: 'test-lease'
            });
        }) as never);
        context.mock.method(DomainEventDeliverySchema, 'updateOne', ((_filter: unknown, update: Record<string, unknown>) => {
            deliveryUpdates.push(update);
            return Promise.resolve({ modifiedCount: 1 });
        }) as never);
        context.mock.method(DomainEventCheckpointSchema, 'updateOne', ((_filter: unknown, update: Record<string, unknown>) => {
            checkpointUpdates.push(update);
            return Promise.resolve({ modifiedCount: 1 });
        }) as never);

        const result = await drainDomainEvents({
            consumer: 'chat-announcements-v1',
            topics: ['channel'],
            eventFilter: {
                'metadata.durableChatHandled': true,
                type: { $in: ['stream.started', 'stream.ended'] }
            },
            handler: async (envelope) => { handled.push(envelope.eventKey); }
        });

        assert.equal(result.scanned, 1);
        assert.equal(result.succeeded, 1);
        assert.deepEqual(handled, [event.eventKey]);
        assert.deepEqual(checkpointUpdates, [{
            $max: { lastEventID: event._id },
            $setOnInsert: { consumer: 'chat-announcements-v1', topic: 'channel' }
        }]);
        assert.equal((deliveryUpdates[0].$set as { status: string }).status, 'succeeded');
    });
}

test('unfiltered analytics consumers retain historical backfill behavior', async (context) => {
    const scannedFilters: Array<Record<string, unknown>> = [];
    let checkpointUpdates = 0;

    context.mock.method(DomainEventDeliverySchema, 'find', (() => queryResult([])) as never);
    context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => queryResult(null)) as never);
    context.mock.method(DomainEventCheckpointSchema, 'updateOne', (() => {
        checkpointUpdates += 1;
        return Promise.resolve({ acknowledged: true, modifiedCount: 0 });
    }) as never);
    context.mock.method(DomainEventSchema, 'find', ((filter: Record<string, unknown>) => {
        scannedFilters.push(filter);
        return queryResult([]);
    }) as never);

    await drainDomainEvents({
        consumer: 'stream-analytics-v1',
        topics: ['channel'],
        handler: async () => undefined
    });

    assert.equal(checkpointUpdates, 0);
    assert.equal(scannedFilters[0]['metadata.durableChatHandled'], undefined);
    assert.equal(scannedFilters[0].type, undefined);
    assert.equal(
        ((scannedFilters[0]._id as { $gt: Types.ObjectId }).$gt).toHexString(),
        '000000000000000000000000'
    );
});

test('existing retry deliveries are not discarded by the new journal filter', async (context) => {
    const event = new DomainEventSchema({ eventKey: 'older-delivery', topic: 'channel' });
    const handled: string[] = [];
    context.mock.method(DomainEventDeliverySchema, 'find', (() => queryResult([{ eventID: event._id }])) as never);
    context.mock.method(DomainEventSchema, 'findById', ((id: Types.ObjectId) => {
        assert.deepEqual(id, event._id);
        return Promise.resolve(event);
    }) as never);
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: unknown, update: Record<string, unknown>) => Promise.resolve({
        _id: new Types.ObjectId(),
        status: update.$setOnInsert ? 'retry' : 'processing',
        attempts: 2,
        leaseToken: 'retry-lease'
    })) as never);
    context.mock.method(DomainEventDeliverySchema, 'updateOne', (() => Promise.resolve({ modifiedCount: 1 })) as never);
    context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => queryResult(null)) as never);
    context.mock.method(DomainEventSchema, 'find', (() => queryResult([])) as never);

    const result = await drainDomainEvents({
        consumer: 'chat-announcements-v1',
        topics: ['channel'],
        eventFilter: { 'metadata.durableChatHandled': true },
        handler: async (envelope) => { handled.push(envelope.eventKey); }
    });

    assert.equal(result.succeeded, 1);
    assert.equal(result.scanned, 0);
    assert.deepEqual(handled, [event.eventKey]);
});

const NOW = Date.UTC(2026, 8, 5);

function policyHarness(t: TestContext, age = 0) {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const event = new DomainEventSchema({
        eventKey: 'policy-event', source: 'generic-test', sourceEventId: 'policy-event',
        topic: 'channel', type: 'channel.follow.received', schemaVersion: 1,
        occurredAt: new Date(NOW - age), journaledAt: new Date(NOW),
        expiresAt: new Date(NOW + 90 * 86_400_000), payload: {}, metadata: { durableChatHandled: true }
    });
    let delivery: any;
    let checkpoint: Types.ObjectId | undefined;
    let claimDelay = 0;
    let allowTerminalWrite = true;
    const writes: any[] = [];
    const admissions: any[] = [];
    t.mock.method(DomainEventDeliverySchema, 'init', (async () => DomainEventDeliverySchema) as never);
    t.mock.method(DomainEventDeliverySchema, 'find', (() => queryResult(delivery && (
        delivery.status === 'pending' || delivery.status === 'retry' && delivery.nextAttemptAt <= new Date()
    ) ? [{ ...delivery }] : [])) as never);
    t.mock.method(DomainEventSchema, 'findById', (() => queryResult(event)) as never);
    t.mock.method(DomainEventSchema, 'find', ((filter: any) => {
        admissions.push(filter);
        // Deliberately return even incompatible versions to verify the engine's admission check too.
        return queryResult(!checkpoint || filter.dispatchPending || filter._id?.$in ? [event] : []);
    }) as never);
    t.mock.method(DomainEventSchema, 'updateMany', (() => queryResult({ modifiedCount: 1 })) as never);
    t.mock.method(DomainEventCheckpointSchema, 'findOne', (() => queryResult(checkpoint ? { lastEventID: checkpoint } : null)) as never);
    t.mock.method(DomainEventCheckpointSchema, 'updateOne', ((_filter: any, update: any) => {
        checkpoint = update.$max.lastEventID;
        return queryResult({ modifiedCount: 1 });
    }) as never);
    t.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: any, update: any) => {
        if (update.$setOnInsert) {
            delivery ||= { _id: new Types.ObjectId(), ...update.$setOnInsert };
        } else {
            t.mock.timers.tick(claimDelay);
            Object.assign(delivery, update.$set);
            delivery.attempts += update.$inc.attempts;
        }
        return queryResult({ ...delivery });
    }) as never);
    t.mock.method(DomainEventDeliverySchema, 'updateOne', ((filter: any, update: any, options: any) => {
        writes.push({ filter, update, options });
        if (!allowTerminalWrite) return queryResult({ modifiedCount: 0 });
        assert.ok(delivery);
        if (filter.leaseToken) assert.equal(filter.leaseToken, delivery.leaseToken);
        Object.assign(delivery, update.$set);
        delivery.attempts += update.$inc?.attempts || 0;
        return queryResult({ modifiedCount: 1 });
    }) as never);
    return {
        event, writes, admissions,
        get delivery() { return delivery; },
        get checkpoint() { return checkpoint; },
        setDelivery(fields: any) {
            delivery = { _id: new Types.ObjectId(), eventID: event._id, eventKey: event.eventKey,
                status: 'pending', attempts: 0, lockedUntil: null, nextAttemptAt: null,
                leaseToken: null, completedAt: null, lastDeadLetterError: '', ...fields };
        },
        delayClaim(ms: number) { claimDelay = ms; },
        loseTerminalRace() { allowTerminalWrite = false; },
        drain(options: Partial<DomainEventConsumerOptions> = {}) {
            return drainDomainEvents({ consumer: 'policy-test', topics: ['channel'], schemaVersions: [1],
                handler: async () => undefined, ...options });
        }
    };
}

for (const consumer of ['chat-announcements-v1', 'account-health-notifications-v1', 'follow-defense-v1']) {
    test(`${consumer} skips old history without effects, failure budget, or successful completion`, async t => {
        const h = policyHarness(t, 49 * 60 * 60_000);
        const definition = DOMAIN_EVENT_CONSUMERS.find(d => d.consumer === consumer)!;
        const result = await h.drain({ ...definition, handler: async () => assert.fail('Old event executed') });
        assert.equal(result.skipped, 1);
        assert.equal(result.succeeded, 0);
        assert.equal(result.retried, 0);
        assert.equal(result.dead, 0);
        assert.equal(h.delivery.status, 'skipped');
        assert.equal(h.delivery.attempts, 0);
        assert.match(h.delivery.skipReason, /maxEventAgeMs 300000/);
        assert.equal(h.delivery.completedAt.getTime(), NOW);
        assert.equal(h.delivery.lastError, '');
        assert.equal(h.delivery.nextAttemptAt, null);
        assert.deepEqual(h.checkpoint, h.event._id);
        assert.deepEqual(h.writes[0].options.writeConcern, { w: 1, j: true });
        assert.equal((await h.drain(definition)).succeeded, 0);
    });
}

test('a chat retry delayed past max age cannot emit effects, even with retained journal and retry budget', async t => {
    const h = policyHarness(t);
    let executions = 0;
    const options = { maxEventAgeMs: 300_000, handler: async () => {
        executions++;
        throw new Error('Chat dependency temporarily unavailable');
    } };
    assert.equal((await h.drain(options)).retried, 1);
    assert.equal(h.delivery.attempts, 1);
    t.mock.timers.tick(300_001);
    const result = await h.drain(options);
    assert.equal(executions, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(result.retried, 0);
    assert.equal(h.delivery.status, 'skipped');
    assert.equal(h.delivery.attempts, 1);
    assert.equal(h.delivery.completedAt.getTime(), NOW + 300_001);
});

test('age is rechecked after a delayed claim and refunds the unused attempt', async t => {
    const h = policyHarness(t, 299_999);
    h.delayClaim(2);
    const result = await h.drain({ maxEventAgeMs: 300_000, handler: async () => assert.fail('Claim crossed the age boundary') });
    assert.equal(result.skipped, 1);
    assert.equal(h.delivery.attempts, 0);
    assert.equal(h.writes[0].filter.status, 'processing');
    assert.equal(typeof h.writes[0].filter.leaseToken, 'string');
    assert.ok(h.writes[0].filter.lockedUntil.$gt instanceof Date);
});

test('dispatch persists stale admission as skipped but never creates incompatible deliveries', async t => {
    const h = policyHarness(t, 300_000);
    const options = { consumer: 'ephemeral', topics: ['channel' as const], schemaVersions: [1],
        maxEventAgeMs: 300_000, handler: async () => assert.fail('Dispatch executed handler') };
    h.event.schemaVersion = 2;
    assert.equal(await dispatchDomainEvents([options]), 1);
    assert.equal(Boolean(h.delivery), false);
    assert.deepEqual(h.admissions[1].schemaVersion, { $in: [1] });
    h.event.schemaVersion = 1;
    assert.equal(await dispatchDomainEvents([options]), 1);
    assert.equal(h.delivery.status, 'skipped');
    assert.equal(h.delivery.attempts, 0);
    assert.equal(h.delivery.completedAt.getTime(), NOW);
});

test('checkpoint admission excludes unsupported versions without delivery creation or retries', async t => {
    const h = policyHarness(t);
    h.event.schemaVersion = 2;
    const result = await h.drain({ handler: async () => assert.fail('Unsupported version executed') });
    assert.equal(h.delivery, undefined);
    assert.deepEqual(h.admissions[0].schemaVersion, { $in: [1] });
    assert.equal(result.succeeded, 0);
    assert.equal(result.retried, 0);
    assert.equal(result.dead, 0);
});

test('existing incompatible delivery is permanently dead without another attempt', async t => {
    const h = policyHarness(t);
    h.event.schemaVersion = 2;
    h.setDelivery({ status: 'retry', attempts: 2, nextAttemptAt: new Date(NOW) });
    const result = await h.drain({ handler: async () => assert.fail('Unsupported version executed') });
    assert.equal(result.dead, 1);
    assert.equal(result.retried, 0);
    assert.equal(result.succeeded, 0);
    assert.equal(h.delivery.attempts, 2);
    assert.equal(h.delivery.status, 'dead');
    assert.match(h.delivery.lastDeadLetterError, /Unsupported schema version 2/);
    assert.equal(h.delivery.completedAt.getTime(), NOW);
    assert.equal(h.delivery.deadLetteredAt.getTime(), NOW);
});

test('invalid retained known-source payload is permanently dead before effects without spending budget', async t => {
    const h = policyHarness(t);
    h.event.source = 'twitch-eventsub';
    h.setDelivery({ status: 'retry', attempts: 2, nextAttemptAt: new Date(NOW) });
    const result = await h.drain({ handler: async () => assert.fail('Invalid contract reached effects') });
    assert.equal(result.dead, 1);
    assert.equal(result.retried, 0);
    assert.equal(result.succeeded, 0);
    assert.equal(h.delivery.status, 'dead');
    assert.equal(h.delivery.attempts, 2);
    assert.equal(h.delivery.lastErrorCode, 'contract_invalid');
    assert.match(h.delivery.lastDeadLetterError, /Domain event contract:/);
    assert.equal(h.delivery.completedAt.getTime(), NOW);
    assert.equal(h.delivery.nextAttemptAt, null);
});

test('attempt timing uses a monotonic clock and error codes clear only on fenced success', async t => {
    const h = policyHarness(t);
    const warnings = t.mock.method(console, 'warn', () => undefined);
    let monotonic = 100;
    t.mock.method(performance, 'now', () => monotonic);
    const first = await h.drain({ handler: async () => {
        monotonic += 75;
        t.mock.timers.setTime(NOW - 5000);
        throw new Error('Sensitive provider detail '.repeat(1000));
    } });
    assert.equal(first.succeeded, 0);
    assert.equal(h.delivery.lastErrorCode, 'handler_failed');
    assert.equal(h.delivery.lastAttemptDurationMs, 75);
    assert.equal(h.delivery.lastError.length, 8000);
    const logged = JSON.stringify(warnings.mock.calls.map(call => call.arguments));
    assert.doesNotMatch(logged, /Sensitive provider detail|payload|leaseToken|lastError/);
    assert.match(logged, /handler_failed/);
    t.mock.timers.tick(10_000);
    const second = await h.drain({ handler: async () => { monotonic += 25; } });
    assert.equal(second.succeeded, 1);
    assert.equal(h.delivery.lastErrorCode, '');
    assert.equal(h.delivery.lastError, '');
    assert.equal(h.delivery.lastAttemptDurationMs, 25);
    assert.ok(h.writes.every(w => w.filter.status === 'processing' && w.filter.leaseToken && w.filter.lockedUntil.$gt));
});

test('lost completion ownership does not publish successful timing or clear the previous failure', async t => {
    const h = policyHarness(t);
    h.setDelivery({ lastErrorCode: 'handler_failed', lastAttemptDurationMs: 42 });
    h.loseTerminalRace();
    const result = await h.drain();
    assert.equal(result.succeeded, 0);
    assert.equal(result.deferred, 2, 'ready and checkpoint scans both lose the fenced completion');
    assert.equal(h.delivery.lastErrorCode, 'handler_failed');
    assert.equal(h.delivery.lastAttemptDurationMs, 42);
});

test('a contract helper error thrown by the handler is also permanent and refunds the attempt', async t => {
    const h = policyHarness(t);
    const result = await h.drain({ handler: async () => { throw new DomainEventContractError('invalid effect payload'); } });
    assert.equal(result.dead, 1);
    assert.equal(result.retried, 0);
    assert.equal(h.delivery.attempts, 0);
    assert.match(h.delivery.lastDeadLetterError, /invalid effect payload/);
});

for (const status of ['dead', 'succeeded', 'skipped']) {
    test(`checkpoint encounter of ${status} is not counted as a successful execution`, async t => {
        const h = policyHarness(t);
        h.setDelivery({ status });
        const result = await h.drain({ handler: async () => assert.fail('Terminal delivery executed again') });
        assert.equal(result.succeeded, 0);
        assert.equal(result.alreadyComplete, 1);
        assert.equal(result.dead, 0);
        assert.equal(result.skipped, 0);
        assert.equal(h.writes.length, 0);
    });
}

test('lost policy retirement race reports deferred, not skipped or succeeded', async t => {
    const h = policyHarness(t, 300_000);
    h.loseTerminalRace();
    const result = await h.drain({ maxEventAgeMs: 300_000, handler: async () => assert.fail('Stale event executed') });
    assert.equal(result.deferred, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.succeeded, 0);
    assert.equal(h.checkpoint, undefined);
    assert.deepEqual(h.writes[0].filter.$and[0], { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date(NOW) } }] });
});

for (const consumer of ['unknown-consumer', 'chat-announcements-v1', 'account-health-notifications-v1', 'follow-defense-v1']) {
    test(`central replay denies ${consumer} without resetting any delivery`, async t => {
        t.mock.method(DomainEventDeliverySchema, 'findOne', (() => assert.fail('Denied consumer queried delivery')) as never);
        t.mock.method(DomainEventDeliverySchema, 'updateOne', (() => assert.fail('Denied replay reset delivery')) as never);
        assert.equal(await replayDeadDomainEvent(consumer, 'event'), false);
    });
}

for (const scenario of ['missing-delivery', 'expired-delivery', 'missing-journal', 'expired-journal', 'unsupported', 'invalid-contract', 'allowed', 'lost-race']) {
    test(`central replay checks retained journal and policy: ${scenario}`, async t => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW });
        const consumer = 'stream-analytics-v1';
        const definition = DOMAIN_EVENT_CONSUMERS.find(d => d.consumer === consumer)!;
        const expiry = new Date(NOW + 86_400_000);
        const delivery = { _id: new Types.ObjectId(), eventID: new Types.ObjectId(),
            expiresAt: scenario === 'expired-delivery' ? new Date(NOW) : expiry };
        let resets = 0;
        t.mock.method(DomainEventDeliverySchema, 'findOne', ((filter: any) => {
            assert.deepEqual(filter, { consumer, eventKey: 'event', status: 'dead' });
            return queryResult(scenario === 'missing-delivery' ? null : delivery);
        }) as never);
        t.mock.method(DomainEventSchema, 'findOne', ((filter: any) => {
            assert.deepEqual(filter, { ...definition.eventFilter, _id: delivery.eventID, eventKey: 'event',
                topic: { $in: definition.topics }, schemaVersion: { $in: [1] }, expiresAt: { $gt: new Date(NOW) } });
            return queryResult(scenario === 'missing-journal' ? null : {
                source: 'twitch-eventsub', sourceEventId: 'event', type: 'channel.follow.received', topic: 'channel',
                channelID: 'channel-1', subject: { provider: 'twitch', kind: 'streaming-account', id: 'channel-1' },
                metadata: { originalEventType: 'channel.follow' },
                payload: scenario === 'invalid-contract' ? {} : {
                    subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: 'channel-1', user_id: 'follower-1' }
                },
                schemaVersion: scenario === 'unsupported' ? 2 : 1,
                occurredAt: new Date(NOW - 89 * 86_400_000),
                expiresAt: scenario === 'expired-journal' ? new Date(NOW) : expiry
            });
        }) as never);
        t.mock.method(DomainEventDeliverySchema, 'updateOne', ((filter: any, update: any, options: any) => {
            resets++;
            assert.equal(filter.status, 'dead');
            assert.deepEqual(filter.expiresAt, { $gt: new Date(NOW) });
            assert.deepEqual(filter.$expr, { $lt: ['$$NOW', expiry] });
            assert.equal(update.$set.status, 'retry');
            assert.equal(update.$set.attempts, 0);
            assert.equal(update.$set.lastErrorCode, '');
            assert.equal(update.$set.lastPrerequisiteKind, '');
            assert.equal(update.$set.lastAttemptDurationMs, null);
            assert.equal(update.$set.expiresAt, undefined, 'Replay must never extend retention');
            assert.equal(update.$set.occurredAt, undefined);
            assert.equal(update.$set.journaledAt, undefined);
            assert.equal(update.$inc.replayCount, 1);
            assert.deepEqual(options.writeConcern, { w: 1, j: true });
            return queryResult({ modifiedCount: scenario === 'lost-race' ? 0 : 1 });
        }) as never);
        assert.equal(await replayDeadDomainEvent(consumer, 'event'), scenario === 'allowed');
        assert.equal(resets, ['allowed', 'lost-race'].includes(scenario) ? 1 : 0);
    });
}

for (const consumer of ['polar-plan-v1', 'polar-credits-v1', 'polar-rewards-v1', 'stream-operations-v1']) {
    test(`${consumer} permits retained history replay without adding an age cutoff`, async t => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW });
        const expiresAt = new Date(NOW + 86_400_000);
        const delivery = { _id: new Types.ObjectId(), eventID: new Types.ObjectId(), expiresAt };
        const operations = consumer === 'stream-operations-v1';
        const credits = consumer === 'polar-credits-v1';
        const event = {
            source: operations ? 'twitch-eventsub' : 'polar-webhook', sourceEventId: 'event', schemaVersion: 1,
            topic: operations ? 'channel' : 'domain',
            type: operations ? 'stream.started' : credits ? 'billing.customer.state.changed' : 'billing.order.paid',
            occurredAt: new Date(NOW - 89 * 86_400_000), expiresAt,
            ...(operations ? {
                channelID: 'channel-1', streamID: 'stream-1',
                subject: { provider: 'twitch', kind: 'streaming-account', id: 'channel-1' },
                metadata: { originalEventType: 'stream.online' },
                payload: { subscription: { type: 'stream.online' }, event: { broadcaster_user_id: 'channel-1', id: 'stream-1' } }
            } : {
                subject: { provider: 'polar', kind: 'customer', id: 'customer-1' },
                metadata: { originalEventType: credits ? 'customer.state_changed' : 'order.paid' },
                payload: credits ? { customerId: 'customer-1', meters: [] }
                    : { customerId: 'customer-1', orderId: 'order-1', status: 'paid', paid: true }
            })
        };
        t.mock.method(DomainEventDeliverySchema, 'findOne', (() => queryResult(delivery)) as never);
        t.mock.method(DomainEventSchema, 'findOne', (() => queryResult(event)) as never);
        t.mock.method(DomainEventDeliverySchema, 'updateOne', ((_filter: any, update: any) => {
            assert.equal(update.$set.expiresAt, undefined);
            assert.equal(update.$set.status, 'retry');
            return queryResult({ modifiedCount: 1 });
        }) as never);
        assert.equal(await replayDeadDomainEvent(consumer, 'event'), true);
    });
}

test('skipped status is schema-valid and legacy delivery rows require no new field', () => {
    for (const status of ['pending', 'retry', 'succeeded', 'dead', 'skipped']) {
        const delivery = new DomainEventDeliverySchema({
            consumer: 'legacy', topic: 'channel', eventID: new Types.ObjectId(), eventKey: 'event',
            status, expiresAt: new Date(NOW + 86_400_000)
        });
        assert.equal(delivery.validateSync(), undefined);
        assert.equal(delivery.skipReason, '');
        assert.equal(delivery.lastErrorCode, '');
        assert.equal(delivery.lastPrerequisiteKind, '');
        assert.equal(delivery.lastAttemptDurationMs, null);
        delivery.lastAttemptDurationMs = -1;
        assert.ok(delivery.validateSync()?.errors.lastAttemptDurationMs);
    }
});
