import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { DOMAIN_EVENT_PRODUCERS, ingestDomainEvent } from './domain_event_producers.js';
import type { DomainEventProducer, JournalDomainEventInput } from './domain_event.types.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { DOMAIN_EVENT_CONSUMERS } from './domain_event_consumers.js';

test('Twitch producer adds internal ownership without changing provider channel identity', async () => {
    let journaled: JournalDomainEventInput | undefined;
    const ownerUserId = new Types.ObjectId().toString();
    const result = await ingestDomainEvent(DOMAIN_EVENT_PRODUCERS.twitch, {
        messageId: 'twitch-message',
        subscription: { type: 'channel.follow' },
        event: { broadcaster_user_id: '123', user_id: '456' },
        durableChatHandled: true
    }, {
        resolveOwner: async (event) => {
            assert.deepEqual(event.subject, { provider: 'twitch', kind: 'streaming-account', id: '123' });
            return ownerUserId;
        },
        journal: async (event) => {
            journaled = event;
            return { event: new DomainEventSchema(event), inserted: true };
        }
    });
    assert.equal(result?.inserted, true);
    assert.equal(journaled?.ownerUserId, ownerUserId);
    assert.equal(journaled?.channelID, '123');
    assert.equal(journaled?.source, 'twitch-eventsub');
    assert.equal(journaled?.metadata?.durableChatHandled, true);
});

test('a provider can journal an unresolved customer without fabricating a Twitch channel', async () => {
    const producer: DomainEventProducer<void> = {
        provider: 'example-payment',
        normalize: () => ({
            source: 'example-payment-webhook', sourceEventId: 'receipt-1',
            type: 'billing.order.paid', topic: 'domain',
            subject: { provider: 'example-payment', kind: 'customer', id: 'customer-1' },
            payload: {}
        })
    };
    const result = await ingestDomainEvent(producer, undefined, {
        resolveOwner: async () => undefined,
        journal: async (input) => {
            assert.equal(input.channelID, undefined);
            assert.equal(input.ownerUserId, undefined);
            const event = new DomainEventSchema(input);
            event.eventKey = 'receipt-1';
            event.occurredAt = new Date();
            event.expiresAt = new Date();
            await event.validate();
            return { event, inserted: true };
        }
    });
    assert.equal(result?.inserted, true);
});

test('unsubscribed provider events do not resolve accounts or write the journal', async () => {
    const result = await ingestDomainEvent(DOMAIN_EVENT_PRODUCERS.twitch, {
        messageId: 'chat', subscription: { type: 'channel.chat.message' }, event: {}
    }, {
        resolveOwner: async () => { assert.fail('Unexpected account lookup'); },
        journal: async () => { assert.fail('Unexpected journal write'); }
    });
    assert.equal(result, null);
});

test('producer subject mismatch is rejected before ownership resolution', async () => {
    await assert.rejects(ingestDomainEvent({
        provider: 'paypal',
        normalize: () => ({
            source: 'paypal', sourceEventId: 'id', type: 'billing.order.paid', topic: 'domain',
            subject: { provider: 'twitch', kind: 'streaming-account', id: '123' }, payload: {}
        })
    }, undefined), /must supply its own provider subject/);
});

test('a producer can preserve ownership already resolved at its trusted transport boundary', async () => {
    const ownerUserId = new Types.ObjectId().toString();
    await ingestDomainEvent({
        provider: 'example',
        normalize: () => ({
            source: 'example', sourceEventId: 'id', type: 'example.event', topic: 'domain',
            ownerUserId, subject: { provider: 'example', kind: 'integration-account', id: 'integration-1' }, payload: {}
        })
    }, undefined, {
        journal: async (input) => {
            assert.equal(input.ownerUserId, ownerUserId);
            return { event: new DomainEventSchema(input), inserted: true };
        }
    });
});

test('existing consumer IDs and Twitch-only scope remain explicit in the registry', () => {
    const twitchConsumers = DOMAIN_EVENT_CONSUMERS.filter(({ topics }) => topics.includes('channel'));
    assert.deepEqual(twitchConsumers.map(({ consumer }) => consumer), [
        'stream-analytics-v1', 'stream-operations-v1', 'chat-announcements-v1', 'account-health-notifications-v1'
    ]);
    for (const definition of twitchConsumers) {
        assert.deepEqual(definition.schemaVersions, [1]);
        assert.deepEqual(definition.eventFilter?.source, { $in: ['twitch-eventsub', 'twitch-eventsub-test'] });
    }
});
