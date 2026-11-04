/**
 * API check: account deletion (DELETE /auth/account) and DimaFX log retention.
 *
 * - Polar: every billable subscription (by stored customer ID and by our user ID as external
 *   customer ID, across pages) is revoked BEFORE any data is deleted; ended subscriptions and
 *   other customers are untouched; if Polar fails, the request fails and nothing is deleted;
 *   a subscription already ended by a concurrent cancel does not block deletion.
 *
 * - The API creates both TTL indexes (also when the old non-unique twitchTransactionID index
 *   that production still has is present).
 * - TTL: every purchase/playback record older than 365 days expires, in any state (including
 *   unresolved ones); records younger than 365 days stay.
 * - DELETE /auth/account removes the channel's shop items, viewer wallets, purchase log and
 *   playback records; other channels' DimaFX data is untouched; unauthenticated calls get 401.
 *
 * Run with --dependency mongo --dependency redis --fixtures <copy of ops/checks/account-deletion-fixtures>
 * --test-env ops/checks/account-deletion-fixtures/test-env.json.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const BASE = 'mongodb://mongo:27017';
const TTL_SECONDS = 365 * 24 * 60 * 60;
const DAY = 24 * 60 * 60 * 1000;

async function until(fn, message, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${message}`);
}

const ttlIndex = async (database, collection) =>
  (await database.collection(collection).indexes().catch(() => [])).find(index => index.name === 'createdAt_1');

function assertTtlIndex(index, label) {
  assert.ok(index, `${label}: TTL index exists`);
  assert.equal(index.expireAfterSeconds, TTL_SECONDS, `${label}: expires after 365 days`);
  assert.equal(index.partialFilterExpression, undefined, `${label}: applies to every state`);
}

const conn = await mongoose.createConnection(`${BASE}/saas_ops_account_deletion_test`).asPromise();
const db = conn.db;
await conn.client.db('admin').command({ setParameter: 1, ttlMonitorSleepSecs: 1 });

// 1. The running API created both TTL indexes on startup.
await until(async () => (await ttlIndex(db, 'extensionwallettransactions')) && (await ttlIndex(db, 'dimafxplaybacks')),
  'API created both DimaFX TTL indexes');
assertTtlIndex(await ttlIndex(db, 'extensionwallettransactions'), 'purchase log');
assertTtlIndex(await ttlIndex(db, 'dimafxplaybacks'), 'playback log');
console.log('PASS API created 365-day TTL indexes for the DimaFX purchase and playback logs');

// 1b. Production still has a legacy non-unique twitchTransactionID_1 index that conflicts with the
// schema's unique one. The TTL index must still be created next to it.
const legacy = await mongoose.createConnection(`${BASE}/saas_ops_account_dimafx_legacy`).asPromise();
await legacy.db.collection('extensionwallettransactions').createIndex({ twitchTransactionID: 1 }, { name: 'twitchTransactionID_1', background: true });
const { ExtensionWalletTransactionSchema } = await import('/app/dist/schemas/extension_wallet_transaction.schema.js');
const LegacyModel = legacy.model('ExtensionWalletTransaction', ExtensionWalletTransactionSchema.schema);
const initError = await LegacyModel.init().then(() => null, error => error);
console.log(`  legacy index conflict reproduced: ${initError ? initError.codeName || initError.message : 'no error'}`);
assertTtlIndex(await ttlIndex(legacy.db, 'extensionwallettransactions'), 'purchase log with legacy index');
console.log('PASS TTL index is created even with the production legacy twitchTransactionID index');
await legacy.close();

// 2. TTL behaviour on real documents.
const old = new Date(Date.now() - 366 * DAY);
const recent = new Date(Date.now() - 364 * DAY);
const tx = (name, type, metadata, createdAt = old) => ({
  name, platform: 'twitch', userID: '55500001', channelID: 'ttl-channel', type, amountBits: 100, balanceDelta: 0,
  metadata, createdAt, updatedAt: createdAt
});
await db.collection('extensionwallettransactions').insertMany([
  tx('legacy-bits', 'bits_purchase', { action: 'use_now' }),
  tx('fulfilled', 'bits_purchase', { action: 'use_now', fulfillment: 'fulfilled' }),
  tx('refunded', 'bits_purchase', { action: 'save', fulfillment: 'refunded' }),
  tx('credit-use', 'use_now', {}),
  tx('pending', 'bits_purchase', { action: 'use_now', fulfillment: 'pending' }),
  tx('processing', 'bits_purchase', { action: 'use_now', fulfillment: 'processing' }),
  tx('refund-pending', 'bits_purchase', { action: 'use_now', fulfillment: 'refund_pending' }),
  tx('recent-fulfilled', 'bits_purchase', { action: 'use_now', fulfillment: 'fulfilled' }, recent)
]);
const playback = (id, state, createdAt = old) => ({
  _id: id, channelID: 'ttl-channel', payload: {}, state, leaseOwner: '', leaseUntil: new Date(0), createdAt, updatedAt: createdAt
});
await db.collection('dimafxplaybacks').insertMany([
  playback('pb-completed', 'completed'), playback('pb-refunded', 'refunded'), playback('pb-queued', 'queued'),
  playback('pb-playing', 'playing'), playback('pb-refunding', 'refunding'), playback('pb-recent', 'completed', recent)
]);

const txNames = async () => (await db.collection('extensionwallettransactions').find({ channelID: 'ttl-channel' }).toArray()).map(d => d.name).sort();
const pbIds = async () => (await db.collection('dimafxplaybacks').find({ channelID: 'ttl-channel' }).toArray()).map(d => d._id).sort();
await until(async () => (await txNames()).length === 1 && (await pbIds()).length === 1, 'TTL monitor removed expired DimaFX logs');
assert.deepEqual(await txNames(), ['recent-fulfilled']);
assert.deepEqual(await pbIds(), ['pb-recent']);
console.log('PASS every log older than 365 days expired in any state (incl. pending/queued and legacy rows); recent logs stayed');

// 3. Account deletion removes the channel's DimaFX data and nothing else.
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
const owner = '99003101';
const other = '99003102';
const token = 'account-dimafx-owner-token';
await redis.hSet(`token:${token}`, { id: owner, login: 'acct_dimafx_owner', display_name: 'acct_dimafx_owner' });
await db.collection('users').insertOne({
  _id: new mongoose.Types.ObjectId(),
  accounts: [{ type: 'twitch', id: owner, name: 'acct_dimafx_owner', actived: true }]
});

const oid = () => new mongoose.Types.ObjectId();
const item = (channelID, deletedAt = null) => ({
  _id: oid(), channelID, channelName: channelID, createdByUserID: channelID, assetID: oid(), name: 'Clip', description: '',
  category: 'video', mediaType: 'video', thumbnailUrl: '', durationMs: 1000, bitsPrice: 100, sku: 'dimafx_100', volume: 100,
  isEnabled: !deletedAt, sortOrder: 0, tts: null, deletedAt, createdAt: new Date(), updatedAt: new Date()
});
const wallet = (channelID, userID) => ({
  _id: oid(), platform: 'twitch', userID, channelID, displayName: userID, balance: 300,
  config: { quickPurchasePriority: 'credits_first', quickPurchaseAction: 'use_now' }, items: [], dimafxReceipts: [],
  createdAt: new Date(), updatedAt: new Date()
});
const ledger = (channelID, type, metadata = {}) => ({
  _id: oid(), platform: 'twitch', userID: '55500002', channelID, type, amountBits: 100, balanceDelta: 0,
  metadata, createdAt: new Date(), updatedAt: new Date()
});
await db.collection('channelextensionitems').insertMany([item(owner), item(owner, new Date()), item(other)]);
await db.collection('userextensioninventories').insertMany([
  wallet(owner, '55500002'), wallet(owner, '55500003'),
  wallet(other, '55500002'),
  // The deleted streamer as a viewer in someone else's shop: that wallet belongs to the other channel.
  wallet(other, owner)
]);
await db.collection('extensionwallettransactions').insertMany([
  ledger(owner, 'bits_purchase', { action: 'use_now', fulfillment: 'fulfilled', viewerText: 'hello' }),
  ledger(owner, 'bits_purchase', { action: 'use_now', fulfillment: 'pending' }),
  ledger(owner, 'credit_purchase'),
  ledger(other, 'bits_purchase', { action: 'use_now', fulfillment: 'fulfilled' }),
  ledger(other, 'use_now')
]);
await db.collection('dimafxplaybacks').insertMany([
  { _id: 'owner-done', channelID: owner, payload: { viewerText: 'hi' }, state: 'completed', leaseOwner: '', leaseUntil: new Date(0), createdAt: new Date(), updatedAt: new Date() },
  { _id: 'owner-queued', channelID: owner, payload: {}, state: 'queued', leaseOwner: '', leaseUntil: new Date(0), createdAt: new Date(), updatedAt: new Date() },
  { _id: 'other-done', channelID: other, payload: {}, state: 'completed', leaseOwner: '', leaseUntil: new Date(0), createdAt: new Date(), updatedAt: new Date() }
]);

const counts = async channelID => ({
  items: await db.collection('channelextensionitems').countDocuments({ channelID }),
  wallets: await db.collection('userextensioninventories').countDocuments({ channelID }),
  transactions: await db.collection('extensionwallettransactions').countDocuments({ channelID }),
  playbacks: await db.collection('dimafxplaybacks').countDocuments({ channelID })
});
assert.deepEqual(await counts(owner), { items: 2, wallets: 2, transactions: 3, playbacks: 2 });

const unauthenticated = await fetch('http://127.0.0.1:3000/auth/account', { method: 'DELETE' });
assert.equal(unauthenticated.status, 401, 'auth required');
assert.deepEqual(await counts(owner), { items: 2, wallets: 2, transactions: 3, playbacks: 2 }, 'nothing deleted without auth');

const response = await fetch('http://127.0.0.1:3000/auth/account', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const body = await response.json();
assert.equal(response.status, 200, JSON.stringify(body));
assert.equal(body.error, false);
assert.equal(body.data.usersDeleted, 1);
assert.equal(body.data.polarSubscriptionsRevoked, 0, 'no Polar subscriptions for this account');
assert.equal(body.data.dimafxItemsDeleted, 2);
assert.equal(body.data.dimafxWalletsDeleted, 2);
assert.equal(body.data.dimafxTransactionsDeleted, 3);
assert.equal(body.data.dimafxPlaybacksDeleted, 2);
assert.deepEqual(await counts(owner), { items: 0, wallets: 0, transactions: 0, playbacks: 0 });
assert.deepEqual(await counts(other), { items: 1, wallets: 2, transactions: 2, playbacks: 1 }, 'other channels untouched');
assert.equal(await db.collection('users').countDocuments({ 'accounts.id': owner }), 0, 'account deleted');
console.log('PASS DELETE /auth/account removed the channel\'s DimaFX items, wallets, purchase log and playbacks; other channels untouched; 401 without auth');

// 4. Polar subscriptions are revoked before anything is deleted.
const fs = await import('node:fs');
const STATE = '/tmp/saas-fixtures/polar-state.json';
const CALLS = '/tmp/saas-fixtures/polar-calls.jsonl';
const payer = '99003201';
const payerToken = 'account-polar-payer-token';
const payerUserId = new mongoose.Types.ObjectId();
await redis.hSet(`token:${payerToken}`, { id: payer, login: 'acct_polar_payer', display_name: 'acct_polar_payer' });
await db.collection('users').insertOne({
  _id: payerUserId, polar_sh_customer_id: 'cus_payer', plan_tier: 'pro',
  accounts: [{ type: 'twitch', id: payer, name: 'acct_polar_payer', actived: true }]
});
await db.collection('channelextensionitems').insertOne(item(payer));
const sub = (id, status, extra) => ({ id, status, ...extra });
const byCustomer = { customer_id: 'cus_payer' };
const byExternal = { external_customer_id: String(payerUserId) };
const writeState = state => fs.writeFileSync(STATE, JSON.stringify({ ownerUserId: String(payerUserId), ownerChannelId: payer, ...state }));
const subscriptions = () => [
  sub('sub_active', 'active', byCustomer),
  sub('sub_old_1', 'canceled', byCustomer),
  sub('sub_old_2', 'incomplete_expired', byCustomer),
  sub('sub_past_due', 'past_due', byCustomer), // on page 2 of the customer listing
  sub('sub_trial', 'trialing', byExternal),
  sub('sub_race', 'unpaid', { ...byExternal, conflictOnRevoke: true }),
  sub('sub_someone_else', 'active', { customer_id: 'cus_other', external_customer_id: 'someone-else' })
];
const deletePayer = async () => {
  const res = await fetch('http://127.0.0.1:3000/auth/account', { method: 'DELETE', headers: { Authorization: `Bearer ${payerToken}` } });
  return { status: res.status, body: await res.json() };
};
const revokeCalls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const status = id => JSON.parse(fs.readFileSync(STATE, 'utf8')).subscriptions.find(s => s.id === id).status;

// 4a. Polar fails: request fails, nothing deleted, subscription still active.
writeState({ failRevoke: true, subscriptions: subscriptions() });
let r = await deletePayer();
assert.equal(r.status, 500, 'deletion fails when Polar cannot revoke');
assert.equal(status('sub_active'), 'active');
assert.equal(await db.collection('users').countDocuments({ _id: payerUserId }), 1, 'account kept when Polar fails');
assert.equal(await db.collection('channelextensionitems').countDocuments({ channelID: payer }), 1, 'data kept when Polar fails');
console.log('PASS Polar failure: deletion refused with 500, account, data and subscription untouched');

// 4b. Success: revoke all billable subscriptions first, then delete.
fs.rmSync(CALLS, { force: true });
writeState({ subscriptions: subscriptions() });
r = await deletePayer();
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.data.polarSubscriptionsRevoked, 4);
const calls = revokeCalls();
assert.deepEqual(calls.map(c => c.revoke).sort(), ['sub_active', 'sub_past_due', 'sub_race', 'sub_trial']);
for (const call of calls) {
  assert.equal(call.usersAtRevoke, 1, `${call.revoke} revoked while the account still existed`);
  assert.equal(call.dimafxItemsAtRevoke, 1, `${call.revoke} revoked before any data was deleted`);
}
for (const id of ['sub_active', 'sub_past_due', 'sub_trial', 'sub_race']) assert.equal(status(id), 'canceled', `${id} ended`);
assert.equal(status('sub_someone_else'), 'active', 'other customers untouched');
assert.equal(await db.collection('users').countDocuments({ _id: payerUserId }), 0, 'account deleted');
assert.equal(await db.collection('channelextensionitems').countDocuments({ channelID: payer }), 0, 'data deleted');
console.log('PASS Polar: 4 billable subscriptions (customer ID + external ID, page 2, concurrent cancel) revoked before any deletion; ended and other customers untouched');

await redis.quit();
await conn.close();
process.exit(0);
