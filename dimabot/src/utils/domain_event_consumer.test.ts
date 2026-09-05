import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { drainDomainEvents } from './domain_event_consumer.js';

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
            occurredAt: new Date('2026-09-03T12:00:00Z'),
            journaledAt: new Date('2026-09-03T12:00:01Z'),
            payload: {},
            metadata: { durableChatHandled: true },
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
