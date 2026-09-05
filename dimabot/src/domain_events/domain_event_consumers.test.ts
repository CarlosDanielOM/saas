import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_EVENT_CONSUMERS } from './domain_event_consumers.js';

test('defense admission is channel v1, exactly production Twitch, marked follow/raid only', () => {
    const definition = DOMAIN_EVENT_CONSUMERS.find(({ consumer }) => consumer === 'follow-defense-v1');
    assert.ok(definition);
    assert.deepEqual(definition.topics, ['channel']);
    assert.deepEqual(definition.schemaVersions, [1]);
    assert.deepEqual(definition.eventFilter, {
        source: 'twitch-eventsub',
        'metadata.durableDefenseHandled': true,
        type: { $in: ['channel.follow.received', 'channel.raid.received'] }
    });
    assert.equal(new Set(DOMAIN_EVENT_CONSUMERS.map(({ consumer }) => consumer)).size, DOMAIN_EVENT_CONSUMERS.length);
});

test('every registry entry explicitly declares replay and ephemeral consumers stay below receipt retention', () => {
    const ephemeral = ['chat-announcements-v1', 'account-health-notifications-v1', 'follow-defense-v1'];
    for (const definition of DOMAIN_EVENT_CONSUMERS) {
        assert.equal(typeof definition.adminReplay, 'boolean', definition.consumer);
        assert.equal(definition.adminReplay, !ephemeral.includes(definition.consumer), definition.consumer);
        if (ephemeral.includes(definition.consumer)) {
            assert.equal(definition.maxEventAgeMs, 300_000);
            assert.ok(definition.maxEventAgeMs < 48 * 60 * 60_000);
        } else {
            assert.equal(definition.maxEventAgeMs, undefined, 'Retained projections and lifecycle recovery remain uncapped');
        }
    }
});

test('history uses existing markers, with no startup-time or new date cutoff', () => {
    for (const definition of DOMAIN_EVENT_CONSUMERS) {
        const filter = definition.eventFilter!;
        assert.equal(filter.occurredAt, undefined);
        assert.equal(filter.journaledAt, undefined);
        assert.equal(filter._id, undefined);
        assert.equal(filter['metadata.durableChatHandled'],
            ['chat-announcements-v1', 'account-health-notifications-v1'].includes(definition.consumer) ? true : undefined);
        assert.equal(filter['metadata.durableDefenseHandled'], definition.consumer === 'follow-defense-v1' ? true : undefined);
    }
});
