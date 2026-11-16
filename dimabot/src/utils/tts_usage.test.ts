import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const ingest = mock.fn(async (_options: unknown) => ({ error: false } as { error: boolean; queued?: boolean }));
const debit = mock.fn(async (_channelID: string, _credits: number, _entryId?: string) => true);
const create = mock.fn(async (_row: Record<string, unknown>) => ({}));
const cache = {
  hIncrBy: async () => 1,
  expire: async () => true,
};
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('./polarsh.js', { namedExports: { ingestPolarSHEvent: ingest } });
mock.module('./billing.js', { namedExports: { recordAiCreditUsage: debit } });
mock.module('../schemas/tts_usage_pending.schema.js', { defaultExport: { create } });
mock.module('./logger.js', { namedExports: { error: async () => {} } });
const { trackTtsUsage, calculateTtsUsage } = await import('./tts_usage.js');

const reset = () => { ingest.mock.resetCalls(); debit.mock.resetCalls(); create.mock.resetCalls(); };
type Sent = { cost: number; credits: number; reason: string; mode: string; externalId: string; characters: number;
  usage: { receipt?: Record<string, unknown>; provider?: string; quantity?: number } };
const sent = (index = 0) => ingest.mock.calls[index].arguments[0] as Sent;
const streamer = { polar_sh_customer_id: 'customer' };

test('Piper speech rounds up at 50 characters per credit and reports zero provider cost', async () => {
  reset();
  for (const [characters, expected] of [[0, 0], [1, 1], [50, 1], [51, 2], [100, 2], [101, 3]]) {
    assert.equal(calculateTtsUsage('piper', characters).creditsConsumed, expected);
  }
  const usage = await trackTtsUsage({ channelID: 'test', streamer, provider: 'piper', characters: 100, text: 'Hello' });
  assert.equal(usage.creditsConsumed, 2);
  assert.equal(ingest.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 0);
  const event = sent();
  assert.equal(event.reason, 'tts_piper');
  // Piper runs on our host: nothing was paid, only the fixed credits are charged.
  assert.equal(event.cost, 0);
  assert.equal(event.credits, 2);
  assert.equal(event.mode, 'batch');
  assert.equal(event.usage.receipt?.costUsd, 0);
});

test('Fish speech keeps its credit rate and, without an OpenRouter generation, sends the list price at once', async () => {
  reset();
  const usage = await trackTtsUsage({
    channelID: 'test', streamer, provider: 'fish', characters: 100, text: 'Hello',
    providerCost: { backend: 's2.1-pro', bytes: 5 },
    usage: { entryId: 'entry-1', requestId: 'request-1', source: 'chat-command', resourceType: 'speech', resourceId: 'speech-1' },
  });
  assert.equal(usage.creditsConsumed, 150);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(ingest.mock.callCount(), 1);
  assert.deepEqual(ingest.mock.calls[0].arguments[0], {
    customerId: 'customer',
    channelID: 'test',
    // Fish's own API: 5 bytes at $15 per million.
    cost: 0.000075,
    credits: 150,
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
      receipt: { model: 's2.1-pro', costUsd: 0.000075 },
    },
  });
});

test('an OpenRouter line waits for its real charge: parked in MongoDB, credits taken locally, nothing sent yet', async () => {
  reset();
  const usage = await trackTtsUsage({
    channelID: 'test', streamer, provider: 'fish', characters: 32, text: '¡Olé ñandú! 😀 ¿Qué tal, mañana?', requireDurableUsage: true,
    providerCost: { backend: 'fish-audio/drama-3', bytes: 41, generationId: 'gen-tts-1' },
    usage: { entryId: 'entry-2', requestId: 'request-2', source: 'pet', receipt: { voice: 'fish-voice' } },
  });
  assert.equal(usage.creditsConsumed, 48);
  assert.equal(ingest.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 1);
  const row = create.mock.calls[0].arguments[0];
  assert.equal(row.entryId, 'entry-2');
  assert.equal(row.generationId, 'gen-tts-1');
  assert.equal(row.backend, 'fish-audio/drama-3');
  assert.equal(row.bytes, 41);
  assert.equal(row.credits, 48);
  assert.equal(row.customerId, 'customer');
  assert.deepEqual((row.usage as { receipt: unknown }).receipt, { voice: 'fish-voice', model: 'fish-audio/drama-3' });
  assert.ok((row.nextAttemptAt as Date).getTime() > (row.occurredAt as Date).getTime());
  assert.deepEqual(debit.mock.calls[0].arguments, ['test', 48, 'entry-2']);
});

test('a retried request that is already parked is not parked or charged twice', async () => {
  reset();
  create.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); });
  await trackTtsUsage({ channelID: 'test', streamer, provider: 'fish', characters: 10, text: 'Hello chat',
    providerCost: { backend: 'fish-audio/drama-3', bytes: 10, generationId: 'gen-tts-2' }, usage: { entryId: 'entry-3' } });
  assert.equal(ingest.mock.callCount(), 0);
  // The local debit is idempotent per entry, so repeating it is harmless.
  assert.deepEqual(debit.mock.calls[0].arguments, ['test', 15, 'entry-3']);
});

test('when MongoDB cannot park the line it is sent at once with the list price, so no credits are lost', async () => {
  reset();
  create.mock.mockImplementationOnce(async () => { throw new Error('mongo down'); });
  await trackTtsUsage({ channelID: 'test', streamer, provider: 'fish', characters: 10, text: 'Hello chat', requireDurableUsage: true,
    providerCost: { backend: 'fish-audio/drama-3', bytes: 10, generationId: 'gen-tts-3' }, usage: { entryId: 'entry-4' } });
  assert.equal(debit.mock.callCount(), 0);
  assert.equal(ingest.mock.callCount(), 1);
  assert.equal(sent().cost, 0.0001);
  assert.equal(sent().credits, 15);
  assert.equal(sent().externalId, 'entry-4');
});

test('durable callers fail when the usage could not be recorded at all', async () => {
  reset();
  ingest.mock.mockImplementationOnce(async () => ({ error: true }));
  await assert.rejects(trackTtsUsage({ channelID: 'test', streamer, provider: 'kokoro', characters: 16, text: '0123456789abcdef',
    requireDurableUsage: true, providerCost: { backend: 'hexgrad/kokoro-82m', bytes: 16 } }), /TTS usage recording unavailable/);
});

test('Kokoro charges one credit per 15 characters, always rounding up', async () => {
  reset();
  for (const [characters, expected] of [[0, 0], [1, 1], [15, 1], [16, 2], [30, 2], [31, 3], [45, 3], [46, 4], [500, 34]]) {
    assert.equal(calculateTtsUsage('kokoro', characters).creditsConsumed, expected);
  }
  const usage = await trackTtsUsage({ channelID: 'test', streamer, provider: 'kokoro', characters: 16, text: '0123456789abcdef',
    usage: { entryId: 'kokoro-entry' } });
  assert.equal(usage.creditsConsumed, 2);
  const event = sent();
  assert.equal(event.reason, 'tts_kokoro');
  assert.equal(event.credits, 2);
  assert.equal(event.externalId, 'kokoro-entry');
  // No provider report: 16 bytes at Kokoro's list price.
  assert.equal(event.cost, 0.00000992);
});

test('the requester and voice go to the receipt details without changing the charge', async () => {
  reset();
  const receipt = { actor: { id: '42', login: 'viewer', name: 'Viewer' }, voice: 'fish-id', model: 'queue-model' };
  const usage = await trackTtsUsage({ channelID: 'test', streamer, provider: 'fish', characters: 100, text: 'Hello',
    usage: { entryId: 'entry-r', receipt } });
  assert.equal(usage.creditsConsumed, 150);
  assert.equal(sent().credits, 150);
  // Without a synthesis report the caller's model stays.
  assert.deepEqual(sent().usage.receipt, { ...receipt, costUsd: 0.000075 });
});

test('a channel without a Polar customer is counted locally only', async () => {
  reset();
  await trackTtsUsage({ channelID: 'test', streamer: {}, provider: 'fish', characters: 10, text: 'Hello chat',
    providerCost: { backend: 'fish-audio/drama-3', bytes: 10, generationId: 'gen-tts-4' } });
  assert.equal(ingest.mock.callCount() + create.mock.callCount() + debit.mock.callCount(), 0);
});
