// Bot target: scripts/saas-ops verify bot-<run-id> --dependency mongo --dependency redis \
//   --test-env ops/checks/keywords-fixtures/test-env.json --fixtures ops/checks/keywords-fixtures --check ops/checks/keyword-cooldown-override-bot.mjs
// Keywords obey the plan's minimum cooldown in chat (free: 5 s) even when a lower value is stored, unless the
// owner console set the cooldown (`cooldownOverride`, handlers/commands.handler.ts): then chat uses it as stored,
// 0 included. Runs the real keyword handler of the bot candidate; chat sends land in the fixture's test list.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { createUserIdentity } from '/app/dist/utils/permissions/index.js';
import { handleKeywords } from '/app/dist/handlers/keywords.handler.js';
import { refreshKeywordIndex } from '/app/dist/utils/keyword_cache.js';

await getMongoDBConnection('keyword-override-check');
const redis = await getDragonflyClient('keyword-override-check');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch { /* starting */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'bot runtime started');
await redis.set('app:twitch:token', 'dummy');

const viewer = createUserIdentity(1, []);
const event = text => ({ chatter_user_id: 'viewer', chatter_user_login: 'viewer', chatter_user_name: 'Viewer', message_id: `m-${Math.random()}`, badges: [], message: { text } });
const channel = 'keyword-override-free';
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: 'free', chat_enabled: 'true' });
const keyword = await CommandsSchema.create({ channelID: channel, channel, name: 'Wave', cmd: 'wave', func: 'custom', message: 'wave back',
    cooldown: 0, activation: 'keyword', keywordSettings: { matchMode: 'anywhere' }, userLevel: 1 });
const id = String(keyword._id);
const cooldownKey = `command:execution:cooldown:${channel}:keyword:${id}`;
const sent = async () => redis.lLen('keywords:test:messages');

// Stored 0 without the owner's override: chat still waits the free plan's 5 s.
await refreshKeywordIndex(channel, id);
await handleKeywords(channel, event('wave'), viewer);
assert.ok(await redis.pTTL(cooldownKey) > 4000, 'plan minimum applies to a stored low value');
const before = await sent();
await handleKeywords(channel, event('wave'), viewer);
assert.equal(await sent(), before, 'second wave blocked by the plan minimum');

// The owner set 0: every message runs.
await CommandsSchema.updateOne({ _id: id }, { $set: { cooldownOverride: true } });
await refreshKeywordIndex(channel, id);
await redis.del(cooldownKey);
const start = await sent();
for (let i = 0; i < 3; i++) await handleKeywords(channel, event('wave'), viewer);
assert.equal(await sent(), start + 3, 'no cooldown when the owner set 0: every message answered');
assert.equal(await redis.exists(cooldownKey), 0);

// The owner set 2 s on a free channel (below its 5 s minimum): exactly 2 s.
await CommandsSchema.updateOne({ _id: id }, { $set: { cooldown: 2 } });
await refreshKeywordIndex(channel, id);
await handleKeywords(channel, event('wave'), viewer);
const ttl = await redis.pTTL(cooldownKey);
assert.ok(ttl > 0 && ttl <= 2000, `owner cooldown used as stored (ttl ${ttl} ms)`);

// A site edit clears the override: the plan minimum is back.
await CommandsSchema.updateOne({ _id: id }, { $set: { cooldownOverride: false } });
await refreshKeywordIndex(channel, id);
await redis.del(cooldownKey);
await handleKeywords(channel, event('wave'), viewer);
assert.ok(await redis.pTTL(cooldownKey) > 4000, 'plan minimum back without the override');
console.log('PASS keyword cooldowns: plan minimum without the override, owner-set 0 and 2 s used as stored, minimum back when cleared');
process.exit(0);
