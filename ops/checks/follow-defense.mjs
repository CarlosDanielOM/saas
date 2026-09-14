import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import * as queue from '/app/dist/utils/follow_defense_actions.js';
import { processDurableFollowDefenseFollow } from '/app/dist/utils/follow_defense.js';
import { projectFollowDefenseState } from '/app/dist/utils/follow_defense_queue.js';
import { FollowDefenseActionSchema as Actions, FollowDefenseControlSchema as Controls } from '/app/dist/schemas/follow_defense_action.schema.js';
import { FollowDefenseSettingsSchema as Settings } from '/app/dist/schemas/follow_defense_settings.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { normalizeTwitchEventsubDomainEvent } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { journalDomainEvent } from '/app/dist/utils/domain_events.js';
const mongo = await getMongoDBConnection('defense-check');
const redis = await getDragonflyClient('defense-check');
await Promise.all([Actions.init(), Controls.init(), Settings.init()]);
const channel = '533538623';
const other = '533538624';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do { if (await check()) return; await sleep(100); } while (Date.now() < deadline);
    throw new Error(`Timeout: ${label}`);
}
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl') ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const follow = (id, channelID = channel) => ({ eventID: id, channelID, channelLogin: 'fixture', channelName: 'Fixture', followerID: id, followerLogin: 'viewer', followerName: 'Viewer', followedAt: new Date().toISOString(), receivedAt: Date.now() });
for (const id of [channel, other]) {
    await Settings.create({ channelID: id });
    await redis.hSet(`accounts:twitch:${id}:data`, { id, name: 'fixture', chat_enabled: 'false' });
}
await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'dummy-token', expires_at: String(Math.floor(Date.now() / 1000) + 36000) });
await redis.set('app:twitch:token', 'dummy-app-token');
await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: 'fixture' }] });

if (process.env.SAAS_TARGET === 'bot') {
    await until(async () => {
        try { return (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; }
        catch { return false; }
    }, 'bot webhook ready');
    const { ban, banRateLimitHeaders } = await import('/app/dist/functions/moderation/ban.moderation.js');
    const result = await ban(channel, 'bot-transport-test', '698614112');
    assert.equal(result.error, false);
    assert.equal(result.rateLimitRemaining, 500);
    assert.ok(calls().some(call => call.user === 'bot-transport-test' && call.moderator === '698614112'));
    assert.equal(banRateLimitHeaders(new Headers({ 'Retry-After': '60' })).retryAfterMs, 60000);
    console.log('PASS BOT: actual webhook startup, unsigned rejection, unchanged ban call signature, bot identity, rate-limit metadata');
    process.exit(0);
}

if (process.env.SAAS_TARGET === 'api') {
    await redis.hSet('token:defense-owner', { id: channel, login: 'fixture', display_name: 'Fixture' });
    const pending = follow('reset-me');
    await queue.enqueueFollowDefenseBan(pending, 'DimaBot follow defense protection mode');
    const request = (path, options = {}) => fetch(`http://127.0.0.1:3000/follow-defense/${channel}/${path}`, {
        ...options, headers: { Authorization: 'Bearer defense-owner', 'Content-Type': 'application/json' }
    });
    const status = await request('status');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.moderationQueue.pending, 1);
    assert.equal((await request('reset', { method: 'POST' })).status, 200);
    assert.equal((await Actions.findById(queue.defenseActionID(channel, 'reset-me')).lean()).status, 'cancelled');
    // Late enqueue after Reset is still fenced before execution.
    await queue.enqueueFollowDefenseBan({ ...pending, eventID: 'late-reset', followerID: 'late-reset' }, 'DimaBot follow defense protection mode');
    await queue.processFollowDefenseAction(async () => assert.fail('Reset must fence the late enqueue'));
    assert.equal((await Actions.findById(queue.defenseActionID(channel, 'late-reset')).lean()).status, 'cancelled');
    await sleep(5);
    await queue.enqueueFollowDefenseBan(follow('disable-me'), 'DimaBot follow defense protection mode');
    assert.equal((await request('settings', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status, 200);
    assert.equal((await Actions.findById(queue.defenseActionID(channel, 'disable-me')).lean()).status, 'cancelled');
    assert.equal((await fetch(`http://127.0.0.1:3000/follow-defense/${channel}/reset`, { method: 'POST' })).status, 401);
    console.log('PASS API: readiness, queue status, authenticated Reset, late enqueue fence, disable cancellation, unauthenticated rejection');
    process.exit(0);
}

await until(() => calls().some(call => call.ready), 'cron action worker ready');
const workerPID = calls().findLast(call => call.ready).ready;
const slow = follow('slow-first');
await queue.enqueueFollowDefenseBan(slow, 'DimaBot follow defense protection mode');
await until(() => calls().some(call => call.user === 'slow-first'), 'worker calls mock Twitch');
await projectFollowDefenseState(channel, { type: 'transition', state: {
    mode: 'protection', channelID: channel, channelLogin: 'fixture', channelName: 'Fixture',
    modeStartedAt: Date.now() - 1000, burstStartedAt: Date.now() - 1000, expiresAt: Date.now() + 60000,
    triggeredBy: 'threshold', lastTransitionReason: 'fixture', lastUpdatedAt: Date.now()
} });
// Exercise actual journal -> dispatcher -> defense consumer while the action worker is blocked.
const normalized = normalizeTwitchEventsubDomainEvent({
    messageId: 'pipeline-defense-test', messageTimestamp: new Date().toISOString(), durableDefenseHandled: true,
    subscription: { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: channel, moderator_user_id: '698614112' } },
    event: { broadcaster_user_id: channel, broadcaster_user_login: 'fixture', broadcaster_user_name: 'Fixture', user_id: 'pipeline-user', user_login: 'viewer', user_name: 'Viewer', followed_at: new Date().toISOString() }
});
assert.ok(normalized);
const journaled = await journalDomainEvent(normalized);
await until(() => Actions.exists({ eventID: journaled.event.eventKey, kind: 'ban' }), 'global pipeline records ban while Twitch is slow', 3500);
assert.equal((await Actions.findById(queue.defenseActionID(channel, 'slow-first')).lean()).status, 'processing', 'detection proceeds independently of the moderation request');
await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'follow-defense-v1', eventKey: journaled.event.eventKey }).lean())?.status === 'succeeded', 'defense delivery acknowledged');
await queue.cancelFollowDefenseActions(channel);
await until(async () => (await Actions.findById(queue.defenseActionID(channel, 'slow-first')).lean()).status === 'succeeded', 'in-flight mock request completes');

// Verify independent-process restart and persisted pacing with real background execution.
process.kill(workerPID, 'SIGKILL');
await until(() => calls().some(call => call.ready && call.ready !== workerPID), 'cron supervisor restarts action worker', 15000);
await sleep(10);
await queue.enqueueFollowDefenseBan(follow('pace-a1'), 'DimaBot follow defense protection mode');
await queue.enqueueFollowDefenseBan(follow('pace-a2'), 'DimaBot follow defense protection mode');
await queue.enqueueFollowDefenseBan(follow('pace-b1', other), 'DimaBot follow defense protection mode');
await until(() => calls().filter(call => call.user?.startsWith('pace-')).length === 3, 'fair paced worker drain', 75000);
const paced = calls().filter(call => call.user?.startsWith('pace-'));
for (let i = 1; i < paced.length; i++) assert.ok(paced[i].at - paced[i - 1].at >= 490, 'global pacing');
const sameChannel = paced.filter(call => call.channel === channel);
assert.ok(sameChannel[1].at - sameChannel[0].at >= 990, 'per-channel pacing');
assert.ok(paced.findIndex(call => call.channel === other) < 2, 'second channel served before first drains');
assert.ok(paced.every(call => call.moderator === '698614112'));
await until(async () => await Actions.countDocuments({ eventID: /^pace-/, status: 'succeeded' }) === 3, 'outcomes persisted');

// Pause only this disposable worker while probing Mongo leases/failures deterministically.
const restartedPID = calls().findLast(call => call.ready).ready;
process.kill(restartedPID, 'SIGSTOP');
try {
    await Actions.deleteMany({}); await Controls.deleteMany({});
    await queue.enqueueFollowDefenseBans(Array.from({ length: 500 }, (_, i) => follow(`wave-${i}`)), 'DimaBot follow defense attack mode');
    const initialDeadline = (await Actions.findById(queue.defenseActionID(channel, 'wave-0')).lean()).expiresAt.getTime();
    await queue.enqueueFollowDefenseBans(Array.from({ length: 500 }, (_, i) => follow(`wave-${i}`)), 'DimaBot follow defense attack mode');
    assert.equal(await Actions.countDocuments(), 500, 'bulk acceptance and dedupe');
    assert.equal((await Actions.findById(queue.defenseActionID(channel, 'wave-0')).lean()).expiresAt.getTime(), initialDeadline, 'duplicate admission never extends the execution deadline');
    await queue.cancelFollowDefenseActions(channel);
    assert.equal(await Actions.countDocuments({ status: 'cancelled' }), 500);
    await Actions.deleteMany({}); await Controls.deleteMany({});
    const rate = follow('rate-test');
    await queue.enqueueFollowDefenseBan(rate, 'DimaBot follow defense protection mode');
    let requests = 0;
    await queue.processFollowDefenseAction(async () => { requests++; return { error: true, status: 429, message: 'limited', retryAfterMs: 60000 }; });
    const rateJob = await Actions.findById(queue.defenseActionID(channel, rate.eventID)).lean();
    assert.equal(rateJob.status, 'pending'); assert.equal(rateJob.failures, 0);
    assert.ok(rateJob.nextAttemptAt.getTime() >= Date.now() + 59000);
    await queue.processFollowDefenseAction(async () => { requests++; return { error: false, message: 'unexpected' }; });
    assert.equal(requests, 1, 'persisted rate pause survives a new processor invocation');
    await Controls.updateMany({}, { $set: { nextAllowedAt: new Date(0) } });
    await Actions.updateOne({ _id: rateJob._id }, { $set: { nextAttemptAt: new Date(0), status: 'processing', lockedUntil: new Date(0), leaseToken: 'dead-worker', followedAt: new Date(Date.now() - 120000) } });
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const first = queue.processFollowDefenseAction(async () => { requests++; await blocked; return { error: true, status: 400, message: 'The user specified in the user_id field is already banned.' }; });
    await until(() => requests === 2, 'expired processing claim recovered');
    assert.equal(await queue.processFollowDefenseAction(async () => assert.fail('Concurrent executor must not send')), false);
    release(); await first;
    assert.equal((await Actions.findById(rateJob._id).lean()).status, 'succeeded', 'recorded fresh decision survives original 60s age and recovers response loss');
    await Actions.deleteMany({}); await Controls.deleteMany({});
    await queue.enqueueFollowDefenseBan(follow('expired'), 'DimaBot follow defense protection mode');
    await Actions.updateMany({}, { $set: { expiresAt: new Date(0) } });
    await queue.processFollowDefenseAction(async () => assert.fail('Expired jobs never execute'));
    assert.equal((await Actions.findOne().lean()).status, 'expired');
    await Actions.deleteMany({}); await Controls.deleteMany({});
    await queue.enqueueFollowDefenseBan(follow('disabled'), 'DimaBot follow defense protection mode');
    await Settings.updateOne({ channelID: channel }, { $set: { enabled: false } });
    await queue.processFollowDefenseAction(async () => assert.fail('Disabled defense never executes'));
    assert.equal((await Actions.findOne().lean()).status, 'cancelled');
} finally { process.kill(restartedPID, 'SIGCONT'); }
console.log('PASS CRON: real journal/consumer during slow Twitch, worker restart, persisted outcomes, bot identity, global/channel pacing, fairness, 500-job bulk dedupe, cancellation, 429, lease recovery/exclusion, already-banned, delayed execution, expiry, disable');
process.exit(0);
