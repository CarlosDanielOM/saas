// Bot-side check for "bot in chat without full access" (2026-11-10). Runs inside the `bot`
// candidate with disposable Mongo/Redis and ops/checks/moderation-fixtures (mocked Twitch/AI).
// 1. A channel without full access is never moderated (no reviews, no Twitch actions):
//    the bot isn't a moderator there, so actions would fail and spam reviews would cost credits.
// 2. A channel with full access is still moderated (same caps ladder as moderation.mjs).
// 3. When Twitch revokes the chat subscription, the streamer's "bot in chat" flag turns off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { encrypt } from '/app/dist/utils/crypto.js';
import { ChannelModerationSettingsSchema, buildDefaultModerationRules } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { ModerationDecision } from '/app/dist/schemas/moderation_decision.schema.js';
import { runChatModeration } from '/app/dist/handlers/moderation.handler.js';
import { revocationHandler } from '/app/dist/handlers/revocation.handler.js';

await getMongoDBConnection('bot-chat-only-check');
const redis = await getDragonflyClient('bot-chat-only-check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = () => { try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'dummy-token', expires_at: String(Math.floor(Date.now() / 1000) + 36000) });

const account = (id, name, actived, chat) => ({ type: 'twitch', id, name, email: '', access_token: encrypt(actived ? 'a' : ''), refresh_token: encrypt(actived ? 'r' : ''),
  actived, chat_enabled: chat, has_permissions: actived, up_to_date_permissions: actived });
const CHAT_ONLY = 'chatonly-1';
const FULL = 'fullaccess-1';
await UsersSchema.create([
  { name: 'chat_only', plan_tier: 'pro', accounts: [account(CHAT_ONLY, 'chat_only', false, true)] },
  { name: 'full_access', plan_tier: 'pro', accounts: [account(FULL, 'full_access', true, true)] }
]);
const rules = buildDefaultModerationRules();
for (const channelID of [CHAT_ONLY, FULL]) {
  // Even with saved, enabled settings (e.g. left over from an earlier activation) the chat-only channel is skipped.
  await ChannelModerationSettingsSchema.create({ channelID, channel: channelID, enabled: true, offenseWindowSeconds: 3600, rules, settingsVersion: 1 });
}
const identity = { level: 1, tags: new Set(['everyone']), userId: 'viewer-1' };
const message = (id, text) => ({ chatter_user_id: 'viewer-1', chatter_user_login: 'viewer1', chatter_user_name: 'Viewer1', message_id: id, badges: [], message: { text, fragments: [] } });

// 1. Chat-only channel: spammy first message and caps are ignored.
let mark = calls().length;
for (const [id, text] of [['co-1', 'FOLLOW MY CHANNEL twitch.tv/spammer CHEAP VIEWERS'], ['co-2', 'THIS IS WAY TOO LOUD BRO'], ['co-3', 'THIS IS WAY TOO LOUD BRO']]) {
  const result = await runChatModeration(CHAT_ONLY, message(id, text), identity);
  assert.equal(result.actionTaken, false, `chat-only: ${id} not actioned`);
}
await sleep(500);
assert.deepEqual(calls().slice(mark), [], 'chat-only: no Twitch moderation calls, no AI review');
assert.equal(await ModerationDecision.countDocuments({ channelID: CHAT_ONLY }), 0, 'chat-only: no moderation decisions stored');
console.log('PASS channel without full access is not moderated');

// 2. Full-access channel: caps still actioned (first rung: warning).
mark = calls().length;
const actioned = await runChatModeration(FULL, message('fa-1', 'THIS IS WAY TOO LOUD BRO'), identity);
assert.equal(actioned.actionTaken, true, 'full access: caps offense actioned');
for (let i = 0; i < 50 && !calls().slice(mark).some((c) => c.warn === 'viewer-1'); i++) await sleep(100);
assert.ok(calls().slice(mark).some((c) => c.warn === 'viewer-1' && c.channel === FULL), 'full access: Twitch warning sent');
console.log('PASS channel with full access is still moderated');

// 3. Revoked chat subscription turns the flag off (only when no chat subscription remains).
const sub = (id, channelID) => ({ id, status: 'enabled', type: 'channel.chat.message', version: '1', channel: channelID, channelID,
  condition: { broadcaster_user_id: channelID, user_id: '698614112' }, transport: { method: 'webhook', callback: 'https://x' }, cost: 0, created_at: new Date().toISOString() });
await EventsubSchema.create([sub('rev-a', FULL), sub('rev-b', FULL)]);
await redis.hSet(`accounts:twitch:${FULL}:data`, { id: FULL, chat_enabled: 'true' });
let revoked = await revocationHandler({ id: 'rev-a', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: FULL, user_id: '698614112' } });
assert.equal(revoked.error, false);
let saved = (await UsersSchema.findOne({ 'accounts.id': FULL }).lean()).accounts[0];
assert.equal(saved.chat_enabled, true, 'another chat subscription remains: still in chat');
revoked = await revocationHandler({ id: 'rev-b', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: FULL, user_id: '698614112' } });
assert.equal(revoked.error, false);
saved = (await UsersSchema.findOne({ 'accounts.id': FULL }).lean()).accounts[0];
assert.equal(saved.chat_enabled, false, 'last chat subscription revoked: out of chat');
assert.equal(await redis.hGet(`accounts:twitch:${FULL}:data`, 'chat_enabled'), 'false', 'cache updated');
assert.equal(await EventsubSchema.countDocuments({ channelID: FULL }), 0);
// Other revocations leave the flag alone.
await UsersSchema.updateOne({ 'accounts.id': FULL }, { $set: { 'accounts.$.chat_enabled': true } });
await EventsubSchema.create({ ...sub('rev-c', FULL), type: 'channel.follow', version: '2' });
await revocationHandler({ id: 'rev-c', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: FULL } });
assert.equal((await UsersSchema.findOne({ 'accounts.id': FULL }).lean()).accounts[0].chat_enabled, true, 'follow revocation keeps chat flag');
// A replay after the record is already gone (e.g. the flag update failed the first time) repairs the flag.
await UsersSchema.updateOne({ 'accounts.id': FULL }, { $set: { 'accounts.$.chat_enabled': true } });
await redis.hSet(`accounts:twitch:${FULL}:data`, 'chat_enabled', 'true');
revoked = await revocationHandler({ id: 'rev-b', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: FULL, user_id: '698614112' } });
assert.equal(revoked.error, false);
assert.equal((await UsersSchema.findOne({ 'accounts.id': FULL }).lean()).accounts[0].chat_enabled, false, 'replay repairs the flag');
assert.equal(await redis.hGet(`accounts:twitch:${FULL}:data`, 'chat_enabled'), 'false', 'replay repairs the cache');
// A replay for an old subscription doesn't remove a bot the streamer added again since.
await EventsubSchema.create(sub('rev-new', FULL));
await UsersSchema.updateOne({ 'accounts.id': FULL }, { $set: { 'accounts.$.chat_enabled': true } });
await revocationHandler({ id: 'rev-b', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: FULL, user_id: '698614112' } });
assert.equal((await UsersSchema.findOne({ 'accounts.id': FULL }).lean()).accounts[0].chat_enabled, true, 're-added bot stays in chat');
console.log('PASS revoked chat subscription marks the bot out of chat');
process.exit(0);
