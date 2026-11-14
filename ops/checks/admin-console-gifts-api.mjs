// API target: scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
//   --test-env ops/checks/credit-gifts-fixtures/test-env.json --fixtures ops/checks/credit-gifts-fixtures --check ops/checks/admin-console-gifts-api.mjs
// Cron target (same flags, `cron-<run-id>`): only part 0 runs, against the candidate's real supervised gift worker
// (direct calls would race it). Polar and Twitch are the fake providers from credit-gifts-fixtures.
//
// 1. Gift worker before payment (utils/credit_gifts.ts): an open checkout is checked every 30 s for 30 minutes,
//    then every 5 minutes; Polar errors before payment never flag a gift `needs_support`; an expired checkout
//    (or an open/failed one an hour past its expiry, or a reservation that never got a checkout after 48 h) ends
//    as `expired` and is never claimed again; an old unpaid `needs_support` row heals to `expired`; a paid gift
//    that keeps failing still becomes `needs_support`.
// 2. Owner gifts API (/admin-site/gifts): owner only, no-store, filters and counts (an unpaid needs_support row
//    counts as awaiting payment), channel filter by id and login, cursor pages, one gift, retry rules, safe output.
// 3. Owner channel lists: command rows carry activation/reserved/authoring/permissionMode/userLevel; eventsub rows
//    carry the site's normalized type (outgoing raid, legacy cheer), the raw type and the editable chat settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { CommandsSchema as Commands } from '/app/dist/schemas/commands.schema.js';
import Eventsubs from '/app/dist/schemas/eventsub.schema.js';
import { CreditGiftSchema as Gifts } from '/app/dist/schemas/credit_gift.schema.js';
import { createCreditGiftCheckout, processCreditGift, checkoutClosedUnpaid, acceptCreditGiftPaidOrder } from '/app/dist/utils/credit_gifts.js';
import { GIFT_PACK_PAIRS } from '/app/dist/utils/credit_gift_provider.js';

await getMongoDBConnection('gift-admin-check');
const redis = await getDragonflyClient('gift-admin-check');
await Gifts.init();
const dir = '/tmp/saas-fixtures', statePath = `${dir}/polar.json`, callsPath = `${dir}/calls.jsonl`;
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
// Atomic (temp + rename): the candidate's worker reads this file at the same time.
const modify = fn => { const state = read(); fn(state); const tmp = `${statePath}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, statePath); };
const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* not ready */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }
const MIN = 60_000, HOUR = 60 * MIN;

// ---- People (fictional). Channel ids 4xx so other checks' rows never collide. ----
const buyerCustomer = '44444444-4444-4444-8444-444444444441', recipientCustomer = '44444444-4444-4444-8444-444444444442';
const users = [];
for (const [login, channel, customer] of [['lantern_buyer', '411', buyerCustomer], ['fjord_recipient', '422', recipientCustomer]]) {
    const user = await Users.create({ name: login, email: `${login}@example.invalid`, plan_tier: 'free', polar_sh_customer_id: customer,
        accounts: [{ type: 'twitch', id: channel, name: login, actived: false, chat_enabled: false, has_permissions: false }] });
    users.push(user);
    modify(s => { s.customers[customer] = { id: customer, external_id: user._id.toString(), deleted_at: null }; });
}
const [buyer, recipient] = users;
await redis.hSet('token:gift-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:gift-streamer', { id: '411', login: 'lantern_buyer', display_name: 'lantern_buyer' });
await redis.set('app:twitch:token', 'dummy-app-token');

const giftRequest = () => ({ user: buyer, productId: GIFT_PACK_PAIRS[0].productId, recipientId: recipient._id.toString(),
    requestId: randomUUID(), acknowledgeNoRefunds: true, successUrl: 'https://domdimabot.com/lantern_buyer/credits?gift=return',
    returnUrl: 'https://domdimabot.com/lantern_buyer/credits' });
const newGift = (request = giftRequest()) => createCreditGiftCheckout(request);
const payInPolar = checkoutId => {
    const id = randomUUID();
    modify(s => { const c = s.checkouts[checkoutId]; c.status = 'succeeded'; s.orders[id] = {
        id, paid: true, status: 'paid', product_id: c.product_id, checkout_id: c.id, customer_id: c.customer_id,
        customer: s.customers[c.customer_id], net_amount: c.amount, total_amount: c.amount, refunded_amount: 0, discount_amount: 0,
        currency: 'usd', subscription_id: null, metadata: c.metadata }; });
    return id;
};
/** Only this gift is due, so `processCreditGift` claims exactly it. */
const advance = async id => {
    await Gifts.updateMany({ _id: { $ne: id } }, { $set: { nextAttemptAt: new Date(Date.now() + 365 * 86_400_000) } });
    await Gifts.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(0) } });
    assert.equal(await processCreditGift(), true, `gift ${id.slice(0, 8)} was claimed`);
    return Gifts.findById(id).lean();
};
const backdate = (id, ms) => Gifts.collection.updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - ms) } });
const checkout = (giftCheckoutId, values) => modify(s => Object.assign(s.checkouts[giftCheckoutId], values));
const near = (date, ms, label) => {
    const delta = new Date(date).getTime() - Date.now();
    assert.ok(Math.abs(delta - ms) < 15_000, `${label}: next check in ${Math.round(delta / 1000)} s, expected ~${ms / 1000} s`);
};

// ---------------------------------------------------------------- 0. Cron target: the real supervised worker
if (process.env.SAAS_TARGET === 'cron') {
    // The worker in the candidate claims gifts itself; drive it only through Polar's state and the due time.
    await until(() => calls().some(c => c.workerReady), 'credit gift worker started');
    const expiring = await newGift(), legacyFlag = await newGift(), waiting = await newGift();
    checkout(expiring.checkoutId, { status: 'expired' });
    checkout(legacyFlag.checkoutId, { status: 'expired' });
    await Gifts.updateOne({ _id: legacyFlag.giftId }, { $set: { status: 'needs_support', attempts: 9, lastError: 'Gift provider connection interrupted' } });
    await Gifts.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await until(async () => (await Gifts.findById(expiring.giftId).lean()).status === 'expired', 'worker closes the expired checkout');
    await until(async () => (await Gifts.findById(legacyFlag.giftId).lean()).status === 'expired', 'worker heals the legacy unpaid flag');
    await until(async () => (await Gifts.findById(waiting.giftId).lean()).nextAttemptAt > new Date(Date.now() + 10_000), 'open checkout rescheduled');
    const open = await Gifts.findById(waiting.giftId).lean();
    assert.equal(open.status, 'awaiting_payment');
    near(open.nextAttemptAt, 30_000, 'open checkout under the real worker');
    // The expired ones are left alone afterwards: no more Polar calls for their checkouts.
    const settled = calls().length;
    await Gifts.updateMany({ status: 'expired' }, { $set: { nextAttemptAt: new Date(0) } });
    await sleep(4000);
    assert.equal(calls().slice(settled).some(c => [expiring.checkoutId, legacyFlag.checkoutId].some(id => `${c.path}${c.query || ''}`.includes(id))), false,
        'expired gifts are never checked again');
    console.log('PASS cron: the supervised gift worker closes expired checkouts, heals legacy unpaid flags, keeps checking open ones every 30 s and leaves expired gifts alone');
    process.exit(0);
}

// ---------------------------------------------------------------- 1. Worker before payment
assert.equal(checkoutClosedUnpaid({ status: 'expired' }), true);
assert.equal(checkoutClosedUnpaid({ status: 'open', expires_at: new Date(Date.now() + HOUR).toISOString() }), false);
assert.equal(checkoutClosedUnpaid({ status: 'open', expires_at: new Date(Date.now() - 30 * MIN).toISOString() }), false, 'grace hour after expiry');
assert.equal(checkoutClosedUnpaid({ status: 'open', expires_at: new Date(Date.now() - 2 * HOUR).toISOString() }), true);
assert.equal(checkoutClosedUnpaid({ status: 'failed', expires_at: new Date(Date.now() - 2 * HOUR).toISOString() }), true);
assert.equal(checkoutClosedUnpaid({ status: 'failed' }), false, 'a failed checkout without an expiry keeps being checked');
assert.equal(checkoutClosedUnpaid({ status: 'confirmed', expires_at: new Date(Date.now() - 2 * HOUR).toISOString() }), false, 'confirmed may still create its order');
assert.equal(checkoutClosedUnpaid({ status: 'succeeded' }), false);

// A fresh open checkout: checked again in ~30 s; the checkout's own status is read when there is no order.
const fresh = await newGift();
let gift = await advance(fresh.giftId);
assert.equal(gift.status, 'awaiting_payment');
near(gift.nextAttemptAt, 30_000, 'young unpaid gift');
assert.ok(calls().some(c => c.method === 'GET' && c.path === `/v1/checkouts/${fresh.checkoutId}`), 'checkout status read');

// After 30 minutes: every 5 minutes.
await backdate(fresh.giftId, 2 * HOUR);
gift = await advance(fresh.giftId);
assert.equal(gift.status, 'awaiting_payment');
near(gift.nextAttemptAt, 5 * MIN, 'older unpaid gift');

// Polar errors before payment: backoff, never needs_support.
modify(s => { s.controls.ordersDown = true; });
for (let i = 0; i < 6; i++) gift = await advance(fresh.giftId);
assert.equal(gift.attempts, 6);
assert.equal(gift.status, 'awaiting_payment', 'unpaid gifts are never flagged as needing support');
assert.equal(gift.lastError, 'Gift provider request failed (503)');
modify(s => { delete s.controls.ordersDown; });

// The checkout expires: the gift ends as expired and is never claimed again.
checkout(fresh.checkoutId, { status: 'expired', expires_at: new Date(Date.now() - 22 * HOUR).toISOString() });
gift = await advance(fresh.giftId);
assert.equal(gift.status, 'expired');
assert.ok(gift.expiredAt, 'expiredAt recorded');
assert.equal(gift.lastError, '');
assert.equal(gift.leaseToken, undefined);
await Gifts.updateOne({ _id: fresh.giftId }, { $set: { nextAttemptAt: new Date(0) } });
const before = calls().length;
assert.equal(await processCreditGift(), false, 'an expired gift is not claimed');
assert.equal(calls().length, before, 'no Polar call for an expired gift');

// An expired gift never gets a new checkout for the same request.
const reused = giftRequest();
const closed = await newGift(reused);
checkout(closed.checkoutId, { status: 'expired' });
assert.equal((await advance(closed.giftId)).status, 'expired');
await assert.rejects(newGift(reused), err => err.statusCode === 409 && /expired/.test(err.message), 'expired gift refuses a new checkout');

// Race: the paid-order webhook records the payment while the worker is reading the expired checkout.
// The stale expiry must not land over the payment.
const raced = await newGift();
checkout(raced.checkoutId, { status: 'expired' });
globalThis.__giftCheckoutReadHook = async id => {
    if (id !== raced.checkoutId) return;
    globalThis.__giftCheckoutReadHook = null;
    await Gifts.updateOne({ _id: raced.giftId, paidAt: { $exists: false } }, { $set: { paidOrderId: 'webhook-order', paidAt: new Date(), status: 'payment_received' } });
};
gift = await advance(raced.giftId);
assert.equal(globalThis.__giftCheckoutReadHook, null, 'the race hook ran');
assert.equal(gift.status, 'payment_received', 'a payment that landed mid-pass is never overwritten by expiry');
assert.ok(gift.paidAt); assert.equal(gift.expiredAt, undefined);

// Race: payment lands (webhook) while the worker polls an open, older checkout: it is due again right away,
// not after the 5-minute unpaid delay.
const paidMidPoll = await newGift();
await backdate(paidMidPoll.giftId, 2 * HOUR);
globalThis.__giftCheckoutReadHook = async id => {
    if (id !== paidMidPoll.checkoutId) return;
    globalThis.__giftCheckoutReadHook = null;
    await Gifts.updateOne({ _id: paidMidPoll.giftId, paidAt: { $exists: false } }, { $set: { paidOrderId: 'webhook-order-2', paidAt: new Date(), status: 'payment_received', nextAttemptAt: new Date() } });
};
gift = await advance(paidMidPoll.giftId);
assert.equal(globalThis.__giftCheckoutReadHook, null, 'the poll race hook ran');
assert.equal(gift.status, 'payment_received');
near(gift.nextAttemptAt, 1000, 'a payment recorded mid-poll keeps the gift due now');

// Race: a 48 h old reservation gets its checkout while the worker looks for one; it stays open.
await Gifts.collection.insertOne({
    _id: 'f'.repeat(64), buyerId: buyer._id, recipientId: recipient._id, buyerLogin: 'lantern_buyer', recipientLogin: 'fjord_recipient',
    recipientName: 'fjord_recipient', recipientChannelId: '422', productId: GIFT_PACK_PAIRS[0].productId,
    fulfillmentProductId: GIFT_PACK_PAIRS[0].fulfillmentProductId, benefitId: 'b', credits: 40000, priceAmount: 100, priceCurrency: 'usd',
    status: 'awaiting_payment', noRefundsAcknowledgedAt: new Date(), purchaseCreateStartedAt: new Date(Date.now() - 72 * HOUR),
    announcementAttempts: 0, attempts: 0, nextAttemptAt: new Date(0), createdAt: new Date(Date.now() - 72 * HOUR), updatedAt: new Date(),
});
globalThis.__giftCheckoutListHook = async () => {
    globalThis.__giftCheckoutListHook = null;
    await Gifts.updateOne({ _id: 'f'.repeat(64) }, { $set: { checkoutId: randomUUID() } });
};
gift = await advance('f'.repeat(64));
assert.equal(globalThis.__giftCheckoutListHook, null, 'the list race hook ran');
assert.equal(gift.status, 'awaiting_payment', 'a checkout that appeared mid-pass keeps the reservation open');

// If a paid order ever arrives for an expired gift, the paid-order webhook revives it for delivery.
const late = await newGift();
const lateOrder = payInPolar(late.checkoutId);
await Gifts.updateOne({ _id: late.giftId }, { $set: { status: 'expired', expiredAt: new Date() } });
await acceptCreditGiftPaidOrder(lateOrder);
gift = await Gifts.findById(late.giftId).lean();
assert.deepEqual([gift.status, gift.paidOrderId], ['payment_received', lateOrder], 'the webhook repairs a paid expired gift');

// An old unpaid needs_support row (flagged by transient errors before this fix) heals to expired.
const legacy = await newGift();
checkout(legacy.checkoutId, { status: 'expired' });
await Gifts.updateOne({ _id: legacy.giftId }, { $set: { status: 'needs_support', attempts: 9, lastError: 'Gift provider connection interrupted' } });
gift = await advance(legacy.giftId);
assert.equal(gift.status, 'expired', 'legacy unpaid needs_support heals');

// Open an hour past its expiry → expired; open before its expiry → still waiting; failed without expiry → waiting.
const stale = await newGift();
checkout(stale.checkoutId, { expires_at: new Date(Date.now() - 2 * HOUR).toISOString() });
assert.equal((await advance(stale.giftId)).status, 'expired');
const open = await newGift();
checkout(open.checkoutId, { expires_at: new Date(Date.now() + 20 * HOUR).toISOString() });
assert.equal((await advance(open.giftId)).status, 'awaiting_payment');
const failed = await newGift();
checkout(failed.checkoutId, { status: 'failed' });
assert.equal((await advance(failed.giftId)).status, 'awaiting_payment');

// A reservation that never got a checkout: waits 60 s while young, expires after 48 h.
const reservation = (id, ageMs) => Gifts.collection.insertOne({
    _id: id, buyerId: buyer._id, recipientId: recipient._id, buyerLogin: 'lantern_buyer', recipientLogin: 'fjord_recipient',
    recipientName: 'fjord_recipient', recipientChannelId: '422', productId: GIFT_PACK_PAIRS[0].productId,
    fulfillmentProductId: GIFT_PACK_PAIRS[0].fulfillmentProductId, benefitId: 'b', credits: 40000, priceAmount: 100, priceCurrency: 'usd',
    status: 'awaiting_payment', noRefundsAcknowledgedAt: new Date(), announcementAttempts: 0, attempts: 0, nextAttemptAt: new Date(0),
    createdAt: new Date(Date.now() - ageMs), updatedAt: new Date(),
});
await reservation('c'.repeat(64), HOUR);
gift = await advance('c'.repeat(64));
assert.equal(gift.status, 'awaiting_payment');
near(gift.nextAttemptAt, 60_000, 'young reservation without checkout');
await reservation('d'.repeat(64), 72 * HOUR);
assert.equal((await advance('d'.repeat(64))).status, 'expired', 'reservation without checkout expires after 48 h');

// Paid, then delivery keeps failing: still needs_support (money was received).
const paidGift = await newGift();
const orderId = payInPolar(paidGift.checkoutId);
gift = await advance(paidGift.giftId);
assert.equal(gift.status, 'payment_received');
modify(s => { s.controls.badRollover = true; });
for (let i = 0; i < 5; i++) gift = await advance(paidGift.giftId);
assert.equal(gift.status, 'needs_support', 'paid gift that keeps failing needs support');
assert.match(gift.lastError, /permanent credits/);
modify(s => { delete s.controls.badRollover; });
console.log('PASS gift worker: 30 s → 5 min checks before payment, expiry never lands over a payment or a new checkout (raced mid-pass), a payment recorded mid-poll stays due now, expired gifts refuse a new checkout, a late paid order revives one, no needs_support without payment, expired/open-past-expiry/never-created checkouts close, legacy unpaid flags heal, paid failures still need support');

// ---------------------------------------------------------------- 2. Owner gifts API
const api = (path, { token = 'gift-owner', method = 'GET' } = {}) => fetch(`http://127.0.0.1:3000/admin-site/${path}`,
    { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
await until(async () => (await api('gifts')).status === 200, 'API ready');
const FORBIDDEN = [buyerCustomer, recipientCustomer, 'polar_c_', 'polar.sh/checkout', 'leaseToken', 'checkoutUrl', 'example.invalid', 'buyerCustomerId', 'recipientCustomerId'];
const json = async (path, status = 200, options) => {
    const res = await api(path, options);
    const text = await res.text();
    assert.equal(res.status, status, `${path}: ${text.slice(0, 300)}`);
    if (status === 200) assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const secret of FORBIDDEN) assert.equal(text.includes(secret), false, `${path} leaks ${secret}`);
    return JSON.parse(text);
};

assert.equal((await api('gifts', { token: null })).status, 401);
assert.equal((await api('gifts', { token: 'gift-streamer' })).status, 403);
await json('gifts?status=bogus', 400);
await json('gifts?cursor=nope', 400);
await json('gifts?limit=99', 400);
await json('gifts?channel=a%20b', 400);

// A legacy unpaid needs_support row the worker hasn't reached yet counts as awaiting payment.
const legacyOpen = await newGift();
await Gifts.updateOne({ _id: legacyOpen.giftId }, { $set: { status: 'needs_support', attempts: 7, lastError: 'Gift provider connection interrupted', nextAttemptAt: new Date(Date.now() + 365 * 86_400_000) } });

const all = await Gifts.find({}).lean();
const expect = {
    all: all.length,
    needs_support: all.filter(g => g.status === 'needs_support' && g.paidAt).length,
    in_progress: all.filter(g => ['payment_received', 'delivering'].includes(g.status)).length,
    awaiting_payment: all.filter(g => g.status === 'awaiting_payment' || (g.status === 'needs_support' && !g.paidAt)).length,
    delivered: all.filter(g => g.status === 'delivered').length,
    expired: all.filter(g => g.status === 'expired').length,
};
const list = (await json('gifts?limit=50')).data;
assert.deepEqual(list.counts, expect);
assert.equal(expect.needs_support, 1);
assert.ok(expect.expired >= 4 && expect.awaiting_payment >= 4);
assert.equal(list.rows.length, all.length);
for (let i = 1; i < list.rows.length; i++) assert.ok(list.rows[i - 1].createdAt >= list.rows[i].createdAt, 'newest first');

const row = list.rows.find(r => r.id === paidGift.giftId);
assert.equal(row.status, 'needs_support'); assert.equal(row.paid, true);
assert.deepEqual(row.buyer, { login: 'lantern_buyer', channelID: '411' });
assert.deepEqual(row.recipient, { login: 'fjord_recipient', displayName: 'fjord_recipient', channelID: '422' });
assert.equal(row.credits, 40000); assert.equal(row.creditsUSD, 0.4);
assert.equal(row.priceAmount, 100); assert.equal(row.priceCurrency, 'usd');
assert.ok(row.paidAt && row.nextAttemptAt && row.lastError);
assert.equal(row.refs.checkoutId, paidGift.checkoutId); assert.equal(row.refs.paidOrderId, orderId);
assert.equal(row.processing, false);
const expiredRow = list.rows.find(r => r.id === fresh.giftId);
assert.equal(expiredRow.status, 'expired'); assert.equal(expiredRow.paid, false);
assert.ok(expiredRow.expiredAt); assert.equal(expiredRow.nextAttemptAt, null, 'nothing left to do');

for (const [filter, test] of [
    ['needs_support', r => r.status === 'needs_support' && r.paid],
    ['awaiting_payment', r => !r.paid && ['awaiting_payment', 'needs_support'].includes(r.status)],
    ['expired', r => r.status === 'expired'],
    ['in_progress', r => ['payment_received', 'delivering'].includes(r.status)],
    ['delivered', r => r.status === 'delivered'],
]) {
    const page = (await json(`gifts?status=${filter}&limit=50`)).data;
    assert.equal(page.rows.length, expect[filter], `${filter} rows`);
    assert.ok(page.rows.every(test), `${filter} filter`);
    assert.deepEqual(page.counts, expect, 'counts ignore the status filter');
}
assert.ok((await json('gifts?status=awaiting_payment&limit=50')).data.rows.some(r => r.id === legacyOpen.giftId), 'legacy unpaid flag is awaiting payment');

// Channel filter: by id (recipient), by login (buyer), unknown login → empty.
assert.equal((await json('gifts?channel=422&limit=50')).data.rows.length, all.length);
assert.equal((await json('gifts?channel=lantern_buyer&limit=50')).data.rows.length, all.length);
const nobody = (await json('gifts?channel=no_such_streamer')).data;
assert.deepEqual([nobody.rows.length, nobody.next, nobody.counts.all], [0, null, 0]);
assert.equal((await json('gifts?channel=999999')).data.rows.length, 0);

// Cursor pages cover every gift once, in order.
const seen = [];
let cursor = null;
do {
    const page = (await json(`gifts?limit=3${cursor ? `&cursor=${cursor}` : ''}`)).data;
    assert.ok(page.rows.length <= 3);
    seen.push(...page.rows.map(r => r.id));
    cursor = page.next;
} while (cursor);
assert.deepEqual(seen, list.rows.map(r => r.id), 'pages follow the merged order without gaps or repeats');

// One gift.
assert.equal((await json(`gifts/${paidGift.giftId}`)).data.id, paidGift.giftId);
await json('gifts/not-a-gift', 404);
await json(`gifts/${'e'.repeat(64)}`, 404);

// Retry: never paid → 409; leased → 409; paid and stuck → due now; delivered → 409.
assert.match((await json(`gifts/${fresh.giftId}/retry`, 409, { method: 'POST' })).message, /never paid/);
await Gifts.updateOne({ _id: paidGift.giftId }, { $set: { leaseUntil: new Date(Date.now() + MIN), nextAttemptAt: new Date(Date.now() + HOUR) } });
assert.equal((await json(`gifts/${paidGift.giftId}`)).data.processing, true);
assert.match((await json(`gifts/${paidGift.giftId}/retry`, 409, { method: 'POST' })).message, /working on this gift/);
await Gifts.updateOne({ _id: paidGift.giftId }, { $unset: { leaseUntil: '' } });
const retried = await json(`gifts/${paidGift.giftId}/retry`, 200, { method: 'POST' });
assert.match(retried.message, /try this gift again/);
assert.ok(new Date(retried.data.nextAttemptAt).getTime() <= Date.now() + 1000, 'due now');
assert.ok((await Gifts.findById(paidGift.giftId).lean()).nextAttemptAt.getTime() <= Date.now(), 'stored as due');
assert.equal((await Gifts.findById(paidGift.giftId).lean()).status, 'needs_support', 'retry changes nothing else');
await Gifts.updateOne({ _id: paidGift.giftId }, { $set: { deliveredAt: new Date(), status: 'delivered' } });
assert.match((await json(`gifts/${paidGift.giftId}/retry`, 409, { method: 'POST' })).message, /already delivered/);
assert.equal((await api(`gifts/${paidGift.giftId}/retry`, { token: 'gift-streamer', method: 'POST' })).status, 403);
console.log('PASS gifts API: owner only, no-store, counts/filters (legacy unpaid = awaiting payment), channel by id/login, cursor pages, one gift, retry rules, no customer ids or checkout secrets');

// ---------------------------------------------------------------- 3. Command and eventsub rows for the editors
await Commands.create([
    { channelID: '422', channel: 'fjord_recipient', name: 'Lurk', cmd: 'lurk', func: 'lurk', message: '$(user) lurks', cooldown: 10, enabled: true, userLevel: 1, userLevelName: 'everyone', activation: 'command', reserved: false, authoring: 'text' },
    { channelID: '422', channel: 'fjord_recipient', name: 'Hello', cmd: 'hello there', func: 'custom', message: 'Hi!', cooldown: 30, enabled: true, userLevel: 1, activation: 'keyword', keywordSettings: { matchMode: 'anywhere' } },
    { channelID: '422', channel: 'fjord_recipient', name: 'Shoutout', cmd: 'so', func: 'shoutout', message: '', cooldown: 5, enabled: true, userLevel: 7, userLevelName: 'mod', reserved: true },
    { channelID: '422', channel: 'fjord_recipient', name: 'Dice', cmd: 'dice', func: 'dice', message: 'rolled', cooldown: 0, enabled: false, userLevel: 1, authoring: 'blocks', permissionExpression: { role: 'vip' } },
    { channelID: '422', channel: 'fjord_recipient', name: 'Broken', cmd: 'broken', func: 'broken', message: 'x', cooldown: 0, enabled: true, userLevel: 1, permissionExpression: { nope: true } },
    { channelID: '422', channel: 'fjord_recipient', name: 'Promo', cmd: 'promo', func: 'promo', message: 'never posted', cooldown: 5, enabled: true, userLevel: 7 },
]);
const commands = (await json('users/422/commands?limit=50')).data.rows;
const byCmd = Object.fromEntries(commands.map(c => [c.cmd, c]));
assert.deepEqual(['activation', 'reserved', 'authoring', 'permissionMode', 'userLevel'].map(k => byCmd.lurk[k]), ['command', false, 'text', 'level', 1]);
assert.equal(byCmd.lurk.keywordMatch, null);
assert.deepEqual([byCmd['hello there'].activation, byCmd['hello there'].keywordMatch], ['keyword', 'anywhere']);
assert.deepEqual([byCmd.so.reserved, byCmd.so.userLevel], [true, 7]);
assert.deepEqual([byCmd.dice.authoring, byCmd.dice.permissionMode, byCmd.dice.enabled], ['blocks', 'tags', false]);
assert.equal(byCmd.broken.permissionMode, 'invalid');
assert.deepEqual([byCmd.promo.runsBuiltIn, byCmd.so.runsBuiltIn, byCmd.lurk.runsBuiltIn, byCmd['hello there'].runsBuiltIn], [true, true, false, false],
    'commands whose built-in code runs instead of the reply are flagged');
assert.equal(byCmd.lurk.channel, 'fjord_recipient');
assert.equal(JSON.stringify(commands).includes('permissionExpression'), false, 'the rule itself is not sent');

const base = { status: 'enabled', version: '1', created_at: '2026-11-01T00:00:00Z', transport: { method: 'webhook', callback: 'https://example.test/eventsub' }, cost: 0, channel: 'fjord_recipient', channelID: '422' };
await Eventsubs.create([
    { ...base, id: 'sub-follow', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '422', moderator_user_id: '698614112' }, message: 'Thanks $(user)!' },
    { ...base, id: 'sub-raid-in', type: 'channel.raid', condition: { to_broadcaster_user_id: '422' }, message: '$(raid.channel) raids!', clipEnabled: true, minViewers: 5 },
    { ...base, id: 'sub-raid-out', type: 'channel.raid', condition: { from_broadcaster_user_id: '422' }, message: '' },
    { ...base, id: 'sub-cheer', type: 'channel.cheer', condition: { broadcaster_user_id: '422' }, message: '$(user) cheered', cheerTiers: [{ id: 't1', name: 'a', message: 'm', min_amount: 1, max_amount: 99 }] },
    { ...base, id: 'sub-notify', type: 'channel.chat.notification', condition: { broadcaster_user_id: '422', user_id: '698614112' }, message: '', modiversaryEnabled: false },
]);
const subs = (await json('users/422/eventsubs?limit=50')).data.rows;
const byId = Object.fromEntries(subs.map(s => [s.rawType + ':' + s.type, s]));
assert.ok(byId['channel.raid:channel.raid'], 'incoming raid keeps its type');
assert.ok(byId['channel.raid:channel.raid.outgoing'], 'outgoing raid is named like the standard list');
assert.ok(byId['channel.cheer:channel.bits.use'], 'legacy cheer is named like the standard list');
const raidIn = byId['channel.raid:channel.raid'];
assert.deepEqual([raidIn.settings.clipEnabled, raidIn.settings.minViewers, raidIn.settings.message], [true, 5, '$(raid.channel) raids!']);
assert.equal(byId['channel.cheer:channel.bits.use'].cheerTierCount, 1);
const notify = byId['channel.chat.notification:channel.chat.notification'];
assert.deepEqual([notify.settings.modiversaryEnabled, notify.settings.watchStreakEnabled, notify.settings.message], [false, true, '']);
assert.equal(byId['channel.follow:channel.follow'].message, 'Thanks $(user)!', 'old fields kept');
assert.equal(JSON.stringify(subs).includes('example.test/eventsub'), false, 'no transport details');
console.log('PASS channel lists: command editor fields (keyword, built-in, blocks + tag rule, broken rule) and eventsub normalized types, raw types and chat settings');

console.log('PASS admin console gifts + editing API');
process.exit(0);
