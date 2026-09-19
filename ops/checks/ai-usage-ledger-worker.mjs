import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import AiUsageDailySchema from '/app/dist/schemas/ai_usage_daily.schema.js';
import AiUsageLedgerStateSchema from '/app/dist/schemas/ai_usage_ledger_state.schema.js';
import AiUsageReceiptSchema from '/app/dist/schemas/ai_usage_receipt.schema.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { ingestPolarSHEvent } from '/app/dist/utils/polarsh.js';

const receiptWorkerEntry = path.join(process.cwd(), 'dist/workers/ai_usage_receipts.worker.js');
const backfillWorkerEntry = path.join(process.cwd(), 'dist/workers/ai_usage_backfill.worker.js');

function runWorker(workerEntry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerEntry, '--once'], {
      cwd: process.cwd(), env: { ...process.env, AI_USAGE_RECEIPTS_ENABLED: 'true', AI_USAGE_BACKFILL_ENABLED: 'true' },
    });
    let output = '';
    const capture = chunk => { output += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`worker exited ${code}/${signal}\n${output}`));
      else resolve(output);
    });
  });
}

function account(id) {
  return [{ type: 'twitch', id, name: id, email: `${id}@example.invalid`, actived: true,
    chat_enabled: true, has_permissions: true, up_to_date_permissions: true }];
}

await getMongoDBConnection('ai-usage-ledger-worker-check');
const redis = await getDragonflyClient('ai-usage-ledger-worker-check');
await Promise.all([
  UsersSchema.deleteMany({}), AiUsageReceiptSchema.deleteMany({}), AiUsageDailySchema.deleteMany({}),
  AiUsageLedgerStateSchema.deleteMany({}), redis.flushDb(),
]);

const occurredAt = new Date();
const tiers = [['free', 30], ['premium', 60], ['pro', 90]];
for (const [tier, days] of tiers) {
  const channelID = `producer-${tier}`;
  const customerId = `${days}`.padStart(8, '0') + '-1111-4111-8111-111111111111';
  await UsersSchema.create({ name: channelID, email: `${channelID}@example.invalid`, plan_tier: tier,
    polar_sh_customer_id: customerId, accounts: account(channelID) });
  const result = await ingestPolarSHEvent({
    customerId, channelID, externalId: `producer-${tier}-event`, cost: 0.15, reason: 'tts_fish', mode: 'immediate',
    usage: { category: 'tts', operation: 'synthesize', source: 'test', provider: 'fish', quantity: 100, unit: 'characters' },
  });
  assert.equal(result.error, false);
}
assert.equal(await redis.lLen('cron:ai-usage-receipts:queue'), 3);

const output = await runWorker(receiptWorkerEntry);
assert.match(output, /AI usage receipt batch completed/);
for (const [tier, days] of tiers) {
  const receipt = await AiUsageReceiptSchema.findOne({ entryId: `producer-${tier}-event` }).lean();
  assert.equal(receipt.retentionTier, tier);
  const retentionMs = receipt.expiresAt.getTime() - receipt.occurredAt.getTime();
  assert.equal(retentionMs, Number(days) * 86400000);
  assert.ok(Math.abs(receipt.occurredAt.getTime() - occurredAt.getTime()) < 10_000);
}
assert.equal(await AiUsageDailySchema.countDocuments({}), 3);
const receiptIndexes = await AiUsageReceiptSchema.collection.indexes();
const ttlIndex = receiptIndexes.find(index => index.key?.expiresAt === 1);
assert.equal(ttlIndex?.expireAfterSeconds, 0, 'receipt expiry must be enforced by a Mongo TTL index');
const uniqueIndex = receiptIndexes.find(index => index.unique === true && index.key?.entryId === 1);
assert.ok(uniqueIndex, 'receipt deduplication requires the compound unique event index');
assert.equal(await redis.lLen('cron:ai-usage-receipts:queue'), 0);
assert.equal(await redis.lLen('cron:ai-usage-receipts:processing'), 0);

const backfillOutput = await runWorker(backfillWorkerEntry);
assert.match(backfillOutput, /AI usage ledger sync completed/);
assert.equal(await AiUsageLedgerStateSchema.countDocuments({}), 3);
assert.equal(await redis.lLen('cron:ai-usage-backfills:queue'), 0);
assert.equal(await redis.lLen('cron:ai-usage-backfills:processing'), 0);
assert.equal(await redis.lLen('cron:ai-usage-backfills:dead'), 0);

// Crash repair: a receipt exists but its derived daily row was never written.
const { persistAiUsageReceipt, backfillAiUsageLedger } = await import('/app/dist/utils/ai_usage_ledger.js');
const { USAGE_QUEUES, claimUsageJob, failUsageJob, monitorAiUsageQueues } = await import('/app/dist/utils/ai_usage_queue_health.js');
const { computeDashboard, getAiUsageDashboard, refreshAiUsageDashboards } = await import('/app/dist/utils/ai_usage_dashboard.js');
const Dashboards = (await import('/app/dist/schemas/ai_usage_dashboard.schema.js')).default;
const repairChannel = 'producer-pro';
const repairCustomer = '00000090-1111-4111-8111-111111111111';
const existing = await AiUsageReceiptSchema.findOne({ channelID: repairChannel, entryId: 'producer-pro-event' }).lean();
const replay = { ...existing, id: existing.entryId, occurredAt: existing.occurredAt.toISOString() };
await AiUsageDailySchema.deleteMany({ channelID: repairChannel });
assert.equal(await persistAiUsageReceipt(replay, 'pro'), 'duplicate');
const expectedTotal = (await AiUsageReceiptSchema.find({ channelID: repairChannel }).lean()).filter(x => x.credits > 0 && x.entryKind !== 'adjustment').reduce((a, b) => a + b.credits, 0);
let dailyTotal = (await AiUsageDailySchema.find({ channelID: repairChannel }).lean()).reduce((a, b) => a + b.spentCredits, 0);
// Replay repairs the receipt's day; repair the other imported days independently.
await backfillAiUsageLedger({ channelID: repairChannel, customerId: repairCustomer, planTier: 'pro', coverageStart: new Date(Date.now() - 89 * 86400000), transactions: [] });
dailyTotal = (await AiUsageDailySchema.find({ channelID: repairChannel }).lean()).reduce((a, b) => a + b.spentCredits, 0);
assert.equal(dailyTotal, expectedTotal);
await Promise.all([
  persistAiUsageReceipt(replay, 'pro'),
  backfillAiUsageLedger({ channelID: repairChannel, customerId: repairCustomer, planTier: 'pro', coverageStart: new Date(Date.now() - 89 * 86400000), rebuildStart: new Date(), transactions: [] })
]);
assert.equal((await AiUsageDailySchema.find({ channelID: repairChannel }).lean()).reduce((a, b) => a + b.spentCredits, 0), expectedTotal);

const now = new Date();
const dayEnd = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
const historyStart = new Date(dayEnd.getTime() - 30 * 86400000);
const historyChannel = 'history-pro';
await AiUsageLedgerStateSchema.create({ channelID: historyChannel, customerId: repairCustomer, coverageStart: historyStart, backfilledAt: now });
const historyReceipts = Array.from({ length: 30 }, (_, i) => ({ ...existing, _id: undefined, channelID: historyChannel,
  entryId: `day-${i}`, occurredAt: new Date(historyStart.getTime() + i * 86400000 + 1000), credits: 100,
  expiresAt: new Date(now.getTime() + 60 * 86400000) }));
await AiUsageReceiptSchema.insertMany(historyReceipts);
await AiUsageReceiptSchema.create({ ...existing, _id: undefined, channelID: historyChannel, entryId: 'today-spike', occurredAt: now, credits: 100000 });
const window = { from: historyStart.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), timeZone: 'UTC',
  startTimestamp: historyStart, endTimestampExclusive: new Date(dayEnd.getTime() + 86400000), days: [now.toISOString().slice(0, 10)] };
const request = { channelID: historyChannel, customerId: repairCustomer, planTier: 'pro', accountCreatedAt: historyStart, window };
const firstDashboard = await getAiUsageDashboard(request);
assert.equal(firstDashboard.history.averageDailyCredits, 100, 'today spike must not distort completed-day history');
assert.equal(firstDashboard.history.dayCount, 30);
assert.equal(firstDashboard.history.activeDayCount, 30);
assert.equal(firstDashboard.history.recentAverageDailyCredits, 100);
assert.equal(firstDashboard.history.coefficientOfVariation, 0);
assert.equal((await getAiUsageDashboard(request)).cached, true);
await persistAiUsageReceipt({ ...replay, channelID: historyChannel, id: 'extra', occurredAt: now.toISOString(), credits: 5 }, 'pro');
assert.equal((await Dashboards.findOne({ channelID: historyChannel }).lean()).dirty, true);
await refreshAiUsageDashboards();
const refreshed = await getAiUsageDashboard(request);
assert.equal(refreshed.cached, true);
assert.equal(refreshed.summary.totalSpentCredits, 103005);
const grant = { ...replay, channelID: historyChannel, id: 'reset', occurredAt: now.toISOString(), credits: -5000, entryKind: 'adjustment', source: 'free_credit_reset_worker', adjustmentType: null };
await persistAiUsageReceipt(grant, 'pro');
await persistAiUsageReceipt({ ...grant, id: 'correction', credits: 25, operation: 'correction', source: 'admin' }, 'pro');
const adjusted = await getAiUsageDashboard(request);
assert.equal(adjusted.summary.totalSpentCredits, 103005);
assert.equal(adjusted.summary.grantedCredits, 5000);
assert.equal(adjusted.summary.adjustmentDebitedCredits, 25);
assert.equal(adjusted.summary.netConsumedCredits, 98030);
assert.ok(adjusted.summary.adjustments.some(row => row.type === 'monthly_reset' && row.grantedCredits === 5000));
assert.equal(adjusted.history.averageDailyCredits, 100);

// Retry movement is atomic and survives consumer restarts; the original payload is retained.
const queue = USAGE_QUEUES[0];
const failedRaw = JSON.stringify({ id: 'poison', enqueuedAt: new Date(Date.now() - 1800000).toISOString() });
await redis.rPush(queue.queue, failedRaw);
for (let attempt = 1; attempt <= 3; attempt++) {
  assert.equal(await claimUsageJob(redis, queue), failedRaw);
  assert.equal(await failUsageJob(redis, queue, failedRaw), attempt === 3 ? 2 : 1);
  assert.equal(await redis.lLen(queue.processing), 0);
}
assert.equal(await redis.lIndex(queue.dead, -1), failedRaw);
await redis.rPush(queue.queue, failedRaw);
const health = await monitorAiUsageQueues(redis);
assert.ok(health[0].reasons.includes('dead_letters'));
assert.ok(health[0].reasons.includes('queue_age'));
assert.ok(health[0].reasons.includes('repeated_failures'));
assert.ok(await redis.get('ai-usage:queue-health:receipts:snapshot'));
await claimUsageJob(redis, queue);
const stalled = await monitorAiUsageQueues(redis, Date.now() + 1800000);
assert.ok(stalled[0].reasons.includes('processing_stalled'));
console.log('PASS crash repair, concurrent writers, completed-day history, snapshot reuse/refresh, adjustment isolation, durable retries and queue alerts');

redis.destroy();
console.log('usage producer queue, background Polar backfill, and Mongo retention passed');
process.exit(0);
