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
