import assert from 'node:assert/strict';

import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { trackTtsUsage } from '/app/dist/utils/tts_usage.js';

const channelID = 'tts-durable-channel';
const customerId = '11111111-1111-4111-8111-111111111111';
const entryId = 'tts-durable-entry';
const redis = await getDragonflyClient('tts-durable-accounting-check');

await redis.set(`twitch:${channelID}:ai:credits`, JSON.stringify({
  version: 3,
  used: 0,
  limit: 1_000,
  balance: 1_000,
  meterId: '5103e79b-fd74-4ba8-a287-f95574f9addf',
  updatedAt: '2026-09-22T00:00:00.000Z',
  available: true,
  status: 'available',
}), { EX: 300 });

const usage = await trackTtsUsage({
  channelID,
  streamer: { polar_sh_customer_id: customerId, plan_tier: 'pro' },
  provider: 'fish',
  characters: 10,
  text: '0123456789',
  usage: {
    entryId,
    requestId: 'tts-durable-request',
    source: 'behavior-check',
    resourceType: 'speech',
    resourceId: 'tts-durable-speech',
  },
});

assert.equal(usage.creditsConsumed, 15);

const credits = JSON.parse(await redis.get(`twitch:${channelID}:ai:credits`));
assert.equal(credits.used, 15);
assert.equal(credits.balance, 985);

const pending = await redis.lRange(`twitch:${channelID}:ai:polarshevent`, 0, -1);
assert.equal(pending.length, 1);
const event = JSON.parse(pending[0]);
assert.equal(event.externalId, entryId);
assert.equal(event.metadata.reason, 'tts_fish');
assert.equal(event.metadata.credits, 15);
assert.equal(event.metadata.provider, 'fish');

assert.equal(await redis.hGet(`${channelID}:tts:usage`, 'fish_characters'), '10');
assert.equal(await redis.hGet(`${channelID}:tts:usage`, 'fish_credits'), '15');

await redis.quit();
console.log('Fish TTS debits locally and retains its idempotent Polar event after a simulated 403');
