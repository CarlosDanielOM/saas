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

test('Piper speech rounds up at 50 characters per credit and submits durable billing', async () => {
  const { calculateTtsUsage } = await import('./tts_usage.js');
  for (const [characters, expected] of [[0, 0], [1, 1], [50, 1], [51, 2], [100, 2], [101, 3]]) {
    assert.equal(calculateTtsUsage('piper', characters).creditsConsumed, expected);
  }
  const usage = await trackTtsUsage({
    channelID: 'test', streamer: { polar_sh_customer_id: 'customer' },
    provider: 'piper', characters: 100, text: 'Hello',
  });
  assert.equal(usage.creditsConsumed, 2);
  assert.equal(usage.costUsd, 0.00002);
  assert.equal(ingest.mock.callCount(), 1);
  const event = ingest.mock.calls[0].arguments[0] as { reason: string; _cost: number; cost: number; mode: string };
  assert.equal(event.reason, 'tts_piper');
  assert.equal(event._cost, 0.002);
  assert.equal(event.cost, 0.00002);
  assert.equal(event.mode, 'batch');
});

test('Fish speech retains its credit rate and queues durable billing before returning', async () => {
  ingest.mock.resetCalls();
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

test('Kokoro charges one credit per 15 characters, always rounding up', async () => {
  const { calculateTtsUsage } = await import('./tts_usage.js');
  for (const [characters, expected] of [[0, 0], [1, 1], [15, 1], [16, 2], [30, 2], [31, 3], [45, 3], [46, 4], [500, 34]]) {
    assert.equal(calculateTtsUsage('kokoro', characters).creditsConsumed, expected);
  }
  const usage = await trackTtsUsage({ channelID: 'test', streamer: { polar_sh_customer_id: 'customer' },
    provider: 'kokoro', characters: 16, text: '0123456789abcdef', usage: { entryId: 'kokoro-entry' } });
  assert.equal(usage.creditsConsumed, 2);
  const event = ingest.mock.calls.at(-1)!.arguments[0] as { reason: string; cost: number; externalId: string };
  assert.equal(event.reason, 'tts_kokoro');
  assert.equal(event.cost, 0.00002);
  assert.equal(event.externalId, 'kokoro-entry');
});
