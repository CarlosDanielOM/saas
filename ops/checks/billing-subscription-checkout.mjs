import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = process.env.SAAS_BILLING_FIXTURES || '/tmp/saas-fixtures';
const { createBillingCheckout, getBillingContext } = await import(process.env.SAAS_BILLING_MODULE || '/app/dist/utils/billing.js');
const { PRODUCT_IDS } = await import(process.env.SAAS_REFERRAL_MODULE || '/app/dist/utils/referral.js');
const customerId = '22222222-2222-4222-8222-222222222222';
const user = {
  _id: '0123456789abcdef01234567', name: 'billing-fixture', email: 'fixture@example.invalid',
  plan_tier: 'premium', polar_sh_customer_id: customerId, accounts: [],
};
const premium = { id: 'premium-subscription', status: 'active', product_id: PRODUCT_IDS.PREMIUM };
const pro = { id: 'pro-subscription', status: 'active', product_id: PRODUCT_IDS.PRO };
const free = { id: 'free-subscription', status: 'active', product_id: PRODUCT_IDS.FREE };
const reset = (active, extra = {}) => {
  fs.writeFileSync(`${dir}/state.json`, JSON.stringify({ active, ...extra }));
  fs.writeFileSync(`${dir}/calls.jsonl`, '');
};
const calls = () => fs.readFileSync(`${dir}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const request = { user, targetPlan: 'pro', returnUrl: 'https://domdimabot.com/fixture/profile' };
const assertNoCheckout = () => assert.equal(calls().filter(c => c.path === '/v1/checkouts').length, 0);

for (const action of ['auto', 'new', 'upgrade', 'change', 'reactivate']) {
  // An old free subscription or unrelated product must not hide the existing Premium subscription.
  reset([free, { id: 'other', product_id: 'unrelated-product' }, premium]);
  const context = await getBillingContext(user, 'pro', action);
  assert.equal(context.activeSubscriptionId, premium.id);
  assert.equal(context.planTier, 'premium');
  assert.equal(context.scenario, 'upgrade', `active subscription must override action=${action}`);
  const result = await createBillingCheckout({ ...request, action });
  assert.equal(result.flow, 'customer_portal');
  assert.equal(result.checkoutId, null);
  assert.equal(result.portalSessionId, 'portal-session-fixture');
  assert.equal(result.allowDiscountCodes, false);
  assert.equal(new URL(result.checkoutUrl).pathname, '/test-org/portal');
  assertNoCheckout();
  assert.deepEqual(calls().find(c => c.path === '/v1/customer-sessions').body, {
    customer_id: customerId, return_url: request.returnUrl,
  });
}
console.log('PASS paid upgrades use the existing customer portal; explicit actions cannot force a new purchase');

reset([pro]);
assert.equal((await createBillingCheckout({ ...request, targetPlan: 'premium' })).flow, 'customer_portal');
assertNoCheckout();
for (const action of ['auto', 'new', 'upgrade', 'reactivate']) {
  reset([premium]);
  await assert.rejects(createBillingCheckout({ ...request, targetPlan: 'premium', action }), /already subscribed/);
  assertNoCheckout();
}
console.log('PASS paid changes route to the portal and same-plan purchases are rejected');

for (const extra of [{ subscriptionStatus: 503 }, { portalStatus: 503 }, { portalStatus: 422 }]) {
  reset([premium], extra);
  await assert.rejects(createBillingCheckout(request));
  assertNoCheckout();
}
console.log('PASS provider failures never fall back to creating a second subscription');

reset([]);
const fresh = await createBillingCheckout({ ...request, user: { ...user, plan_tier: 'free' } });
assert.equal(fresh.flow, 'checkout');
assert.equal(fresh.scenario, 'new');
assert.equal(fresh.checkoutId, 'new-checkout-fixture');
assert.deepEqual(calls().find(c => c.path === '/v1/checkouts').body.products, [PRODUCT_IDS.PRO]);
assert.equal(calls().some(c => c.path === '/v1/customer-sessions'), false);

reset([free]);
const fromFree = await createBillingCheckout(request);
assert.equal(fromFree.flow, 'checkout');
assert.equal(calls().find(c => c.path === '/v1/checkouts').body.subscription_id, free.id);

reset([], { rejectCustomer: true });
assert.equal((await createBillingCheckout(request)).checkoutId, 'new-checkout-fixture');
const retries = calls().filter(c => c.path === '/v1/checkouts');
assert.equal(retries.length, 2);
assert.equal(retries[0].body.customer_id, customerId);
assert.equal('customer_id' in retries[1].body, false);
console.log('PASS new purchases, free subscription upgrades, and new-customer retry remain supported');

if (process.env.SAAS_TARGET === 'api') {
  const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
  const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
  const { default: Users } = await import('/app/dist/schemas/users.schema.js');
  await getMongoDBConnection('billing-subscription-check');
  const redis = await getDragonflyClient('billing-subscription-check');
  await Users.create({ ...user, accounts: [{ type: 'twitch', id: 'billing-fixture', name: 'billing-fixture' }] });
  await redis.hSet('token:billing-fixture-token', { id: 'billing-fixture', login: 'billing-fixture', display_name: 'Fixture' });
  const api = (body, token = 'billing-fixture-token') => fetch('http://127.0.0.1:3000/billing/checkout', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  reset([free, premium]);
  const response = await api({ targetPlan: 'pro', action: 'new', returnUrl: request.returnUrl });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.data.flow, 'customer_portal');
  assert.equal(data.data.checkoutId, null);
  assert.equal(data.data.portalSessionId, 'portal-session-fixture');
  assert.equal(data.data.scenario, 'upgrade');
  assertNoCheckout();
  reset([premium], { portalStatus: 503 });
  assert.equal((await api({ targetPlan: 'pro' })).status, 500);
  assertNoCheckout();
  reset([premium]);
  assert.equal((await api({ targetPlan: 'premium', action: 'new' })).status, 400);
  assert.equal((await api({ targetPlan: 'pro' }, 'invalid')).status, 401);
  assertNoCheckout();
  console.log('PASS authenticated HTTP upgrade response, provider failure, same-plan rejection, and auth enforcement');
  redis.destroy();
}
process.exit(0);
