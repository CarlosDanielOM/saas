import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBuiltinChatEvents } from './chat_event_catalog.js';

test('received shoutouts are discoverable without a database catalog entry', () => {
    const catalog = withBuiltinChatEvents([]);
    const event = catalog.find(event => event.type === 'channel.shoutout.receive');
    assert.ok(event);
    assert.equal(event.version, '1');
    assert.equal(event.plan_tier, 'free');
    assert.deepEqual(event.condition, { broadcaster_user_id: 'user', moderator_user_id: 'moderator' });
    assert.equal(event.config.find(control => control.id === 'message')?.canDisable, true);
});

test('built-in discovery preserves existing catalog definitions without duplicates', () => {
    const override = { type: 'channel.shoutout.receive', name: 'Custom catalog entry' };
    const events = [override, { type: 'channel.follow' }];
    const catalog = withBuiltinChatEvents(events);
    assert.equal(catalog.filter(event => event.type === override.type).length, 1);
    assert.equal(catalog.find(event => event.type === override.type), override);
    assert.equal(events.length, 2, 'input catalog is not mutated');
    assert.equal(catalog.filter(event => event.type === 'channel.chat.notification').length, 1);
});
