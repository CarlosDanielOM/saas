import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const ingest = mock.fn(async () => ({ error: false }));
const cache = {
  hIncrBy: async () => 1,
  expire: async () => true,
};
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('./polarsh.js', { namedExports: { ingestPolarSHEvent: ingest } });
mock.module('./logger.js', { namedExports: { error: async () => {} } });
const { trackTtsUsage } = await import('./tts_usage.js');

test('Piper speech does not consume credits or submit a paid billing event', async () => {
  const usage = await trackTtsUsage({
    channelID: 'test', streamer: { polar_sh_customer_id: 'customer' },
    provider: 'piper', characters: 100, text: 'Hello',
  });
  assert.equal(usage.creditsConsumed, 0);
  assert.equal(usage.costUsd, 0);
  assert.equal(ingest.mock.callCount(), 0);
});

test('Fish speech retains its credit rate and completes billing before returning', async () => {
  const usage = await trackTtsUsage({
    channelID: 'test', streamer: { polar_sh_customer_id: 'customer' },
    provider: 'fish', characters: 100, text: 'Hello',
  });
  assert.equal(usage.creditsConsumed, 150);
  assert.equal(ingest.mock.callCount(), 1);
});
