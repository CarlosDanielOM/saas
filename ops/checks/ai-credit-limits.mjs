/**
 * Behavior check: plan AI credit ceilings in the compiled billing module.
 *
 * Verifies the source-of-truth limits (free/premium/pro) and that credit
 * snapshots built from Polar meters use the updated ceilings and reach the
 * exhausted state exactly at the plan limit.
 */
import assert from 'node:assert/strict';

const billing = await import('/app/dist/utils/billing.js');

assert.deepEqual(
  billing.AI_CREDIT_LIMITS,
  { free: 25000, premium: 200000, pro: 800000 },
  'plan credit ceilings must match the updated benefits',
);

assert.equal(billing.getAiCreditLimitForPlan('free'), 25000);
assert.equal(billing.getAiCreditLimitForPlan('premium'), 200000);
assert.equal(billing.getAiCreditLimitForPlan('pro'), 800000);
assert.equal(billing.getAiCreditLimitForPlan(null), 25000);
assert.equal(billing.getAiCreditLimitForPlan('unknown'), 25000);

for (const [tier, limit] of [['premium', 200000], ['pro', 800000]]) {
  const meter = { meter_id: billing.AI_CREDITS_METER_ID, consumed_units: limit, balance: -limit };
  const snapshot = billing.buildAiCreditsDataFromMeter(meter, tier);
  assert.equal(snapshot.limit, limit, `${tier} snapshot limit`);
  assert.equal(snapshot.balance, 0, `${tier} snapshot balance`);
  assert.equal(snapshot.status, 'exhausted', `${tier} snapshot status`);

  const partial = billing.buildAiCreditsDataFromMeter(
    { meter_id: billing.AI_CREDITS_METER_ID, consumed_units: limit - 1, balance: -(limit - 1) },
    tier,
  );
  assert.equal(partial.limit, limit, `${tier} partial limit`);
  assert.equal(partial.balance, 1, `${tier} partial balance`);
  assert.equal(partial.status, 'available', `${tier} partial status`);
}

console.log('PASS plan AI credit limits: free=25000 premium=200000 pro=800000');
