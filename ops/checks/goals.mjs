// saas-ops only: real candidate runtime, isolated Mongo/Redis, goals-fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Eventsub from '/app/dist/schemas/eventsub.schema.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { ingestDomainEvent } from '/app/dist/domain_events/domain_event_producers.js';
import { twitchEventsubProducer } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { GoalSet, GoalContribution, changeGoal, goalSnapshot, applyGoalEvent } from '/app/dist/goals/service.js';
const target = process.env.SAAS_GOALS_TARGET, channel = '991901', other = '991902', admin = '991903';
await getMongoDBConnection('goal-check');
const redis = await getDragonflyClient('goal-check');
await Promise.all([GoalSet.init(), GoalContribution.init(), DomainEventDeliverySchema.init()]);
for (const id of [channel, other, admin]) {
  await Users.collection.insertOne({ plan_tier: 'free', accounts: [{ type: 'twitch', id, name: 'goalfixture', actived: true, chat_enabled: false }] });
  await redis.hSet('token:fixture-' + id, { id, login: 'goalfixture', display_name: 'Fixture' });
}
const input = { name: 'New follows', metric: 'follows', mode: 'total', target: 10 };
const request = async (method, path, body, revision, expected = 200, identity = channel) => {
  const response = await fetch('http://127.0.0.1:3000/goals/' + path, { method, headers: { ...(identity ? { Authorization: 'Bearer fixture-' + identity } : {}), 'Content-Type': 'application/json', ...(revision !== undefined ? { 'If-Match': String(revision) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result.data;
};
if (target === 'api') {
  await request('GET', channel, null, undefined, 401, null);
  await request('GET', channel, null, undefined, 403, other);
  await request('POST', channel, input, undefined, 400);
  await request('POST', channel, { ...input, target: 0 }, 0, 400);
  await request('POST', channel, { ...input, metric: 'bits' }, 0, 403);
  let state = await request('POST', channel, input, 0); assert.equal(state.goals.length, 1);
  await request('POST', channel, input, 0, 409);
  const id = state.goals[0].id;
  await request('PATCH', channel + '/' + id, { name: 'Changed', target: 20, metric: 'bits' }, 1, 400);
  state = await request('PATCH', channel + '/' + id, { name: 'Changed', target: 20 }, 1); assert.equal(state.goals[0].target, 20);
  await AdminSchema.collection.insertOne({ channelID: channel, adminID: admin, actived: true, role: 'channel', permissions: ['dashboard:view'] });
  assert.equal((await request('GET', channel, null, undefined, 200, admin)).canManage, false);
  await request('POST', channel, input, state.revision, 403, admin);
  await request('DELETE', channel + '/' + id, null, state.revision);
  await GoalSet.deleteOne({ _id: channel });
  console.log('PASS actual API: authenticated ownership, view-only admin, validation, Bits entitlement, stale edits, immutable timing, edit and delete.');
}
// Concurrent creates cannot claim the same last slot.
const races = await Promise.allSettled([changeGoal(channel, 'create', input, 0), changeGoal(channel, 'create', input, 0)]);
assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
await changeGoal(channel, 'create', { ...input, name: 'Subs', metric: 'subs' }, 1);
await assert.rejects(() => changeGoal(channel, 'create', input, 2), e => e.code === 'limit');
await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'premium' } });
await changeGoal(channel, 'create', { ...input, name: 'Bits', metric: 'bits', mode: 'rolling', windowSeconds: 60 }, 2);
await assert.rejects(() => changeGoal(channel, 'create', input, 3), e => e.code === 'limit');
await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'pro' } });
await changeGoal(channel, 'create', { ...input, name: 'Timed follows', mode: 'fixed', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60000).toISOString() }, 3);
await assert.rejects(() => changeGoal(channel, 'create', input, 4), e => e.code === 'limit');
let state = await goalSnapshot(channel); assert.equal(state.goals.length, 4);
const fixed = state.goals[3];
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('Timed out waiting for real goal consumer'); }
async function send(type, raw = {}, receipt = crypto.randomUUID(), time = Date.now(), owner = channel, source = 'twitch-eventsub') {
  const result = await ingestDomainEvent(twitchEventsubProducer, { messageId: receipt, messageTimestamp: new Date(time).toISOString(), source, subscription: { type, version: type === 'channel.follow' ? '2' : '1', id: 'fixture-' + type }, event: { broadcaster_user_id: owner, user_id: '123', ...raw } });
  assert(result?.event);
  if (target === 'cron' && source === 'twitch-eventsub') await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'channel-goals-v1', eventKey: result.event.eventKey }).lean())?.status === 'succeeded');
  else await applyGoalEvent(result.event);
  return result.event;
}
const follow = await send('channel.follow');
await Promise.all([applyGoalEvent(follow), applyGoalEvent(follow)]);
await send('channel.subscribe', { is_gift: false });
await send('channel.subscribe', { is_gift: true });
await send('channel.subscription.gift', { total: 5 });
await send('channel.subscription.message');
const bits = await send('channel.bits.use', { bits: 250 });
await Eventsub.collection.insertOne({ channelID: channel, type: 'channel.bits.use', enabled: true, created_at: new Date(0).toISOString() });
await send('channel.cheer', { bits: 250 }); // Legacy duplicate feed does not count twice.
await send('channel.follow', {}, crypto.randomUUID(), Date.now() - 86400000);
await send('channel.follow', {}, crypto.randomUUID(), Date.now(), other);
await send('channel.follow', {}, crypto.randomUUID(), Date.now(), channel, 'twitch-eventsub-test');
state = await goalSnapshot(channel);
assert.deepEqual(state.goals.map(g => g.current), [1, 7, 250, 1]);
assert.equal((await goalSnapshot(other)).goals.length, 0);
const expired = await goalSnapshot(channel, bits.occurredAt.getTime() + 60000);
assert.equal(expired.goals[2].current, 0, 'rolling expiry does not wait for Mongo TTL cleanup');
assert.equal(expired.goals[0].current, 1, 'total persists');
await GoalContribution.create({ _id: 'creation-boundary', channel, goal: state.goals[2].id, occurredAt: state.goals[2].startsAt, amount: 9 });
assert.equal((await goalSnapshot(channel, state.goals[2].startsAt + 60000)).goals[2].current, 250, 'event at creation expires exactly one window later');
await GoalContribution.deleteOne({ _id: 'creation-boundary' });
// Delayed delivery after a fixed period still counts by event occurrence, not processing time.
await GoalSet.updateOne({ _id: channel }, { $set: { 'goals.3.endsAt': follow.occurredAt.getTime() + 1 } });
await applyGoalEvent({ ...follow, eventKey: 'late-fixture', sourceEventId: 'late-fixture' });
assert.equal((await goalSnapshot(channel)).goals[3].current, 2);
await applyGoalEvent({ ...follow, eventKey: 'end-fixture', occurredAt: new Date(follow.occurredAt.getTime() + 1) });
assert.equal((await goalSnapshot(channel)).goals[3].current, 2, 'end boundary is exclusive');
await changeGoal(channel, 'edit', { name: 'Keep progress', target: 1 }, 4, state.goals[0].id);
assert.equal((await goalSnapshot(channel)).goals[0].status, 'reached');
await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'free' } });
assert.equal((await goalSnapshot(channel)).goals.length, 4, 'downgrade preserves existing goals');
await assert.rejects(() => changeGoal(channel, 'create', input, 5), e => e.code === 'limit');
await changeGoal(channel, 'delete', {}, 5, state.goals[0].id);
assert.equal(await GoalContribution.countDocuments({ goal: state.goals[0].id }), 0);
await applyGoalEvent(follow); assert.equal((await goalSnapshot(channel)).goals.length, 3);
console.log('PASS durable goals: all plan limits, concurrent slots, follows/subs/gifts/shared resubs/Bits, retries, legacy Bits, historical/test/cross-channel exclusion, fixed late delivery, rolling expiration, edits and downgrade preservation.');
const tests = spawnSync('node', ['--test', 'dist/goals/model.test.js', 'dist/domain_events/domain_event_consumers.test.js', 'dist/domain_events/domain_event_producers.test.js', 'dist/utils/domain_event_consumer.test.js'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_OPTIONS: '' } });
process.stdout.write(tests.stdout); process.stderr.write(tests.stderr); assert.equal(tests.status, 0);
console.log('PASS runtime target: ' + target + (target === 'cron' ? ', real supervisor and goals consumer' : ', real API entrypoint'));
process.exit(0);
