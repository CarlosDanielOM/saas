import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { SUBSCRIPTION_TYPES } from '/app/dist/utils/eventsub.js';
import { buildExpectedEventsubCondition } from '/app/dist/utils/eventsub_condition.js';
import { reconcileEventsubs } from '/app/dist/utils/eventsub_reconciliation.js';
import { generateTestPayload } from '/app/dist/utils/eventsub.test-data.js';
import { validateDomainEventContract } from '/app/dist/domain_events/domain_event_contracts.js';
import { createTwitchEventsubApp } from '/app/dist/bot/eventsub.twitch.js';

const channelID = '99003301';
const target = process.env.SAAS_TARGET;
const directory = '/tmp/saas-fixtures';
const calls = () => fs.existsSync(`${directory}/calls.jsonl`)
    ? fs.readFileSync(`${directory}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(check, label) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail(`Timed out: ${label}`);
}

await getMongoDBConnection('ChatNotificationCheck');
const redis = await getDragonflyClient('ChatNotificationCheck');
await Promise.all([DomainEventSchema.init(), DomainEventDeliverySchema.init(), EventsubSchema.init()]);
const owner = await UsersSchema.create({ name: 'Notice Fixture', accounts: [{ type: 'twitch', id: channelID,
    name: 'noticefixture', actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${channelID}:data`, {
    id: channelID, name: 'noticefixture', actived: 'true', has_permissions: 'true', chat_enabled: 'true',
    access_token: 'dummy-streamer-token', expires_at: String(Math.floor(Date.now() / 1000) + 3600)
});
await redis.set('app:twitch:token', 'app-token');

// Other subscription types are already healthy; reconciliation should create
// precisely one missing chat-notification subscription, using the bot identity.
const remote = SUBSCRIPTION_TYPES.filter(subscription => subscription.type !== 'channel.chat.notification')
    .map((subscription, i) => ({ id: `existing-${i}`, type: subscription.type, version: subscription.version,
        condition: buildExpectedEventsubCondition(subscription, channelID), status: 'enabled',
        transport: { method: 'webhook', callback: 'https://subscriptions.domdimabot.com/eventsub' },
        created_at: new Date().toISOString(), cost: 0 }));
fs.writeFileSync(`${directory}/remote.json`, JSON.stringify(remote));
const result = await reconcileEventsubs({ requestDelayMs: 0 });
assert.deepEqual(result.errors, []);
assert.equal(result.subscriptionsCreated, 1);
const storedSubscription = await EventsubSchema.findOne({ channelID, type: 'channel.chat.notification' }).lean();
assert.ok(storedSubscription);
assert.deepEqual(storedSubscription.condition, { broadcaster_user_id: channelID, user_id: '698614112' });
const requests = calls().filter(call => call.subscription);
assert.equal(requests.length, 1);
assert.equal(requests[0].authorization, 'Bearer app-token');
assert.equal(requests[0].subscription.type, 'channel.chat.notification');
assert.equal(requests[0].subscription.version, '1');
assert.equal(requests[0].subscription.transport.method, 'webhook');
assert.equal((await reconcileEventsubs()).subscriptionsCreated, 0, 'second reconciliation is idempotent');

if (target === 'api') {
    const response = await fetch('http://127.0.0.1:3000/eventsubs/standard');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.standardTypes.filter(type => type.type === 'channel.chat.notification').length, 1);
}
if (target === 'cron') {
    await until(() => calls().some(call => call.worker?.endsWith('/domain_events.worker.js'))
        && calls().some(call => call.worker?.endsWith('/eventsub_reconciliation.worker.js')), 'real affected cron workers started');
}

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

async function send(payload, receipt, { timestamp = new Date().toISOString(), retry, invalidSignature = false, messageType = 'notification' } = {}) {
    const body = JSON.stringify(payload);
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
        .update(receipt).update(timestamp).update(body).digest('hex');
    return fetch(webhookURL, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': receipt,
        'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Type': messageType,
        'Twitch-Eventsub-Message-Signature': invalidSignature ? 'sha256=invalid' : signature,
        ...(retry ? { 'Twitch-Eventsub-Message-Retry': retry } : {})
    }, body });
}
const payload = generateTestPayload('channel.chat.notification', channelID);
payload.subscription.id = storedSubscription.id;
const challenge = await send({ subscription: payload.subscription, challenge: 'test-challenge' }, 'challenge', { messageType: 'webhook_callback_verification' });
assert.equal(challenge.status, 200);
assert.equal(await challenge.text(), 'test-challenge');
assert.equal((await send(payload, 'watch-streak')).status, 204);
assert.equal((await send(payload, 'watch-streak')).status, 204, 'duplicate delivery acknowledged');
assert.equal(await DomainEventSchema.countDocuments({ sourceEventId: 'watch-streak' }), 1);
const journaled = await DomainEventSchema.findOne({ sourceEventId: 'watch-streak' }).lean();
assert.equal(journaled.type, 'channel.chat.notification');
assert.equal(journaled.ownerUserId, String(owner._id));
assert.deepEqual(journaled.payload.event, payload.event);
assert.deepEqual(journaled.payload.subscription, payload.subscription);
validateDomainEventContract(journaled);

const resub = structuredClone(payload);
Object.assign(resub.event, { notice_type: 'resub', watch_streak: null, sub: null,
    resub: { cumulative_months: 10, duration_months: 0, streak_months: null, sub_plan: '1000',
        is_gift: false, gifter_is_anonymous: null, gifter_user_id: null, gifter_user_name: null, gifter_user_login: null },
    shared_chat_sub: null, source_badges: null, is_source_only: null });
assert.equal((await send(resub, 'resub-notice')).status, 204);
assert.deepEqual((await DomainEventSchema.findOne({ sourceEventId: 'resub-notice' }).lean()).payload.event, resub.event);
const anonymous = structuredClone(resub);
Object.assign(anonymous.event, { notice_type: 'sub_gift', chatter_is_anonymous: true,
    chatter_user_id: '', chatter_user_login: '', chatter_user_name: '', resub: null });
assert.equal((await send(anonymous, 'anonymous-notice')).status, 204);

assert.equal((await send(payload, 'forged-notice', { invalidSignature: true })).status, 403);
const malformed = structuredClone(payload);
malformed.event.watch_streak.streak_count = -1;
assert.equal((await send(malformed, 'malformed-notice')).status, 503, 'invalid contract rejected before journaling');
const old = new Date(Date.now() - 20 * 60_000).toISOString();
assert.equal((await send(payload, 'old-notice', { timestamp: old })).status, 403);
assert.equal((await send(payload, 'retried-notice', { timestamp: old, retry: '1' })).status, 204);
assert.equal((await DomainEventSchema.findOne({ sourceEventId: 'retried-notice' }).lean()).metadata.staleRetry, true);
assert.equal(await DomainEventSchema.countDocuments({ sourceEventId: { $in: ['forged-notice', 'malformed-notice', 'old-notice'] } }), 0);

if (target === 'cron') {
    await until(async () => (await DomainEventDeliverySchema.findOne({ eventKey: journaled.eventKey,
        consumer: 'stream-analytics-v1' }).lean())?.status === 'succeeded', 'real domain consumer accepts new event type');
    assert.equal(await DomainEventDeliverySchema.countDocuments({ eventKey: journaled.eventKey,
        consumer: { $in: ['chat-announcements-v1', 'follow-defense-v1', 'stream-operations-v1'] } }), 0);
}
assert.equal(calls().filter(call => call.chat).length, 0, 'chat notices do not send duplicate announcements');
console.log(`PASS ${target}: subscription registration/reconciliation, webhook signatures/challenge, full payload journaling, dedupe, stale retry, malformed input, and no duplicate effects`);
if (server) await new Promise(resolve => server.close(resolve));
await mongoose.disconnect();
await redis.quit();
process.exit(0);
