import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { CreditGiftSchema as Gifts } from '/app/dist/schemas/credit_gift.schema.js';
import { createCreditGiftCheckout, processCreditGift, acceptCreditGiftPaidOrder, getCreditGift, validateGiftOrder } from '/app/dist/utils/credit_gifts.js';
import { GIFT_PACK_PAIRS, validateGiftPair, giftPolarRequest } from '/app/dist/utils/credit_gift_provider.js';
import { applyCreditGiftDomainEvent } from '/app/dist/domain_events/credit_gift_events.js';
import { DOMAIN_EVENT_CONSUMERS } from '/app/dist/domain_events/domain_event_consumers.js';
import { ingestDomainEvent } from '/app/dist/domain_events/domain_event_producers.js';
import { polarWebhookProducer } from '/app/dist/domain_events/polar_events.js';
import { DomainEventDeliverySchema as Deliveries } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { products } from '/tmp/saas-fixtures/providers.mjs';
await getMongoDBConnection('gift-check');
const redis = await getDragonflyClient('gift-check');
await Gifts.init();
const dir = '/tmp/saas-fixtures', statePath = `${dir}/polar.json`, callsPath = `${dir}/calls.jsonl`;
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const modify = fn => { const state = read(); fn(state); fs.writeFileSync(statePath, JSON.stringify(state)); };
const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(100); } throw new Error(label); }
const buyerCustomer = '11111111-1111-4111-8111-111111111111', recipientCustomer = '22222222-2222-4222-8222-222222222222';
const users = [];
for (const [login, channel, customer] of [['giftbuyer', '111', buyerCustomer], ['giftrecipient', '222', recipientCustomer], ['unrelated', '333', '33333333-3333-4333-8333-333333333333']]) {
    const user = await Users.create({ name: login, email: `${login}@example.invalid`, plan_tier: 'free', polar_sh_customer_id: customer,
        accounts: [{ type: 'twitch', id: channel, name: login, actived: false, chat_enabled: false, has_permissions: false }] });
    users.push(user);
    modify(s => { s.customers[customer] = { id: customer, external_id: user._id.toString(), deleted_at: null }; });
    await redis.hSet(`token:${login}`, { id: channel, login, display_name: login });
}
const [buyer, recipient, unrelated] = users;
await redis.set('app:twitch:token', 'dummy-app-token');
const request = (token, path, body) => fetch(`http://127.0.0.1:3000/billing${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const giftRequest = () => ({ user: buyer, productId: GIFT_PACK_PAIRS[0].productId, recipientId: recipient._id.toString(), requestId: randomUUID(),
    acknowledgeNoRefunds: true, successUrl: 'https://domdimabot.com/giftbuyer/credits?gift=return', returnUrl: 'https://domdimabot.com/giftbuyer/credits' });
const advance = async id => { await Gifts.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(0) } }); await processCreditGift(); };
const pay = checkoutId => {
    const id = randomUUID();
    modify(s => { const c = s.checkouts[checkoutId]; c.status = 'succeeded'; s.orders[id] = {
        id, paid: true, status: 'paid', product_id: c.product_id, checkout_id: c.id, customer_id: c.customer_id,
        customer: s.customers[c.customer_id], net_amount: 100, total_amount: 108, refunded_amount: 0, discount_amount: 0,
        currency: 'usd', subscription_id: null, metadata: c.metadata,
    }; });
    return id;
};
assert.equal(validateGiftPair(...products).offer.credits, 40000);
for (const mutate of [p => p[0].benefits.push(p[1].benefits[0]), p => p[1].prices[0].price_amount = 100,
    p => p[1].benefits[0].properties.rollover = false, p => p[1].benefits[0].properties.units = 123]) {
    const p = structuredClone(products); mutate(p); assert.throws(() => validateGiftPair(...p));
}
assert.ok(DOMAIN_EVENT_CONSUMERS.find(c => c.consumer === 'polar-gifts-v1' && c.adminReplay));
console.log('PASS configuration: paid product has no benefit; free counterpart matches exact permanent meter credits');
if (process.env.SAAS_TARGET === 'api') {
    const catalog = await (await request('giftbuyer', '/gift-packs')).json();
    assert.equal(catalog.data.offers.length, 1); assert.equal(catalog.data.offers[0].priceAmount, 100);
    assert.equal(catalog.data.offers[0].id, GIFT_PACK_PAIRS[0].productId);
    assert.equal(JSON.stringify(catalog).includes(GIFT_PACK_PAIRS[0].fulfillmentProductId), false);
    assert.equal((await request('invalid', '/gift-packs')).status, 401);
    const found = await (await request('giftbuyer', '/gift-packs/recipient?login=%40GIFTRECIPIENT')).json();
    assert.equal(found.data.id, recipient._id.toString()); assert.equal(found.data.login, 'giftrecipient');
    assert.equal('email' in found.data, false);
    assert.equal((await request('giftbuyer', '/gift-packs/recipient?login=unknownchannel')).status, 404);
    assert.equal((await request('giftbuyer', '/gift-packs/recipient?login=.*')).status, 400);
    for (const override of [{ acknowledgeNoRefunds: false }, { productId: GIFT_PACK_PAIRS[0].fulfillmentProductId },
        { recipientId: buyer._id.toString() }, { recipientId: 'not-an-id' }, { successUrl: 'https://evil.test/path' },
        { requestId: 'x' }, { returnUrl: 'http://domdimabot.com' }]) {
        const body = { ...giftRequest(), ...override }; delete body.user;
        assert.equal((await request('giftbuyer', '/gift-packs/checkout', body)).status, 400);
    }
    const body = giftRequest(); delete body.user;
    const response = await request('giftbuyer', '/gift-packs/checkout', body), result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    const duplicate = await (await request('giftbuyer', '/gift-packs/checkout', body)).json();
    assert.equal(duplicate.data.checkoutId, result.data.checkoutId);
    assert.equal((await request('giftbuyer', '/gift-packs/checkout', { ...body, recipientId: unrelated._id.toString() })).status, 409);
    assert.equal((await request('unrelated', `/gift-packs/${result.data.giftId}`)).status, 404);
    const status = await (await request('giftbuyer', `/gift-packs/${result.data.giftId}`)).json();
    assert.equal(status.data.status, 'awaiting_payment'); assert.equal(status.data.deliveredAt, null);
    const payload = calls().find(c => c.method === 'POST' && c.body?.metadata?.gift_id === result.data.giftId).body;
    assert.equal(payload.customer_id, buyerCustomer); assert.equal(payload.external_customer_id, buyer._id.toString());
    assert.equal(new URL(payload.success_url).searchParams.get('gift_id'), result.data.giftId);
    assert.equal(payload.allow_discount_codes, false);
    assert.equal(read().grants.length, 0); assert.equal(calls().filter(c => c.chat).length, 0);
    // Keep this unpaid gift out of the stage-by-stage checks below.
    await Gifts.updateOne({ _id: result.data.giftId }, { $set: { nextAttemptAt: new Date(Date.now() + 86400000) } });
    console.log('PASS API: authenticated exact lookup, no private data/free product exposure, confirmation, pinned recipient, retry identity, authorized status');
}
// Model an HTTP response lost after the paid checkout was created. Same request recovers it once.
const lostRequest = giftRequest(); modify(s => s.controls.losePurchaseResponse = true);
await assert.rejects(createCreditGiftCheckout(lostRequest), /interrupted/);
const recovered = await createCreditGiftCheckout(lostRequest);
assert.equal(calls().filter(c => c.method === 'POST' && c.body?.metadata?.gift_id === recovered.giftId).length, 1);
const paidId = pay(recovered.checkoutId);
const stored = await Gifts.findById(recovered.giftId).lean();
const goodOrder = read().orders[paidId];
for (const change of [{ paid: false }, { total_amount: 0 }, { refunded_amount: 100 }, { product_id: GIFT_PACK_PAIRS[0].fulfillmentProductId },
    { customer_id: recipientCustomer }, { checkout_id: randomUUID() }, { currency: 'eur' }, { discount_amount: 100 }, { subscription_id: randomUUID() }]) {
    assert.throws(() => validateGiftOrder({ ...goodOrder, ...change }, stored, buyer, false));
}
await acceptCreditGiftPaidOrder(paidId); await acceptCreditGiftPaidOrder(paidId);
assert.equal((await getCreditGift(recovered.giftId, buyer)).status, 'payment_received');
if (process.env.SAAS_TARGET === 'cron') {
    const journal = await ingestDomainEvent(polarWebhookProducer, { webhookId: 'gift-signed-receipt', event: {
        type: 'order.paid', timestamp: new Date(), data: { id: paidId, customerId: buyerCustomer,
            customer: { id: buyerCustomer, externalId: buyer._id.toString() }, status: 'paid', paid: true, totalAmount: 108,
            productId: GIFT_PACK_PAIRS[0].productId },
    } });
    await until(async () => (await Deliveries.findOne({ eventKey: journal.event.eventKey, consumer: 'polar-gifts-v1' }).lean())?.status === 'succeeded',
        'new gift consumer dispatches the journaled paid event');
}
modify(s => { s.controls.holdGrant = true; s.controls.loseFulfillResponse = true; });
if (process.env.SAAS_TARGET === 'cron') {
    await until(() => calls().some(c => c.workerReady), 'actual supervised gift worker startup');
    await Gifts.updateOne({ _id: recovered.giftId }, { $set: { nextAttemptAt: new Date(0) } });
    await until(() => read().grants.length > 0, 'actual worker completes known free checkout after response loss');
} else {
    await advance(recovered.giftId); // POST result lost; reservation persists.
    await advance(recovered.giftId); // Recovery returns that same checkout.
    modify(s => s.controls.loseConfirmResponse = true);
    await advance(recovered.giftId); // Confirmation response lost, checkout already succeeded.
    await advance(recovered.giftId); // No duplicate confirmation/order; grant still pending.
}
assert.equal((await getCreditGift(recovered.giftId, buyer)).status, 'delivering');
assert.equal(calls().filter(c => c.chat).length, 0, 'no chat until native benefit credited');
const freeCreates = calls().filter(c => c.method === 'POST' && c.body?.metadata?.source === 'dimabot_gift_fulfillment');
assert.equal(freeCreates.length, 1);
assert.equal(freeCreates[0].body.customer_id, recipientCustomer); assert.equal(freeCreates[0].body.external_customer_id, recipient._id.toString());
assert.equal(freeCreates[0].body.metadata.parent_order_id, paidId);
modify(s => { s.grants[0].is_granted = true; delete s.controls.holdGrant; });
if (process.env.SAAS_TARGET === 'cron') {
    await until(async () => (await Gifts.findById(recovered.giftId).lean()).announcedAt, 'actual worker confirms credits and sends offline chat');
} else { await advance(recovered.giftId); await advance(recovered.giftId); }
const delivered = await Gifts.findById(recovered.giftId).lean();
assert.equal(delivered.status, 'delivered'); assert.ok(delivered.grantId && delivered.announcedAt);
assert.equal(read().grants.length, 1); assert.equal(read().grants[0].customer_id, recipientCustomer);
assert.equal(calls().filter(c => c.chat).length, 1);
assert.equal(calls().find(c => c.chat).channel, '222'); assert.match(calls().find(c => c.chat).message, /@giftbuyer.*40,000.*@giftrecipient/);
assert.equal((await Users.findById(buyer._id)).plan_tier, 'free');
assert.equal((await Users.findById(recipient._id)).plan_tier, 'free');
assert.equal((await Users.findById(recipient._id)).token_balance, 0);
assert.equal(JSON.parse(await redis.get('twitch:222:ai:credits')).balance, 40000);
assert.equal(await redis.exists('twitch:222:ai:exhaust'), 0);
// Duplicate paid events and recursive free order.paid cannot generate another gift.
await acceptCreditGiftPaidOrder(paidId);
const freeOrder = Object.values(read().orders).find(o => o.product_id === GIFT_PACK_PAIRS[0].fulfillmentProductId);
await applyCreditGiftDomainEvent({ source: 'polar-webhook', type: 'billing.order.paid', payload: { productId: freeOrder.product_id, orderId: freeOrder.id, paid: true } });
await advance(recovered.giftId);
assert.equal(read().grants.length, 1); assert.equal(calls().filter(c => c.chat).length, 1);
console.log(`PASS ${process.env.SAAS_TARGET}: $1 buyer order -> one free recipient order -> confirmed 40k native rollover grant -> one offline chat announcement`);
if (process.env.SAAS_TARGET === 'api') {
    // Chat failures retry without refulfilling; moderation holds do not spam.
    const chatGift = { ...delivered, _id: 'a'.repeat(64), announcedAt: undefined, announcementAttempts: 0, nextAttemptAt: new Date(0) };
    delete chatGift.announcementMessageId; delete chatGift.leaseToken; delete chatGift.leaseUntil;
    await Gifts.create(chatGift);
    modify(s => s.controls.chatFail = true);
    await advance(chatGift._id);
    assert.equal((await Gifts.findById(chatGift._id)).status, 'delivered');
    assert.equal(read().grants.length, 1);
    modify(s => { delete s.controls.chatFail; s.controls.chatHeld = true; });
    await advance(chatGift._id); await advance(chatGift._id);
    assert.ok((await Gifts.findById(chatGift._id)).announcementStoppedAt);
    assert.equal(calls().filter(c => c.chat).length, 3);
    modify(s => delete s.controls.chatHeld);
    // Two concurrent stage claims only issue one benefit-bearing create.
    const concurrent = await createCreditGiftCheckout(giftRequest()); pay(concurrent.checkoutId);
    await advance(concurrent.giftId);
    await Gifts.updateOne({ _id: concurrent.giftId }, { $set: { nextAttemptAt: new Date(0) } });
    await Promise.all([processCreditGift(), processCreditGift()]);
    assert.equal(calls().filter(c => c.method === 'POST' && c.body?.metadata?.source === 'dimabot_gift_fulfillment' && c.body.metadata.gift_id === concurrent.giftId).length, 1);
    // Simulate response loss where no checkout is discoverable: repeated retries never create another.
    const uncertain = await createCreditGiftCheckout(giftRequest()); pay(uncertain.checkoutId); await advance(uncertain.giftId);
    await Gifts.updateOne({ _id: concurrent.giftId }, { $set: { nextAttemptAt: new Date(Date.now() + 86400000) } });
    await Gifts.updateOne({ _id: uncertain.giftId }, { $set: { fulfillmentCreateStartedAt: new Date() } });
    const before = calls().filter(c => c.method === 'POST').length;
    for (let i = 0; i < 5; i++) await advance(uncertain.giftId);
    assert.equal(calls().filter(c => c.method === 'POST').length, before);
    assert.equal((await Gifts.findById(uncertain.giftId)).status, 'needs_support');
    // Transport respects sandbox mode and never uses the default production SDK.
    process.env.POLARSH_ENVIRONMENT = 'sandbox'; await giftPolarRequest(`/v1/products/${GIFT_PACK_PAIRS[0].productId}`);
    assert.equal(calls().at(-1).host, 'sandbox-api.polar.sh'); delete process.env.POLARSH_ENVIRONMENT;
    console.log('PASS recovery: lost create/confirm responses, duplicate paid events, free-order recursion, concurrent claims, uncertain creates, failed/held chat and sandbox routing');
}
console.log('PASS isolated credit gifting behavior');
process.exit(0);
