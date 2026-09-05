import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';
import { dispatchDomainEvents, drainDomainEvents } from './domain_event_consumer.js';

function query<T>(value: T) {
    const result = {
        sort() { return result; },
        limit() { return result; },
        select() { return result; },
        lean: async () => value,
        then: <R>(resolve: (value: T) => R) => Promise.resolve(value).then(resolve)
    };
    return result;
}

function createEvent() {
    return new DomainEventSchema({
        _id: new Types.ObjectId('000000000000000000000001'),
        source: 'polar-webhook', sourceEventId: 'late-insert', eventKey: 'polar:late-insert',
        type: 'billing.order.paid', topic: 'domain',
        payload: { customerId: 'customer-1', orderId: 'order-1', status: 'paid', paid: true },
        metadata: { originalEventType: 'order.paid' },
        subject: { provider: 'polar', kind: 'customer', id: 'customer-1' },
        occurredAt: new Date('2026-09-05T12:00:00Z'),
        expiresAt: new Date('2026-12-05T12:00:00Z'), dispatchPending: true
    });
}

test('dispatch discovers a late lower-ID insert without reading a checkpoint', async (context) => {
    const event = createEvent();
    const calls: string[] = [];
    context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => {
        assert.fail('Dispatch must not use checkpoint ordering');
    }) as never);
    context.mock.method(DomainEventDeliverySchema, 'init', (async () => DomainEventDeliverySchema) as never);
    context.mock.method(DomainEventSchema, 'find', ((filter: Record<string, unknown>) => {
        if (filter.dispatchPending === true) return query([event]);
        assert.deepEqual(filter._id, { $in: [event._id] });
        assert.deepEqual(filter.topic, { $in: ['domain'] });
        assert.equal(filter.source, 'polar-webhook');
        return query(filter.type === event.type ? [event] : []);
    }) as never);
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((filter: unknown, update: Record<string, any>, options: unknown) => {
        calls.push('delivery');
        assert.deepEqual(filter, { consumer: 'billing-v1', eventKey: event.eventKey });
        assert.equal(update.$setOnInsert.status, 'pending');
        assert.deepEqual(update.$setOnInsert.eventID, event._id);
        assert.deepEqual((options as { writeConcern: unknown }).writeConcern, { w: 1, j: true });
        return query(update.$setOnInsert);
    }) as never);
    context.mock.method(DomainEventSchema, 'updateMany', ((filter: unknown, update: unknown) => {
        assert.deepEqual(filter, { _id: { $in: [event._id] }, dispatchPending: true });
        assert.deepEqual(update, { $set: { dispatchPending: false } });
        calls.push('clear');
        return query({ modifiedCount: 1 });
    }) as never);

    assert.equal(await dispatchDomainEvents([
        { consumer: 'billing-v1', topics: ['domain'], eventFilter: { source: 'polar-webhook', type: event.type }, handler: async () => undefined },
        { consumer: 'credits-v1', topics: ['domain'], eventFilter: { source: 'polar-webhook', type: 'billing.customer.state.changed' }, handler: async () => undefined }
    ]), 1);
    assert.deepEqual(calls, ['delivery', 'clear']);
});

test('failed partial fanout retains the receipt and retries only idempotent delivery upserts', async (context) => {
    const event = createEvent();
    const deliveries = new Map<string, Record<string, unknown>>();
    let failSecond = true;
    let clears = 0;
    context.mock.method(DomainEventDeliverySchema, 'init', (async () => DomainEventDeliverySchema) as never);
    context.mock.method(DomainEventSchema, 'find', (() => query([event])) as never);
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((filter: { consumer: string }, update: { $setOnInsert: Record<string, unknown> }) => {
        if (filter.consumer === 'second' && failSecond) throw new Error('Delivery write failed');
        if (!deliveries.has(filter.consumer)) deliveries.set(filter.consumer, update.$setOnInsert);
        return query(deliveries.get(filter.consumer));
    }) as never);
    context.mock.method(DomainEventSchema, 'updateMany', (() => {
        clears += 1;
        assert.equal(deliveries.size, 2);
        return query({ modifiedCount: 1 });
    }) as never);
    const definitions = ['first', 'second'].map((consumer) => ({
        consumer, topics: ['domain' as const], handler: async () => undefined
    }));

    await assert.rejects(dispatchDomainEvents(definitions), /Delivery write failed/);
    assert.equal(clears, 0);
    assert.equal(deliveries.size, 1);
    failSecond = false;
    assert.equal(await dispatchDomainEvents(definitions), 1);
    assert.equal(deliveries.size, 2);
    assert.equal(clears, 1);
});

for (const status of ['pending', 'processing'] as const) {
    test(`${status} delivery recovers below the checkpoint, including an expired processing lease`, async (context) => {
        const event = createEvent();
        const checkpointID = new Types.ObjectId('ffffffffffffffffffffffff');
        const delivery = {
            _id: new Types.ObjectId(), status, eventID: event._id,
            lockedUntil: status === 'processing' ? new Date(0) : null,
            nextAttemptAt: null, leaseToken: 'old-lease', attempts: 1
        };
        let handled = 0;
        context.mock.method(DomainEventDeliverySchema, 'find', ((filter: Record<string, any>) => {
            assert.equal(filter.consumer, 'billing-v1');
            assert.deepEqual(filter.$or[0], { status: 'pending' });
            assert.equal(filter.$or[1].status, 'retry');
            assert.equal(filter.$or[2].status, 'processing');
            assert.ok(filter.$or[2].$or[1].lockedUntil.$lte instanceof Date);
            return query([delivery]);
        }) as never);
        context.mock.method(DomainEventSchema, 'findById', ((id: Types.ObjectId) => {
            assert.deepEqual(id, event._id);
            return query(event);
        }) as never);
        context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: unknown, update: Record<string, any>) => {
            return query(update.$setOnInsert ? delivery : { ...delivery, ...update.$set, attempts: 2 });
        }) as never);
        context.mock.method(DomainEventDeliverySchema, 'updateOne', (() => query({ modifiedCount: 1 })) as never);
        context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query({ lastEventID: checkpointID })) as never);
        context.mock.method(DomainEventSchema, 'find', ((filter: Record<string, unknown>) => {
            assert.deepEqual(filter._id, { $gt: checkpointID });
            return query([]);
        }) as never);
        const result = await drainDomainEvents({
            consumer: 'billing-v1', topics: ['domain'], schemaVersions: [1],
            handler: async (envelope) => {
                assert.equal(envelope.eventKey, event.eventKey);
                handled += 1;
            }
        });
        assert.equal(handled, 1);
        assert.equal(result.ready, 1);
        assert.equal(result.succeeded, 1);
        assert.equal(result.scanned, 0);
    });
}

test('an unexpired lease cannot be stolen even if another scan observed the delivery earlier', async (context) => {
    const event = createEvent();
    const delivery = {
        _id: new Types.ObjectId(), eventID: event._id, status: 'processing',
        lockedUntil: new Date(Date.now() + 60_000), leaseToken: 'active-lease'
    };
    context.mock.method(DomainEventDeliverySchema, 'find', (() => query([delivery])) as never);
    context.mock.method(DomainEventSchema, 'findById', (() => query(event)) as never);
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: unknown, update: Record<string, unknown>) => {
        assert.ok(update.$setOnInsert, 'Must not attempt to claim a live lease');
        return query(delivery);
    }) as never);
    context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query(null)) as never);
    context.mock.method(DomainEventSchema, 'find', (() => query([])) as never);
    const result = await drainDomainEvents({
        consumer: 'billing-v1', topics: ['domain'],
        handler: async () => { assert.fail('Live lease was stolen'); }
    });
    assert.equal(result.deferred, 1);
    assert.equal(result.succeeded, 0);
});

test('unsupported event versions are rejected before consumer effects', async (context) => {
    const event = createEvent();
    event.schemaVersion = 2;
    context.mock.method(DomainEventDeliverySchema, 'find', (() => query([{ eventID: event._id }])) as never);
    context.mock.method(DomainEventSchema, 'findById', (() => query(event)) as never);
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: unknown, update: Record<string, unknown>) => query({
        _id: new Types.ObjectId(), status: update.$setOnInsert ? 'pending' : 'processing',
        attempts: 1, leaseToken: 'test-lease'
    })) as never);
    let failureRecorded = false;
    context.mock.method(DomainEventDeliverySchema, 'updateOne', ((_filter: unknown, update: Record<string, any>) => {
        assert.match(update.$set.lastError, /Unsupported schema version 2 for billing-v1/);
        failureRecorded = true;
        // Simulate a lost lease so the error path needs no cache-backed logger.
        return query({ modifiedCount: 0 });
    }) as never);
    context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query(null)) as never);
    context.mock.method(DomainEventSchema, 'find', (() => query([])) as never);
    await drainDomainEvents({
        consumer: 'billing-v1', topics: ['domain'], schemaVersions: [1],
        handler: async () => { assert.fail('Unsupported version reached a consumer'); }
    });
    assert.equal(failureRecorded, true);
});
