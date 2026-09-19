import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import AiUsageDailySchema from '/app/dist/schemas/ai_usage_daily.schema.js';
import AiUsageLedgerStateSchema from '/app/dist/schemas/ai_usage_ledger_state.schema.js';
import AiUsageReceiptSchema from '/app/dist/schemas/ai_usage_receipt.schema.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';

const base = 'http://127.0.0.1:3000';
const callsPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const receiptWorkerEntry = path.join(process.cwd(), 'dist/workers/ai_usage_receipts.worker.js');
const backfillWorkerEntry = path.join(process.cwd(), 'dist/workers/ai_usage_backfill.worker.js');

function account(id) {
  return [{ type: 'twitch', id, name: id, email: `${id}@example.invalid`, actived: true,
    chat_enabled: true, has_permissions: true, up_to_date_permissions: true }];
}

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

await getMongoDBConnection('ai-usage-ledger-check');
const redis = await getDragonflyClient('ai-usage-ledger-check');
await Promise.all([
  UsersSchema.deleteMany({}), AiUsageReceiptSchema.deleteMany({}),
  AiUsageDailySchema.deleteMany({}), AiUsageLedgerStateSchema.deleteMany({}), redis.flushDb(),
]);
fs.writeFileSync(callsPath, '');

const customer = '11111111-1111-4111-8111-111111111111';
await UsersSchema.create({
  name: 'ledger-pro', email: 'ledger-pro@example.invalid', plan_tier: 'pro', polar_sh_customer_id: customer,
  accounts: account('ledger-pro'), created_at: new Date('2025-01-07T00:00:00.000Z'),
});
await redis.hSet('token:ledger-token', { id: 'ledger-pro', login: 'ledger-pro', display_name: 'Ledger Pro' });
await redis.set('twitch:ledger-pro:ai:credits', JSON.stringify({
  version: 3, used: 200, limit: 500000, balance: 499800,
  meterId: '5103e79b-fd74-4ba8-a287-f95574f9addf', updatedAt: new Date().toISOString(),
  available: true, status: 'available',
}));

async function summary() {
  const response = await fetch(`${base}/billing/ai-usage/summary?from=2026-09-18&to=2026-09-19&timezone=UTC`, {
    headers: { Authorization: 'Bearer ledger-token' },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data;
}

const first = await summary();
assert.equal(first.analytics.totalSpentCredits, 0);
assert.equal(first.ledger.status, 'pending');
assert.equal(await redis.lLen('cron:ai-usage-backfills:queue'), 1);
let listCalls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  .filter(call => call.type === 'polar-events-list');
assert.equal(listCalls.length, 0, 'API request must not download Polar history');

const backfillOutput = await runWorker(backfillWorkerEntry);
assert.match(backfillOutput, /AI usage ledger sync completed/);
const afterBackfill = await summary();
assert.equal(afterBackfill.analytics.totalSpentCredits, 200);
assert.equal(afterBackfill.ledger.status, 'ready');
assert.equal(await AiUsageReceiptSchema.countDocuments({ channelID: 'ledger-pro', customerId: customer }), 2);
assert.equal(await AiUsageDailySchema.countDocuments({ channelID: 'ledger-pro', customerId: customer }), 2);
assert.ok(await AiUsageLedgerStateSchema.exists({ channelID: 'ledger-pro', customerId: customer }));
const stored = await AiUsageReceiptSchema.findOne({ entryId: 'ledger-tts' }).lean();
assert.equal(
  stored.expiresAt.toISOString(),
  new Date(new Date('2026-09-19T01:00:00.000Z').getTime() + 90 * 86400000).toISOString(),
);

const cachedKeys = await redis.keys('twitch:ledger-pro:ai:usage-receipts:v2:*');
if (cachedKeys.length) await redis.del(cachedKeys);
const second = await summary();
assert.equal(second.analytics.totalSpentCredits, 200);
listCalls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  .filter(call => call.type === 'polar-events-list');
assert.equal(listCalls.length, 1, 'Mongo coverage should avoid a second Polar history download');

const tiers = [['free', 30], ['premium', 60], ['pro', 90]];
for (const [tier, days] of tiers) {
  const channelID = `queue-${tier}`;
  const customerId = `${days}`.padStart(8, '0') + '-1111-4111-8111-111111111111';
  await UsersSchema.create({ name: channelID, email: `${channelID}@example.invalid`, plan_tier: tier,
    polar_sh_customer_id: customerId, accounts: account(channelID) });
  await redis.rPush('cron:ai-usage-receipts:queue', JSON.stringify({
    channelID, customerId, id: `queued-${tier}`, requestId: `request-${tier}`,
    occurredAt: '2026-09-19T12:00:00.000Z', entryKind: 'usage', category: 'tts',
    operation: 'synthesize', provider: 'fish', model: null, quantity: 100,
    unit: 'characters', credits: 150, resourceType: 'speech', resourceId: null, itemized: true,
  }));
}
const workerOutput = await runWorker(receiptWorkerEntry);
assert.match(workerOutput, /AI usage receipt batch completed/);
for (const [tier, days] of tiers) {
  const receipt = await AiUsageReceiptSchema.findOne({ entryId: `queued-${tier}` }).lean();
  assert.equal(receipt.retentionTier, tier);
  assert.equal(
    receipt.expiresAt.toISOString(),
    new Date(new Date('2026-09-19T12:00:00.000Z').getTime() + Number(days) * 86400000).toISOString(),
  );
}
assert.equal(await redis.lLen('cron:ai-usage-receipts:queue'), 0);
assert.equal(await redis.lLen('cron:ai-usage-receipts:processing'), 0);


const { persistAiUsageReceipt } = await import('/app/dist/utils/ai_usage_ledger.js');
const Dashboards = (await import('/app/dist/schemas/ai_usage_dashboard.schema.js')).default;
assert.ok(await Dashboards.exists({ channelID: 'ledger-pro' }));
async function transactions(query = '') {
  const response = await fetch(`${base}/billing/ai-usage/transactions?from=2026-09-18&to=2026-09-19&${query}`, { headers: { Authorization: 'Bearer ledger-token' } });
  return { status: response.status, body: await response.json() };
}
const firstPage = await transactions('limit=1');
assert.equal(firstPage.status, 200);
assert.equal(firstPage.body.data.items.length, 1);
const cursor = firstPage.body.data.nextCursor;
assert.ok(cursor);
// Removing the prior row must not invalidate the continuation boundary.
await AiUsageReceiptSchema.deleteOne({ entryId: firstPage.body.data.items[0].id });
const nextPage = await transactions(`limit=1&cursor=${encodeURIComponent(cursor)}`);
assert.equal(nextPage.status, 200);
assert.equal(nextPage.body.data.items[0].id, 'ledger-chat');
assert.equal((await transactions('limit=101')).status, 400);
assert.equal((await transactions('cursor=broken')).status, 400);
assert.equal((await transactions(`category=tts&cursor=${encodeURIComponent(cursor)}`)).status, 400);
assert.equal((await transactions('source=chat')).body.data.items.length, 1);
assert.equal((await transactions('requestId=request-chat')).body.data.items.length, 1);
assert.equal((await transactions('resourceId=missing')).body.data.items.length, 0);
const adjustment = { channelID: 'ledger-pro', customerId: customer, id: 'test-grant', requestId: 'grant-request',
 occurredAt: '2026-09-19T02:00:00Z', entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant',
 source: 'admin_credit_grant', provider: 'polar', model: null, quantity: null, unit: null, credits: -100,
 resourceType: null, resourceId: null, itemized: true };
await persistAiUsageReceipt(adjustment, 'pro');
const adjustmentPage = await transactions('entryKind=adjustment&adjustmentType=manual_grant');
assert.equal(adjustmentPage.body.data.items[0].credits, -100);
assert.equal(adjustmentPage.body.data.items[0].adjustmentType, 'manual_grant');
assert.equal((await transactions('entryKind=usage')).body.data.items.length, 1);
const freshSummary = await summary();
assert.equal(freshSummary.analytics.totalSpentCredits, 50);
assert.equal(freshSummary.analytics.grantedCredits, 100);
assert.ok(freshSummary.summaryUpdatedAt);
console.log('PASS API database cursors, scope validation, source/request/item filters, separate adjustments and dashboard refresh');

redis.destroy();
console.log('Background Mongo backfill, immediate API reads, local reuse, queue worker, aggregates, and tier retention passed');
process.exit(0);
