import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AiUsageReceiptLimitError,
  AiUsageReceiptValidationError,
  buildAiUsagePacing,
  buildAiUsageSummary,
  fetchAiUsageTransactions,
  normalizePolarUsageEvent,
  paginateAiUsageTransactions,
  resolveAiUsagePeriod,
  resolveAiUsageWindow,
  type AiUsageTransaction,
} from './ai_usage_receipts.js';

function event(input: {
  id: string;
  timestamp: string;
  credits: number;
  category?: string;
  entryKind?: string;
  operation?: string;
  provider?: string;
  schemaVersion?: number;
}) {
  return {
    id: input.id,
    name: 'ai_usage',
    source: 'user',
    timestamp: new Date(input.timestamp),
    metadata: {
      credits: input.credits,
      ...(input.schemaVersion === undefined ? {} : { schema_version: input.schemaVersion }),
      ...(input.category ? { category: input.category } : {}),
      ...(input.entryKind ? { entry_kind: input.entryKind } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    },
  };
}

test('usage windows use local calendar dates and include zero-spend days', () => {
  const window = resolveAiUsageWindow({
    from: '2026-03-07',
    to: '2026-03-09',
    timeZone: 'America/New_York',
    now: new Date('2026-03-10T12:00:00Z'),
  });

  assert.deepEqual(window.days, ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.equal(window.startTimestamp.toISOString(), '2026-03-07T05:00:00.000Z');
  assert.equal(window.endTimestampExclusive.toISOString(), '2026-03-10T04:00:00.000Z');
});

test('usage windows reject invalid timezones and ranges over 31 days', () => {
  assert.throws(
    () => resolveAiUsageWindow({ timeZone: 'Mars/Olympus' }),
    AiUsageReceiptValidationError,
  );
  assert.throws(
    () => resolveAiUsageWindow({
      from: '2026-01-01', to: '2026-02-01', timeZone: 'UTC', now: new Date('2026-03-01T00:00:00Z'),
    }),
    AiUsageReceiptLimitError,
  );
});

test('plan-specific windows allow 60 Premium days and 90 Pro days', () => {
  const premium = resolveAiUsageWindow({
    from: '2026-07-22', to: '2026-09-19', timeZone: 'UTC',
    now: new Date('2026-09-19T20:00:00Z'), maxDays: 60,
  });
  const pro = resolveAiUsageWindow({
    from: '2026-06-22', to: '2026-09-19', timeZone: 'UTC',
    now: new Date('2026-09-19T20:00:00Z'), maxDays: 90,
  });
  assert.equal(premium.days.length, 60);
  assert.equal(pro.days.length, 90);
  assert.throws(() => resolveAiUsageWindow({
    from: '2026-07-21', to: '2026-09-19', timeZone: 'UTC',
    now: new Date('2026-09-19T20:00:00Z'), maxDays: 60,
  }), AiUsageReceiptLimitError);
});

test('default paid usage period follows the active Polar subscription boundaries', async () => {
  const period = await resolveAiUsagePeriod({
    customerId: 'customer-1',
    timeZone: 'UTC',
    now: new Date('2026-09-15T12:00:00Z'),
    getCustomerState: async () => ({
      activeSubscriptions: [{
        status: 'active',
        currentPeriodStart: new Date('2026-09-07T10:00:00Z'),
        currentPeriodEnd: new Date('2026-10-07T10:00:00Z'),
      }],
    }),
  });

  assert.equal(period.billingPeriod.source, 'subscription');
  assert.equal(period.billingPeriod.startsAt, '2026-09-07T10:00:00.000Z');
  assert.equal(period.billingPeriod.endsAt, '2026-10-07T10:00:00.000Z');
  assert.equal(period.billingPeriod.from, '2026-09-07');
  assert.equal(period.billingPeriod.to, '2026-10-07');
  assert.equal(period.billingPeriod.totalDayCount, 31);
  assert.equal(period.billingPeriod.elapsedDayCount, 9);
  assert.equal(period.window.from, '2026-09-07');
  assert.equal(period.window.to, '2026-09-15');
  assert.equal(period.window.startTimestamp.toISOString(), '2026-09-07T10:00:00.000Z');
  assert.equal(period.window.endTimestampExclusive.toISOString(), '2026-10-07T10:00:00.000Z');
});

test('monthly subscription periods allow partial start and renewal date buckets', async () => {
  const period = await resolveAiUsagePeriod({
    customerId: 'customer-1',
    timeZone: 'UTC',
    now: new Date('2026-09-19T01:00:00Z'),
    getCustomerState: async () => ({
      activeSubscriptions: [{
        status: 'active',
        currentPeriodStart: new Date('2026-08-20T07:06:23.993Z'),
        currentPeriodEnd: new Date('2026-09-20T07:06:23.993Z'),
      }],
    }),
  });

  assert.equal(period.billingPeriod.totalDayCount, 32);
  assert.equal(period.billingPeriod.elapsedDayCount, 31);
  assert.equal(period.billingPeriod.from, '2026-08-20');
  assert.equal(period.billingPeriod.to, '2026-09-20');
});

test('pacing estimates exhaustion from unchanged credit totals', () => {
  const pacing = buildAiUsagePacing({
    credits: {
      used: 250_000,
      limit: 500_000,
      balance: 250_000,
      available: true,
      status: 'available',
    },
    billingPeriod: {
      source: 'subscription',
      startsAt: '2026-09-07T00:00:00.000Z',
      endsAt: '2026-10-07T00:00:00.000Z',
      endExclusive: true,
      from: '2026-09-07',
      to: '2026-10-06',
      totalDayCount: 30,
      elapsedDayCount: 7,
    },
    now: new Date('2026-09-14T00:00:00.000Z'),
  });

  assert.deepEqual(pacing, {
    status: 'over_pace',
    forecastBasis: 'current_billing_period',
    forecastRateBasis: 'current_cycle',
    quotaUsedPercent: 50,
    averageDailyCredits: 35_714.29,
    currentCycleAverageDailyCredits: 35_714.29,
    historicalAverageDailyCredits: null,
    forecastHistoryDays: 0,
    projectedPeriodCredits: 1_071_429,
    projectedQuotaUsedPercent: 214.29,
    projectedOverageCredits: 571_429,
    remainingPeriodDays: 23,
    dailyCreditsToLastPeriod: 10_869.57,
    expectedToExhaustWithinPeriod: true,
    estimatedDaysUntilExhaustion: 7,
    estimatedExhaustionAt: '2026-09-21T00:00:00.000Z',
  });
});

test('pacing uses retained history to smooth the remaining cycle forecast', () => {
  const pacing = buildAiUsagePacing({
    credits: {
      used: 250_000, limit: 500_000, balance: 250_000, available: true, status: 'available',
    },
    billingPeriod: {
      source: 'subscription',
      startsAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-10-07T00:00:00.000Z',
      endExclusive: true, from: '2026-09-07', to: '2026-10-06', totalDayCount: 30, elapsedDayCount: 7,
    },
    history: {
      averageDailyCredits: 5_000, totalSpentCredits: 450_000, dayCount: 90,
      from: '2026-06-17', to: '2026-09-14',
    },
    now: new Date('2026-09-14T00:00:00.000Z'),
  });

  assert.equal(pacing?.forecastRateBasis, 'retention_history');
  assert.equal(pacing?.averageDailyCredits, 5_000);
  assert.equal(pacing?.currentCycleAverageDailyCredits, 35_714.29);
  assert.equal(pacing?.historicalAverageDailyCredits, 5_000);
  assert.equal(pacing?.forecastHistoryDays, 90);
  assert.equal(pacing?.projectedPeriodCredits, 365_000);
  assert.equal(pacing?.projectedOverageCredits, 0);
  assert.equal(pacing?.expectedToExhaustWithinPeriod, false);
});

test('pacing waits for seven historical days before using the retained average', () => {
  const pacing = buildAiUsagePacing({
    credits: { used: 70, limit: 300, balance: 230, available: true, status: 'available' },
    billingPeriod: {
      source: 'free_monthly', startsAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-10-07T00:00:00.000Z',
      endExclusive: true, from: '2026-09-07', to: '2026-10-06', totalDayCount: 30, elapsedDayCount: 7,
    },
    history: { averageDailyCredits: 1, totalSpentCredits: 3, dayCount: 3, from: '2026-09-11', to: '2026-09-14' },
    now: new Date('2026-09-14T00:00:00.000Z'),
  });

  assert.equal(pacing?.forecastRateBasis, 'current_cycle');
  assert.equal(pacing?.averageDailyCredits, 10);
  assert.equal(pacing?.historicalAverageDailyCredits, null);
});

test('retained history forecasts a newly reset cycle with zero current usage', () => {
  const pacing = buildAiUsagePacing({
    credits: { used: 0, limit: 100, balance: 100, available: true, status: 'available' },
    billingPeriod: {
      source: 'subscription', startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-10-14T00:00:00.000Z',
      endExclusive: true, from: '2026-09-14', to: '2026-10-13', totalDayCount: 30, elapsedDayCount: 1,
    },
    history: { averageDailyCredits: 10, totalSpentCredits: 900, dayCount: 90, from: '2026-06-17', to: '2026-09-14' },
    now: new Date('2026-09-14T00:00:00.000Z'),
  });

  assert.equal(pacing?.forecastRateBasis, 'retention_history');
  assert.equal(pacing?.status, 'over_pace');
  assert.equal(pacing?.projectedPeriodCredits, 300);
});

test('free pacing follows the account creation monthly anniversary', async () => {
  const period = await resolveAiUsagePeriod({
    freePeriodAnchor: new Date('2026-09-07T00:00:00.000Z'),
    timeZone: 'UTC',
    now: new Date('2026-09-14T00:00:00.000Z'),
  });
  const pacing = buildAiUsagePacing({
    credits: {
      used: 12_500,
      limit: 25_000,
      balance: 12_500,
      available: true,
      status: 'available',
    },
    billingPeriod: period.billingPeriod,
    now: new Date('2026-09-14T00:00:00.000Z'),
  });

  assert.equal(period.billingPeriod.source, 'free_monthly');
  assert.equal(period.billingPeriod.startsAt, '2026-09-07T00:00:00.000Z');
  assert.equal(period.billingPeriod.endsAt, '2026-10-07T00:00:00.000Z');
  assert.equal(pacing?.forecastBasis, 'current_free_credit_period');
  assert.equal(pacing?.status, 'over_pace');
  assert.equal(pacing?.projectedPeriodCredits, 53_571);
  assert.equal(pacing?.projectedOverageCredits, 28_572);
  assert.equal(pacing?.estimatedDaysUntilExhaustion, 7);
});

test('pacing omits exhaustion estimates that fall after the credit reset', () => {
  const pacing = buildAiUsagePacing({
    credits: {
      used: 10,
      limit: 100,
      balance: 90,
      available: true,
      status: 'available',
    },
    billingPeriod: {
      source: 'subscription',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
      endExclusive: true,
      from: '2026-09-01',
      to: '2026-09-30',
      totalDayCount: 30,
      elapsedDayCount: 15,
    },
    now: new Date('2026-09-16T00:00:00.000Z'),
  });

  assert.equal(pacing?.status, 'within_pace');
  assert.equal(pacing?.expectedToExhaustWithinPeriod, false);
  assert.equal(pacing?.estimatedDaysUntilExhaustion, null);
  assert.equal(pacing?.estimatedExhaustionAt, null);
});

test('Polar event normalization exposes only receipt-safe fields', () => {
  const normalized = normalizePolarUsageEvent({
    id: 'polar-event-1',
    name: 'ai_usage',
    source: 'user',
    timestamp: new Date('2026-09-19T12:00:00Z'),
    metadata: {
      schema_version: 1,
      entry_id: 'entry-1',
      request_id: 'request-1',
      entry_kind: 'usage',
      category: 'tts',
      operation: 'synthesize',
      provider: 'fish',
      model: 'fish-v1',
      quantity: 100,
      unit: 'characters',
      resource_type: 'speech',
      resource_id: 'speech-1',
      credits: 150,
      text: 'private speech',
      prompt: 'private prompt',
      message: 'private message',
    },
  });

  assert.deepEqual(normalized, {
    id: 'entry-1',
    requestId: 'request-1',
    occurredAt: '2026-09-19T12:00:00.000Z',
    entryKind: 'usage',
    category: 'tts',
    operation: 'synthesize',
    provider: 'fish',
    model: 'fish-v1',
    quantity: 100,
    unit: 'characters',
    credits: 150,
    resourceType: 'speech',
    resourceId: 'speech-1',
    itemized: true,
  });
  assert.equal('text' in normalized!, false);
  assert.equal('prompt' in normalized!, false);
  assert.equal('message' in normalized!, false);
});

test('summary separates spend from grants and groups legacy usage as uncategorized', () => {
  const window = resolveAiUsageWindow({
    from: '2026-09-17', to: '2026-09-19', timeZone: 'UTC', now: new Date('2026-09-19T20:00:00Z'),
  });
  const transactions = [
    event({ id: 'tts', timestamp: '2026-09-19T12:00:00Z', credits: 150, category: 'tts', operation: 'synthesize', provider: 'fish', schemaVersion: 1 }),
    event({ id: 'chat', timestamp: '2026-09-19T10:00:00Z', credits: 50, category: 'ai_chat', operation: 'message', provider: 'openrouter', schemaVersion: 1 }),
    event({ id: 'grant', timestamp: '2026-09-18T10:00:00Z', credits: -1000, category: 'credit_adjustment', entryKind: 'adjustment', schemaVersion: 1 }),
    event({ id: 'legacy', timestamp: '2026-09-17T10:00:00Z', credits: 25 }),
  ].map((value) => normalizePolarUsageEvent(value)!);

  const summary = buildAiUsageSummary(transactions, window);

  assert.equal(summary.totalSpentCredits, 225);
  assert.equal(summary.averageDailySpentCredits, 75);
  assert.equal(summary.grantedCredits, 1000);
  assert.equal(summary.netConsumedCredits, -775);
  assert.equal(summary.transactionCount, 3);
  assert.deepEqual(summary.daily, [
    { date: '2026-09-17', credits: 25, transactionCount: 1 },
    { date: '2026-09-18', credits: 0, transactionCount: 0 },
    { date: '2026-09-19', credits: 200, transactionCount: 2 },
  ]);
  assert.deepEqual(summary.categories, [
    { category: 'tts', credits: 150, transactionCount: 1, percentage: 66.67 },
    { category: 'ai_chat', credits: 50, transactionCount: 1, percentage: 22.22 },
    { category: 'uncategorized', credits: 25, transactionCount: 1, percentage: 11.11 },
  ]);
});

test('Polar event fetching follows pagination and deduplicates stable entry IDs', async () => {
  const window = resolveAiUsageWindow({
    from: '2026-09-18', to: '2026-09-19', timeZone: 'UTC', now: new Date('2026-09-19T20:00:00Z'),
  });
  const requestedPages: number[] = [];
  const transactions = await fetchAiUsageTransactions('customer-1', window, async (request) => {
    requestedPages.push(request.page);
    return request.page === 1
      ? {
          items: [event({ id: 'one', timestamp: '2026-09-19T12:00:00Z', credits: 10, category: 'tts', schemaVersion: 1 })],
          pagination: { maxPage: 2 },
        }
      : {
          items: [event({ id: 'one', timestamp: '2026-09-19T12:00:00Z', credits: 10, category: 'tts', schemaVersion: 1 })],
          pagination: { maxPage: 2 },
        };
  });

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(transactions.length, 1);
});

test('transaction pagination uses an opaque stable cursor and category filters', () => {
  const transactions: AiUsageTransaction[] = ['3', '2', '1'].map((id) => ({
    id,
    requestId: null,
    occurredAt: `2026-09-19T0${id}:00:00.000Z`,
    entryKind: 'usage',
    category: id === '1' ? 'ai_chat' : 'tts',
    operation: 'usage',
    provider: 'unknown',
    model: null,
    quantity: null,
    unit: null,
    credits: Number(id),
    resourceType: null,
    resourceId: null,
    itemized: true,
  }));

  const first = paginateAiUsageTransactions({ transactions, category: 'tts', limit: 1 });
  assert.deepEqual(first.items.map((item) => item.id), ['3']);
  assert.ok(first.nextCursor);
  const second = paginateAiUsageTransactions({ transactions, category: 'tts', limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(second.items.map((item) => item.id), ['2']);
  assert.equal(second.nextCursor, null);
});
