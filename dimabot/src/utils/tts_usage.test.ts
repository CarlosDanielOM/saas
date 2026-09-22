import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const ingest = mock.fn(async (_options: unknown) => ({ error: false }));
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

test('Fish speech retains its credit rate and queues durable billing before returning', async () => {
  const usage = await trackTtsUsage({
    channelID: 'test', streamer: { polar_sh_customer_id: 'customer' },
    provider: 'fish', characters: 100, text: 'Hello',
    usage: {
      entryId: 'entry-1', requestId: 'request-1', source: 'chat-command',
      resourceType: 'speech', resourceId: 'speech-1',
    },
  });
  assert.equal(usage.creditsConsumed, 150);
  assert.equal(ingest.mock.callCount(), 1);
  assert.deepEqual(ingest.mock.calls[0].arguments[0], {
    customerId: 'customer',
    channelID: 'test',
    cost: 0.0015,
    _cost: 0.15,
    characters: 100,
    reason: 'tts_fish',
    mode: 'batch',
    externalId: 'entry-1',
    usage: {
      requestId: 'request-1',
      source: 'chat-command',
      provider: 'fish',
      quantity: 100,
      unit: 'characters',
      resourceType: 'speech',
      resourceId: 'speech-1',
    },
  });
});
