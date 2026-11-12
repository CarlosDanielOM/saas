// Records what the frozen TypeScript stores and answers for the usage ledger (P2-BILLING-02a):
// the ledger writes, the usage page's reads, retention, and the pure window, period and
// normalisation functions, against a scratch MongoDB database and Dragonfly database 9, with
// the clock fixed at 2026-11-12T12:00:00Z. Run from the dimabot checkout:
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/9 \
//     OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/billing/tests/usage_recorded/record.mts" \
//     "$REPO/dima-rust/crates/billing/tests/usage_recorded/typescript.json"
//
// Names and ids are fictional. The database is dropped and the Dragonfly keys deleted at the end.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON } = require('bson');
const output = process.argv[2];
const NOW = 1794484800000, DAY = 86_400_000, RealDate = Date;
let now = NOW;
class FixedDate extends RealDate { constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); } static now() { return now; } static [Symbol.hasInstance](v: any) { return v instanceof RealDate; } }
const database = `dima_test_billing_${randomUUID().replaceAll('-', '')}`;
const bson = (v: any) => { const d = globalThis.Date; globalThis.Date = RealDate; try { return EJSON.serialize(v, { relaxed: false }); } finally { globalThis.Date = d; } };
const json = (v: any) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const CHANNEL = 'rec-channel-1', CUSTOMER = 'rec-customer-1';
const sources: Record<string, string> = {};
for (const file of ['utils/ai_usage_ledger.ts', 'utils/ai_usage_dashboard.ts', 'utils/ai_usage_queries.ts', 'utils/ai_usage_receipts.ts', 'utils/ai_usage_lock.ts', 'utils/ai_usage_classification.ts', 'utils/ai_usage_backfill_queue.ts', 'schemas/ai_usage_receipt.schema.ts', 'schemas/ai_usage_daily.schema.ts', 'schemas/ai_usage_ledger_state.schema.ts', 'schemas/ai_usage_dashboard.schema.ts']) {
  sources[file] = createHash('sha256').update(await readFile(`${root}/src/${file}`)).digest('hex');
}
let cache: any;
try {
  await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: database, autoCreate: true, autoIndex: true });
  const ledger = await import(`${root}/src/utils/ai_usage_ledger.ts`);
  const dashboard = await import(`${root}/src/utils/ai_usage_dashboard.ts`);
  const queries = await import(`${root}/src/utils/ai_usage_queries.ts`);
  const receipts = await import(`${root}/src/utils/ai_usage_receipts.ts`);
  const backfillQueue = await import(`${root}/src/utils/ai_usage_backfill_queue.ts`);
  const { getDragonflyClient } = await import(`${root}/src/utils/databases/dragonfly.database.ts`);
  const models = [
    (await import(`${root}/src/schemas/ai_usage_receipt.schema.ts`)).default,
    (await import(`${root}/src/schemas/ai_usage_daily.schema.ts`)).default,
    (await import(`${root}/src/schemas/ai_usage_ledger_state.schema.ts`)).default,
    (await import(`${root}/src/schemas/ai_usage_dashboard.schema.ts`)).default,
  ];
  await Promise.all(models.map((m: any) => m.init()));
  cache = await getDragonflyClient('record');
  globalThis.Date = FixedDate as any;
  const sorts = [{ entryId: 1 }, { date: 1 }, { channelID: 1 }, { key: 1 }];
  async function snapshot() {
    const out: any = {};
    for (const [i, m] of models.entries()) {
      out[m.collection.name] = (await m.collection.find({}, { promoteValues: false }).sort(sorts[i]).toArray()).map((d: any) => { delete d._id; return bson(d); });
    }
    return out;
  }
  const steps: any[] = [];
  async function step(name: string, input: any, run: () => Promise<any>) {
    let result: any;
    try { result = json(await run()); } catch (e: any) { result = { error: e.message }; }
    steps.push({ name, now, input, result, documents: await snapshot() });
  }
  const receipt = (id: string, offset: number, credits: number, extra: any = {}) => ({
    channelID: CHANNEL, customerId: CUSTOMER, id, requestId: `req-${id}`, occurredAt: new RealDate(NOW - offset).toISOString(),
    entryKind: 'usage', category: 'tts', operation: 'synthesize', source: 'tts_queue', adjustmentType: null, provider: 'fish',
    model: null, quantity: 100, unit: 'characters', credits, resourceType: 'speech', resourceId: `speech-${id}`, itemized: true, ...extra,
  });
  const persist = async (name: string, raw: any, tier: string) => {
    const text = JSON.stringify(raw);
    await step(name, { queued: text, tier }, async () => ledger.persistAiUsageReceipt(ledger.parseQueuedAiUsageReceipt(text), tier));
  };
  await persist('persist-tts', receipt('aiu_tts', 3_600_000, 150), 'pro');
  await persist('persist-repeat', receipt('aiu_tts', 3_600_000, 150), 'pro');
  await persist('persist-fraction', receipt('aiu_chat', 7_200_000, 0.25, { category: 'ai_chat', operation: 'message', provider: 'openrouter', model: 'openai/gpt-x', quantity: 3.5, unit: 'tokens', resourceType: 'llm_generation' }), 'pro');
  await persist('persist-grant', receipt('aiu_grant', 10_800_000, -5000, { entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', source: 'admin_credit_grant', provider: 'polar', quantity: null, unit: null, resourceType: null, resourceId: null }), 'pro');
  await persist('persist-legacy-category', receipt('aiu_legacy', 2 * DAY, 7, { category: 'weird', quantity: null }), 'pro');
  await persist('persist-other-category', receipt('aiu_other', 2 * DAY + 60_000, 9, { category: 'other' }), 'pro');
  await persist('persist-debit', receipt('aiu_debit', 3_600_000 + 5, 30, { entryKind: 'adjustment', category: 'credit_adjustment', operation: 'correction', provider: 'polar' }), 'pro');
  await persist('persist-expired', receipt('aiu_expired', 100 * DAY, 4), 'pro');
  await persist('persist-large', receipt('aiu_large', 4 * 3_600_000, 3_000_000_000, { quantity: 2_147_483_648 }), 'pro');
  const transaction = (id: string, offset: number, credits: number, extra: any = {}) => ({
    id, requestId: `req-${id}`, occurredAt: new RealDate(NOW - offset).toISOString(), entryKind: credits < 0 ? 'adjustment' : 'usage',
    category: 'tts', operation: 'synthesize', source: 'tts_queue', adjustmentType: null, provider: 'fish', model: null,
    quantity: 100, unit: 'characters', credits, resourceType: null, resourceId: null, itemized: true, ...extra,
  });
  const transactions = [
    transaction('aiu_tts', 3_600_000, 150),
    transaction('bf-1', 5 * 3_600_000, 12),
    transaction('polar-credit:x1', 3 * DAY, -40_000, { category: 'credit_adjustment', operation: 'permanent_credit_grant', source: 'polar_meter_credit', adjustmentType: 'native_grant', provider: 'polar', quantity: null, unit: null }),
    transaction('bf-old', 95 * DAY, 3),
  ];
  const backfillInput = { channelID: CHANNEL, customerId: CUSTOMER, planTier: 'pro', coverageStart: new RealDate(NOW - 89 * DAY), rebuildStart: new RealDate(NOW - 3 * DAY), transactions, now: new RealDate(NOW) };
  await step('backfill', { planTier: 'pro', coverageStart: NOW - 89 * DAY, rebuildStart: NOW - 3 * DAY, transactions }, async () => ledger.backfillAiUsageLedger(backfillInput));
  await step('status-30', { startsAt: NOW - 30 * DAY }, async () => ledger.getAiUsageLedgerStatus({ channelID: CHANNEL, customerId: CUSTOMER, startsAt: new RealDate(NOW - 30 * DAY) }));
  await step('status-95', { startsAt: NOW - 95 * DAY }, async () => ledger.getAiUsageLedgerStatus({ channelID: CHANNEL, customerId: CUSTOMER, startsAt: new RealDate(NOW - 95 * DAY) }));
  const windows: any[] = [];
  for (const timeZone of ['America/New_York', 'UTC']) {
    const window = receipts.resolveAiUsageWindow({ timeZone, now: new RealDate(NOW), maxDays: 90 });
    windows.push({ timeZone, maxDays: 90 });
    const input = { channelID: CHANNEL, customerId: CUSTOMER, planTier: 'pro', accountCreatedAt: new RealDate(NOW - 400 * DAY), window };
    await step(`dashboard-${timeZone}`, { timeZone, accountCreatedAt: NOW - 400 * DAY }, async () => dashboard.getAiUsageDashboard(input));
    await step(`dashboard-cached-${timeZone}`, { timeZone, accountCreatedAt: NOW - 400 * DAY }, async () => dashboard.getAiUsageDashboard(input));
  }
  const window = receipts.resolveAiUsageWindow({ timeZone: 'UTC', now: new RealDate(NOW), maxDays: 90 });
  const pages: any[] = [];
  const page = async (filters: any) => { const result = await queries.queryAiUsageTransactions({ channelID: CHANNEL, customerId: CUSTOMER, window, ...filters }); pages.push({ filters, result: json(result) }); return result; };
  const first = await page({ limit: 2 });
  const second = await page({ limit: 2, cursor: first.nextCursor });
  await page({ limit: 2, cursor: second.nextCursor });
  await page({ category: 'tts' });
  await page({ entryKind: 'adjustment' });
  await page({ adjustmentType: 'manual_grant' });
  await page({ source: 'tts_queue', limit: 100 });
  for (const bad of [{ limit: 0 }, { category: 'nope' }, { source: 'a b' }, { cursor: 'not-a-cursor' }, { category: 'tts', cursor: first.nextCursor }]) {
    try { await page(bad); } catch (e: any) { pages.push({ filters: bad, error: e.message }); }
  }
  await step('retention-free', { tier: 'free' }, async () => ledger.adjustAiUsageRetention([CHANNEL], 'free'));
  const job = await backfillQueue.enqueueAiUsageBackfill(cache, { channelID: CHANNEL, customerId: CUSTOMER, planTier: 'premium', now: new RealDate(NOW) });
  await cache.del([job.job.dedupeKey]);
  await cache.lRem(backfillQueue.AI_USAGE_BACKFILL_QUEUE_KEY, 0, JSON.stringify(job.job));
  // Pure functions: windows in several zones across daylight-saving changes.
  const zoneCases: any[] = [];
  for (const timeZone of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo', 'America/Santiago', 'Asia/Tehran', '+05:30', '-08', 'utc', ' Europe/Kyiv ', 'Mars/Olympus']) {
    for (const [from, to, nowText, maxDays] of [[undefined, undefined, '2026-11-12T12:00:00Z', 30], ['2026-03-07', '2026-03-09', '2026-03-10T12:00:00Z', 31], ['2026-10-03', '2026-10-06', '2026-10-07T00:00:00Z', 31], ['2026-03-28', '2026-03-31', '2026-04-01T00:00:00Z', 90], ['2026-01-01', '2026-02-01', '2026-03-01T00:00:00Z', 31], ['2026-02-30', '2026-03-01', '2026-03-10T00:00:00Z', 31]]) {
      const input = { from, to, timeZone, now: new RealDate(nowText as string), maxDays };
      try { const w = receipts.resolveAiUsageWindow(input); zoneCases.push({ input: { from, to, timeZone, now: nowText, maxDays }, window: { from: w.from, to: w.to, timeZone: w.timeZone, start: w.startTimestamp.toISOString(), end: w.endTimestampExclusive.toISOString(), days: w.days.length } }); }
      catch (e: any) { zoneCases.push({ input: { from, to, timeZone, now: nowText, maxDays }, error: e.constructor.name, message: e.message }); }
    }
  }
  const periodCases: any[] = [];
  for (const [anchor, nowText, timeZone] of [['2026-01-31T10:00:00.000Z', '2026-02-28T12:00:00Z', 'UTC'], ['2026-01-31T10:00:00.000Z', '2026-03-01T09:00:00Z', 'America/New_York'], ['2024-02-29T00:00:00.000Z', '2026-02-28T23:59:59Z', 'Asia/Kolkata'], ['2026-11-30T00:00:00.000Z', '2026-11-12T00:00:00Z', 'UTC']]) {
    const p = await receipts.resolveAiUsagePeriod({ freePeriodAnchor: new RealDate(anchor), timeZone, now: new RealDate(nowText) });
    periodCases.push({ anchor, now: nowText, timeZone, billingPeriod: json(p.billingPeriod), window: { from: p.window.from, to: p.window.to, start: p.window.startTimestamp.toISOString(), end: p.window.endTimestampExclusive.toISOString(), days: p.window.days.length } });
  }
  const parseCases: any[] = [];
  for (const raw of ['{', 'null', '{}', JSON.stringify(receipt('p1', 0, 5)), JSON.stringify({ ...receipt('p2', 0, 5), credits: '0x10', quantity: null, requestId: '  r  ', operation: '   ', itemized: 1 }), JSON.stringify({ ...receipt('p3', 0, -1), entryKind: 'usage', source: 'free_credit_reset_worker' }), JSON.stringify({ ...receipt('p4', 0, 1), occurredAt: '2026-10-21', category: 'uncategorized', unit: 'bytes' })]) {
    parseCases.push({ raw, parsed: json(ledger.parseQueuedAiUsageReceipt(raw)) });
  }
  globalThis.Date = RealDate;
  await writeFile(output, JSON.stringify({ reference: { commit: '0c71108e', sources }, now: NOW, channel: CHANNEL, customer: CUSTOMER, steps, windows, pages, job: { enqueued: job.enqueued, job: { ...job.job, id: '<random>' } }, zoneCases, periodCases, parseCases }, null, 2) + '\n');
  console.log(`recorded ${steps.length} ledger steps, ${pages.length} pages, ${zoneCases.length} windows`);
} finally {
  globalThis.Date = RealDate;
  if (cache) { await cache.del([`locks:ai-usage-write:${createHash('sha256').update(JSON.stringify([CHANNEL, CUSTOMER])).digest('hex')}`]); cache.destroy?.(); }
  await mongoose.disconnect();
  if (!database.startsWith('dima_test_billing_')) throw Error('unsafe cleanup');
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(process.env.DIMA_TEST_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try { await c.connect(); await c.db(database).dropDatabase(); } finally { await c.close(); }
  process.exit(0);
}
