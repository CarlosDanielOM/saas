import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const mongoose = require('mongoose');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { ReferralCodeSchema: Codes } = await import('/app/dist/schemas/referral_code.schema.js');
const { CreditTransactionSchema: Credits, TRANSACTION_TYPES } = await import('/app/dist/schemas/credit_transaction.schema.js');
const { DomainEventDeliverySchema: Deliveries } = await import('/app/dist/schemas/domain_event_delivery.schema.js');
const { journalDomainEvent } = await import('/app/dist/utils/domain_events.js');
const { PRODUCT_IDS } = await import('/app/dist/utils/referral.js');

assert.match(process.env.MONGO_URI, /\/saas_ops_pro_referral_test$/);
const workerPid = Number(readFileSync('/tmp/saas-fixtures/domain-worker-pid', 'utf8'));
assert.ok(workerPid > 0, 'Real domain-event worker must be started by the supervisor');
process.kill(workerPid, 0);

const unitOutput = execFileSync(process.execPath, ['--test',
  '/app/dist/utils/paid_order_reward.test.js',
  '/app/dist/domain_events/polar_billing_events.test.js',
  '/app/dist/utils/referral_stats.test.js',
], { encoding: 'utf8', timeout: 30000 });
console.log(unitOutput.slice(unitOutput.lastIndexOf('ℹ tests')));

await mongoose.connect(process.env.MONGO_URI);
try {
  await Promise.all([Credits.init(), Codes.init(), Deliveries.init()]);
  const referrer = await Users.create({ name: 'historical-referrer', accounts: [], token_balance: 125 });
  const payer = await Users.create({ name: 'test-payer', accounts: [],
    referrerId: referrer._id, referralCodeUsed: 'referraltest', polar_sh_customer_id: 'test-customer' });
  await Codes.create({ owner: referrer._id, code: 'referraltest', label: 'Test', active: true });
  const historical = await Credits.create({ user: referrer._id, type: TRANSACTION_TYPES.SUBSCRIPTION_REWARD,
    amount: 125, balanceAfter: 125, appliedAt: new Date(), idempotencyKey: 'polar:paid-order:historical',
    metadata: { subscriptionId: 'historical', planId: PRODUCT_IDS.PRO, rewardTargetType: 'referrer' } });
  await Users.updateOne({ _id: referrer._id }, { $addToSet: { applied_credit_transaction_ids: historical._id } });

  async function deliver(orderId, productId, cadence, deliveryId = orderId, extraPayload = {}) {
    const payload = { customerId: 'test-customer', orderId, subscriptionId: `subscription-${orderId}`,
      productId, cadence, paid: true, status: 'paid', totalAmount: 1000, ...extraPayload };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const { event } = await journalDomainEvent({ source: 'polar-webhook', sourceEventId: deliveryId,
      type: 'billing.order.paid', topic: 'domain', ownerUserId: payer._id.toString(),
      subject: { provider: 'polar', kind: 'customer', id: 'test-customer' }, occurredAt: new Date(),
      metadata: { originalEventType: 'order.paid' },
      payload });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const row = await Deliveries.findOne({ consumer: 'polar-rewards-v1', eventKey: event.eventKey }).lean();
      assert.notEqual(row?.status, 'dead', row?.lastError);
      if (row?.status === 'succeeded') return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Reward worker did not complete ${orderId}`);
  }
  const balance = async () => (await Users.findById(referrer._id).lean()).token_balance;
  await deliver('historical', PRODUCT_IDS.PRO, 'monthly');
  assert.equal(await balance(), 125);
  assert.equal((await Credits.findById(historical._id).lean()).amount, 125);

  let expected = 125;
  for (const [productId, cadence, amount] of [
    [PRODUCT_IDS.PRO, 'monthly', 100], [PRODUCT_IDS.PRO, 'yearly', 1000],
    [PRODUCT_IDS.PREMIUM, 'monthly', 50], [PRODUCT_IDS.PREMIUM, 'yearly', 500],
  ]) {
    const orderId = `${productId}-${cadence}`;
    await deliver(orderId, productId, cadence);
    expected += amount;
    assert.equal(await balance(), expected);
    const receipt = await Credits.findOne({ idempotencyKey: `polar:paid-order:${orderId}` }).lean();
    assert.equal(receipt.amount, amount);
    assert.ok(receipt.appliedAt);
    assert.equal(receipt.metadata.rewardTargetType, 'referrer');
    await deliver(orderId, productId, cadence, `retry-${orderId}`);
    assert.equal(await balance(), expected, 'Duplicate order must not earn another reward');
  }
  await deliver('trial', PRODUCT_IDS.PRO, 'monthly', 'trial', { totalAmount: 0 });
  await deliver('one-time', PRODUCT_IDS.PRO, 'monthly', 'one-time', { subscriptionId: undefined });
  assert.equal(await balance(), expected);
  assert.equal(await Credits.countDocuments(), 5);
  console.log('PASS: real cron reward consumer awards Pro 100/1000, preserves historical 125, keeps Premium 50/500, deduplicates retries, and excludes trials and one-time orders');
} finally {
  await mongoose.disconnect();
}
