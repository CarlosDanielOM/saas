import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';
import { CHAT_MODERATION_EVENT_TYPES } from './subscriptions.js';

// Exercise the actual signed webhook app with a disposable in-memory dedupe boundary.
mock.module('../utils/databases/dragonfly.database.js', { namedExports: {
  getDragonflyClient: async () => ({ set: async () => 'OK' })
} });

test('signed moderation and unknown notifications reach the handler without durable journaling or chat authority', async context => {
  const secret = 'widget-feed-test-secret';
  const oldSecret = process.env.TWITCH_EVENTSUB_SECRET, oldKey = process.env.SECRET_KEY;
  process.env.TWITCH_EVENTSUB_SECRET = secret;
  process.env.SECRET_KEY = 'widget-feed-test-encryption-key';
  context.after(() => {
    if (oldSecret === undefined) delete process.env.TWITCH_EVENTSUB_SECRET; else process.env.TWITCH_EVENTSUB_SECRET = oldSecret;
    if (oldKey === undefined) delete process.env.SECRET_KEY; else process.env.SECRET_KEY = oldKey;
  });
  const { createTwitchEventsubApp } = await import('../bot/eventsub.twitch.js');
  const { isDurableTwitchEventsubType } = await import('../domain_events/twitch_eventsub_events.js');
  const handled: string[] = [];
  const server = createTwitchEventsubApp({
    journalEvent: async () => assert.fail('Feed notifications must not be journaled'),
    resolveOwner: async () => assert.fail('Feed notifications must not resolve durable ownership'),
    handleEvent: async (subscription, _event, options) => {
      assert.equal(options?.durableChatHandled, false);
      assert.equal(options?.chatEffectContext, undefined);
      handled.push(subscription.type);
    }
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/eventsub`;
  for (const type of [...CHAT_MODERATION_EVENT_TYPES, 'channel.future.unknown']) {
    assert.equal(isDurableTwitchEventsubType(type), false);
    const body = JSON.stringify({ subscription: { id: type, type, version: '1', condition: { broadcaster_user_id: 'channel', user_id: 'bot' } },
      event: { broadcaster_user_id: 'channel', target_user_id: 'viewer', message_id: 'message' } });
    const timestamp = new Date().toISOString();
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(type).update(timestamp).update(body).digest('hex');
    const response = await fetch(endpoint, { method: 'POST', body, headers: {
      'content-type': 'application/json', 'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': type, 'twitch-eventsub-message-timestamp': timestamp, 'twitch-eventsub-message-signature': signature
    } });
    assert.equal(response.status, 204);
  }
  assert.deepEqual(handled, [...CHAT_MODERATION_EVENT_TYPES, 'channel.future.unknown']);
});
