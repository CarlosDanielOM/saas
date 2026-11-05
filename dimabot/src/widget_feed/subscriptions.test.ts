import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_MODERATION_EVENT_TYPES, createChatModerationEnsurer } from './subscriptions.js';

function remote(type: string, status = 'enabled', id = type) {
  return { id, type, status, version: '1', condition: { broadcaster_user_id: 'channel', user_id: 'bot' },
    transport: { method: 'webhook', callback: 'https://subscriptions.domdimabot.com/eventsub' }, created_at: new Date().toISOString(), cost: 0 };
}
function setup() {
  let remotes: ReturnType<typeof remote>[] = [];
  let responseError = 0, inspectError = false, removalError = false, complete = true;
  let inspections = 0;
  const adopted: string[] = [], removed: string[] = [], created: string[] = [];
  const ensure = createChatModerationEnsurer({
    botAccountId: 'bot', account: async () => ({ name: 'Channel' }),
    inspect: async () => { inspections++; return { data: [...remotes], error: inspectError, complete }; },
    adopt: async (event, channel, name) => { assert.equal(channel, 'channel'); assert.equal(name, 'Channel'); adopted.push(event.id); },
    remove: async id => { removed.push(id); remotes = remotes.filter(item => item.id !== id); return { error: removalError }; },
    subscribe: async (channel, type, version, condition, config, options) => {
      assert.equal(channel, 'channel'); assert.equal(version, '1');
      assert.deepEqual(condition, { broadcaster_user_id: 'channel', user_id: 'bot' });
      assert.equal(config, undefined); assert.deepEqual(options, { ignoreExisting: true });
      created.push(type);
      if (responseError) {
        if (responseError === 409) remotes.push(remote(type, 'enabled', `conflict-${type}`));
        return { error: 'fixture', message: 'fixture', status: responseError };
      }
      const item = remote(type, 'webhook_callback_verification_pending'); remotes.push(item); return item;
    }
  });
  return { ensure, adopted, removed, created, inspections: () => inspections,
    remote: (items: ReturnType<typeof remote>[]) => { remotes = items; },
    error: (status: number) => { responseError = status; },
    inspectError: () => { inspectError = true; }, incomplete: () => { complete = false; },
    removalError: () => { removalError = true; } };
}

test('on-demand creation uses the bot reader identity and accepts pending verification; next call adopts', async () => {
  const fixture = setup();
  const result = await fixture.ensure('channel');
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, CHAT_MODERATION_EVENT_TYPES.map(type => ({ type, status: 'webhook_callback_verification_pending' })));
  assert.deepEqual(fixture.created, CHAT_MODERATION_EVENT_TYPES);
  await fixture.ensure('channel');
  assert.equal(fixture.created.length, 3);
  assert.equal(fixture.adopted.length, 6);
});

test('adopts enabled remote subscriptions and repairs only stale subscriptions owned by this bot/callback', async () => {
  const fixture = setup();
  const [deleted, userClear, clear] = CHAT_MODERATION_EVENT_TYPES;
  const foreign = remote(clear, 'authorization_revoked', 'foreign'); foreign.condition.user_id = 'other-bot';
  const elsewhere = remote(clear, 'authorization_revoked', 'elsewhere'); elsewhere.transport.callback = 'https://other.example/eventsub';
  fixture.remote([remote(deleted), remote(userClear, 'webhook_callback_verification_pending'), remote(clear, 'authorization_revoked', 'stale'), foreign, elsewhere]);
  assert.equal((await fixture.ensure('channel')).ok, true);
  assert.deepEqual(fixture.removed, ['stale']);
  assert.deepEqual(fixture.created, [clear]);
  assert.deepEqual(fixture.adopted, [deleted, userClear, clear]);
});

test('handles a cross-process 409 by inspecting and adopting the winner', async () => {
  const fixture = setup(); fixture.error(409);
  assert.equal((await fixture.ensure('channel')).ok, true);
  assert.equal(fixture.inspections(), 4);
  assert.deepEqual(fixture.adopted, CHAT_MODERATION_EVENT_TYPES.map(type => `conflict-${type}`));
});

test('de-duplicates concurrent activation per channel and releases the lock afterwards', async () => {
  const fixture = setup();
  const first = fixture.ensure('channel'), second = fixture.ensure('channel');
  assert.equal(first, second);
  await first;
  assert.equal(fixture.created.length, 3);
  await fixture.ensure('channel');
  assert.equal(fixture.inspections(), 2);
});

test('returns actionable authorization failure; incomplete inspection and stale removal failures never create', async () => {
  const forbidden = setup(); forbidden.error(403);
  const denied = await forbidden.ensure('channel');
  assert.equal(denied.ok, false);
  assert.match(denied.message!, /user:read:chat.*user:bot.*channel:bot/);
  for (const mode of ['inspect', 'incomplete', 'remove']) {
    const fixture = setup();
    if (mode === 'inspect') fixture.inspectError();
    if (mode === 'incomplete') fixture.incomplete();
    if (mode === 'remove') { fixture.remote([remote(CHAT_MODERATION_EVENT_TYPES[0], 'authorization_revoked')]); fixture.removalError(); }
    const result = await fixture.ensure('channel');
    assert.equal(result.ok, false);
    assert.equal(fixture.created.length, 0);
    assert.ok(result.message);
  }
});
