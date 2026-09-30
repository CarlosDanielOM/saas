import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTwitchEventsubDomainEvent } from './twitch_eventsub_events.js';
import { validateDomainEventContract } from './domain_event_contracts.js';
import { generateTestPayload, getTestableEventTypes } from '../utils/eventsub.test-data.js';

function notification() {
    const payload = generateTestPayload('channel.chat.notification', '1234');
    return { messageId: 'notice-receipt', messageTimestamp: '2026-09-30T12:00:00Z',
        subscription: { ...payload.subscription }, event: { ...payload.event } };
}

test('watch streak notices preserve provider data with independent event identity', () => {
    const input = notification();
    const event = normalizeTwitchEventsubDomainEvent(input);
    assert.ok(event);
    validateDomainEventContract(event, 'ingest');
    assert.equal(event.type, 'channel.chat.notification');
    assert.equal(event.sourceEventId, 'notice-receipt');
    assert.deepEqual(event.payload, { subscription: input.subscription, event: input.event });
    assert.deepEqual(event.subject, { provider: 'twitch', kind: 'streaming-account', id: '1234' });
    assert.equal(input.subscription.condition.user_id, '698614112');
    assert.ok(getTestableEventTypes().includes('channel.chat.notification'));
});

test('resubs, anonymous gifts, shared chat and future notices retain nullable fields', () => {
    for (const notice_type of ['resub', 'sub_gift', 'shared_chat_resub', 'future_notice']) {
        const input = notification();
        Object.assign(input.event, { notice_type, watch_streak: null, sub: null,
            resub: { cumulative_months: 10, streak_months: null, sub_plan: '1000' },
            source_broadcaster_user_id: '4321', source_message_id: 'source-notice',
            chatter_is_anonymous: true, chatter_user_id: '', chatter_user_login: '', chatter_user_name: '' });
        const event = normalizeTwitchEventsubDomainEvent(input);
        assert.ok(event);
        validateDomainEventContract(event, 'ingest');
        assert.equal(event.channelID, '1234');
        assert.deepEqual(event.payload.event, input.event);
    }
});

test('malformed chat notices fail contract validation', () => {
    for (const invalid of [{ notice_type: '' }, { message_id: '' }, { chatter_is_anonymous: 'false' },
        { chatter_user_id: '' }, { message: { text: '', fragments: null } },
        { watch_streak: null }, { watch_streak: { streak_count: -1, channel_points_awarded: 450 } },
        { watch_streak: { streak_count: 5, channel_points_awarded: -1 } }]) {
        const input = notification();
        Object.assign(input.event, invalid);
        const event = normalizeTwitchEventsubDomainEvent(input);
        assert.ok(event);
        assert.throws(() => validateDomainEventContract(event, 'ingest'), /Domain event contract/);
    }
});
