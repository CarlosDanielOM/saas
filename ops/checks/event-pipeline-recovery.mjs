// Exact-candidate checks using disposable Mongo/Dragonfly and blocked external providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';
import { StreamSessionSchema } from '/app/dist/schemas/stream_session.schema.js';
import { StreamOperationsReceipt, StreamOperationsReconciliation } from '/app/dist/schemas/stream_operations_receipt.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';
import { encrypt, decrypt } from '/app/dist/utils/crypto.js';
import { ingestDomainEvent } from '/app/dist/domain_events/domain_event_producers.js';
import { twitchEventsubProducer } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { applyStreamOperationsDomainEvent, enqueueStreamOperationsReconciliation, recoverStreamOperationsReconciliations } from '/app/dist/domain_events/stream_operations_events.js';
import { recordStreamOfflineEvent } from '/app/dist/utils/stream_analytics.js';
import { getChannelEditors } from '/app/dist/functions/channels/get_editors.channel.js';

const target = process.env.SAAS_TARGET;
await getMongoDBConnection('pipeline-recovery-check');
assert.equal(mongoose.connection.name, 'saas_ops_pipeline_recovery_test');
const redis = await getDragonflyClient('pipeline-recovery-check');
await Promise.all([StreamOperationsReceipt.init(), StreamOperationsReconciliation.init(), StreamSessionSchema.init(), DomainEventDeliverySchema.init(), DomainEventSchema.init()]);
const dir = '/tmp/saas-fixtures';
const mode = value => fs.writeFileSync(`${dir}/mode.json`, JSON.stringify(value));
const calls = () => fs.existsSync(`${dir}/calls.jsonl`) ? fs.readFileSync(`${dir}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const tokens = () => fs.existsSync(`${dir}/tokens.jsonl`) ? fs.readFileSync(`${dir}/tokens.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const until = async (check, label, timeout = 25000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
};
async function seed(id, { active = true, permissions = true, access = 'fixture-valid', name = 'fixture' + id } = {}) {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  await Users.collection.insertOne({ name, plan_tier: 'free', accounts: [{ type: 'twitch', id, name, actived: active, chat_enabled: false,
    has_permissions: permissions, up_to_date_permissions: permissions, access_token: encrypt(access), refresh_token: encrypt('fixture-refresh-' + id), access_token_expires_at: expiry }] });
  await redis.hSet(`accounts:twitch:${id}:data`, { id, name, actived: String(active), chat_enabled: 'false', plan_tier: 'free',
    has_permissions: String(permissions), up_to_date_permissions: String(permissions), access_token: access, refresh_token: 'fixture-refresh-' + id, expires_at: String(expiry) });
}
await redis.set('app:twitch:token', 'fixture-app');
if (target === 'api') assert.equal((await fetch('http://127.0.0.1:3000/config/site/analytics')).status, 200);
if (target === 'bot') await until(async () => { try { return (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch { return false; } }, 'actual bot webhook ready');

async function event(channel, type, at = new Date()) {
  const result = await ingestDomainEvent(twitchEventsubProducer, { messageId: crypto.randomUUID(), messageTimestamp: at.toISOString(),
    subscription: { id: 'fixture-' + type, type, version: '1' }, event: { broadcaster_user_id: channel, broadcaster_user_login: 'fixture',
      ...(type === 'stream.online' ? { id: crypto.randomUUID(), started_at: at.toISOString() } : {}) } });
  assert(result?.event); return result.event;
}
async function apply(e) {
  if (target === 'cron') {
    await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'stream-operations-v1', eventKey: e.eventKey }).lean())?.status === 'succeeded', 'real lifecycle consumer success');
  } else await applyStreamOperationsDomainEvent(e);
}

// Original production failure: disabled auth must not prevent Mongo admin refresh.
await seed('991901', { active: false, permissions: false, name: 'pipelinefixture' });
await AdminSchema.collection.insertOne({ channelID: '991901', adminID: '991910', adminName: 'fixtureadmin', actived: true, permissions: ['*'] });
mode({});
const disabled = await event('991901', 'stream.online');
await apply(disabled);
let receipt = await StreamOperationsReceipt.findById(disabled.eventKey).lean();
assert.equal(receipt.steps.admins.status, 'completed');
assert.equal(receipt.steps.editors.status, 'skipped');
assert.equal(receipt.steps.vips.status, 'skipped');
assert.equal(await redis.sIsMember('twitch:991901:admins', 'fixtureadmin'), 1);
assert(!calls().some(c => c.path === '/helix/channels/editors' && c.query.includes('991901')));
console.log('PASS disabled authorization: explicit skips and independent admin refresh in actual consumer.');

// An editor provider outage must not block other work; retry preserves prior receipts.
await seed('991902'); mode({ editors: 'temporary' });
const temporary = await event('991902', 'stream.online');
if (target === 'cron') await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'stream-operations-v1', eventKey: temporary.eventKey }).lean())?.status === 'retry', 'real consumer retry');
else await assert.rejects(() => applyStreamOperationsDomainEvent(temporary), /editors/);
receipt = await StreamOperationsReceipt.findById(temporary.eventKey).lean();
assert.equal(receipt.steps.admins.status, 'completed'); assert.equal(receipt.steps.vips.status, 'completed');
const adminAt = receipt.steps.admins.at.getTime();
mode({}); await apply(temporary);
receipt = await StreamOperationsReceipt.findById(temporary.eventKey).lean();
assert.equal(receipt.steps.editors.status, 'completed'); assert.equal(receipt.steps.admins.at.getTime(), adminAt);
console.log('PASS transient editor failure: independent steps complete and retry resumes failed work.');

// Real token manager, distributed Redis lock, encrypted Mongo credentials and provider responses.
await seed('991904', { access: 'fixture-rejected' }); mode({});
const before = tokens().length;
assert.equal((await getChannelEditors('991904', true)).error, false);
assert.equal(tokens().length - before, 1);
assert.equal(await redis.hGet('accounts:twitch:991904:data', 'access_token'), 'fixture-rotated');
await seed('991905', { access: 'fixture-rejected' }); mode({ refreshFailure: 'transient' });
assert.equal((await getChannelEditors('991905')).error, true);
assert.equal((await Users.findOne({ 'accounts.id': '991905' }).lean()).accounts[0].has_permissions, true);
assert.equal(await redis.hGet('accounts:twitch:991905:data', 'refresh_token'), 'fixture-refresh-991905');
await seed('991906', { access: 'fixture-rejected' }); mode({ refreshFailure: 'revoked' });
assert.equal((await getChannelEditors('991906')).error, true);
assert.equal((await Users.findOne({ 'accounts.id': '991906' }).lean()).accounts[0].has_permissions, false);
mode({});
console.log('PASS real refresh path: rejected cached token rotates, transient failure preserves credentials, confirmed revocation disables permissions.');

// Queue revision/lease fencing must retain a reauthorization arriving during older work.
await enqueueStreamOperationsReconciliation('991902');
const leased = await StreamOperationsReconciliation.findOneAndUpdate({ _id: '991902' }, { $set: { leaseToken: 'fixture-owner', leaseUntil: new Date(Date.now() + 60000) } }, { new: true }).lean();
await enqueueStreamOperationsReconciliation('991902');
assert.equal((await StreamOperationsReconciliation.updateOne({ _id: '991902', revision: leased.revision, leaseToken: 'fixture-owner' }, { $set: { pending: false } })).modifiedCount, 0);
assert.equal((await StreamOperationsReconciliation.findById('991902').lean()).pending, true);
await StreamOperationsReconciliation.updateOne({ _id: '991902', leaseToken: 'fixture-owner' }, { $unset: { leaseToken: 1, leaseUntil: 1 } });
await recoverStreamOperationsReconciliations();
assert.equal((await StreamOperationsReconciliation.findById('991902').lean()).pending, false);
if (target === 'cron') {
  await enqueueStreamOperationsReconciliation('991901');
  console.log('Checking actual stream-analytics worker recovery on its next scheduled tick.');
  await until(async () => (await StreamOperationsReconciliation.findById('991901').lean())?.pending === false, 'scheduled reconciliation recovery', 75000);
}
if (target === 'api') {
  const response = await fetch('http://127.0.0.1:3000/auth/reauthenticate?code=fixture&state=pipelinefixture', { redirect: 'manual' });
  assert.equal(response.status, 302, await response.text());
  assert.equal((await StreamOperationsReconciliation.findById('991901').lean()).pending, true);
  await recoverStreamOperationsReconciliations();
  assert.equal((await StreamOperationsReconciliation.findById('991901').lean()).pending, false);
  assert.equal(decrypt((await Users.findOne({ 'accounts.id': '991901' }).lean()).accounts[0].access_token), 'fixture-rotated');
}
console.log('PASS durable reauthorization: revision fences stale acknowledgement, recovery refreshes current state without old stream reset.');

// Reproduce the snapshot closure 2.7s before its actual offline notification.
await seed('991907');
const at = new Date();
const session = await StreamSessionSchema.create({ channelID: '991907', stream_id: 'snapshot-fixture', started_at: new Date(+at - 3600000),
  status: 'orphaned', closure_source: 'snapshot', ended_at: new Date(+at - 2700), consecutive_offline_checks: 2, bits: 123 });
const offline = await event('991907', 'stream.offline', at);
if (target === 'cron') await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'stream-analytics-v1', eventKey: offline.eventKey }).lean())?.status === 'succeeded', 'actual offline analytics consumer');
else await recordStreamOfflineEvent({ channelID: '991907', endedAt: at, eventKey: offline.eventKey });
let repaired = await StreamSessionSchema.findById(session._id).select('+applied_domain_event_keys').lean();
assert.equal(repaired.status, 'offline'); assert.equal(repaired.closure_source, 'eventsub');
assert.equal(repaired.ended_at.getTime(), +at); assert.equal(repaired.bits, 123); assert(repaired.offline_summary_enqueued_at); assert(repaired.offline_clips_completed_at);
const accepted = await redis.lLen('cron:stream-memory:queue');
await recordStreamOfflineEvent({ channelID: '991907', endedAt: at, eventKey: offline.eventKey });
assert.equal(await redis.lLen('cron:stream-memory:queue'), accepted);
console.log('PASS offline snapshot race: correct session finalized, metrics preserved and downstream acceptance not duplicated.');

// Historical repairs are an explicit, guarded path, independent of expired retry horizons.
await seed('991908');
const legacyAt = new Date();
const legacy = await StreamSessionSchema.create({ channelID: '991908', stream_id: 'legacy-fixture', started_at: new Date(+legacyAt - 3600000),
  status: 'orphaned', ended_at: new Date(+legacyAt - 2700), consecutive_offline_checks: 2 });
const legacyEvent = await event('991908', 'stream.offline', legacyAt);
if (target === 'cron') await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'stream-analytics-v1', eventKey: legacyEvent.eventKey }).lean())?.status === 'retry', 'legacy event defers normal matching');
await DomainEventDeliverySchema.updateOne({ consumer: 'stream-analytics-v1', eventKey: legacyEvent.eventKey }, {
  $set: { status: 'dead', lastErrorCode: 'prerequisite_missing', nextAttemptAt: null, lockedUntil: null, leaseToken: null },
  $setOnInsert: { topic: 'channel', eventID: legacyEvent._id, expiresAt: legacyEvent.expiresAt, attempts: 0 }
}, { upsert: true });
await redis.set(`cron:jobs:accepted:stream-memory-summary:991908:${legacy._id}`, '1');
const repairArgs = ['dist/scripts/reconcile_stream_offline.script.js', '--channel', '991908', '--event-key', legacyEvent.eventKey, '--session-id', String(legacy._id)];
function repair(extra = []) {
  const result = spawnSync(process.execPath, [...repairArgs, ...extra], { encoding: 'utf8', timeout: 20000, env: process.env });
  assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
}
const legacyBefore = await StreamSessionSchema.findById(legacy._id).lean();
const queueBefore = await redis.lLen('cron:stream-memory:queue');
assert.match(repair(), /dry-run/);
assert.deepEqual(await StreamSessionSchema.findById(legacy._id).lean(), legacyBefore);
assert.equal(await redis.lLen('cron:stream-memory:queue'), queueBefore);
assert.match(repair(['--execute']), /reconciled/);
repaired = await StreamSessionSchema.findById(legacy._id).select('+applied_domain_event_keys').lean();
assert.equal(repaired.status, 'offline'); assert.equal(repaired.ended_at.getTime(), +legacyAt);
assert.equal(await redis.lLen('cron:stream-memory:queue'), queueBefore);
assert.equal((await DomainEventDeliverySchema.findOne({ consumer: 'stream-analytics-v1', eventKey: legacyEvent.eventKey }).lean()).status, 'dead');
repair(['--execute']);
assert.equal(await redis.lLen('cron:stream-memory:queue'), queueBefore);
const wrong = spawnSync(process.execPath, [...repairArgs.slice(0, -1), String(session._id), '--execute'], { encoding: 'utf8', timeout: 20000, env: process.env });
assert.notEqual(wrong.status, 0, 'cross-channel session repair must be refused');
console.log('PASS scoped repair: dry-run has no data effects, explicit repair and repeat preserve acceptance, mismatched session is refused, delivery history remains unchanged.');

const suites = ['dist/domain_events/stream_operations_events.test.js', 'dist/utils/twitch_streamer_refresh.test.js', 'dist/utils/stream_analytics_offline_replay.test.js', 'dist/handlers/dima032_session.test.js'];
const tested = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', ...suites], { encoding: 'utf8', timeout: 90000, env: { ...process.env, NODE_OPTIONS: '' } });
if (tested.status !== 0) { process.stdout.write(tested.stdout); process.stderr.write(tested.stderr); }
assert.equal(tested.status, 0, 'candidate regression suites');
console.log(tested.stdout.split('\n').filter(line => /tests |pass |fail |skipped /.test(line)).join('\n'));
console.log('PASS exact candidate runtime: ' + target);
process.exit(0);
