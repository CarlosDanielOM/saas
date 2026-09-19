import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';

await getMongoDBConnection('ai-usage-receipts-check');
const redis = await getDragonflyClient('ai-usage-receipts-check');
const base = 'http://127.0.0.1:3000';
const polarCustomer = '11111111-1111-4111-8111-111111111111';

async function seedUser(id, planTier, token) {
  await UsersSchema.create({
    name: `${planTier}-fixture`,
    email: `${planTier}@example.invalid`,
    plan_tier: planTier,
    polar_sh_customer_id: polarCustomer,
    accounts: [{
      type: 'twitch',
      id,
      name: `${planTier}-fixture`,
      email: `${planTier}@example.invalid`,
      actived: true,
      chat_enabled: true,
      has_permissions: true,
      up_to_date_permissions: true
    }]
  });
  await redis.hSet(`token:${token}`, {
    id,
    login: `${planTier}-fixture`,
    display_name: `${planTier} Fixture`,
    profile_image_url: ''
  });
  await redis.set(`twitch:${id}:ai:credits`, JSON.stringify({
    version: 3,
    used: 255,
    limit: planTier === 'pro' ? 500000 : planTier === 'premium' ? 125000 : 25000,
    balance: planTier === 'pro' ? 499745 : planTier === 'premium' ? 124745 : 24745,
    meterId: '5103e79b-fd74-4ba8-a287-f95574f9addf',
    updatedAt: '2026-09-19T12:00:00.000Z',
    available: true,
    status: 'available'
  }), { EX: 300 });
}

await seedUser('pro-channel', 'pro', 'pro-token');
await seedUser('premium-channel', 'premium', 'premium-token');
await seedUser('free-channel', 'free', 'free-token');

async function get(path, token) {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await response.json();
  return { response, json };
}

const query = 'from=2026-09-18&to=2026-09-19&timezone=UTC';
const proSummary = await get(`/billing/ai-usage/summary?${query}`, 'pro-token');
assert.equal(proSummary.response.status, 200);
assert.equal(proSummary.json.data.planTier, 'pro');
assert.equal(proSummary.json.data.capabilities.transactions, true);
assert.equal(proSummary.json.data.analytics.totalSpentCredits, 255);
assert.equal(proSummary.json.data.analytics.averageDailySpentCredits, 127.5);
assert.equal(proSummary.json.data.analytics.grantedCredits, 1000);
assert.equal(proSummary.json.data.analytics.transactionCount, 4);
assert.deepEqual(proSummary.json.data.analytics.daily, [
  { date: '2026-09-18', credits: 75, transactionCount: 2 },
  { date: '2026-09-19', credits: 180, transactionCount: 2 }
]);
assert.deepEqual(
  proSummary.json.data.analytics.categories.map(category => [category.category, category.credits]),
  [['tts', 180], ['ai_chat', 50], ['uncategorized', 25]]
);

const subscriptionSummary = await get('/billing/ai-usage/summary?timezone=UTC', 'pro-token');
assert.equal(subscriptionSummary.response.status, 200);
assert.equal(subscriptionSummary.json.data.analytics.billingPeriod.source, 'subscription');
assert.equal(subscriptionSummary.json.data.analytics.billingPeriod.startsAt, '2026-09-07T00:00:00.000Z');
assert.equal(subscriptionSummary.json.data.analytics.billingPeriod.endsAt, '2026-10-07T00:00:00.000Z');
assert.equal(subscriptionSummary.json.data.analytics.billingPeriod.endExclusive, true);
assert.equal(subscriptionSummary.json.data.analytics.totalSpentCredits, 255);
assert.equal(subscriptionSummary.json.data.analytics.pacing.status, 'within_pace');
assert.equal(subscriptionSummary.json.data.analytics.pacing.expectedToExhaustWithinPeriod, false);
assert.ok(subscriptionSummary.json.data.analytics.pacing.averageDailyCredits > 0);
assert.equal(subscriptionSummary.json.data.analytics.pacing.estimatedDaysUntilExhaustion, null);
assert.equal(subscriptionSummary.json.data.analytics.pacing.estimatedExhaustionAt, null);

const firstPage = await get(`/billing/ai-usage/transactions?${query}&category=tts&limit=1`, 'pro-token');
assert.equal(firstPage.response.status, 200);
assert.equal(firstPage.json.data.items.length, 1);
assert.equal(firstPage.json.data.items[0].id, 'entry-tts-2');
assert.ok(firstPage.json.data.nextCursor);
assert.equal('text' in firstPage.json.data.items[0], false);
assert.equal('prompt' in firstPage.json.data.items[0], false);
assert.equal('message' in firstPage.json.data.items[0], false);

const secondPage = await get(
  `/billing/ai-usage/transactions?${query}&category=tts&limit=1&cursor=${encodeURIComponent(firstPage.json.data.nextCursor)}`,
  'pro-token'
);
assert.equal(secondPage.response.status, 200);
assert.equal(secondPage.json.data.items[0].id, 'entry-tts-1');
assert.equal(secondPage.json.data.nextCursor, null);

const premiumSummary = await get(`/billing/ai-usage/summary?${query}`, 'premium-token');
assert.equal(premiumSummary.response.status, 200);
assert.equal(premiumSummary.json.data.capabilities.dailySpend, true);
assert.equal(premiumSummary.json.data.capabilities.transactions, false);
assert.equal(premiumSummary.json.data.analytics.totalSpentCredits, 255);

const premiumTransactions = await get(`/billing/ai-usage/transactions?${query}`, 'premium-token');
assert.equal(premiumTransactions.response.status, 403);
assert.equal(premiumTransactions.json.type, 'plan_required');

const freeSummary = await get(`/billing/ai-usage/summary?${query}`, 'free-token');
assert.equal(freeSummary.response.status, 200);
assert.equal(freeSummary.json.data.capabilities.dailySpend, false);
assert.equal(freeSummary.json.data.analytics, null);
assert.equal(freeSummary.json.data.credits.used, 255);

const invalidTimezone = await get('/billing/ai-usage/summary?timezone=Mars%2FOlympus', 'premium-token');
assert.equal(invalidTimezone.response.status, 400);

const crossChannel = await get(`/billing/ai-usage/summary?channelID=pro-channel&${query}`, 'premium-token');
assert.equal(crossChannel.response.status, 403);

console.log('AI usage receipt summary, tier gates, isolation, and Pro pagination passed');
process.exit(0);
