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
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';
import { getFunctionMetadata } from '/app/dist/utils/ast_parser/evaluator.js';
import { findAstCatalogEntry } from '/app/dist/utils/ai/ast_catalog/index.js';
import { applyChatAnnouncementDomainEvent } from '/app/dist/domain_events/chat_announcement_events.js';
import { eventsubHandler } from '/app/dist/handlers/eventsub.handler.js';

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
async function completeAnnouncement(receipt) {
    const event = await DomainEventSchema.findOne({ sourceEventId: receipt }).lean();
    assert.ok(event);
    if (target === 'cron') {
        await until(async () => ['succeeded', 'skipped'].includes((await DomainEventDeliverySchema.findOne({
            eventKey: event.eventKey, consumer: 'chat-announcements-v1'
        }).lean())?.status), `chat delivery completed: ${receipt}`);
    } else {
        await applyChatAnnouncementDomainEvent(event);
    }
}
const payload = generateTestPayload('channel.chat.notification', channelID);
payload.subscription.id = storedSubscription.id;
const renderStreak = async eventData => (await parseSpecialCommands('$(user) has watched $(twitch.streak) consecutive streams!',
    { channelID, eventData, scopeType: 'event', scopeName: 'channel.chat.notification' })).parsedText;
assert.equal(await renderStreak(payload.event), 'TestViewer has watched 5 consecutive streams!');
assert.equal(getFunctionMetadata('twitch.streak')?.category, 'event-data');
assert.equal(findAstCatalogEntry('twitch.streak')?.syntax, 'twitch.streak');
assert.deepEqual(getFunctionMetadata('twitch.streak')?.surfaces, ['authoring']);
assert.equal((await parseSpecialCommands('*($(twitch.streak) + 1)', { channelID, eventData: payload.event })).parsedText, '6');
for (const eventData of [{}, { watch_streak: null }, { watch_streak: { streak_count: -1 } },
    { watch_streak: { streak_count: '5' } }, { notice_type: 'resub', resub: { streak_months: 12 } }]) {
    assert.equal((await parseSpecialCommands('$(twitch.streak)', { channelID, eventData })).parsedText, '0');
}
const challenge = await send({ subscription: payload.subscription, challenge: 'test-challenge' }, 'challenge', { messageType: 'webhook_callback_verification' });
assert.equal(challenge.status, 200);
assert.equal(await challenge.text(), 'test-challenge');
assert.equal((await send(payload, 'watch-streak')).status, 204);
assert.equal((await send(payload, 'watch-streak')).status, 204, 'duplicate delivery acknowledged');
await completeAnnouncement('watch-streak');
assert.deepEqual(calls().filter(call => call.chat).map(call => call.chat.message), ['TestViewer has a streak of 5 days!']);
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
        consumer: { $in: ['follow-defense-v1', 'stream-operations-v1'] } }), 0);
    assert.equal(await DomainEventDeliverySchema.countDocuments({ consumer: 'chat-announcements-v1',
        eventKey: { $in: (await DomainEventSchema.find({ sourceEventId: { $in: ['resub-notice', 'anonymous-notice'] } }).lean()).map(event => event.eventKey) } }), 0);
    await completeAnnouncement('retried-notice');
}
assert.equal(calls().filter(call => call.chat).length, 1, 'duplicate, non-streak and stale notices do not announce');
await UsersSchema.updateOne({ _id: owner._id }, { $set: { language: 'es' } });
assert.equal((await send(payload, 'spanish-streak')).status, 204);
await completeAnnouncement('spanish-streak');
assert.equal(calls().filter(call => call.chat).at(-1).chat.message, '¡TestViewer tiene una racha de 5 días!');
await EventsubSchema.updateOne({ _id: storedSubscription._id }, { $set: { message: 'Custom $(user): $(twitch.streak)' } });
assert.equal((await send(payload, 'custom-streak')).status, 204);
await completeAnnouncement('custom-streak');
assert.equal(calls().filter(call => call.chat).at(-1).chat.message, 'Custom TestViewer: 5');
await EventsubSchema.updateOne({ _id: storedSubscription._id }, { $set: { enabled: false } });
assert.equal((await send(payload, 'disabled-streak')).status, 204);
await completeAnnouncement('disabled-streak');
assert.equal(calls().filter(call => call.chat).length, 3, 'disabled announcement is silent');
await EventsubSchema.updateOne({ _id: storedSubscription._id }, { $set: { enabled: true, message: '' } });
await redis.hSet(`accounts:twitch:${channelID}:data`, 'chat_enabled', 'false');
assert.equal((await send(payload, 'chat-disabled-streak')).status, 204);
await completeAnnouncement('chat-disabled-streak');
assert.equal(calls().filter(call => call.chat).length, 3, 'disabled channel chat is silent');
await redis.hSet(`accounts:twitch:${channelID}:data`, 'chat_enabled', 'true');
if (target === 'api') {
    await eventsubHandler(payload.subscription, payload.event);
    assert.equal(calls().filter(call => call.chat).at(-1).chat.message, '¡TestViewer tiene una racha de 5 días!', 'manual event test uses localized default');
}
console.log(`PASS ${target}: streak AST, EN/ES default announcements, custom templates, disabled settings, webhook signatures, journaling, dedupe, and other-notice/stale suppression`);
if (server) await new Promise(resolve => server.close(resolve));
await mongoose.disconnect();
await redis.quit();
process.exit(0);
