import assert from 'node:assert/strict';
import test from 'node:test';
import { isDurableTwitchEventsubType, normalizeTwitchEventsubDomainEvent, type NormalizeTwitchEventsubInput } from './twitch_eventsub_events.js';
import { DomainEventContractError } from './domain_event_contracts.js';

test('normalizes a bits notification into a durable channel event', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-1',
        messageTimestamp: '2026-08-28T10:00:00Z',
        subscription: { id: 'sub-1', type: 'channel.bits.use', version: '1' },
        event: {
            broadcaster_user_id: '1234',
            bits: 500,
            user_id: '5678'
        }
    });

    assert.ok(event);
    assert.equal(event.type, 'channel.bits.received');
    assert.equal(event.channelID, '1234');
    assert.equal(event.sourceEventId, 'message-1');
    assert.equal(event.metadata?.originalEventType, 'channel.bits.use');
});

test('preserves gift quantity and original subscription type', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-2',
        subscription: { type: 'channel.subscription.gift', version: '1' },
        event: {
            broadcaster_user_id: '1234',
            total: 50,
            tier: '1000'
        }
    });

    assert.ok(event);
    assert.equal(event.type, 'channel.subscription.gifted');
    assert.equal((event.payload.event as Record<string, unknown>).total, 50);
    assert.equal(event.metadata?.originalEventType, 'channel.subscription.gift');
});

test('uses stream identity and start time for lifecycle events', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-3',
        subscription: { type: 'stream.online', version: '1' },
        event: {
            id: 'stream-9',
            broadcaster_user_id: '1234',
            started_at: '2026-08-28T11:00:00Z'
        }
    });

    assert.ok(event);
    assert.equal(event.type, 'stream.started');
    assert.equal(event.streamID, 'stream-9');
    assert.equal(event.occurredAt, '2026-08-28T11:00:00Z');
});

test('does not journal disposable chat notifications', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-4',
        subscription: { type: 'channel.chat.message', version: '1' },
        event: {
            broadcaster_user_id: '1234',
            message: { text: 'hello' }
        }
    });

    assert.equal(event, null);
});

test('rejects durable events without a channel identity', () => {
    assert.throws(() => normalizeTwitchEventsubDomainEvent({
        messageId: 'message-5',
        subscription: { type: 'channel.follow', version: '2' },
        event: { user_id: '5678' }
    }), /missing a channel ID/);
});

test('normalizes every durable contribution and lifecycle subscription type', () => {
    const cases = [
        ['channel.cheer', 'channel.bits.received'],
        ['channel.bit.use', 'channel.bits.received'],
        ['channel.follow', 'channel.follow.received'],
        ['channel.subscribe', 'channel.subscription.received'],
        ['channel.subscription.message', 'channel.subscription.received'],
        ['channel.subscription.gift', 'channel.subscription.gifted'],
        ['channel.subscription.end', 'channel.subscription.ended'],
        ['stream.offline', 'stream.ended']
    ] as const;

    for (const [subscriptionType, domainType] of cases) {
        const event = normalizeTwitchEventsubDomainEvent({
            messageId: `message-${subscriptionType}`,
            messageTimestamp: '2026-08-28T12:00:00Z',
            subscription: { type: subscriptionType, version: '1' },
            event: { broadcaster_user_id: '1234' }
        });
        assert.ok(event);
        assert.equal(event.type, domainType);
        assert.equal(event.occurredAt, '2026-08-28T12:00:00Z');
    }
});

test('uses the destination broadcaster for raids', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-destination',
        subscription: { type: 'channel.raid', version: '1' },
        event: { to_broadcaster_user_id: '4321', from_broadcaster_user_id: '1234', viewers: 5 }
    });

    assert.ok(event);
    assert.equal(event.channelID, '4321');
});

test('defaults a missing gift total without changing the payload', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-gift-default',
        subscription: { type: 'channel.subscription.gift', version: '1' },
        event: { broadcaster_user_id: '1234', is_anonymous: true }
    });

    assert.ok(event);
    assert.equal((event.payload.event as Record<string, unknown>).total, undefined);
});

test('records stale retry audit metadata', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'message-stale-retry',
        messageTimestamp: '2026-08-28T10:00:00Z',
        messageRetry: 2,
        staleRetry: true,
        subscription: { type: 'channel.follow', version: '2' },
        event: { broadcaster_user_id: '1234', user_id: '5678' }
    });

    assert.ok(event);
    assert.equal(event.metadata?.messageRetry, 2);
    assert.equal(event.metadata?.staleRetry, true);
});

test('raid normalization uses the destination and original delivery time', () => {
    const event = normalizeTwitchEventsubDomainEvent({
        messageId: 'raid-receipt', messageTimestamp: '2026-09-05T12:00:00Z', durableDefenseHandled: true,
        subscription: { type: 'channel.raid', version: '1' },
        event: { to_broadcaster_user_id: 'target', from_broadcaster_user_id: 'raider', viewers: 12 }
    });
    assert.ok(event);
    assert.equal(event.type, 'channel.raid.received');
    assert.equal(event.channelID, 'target');
    assert.deepEqual(event.subject, { provider: 'twitch', kind: 'streaming-account', id: 'target' });
    assert.equal(event.sourceEventId, 'raid-receipt');
    assert.equal(event.occurredAt, '2026-09-05T12:00:00Z');
    assert.equal(event.metadata?.durableDefenseHandled, true);
});

test('defense ownership is opt-in, production-only and follow/raid-only', () => {
    for (const source of ['twitch-eventsub', 'twitch-eventsub-test'] as const) {
        for (const type of ['channel.follow', 'channel.raid', 'stream.online', 'channel.bits.use']) {
            for (const marked of [false, true]) {
                const event = normalizeTwitchEventsubDomainEvent({
                    messageId: 'receipt', source, durableDefenseHandled: marked,
                    subscription: { type }, event: { broadcaster_user_id: 'channel', to_broadcaster_user_id: 'channel' }
                });
                assert.equal(event?.metadata?.durableDefenseHandled,
                    marked && source === 'twitch-eventsub' && ['channel.follow', 'channel.raid'].includes(type) ? true : undefined);
            }
        }
    }
});

test('redemption AST, chat, ad and ban notifications remain unjournaled', () => {
    for (const type of ['channel.channel_points_custom_reward_redemption.add', 'channel.chat.message', 'channel.ad_break.begin', 'channel.ban']) {
        assert.equal(normalizeTwitchEventsubDomainEvent({
            messageId: 'receipt', durableDefenseHandled: true,
            subscription: { type }, event: { broadcaster_user_id: 'channel' }
        }), null);
    }
});

test('prototype property names cannot become durable Twitch event types', () => {
    for (const type of ['constructor', '__proto__', 'toString']) {
        assert.equal(isDurableTwitchEventsubType(type), false);
        assert.equal(normalizeTwitchEventsubDomainEvent({ messageId: 'receipt', subscription: { type }, event: {} }), null);
    }
});

test('malformed Twitch normalization keys fail permanently rather than coercing source or receipt identity', () => {
    const valid = { messageId: 'receipt', subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: 'channel', user_id: 'user' } };
    for (const input of [null, { ...valid, subscription: null }, { ...valid, event: null },
        { ...valid, event: [] }, { ...valid, messageId: 123 }, { ...valid, source: 'generic-bypass' }]) {
        assert.throws(() => normalizeTwitchEventsubDomainEvent(input as NormalizeTwitchEventsubInput), DomainEventContractError);
    }
});
