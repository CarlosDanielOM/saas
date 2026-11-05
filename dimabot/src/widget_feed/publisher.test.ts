import assert from 'node:assert/strict';
import test from 'node:test';
import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';
import { normalizeChatMessage } from './chat-normalize.js';
import { createWidgetChatPublisher } from './publisher.js';
import { WIDGET_FEED_CHANNEL, widgetFeedDemandKey, type WidgetFeedMessage } from './types.js';

const event: IChatMessage = {
  broadcaster_user_id: 'channel', chatter_user_id: 'viewer', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
  message_id: 'message', message_type: 'text', message: { text: 'hello', fragments: [{ type: 'text', text: 'hello' }] },
  badges: [], cheer: { bits: 0 }, color: ''
};
function setup() {
  let now = 1000, present = false, reads = 0, badges = 0, normalizations = 0;
  let failure = '';
  const sent: { topic: string; message: WidgetFeedMessage }[] = [];
  const publish = createWidgetChatPublisher({
    now: () => now,
    readDemand: async key => { reads++; assert.equal(key, widgetFeedDemandKey('channel')); if (failure === 'read') throw Error('redis'); return present; },
    badges: async () => { badges++; if (failure === 'badges') throw Error('badges'); return new Map(); },
    normalize: (...args) => { normalizations++; if (failure === 'normalize') throw Error('normalize'); return normalizeChatMessage(...args); },
    publish: async (topic, message) => { if (failure === 'publish') throw Error('publish'); sent.push({ topic, message }); }
  });
  return { publish, sent, stats: () => ({ reads, badges, normalizations }),
    time: (value: number) => { now = value; }, demand: (value: boolean) => { present = value; }, fail: (value: string) => { failure = value; } };
}

test('no demand means no badge lookup, normalization or publish, even for invalid raw input', async () => {
  const fixture = setup();
  await fixture.publish('channel', 'chat', null);
  assert.deepEqual(fixture.stats(), { reads: 1, badges: 0, normalizations: 0 });
  assert.deepEqual(fixture.sent, []);
});

test('caches both negative and positive demand for exactly five seconds', async () => {
  const fixture = setup();
  await fixture.publish('channel', 'chat', event);
  fixture.demand(true);
  fixture.time(5999);
  await fixture.publish('channel', 'chat', event);
  assert.equal(fixture.stats().reads, 1);
  assert.equal(fixture.sent.length, 0);
  fixture.time(6000);
  await fixture.publish('channel', 'chat', event);
  assert.equal(fixture.stats().reads, 2);
  assert.equal(fixture.sent.length, 1);
  fixture.demand(false);
  fixture.time(10999);
  await fixture.publish('channel', 'chat', event);
  assert.equal(fixture.stats().reads, 2);
  assert.equal(fixture.sent.length, 2);
  fixture.time(11000);
  await fixture.publish('channel', 'chat', event);
  assert.equal(fixture.stats().reads, 3);
  assert.equal(fixture.sent.length, 2);
});

test('publishes the exact channel/type/data envelope for all feed types; moderation skips badges', async () => {
  const fixture = setup(); fixture.demand(true);
  await fixture.publish('channel', 'chat', event);
  await fixture.publish('channel', 'chat.delete', { message_id: 'removed', target_user_id: 'viewer' });
  await fixture.publish('channel', 'chat.clear', { target_user_id: 'viewer' });
  await fixture.publish('channel', 'chat.clear', { broadcaster_user_id: 'channel' });
  assert.deepEqual(fixture.sent, [
    { topic: WIDGET_FEED_CHANNEL, message: { channel: 'channel', type: 'chat', data: normalizeChatMessage(event, new Map(), 1000) } },
    { topic: WIDGET_FEED_CHANNEL, message: { channel: 'channel', type: 'chat.delete', data: { messageId: 'removed', userId: 'viewer' } } },
    { topic: WIDGET_FEED_CHANNEL, message: { channel: 'channel', type: 'chat.clear', data: { userId: 'viewer' } } },
    { topic: WIDGET_FEED_CHANNEL, message: { channel: 'channel', type: 'chat.clear', data: { userId: null } } }
  ]);
  assert.deepEqual(fixture.stats(), { reads: 1, badges: 1, normalizations: 1 });
});

test('de-duplicates concurrent demand checks per channel, while keeping channel caches separate', async () => {
  let reads = 0;
  let release!: (present: boolean) => void;
  const pending = new Promise<boolean>(resolve => { release = resolve; });
  const publish = createWidgetChatPublisher({ now: () => 0, readDemand: async () => { reads++; return pending; },
    badges: async () => assert.fail('No badges'), publish: async () => assert.fail('No publish') });
  const requests = Array.from({ length: 10 }, () => publish('channel', 'chat', null));
  requests.push(publish('other', 'chat', null));
  assert.equal(reads, 2);
  release(false);
  await Promise.all(requests);
});

test('swallows demand, badges, normalization and publishing errors; demand outages are cached', async () => {
  for (const failure of ['read', 'badges', 'normalize', 'publish']) {
    const fixture = setup(); fixture.demand(true); fixture.fail(failure);
    await assert.doesNotReject(fixture.publish('channel', 'chat', event));
    assert.equal(fixture.sent.length, 0);
    if (failure === 'read') {
      await fixture.publish('channel', 'chat', event);
      assert.deepEqual(fixture.stats(), { reads: 1, badges: 0, normalizations: 0 });
    }
  }
});

test('starts no normalization synchronously in the callers chat-handler turn', async () => {
  const fixture = setup(); fixture.demand(true);
  const completion = fixture.publish('channel', 'chat', event);
  assert.equal(fixture.stats().normalizations, 0);
  await completion;
  assert.equal(fixture.stats().normalizations, 1);
});

test('a slow badge lookup cannot let a delete overtake the message it removes', async () => {
  let release!: () => void;
  const pendingBadges = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const publish = createWidgetChatPublisher({ now: () => 0, readDemand: async () => true,
    badges: async () => { await pendingBadges; return new Map(); },
    publish: async (_topic, message) => { sent.push(message.type); } });
  const chat = publish('channel', 'chat', event);
  const deletion = publish('channel', 'chat.delete', { message_id: event.message_id });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
  release();
  await Promise.all([chat, deletion]);
  assert.deepEqual(sent, ['chat', 'chat.delete']);
});

test('one channel cannot block another, and a failed delivery cannot poison later events', async () => {
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const publish = createWidgetChatPublisher({ now: () => 0, readDemand: async () => true,
    badges: async channel => { if (channel === 'slow') await slow; throw Error('badge dependency failed'); },
    publish: async (_topic, message) => { sent.push(message.channel); } });
  const failed = publish('slow', 'chat', event);
  await publish('fast', 'chat.clear', {});
  assert.deepEqual(sent, ['fast']);
  const later = publish('slow', 'chat.clear', {});
  release();
  await Promise.all([failed, later]);
  assert.deepEqual(sent, ['fast', 'slow']);
});
