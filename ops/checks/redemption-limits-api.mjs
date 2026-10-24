/**
 * API check: reward limits and pause live only on Twitch.
 * - POST /rewards maps per-stream / per-viewer limits, cooldown and "skip queue: off" to Helix fields
 *   (and never sends is_paused on create); none of them are stored in Mongo.
 * - PATCH isPaused / limits returns Twitch's live copy without touching the DB document.
 * - Turning a limit off sends only the "enabled: false" flag; bot-side price rises still work.
 * - Invalid limits / cooldowns are rejected before Twitch is called; Twitch errors pass through.
 * - Outsiders get 403.
 * Run with --dependency mongo --dependency redis --fixtures ops/checks/redemption-limits-fixtures
 * --test-env ops/checks/redemption-limits-fixtures/test-env.json.
 */
import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';

const mongo = await getMongoDBConnection('redemption-limits-check');
const redis = await getDragonflyClient('redemption-limits-check');
const channelID = '99003101';
const outsiderID = '99003102';
const ownerToken = 'owner-redemption-limits-token';
const outsiderToken = 'outsider-redemption-limits-token';

await redis.hSet(`token:${ownerToken}`, { id: channelID, login: 'limits_owner', display_name: 'limits_owner' });
await redis.hSet(`token:${outsiderToken}`, { id: outsiderID, login: 'limits_outsider', display_name: 'limits_outsider' });
await redis.hSet(`accounts:twitch:${channelID}:data`, {
  id: channelID, name: 'limits_owner', has_permissions: 'true',
  access_token: 'fixture-streamer-token', expires_at: String(Math.floor(Date.now() / 1000) + 86400)
});
await redis.set('app:twitch:token', 'fixture-app-token', { EX: 3600 });
await mongo.connection.db.collection('users').insertMany([
  { accounts: [{ type: 'twitch', id: channelID, name: 'limits_owner', has_permissions: true, actived: true }] },
  { accounts: [{ type: 'twitch', id: outsiderID, name: 'limits_outsider', has_permissions: true, actived: true }] }
]);

const api = async (method, path, body, token = ownerToken) => {
  const res = await fetch(`http://127.0.0.1:3000${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const helixCalls = async () => (await redis.lRange('redemption-limits:helix', 0, -1)).map((raw) => JSON.parse(raw));
const lastHelix = async (method) => (await helixCalls()).filter((c) => c.method === method).at(-1);
const rewardsCol = mongo.connection.db.collection('redemptionrewards');

// 1. Create with limits.
let r = await api('POST', `/rewards/${channelID}`, {
  title: 'Hydrate', cost: 500, prompt: 'Drink water', message: '$(user) hydrated', type: 'custom', isEnabled: true,
  cooldown: 300, maxPerStream: 10, maxPerUserPerStream: 2, skipQueue: false, userInput: false, isPaused: true
});
assert.equal(r.status, 201, JSON.stringify(r.body));
const rewardID = r.body.data.rewardID;
assert.ok(rewardID);
let sent = (await lastHelix('POST')).body;
assert.equal(sent.is_max_per_stream_enabled, true);
assert.equal(sent.max_per_stream, 10);
assert.equal(sent.is_max_per_user_per_stream_enabled, true);
assert.equal(sent.max_per_user_per_stream, 2);
assert.equal(sent.is_global_cooldown_enabled, true);
assert.equal(sent.global_cooldown_seconds, 300);
assert.equal(sent.should_redemptions_skip_request_queue, false, 'skip queue off is sent explicitly');
assert.equal('is_paused' in sent, false, 'Twitch create never gets is_paused');
assert.equal('maxPerStream' in sent, false, 'camelCase fields are translated, not leaked');
let doc = await rewardsCol.findOne({ channelID, rewardID });
assert.ok(doc);
for (const key of ['maxPerStream', 'maxPerUserPerStream', 'isPaused', 'max_per_stream']) {
  assert.equal(key in doc, false, `${key} must not be stored in Mongo`);
}
assert.equal(doc.cooldown, 300);
assert.equal(doc.message, '$(user) hydrated');
console.log('PASS create maps limits to Twitch and stores none of them');

// 2. Pause: Twitch-only, live copy returned, DB untouched.
const before = await rewardsCol.findOne({ channelID, rewardID });
r = await api('PATCH', `/rewards/${channelID}/${rewardID}`, { isPaused: true });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.twitch.is_paused, true);
assert.equal(r.body.data.rewardID, rewardID);
assert.deepEqual((await lastHelix('PATCH')).body, { is_paused: true });
assert.deepEqual(await rewardsCol.findOne({ channelID, rewardID }), before, 'pause leaves the DB document alone');
r = await api('PATCH', `/rewards/${channelID}/${rewardID}`, { isPaused: false });
assert.equal(r.body.twitch.is_paused, false);
console.log('PASS pause/resume goes to Twitch only and returns the live copy');

// 3. Change limits together with a DB field; turning limits off sends only the flag.
r = await api('PATCH', `/rewards/${channelID}/${rewardID}`, {
  title: 'Hydrate now', cost: 600, maxPerStream: 0, maxPerUserPerStream: 3, cooldown: 0, skipQueue: true
});
assert.equal(r.status, 200, JSON.stringify(r.body));
sent = (await lastHelix('PATCH')).body;
assert.equal(sent.is_max_per_stream_enabled, false);
assert.equal('max_per_stream' in sent, false, 'no max value is sent while the limit is off');
assert.equal(sent.max_per_user_per_stream, 3);
assert.equal(sent.is_global_cooldown_enabled, false);
assert.equal(sent.should_redemptions_skip_request_queue, true);
assert.equal(r.body.twitch.max_per_stream_setting.is_enabled, false);
assert.equal(r.body.twitch.max_per_user_per_stream_setting.max_per_user_per_stream, 3);
doc = await rewardsCol.findOne({ channelID, rewardID });
assert.equal(doc.title, 'Hydrate now');
assert.equal(doc.cost, 600);
assert.equal(doc.cooldown, 0);
assert.equal('maxPerUserPerStream' in doc, false);
console.log('PASS limits update alongside DB fields; off = flag only');

// 4. Bot-side price rise body (title/prompt/cost) is unchanged and keeps Twitch limits as they are.
r = await api('PATCH', `/rewards/${channelID}/${rewardID}`, { title: 'Hydrate now', prompt: 'Drink water', cost: 650 });
assert.equal(r.status, 200);
assert.deepEqual((await lastHelix('PATCH')).body, { title: 'Hydrate now', prompt: 'Drink water', cost: 650 });
assert.equal(r.body.twitch.max_per_user_per_stream_setting.is_enabled, true, 'price rise leaves limits alone');
assert.equal((await rewardsCol.findOne({ channelID, rewardID })).cost, 650);
console.log('PASS price-rise path unchanged');

// 5. Validation happens before Twitch is called.
const callsBefore = (await helixCalls()).length;
for (const body of [{ maxPerStream: -1 }, { maxPerUserPerStream: 1.5 }, { maxPerStream: '5' }, { cooldown: 604801 }, { isPaused: 'yes' }]) {
  r = await api('PATCH', `/rewards/${channelID}/${rewardID}`, body);
  assert.equal(r.status, 400, `rejects ${JSON.stringify(body)}`);
  assert.ok(r.body.message && !/^Bad Request$/.test(r.body.message), 'gives a readable reason');
}
r = await api('POST', `/rewards/${channelID}`, { title: 'Too long wait', cost: 10, cooldown: 700000, type: 'custom', isEnabled: true });
assert.equal(r.status, 400);
assert.match(r.body.message, /7 days/);
assert.equal((await helixCalls()).length, callsBefore, 'invalid input never reaches Twitch');
console.log('PASS invalid limits and cooldowns rejected before Twitch');

// 6. Twitch errors pass through with their message (the site maps DUPLICATE_REWARD to plain words).
r = await api('POST', `/rewards/${channelID}`, { title: 'hydrate now', cost: 10, type: 'custom', isEnabled: true });
assert.equal(r.status, 400);
assert.match(r.body.message, /DUPLICATE_REWARD/);
console.log('PASS Twitch duplicate-name error passes through');

// 7. The live list carries the settings the site reads.
r = await api('GET', `/rewards/twitch/${channelID}`);
assert.equal(r.status, 200);
const live = r.body.data.find((item) => item.id === rewardID);
assert.equal(live.max_per_user_per_stream_setting.max_per_user_per_stream, 3);
assert.equal(live.is_in_stock, true);
console.log('PASS live Twitch list returns limit settings');

// 8. Permissions.
r = await api('PATCH', `/rewards/${channelID}/${rewardID}`, { isPaused: true }, outsiderToken);
assert.equal(r.status, 403);
r = await api('PATCH', `/rewards/${channelID}/missing-reward`, { isPaused: true });
assert.equal(r.status, 404);
console.log('PASS outsiders blocked, unknown rewards 404');

process.exit(0);
