import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { ITwitchEventData, ITwitchSubscriptionData } from '../interfaces/twitch/eventsub.interface.js';

let effects: string[] = [], lookups = 0;
const pending = new Promise<void>(() => {});
mock.module('./publisher.js', { namedExports: { publishWidgetChatEvent: (channel: string, type: string) => {
  effects.push(`feed:${channel}:${type}`); return pending;
} } });
mock.module('../classes/chat_history.js', { defaultExport: {} });
mock.module('../utils/keyword_cache.js', { namedExports: { keywordIndexCache: {} } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: {
  getTwitchAccountById: async (id: string) => { lookups++; return { id, chat_enabled: 'true' }; }
} });
mock.module('../schemas/eventsub.schema.js', { defaultExport: { findOne: async () => ({ enabled: true, message: 'announcement must not run' }) } });
mock.module('../schemas/users.schema.js', { defaultExport: {} });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({}) } });
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async () => assert.fail('No chat replies') } });
mock.module('../utils/logger.js', { namedExports: { info: async () => undefined, error: async () => undefined } });
mock.module('../utils/eventsub.js', { namedExports: {
  CANONICAL_BITS_EVENT_TYPE: 'channel.bits.use', canonicalizeEventsubType: (type: string) => type,
  getEquivalentEventsubTypes: (type: string) => [type], isLegacyBitsEventType: () => false,
  migrateLegacyBitsEventsubs: async () => assert.fail('No migration')
} });
mock.module('../handlers/message.handler.js', { namedExports: { messageHandler: () => { effects.push('message-handler'); } } });
for (const [path, name] of [
  ['../handlers/raid.handler.js', 'raidHandler'], ['../handlers/follow.handler.js', 'followHandler'],
  ['../handlers/cheer.handler.js', 'cheerHandler'], ['../handlers/redemption.handler.js', 'redemptionHandler'],
  ['../handlers/stream_online.handler.js', 'streamOnlineHandler'], ['../handlers/stream_offline.handler.js', 'streamOfflineHandler'],
  ['../handlers/ad_break.handler.js', 'adBreakHandler'], ['../handlers/ban.handler.js', 'banHandler']
]) mock.module(path, { namedExports: { [name]: async () => assert.fail(`Unexpected ${name}`) } });

const { eventsubHandler } = await import('../handlers/eventsub.handler.js');
const event = { broadcaster_user_id: 'channel' } as ITwitchEventData;
const subscription = (type: string) => ({ type }) as ITwitchSubscriptionData;
beforeEach(() => { effects = []; lookups = 0; });

test('new moderation cases publish only, without account lookups or awaiting the publisher', async () => {
  for (const type of ['channel.chat.message_delete', 'channel.chat.clear_user_messages', 'channel.chat.clear']) {
    await eventsubHandler(subscription(type), event);
  }
  assert.equal(lookups, 0);
  assert.deepEqual(effects, ['feed:channel:chat.delete', 'feed:channel:chat.clear', 'feed:channel:chat.clear']);
});

test('ordinary chat still reaches messageHandler without awaiting widget delivery', async () => {
  await eventsubHandler(subscription('channel.chat.message'), event);
  assert.deepEqual(effects, ['feed:channel:chat', 'message-handler']);
  assert.equal(lookups, 1);
});

test('foreign shared-chat messages reach only the visual feed; foreign notices remain ignored', async () => {
  const shared = { broadcaster_user_id: 'receiver', source_broadcaster_user_id: 'origin' } as ITwitchEventData;
  await eventsubHandler(subscription('channel.chat.message'), shared);
  await eventsubHandler(subscription('channel.chat.notification'), shared);
  assert.equal(lookups, 0);
  assert.deepEqual(effects, ['feed:receiver:chat']);
});
