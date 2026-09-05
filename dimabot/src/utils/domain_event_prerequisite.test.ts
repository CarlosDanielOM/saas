import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import { DomainEventPrerequisiteMissingError } from '../domain_events/domain_event.types.js';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { drainDomainEvents } from './domain_event_consumer.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 5);

function query<T>(value: T) {
    return {
        sort() { return this; }, limit() { return this; }, lean: async () => value,
        then: Promise.resolve(value).then.bind(Promise.resolve(value))
    };
}

function setup(t: TestContext, age = 0, retention = DAY * 90) {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const event = new DomainEventSchema({
        eventKey: 'metric', topic: 'channel', type: 'channel.follow.received',
        journaledAt: new Date(NOW - age), expiresAt: new Date(NOW + retention)
    });
    const started = new DomainEventSchema({ eventKey: 'start', topic: 'channel', type: 'stream.started' });
    const deliveries = new Map<string, any>();
    const writes: any[] = [];
    let checkpoint: Types.ObjectId | undefined;
    let loseDeferralResponse = false;
    t.mock.method(DomainEventDeliverySchema, 'find', (() => query([...deliveries.values()].filter(d =>
        d.status === 'retry' && d.nextAttemptAt <= new Date()))) as never);
    t.mock.method(DomainEventSchema, 'findById', ((id: Types.ObjectId) => query(id.equals(event._id) ? event : started)) as never);
    t.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query(checkpoint ? { lastEventID: checkpoint } : null)) as never);
    t.mock.method(DomainEventSchema, 'find', (() => query([event, started].filter(e => !checkpoint || e._id > checkpoint))) as never);
    t.mock.method(DomainEventCheckpointSchema, 'updateOne', ((_filter: any, update: any) => {
        checkpoint = update.$max.lastEventID;
        return query({ modifiedCount: 1 });
    }) as never);
    t.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((filter: any, update: any) => {
        if (update.$setOnInsert) {
            if (!deliveries.has(filter.eventKey)) deliveries.set(filter.eventKey, { _id: new Types.ObjectId(), ...update.$setOnInsert });
            return query({ ...deliveries.get(filter.eventKey) });
        }
        const d = [...deliveries.values()].find(d => d._id.equals(filter._id));
        assert.ok(d.attempts < filter.attempts.$lt);
        Object.assign(d, update.$set);
        d.attempts += update.$inc.attempts;
        return query({ ...d });
    }) as never);
    t.mock.method(DomainEventDeliverySchema, 'updateOne', (async (filter: any, update: any, options: any) => {
        const d = [...deliveries.values()].find(d => d._id.equals(filter._id));
        assert.equal(filter.leaseToken, d.leaseToken);
        assert.ok(filter.lockedUntil.$gt instanceof Date);
        writes.push({ update, options });
        Object.assign(d, update.$set);
        d.attempts += update.$inc?.attempts || 0;
        if (loseDeferralResponse && update.$inc?.attempts === -1) {
            loseDeferralResponse = false;
            throw new Error('Deferral response lost');
        }
        return { modifiedCount: 1 };
    }) as never);
    return {
        event, started, deliveries, writes,
        loseResponse() { loseDeferralResponse = true; },
        get checkpoint() { return checkpoint; },
        drain(handler: (event: any) => Promise<void>, maxAttempts = 2) {
            return drainDomainEvents({ consumer: 'stage2', topics: ['channel'], handler, maxAttempts });
        }
    };
}

test('missing prerequisite does not spend failure budget or block delayed stream.started', async t => {
    const h = setup(t);
    let session = false;
    let applied = 0;
    const handler = async (e: any) => {
        if (e.type === 'stream.started') { session = true; return; }
        if (!session) throw new DomainEventPrerequisiteMissingError('stream-session');
        applied++;
    };
    const first = await h.drain(handler, 1);
    assert.equal(first.deferred, 1);
    assert.equal(first.succeeded, 1);
    assert.equal(h.checkpoint, h.started._id);
    const delivery = h.deliveries.get('metric');
    assert.equal(delivery.status, 'retry');
    assert.equal(delivery.lastErrorCode, 'prerequisite_missing');
    assert.equal(delivery.lastPrerequisiteKind, 'other');
    assert.equal(delivery.attempts, 0);
    assert.equal(delivery.completedAt, null);
    assert.equal(delivery.nextAttemptAt.getTime(), NOW + 30_000);
    assert.deepEqual(h.writes[0].options.writeConcern, { w: 1, j: true });
    t.mock.timers.tick(30_000);
    assert.equal((await h.drain(handler, 1)).succeeded, 1);
    assert.equal(applied, 1);
    assert.equal(delivery.status, 'succeeded');
    assert.equal(delivery.lastErrorCode, '');
    assert.equal(delivery.lastPrerequisiteKind, '');
});

test('repeated prerequisites preserve ordinary retry budget, including the last attempt', async t => {
    const h = setup(t);
    let failNormally = true;
    const handler = async (e: any) => {
        if (e.eventKey !== 'metric') return;
        if (failNormally) throw new Error('Transient write failure');
        throw new DomainEventPrerequisiteMissingError('stream-session');
    };
    await h.drain(handler);
    failNormally = false;
    for (let i = 0; i < 8; i++) {
        t.mock.timers.tick(30_000);
        assert.equal((await h.drain(handler)).deferred, 1);
        assert.equal(h.deliveries.get('metric').attempts, 1);
    }
    failNormally = true;
    t.mock.timers.tick(30_000);
    assert.equal((await h.drain(handler)).dead, 1);
    assert.match(h.deliveries.get('metric').lastDeadLetterError, /Transient write failure/);
});

for (const [name, age, retention] of [
    ['journal horizon', DAY, DAY * 90],
    ['retention cap', 0, 0]
] as const) {
    test(`${name} dead-letters missing prerequisites with an explicit reason`, async t => {
        const h = setup(t, age, retention);
        const result = await h.drain(async e => {
            if (e.eventKey === 'metric') throw new DomainEventPrerequisiteMissingError('stream-session');
        });
        assert.equal(result.dead, 1);
        const d = h.deliveries.get('metric');
        assert.equal(d.status, 'dead');
        assert.equal(d.lastErrorCode, 'prerequisite_missing');
        assert.equal(d.attempts, 0);
        assert.equal(d.nextAttemptAt, null);
        assert.match(d.lastDeadLetterError, /Prerequisite horizon exceeded.*stream-session/);
        assert.equal(h.checkpoint, h.started._id);
    });
}

test('retry delay is capped at expiry and the horizon cannot slide with each deferral', async t => {
    const h = setup(t, DAY - 10_000);
    const handler = async (e: any) => {
        if (e.eventKey === 'metric') throw new DomainEventPrerequisiteMissingError('stream-session');
    };
    await h.drain(handler);
    assert.equal(h.deliveries.get('metric').nextAttemptAt.getTime(), NOW + 10_000);
    t.mock.timers.tick(10_000);
    assert.equal((await h.drain(handler)).dead, 1);
});

test('owner repair beyond the ordinary 36-minute budget succeeds within the fixed 24-hour horizon', async t => {
    const h = setup(t, 23 * 60 * 60_000);
    let repaired = false;
    const handler = async (e: any) => {
        if (e.eventKey === 'metric' && !repaired) throw new DomainEventPrerequisiteMissingError('owner:polar mapping');
    };
    await h.drain(handler, 1);
    const delivery = h.deliveries.get('metric');
    assert.equal(delivery.lastErrorCode, 'prerequisite_missing');
    assert.equal(delivery.lastPrerequisiteKind, 'owner');
    assert.equal(delivery.attempts, 0);
    t.mock.timers.tick(37 * 60_000);
    assert.equal((await h.drain(handler, 1)).dead, 0);
    assert.equal(delivery.status, 'retry');
    repaired = true;
    t.mock.timers.tick(30_000);
    assert.equal((await h.drain(handler, 1)).succeeded, 1);
    assert.equal(delivery.lastPrerequisiteKind, '');
    assert.equal(h.event.ownerUserId, undefined);
});

test('owner prerequisite stops at the original 24-hour horizon, not 24 hours from each retry', async t => {
    const h = setup(t, DAY - 1);
    const handler = async (e: any) => {
        if (e.eventKey === 'metric') throw new DomainEventPrerequisiteMissingError('owner:polar mapping');
    };
    await h.drain(handler, 1);
    t.mock.timers.tick(1);
    const result = await h.drain(handler, 1);
    assert.equal(result.dead, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(h.deliveries.get('metric').lastPrerequisiteKind, 'owner');
});

test('lost deferral response leaves a durable retry that subsequent scans can pass', async t => {
    const h = setup(t);
    h.loseResponse();
    const handler = async (e: any) => {
        if (e.eventKey === 'metric') throw new DomainEventPrerequisiteMissingError('stream-session');
    };
    await assert.rejects(h.drain(handler), /Deferral response lost/);
    assert.equal(h.checkpoint, undefined);
    assert.equal(h.deliveries.get('metric').attempts, 0);
    await h.drain(handler);
    assert.equal(h.checkpoint, h.started._id);
    assert.equal(h.deliveries.get('start').status, 'succeeded');
});
