import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// One voice request from a channel-point reward, through the real billing path (tts_usage -> polarsh ->
// ledger): Polar and PostHog get exactly what they got before receipts had their own source.
const polarEvents: Array<Record<string, any>> = [];
const posthogCaptures: Array<Record<string, any>> = [];
class MockPolar { events = { ingest: async ({ events }: { events: Array<Record<string, any>> }) => {
  polarEvents.push(...structuredClone(events)); return { inserted: events.length, duplicates: 0 }; } }; }
class MockPostHog { capture(event: Record<string, any>) { posthogCaptures.push(structuredClone(event)); } identify() {} }
const lists = new Map<string, string[]>();
const cache = {
  hIncrBy: async () => 1, expire: async () => true, set: async () => 'OK', get: async () => null, del: async () => 1,
  type: async () => 'list',
  rPush: async (key: string, value: string | string[]) => { lists.set(key, [...(lists.get(key) ?? []), ...[value].flat()]); return 1; },
  lRange: async (key: string) => [...(lists.get(key) ?? [])],
  lTrim: async (key: string, start: number) => { lists.set(key, (lists.get(key) ?? []).slice(start)); return 'OK'; },
};
mock.module('@polar-sh/sdk', { namedExports: { Polar: MockPolar } });
mock.module('posthog-node', { namedExports: { PostHog: MockPostHog } });
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('./billing.js', { namedExports: { recordAiCreditUsage: async () => {} } });
mock.module('./logger.js', { namedExports: { error: async () => {}, info: () => {}, debug: () => {}, warn: () => {} } });
process.env.POLARSH_OAT = 'test';
const { trackTtsUsage } = await import('./tts_usage.js');
const { AI_USAGE_RECEIPT_QUEUE_KEY, parseQueuedAiUsageReceipt } = await import('./ai_usage_ledger.js');

const speak = async (receipt?: Record<string, unknown>) => {
  polarEvents.length = 0; posthogCaptures.length = 0; lists.clear();
  // What the voice queue passes for a reward's request (`queueItem.source` is 'ast').
  await trackTtsUsage({ channelID: '42', streamer: { polar_sh_customer_id: 'customer' }, provider: 'fish', characters: 10, text: 'Hello chat',
    usage: { entryId: 'entry-1', requestId: 'request-1', source: 'ast', resourceType: 'speech', resourceId: 'speech-1', ...(receipt ? { receipt } : {}) } });
  const queued = lists.get(AI_USAGE_RECEIPT_QUEUE_KEY) ?? [];
  assert.equal(queued.length, 1);
  return { polar: polarEvents.slice(), posthog: posthogCaptures.filter(event => event.event === 'ai_usage_recorded'), receipt: parseQueuedAiUsageReceipt(queued[0])! };
};

test('a reward voice request keeps the Polar and PostHog events as they were and labels only its receipt', async () => {
  const before = await speak();
  const reward = await speak({ source: 'redemption', actor: { id: '7', login: 'viewer', name: 'Viewer' }, voice: 'fish-voice' });

  assert.equal(JSON.stringify(reward.polar), JSON.stringify(before.polar));
  assert.equal(JSON.stringify(reward.posthog), JSON.stringify(before.posthog));
  assert.equal(reward.polar.length, 1);
  assert.equal(reward.posthog.length, 1);
  // HEAD's shape: the accounting fields plus the usage metadata, nothing about the chatter or the reward.
  assert.deepEqual(Object.keys(reward.polar[0].metadata).sort(), ['_cost', 'category', 'channel_id', 'characters', 'cost', 'credits', 'currency',
    'entry_id', 'entry_kind', 'operation', 'pricing_version', 'provider', 'quantity', 'reason', 'request_id', 'resource_id', 'resource_type',
    'schema_version', 'unit', 'usage_source']);
  assert.equal(reward.polar[0].metadata.usage_source, 'ast');
  assert.equal(reward.polar[0].metadata.credits, 15);
  assert.equal(reward.posthog[0].properties.source, 'ast');
  assert.ok(!JSON.stringify([reward.polar, reward.posthog]).match(/redemption|viewer|fish-voice/i));

  assert.equal(before.receipt.source, 'ast');
  assert.equal(reward.receipt.source, 'redemption');
  assert.equal(reward.receipt.actorLogin, 'viewer');
  assert.equal(reward.receipt.voice, 'fish-voice');
  assert.equal(reward.receipt.credits, before.receipt.credits);
  assert.equal(reward.receipt.costUsd, null);
});
