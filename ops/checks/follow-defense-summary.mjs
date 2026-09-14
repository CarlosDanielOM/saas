import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { FollowDefenseSettingsSchema as Settings } from '/app/dist/schemas/follow_defense_settings.schema.js';
import { default as Eventsub } from '/app/dist/schemas/eventsub.schema.js';
import { DomainEventDeliverySchema as Deliveries } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { normalizeTwitchEventsubDomainEvent } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { journalDomainEvent } from '/app/dist/utils/domain_events.js';
import { followDefenseKeys, projectFollowDefenseState, shouldSuppressFollowAlerts } from '/app/dist/utils/follow_defense_queue.js';
import { sendPendingFollowDefenseSummaries } from '/app/dist/utils/follow_defense_summary.js';
const mongo = await getMongoDBConnection('summary-check');
const redis = await getDragonflyClient('summary-check');
const channel = '533538623';
const keys = followDefenseKeys(channel);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl') ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const chat = () => calls().filter(call => call.chat && call.channel === channel);
const summaries = () => chat().filter(call => call.message.includes('additional follow') || call.message.includes('adicional'));
async function until(check, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do { if (await check()) return; await sleep(100); } while (Date.now() < deadline);
    throw new Error(`Timeout: ${label}`);
}
await Settings.create({ channelID: channel });
await Eventsub.create({ id: 'summary-fixture-config', status: 'enabled', version: '2', condition: { broadcaster_user_id: channel }, created_at: new Date().toISOString(), transport: { method: 'webhook', callback: 'https://fixture.invalid' }, cost: 0, channel: 'fixture', channelID: channel, type: 'channel.follow', enabled: true, message: 'Welcome {user}!', todayFollows: false });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'fixture', chat_enabled: 'true' });
await redis.set('app:twitch:token', 'dummy-app-token');
await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: 'fixture', chat_enabled: true }] });
async function mode(mode, expiresAt) {
    await projectFollowDefenseState(channel, { type: 'transition', state: {
        mode, channelID: channel, channelLogin: 'fixture', channelName: 'Fixture', modeStartedAt: Date.now(),
        burstStartedAt: Date.now(), expiresAt, triggeredBy: 'threshold', lastTransitionReason: 'summary-fixture', lastUpdatedAt: Date.now()
    } });
}

if (process.env.SAAS_TARGET === 'api') {
    await redis.hSet('token:summary-owner', { id: channel, login: 'fixture', display_name: 'Fixture' });
    await mode('silent', Date.now() + 60000);
    assert.equal(await shouldSuppressFollowAlerts(channel, 'reset-summary'), true);
    const result = await fetch(`http://127.0.0.1:3000/follow-defense/${channel}/reset`, {
        method: 'POST', headers: { Authorization: 'Bearer summary-owner', 'Content-Type': 'application/json' }
    });
    assert.equal(result.status, 200);
    assert.equal(await redis.get(keys.summary), null);
    assert.equal(await redis.zScore(keys.summaries, channel), null);
    assert.equal(await shouldSuppressFollowAlerts(channel, 'reset-summary'), true, 'Reset does not replay an already suppressed individual message');
    assert.equal(await sendPendingFollowDefenseSummaries(), 0);
    console.log('PASS API: authenticated Reset cancels pending summary and preserves individual suppression receipts');
    process.exit(0);
}

if (process.env.SAAS_TARGET === 'bot') {
    const { followHandler } = await import('/app/dist/handlers/follow.handler.js');
    const follow = { broadcaster_user_id: channel, broadcaster_user_login: 'fixture', broadcaster_user_name: 'Fixture', user_id: 'legacy-user', user_login: 'viewer', user_name: 'Viewer', followed_at: new Date().toISOString() };
    const config = { message: 'Welcome {user}!', todayFollows: false };
    await mode('silent', Date.now() + 60000);
    assert.equal((await followHandler(follow, config, true, { durableDefenseHandled: true })).error, false);
    await followHandler(follow, config, true, { durableDefenseHandled: true });
    await followHandler({ ...follow, user_id: 'empty' }, { message: '' }, true, { durableDefenseHandled: true });
    await followHandler({ ...follow, user_id: 'disabled' }, config, false, { durableDefenseHandled: true });
    assert.equal(JSON.parse(await redis.get(keys.summary)).count, 1, 'legacy retries/empty/disabled messages do not inflate count');
    assert.equal(chat().length, 0);
    console.log('PASS BOT: real legacy handler records actual suppression, stable retry identity, empty/disabled message exclusions');
    process.exit(0);
}

async function publish(id) {
    const normalized = normalizeTwitchEventsubDomainEvent({
        messageId: id, messageTimestamp: new Date().toISOString(), durableChatHandled: true,
        subscription: { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: channel, moderator_user_id: '698614112' } },
        event: { broadcaster_user_id: channel, broadcaster_user_login: 'fixture', broadcaster_user_name: 'Fixture', user_id: id, user_login: id, user_name: id, followed_at: new Date().toISOString() }
    });
    return (await journalDomainEvent(normalized)).event.eventKey;
}
const announced = await Promise.all(Array.from({ length: 10 }, (_, i) => publish(`announced-${i}`)));
await until(() => chat().length === 10, 'first ten ordinary follow announcements');
const end = Date.now() + 5000;
await mode('silent', end);
const suppressed = await Promise.all(Array.from({ length: 10 }, (_, i) => publish(`suppressed-${i}`)));
await until(async () => await Deliveries.countDocuments({ consumer: 'chat-announcements-v1', eventKey: { $in: suppressed }, status: 'succeeded' }) === 10, 'global consumer suppresses remaining ten');
assert.equal(chat().length, 10);
assert.equal(JSON.parse(await redis.get(keys.summary)).count, 10);
// A redelivered event is suppressed and counted exactly once even outside the pipeline receipt.
for (const event of suppressed) assert.equal(await shouldSuppressFollowAlerts(channel, event), true);
// Protection may be tracking a recognized raid. A mode upgrade must not discard acknowledgement.
await mode('protection', end + 1000);
await until(() => summaries().length === 1, 'actual maintenance worker sends summary after cooldown');
assert.equal(summaries()[0].message, '10 additional follows were received while announcements were paused. Thanks for following!');
assert.ok(summaries()[0].at >= end + 1000, 'summary waits for the upgraded cooldown');
assert.equal(chat().length, 11);
await sleep(1200);
assert.equal(summaries().length, 1);
assert.equal(await redis.get(keys.summary), null);
assert.equal(await shouldSuppressFollowAlerts(channel, suppressed[0]), true, 'late replay remains individually suppressed');

// Large exact count on real Redis; records remain available when the live mode is cleared.
await mode('protection', Date.now() + 60000);
for (let offset = 0; offset < 4900; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 4900 - offset) }, (_, i) => shouldSuppressFollowAlerts(channel, `large-${offset + i}`)));
}
assert.equal(JSON.parse(await redis.get(keys.summary)).count, 4900);
await redis.del(keys.state);
const record = JSON.parse(await redis.get(keys.summary));
await redis.set(keys.summary, JSON.stringify({ ...record, notBefore: Date.now() }));
await redis.zAdd(keys.summaries, { score: Date.now(), value: channel });
await until(() => summaries().length === 2, 'large aggregate survives mode cleanup');
assert.match(summaries()[1].message, /^4,900 additional follows/);
assert.equal(calls().filter(call => call.user).length, 0, 'summary never invokes moderation');
console.log('PASS CRON: real journal/chat consumer, 10 announced + 10 suppressed, retry dedupe, mode upgrade and cooldown, one summary, 4900 exact aggregate, mode cleanup, no bans');
process.exit(0);
