// Isolated API behaviour check for "bot in chat without full access" (2026-11-10).
// Run with disposable Mongo/Redis, ops/checks/bot-chat-access-fixtures/test-env.json and its
// Twitch mock (providers.mjs). Nothing reaches Twitch or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { encrypt, decrypt } from '/app/dist/utils/crypto.js';
import { ensureReservedCommands, getReservedCommandsPayload } from '/app/dist/server/services/command_defaults.service.js';

const API = 'http://127.0.0.1:3000';
const CALLS = '/tmp/saas-fixtures/calls.jsonl';
const BOT_ID = '698614112';
await getMongoDBConnection('bot-chat-access-check');
const redis = await getDragonflyClient('bot-chat-access-check');

const account = (id, name, flags, tokens = ['', '']) => ({
  type: 'twitch', id, name, email: `${name}@example.test`,
  access_token: encrypt(tokens[0]), refresh_token: encrypt(tokens[1]),
  actived: flags.actived, chat_enabled: flags.chat, has_permissions: flags.perms, up_to_date_permissions: flags.perms
});
const NEW = { id: '91001', login: 'newbie_fixture' };
const NOBOT = { id: 'nobot91002', login: 'nobot_fixture' };
const ACTIVE = { id: '91003', login: 'active_fixture' };
const BOTFAIL = { id: 'botfail91004', login: 'botfail_fixture' };
const LATE = { id: '91005', login: 'late_fixture' };
const SCOPEFAIL = { id: 'scopefail91006', login: 'scopefail_fixture' };
const OUTSIDER = { id: '91099', login: 'outsider_fixture' }; // Twitch account with no DomDimaBot account
await UsersSchema.create([
  { name: NEW.login, email: 'n@example.test', plan_tier: 'free', accounts: [account(NEW.id, NEW.login, { actived: false, chat: false, perms: false })] },
  { name: NOBOT.login, email: 'b@example.test', plan_tier: 'free', accounts: [account(NOBOT.id, NOBOT.login, { actived: false, chat: false, perms: false })] },
  { name: ACTIVE.login, email: 'a@example.test', plan_tier: 'free', accounts: [account(ACTIVE.id, ACTIVE.login, { actived: true, chat: false, perms: true }, ['old-access', 'old-refresh'])] },
  { name: BOTFAIL.login, email: 'f@example.test', plan_tier: 'free', accounts: [account(BOTFAIL.id, BOTFAIL.login, { actived: false, chat: false, perms: false })] },
  { name: LATE.login, email: 'l@example.test', plan_tier: 'free', accounts: [account(LATE.id, LATE.login, { actived: false, chat: false, perms: false })] },
  { name: SCOPEFAIL.login, email: 's@example.test', plan_tier: 'free', accounts: [account(SCOPEFAIL.id, SCOPEFAIL.login, { actived: false, chat: false, perms: false })] }
]);

const token = (u) => `tok-${u.id}-${u.login}`;
const calls = () => fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const callsSince = (n) => calls().slice(n);
const setChat = (channel, enabled, auth) => fetch(`${API}/users/chat/${channel}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify({ enabled })
});
const user = async (id) => (await UsersSchema.findOne({ 'accounts.id': id }).lean()).accounts.find((a) => a.id === id);

// 1. A streamer who only signed in adds the bot to chat: app token only, no stored token needed.
let mark = calls().length;
let res = await setChat(NEW.id, true, token(NEW));
let body = await res.json();
assert.equal(res.status, 200, `join without full access: ${JSON.stringify(body)}`);
assert.equal(body.data.chatEnabled, true);
assert.equal((await user(NEW.id)).chat_enabled, true, 'Mongo chat_enabled true');
assert.equal(await redis.hGet(`accounts:twitch:${NEW.id}:data`, 'chat_enabled'), 'true', 'cache chat_enabled true');
const sub = await EventsubSchema.findOne({ channelID: NEW.id, type: 'channel.chat.message' }).lean();
assert.ok(sub?.id, 'chat subscription stored');
let subscribeCalls = callsSince(mark).filter((c) => c.path === 'eventsub/subscriptions' && c.method === 'POST');
assert.equal(subscribeCalls.length, 1);
assert.equal(subscribeCalls[0].bearer, 'app-token-fixture', 'subscription created with the app token');
assert.deepEqual(subscribeCalls[0].body.condition, { broadcaster_user_id: NEW.id, user_id: BOT_ID });
assert.equal(subscribeCalls[0].body.type, 'channel.chat.message');
assert.ok(!callsSince(mark).some((c) => c.provider === 'twitch-id' && c.grant_type === 'refresh_token'), 'no broadcaster token refresh attempted');
console.log('PASS signed-in-only streamer adds the bot to chat with the app token');

// 2. Adding again is a no-op.
mark = calls().length;
res = await setChat(NEW.id, true, token(NEW));
assert.equal(res.status, 200);
assert.equal(callsSince(mark).filter((c) => c.path === 'eventsub/subscriptions').length, 0, 'no second subscription');
console.log('PASS adding twice keeps one subscription');

// 3. Removing the bot deletes the subscription and the flag.
mark = calls().length;
res = await setChat(NEW.id, false, token(NEW));
body = await res.json();
assert.equal(res.status, 200, JSON.stringify(body));
assert.equal((await user(NEW.id)).chat_enabled, false);
assert.equal(await redis.hGet(`accounts:twitch:${NEW.id}:data`, 'chat_enabled'), 'false');
assert.equal(await EventsubSchema.countDocuments({ channelID: NEW.id, type: 'channel.chat.message' }), 0);
assert.ok(callsSince(mark).some((c) => c.path === 'eventsub/subscriptions' && c.method === 'DELETE' && c.query.includes(sub.id)), 'Twitch subscription deleted');
console.log('PASS removing the bot deletes the chat subscription');

// 4. Twitch refuses (no channel:bot grant): clear code for the site, nothing saved.
res = await setChat(NOBOT.id, true, token(NOBOT));
body = await res.json();
assert.equal(res.status, 403, JSON.stringify(body));
assert.equal(body.code, 'chat_permission_missing');
assert.equal((await user(NOBOT.id)).chat_enabled, false);
assert.equal(await EventsubSchema.countDocuments({ channelID: NOBOT.id }), 0);
console.log('PASS missing Twitch approval returns chat_permission_missing and saves nothing');

// 4b. Twitch refuses although the streamer approved channel:bot: not something they can fix.
res = await setChat(BOTFAIL.id, true, token(BOTFAIL));
body = await res.json();
assert.equal(res.status, 502, JSON.stringify(body));
assert.equal(body.code, 'chat_join_failed');
assert.equal((await user(BOTFAIL.id)).chat_enabled, false);
console.log('PASS bot-side refusal is not reported as a missing streamer approval');

// 4c. Twitch refuses and the approval lookup fails: "try again", never "approve on Twitch".
res = await setChat(SCOPEFAIL.id, true, token(SCOPEFAIL));
body = await res.json();
assert.equal(res.status, 503, JSON.stringify(body));
assert.equal(body.code, 'chat_check_failed');
assert.equal((await user(SCOPEFAIL.id)).chat_enabled, false);
console.log('PASS unknown approval state is a retryable error, not a sign-in prompt');

// 5. Only the owner may add the bot; anonymous requests are rejected.
mark = calls().length;
res = await setChat(NEW.id, true, token(NOBOT));
assert.equal(res.status, 403, 'another streamer cannot add the bot to this chat');
res = await setChat(NEW.id, true, null);
assert.equal(res.status, 401, 'no token');
assert.equal(callsSince(mark).filter((c) => c.path === 'eventsub/subscriptions').length, 0);
assert.equal((await user(NEW.id)).chat_enabled, false);
console.log('PASS chat toggle stays owner-only');

// 6. OAuth callbacks trust only the verified Twitch account, never the username in `state`.
const before = await user(ACTIVE.id);
for (const endpoint of ['register', 'reauthenticate']) {
  const r = await fetch(`${API}/auth/${endpoint}?code=code-${OUTSIDER.id}-${OUTSIDER.login}&state=${ACTIVE.login}`, { redirect: 'manual' });
  assert.equal(r.status, 404, `${endpoint}: a Twitch account without a DomDimaBot account is refused`);
}
const after = await user(ACTIVE.id);
assert.deepEqual(after.access_token, before.access_token, 'victim tokens untouched');
assert.deepEqual(after.refresh_token, before.refresh_token, 'victim refresh token untouched');
console.log('PASS OAuth callbacks ignore the state username (no cross-account token overwrite)');

// 6b. "Reconnect Twitch" before full access runs the full activation from the callback.
res = await fetch(`${API}/auth/reauthenticate?code=code-${LATE.id}-${LATE.login}&state=someone_else`, { redirect: 'manual' });
assert.equal(res.status, 302, await res.text());
const late = await user(LATE.id);
assert.equal(late.actived, true, 'activated');
assert.equal(late.chat_enabled, true, 'bot in chat after activation');
assert.equal(decrypt(late.access_token), token(LATE));
assert.ok(await EventsubSchema.exists({ channelID: LATE.id, type: 'channel.chat.message' }), 'events subscribed');
assert.ok(await CommandsSchema.exists({ channelID: LATE.id, reserved: true }), 'default commands added');
console.log('PASS reauthenticate on a never-activated account runs the full activation');

// 7. Reauthenticating refreshes tokens but keeps the streamer's chat choice (it doesn't join chat).
res = await fetch(`${API}/auth/reauthenticate?code=code-${ACTIVE.id}-${ACTIVE.login}&state=${ACTIVE.login}`, { redirect: 'manual' });
assert.equal(res.status, 302, await res.text());
const active = await user(ACTIVE.id);
assert.equal(active.chat_enabled, false, 'chat choice kept');
assert.equal(active.actived, true);
assert.equal(active.has_permissions, true);
assert.equal(decrypt(active.access_token), token(ACTIVE), 'new token stored');
console.log('PASS reauthenticate keeps chat off when the streamer removed the bot');

// 8. Own commands work before full access, and win over the defaults later.
let created = await fetch(`${API}/commands/${NEW.id}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token(NEW)}` },
  body: JSON.stringify({ name: 's', cmd: 's', func: 's', channel: NEW.login, message: '$(tts $(user) says: &t)', cooldown: 5, userLevel: 1 })
});
assert.ok(created.status === 200 || created.status === 201, `create own command: ${created.status} ${await created.text()}`);
const listed = await (await fetch(`${API}/commands/${NEW.id}?activation=all&limit=1000`)).json();
assert.equal(listed.commands.length, 1, 'no defaults before full access');
assert.equal(listed.commands[0].reserved, false);
const catalog = getReservedCommandsPayload().commands;
const seeded = await ensureReservedCommands(NEW.id, NEW.login);
assert.equal(seeded, catalog.length - 1, 'every default except the taken `!s`');
const named = await CommandsSchema.find({ channelID: NEW.id, cmd: 's' }).lean();
assert.equal(named.length, 1, 'one `!s`');
assert.equal(named[0].func, 's', 'the streamer’s own `!s` kept');
assert.equal(await CommandsSchema.exists({ channelID: NEW.id, func: 'speach' }), null);
console.log('PASS own commands before full access; activation skips defaults whose name is taken');

// 9. The public catalog the site uses for the locked preview.
const publicCatalog = await (await fetch(`${API}/config/commands/reserved?language=es`)).json();
assert.equal(publicCatalog.error, false);
assert.equal(publicCatalog.data.commands.length, catalog.length);
assert.ok(publicCatalog.data.commands.every((c) => typeof c.description === 'string'), 'localized descriptions');
console.log(`PASS reserved catalog lists ${catalog.length} defaults`);

process.exit(0);
