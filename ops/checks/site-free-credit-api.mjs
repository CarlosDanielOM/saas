import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Receipts from '/app/dist/schemas/ai_usage_receipt.schema.js';
import Ledger from '/app/dist/schemas/ai_usage_ledger_state.schema.js';
import Dashboards from '/app/dist/schemas/ai_usage_dashboard.schema.js';
import { getAiCredits, isAiCreditsExhausted } from '/app/dist/utils/billing.js';

const base = 'http://127.0.0.1:3000';
const now = Date.now();
const day = 86400000;
await getMongoDBConnection('free-display-isolated-check');
const redis = await getDragonflyClient('free-display-isolated-check');
const id = '999991';
const customerId = '11111111-1111-4111-8111-111111111111';
const raw = { version: 3, used: 0, limit: 25000, balance: 25000,
  meterId: '5103e79b-fd74-4ba8-a287-f95574f9addf', updatedAt: new Date(now).toISOString(),
  available: true, status: 'available' };
const account = id => [{ type: 'twitch', id, name: `fixture-${id}`, actived: true,
  chat_enabled: true, has_permissions: true, up_to_date_permissions: true }];
const user = await Users.create({ name: 'free-display-fixture', plan_tier: 'free',
  polar_sh_customer_id: customerId, accounts: account(id), created_at: new Date(now - 2 * day) });
await redis.hSet('token:free-display-fixture', { id, login: 'free-display-fixture' });
await redis.set(`twitch:${id}:ai:credits`, JSON.stringify(raw));
const ledger = { channelID: id, customerId, coverageStart: new Date(now - 30 * day),
  backfilledAt: new Date(), reportVersion: 3 };
await Ledger.create(ledger);
const receipt = (entryId, credits, occurredAt) => ({ channelID: id, customerId, entryId,
  requestId: entryId, occurredAt: new Date(occurredAt), entryKind: credits < 0 ? 'adjustment' : 'usage',
  category: credits < 0 ? 'credit_adjustment' : 'tts', operation: credits < 0 ? 'grant' : 'synthesize',
  provider: 'fixture', model: null, quantity: null, unit: null, credits, itemized: true,
  retentionTier: 'free', expiresAt: new Date(now + 30 * day) });
await Receipts.insertMany([
  receipt('initial-grant', -25000, now - 2 * day + 1000),
  receipt('yesterday-spend', 10644, now - day),
  receipt('today-spend', 83, now),
  receipt('outside-current-cycle', 9000, now - 3 * day),
]);
async function get(path, token = 'free-display-fixture') {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  return { status: response.status, ...body };
}
const summary = await get('/billing/ai-usage/summary?timezone=UTC');
assert.equal(summary.status, 200, JSON.stringify(summary));
assert.deepEqual(summary.data.credits, raw, 'the billing snapshot remains unchanged');
assert.equal(summary.data.creditDisplay.estimated, true);
assert.equal(summary.data.creditDisplay.credits.used, 10727);
assert.equal(summary.data.creditDisplay.credits.balance, 14273);
assert.equal(summary.data.creditDisplay.credits.limit, 25000);
assert.ok(summary.data.creditDisplay.pacing.projectedPeriodCredits > 0);
assert.notEqual(summary.data.creditDisplay.pacing.status, 'no_usage');
assert.equal(summary.data.analytics, null, 'Free analytics stay gated');
assert.equal(summary.data.capabilities.dailySpend, false);
assert.equal(summary.data.capabilities.transactions, false);
assert.equal((await get('/billing/ai-usage/transactions')).status, 403, 'the paid ledger remains locked');
const credits = await get(`/billing/ai-credits?channelID=${id}`);
assert.equal(credits.status, 200);
assert.equal(credits.data.balance, 25000, 'raw /ai-credits accounting is untouched');
assert.equal(credits.data.display.credits.balance, 14273, 'dashboard and clip displays use the estimate');
const today = new Date(now).toISOString().slice(0, 10);
const custom = await get(`/billing/ai-usage/summary?from=${today}&to=${today}&timezone=UTC`);
assert.equal(custom.status, 200);
assert.equal(custom.data.billingPeriod.source, 'custom');
assert.equal(custom.data.creditDisplay.credits.used, 10727, 'date filters cannot replace the cycle');
assert.equal(custom.data.creditDisplay.credits.balance, 14273);
await Ledger.deleteOne({ channelID: id });
const pending = await get('/billing/ai-usage/summary');
assert.equal(pending.data.creditDisplay.credits, null);
assert.equal(pending.data.creditDisplay.pacing, null);
assert.equal(pending.data.credits.balance, 25000);
assert.equal((await get('/billing/ai-credits')).data.display.credits, null);
await Ledger.create(ledger);
await Receipts.insertMany([receipt('extra-grant', -10000, now), receipt('extra-debit', 1000, now)]);
await Receipts.updateOne({ entryId: 'extra-debit' }, { $set: { entryKind: 'adjustment' } });
await Dashboards.updateMany({ channelID: id }, { $set: { dirty: true } });
const adjusted = await get('/billing/ai-usage/summary');
assert.equal(adjusted.data.creditDisplay.credits.limit, 35000);
assert.equal(adjusted.data.creditDisplay.credits.used, 11727);
assert.equal(adjusted.data.creditDisplay.credits.balance, 23273);
await Receipts.insertMany([receipt('exhaust-display', 30000, now)]);
await Dashboards.updateMany({ channelID: id }, { $set: { dirty: true } });
const exhausted = await get('/billing/ai-usage/summary');
assert.equal(exhausted.data.creditDisplay.credits.balance, 0);
assert.equal(exhausted.data.creditDisplay.credits.status, 'exhausted');
assert.deepEqual(await getAiCredits(user, id, { requireVerified: true }), raw);
assert.equal(await isAiCreditsExhausted(id, redis), false, 'enforcement still uses the existing math');
assert.deepEqual(JSON.parse(await redis.get(`twitch:${id}:ai:credits`)), raw, 'reporting never writes its estimate into billing cache');
for (const [tier, channelID, used, limit] of [['premium', '999992', 43945, 200000], ['pro', '999993', 176862, 800000]]) {
  await Users.create({ name: `fixture-${tier}`, plan_tier: tier, polar_sh_customer_id: customerId,
    accounts: account(channelID), created_at: new Date(now - 2 * day) });
  await redis.hSet(`token:${tier}-display-fixture`, { id: channelID, login: `fixture-${tier}` });
  const snapshot = { ...raw, used, limit, balance: limit - used };
  await redis.set(`twitch:${channelID}:ai:credits`, JSON.stringify(snapshot));
  const result = await get('/billing/ai-credits', `${tier}-display-fixture`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, snapshot, `${tier} keeps the exact existing response`);
  assert.equal((await get(`/billing/ai-usage/summary?channelID=${channelID}`)).status, 403, 'other channels cannot read credit data');
}
console.log('PASS: public Free display balance/pacing, current cycle, grants/debits, pending history, paid gates, unchanged raw cache/enforcement, paid snapshots and authorization');
redis.destroy();
process.exit(0);
