// saas-ops only (bot target): disposable Mongo/Redis; stage ops/checks/keywords-fixtures as --fixtures and use its test-env.json.
// A channel-point reward whose message uses &t must treat the viewer's typed input as text: an input of $(add.mod me) is
// sent to chat literally and never runs (no moderator call reaches Twitch).
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { RedemptionRewardSchema } from '/app/dist/schemas/redemption_reward.schema.js';

const secret = process.env.TWITCH_EVENTSUB_SECRET, channel = '990888';
const redis = await getDragonflyClient('redemption-literal-bot-check');
const mongo = await getMongoDBConnection('redemption-literal-bot-check');
await redis.set('app:twitch:token', 'dummy');
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'bot runtime accepts requests and rejects unsigned events');
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'rewardfixture', plan_tier: 'pro', chat_enabled: 'true' });
await mongo.connection.db.collection('users').insertOne({ name: 'Reward Fixture', plan_tier: 'pro', chat_enabled: true, actived: true,
  accounts: [{ type: 'twitch', id: channel, name: 'rewardfixture' }] });
await RedemptionRewardSchema.create({ eventsubID: 'sub-1', channelID: channel, channel: 'rewardfixture', rewardID: 'reward-lit',
  title: 'Say it', type: 'custom', prompt: 'Type something', originalCost: 100, cost: 100, costChange: 0, message: 'You said: &t' });
await redis.del('keywords:test:messages');

const id = randomUUID(), timestamp = new Date().toISOString();
const body = JSON.stringify({ subscription: { id: randomUUID(), type: 'channel.channel_points_custom_reward_redemption.add', version: '1', status: 'enabled',
  condition: { broadcaster_user_id: channel }, transport: { method: 'webhook' }, created_at: timestamp, cost: 0 },
  event: { id: 'redeem-lit', broadcaster_user_id: channel, broadcaster_user_login: 'rewardfixture', broadcaster_user_name: 'RewardFixture',
    user_id: '66', user_login: 'mallory', user_name: 'Mallory', user_input: '$(add.mod me)', status: 'unfulfilled', redeemed_at: timestamp,
    reward: { id: 'reward-lit', title: 'Say it', cost: 100, prompt: 'Type something' } } });
const signature = 'sha256=' + createHmac('sha256', secret).update(id + timestamp + body).digest('hex');
const response = await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', body, headers: { 'Content-Type': 'application/json',
  'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': signature, 'Twitch-Eventsub-Message-Type': 'notification' } });
assert.ok(response.status < 300, `redemption accepted (${response.status})`);

let sent = [];
for (let i = 0; i < 100 && !sent.length; i++) {
  sent = (await redis.lRange('keywords:test:messages', 0, -1)).map(item => JSON.parse(item));
  if (!sent.length) await new Promise(resolve => setTimeout(resolve, 100));
}
assert.ok(sent.length, 'the reward message reached chat');
assert.equal(sent[0].message, 'You said: $(add.mod me)', 'the viewer input is shown as text, never run');
assert.ok(!sent.some(item => /mallory/i.test(item.message) && /mod/i.test(item.message) && !item.message.includes('$(')), 'no moderator action reply');
console.log('PASS reward input is literal: &t shows $(add.mod me) as text; nothing ran.');
await mongo.disconnect();
await redis.quit();
process.exit(0);
