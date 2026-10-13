// saas-ops only: real candidate runtime, isolated Mongo/Redis, goals-fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleGoalChannel } from '/app/dist/goals/completion.js';
import { spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Eventsub from '/app/dist/schemas/eventsub.schema.js';
import { FollowRelationshipLedgerSchema as Follows } from '/app/dist/schemas/follow_relationship_ledger.schema.js';
import { StreamSubscriptionLedgerSchema as Subs } from '/app/dist/schemas/stream_subscription_ledger.schema.js';
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
  await request('POST', channel, { ...input, actions:{completion:{type:'message',text:' '}} }, 0, 400);
  await request('POST', channel, { ...input, actions:{failure:{type:'message',text:'invalid mode'}} }, 0, 400);
  let state = await request('POST', channel, {...input,actions:{completion:{type:'ast',text:'$(upper saved)'}}}, 0); assert.equal(state.goals.length, 1);
  assert.equal(state.goals[0].actions.completion.type,'ast');
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
// Current totals include pre-goal active relationships, not event receipts.
const beforeGoal = new Date(Date.now() - 86400000);
for (const [user, status] of [['one', 'active'], ['two', 'active'], ['ended', 'ended']]) {
  await Follows.collection.insertOne({ platform: 'twitch', followed_id: other, follower_id: user, status, followed_at: beforeGoal });
  await Subs.collection.insertOne({ platform: 'twitch', streamer_id: other, user_id: user, status, is_gift: user === 'two', subbed_at: beforeGoal });
}
await Follows.collection.insertOne({ platform: 'twitch', followed_id: channel, follower_id: 'unrelated', status: 'active' });
await Subs.collection.insertOne({ platform: 'twitch', streamer_id: channel, user_id: 'unrelated', status: 'active' });
for (const [metric, revision] of [['follows', 0], ['subs', 1]]) {
  const body = { ...input, name: 'Current ' + metric, metric, mode: 'current', target: 2 };
  if (target === 'api') await request('POST', other, body, revision, 200, other);
  else await changeGoal(other, 'create', body, revision);
}
let totals = await goalSnapshot(other);
assert.deepEqual(totals.goals.map(g => [g.current, g.status]), [[2, 'reached'], [2, 'reached']]);
await send('channel.follow', {}, crypto.randomUUID(), Date.now(), other);
await send('channel.subscribe', { is_gift: false }, crypto.randomUUID(), Date.now(), other);
assert.equal(await GoalContribution.countDocuments({ channel: other }), 0, 'current mode never accumulates contribution receipts');
await Follows.updateOne({ followed_id: other, follower_id: 'two' }, { $set: { status: 'ended' } });
await Subs.updateOne({ streamer_id: other, user_id: 'two' }, { $set: { status: 'ended' } });
totals = target === 'api' ? await request('GET', other, null, undefined, 200, other) : await goalSnapshot(other);
assert.deepEqual(totals.goals.map(g => [g.current, g.status]), [[1, 'active'], [1, 'active']], 'unfollows and expired subscriptions reduce current totals');
await Follows.updateMany({ followed_id: other }, { $set: { status: 'ended' } });
await Subs.updateMany({ streamer_id: other }, { $set: { status: 'ended' } });
assert.deepEqual((await goalSnapshot(other)).goals.map(g => g.current), [0, 0]);
await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'pro' } });
await assert.rejects(() => changeGoal(channel, 'create', { ...input, metric: 'bits', mode: 'current' }, 6), e => e.code === 'invalid');
if (target === 'api') await request('POST', channel, { ...input, metric: 'bits', mode: 'current' }, 6, 400);
console.log('PASS current totals: pre-existing active follows/subs, gifts, ended/other-channel exclusion, falling totals, zero, no event double-counting and Bits rejection.');
// Exercise actual message sender and AST parser against a captured Twitch provider.
await redis.set('app:twitch:token', 'fixture-app-token');
const messages = () => fs.existsSync('/tmp/saas-fixtures/goal-messages.jsonl') ? fs.readFileSync('/tmp/saas-fixtures/goal-messages.jsonl','utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
const actionChannel='991904';
await Users.collection.insertOne({plan_tier:'pro',accounts:[{type:'twitch',id:actionChannel,name:'goalactions',actived:true}]});
await redis.hSet('token:fixture-'+actionChannel,{id:actionChannel,login:'goalactions',display_name:'Fixture'});
await redis.hSet(`accounts:twitch:${actionChannel}:data`,{id:actionChannel,name:'goalactions',plan_tier:'pro'});
async function createActionGoal(body) {
 const state=await goalSnapshot(actionChannel);
 if(target==='api')await request('POST',actionChannel,{...input,...body},state.revision,200,actionChannel);
 else await changeGoal(actionChannel,'create',{...input,...body},state.revision);
 return (await goalSnapshot(actionChannel)).goals.at(-1);
}
async function progress(goal,amount,time=Date.now()) {
 await GoalContribution.create({_id:crypto.randomUUID(),channel:actionChannel,goal:goal.id,occurredAt:time,amount});
}
async function settleAndWait(goal,sequence,status='finished') {
 if(target==='api')await Promise.all([settleGoalChannel(actionChannel),settleGoalChannel(actionChannel)]);
 await until(async()=>{const outcome=(await goalSnapshot(actionChannel)).goals.find(g=>g.id===goal.id)?.outcome;return outcome?.sequence===sequence&&outcome?.actionStatus===status;});
}
const literal=await createActionGoal({target:1,actions:{completion:{type:'message',text:'$(chat.send must stay literal)'}}});
await progress(literal,1);await settleAndWait(literal,1);
await Promise.all([settleGoalChannel(actionChannel),settleGoalChannel(actionChannel)]);
assert.equal(messages().filter(m=>m.message==='$(chat.send must stay literal)').length,1);
const rolling=await createActionGoal({mode:'rolling',target:1,windowSeconds:60,actions:{completion:{type:'ast',text:'$(chat.send "AST effect")$(upper recovered)'},failure:{type:'message',text:'Rolling slipped'}}});
assert.equal((await goalSnapshot(actionChannel)).goals.find(g=>g.id===rolling.id).outcome,undefined);
await progress(rolling,1);await settleAndWait(rolling,1);
assert.equal(messages().filter(m=>m.message==='AST effect').length,1);
assert.equal(messages().filter(m=>m.message==='RECOVERED').length,1);
// Advance the fixture receipt age; real worker must notice expiry with no new events.
await GoalContribution.updateMany({goal:rolling.id},{$set:{occurredAt:Date.now()-61000}});
await settleAndWait(rolling,2);
await Promise.all([settleGoalChannel(actionChannel),settleGoalChannel(actionChannel)]);
assert.equal(messages().filter(m=>m.message==='Rolling slipped').length,1);
await progress(rolling,1);await settleAndWait(rolling,3);
assert.equal(messages().filter(m=>m.message==='AST effect').length,2);
const failed=await createActionGoal({mode:'fixed',startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+60000).toISOString(),actions:{failure:{type:'message',text:'fixture delivery failure'}}});
await GoalSet.updateOne({_id:actionChannel,'goals.id':failed.id},{$set:{'goals.$.endsAt':Date.now()-1}});
await settleAndWait(failed,1,'error');
await settleGoalChannel(actionChannel);await settleGoalChannel(actionChannel);
assert.equal(messages().filter(m=>m.message==='fixture delivery failure').length,1,'failed delivery never automatically repeats');
// Editing action settings preserves outcome; adding a completion action never replays it.
let actionState=await goalSnapshot(actionChannel);
await changeGoal(actionChannel,'edit',{name:literal.name,target:1,actions:{completion:{type:'message',text:'must not replay'}}},actionState.revision,literal.id);
await settleGoalChannel(actionChannel);
assert(!messages().some(m=>m.message==='must not replay'));
// Simulate process loss after the durable claim: uncertainty remains visible, no resend.
const interrupted=await createActionGoal({target:1,actions:{completion:{type:'message',text:'must not duplicate interrupted'}}});
await GoalSet.updateOne({_id:actionChannel},{$set:{[`outcomes.${interrupted.id}`]:{phase:'completed',sequence:1,at:Date.now()-310000,actionStatus:'running'}}});
await progress(interrupted,1);await settleGoalChannel(actionChannel);
assert.equal((await goalSnapshot(actionChannel)).goals.find(g=>g.id===interrupted.id).outcome.actionStatus,'unknown');
assert(!messages().some(m=>m.message==='must not duplicate interrupted'));
actionState=await goalSnapshot(actionChannel);
await changeGoal(actionChannel,'delete',{},actionState.revision,literal.id);
assert.equal((await GoalSet.findById(actionChannel).lean()).outcomes[literal.id],undefined);
console.log('PASS outcome actions: real AST side effects and returned text, literal chat, concurrent claims, no repeat, rolling expiry/failure/recovery without events, fixed deadline, provider failure, edits, interrupted attempt and deletion.');
const tests = spawnSync('node', ['--test', 'dist/goals/model.test.js', 'dist/domain_events/domain_event_consumers.test.js', 'dist/domain_events/domain_event_producers.test.js', 'dist/utils/domain_event_consumer.test.js'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_OPTIONS: '' } });
process.stdout.write(tests.stdout); process.stderr.write(tests.stderr); assert.equal(tests.status, 0);
console.log('PASS runtime target: ' + target + (target === 'cron' ? ', real supervisor and goals consumer' : ', real API entrypoint'));
process.exit(0);
