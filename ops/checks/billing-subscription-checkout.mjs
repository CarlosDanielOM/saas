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

const freeUser = { ...user, plan_tier: 'free' };
for (const paid of [premium, pro]) {
  const pastDue = { ...paid, status: 'past_due', ended_at: null };
  for (const targetPlan of ['premium', 'pro']) {
    for (const action of ['auto', 'new', 'upgrade', 'change', 'reactivate']) {
      reset([], { history: [pastDue] });
      const context = await getBillingContext(freeUser, targetPlan, action);
      assert.equal(context.planTier, 'free');
      assert.equal(context.hasActiveSubscription, false);
      assert.equal(context.scenario, 'reactivate');
      assert.equal(context.recoverySubscriptionId, paid.id);
      const result = await createBillingCheckout({ ...request, user: freeUser, targetPlan, action });
      assert.equal(result.flow, 'customer_portal');
      assert.equal(result.scenario, 'reactivate');
      assertNoCheckout();
    }
  }
  reset([free, { id: 'unrelated', status: 'active', product_id: 'unrelated-product' }], { history: [free, pastDue] });
  assert.equal((await createBillingCheckout({ ...request, user: freeUser })).flow, 'customer_portal');
  assertNoCheckout();
  reset([], { history: [pastDue], portalStatus: 503 });
  await assert.rejects(createBillingCheckout({ ...request, user: freeUser }));
  assertNoCheckout();
}
reset([premium], { history: [premium, { ...pro, status: 'past_due', ended_at: null }] });
assert.equal((await getBillingContext(user, 'pro')).scenario, 'upgrade');
assert.equal((await createBillingCheckout(request)).scenario, 'upgrade');
assertNoCheckout();
console.log('PASS past-due paid subscriptions recover through the portal without granting entitlement');

for (const trial of [false, true]) {
  const pastDueFree = { ...free, status: 'past_due', ended_at: null,
    ...(trial ? { trial_start: '2026-09-12T00:00:00Z', trial_end: '2026-09-26T00:00:00Z' } : {}) };
  for (const action of ['auto', 'new', 'upgrade', 'change', 'reactivate']) {
    reset([], { history: [pastDueFree] });
    const context = await getBillingContext(freeUser, 'premium', action);
    assert.equal(context.planTier, 'free');
    assert.equal(context.hasActiveSubscription, false);
    assert.equal(context.hasPaidSubscriptionHistory, false);
    assert.equal(context.scenario, 'reactivate');
    assert.equal(context.recoverySubscriptionId, free.id);
    assert.equal(context.hasUsedTrial, trial);
    assert.equal((await createBillingCheckout({ ...request, user: freeUser, targetPlan: 'premium', action })).flow, 'customer_portal');
    assertNoCheckout();
  }
  reset([], { history: [pastDueFree], portalStatus: 503 });
  await assert.rejects(createBillingCheckout({ ...request, user: freeUser }));
  assertNoCheckout();
}
reset([premium], { history: [premium, { ...free, status: 'past_due', ended_at: null }] });
assert.equal((await createBillingCheckout(request)).scenario, 'upgrade');
assertNoCheckout();
reset([], { history: [{ id: 'other', product_id: 'unrelated-product', status: 'past_due', ended_at: null }] });
assert.equal((await createBillingCheckout({ ...request, user: freeUser })).flow, 'checkout');
console.log('PASS known Free past-due subscriptions recover without changing paid entitlement or history');

for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
  for (const action of ['auto', 'new']) {
    reset([], { history: [{ ...premium, status, ended_at: null }] });
    const result = await createBillingCheckout({ ...request, user: freeUser, action });
    assert.equal(result.flow, 'checkout');
    assert.equal(calls().find(c => c.path === '/v1/checkouts').body.allow_trial, false);
  }
}
reset([], { history: [{ ...premium, status: 'past_due', ended_at: '2026-01-01T00:00:00Z' }] });
assert.equal((await createBillingCheckout({ ...request, user: freeUser })).flow, 'checkout');
assert.equal(calls().find(c => c.path === '/v1/checkouts').body.allow_trial, false);
reset([], { history: [{ ...free, status: 'canceled' }] });
assert.equal((await createBillingCheckout({ ...request, user: freeUser })).flow, 'checkout');
assert.equal('allow_trial' in calls().find(c => c.path === '/v1/checkouts').body, false);
for (const trialField of ['trial_start', 'trial_end']) {
  reset([], { history: [{ ...free, status: 'canceled', [trialField]: '2026-09-12T00:00:00Z' }] });
  const context = await getBillingContext(freeUser, 'premium', 'new');
  assert.equal(context.hasPaidSubscriptionHistory, false);
  assert.equal(context.hasUsedTrial, true);
  assert.equal((await createBillingCheckout({ ...request, user: freeUser, targetPlan: 'premium', action: 'new' })).flow, 'checkout');
  assert.equal(calls().find(c => c.path === '/v1/checkouts').body.allow_trial, false);
}
reset([], { history: [{ ...premium, status: 'canceled' }], rejectCustomer: true });
await createBillingCheckout({ ...request, user: freeUser, action: 'new' });
assert.deepEqual(calls().filter(c => c.path === '/v1/checkouts').map(c => c.body.allow_trial), [false, false]);
console.log('PASS prior paid history disables repeat trials; free-only history preserves product trial');

reset([]);
const fresh = await createBillingCheckout({ ...request, user: { ...user, plan_tier: 'free' } });
assert.equal(fresh.flow, 'checkout');
assert.equal(fresh.scenario, 'new');
assert.equal(fresh.checkoutId, 'new-checkout-fixture');
assert.deepEqual(calls().find(c => c.path === '/v1/checkouts').body.products, [PRODUCT_IDS.PRO]);
assert.equal('allow_trial' in calls().find(c => c.path === '/v1/checkouts').body, false);
assert.equal(calls().some(c => c.path === '/v1/customer-sessions'), false);

reset([]);
assert.equal((await createBillingCheckout({ ...request, user: freeUser, targetPlan: 'premium' })).flow, 'checkout');
assert.equal('allow_trial' in calls().find(c => c.path === '/v1/checkouts').body, false);

reset([free]);
const fromFree = await createBillingCheckout(request);
assert.equal(fromFree.flow, 'checkout');
assert.equal(calls().find(c => c.path === '/v1/checkouts').body.subscription_id, free.id);
reset([free]);
assert.equal((await createBillingCheckout({ ...request, user: freeUser, targetPlan: 'premium' })).flow, 'checkout');
assert.equal('allow_trial' in calls().find(c => c.path === '/v1/checkouts').body, false);

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
  await Users.updateOne({ _id: user._id }, { $set: { plan_tier: 'free' } });
  reset([], { history: [{ ...premium, status: 'past_due', ended_at: null }] });
  const contextResponse = await fetch('http://127.0.0.1:3000/billing/context?targetPlan=premium&action=new', {
    headers: { Authorization: 'Bearer billing-fixture-token' },
  });
  const contextData = await contextResponse.json();
  assert.equal(contextResponse.status, 200, JSON.stringify(contextData));
  assert.equal(contextData.data.planTier, 'free');
  assert.equal(contextData.data.hasActiveSubscription, false);
  assert.equal(contextData.data.scenario, 'reactivate');
  assert.equal(contextData.data.recoverySubscriptionId, premium.id);
  const recoveryResponse = await api({ targetPlan: 'premium', action: 'new' });
  const recoveryData = await recoveryResponse.json();
  assert.equal(recoveryResponse.status, 201, JSON.stringify(recoveryData));
  assert.equal(recoveryData.data.flow, 'customer_portal');
  assert.equal(recoveryData.data.scenario, 'reactivate');
  assertNoCheckout();
  reset([], { history: [{ ...premium, status: 'past_due', ended_at: null }], portalStatus: 503 });
  assert.equal((await api({ targetPlan: 'premium', action: 'new' })).status, 500);
  assertNoCheckout();
  reset([], { history: [{ ...free, status: 'past_due', ended_at: null,
    trial_start: '2026-09-12T00:00:00Z', trial_end: '2026-09-26T00:00:00Z' }] });
  const freeRecovery = await api({ targetPlan: 'premium', action: 'new' });
  const freeRecoveryData = await freeRecovery.json();
  assert.equal(freeRecovery.status, 201, JSON.stringify(freeRecoveryData));
  assert.equal(freeRecoveryData.data.flow, 'customer_portal');
  assert.equal(freeRecoveryData.data.scenario, 'reactivate');
  assertNoCheckout();
  console.log('PASS authenticated HTTP upgrade response, provider failure, same-plan rejection, and auth enforcement');
  redis.destroy();
}
process.exit(0);
