// Chat alerts leave an owner-only activity row whether they were sent or skipped.
// Run on the cron target (the domain-events worker runs the chat-announcements-v1 consumer):
//   scripts/saas-ops verify cron-<run-id> --check ops/checks/admin-console-alert-activity.mjs \
//     --dependency mongo --dependency redis \
//     --test-env ops/checks/admin-console-alert-activity-fixtures/test-env.json \
//     --fixtures ops/checks/admin-console-alert-activity-fixtures
// Three follows arrive through the real signed webhook: one for a channel with the follow alert on,
// one with it turned off and one where the bot's chat is off. The real consumer handles them and the
// check reads the three `alert` rows back from `activity_logs`.
// Outside the cron target the consumer is applied inline. Locally: APP_DIST=<dimabot>/src FIXTURES_DIR=<dir>,
// with the fixtures' providers.mjs preloaded so nothing reaches Twitch.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const dist = process.env.APP_DIST || '/app/dist';
const target = process.env.SAAS_TARGET || '';
const viaCron = target === 'cron';
const load = path => import(`${dist}/${path}`);
const { getMongoDBConnection } = await load('utils/databases/mongodb.database.js');
const { getDragonflyClient } = await load('utils/databases/dragonfly.database.js');
const { default: UsersSchema } = await load('schemas/users.schema.js');
const { default: EventsubSchema } = await load('schemas/eventsub.schema.js');
const { DomainEventSchema } = await load('schemas/domain_event.schema.js');
const { DomainEventDeliverySchema } = await load('schemas/domain_event_delivery.schema.js');
const { ActivityLog } = await load('schemas/activity_log.schema.js');
const { flushActivityLog } = await load('utils/activity_log.js');
const { generateTestPayload } = await load('utils/eventsub.test-data.js');
const { createTwitchEventsubApp } = await load('bot/eventsub.twitch.js');
const { applyChatAnnouncementDomainEvent } = await load('domain_events/chat_announcement_events.js');

const directory = process.env.FIXTURES_DIR || '/tmp/saas-fixtures';
const calls = () => fs.existsSync(`${directory}/calls.jsonl`)
    ? fs.readFileSync(`${directory}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(check, label, ms = 40_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail(`Timed out: ${label}`);
}

const mongo = await getMongoDBConnection('AlertActivityCheck');
const redis = await getDragonflyClient('AlertActivityCheck');
await Promise.all([DomainEventSchema.init(), DomainEventDeliverySchema.init(), EventsubSchema.init(), ActivityLog.init()]);
if (viaCron) {
    await until(() => calls().some(call => call.worker?.endsWith('/domain_events.worker.js'))
        && calls().some(call => call.consumer === 'chat-announcements-v1'), 'real chat-announcements consumer started');
}

const TEMPLATE = 'Welcome $(user), thanks for the follow!';
const channels = [
    { id: '99007701', login: 'alerton', chat: true, enabled: true, viewer: 'firstviewer' },
    { id: '99007702', login: 'alertoff', chat: true, enabled: false, viewer: 'secondviewer' },
    { id: '99007703', login: 'chatoff', chat: false, enabled: true, viewer: 'thirdviewer' }
];
for (const channel of channels) {
    await UsersSchema.create({ name: channel.login, accounts: [{ type: 'twitch', id: channel.id, name: channel.login,
        actived: true, has_permissions: true, chat_enabled: channel.chat }] });
    await redis.hSet(`accounts:twitch:${channel.id}:data`, {
        id: channel.id, name: channel.login, actived: 'true', has_permissions: 'true', chat_enabled: String(channel.chat),
        access_token: 'dummy-streamer-token', expires_at: String(Math.floor(Date.now() / 1000) + 3600)
    });
    await EventsubSchema.create({ id: `follow-${channel.id}`, status: 'enabled', type: 'channel.follow', version: '2',
        condition: { broadcaster_user_id: channel.id, moderator_user_id: '698614112' }, created_at: new Date().toISOString(),
        transport: { method: 'webhook', callback: 'https://subscriptions.domdimabot.com/eventsub' }, cost: 0,
        channel: channel.login, channelID: channel.id, enabled: channel.enabled, message: TEMPLATE, endMessage: '',
        endEnabled: false, minViewers: 0, temporalBanMessage: '', clipEnabled: false, delay: 0, cheerTiers: [] });
}
const priorAppToken = await redis.get('app:twitch:token');
await redis.set('app:twitch:token', 'app-token');

const server = createTwitchEventsubApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const webhookURL = `http://127.0.0.1:${server.address().port}/eventsub`;
async function send(payload, messageId) {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
        .update(messageId).update(timestamp).update(body).digest('hex');
    return fetch(webhookURL, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': messageId, 'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Type': 'notification', 'Twitch-Eventsub-Message-Signature': signature
    }, body });
}

const keys = {};
for (const [index, channel] of channels.entries()) {
    const payload = generateTestPayload('channel.follow', channel.id);
    Object.assign(payload.event, { user_id: `4200${index}`, user_login: channel.viewer, user_name: channel.viewer,
        followed_at: new Date().toISOString() });
    const messageId = `alert-activity-follow-${channel.id}`;
    assert.equal((await send(payload, messageId)).status, 204);
    assert.equal((await send(payload, messageId)).status, 204, 'a duplicate delivery is acknowledged');
    const event = await DomainEventSchema.findOne({ sourceEventId: messageId }).lean();
    assert.ok(event, `follow journaled for ${channel.login}`);
    assert.equal(event.metadata.durableChatHandled, true);
    keys[channel.id] = event.eventKey;
    if (!viaCron) await applyChatAnnouncementDomainEvent(event);
}
assert.equal(await DomainEventSchema.countDocuments({ sourceEventId: /^alert-activity-follow-/ }), 3);

if (viaCron) {
    for (const channel of channels) {
        await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'chat-announcements-v1',
            eventKey: keys[channel.id] }).lean())?.status === 'succeeded', `chat-announcements delivery for ${channel.login}`);
    }
} else {
    await flushActivityLog();
}
// The consumer writes its rows in batches about once a second.
await until(async () => await ActivityLog.countDocuments({ kind: 'alert', channelID: { $in: channels.map(channel => channel.id) } }) >= 3,
    'three alert rows written', 15_000);

const rows = await ActivityLog.find({ kind: 'alert', channelID: { $in: channels.map(channel => channel.id) } }).lean();
assert.equal(rows.length, 3, 'one alert row per follow, duplicates included');
const byChannel = Object.fromEntries(rows.map(row => [row.channelID, row]));
const [on, off, chatOff] = channels.map(channel => byChannel[channel.id]);
for (const [index, channel] of channels.entries()) {
    const row = byChannel[channel.id];
    assert.ok(row, `alert row for ${channel.login}`);
    assert.equal(row.name, 'channel.follow');
    assert.equal(row.ref, keys[channel.id]);
    assert.equal(row.actorLogin, channel.viewer);
    assert.equal(row.actorID, `4200${index}`);
    if (viaCron) assert.equal(row.service, 'cron');
    assert.ok(row.expiresAt.getTime() > Date.now() + 29 * 86_400_000);
}
assert.equal(on.outcome, 'ok');
assert.equal(on.reason, '');
// Alert rows carry no text: the rendered line is on the bot_message row the send wrote.
assert.equal(on.text, '');
assert.deepEqual([off.outcome, off.reason, off.text], ['skipped', 'alert_disabled', '']);
assert.deepEqual([chatOff.outcome, chatOff.reason, chatOff.text], ['skipped', 'chat_disabled', '']);

const sent = calls().filter(call => call.chat);
assert.equal(sent.length, 1, 'only the channel with the alert on and chat on announced');
assert.equal(sent[0].chat.broadcaster_id, channels[0].id);
assert.equal(sent[0].chat.message, 'Welcome firstviewer, thanks for the follow!');
// Follows are journaled, so the webhook itself writes no twitch_event row for them.
assert.equal(await ActivityLog.countDocuments({ kind: 'twitch_event', channelID: { $in: channels.map(channel => channel.id) } }), 0);

console.log(`PASS ${target || 'inline'}: follow alert rows ok / skipped alert_disabled / skipped chat_disabled, keyed by event key, one row per event`);
await new Promise(resolve => server.close(resolve));
if (process.env.APP_DIST) {
    // Local runs share a test Dragonfly: remove only what this check created.
    for (const channel of channels) {
        for await (const batch of redis.scanIterator({ MATCH: `*${channel.id}*`, COUNT: 500 })) {
            for (const key of [batch].flat()) await redis.del(key);
        }
    }
    if (priorAppToken === null) await redis.del('app:twitch:token');
    else await redis.set('app:twitch:token', priorAppToken);
    await mongo.connection.db.dropDatabase();
}
await mongo.disconnect();
await redis.quit();
process.exit(0);
