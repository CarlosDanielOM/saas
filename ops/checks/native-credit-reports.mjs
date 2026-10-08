import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Receipts from '/app/dist/schemas/ai_usage_receipt.schema.js';
import States from '/app/dist/schemas/ai_usage_ledger_state.schema.js';
import { usageLedgerStatus, queryAiUsageTransactions } from '/app/dist/utils/ai_usage_queries.js';
import { getAiUsageDashboard } from '/app/dist/utils/ai_usage_dashboard.js';
import { syncAiUsageBackfillJob } from '/app/dist/utils/ai_usage_backfill.js';
import { AI_USAGE_REPORT_VERSION } from '/app/dist/utils/ai_usage_ledger.js';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['--test', 'dist/utils/ai_credit_sources.test.js', 'dist/utils/ai_native_credit_reports.test.js',
    'dist/utils/ai_usage_receipts.test.js', 'dist/utils/ai_usage_ledger.test.js'], { stdio: 'inherit' });

await getMongoDBConnection('native-credit-report-check');
const cache = await getDragonflyClient('native-credit-report-check');
const customerId = 'baf7c5a7-9cfc-4d1c-8c54-2b7d26e9cbc1', channelID = '452912249';
const now = new Date();
const ago = days => new Date(now.getTime() - days * 86400000);
const meterId = '5103e79b-fd74-4ba8-a287-f95574f9addf';
const statePath = '/tmp/saas-fixtures/events.json', callsPath = '/tmp/saas-fixtures/calls.jsonl';
const nativeId = '6ea2dbab-2e34-4b59-bf76-b78a7c71737e';
const event = (id, name, source, timestamp, metadata) => ({ id, name, source, timestamp: timestamp.toISOString(), metadata,
    organization_id: 'candidate', customer_id: customerId, customer: null, external_customer_id: null, child_count: 0, label: name });
const native = event(nativeId, 'meter.credited', 'system', ago(0), { meter_id: meterId, units: 40000, rollover: true });
const events = [
    event('usage-1', 'ai_usage', 'user', ago(1), { credits: 110, schema_version: 1, entry_id: 'usage-1', category: 'memory', operation: 'stream_summary' }),
    native, native,
    event('period-1', 'meter.credited', 'system', ago(20), { meter_id: meterId, units: 110000, rollover: false }),
    event('other-meter', 'meter.credited', 'system', ago(1), { meter_id: '01d90c16-87d0-4e31-880a-4045a8da90cd', units: 99999, rollover: true }),
];
const giftCredit = event('gift-credit', 'meter.credited', 'system', ago(2), { meter_id: meterId, units: 40000, rollover: true });
const purchaseCredit = event('purchase-credit', 'meter.credited', 'system', ago(3), { meter_id: meterId, units: 250000, rollover: true });
const periodCredit = events.find(e => e.id === 'period-1');
const sourceEvent = (credit, id, name = 'benefit.granted') => event(`benefit-${id}`, name, 'system',
    new Date(Date.parse(credit.timestamp) + 100), { benefit_id: `benefit-${id}`, benefit_grant_id: `grant-${id}`, benefit_type: 'meter_credit' });
events.push(giftCredit, purchaseCredit, sourceEvent(giftCredit, 'gift'), sourceEvent(purchaseCredit, 'purchase'), sourceEvent(periodCredit, 'subscription', 'benefit.cycled'));
const grant = (id, units, rollover, subscription_id, order_id) => ({ id: `grant-${id}`, customer_id: customerId,
    benefit_id: `benefit-${id}`, subscription_id, order_id,
    benefit: { id: `benefit-${id}`, type: 'meter_credit', properties: { meter_id: meterId, units, rollover } } });
const grants = [grant('gift', 40000, true, null, 'order-gift'), grant('purchase', 250000, true, null, 'order-purchase'),
    grant('subscription', 800000, false, 'subscription', null)];
const orders = [
    { id: 'order-gift', customer_id: customerId, subscription_id: null, paid: true, total_amount: 0,
        product_id: 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a', metadata: { source: 'dimabot_gift_fulfillment', gift_id: 'gift' } },
    { id: 'order-purchase', customer_id: customerId, subscription_id: null, paid: true, total_amount: 500,
        product_id: '2f446a84-69a9-42f6-96ed-6be2b31fdf0c', metadata: {} },
];
const fixture = { events, grants, orders, failNative: false };
fs.writeFileSync(statePath, JSON.stringify(fixture));
fs.writeFileSync(callsPath, '');
const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const accountCreatedAt = ago(365);
await Users.create({ name: 'vtluciel', email: 'recipient@example.invalid', polar_sh_customer_id: customerId, plan_tier: 'free', created_at: accountCreatedAt,
    accounts: [{ type: 'twitch', id: channelID, name: 'vtluciel', actived: false }] });
// A fresh old-format history must upgrade the ENTIRE retained interval, not just the overlap.
await States.create({ channelID, customerId, coverageStart: ago(28), backfilledAt: now, reportVersion: 2 });
// Already-imported native receipts must be reclassified without creating a second grant.
await Receipts.create({ channelID, customerId, entryId: 'polar-credit:period-1', occurredAt: ago(20), entryKind: 'adjustment',
    category: 'credit_adjustment', operation: 'period_credit_grant', source: 'polar_meter_credit', adjustmentType: 'native_grant',
    provider: 'polar', credits: -110000, itemized: true, retentionTier: 'free', expiresAt: ago(-10) });
const start = ago(24); start.setUTCHours(0, 0, 0, 0);
const end = new Date(now); end.setUTCHours(24, 0, 0, 0);
const days = Array.from({ length: 25 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
const window = { from: days[0], to: days.at(-1), timeZone: 'UTC', startTimestamp: start, endTimestampExclusive: end, days };
const input = { channelID, customerId, planTier: 'free', accountCreatedAt, window };
const balance = JSON.stringify({ version: 3, used: 0, limit: 83812.09657, balance: 83812.09657, meterId, updatedAt: now.toISOString(), available: true, status: 'available' });
await cache.set(`twitch:${channelID}:ai:credits`, balance);
await cache.hSet('token:admin-report', { id: 'admin-fixture', login: 'cdom201', display_name: 'Admin' });
await cache.hSet('token:non-admin-report', { id: channelID, login: 'vtluciel', display_name: 'Recipient' });
const range = `from=${window.from}&to=${window.to}&timezone=UTC`;
const url = 'http://127.0.0.1:3000/admin-site/users/' + channelID + '/ai-usage';
const api = async (path, token = 'admin-report') => {
    const response = await fetch(`${url}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
};
async function worker() {
    if (process.env.SAAS_TARGET === 'cron') return;
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['dist/workers/ai_usage_backfill.worker.js', '--once'], { env: process.env });
        let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
        const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
        child.on('error', reject); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
}
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Reporting worker did not complete'); }
if (process.env.SAAS_TARGET === 'api') {
    assert.equal((await api(`summary?${range}`, 'non-admin-report')).status, 403);
    const before = await api(`summary?${range}`);
    assert.equal(before.status, 200); assert.equal(before.body.data.ledger.status, 'pending');
    assert.equal(calls().length, 0, 'API only queues a background report sync');
} else assert.equal((await usageLedgerStatus(input)).status, 'pending');
await worker();
await until(async () => (await States.findOne({ channelID }).lean()).reportVersion === AI_USAGE_REPORT_VERSION);
const report = await getAiUsageDashboard(input);
assert.equal(report.summary.grantedCredits, 440000, JSON.stringify({ calls: calls(), receipts: await Receipts.find({ channelID }).lean() }));
assert.equal(report.summary.totalSpentCredits, 110);
assert.equal(report.summary.transactionCount, 1);
assert.equal(report.summary.netConsumedCredits, -439890);
assert.deepEqual(report.summary.adjustments.map(row => [row.type, row.grantedCredits, row.transactionCount]),
    [['gifted_credits', 40000, 1], ['native_grant', 40000, 1], ['purchased_pack', 250000, 1], ['subscription_credits', 110000, 1]]);
assert.equal(await Receipts.countDocuments({ channelID, source: 'polar_meter_credit' }), 4);
const rows = await queryAiUsageTransactions({ ...input, category: 'credit_adjustment', adjustmentType: 'native_grant' });
assert.deepEqual(rows.items.map(row => [row.operation, row.credits]), [['permanent_credit_grant', -40000]]);
for (const type of ['gifted_credits', 'purchased_pack', 'subscription_credits'])
    assert.equal((await queryAiUsageTransactions({ ...input, adjustmentType: type })).items.length, 1);
const page = await queryAiUsageTransactions({ ...input, category: 'credit_adjustment', limit: 1 });
assert.ok(page.nextCursor);
assert.equal((await queryAiUsageTransactions({ ...input, category: 'credit_adjustment', limit: 1, cursor: page.nextCursor })).items[0].adjustmentType, 'gifted_credits');
assert.equal(await cache.get(`twitch:${channelID}:ai:credits`), balance, 'Reporting must not alter usable credits');
if (process.env.SAAS_TARGET === 'api') {
    const summary = await api(`summary?${range}`);
    assert.equal(summary.body.data.analytics.grantedCredits, 440000);
    assert.equal(summary.body.data.ledger.status, 'ready');
    const history = await api(`transactions?${range}&category=credit_adjustment`);
    assert.equal(history.body.data.items.find(row => row.id === `polar-credit:${nativeId}`).credits, -40000);
    const custom = await api(`summary?from=${days.at(-1)}&to=${days.at(-1)}&timezone=UTC`);
    assert.equal(custom.body.data.analytics.grantedCredits, 40000, 'Date filter excludes earlier period credit');
}
// A retry cannot duplicate receipts or grant totals; failure cannot mark old history upgraded.
const duplicate = { job: { id: 'isolated-retry', channelID, customerId, planTier: 'free', coverageStart: start.toISOString(), requestedAt: now.toISOString(), reason: 'api_request', attempts: 0, dedupeKey: 'isolated-retry' } };
await syncAiUsageBackfillJob(duplicate.job, cache, new Date(now.getTime() + 120000));
assert.equal(await Receipts.countDocuments({ channelID, source: 'polar_meter_credit' }), 4);
await States.updateOne({ channelID }, { $set: { reportVersion: 0 } });
fs.writeFileSync(statePath, JSON.stringify({ ...fixture, failNative: true }));
await assert.rejects(() => syncAiUsageBackfillJob(duplicate.job, cache));
assert.equal((await States.findOne({ channelID }).lean()).reportVersion, 0);
assert.equal(await cache.get(`twitch:${channelID}:ai:credits`), balance);
fs.writeFileSync(statePath, JSON.stringify({ ...fixture, failSource: true }));
await assert.rejects(() => syncAiUsageBackfillJob(duplicate.job, cache));
assert.equal((await States.findOne({ channelID }).lean()).reportVersion, 0, 'source failure keeps upgrade pending');
fs.writeFileSync(statePath, JSON.stringify(fixture));
await syncAiUsageBackfillJob(duplicate.job, cache);
assert.equal((await getAiUsageDashboard(input)).summary.grantedCredits, 440000);
assert.ok(calls().some(call => call.source === 'system' && call.name === 'meter.credited'));
assert.ok(calls().some(call => call.path.replace(/\/$/, '') === '/v1/benefit-grants' && new URLSearchParams(call.query).get('page') === '2'), 'grant source list paginates');
assert.equal(calls().some(call => /^\/v1\/benefit-grants\/[^/]+/.test(call.path)), false, 'Polar has no grant-by-ID endpoint');
assert.equal(calls().some(call => call.method !== 'GET'), false, 'No provider writes, checkout, grant or chat allowed');
assert.equal(calls().some(call => call.blocked), false);
console.log(`PASS ${process.env.SAAS_TARGET}: old history reclassification, separate subscription/purchase/gift/unclassified totals, pagination/deduplication, custom dates, type filters/cursors, retries, provider failures keep upgrade pending, unchanged balance and GET-only Polar access`);
cache.destroy(); process.exit(0);
