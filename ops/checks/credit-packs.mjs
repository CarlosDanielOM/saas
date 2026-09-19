import assert from 'node:assert/strict';
import fs from 'node:fs';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';

const base = 'http://127.0.0.1:3000';
const callsPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const sampleId = '45c32959-3fa2-41a6-855c-bbeafcf9ce3c';
const rechargeId = '44d391d1-8952-408d-ad51-06200404d3ad';

const account = id => [{
  type: 'twitch', id, name: id, email: `${id}@example.invalid`, actived: true,
  chat_enabled: true, has_permissions: true, up_to_date_permissions: true,
}];

await getMongoDBConnection('credit-packs-check');
const redis = await getDragonflyClient('credit-packs-check');
await UsersSchema.deleteMany({});
await redis.flushDb();
fs.writeFileSync(callsPath, '');

await UsersSchema.create({
  name: 'pack-free', email: 'pack-free@example.invalid', plan_tier: 'free',
  polar_sh_customer_id: '11111111-1111-4111-8111-111111111111', accounts: account('pack-free'),
});
await UsersSchema.create({
  name: 'pack-paid', email: 'pack-paid@example.invalid', plan_tier: 'premium',
  polar_sh_customer_id: '22222222-2222-4222-8222-222222222222', accounts: account('pack-paid'),
});
await redis.hSet('token:pack-free-token', { id: 'pack-free', login: 'pack-free', display_name: 'Pack Free' });
await redis.hSet('token:pack-paid-token', { id: 'pack-paid', login: 'pack-paid', display_name: 'Pack Paid' });

const request = (token, path, method = 'GET', body) => fetch(`${base}${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const freeCatalogResponse = await request('pack-free-token', '/billing/credit-packs');
const freeCatalog = await freeCatalogResponse.json();
assert.equal(freeCatalogResponse.status, 200, JSON.stringify(freeCatalog));
assert.equal(freeCatalog.data.offers.length, 6);
assert.equal(freeCatalog.data.hasActivePaidSubscription, false);
assert.ok(freeCatalog.data.offers.filter(offer => offer.kind === 'credits').every(offer => offer.eligible && offer.rollover));
assert.ok(freeCatalog.data.offers.filter(offer => offer.kind === 'recharge').every(offer => !offer.eligible && !offer.rollover));

const invalid = await request('pack-free-token', '/billing/credit-packs/checkout', 'POST', { productId: 'not-allowlisted' });
assert.equal(invalid.status, 400);
const locked = await request('pack-free-token', '/billing/credit-packs/checkout', 'POST', { productId: rechargeId });
assert.equal(locked.status, 403);

const sampleCheckout = await request('pack-free-token', '/billing/credit-packs/checkout', 'POST', {
  productId: sampleId,
  successUrl: 'https://domdimabot.com/pack-free/credits?credits=success',
  returnUrl: 'https://domdimabot.com/pack-free/credits',
});
const sampleBody = await sampleCheckout.json();
assert.equal(sampleCheckout.status, 201, JSON.stringify(sampleBody));
assert.equal(sampleBody.data.offer.credits, 40_000);
assert.equal(sampleBody.data.offer.rollover, true);

const paidCatalogResponse = await request('pack-paid-token', '/billing/credit-packs');
const paidCatalog = await paidCatalogResponse.json();
assert.equal(paidCatalogResponse.status, 200, JSON.stringify(paidCatalog));
assert.equal(paidCatalog.data.planTier, 'premium');
assert.ok(paidCatalog.data.offers.filter(offer => offer.kind === 'recharge').every(offer => offer.eligible));

const rechargeCheckout = await request('pack-paid-token', '/billing/credit-packs/checkout', 'POST', { productId: rechargeId });
const rechargeBody = await rechargeCheckout.json();
assert.equal(rechargeCheckout.status, 201, JSON.stringify(rechargeBody));
assert.equal(rechargeBody.data.offer.rollover, false);

const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const checkouts = calls.filter(call => call.path.replace(/\/$/, '') === '/v1/checkouts');
assert.equal(checkouts.length, 2, 'invalid and locked products must not create Polar checkouts');
assert.deepEqual(checkouts[0].body.products, [sampleId]);
assert.equal(checkouts[0].body.metadata.pack_type, 'credits');
assert.deepEqual(checkouts[1].body.products, [rechargeId]);
assert.equal(checkouts[1].body.metadata.pack_type, 'recharge');
assert.equal(checkouts[1].body.allow_discount_codes, false);

redis.destroy();
console.log('PASS credit pack catalog, rollover distinction, paid recharge gate, allowlist, and Polar checkout payload');
process.exit(0);
