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
const receiptInputs: Array<Record<string, any>> = [];
mock.module('./ai_usage_ledger.js', {
  namedExports: {
    buildQueuedAiUsageReceipt: (input: Record<string, any>) => { receiptInputs.push(input); return null; },
    enqueueAiUsageReceipt: async () => {},
  },
});

process.env.POLARSH_OAT = 'test';
const { grantPolarAiCredits, ingestPolarSHEvent, receiptCostUsd, providerReportedCostUsd } = await import('./polarsh.js');

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
  // A Drama 3 line: OpenRouter charged $0.00041 (41 bytes); the streamer pays the fixed 48 credits.
  await ingestPolarSHEvent({
    customerId: 'customer', channelID: 'channel', externalId: 'tts',
    cost: 0.00041, credits: 48, characters: 32,
    reason: 'tts_fish', mode: 'immediate',
  });

  assert.equal(ingestedEvents.length, 3);
  assert.deepEqual(
    pickAccounting(ingestedEvents[0].metadata),
    // A generic price arrives in cents (0.123 = $0.00123); `cost` is shown in USD.
    { cost: 0.00123, currency: 'usd', credits: 123, reason: 'custom_usage' },
  );
  assert.deepEqual(
    pickAccounting(ingestedEvents[1].metadata),
    {
      _cost: { amount: 0.1234, currency: 'usd' },
      _llm: {
        vendor: 'openai', model: 'test', inputTokens: 10,
        outputTokens: 5, totalTokens: 15,
      },
      // `_cost` in cents, `cost` in USD as OpenRouter reported it, credits = cents × 1000.
      cost: 0.001234, credits: 124, currency: 'usd', reason: 'messages',
    },
  );
  assert.deepEqual(
    pickAccounting(ingestedEvents[2].metadata),
    {
      _cost: { amount: 0.041, currency: 'usd' },
      cost: 0.00041, credits: 48, currency: 'usd',
      reason: 'tts_fish', characters: 32,
    },
  );
});

test('cost keeps every digit the provider reported; generic prices and grants convert from cents', async () => {
  ingestedEvents.length = 0;
  const llm = { model: 'openai/test', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } };
  await ingestPolarSHEvent({ customerId: 'customer', externalId: 'precise', cost: 0.000000123456, reason: 'messages', mode: 'immediate', llm });
  await ingestPolarSHEvent({ customerId: 'customer', externalId: 'tiny', cost: 4e-11, reason: 'messages', mode: 'immediate', llm });
  await ingestPolarSHEvent({ customerId: 'customer', externalId: 'tts-precise', cost: 0.0004123456789, credits: 48, characters: 32, reason: 'tts_fish', mode: 'immediate' });
  await ingestPolarSHEvent({ customerId: 'customer', externalId: 'grant', cost: -25, reason: 'Free benefits', mode: 'immediate' });
  const [precise, tiny, tts, grant] = ingestedEvents.map(event => event.metadata);
  assert.equal(precise.cost, 0.000000123456);
  assert.equal(precise._cost.amount, 0.0000123456);
  assert.equal(precise.credits, 1);
  assert.equal(tiny.cost, 4e-11);
  assert.equal(tiny._cost.amount, 4e-9);
  assert.equal(tts.cost, 0.0004123456789);
  assert.equal(tts._cost.amount, 0.04123457);
  assert.equal(tts.credits, 48);
  assert.equal(grant.cost, -0.25);
  assert.equal(grant.credits, -25_000);
  assert.equal(grant._cost, undefined);
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

test('receipt cost is USD: LLM events carry it in `cost`, other events need the caller to pass it', () => {
  // LLM branch: `cost` is USD as OpenRouter reported it.
  assert.equal(receiptCostUsd({ cost: 0.001234, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), 0.001234);
  assert.equal(receiptCostUsd({ cost: 1e-10, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 0, totalTokens: 1 } }), 1e-10);
  assert.equal(receiptCostUsd({ cost: 0, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 0, totalTokens: 1 } }), null);
  // Voice events carry the provider cost too, but the caller passes it explicitly.
  assert.equal(receiptCostUsd({ cost: 0.00041 }), null);
  // Generic branch: our price, not a provider cost (clip recommendations).
  assert.equal(receiptCostUsd({ cost: 0.125 }), null);
  // A caller that knows the real cost wins; null means it is unknown.
  assert.equal(receiptCostUsd({ cost: 0.5, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, 0.0003), 0.0003);
  assert.equal(receiptCostUsd({ cost: 0.5, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, null), null);
  assert.equal(receiptCostUsd({ cost: 0.5 }, Number.NaN), null);
});

test('receipt details reach the receipt and leave the Polar event byte for byte unchanged', async () => {
  const llm = { model: 'openai/test:model', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  const base = { customerId: 'customer', channelID: 'channel', mode: 'immediate' as const };
  const receipt = { actor: { id: '42', login: 'viewer', name: 'Viewer' }, voice: 'voice-1', model: 'voice-model' };
  for (const [plain, detailed] of [
    [{ ...base, externalId: 'llm-a', cost: 0.001234, reason: 'messages', llm },
      { ...base, externalId: 'llm-a', cost: 0.001234, reason: 'messages', llm, usage: { receipt } }],
    [{ ...base, externalId: 'tts-a', cost: 0.00041, credits: 48, characters: 32, reason: 'tts_fish' },
      { ...base, externalId: 'tts-a', cost: 0.00041, credits: 48, characters: 32, reason: 'tts_fish', usage: { receipt } }],
  ]) {
    ingestedEvents.length = 0;
    receiptInputs.length = 0;
    await ingestPolarSHEvent(plain);
    await ingestPolarSHEvent(detailed);
    assert.equal(JSON.stringify(ingestedEvents[1]), JSON.stringify(ingestedEvents[0]));
    assert.deepEqual(receiptInputs[1].context.receipt, receipt);
    assert.equal(receiptInputs[1].credits, receiptInputs[0].credits);
  }
  // The LLM call's cost reaches the receipt in USD; a voice line's only when passed (sendTtsUsageEvent does).
  ingestedEvents.length = 0;
  receiptInputs.length = 0;
  await ingestPolarSHEvent({ ...base, externalId: 'llm-b', cost: 0.001234, reason: 'messages', llm });
  await ingestPolarSHEvent({ ...base, externalId: 'tts-b', cost: 0.00041, credits: 48, characters: 32, reason: 'tts_fish' });
  await ingestPolarSHEvent({ ...base, externalId: 'mod-b', cost: 0.002, reason: 'contextual_moderation', llm,
    usage: { receipt: { costUsd: 0.0007 } } });
  assert.deepEqual(receiptInputs.map(input => input.costUsd), [0.001234, null, 0.0007]);
  // A charged review still bills its price to Polar ($0.002 = 0.2 cents = 200 credits).
  assert.equal(ingestedEvents[2].metadata.cost, 0.002);
  assert.equal(ingestedEvents[2].metadata._cost.amount, 0.2);
  assert.equal(ingestedEvents[2].metadata.credits, 200);
});

test('the receipt cost is what the provider reported, and unknown when it reported nothing', () => {
  // The prompt and completion split, even when only one side is present.
  assert.equal(providerReportedCostUsd({ cost: 9, cost_details: { upstream_inference_prompt_cost: 0.001, upstream_inference_completions_cost: 0.002, upstream_inference_cost: 9 } }), 0.003);
  assert.equal(providerReportedCostUsd({ cost_details: { upstream_inference_completions_cost: 0.0005 } }), 0.0005);
  // Only the single upstream figure.
  assert.equal(providerReportedCostUsd({ cost: 9, cost_details: { upstream_inference_cost: 0.003 } }), 0.003);
  // Only `usage.cost`.
  assert.equal(providerReportedCostUsd({ cost: 0.0042, prompt_tokens: 1 }), 0.0042);
  // Nothing reported: unknown, never $0.
  assert.equal(providerReportedCostUsd({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), null);
  assert.equal(providerReportedCostUsd({ cost_details: {} }), null);
  assert.equal(providerReportedCostUsd({ cost: 'NaN', cost_details: { upstream_inference_cost: -1 } }), null);
  assert.equal(providerReportedCostUsd(undefined), null);
  // A provider that really said zero.
  assert.equal(providerReportedCostUsd({ cost: 0 }), 0);
  assert.equal(providerReportedCostUsd({ cost_details: { upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 } }), 0);
  // Without an explicit figure, a zero LLM accounting cost is how a missing one looks.
  assert.equal(receiptCostUsd({ cost: 0, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), null);
  assert.equal(receiptCostUsd({ cost: 0, _llm: { vendor: 'v', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, 0), 0);
});

test('a reported cost the split misses reaches the receipt while credits and the Polar event stay as they were', async () => {
  // OpenRouter reported only the single upstream figure: callers bill 0 from the split fields, as before.
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_details: { upstream_inference_cost: 0.003 } };
  const call = { customerId: 'customer', channelID: 'channel', externalId: 'single', cost: 0, reason: 'messages', mode: 'immediate' as const,
    llm: { model: 'openai/test', usage } };
  ingestedEvents.length = 0;
  receiptInputs.length = 0;
  await ingestPolarSHEvent(call);
  await ingestPolarSHEvent({ ...call, usage: { receipt: { costUsd: providerReportedCostUsd(usage) } } });
  assert.equal(JSON.stringify(ingestedEvents[1]), JSON.stringify(ingestedEvents[0]));
  assert.equal(ingestedEvents[1].metadata.credits, 0);
  assert.deepEqual(receiptInputs.map(input => input.costUsd), [null, 0.003]);
});

function pickAccounting(metadata: Record<string, unknown>): Record<string, unknown> {
  const keys = ['_cost', '_llm', 'cost', 'credits', 'currency', 'reason', 'characters'];
  return Object.fromEntries(keys.filter((key) => key in metadata).map((key) => [key, metadata[key]]));
}
