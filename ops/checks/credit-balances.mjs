/** Actual candidate runtime with private Mongo/Redis and mocked Polar.
 * Verify cache refresh, durable TTS debits, webhook reconciliation and exhaustion.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { AI_CREDITS_CACHE_SCHEMA_VERSION as version, AI_CREDITS_METER_ID as meterId, getAiCredits } from '/app/dist/utils/billing.js';
import { trackTtsUsage } from '/app/dist/utils/tts_usage.js';
import { applyPolarCreditsDomainEvent } from '/app/dist/domain_events/polar_billing_events.js';

const mongo = await getMongoDBConnection('credit-balance-check');
const redis = await getDragonflyClient('credit-balance-check');
const channelID = 'credit-balance-test';
const key = `twitch:${channelID}:ai:credits`;
const customerId = '11111111-1111-4111-8111-111111111111';
const user = await Users.create({ name: 'credit-fixture', plan_tier: 'free', polar_sh_customer_id: customerId,
  accounts: [{ type: 'twitch', id: channelID, name: 'credit-fixture' }] });
const state = (meter) => writeFileSync('/tmp/saas-fixtures/credit-balance-state.json', JSON.stringify({
  active_meters: [{ meter_id: meterId, ...meter }], active_subscriptions: [],
}));
const freeMeter = balance => ({ consumed_units: -balance, credited_units: 0, balance });

try {
  state(freeMeter(16_362));
  // The schema bump repairs previously inflated projections without live cache deletion.
  await redis.set(key, JSON.stringify({ version: 3, used: 0, limit: 25_000, balance: 25_000,
    available: true, status: 'available' }), { EX: 300 });
  let credits = await getAiCredits(user, channelID);
  assert.equal(credits.version, version);
  assert.equal(credits.balance, 16_362);
  assert.equal(credits.used, 8_638);

  const usage = { channelID, streamer: user, provider: 'fish', characters: 10, text: '0123456789',
    usage: { entryId: 'credit-balance-tts', source: 'behavior-check' } };
  await trackTtsUsage(usage);
  credits = await getAiCredits(user, channelID);
  assert.equal(credits.balance, 16_347, 'TTS consumes the actual funded balance');
  await trackTtsUsage(usage);
  assert.equal((await getAiCredits(user, channelID)).balance, 16_347, 'Retry cannot debit twice');

  const occurredAt = new Date();
  await applyPolarCreditsDomainEvent({
    source: 'polar-webhook', type: 'billing.customer.state.changed', ownerUserId: user._id.toString(),
    occurredAt, eventKey: 'polar-webhook:credit-balance-check', payload: {
      customerId, meters: [{ meter_id: meterId, ...freeMeter(16_347) }],
    },
  });
  assert.equal(JSON.parse(await redis.get(key)).balance, 16_347, 'Webhook cannot restore spent credits');
  state(freeMeter(16_347));
  await redis.del(key);
  assert.equal((await getAiCredits(user, channelID)).balance, 16_347, 'Cache expiry cannot restore spent credits');

  for (const balance of [1, 0, -2]) {
    state(freeMeter(balance));
    await redis.del(key);
    credits = await getAiCredits(user, channelID);
    assert.equal(credits.balance, balance);
    assert.equal(credits.status, balance <= 0 ? 'exhausted' : 'available');
    assert.equal(await redis.exists(`twitch:${channelID}:ai:exhaust`), balance <= 0 ? 1 : 0);
    assert.equal(await redis.exists(`${channelID}:ai:exhaust`), balance <= 0 ? 1 : 0);
  }
  state({ consumed_units: 199_999, credited_units: 200_000, balance: 1 });
  await redis.del(key);
  credits = await getAiCredits({ ...user.toObject(), plan_tier: 'pro' }, channelID);
  assert.equal(credits.balance, 1, 'Local plan cannot add unfunded credits to a paid meter');
  assert.equal(credits.limit, 200_000);
  state({ consumed_units: 18_912, credited_units: 800_000, balance: 781_088 });
  await redis.del(key);
  assert.equal((await getAiCredits({ ...user.toObject(), plan_tier: 'pro' }, channelID)).balance, 781_088);
  console.log('PASS: real funded balances survive cache refresh, TTS/retry, webhooks and exhaustion; historical grants reconcile');
} finally {
  await redis.quit();
  await mongo.disconnect();
}
