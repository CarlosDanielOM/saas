// Run by saas-ops against the actual bot/API/cron command, with disposable Mongo/Redis.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { StreamSessionSchema } from '/app/dist/schemas/stream_session.schema.js';
import { StreamActivitySchema } from '/app/dist/schemas/stream_activity.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { createTwitchEventsubApp } from '/app/dist/bot/eventsub.twitch.js';
import { generateTestPayload } from '/app/dist/utils/eventsub.test-data.js';
import { applyChatAnnouncementDomainEvent } from '/app/dist/domain_events/chat_announcement_events.js';
import { normalizeTwitchEventsubDomainEvent } from '/app/dist/domain_events/twitch_eventsub_events.js';

const target = process.env.SAAS_TARGET;
assert.ok(['bot', 'api', 'cron'].includes(target));
const channels = ['99005501', '99005502'];
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl')
    ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const speech = () => calls().filter(call => call.speech);
const chat = () => calls().filter(call => call.chat);
const chatPoints = () => calls().filter(call => call.qdrantPath === '/collections/twitch_chat_logs/points')
    .flatMap(call => call.points?.points || []);
const embeddedTexts = () => calls().flatMap(call => call.embeddings
    ? (Array.isArray(call.embeddings.input) ? call.embeddings.input : [call.embeddings.input]) : []);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await pause(100);
    }
    assert.fail(`Timed out: ${label}`);
}
await getMongoDBConnection('SharedChatCheck');
const redis = await getDragonflyClient('SharedChatCheck');
await Promise.all([DomainEventSchema.init(), DomainEventDeliverySchema.init(), EventsubSchema.init()]);
const keywords = new Map();
for (const channelID of channels) {
    await UsersSchema.create({ name: `Fixture ${channelID}`, language: 'en', accounts: [{ type: 'twitch', id: channelID,
        name: `fixture${channelID}`, actived: true, has_permissions: true, chat_enabled: true }] });
    await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: `fixture${channelID}`, plan_tier: 'pro',
        chat_enabled: 'true', actived: 'true', has_permissions: 'true' });
    await StreamSessionSchema.create({ channelID, stream_id: `stream-${channelID}`, status: 'live',
        started_at: new Date(Date.now() - 60_000) });
    // The reserved !s spelling uses the same authored TTS template seen in production.
    await CommandsSchema.create({ channelID, channel: `fixture${channelID}`, name: 'Say', cmd: 's', reserved: true,
        func: 'custom', message: '$(tts $(user) dice: &t)', cooldown: 0, userLevel: 1 });
    const keyword = await CommandsSchema.create({ channelID, channel: `fixture${channelID}`, name: 'Signal', cmd: 'signal',
        func: 'custom', message: '$(upper isolated) $(scount)', cooldown: 1, userLevel: 1,
        activation: 'keyword', keywordSettings: { matchMode: 'anywhere' } });
    keywords.set(channelID, String(keyword._id));
    await EventsubSchema.create({ channelID, channel: `fixture${channelID}`, type: 'channel.chat.notification', enabled: true, message: 'Notice $(user)',
        id: `notice-${channelID}`, status: 'enabled', version: '1', condition: { broadcaster_user_id: channelID, user_id: '698614112' },
        created_at: new Date().toISOString(), transport: { method: 'webhook', callback: 'https://fixture.test/eventsub' }, cost: 0 });
}
await redis.set('app:twitch:token', 'app-token');
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
}, 'real webhook ready');
if (target === 'cron') await until(() => calls().some(call => call.worker?.endsWith('/domain_events.worker.js')), 'real domain worker started');
if (target === 'api') await until(async () => {
    try { return (await fetch('http://127.0.0.1:3000/eventsubs/standard')).status === 200; } catch { return false; }
}, 'actual API ready');
let sequence = 0;
async function send(payload, receipt = `shared-chat-${++sequence}`) {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify(payload);
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
        .update(receipt).update(timestamp).update(body).digest('hex');
    assert.equal((await fetch(webhookURL, { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Twitch-Eventsub-Message-Id': receipt, 'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Type': 'notification', 'Twitch-Eventsub-Message-Signature': signature }, body })).status, 204);
    return receipt;
}
function message(channelID, source, text, id) {
    return { subscription: { id: `message-${channelID}`, type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: channelID, user_id: '698614112' }, transport: { method: 'webhook' } },
        event: { broadcaster_user_id: channelID, broadcaster_user_login: `fixture${channelID}`, broadcaster_user_name: `Fixture ${channelID}`,
            chatter_user_id: '99005503', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
            message_id: id, message: { text, fragments: [] }, message_type: 'text', badges: [], cheer: null,
            color: '', reply: null, channel_points_custom_reward_id: null, source_broadcaster_user_id: source,
            source_message_id: 'unrelated-source-id', is_source_only: false } };
}
async function assertNoMessages() {
    assert.equal(speech().length, 0, 'foreign !s never reaches the chargeable speech boundary');
    assert.equal(chat().length, 0, 'foreign keyword never posts a reply');
    assert.equal(await StreamActivitySchema.countDocuments(), 0, 'foreign copies never enter analytics activity');
    for (const channelID of channels) {
        assert.equal(await redis.lLen(`twitch:${channelID}:chat:history`), 0, 'foreign history remains empty');
        assert.equal(await redis.exists(`${channelID}:commands:s`), 0, 'foreign command never loads receiver config');
        assert.equal(await redis.exists(`command:execution:cooldown:${channelID}:keyword:${keywords.get(channelID)}`), 0);
        assert.equal((await CommandsSchema.findById(keywords.get(channelID))).count, 0);
        const session = await StreamSessionSchema.findOne({ channelID }).lean();
        assert.equal(session.messages, 0); assert.equal(session.commands, 0);
    }
}
// Send foreign copies before local originals, in both directions. is_source_only does not grant ownership.
for (const [origin, receiver] of [channels, [...channels].reverse()]) {
    const payload = message(receiver, origin, '!s signal foreign text', `foreign-${origin}`);
    payload.event.is_source_only = true;
    await send(payload);
}
await pause(500);
await assertNoMessages();
assert.equal(embeddedTexts().includes('!s signal foreign text'), false, 'foreign chat text never reaches embedding generation');
assert.equal(chatPoints().length, 0, 'foreign copies never reach the chat-log collection');
// Exercise the real API manual-test route as well as the signed webhook module it shares.
if (target === 'api') {
    for (const [origin, receiver] of [channels, [...channels].reverse()]) {
        const token = `fixture-${receiver}`;
        await redis.hSet(`token:${token}`, { id: receiver, login: `fixture${receiver}`, display_name: 'Fixture' });
        const response = await fetch(`http://127.0.0.1:3000/eventsubs/${receiver}/test`, { method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(message(receiver, origin, '!s signal manual foreign', `manual-foreign-${origin}`)) });
        assert.equal(response.status, 202, await response.text());
    }
    await pause(250);
    await assertNoMessages();
}
for (const channelID of channels) {
    const before = speech().length;
    await send(message(channelID, channelID, `!s signal local ${channelID}`, `local-${channelID}`));
    await until(() => speech().length === before + 1, 'origin speech delivered once');
    assert.equal(speech().at(-1).channelID, channelID);
    assert.equal(speech().at(-1).speech.text, `Viewer dice : signal local ${channelID}`);
    assert.equal(speech().at(-1).speech.requestedBy.userID, '99005503');
    await until(async () => (await CommandsSchema.findById(keywords.get(channelID))).count === 1, 'origin keyword count');
    await until(() => chat().some(call => call.chat.broadcaster_id === channelID && call.chat.message === 'ISOLATED 1'), 'origin keyword reply');
    assert.ok(await redis.pTTL(`command:execution:cooldown:${channelID}:keyword:${keywords.get(channelID)}`) > 0);
    // Foreign copies must not consume the receiver's first command/keyword cooldown.
    assert.equal(await redis.lLen(`twitch:${channelID}:chat:history`), 1);
    for (const [index, source] of [undefined, null, ''].entries()) {
        const count = speech().length;
        const payload = message(channelID, source, `!s local variant ${index}`, `local-${channelID}-${index}`);
        payload.event.is_source_only = index % 2 === 0;
        await send(payload);
        await until(() => speech().length === count + 1, 'local nullable source accepted');
        assert.equal(speech().at(-1).channelID, channelID);
    }
}
await until(async () => (await StreamSessionSchema.find({}).lean()).every(session => session.messages === 4 && session.commands === 4), 'origin-only analytics');
for (const channelID of channels) {
    assert.equal(await redis.lLen(`twitch:${channelID}:chat:history`), 4);
    assert.equal((await CommandsSchema.findById(keywords.get(channelID))).count, 1);
}
assert.equal(speech().length, 8, 'exactly four local speech calls per origin');
await until(() => chatPoints().length === 8, 'all local embeddings reach the chat-log collection');
assert.equal(chatPoints().length, 8, 'only eight local messages embedded');
assert.ok(chatPoints().every(point => channels.includes(point.payload.channel_id)
    && !point.payload.message.includes('foreign')), 'chat embeddings retain the local owner and text');
// Signed foreign notifications cannot enter the domain journal or any module fanout.
const notification = channelID => generateTestPayload('channel.chat.notification', channelID);
const beforeNotices = chat().length;
for (const [origin, receiver] of [channels, [...channels].reverse()]) {
    const payload = notification(receiver);
    payload.event.source_broadcaster_user_id = origin;
    payload.event.is_source_only = true;
    const receipt = await send(payload);
    assert.equal(await DomainEventSchema.countDocuments({ sourceEventId: receipt }), 0);
}
await pause(250);
assert.equal(chat().length, beforeNotices);
async function complete(event) {
    if (target === 'cron') {
        await until(async () => ['succeeded', 'skipped'].includes((await DomainEventDeliverySchema.findOne({
            eventKey: event.eventKey, consumer: 'chat-announcements-v1' }).lean())?.status), `real delivery ${event.sourceEventId}`);
    } else await applyChatAnnouncementDomainEvent(event);
}
for (const source of [undefined, null, '', channels[0]]) {
    const payload = notification(channels[0]);
    payload.event.source_broadcaster_user_id = source;
    payload.event.is_source_only = false;
    const before = chat().length;
    const receipt = await send(payload);
    const stored = await DomainEventSchema.findOne({ sourceEventId: receipt }).lean();
    assert.ok(stored);
    await complete(stored);
    assert.equal(chat().length, before + 1);
    assert.equal(chat().at(-1).chat.broadcaster_id, channels[0]);
}
// Simulate a retained pre-fix foreign notice without passing through today's normalizer.
const normalized = normalizeTwitchEventsubDomainEvent({ messageId: 'retained-foreign', subscription: notification(channels[1]).subscription,
    event: notification(channels[1]).event, durableChatHandled: true });
const retained = await DomainEventSchema.create({ ...normalized, eventKey: 'fixture:retained-foreign',
    occurredAt: new Date(), journaledAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), dispatchPending: true,
    payload: { ...normalized.payload, event: { ...normalized.payload.event, source_broadcaster_user_id: channels[0] } } });
const beforeRetained = chat().length;
await complete(retained.toObject());
await applyChatAnnouncementDomainEvent(retained.toObject());
await applyChatAnnouncementDomainEvent(retained.toObject());
assert.equal(chat().length, beforeRetained, 'retained/retried foreign notices remain silent');
for (const call of chat()) assert.equal(call.chat.for_source_only, true, 'all app-token replies explicitly stay in their own channel');
console.log(`PASS ${target}: bidirectional foreign isolation before TTS/keywords/history/cooldowns/analytics/embeddings; eight local speech calls; null/missing/empty/same origins; notification journal exclusion and retained retries; source-only replies. Speech is a mocked chargeable boundary, not a real billing debit.`);
if (server) await new Promise(resolve => server.close(resolve));
await mongoose.disconnect();
await redis.quit();
process.exit(0);
