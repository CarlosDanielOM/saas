import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { CHAT_MODERATION_EVENT_TYPES } from './subscriptions.js';

const remotes = ['active', 'inactive'].flatMap(channel => CHAT_MODERATION_EVENT_TYPES.map(type => ({
  id: `${channel}:${type}`, type, version: '1', status: 'authorization_revoked',
  condition: { broadcaster_user_id: channel, user_id: 'bot' },
  transport: { method: 'webhook', callback: 'https://subscriptions.domdimabot.com/eventsub' },
  created_at: new Date().toISOString(), cost: 0
})));
const local = { ...remotes[0], channelID: 'active' };
mock.module('../schemas/users.schema.js', { defaultExport: {
  find: () => ({ select: () => ({ lean: async () => [{ accounts: [{ type: 'twitch', actived: true, has_permissions: true, id: 'active', name: 'Active' }] }] }) })
} });
mock.module('../schemas/eventsub.schema.js', { defaultExport: { find: () => ({ lean: async () => [local] }) } });
mock.module('../utils/eventsub.js', { namedExports: {
  // These types intentionally remain outside the automatic subscription registry.
  SUBSCRIPTION_TYPES: [], CANONICAL_BITS_EVENT_TYPE: 'channel.bits.use', LEGACY_BITS_EVENT_TYPES: ['channel.cheer', 'channel.bit.use'],
  getEventsubs: async () => ({ data: remotes, complete: true }),
  migrateLegacyBitsEventsubs: async () => assert.fail('No bits migration'),
  subscribeTwitchEvent: async () => assert.fail('Do not create on-demand subscriptions'),
  unsubscribeTwitchEvent: async () => assert.fail('Do not remove on-demand subscriptions, even if unhealthy')
} });
mock.module('../utils/raid_subscriptions.js', { namedExports: { shouldRepairRaid: async () => false, isRaidDeleted: async () => false } });

test('reconciliation leaves unregistered chat moderation subscriptions alone for active and inactive channels', async () => {
  const { reconcileEventsubs } = await import('../utils/eventsub_reconciliation.js');
  const result = await reconcileEventsubs();
  assert.equal(result.activeChannels, 1);
  assert.equal(result.remoteSubscriptions, 6);
  assert.equal(result.remoteSubscriptionsRemoved, 0);
  assert.equal(result.subscriptionsCreated, 0);
  assert.equal(result.staleLocalRemoved, 0);
  assert.deepEqual(result.errors, []);
});
