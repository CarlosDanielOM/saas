// Admin console activity log, bot side. Run by saas-ops against the `bot` candidate with disposable
// Mongo/Redis and ops/checks/admin-console-fixtures (mocked Twitch/AI; nothing leaves the container).
// Signed chat messages go through the real webhook and message handler, then `activity_logs` must hold:
// a command row per attempt of a command that exists (ran, cooldown, turned off, no permission), with
// its reason; a bot_message row per reply the bot sent; and nothing for an unknown `!word` or plain chat.
// A built-in that fails keeps its own words (not "something went wrong"); "Usage: ..." is not a failure. A voice
// request that is not queued leaves a `voice`/`request` row saying why (TTS off; no speech page, from a fake
// speech service on 127.0.0.1:3000 that answers like the API).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { encrypt } from '/app/dist/utils/crypto.js';
import { createTwitchEventsubApp } from '/app/dist/bot/eventsub.twitch.js';

const target = process.env.SAAS_TARGET;
const CHANNEL = '99007701';
const VIEWER = '99007799';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await pause(150);
    }
    assert.fail(`Timed out: ${label}`);
}
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl')
    ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const chatSent = () => calls().filter(call => call.chat && call.channel === CHANNEL).map(call => call.message);

await getMongoDBConnection('AdminConsoleBotActivityCheck');
const redis = await getDragonflyClient('AdminConsoleBotActivityCheck');
const activity = mongoose.connection.db.collection('activity_logs');
const rows = filter => activity.find({ channelID: CHANNEL, ...filter }).sort({ at: 1 }).toArray();

// Bot in chat without full access: moderation is skipped for such channels, so the mocked AI review
// never touches these messages and every one of them reaches command dispatch.
await UsersSchema.create({ name: 'Activity Fixture', language: 'en', plan_tier: 'pro', accounts: [{ type: 'twitch', id: CHANNEL,
    name: 'activityfixture', email: '', access_token: encrypt(''), refresh_token: encrypt(''),
    actived: false, has_permissions: false, up_to_date_permissions: false, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${CHANNEL}:data`, { id: CHANNEL, name: 'activityfixture', plan_tier: 'pro',
    chat_enabled: 'true', actived: 'false', has_permissions: 'false' });
await redis.set('app:twitch:token', 'app-token');
const command = (cmd, fields = {}) => ({ channelID: CHANNEL, channel: 'activityfixture', name: cmd, cmd, func: 'custom',
    message: `Reply from ${cmd}`, cooldown: 0, userLevel: 1, enabled: true, ...fields });
await CommandsSchema.create([
    command('hello'),
    command('slow', { cooldown: 30 }),
    command('off', { enabled: false }),
    command('modonly', { userLevel: 7 }),
    // A built-in (its error message is the bot's reply) and the usual voice request command.
    command('dc', { func: 'deleteCommand', message: '' }),
    command('s', { func: 'speach', message: '$(tts $(user) dice: &t)' })
]);

let server;
let webhookURL = 'http://127.0.0.1:3333/eventsub';
if (target !== 'bot') {
    server = createTwitchEventsubApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    webhookURL = `http://127.0.0.1:${server.address().port}/eventsub`;
}
await until(async () => {
    try { return (await fetch(webhookURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; }
    catch { return false; }
}, 'webhook ready and rejecting unsigned requests');

let sequence = 0;
async function send(text, messageID, receipt = `activity-receipt-${++sequence}`) {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
        subscription: { id: `message-${CHANNEL}`, type: 'channel.chat.message', version: '1',
            condition: { broadcaster_user_id: CHANNEL, user_id: '698614112' }, transport: { method: 'webhook' } },
        event: { broadcaster_user_id: CHANNEL, broadcaster_user_login: 'activityfixture', broadcaster_user_name: 'ActivityFixture',
            chatter_user_id: VIEWER, chatter_user_login: 'activityviewer', chatter_user_name: 'ActivityViewer',
            message_id: messageID, message: { text, fragments: [{ type: 'text', text }] }, message_type: 'text', badges: [], cheer: null,
            color: '', reply: null, channel_points_custom_reward_id: null, source_broadcaster_user_id: null,
            source_message_id: null, is_source_only: null }
    });
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
        .update(receipt).update(timestamp).update(body).digest('hex');
    const response = await fetch(webhookURL, { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Twitch-Eventsub-Message-Id': receipt, 'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Type': 'notification', 'Twitch-Eventsub-Message-Signature': signature }, body });
    assert.equal(response.status, 204, `webhook accepted ${messageID}`);
    return receipt;
}
const commandRow = async messageID => (await rows({ kind: 'command', ref: messageID }))[0] ?? null;

// 1. A command that runs: one ok row, and the reply is a bot_message row for the same chatter.
const helloReceipt = await send('!hello', 'act-hello');
await until(async () => (await commandRow('act-hello')) && (await rows({ kind: 'bot_message', text: 'Reply from hello' })).length, 'hello rows');
const hello = await commandRow('act-hello');
assert.equal(hello.name, '!hello');
assert.equal(hello.outcome, 'ok');
assert.equal(hello.reason, '');
assert.equal(hello.actorID, VIEWER);
assert.equal(hello.actorLogin, 'activityviewer');
assert.equal(hello.actorName, 'ActivityViewer');
assert.equal(hello.text, '!hello');
assert.equal(hello.data.trigger, 'chat');
assert.equal(hello.data.func, 'custom');
assert.equal(typeof hello.durationMs, 'number');
if (target === 'bot') assert.equal(hello.service, 'bot');
const [reply] = await rows({ kind: 'bot_message', text: 'Reply from hello' });
assert.equal(reply.name, 'command', 'a command reply says where it came from');
assert.equal(reply.outcome, 'ok');
assert.equal(reply.data.origin, 'command');
assert.equal(reply.ref, 'notice-msg', 'the Twitch message id of the sent reply');
assert.equal(reply.actorID, VIEWER, 'the reply is for the chatter who ran the command');
console.log('PASS a command that runs writes an ok command row and an ok bot_message row');

// 2. Twitch retrying the same delivery is dropped at the webhook and writes nothing more.
await send('!hello', 'act-hello', helloReceipt);
await pause(1500);
assert.equal((await rows({ kind: 'command', ref: 'act-hello' })).length, 1, 'a retried delivery is one command row');
assert.equal((await rows({ kind: 'bot_message', text: 'Reply from hello' })).length, 1, 'and one reply');
console.log('PASS a retried delivery writes no second row');

// 3. Cooldown: the second run inside the 30 s cooldown is skipped and says why.
await send('!slow', 'act-slow-1');
await until(async () => (await commandRow('act-slow-1'))?.outcome === 'ok', 'first slow run');
await send('!slow', 'act-slow-2');
await until(() => commandRow('act-slow-2'), 'second slow run');
const cooled = await commandRow('act-slow-2');
assert.equal(cooled.outcome, 'skipped');
assert.equal(cooled.reason, 'cooldown');
assert.ok(['memory', 'shared'].includes(cooled.data.cooldownStore), 'which cooldown stopped it');

// 4. A command that is turned off, and one the chatter may not use.
await send('!off', 'act-off');
await send('!modonly please', 'act-modonly');
await until(async () => (await commandRow('act-off')) && (await commandRow('act-modonly')), 'refused rows');
const off = await commandRow('act-off');
assert.deepEqual([off.name, off.outcome, off.reason], ['!off', 'skipped', 'disabled']);
const denied = await commandRow('act-modonly');
assert.deepEqual([denied.name, denied.outcome, denied.reason], ['!modonly', 'blocked', 'permission_denied']);
assert.equal(denied.text, '!modonly please');
console.log('PASS cooldown, turned-off and permission refusals are recorded with their reason');

// 5. An unknown !word and plain chat are not commands: no rows. A later known command proves the
// handler has already processed them (same channel, same order of delivery).
await send('!nosuchword at all', 'act-unknown');
await send('just chatting here', 'act-plain');
await send('!hello', 'act-hello-2');
await until(() => commandRow('act-hello-2'), 'follow-up command row');
await pause(1500);
assert.equal((await activity.countDocuments({ ref: { $in: ['act-unknown', 'act-plain'] } })), 0, 'no row for an unknown command or chat');
assert.equal((await activity.countDocuments({ channelID: CHANNEL, name: '!nosuchword' })), 0);
console.log('PASS an unknown !word and plain chat write nothing');

// 6. Refused commands stay silent in chat, as before; every reply the bot sent has its row.
assert.deepEqual(chatSent(), ['Reply from hello', 'Reply from slow', 'Reply from hello'], 'only the commands that ran replied');
const messages = await rows({ kind: 'bot_message' });
assert.deepEqual(messages.map(row => [row.text, row.outcome, row.name]), chatSent().map(text => [text, 'ok', 'command']));
const commands = await rows({ kind: 'command' });
assert.deepEqual(Object.fromEntries(commands.map(row => [row.ref, `${row.outcome}:${row.reason}`])), {
    'act-hello': 'ok:', 'act-slow-1': 'ok:', 'act-slow-2': 'skipped:cooldown',
    'act-off': 'skipped:disabled', 'act-modonly': 'blocked:permission_denied', 'act-hello-2': 'ok:'
});
assert.equal(commands.length, 6, 'one command row per attempt');
const stored = JSON.stringify(await rows({}));
for (const secret of ['app-token', process.env.TWITCH_EVENTSUB_SECRET, process.env.SECRET_KEY].filter(Boolean)) {
    assert.equal(stored.includes(secret), false, 'no token or secret in activity rows');
}
for (const row of [...messages, ...commands]) {
    assert.ok(row.expiresAt.getTime() - row.at.getTime() === 30 * 86_400_000, '30-day expiry');
}
console.log('PASS refused commands stay silent, every sent reply has its row, and no secret is stored');

// 7. A built-in that fails says why in its own words, which are also its chat reply; a usage reply is not a failure.
await send('!dc', 'act-dc-usage');
await send('!dc modonly', 'act-dc-denied');
await until(async () => (await commandRow('act-dc-usage')) && (await commandRow('act-dc-denied')), 'built-in rows');
const usage = await commandRow('act-dc-usage');
assert.deepEqual([usage.outcome, usage.reason, usage.data.error, usage.data.func], ['skipped', 'usage', 'Usage: !dc <command name>', 'deleteCommand']);
const builtInFailed = await commandRow('act-dc-denied');
assert.deepEqual([builtInFailed.outcome, builtInFailed.reason, builtInFailed.data.error],
    ['failed', 'error', 'You do not have enough permissions to delete this command']);
await until(() => chatSent().includes('You do not have enough permissions to delete this command') && chatSent().includes('Usage: !dc <command name>'),
    'the same words were the chat replies');
assert.ok(await CommandsSchema.exists({ channelID: CHANNEL, cmd: 'modonly' }), 'nothing was deleted');
console.log('PASS a failed built-in keeps its own error text; a usage reply is recorded as used wrong, not failed');

// 8. Voice requests that are not queued say why. Off in the channel's settings: skipped (a setting, not a problem).
const ttsSettings = mongoose.connection.db.collection('channel_tts_settings');
await ttsSettings.updateOne({ channelID: CHANNEL }, { $set: { channelID: CHANNEL, channel: 'activityfixture', enabled: false } }, { upsert: true });
const voiceRow = async () => (await rows({ kind: 'voice', name: 'request' })).at(-1) ?? null;
await send('!s read this please', 'act-tts-off');
await until(async () => (await voiceRow())?.reason === 'tts_disabled', 'TTS off row');
const off2 = await voiceRow();
assert.deepEqual([off2.outcome, off2.actorID, off2.actorLogin, off2.data.source, off2.data.error],
    ['skipped', VIEWER, 'activityviewer', 'ast', 'TTS is disabled for this channel']);
assert.ok(off2.text.endsWith('read this please'), `what they asked to be read: ${off2.text}`);
// On, but no speech page is open: the speech service refuses with 409 and a code; nobody hears the viewer.
let speechCalls = 0;
const speech = http.createServer((request, response) => {
    speechCalls++;
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: true, status: 409, code: 'no_speech_page', message: 'Speech overlay is not connected. Open the speech URL first and try again.' }));
});
await new Promise((resolve, reject) => { speech.once('error', reject); speech.listen(3000, '127.0.0.1', resolve); });
await ttsSettings.updateOne({ channelID: CHANNEL }, { $set: { enabled: true } });
await send('!s now with TTS on', 'act-tts-nopage');
await until(async () => (await voiceRow())?.reason === 'no_speech_page', 'no speech page row');
const noPage = await voiceRow();
assert.deepEqual([noPage.outcome, noPage.data.error], ['failed', 'Speech overlay is not connected. Open the speech URL first and try again.']);
assert.ok(noPage.text.endsWith('now with TTS on'));
assert.equal(speechCalls, 1, 'one request reached the speech service');
assert.equal((await rows({ kind: 'voice', name: 'request' })).length, 2, 'one row per refused request');
speech.close();
console.log('PASS refused voice requests record why: TTS off (skipped) and no speech page open (failed)');

server?.close();
process.exit(0);
