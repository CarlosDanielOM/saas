import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const ingestedEvents: Array<Record<string, any>> = [];
class MockPolar {
  events = {
    ingest: async ({ events }: { events: Array<Record<string, any>> }) => {
      ingestedEvents.push(...events);
      return { inserted: events.length, duplicates: 0 };
    },
  };
}

mock.module('@polar-sh/sdk', { namedExports: { Polar: MockPolar } });
mock.module('./databases/dragonfly.database.js', {
  namedExports: { getDragonflyClient: async () => ({}) },
});
mock.module('./billing.js', {
  namedExports: { recordAiCreditUsage: async () => {} },
});
mock.module('./logger.js', {
  namedExports: { error: async () => {}, info: () => {} },
});
mock.module('./posthog_events.js', {
  namedExports: { trackAiUsageRecorded: () => {} },
});

process.env.POLARSH_OAT = 'test';
const { grantPolarAiCredits, ingestPolarSHEvent } = await import('./polarsh.js');

test('receipt metadata leaves generic, LLM, and TTS Polar accounting values unchanged', async () => {
  ingestedEvents.length = 0;

  await ingestPolarSHEvent({
    customerId: 'customer', channelID: 'channel', externalId: 'generic',
    cost: 0.123, reason: 'custom_usage', mode: 'immediate',
  });
  await ingestPolarSHEvent({
    customerId: 'customer', channelID: 'channel', externalId: 'llm',
    cost: 0.001234, reason: 'messages', mode: 'immediate',
    llm: {
      model: 'openai/test:model',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
  await ingestPolarSHEvent({
    customerId: 'customer', channelID: 'channel', externalId: 'tts',
    cost: 0.0015, _cost: 0.15, characters: 100,
    reason: 'tts_fish', mode: 'immediate',
  });

  assert.equal(ingestedEvents.length, 3);
  assert.deepEqual(
    pickAccounting(ingestedEvents[0].metadata),
    { cost: 0.123, currency: 'usd', credits: 123, reason: 'custom_usage' },
  );
  assert.deepEqual(
    pickAccounting(ingestedEvents[1].metadata),
    {
      _cost: { amount: 0.1234, currency: 'usd' },
      _llm: {
        vendor: 'openai', model: 'test', inputTokens: 10,
        outputTokens: 5, totalTokens: 15,
      },
      cost: 0.1234, credits: 124, currency: 'usd', reason: 'messages',
    },
  );
  assert.deepEqual(
    pickAccounting(ingestedEvents[2].metadata),
    {
      _cost: { amount: 0.15, currency: 'usd' },
      cost: 0.0015, credits: 150, currency: 'usd',
      reason: 'tts_fish', characters: 100,
    },
  );
});

test('credit grants accept a stable external ID without changing credit math', async () => {
  ingestedEvents.length = 0;

  const result = await grantPolarAiCredits({
    customerId: 'customer',
    credits: 5_000,
    reason: 'free_monthly_credit_reset',
    externalId: 'free-credit-reset-user-2026-09-07',
    source: 'free_credit_reset_worker',
  });

  assert.equal(result.error, false);
  assert.equal(ingestedEvents.length, 1);
  assert.equal(ingestedEvents[0].externalId, 'free-credit-reset-user-2026-09-07');
  assert.equal(ingestedEvents[0].metadata.credits, -5_000);
  assert.equal(ingestedEvents[0].metadata.cost, 0);
  assert.equal(ingestedEvents[0].metadata.entry_kind, 'adjustment');
  assert.equal(ingestedEvents[0].metadata.category, 'credit_adjustment');
  assert.equal(ingestedEvents[0].metadata.usage_source, 'free_credit_reset_worker');
});

function pickAccounting(metadata: Record<string, unknown>): Record<string, unknown> {
  const keys = ['_cost', '_llm', 'cost', 'credits', 'currency', 'reason', 'characters'];
  return Object.fromEntries(keys.filter((key) => key in metadata).map((key) => [key, metadata[key]]));
}
