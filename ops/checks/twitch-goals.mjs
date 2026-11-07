// saas-ops only: Twitch Creator Goals inside DomDimaBot Goals. Real candidate runtime, disposable Mongo/Redis, fake Twitch
// (ops/checks/twitch-goals-fixtures as --fixtures, with <target>-env.json as --test-env). SAAS_TWITCH_GOALS_TARGET picks:
//   api  — real API: Goals page reads Twitch (free, outside the quota, permission state, coalesced reads), saves actions
//          per Twitch goal type (validation, Premium for Bits/cheerers, stale revision, view-only admin), Studio session
//          and state carry both goal sources without actions or outcomes.
//   cron — real domain-event supervisor (overlay-interactions-v1 only) and goals worker: journaled channel.goal.* events
//          become Twitch goal state; "reached" runs once on a crossing shown by Twitch, "ended without reaching it" on a
//          not-achieved end; baselines, duplicates and Premium rules on Free run nothing.
//   bot  — real bot webhook: signed channel.goal.* notifications are journaled once (1-day retention), nothing runs inline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';

const target = process.env.SAAS_TWITCH_GOALS_TARGET, dir = '/tmp/saas-fixtures';
const owner = '881901', denied = '881902', admin = '881903', other = '881904';
await getMongoDBConnection('twitch-goals-check');
const redis = await getDragonflyClient('twitch-goals-check');
await redis.set('app:twitch:token', 'fixture-app-token');
const exp = String(Math.floor(Date.now() / 1000) + 86400);
async function account(id, plan) {
  await Users.collection.insertOne({ plan_tier: plan, accounts: [{ type: 'twitch', id, name: 'tg' + id, actived: true, has_permissions: true, chat_enabled: false }] });
  await redis.hSet('token:fixture-' + id, { id, login: 'tg' + id, display_name: 'TG' + id });
  await redis.hSet(`accounts:twitch:${id}:data`, { id, name: 'tg' + id, plan_tier: plan, has_permissions: 'true', access_token: 'fixture-user-' + id, expires_at: exp });
}
const answer = (channel, value) => fs.writeFileSync(`${dir}/helix-goals-${channel}.json`, JSON.stringify(value));
const helixCalls = channel => fs.existsSync(`${dir}/helix-goals-calls.jsonl`) ? fs.readFileSync(`${dir}/helix-goals-calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(call => call.channel === channel) : [];
const messages = () => fs.existsSync(`${dir}/goal-messages.jsonl`) ? fs.readFileSync(`${dir}/goal-messages.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, tries = 200) { for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await sleep(150); } throw new Error('Timed out: ' + label); }
const helixGoal = (id, type, current, target, description = '') => ({ id, broadcaster_id: owner, broadcaster_name: 'TG', broadcaster_login: 'tg', type, description, current_amount: current, target_amount: target, created_at: new Date(Date.now() - 3600_000).toISOString() });

if (target === 'api') {
  await account(owner, 'free'); await account(denied, 'free'); await account(admin, 'free'); await account(other, 'pro');
  const request = async (method, path, body, revision, expected = 200, identity = owner) => {
    const response = await fetch('http://127.0.0.1:3000/' + path, { method, headers: { Authorization: 'Bearer fixture-' + identity, 'Content-Type': 'application/json',
      ...(revision !== undefined ? { 'If-Match': String(revision) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`); return result.data;
  };
  for (let i = 0; i < 80; i++) { try { if ((await fetch('http://127.0.0.1:3000/goals/' + owner)).status === 401) break; } catch {} await sleep(250); }
  answer(owner, [helixGoal('tg-follow', 'follower', 420, 500, 'Road to 500'), helixGoal('tg-bits', 'new_bit', 900, 1000)]);
  let state = await request('GET', 'goals/' + owner);
  assert.equal(state.twitch.access, 'ok');
  const byId = Object.fromEntries(state.twitch.goals.map(goal => [goal.id, [goal.type, goal.current, goal.target, goal.status, goal.description]]));
  assert.deepEqual(byId, { 'tg-follow': ['follow', 420, 500, 'active', 'Road to 500'], 'tg-bits': ['new_bit', 900, 1000, 'active', ''] }, 'both spellings, Bits goals free to see');
  assert.equal(state.goals.length, 0); assert.equal(state.limit, 2, 'Twitch goals never take a goal slot');
  assert.equal(state.twitch.actionTypes.includes('new_bit'), false);
  assert.match(helixCalls(owner)[0].authorization, /^Bearer fixture-user-881901$/, 'the streamer\'s own token reads their goals');
  // The page polls every 5 s; Twitch is asked at most once per window (1.5 s in this fixture, a minute live).
  await request('GET', 'goals/' + owner); await request('GET', 'goals/' + owner);
  assert.equal(helixCalls(owner).length, 1);
  await sleep(1700);
  answer(owner, [helixGoal('tg-follow', 'follower', 430, 500, 'Road to 500')]);
  state = await request('GET', 'goals/' + owner);
  assert.equal(helixCalls(owner).length, 2);
  assert.deepEqual(state.twitch.goals.map(goal => [goal.id, goal.current]), [['tg-follow', 430]], 'a goal Twitch stopped listing is hidden');
  // A channel whose goals Twitch lets us read gets the three goal notifications (production doesn't reconcile new types).
  const { default: Eventsub } = await import('/app/dist/schemas/eventsub.schema.js');
  await until(async () => (await Eventsub.countDocuments({ channelID: owner, type: /^channel\.goal\./ })) === 3, 'goal notifications for the channel');
  assert.deepEqual((await Eventsub.find({ channelID: owner, type: /^channel\.goal\./ }).lean()).map(row => [row.type, row.version, row.condition.broadcaster_user_id]).sort(),
    [['channel.goal.begin', '1', owner], ['channel.goal.end', '1', owner], ['channel.goal.progress', '1', owner]]);
  // Missing permission: shown as such, Twitch asked again soon from the page (reconnect), goals stay readable; no notifications.
  answer(denied, 401);
  assert.equal((await request('GET', 'goals/' + denied, null, undefined, 200, denied)).twitch.access, 'permission');
  await sleep(500);
  assert.equal(await Eventsub.countDocuments({ channelID: denied }), 0);
  // Actions per Twitch goal type.
  const actions = { actions: { completion: { type: 'message', text: 'We made it!' }, failure: { type: 'ast', text: '$(upper next time)' } } };
  await request('PUT', `goals/${owner}/twitch/follow`, actions, undefined, 400);
  await request('PUT', `goals/${owner}/twitch/donations`, actions, state.revision, 400);
  await request('PUT', `goals/${owner}/twitch/new_bit`, actions, state.revision, 403);
  await request('PUT', `goals/${owner}/twitch/follow`, { actions: { completion: { type: 'shell', text: 'x' } } }, state.revision, 400);
  state = await request('PUT', `goals/${owner}/twitch/follow`, actions, state.revision);
  assert.deepEqual(state.twitch.rules.map(rule => [rule.type, rule.completion.text, rule.failure.type]), [['follow', 'We made it!', 'ast']]);
  assert.equal(state.goals.length, 0, 'actions are not goals');
  await request('PUT', `goals/${owner}/twitch/follow`, actions, state.revision - 1, 409);
  const { AdminSchema } = await import('/app/dist/schemas/admin.schema.js');
  await AdminSchema.collection.insertOne({ channelID: owner, adminID: admin, actived: true, role: 'channel', permissions: ['dashboard:view'] });
  assert.equal((await request('GET', 'goals/' + owner, null, undefined, 200, admin)).canManage, false);
  await request('PUT', `goals/${owner}/twitch/follow`, { actions: {} }, state.revision, 403, admin);
  await request('GET', 'goals/' + owner, null, undefined, 403, other);
  // Pro: Bits rules allowed; an own goal still counts against the quota on its own.
  answer(other, [helixGoal('tg-cheer', 'new_cheerer', 3, 10)]);
  let pro = await request('GET', 'goals/' + other, null, undefined, 200, other);
  pro = await request('PUT', `goals/${other}/twitch/new_cheerer`, { actions: { completion: { type: 'message', text: 'Cheers!' } } }, pro.revision, 200, other);
  pro = await request('POST', 'goals/' + other, { name: 'Ours', metric: 'subs', mode: 'total', target: 5 }, pro.revision, 200, other);
  assert.deepEqual([pro.goals.length, pro.limit, pro.twitch.rules.length], [1, 4, 1]);
  // Studio: session and state carry both sources; never actions, AST text or outcomes.
  const session = await request('GET', `overlay-studio/${other}/custom-widgets/session`, null, undefined, 200, other);
  assert.deepEqual(session.goalsBySource.twitch, { 'follower-goal': { amount: 0 }, 'subscriber-goal': { amount: 0 }, 'cheer-goal': { amount: 0 }, 'tip-goal': { amount: 0 } });
  assert.deepEqual(Object.keys(session.twitchGoalSources), []);
  assert.equal(session.data['subscriber-goal'].amount, 0);
  const studio = await request('GET', `overlay-studio/${other}/custom-widgets/state`, null, undefined, 200, other);
  assert.deepEqual(studio.goals.map(goal => [goal.source, goal.metric, goal.mode]), [['dima', 'subs', 'total'], ['twitch', 'cheerers', 'twitch']]);
  assert.equal(JSON.stringify(studio).includes('Cheers!'), false, 'actions never reach widgets');
  const ownerSession = await request('GET', `overlay-studio/${owner}/custom-widgets/session`);
  assert.deepEqual([ownerSession.goalsBySource.twitch['follower-goal'].amount, ownerSession.twitchGoalSources['follower-goal'].name], [430, 'Road to 500']);
  assert.equal(ownerSession.data['follower-goal'].amount, 0, 'StreamElements keys stay on the Goals page source by default');
  console.log('PASS actual API: Twitch goals free and outside the quota, streamer token, goal notifications created, coalesced reads, hidden missing goals, permission state, per-type actions (validation, Premium Bits/cheerers, stale revision, view-only admin), Studio session/state with both sources and no actions.');
}

if (target === 'cron') {
  const { ingestDomainEvent } = await import('/app/dist/domain_events/domain_event_producers.js');
  const { twitchEventsubProducer } = await import('/app/dist/domain_events/twitch_eventsub_events.js');
  const { DomainEventDeliverySchema } = await import('/app/dist/schemas/domain_event_delivery.schema.js');
  const { changeTwitchGoalRule, goalSnapshot, GoalSet } = await import('/app/dist/goals/service.js');
  const { readTwitchGoals } = await import('/app/dist/goals/twitch-store.js');
  await Promise.all([GoalSet.init(), DomainEventDeliverySchema.init()]);
  await account(owner, 'pro');
  const rule = async (type, completion, failure) => {
    const state = await goalSnapshot(owner);
    await changeTwitchGoalRule(owner, type, { actions: { ...(completion ? { completion: { type: 'message', text: completion } } : {}), ...(failure ? { failure: { type: 'message', text: failure } } : {}) } }, state.revision);
  };
  await rule('follow', 'Twitch follower goal reached!', 'Follower goal ended early');
  await rule('new_bit', 'Bits goal reached!');
  await rule('subscription_count', 'Sub goal reached!');
  async function send(kind, raw, receipt = randomUUID()) {
    const result = await ingestDomainEvent(twitchEventsubProducer, { messageId: receipt, messageTimestamp: new Date().toISOString(), source: 'twitch-eventsub',
      subscription: { type: 'channel.goal.' + kind, version: '1', id: 'fixture-goal-sub' }, event: { broadcaster_user_id: owner, broadcaster_user_login: 'tg', broadcaster_user_name: 'TG',
        started_at: new Date(Date.now() - 600_000).toISOString(), description: '', ...raw } });
    assert(result?.event);
    assert.equal(result.event.type, { begin: 'channel.goal.began', progress: 'channel.goal.updated', end: 'channel.goal.ended' }[kind]);
    if (result.inserted) await until(async () => (await DomainEventDeliverySchema.findOne({ consumer: 'overlay-interactions-v1', eventKey: result.event.eventKey }).lean())?.status === 'succeeded', 'projection of ' + kind);
    return result;
  }
  const goal = (id, type, current, target) => ({ id, type, current_amount: current, target_amount: target });
  await send('begin', goal('cg-follow', 'follow', 400, 500));
  await send('progress', goal('cg-follow', 'follow', 499, 500));
  const crossing = randomUUID();
  await send('progress', goal('cg-follow', 'follow', 500, 500), crossing);
  assert.equal((await send('progress', goal('cg-follow', 'follow', 500, 500), crossing)).inserted, false, 'Twitch retry is journaled once');
  let stored = await readTwitchGoals(owner);
  assert.deepEqual([stored.goals[0].current, stored.goals[0].reachedBy], [500, 'event']);
  await until(() => messages().some(m => m.message === 'Twitch follower goal reached!'), 'completion action');
  await send('progress', goal('cg-follow', 'follow', 498, 500));
  await send('progress', goal('cg-follow', 'follow', 510, 500));
  await send('end', { ...goal('cg-follow', 'follow', 510, 500), is_achieved: true, ended_at: new Date().toISOString() });
  // Not achieved: the failure action, once.
  await send('begin', goal('cg-follow-2', 'follow', 10, 100));
  await send('end', { ...goal('cg-follow-2', 'follow', 40, 100), is_achieved: false, ended_at: new Date().toISOString() });
  await until(() => messages().some(m => m.message === 'Follower goal ended early'), 'failure action');
  // First seen already past its target: a baseline, nothing runs.
  await send('progress', goal('cg-subs', 'subscription_count', 30, 20));
  await until(async () => (await GoalSet.findById(owner).lean()).outcomes?.['twitch:cg-subs']?.actionSuppressed === 'not_seen', 'baseline outcome');
  // A Premium rule left after a downgrade to Free is recorded, not run.
  await Users.updateOne({ 'accounts.id': owner }, { $set: { plan_tier: 'free' } });
  await redis.hSet(`accounts:twitch:${owner}:data`, { plan_tier: 'free' });
  await send('begin', goal('cg-bits', 'new_bit', 100, 1000));
  await send('progress', goal('cg-bits', 'new_bit', 1000, 1000));
  await until(async () => (await GoalSet.findById(owner).lean()).outcomes?.['twitch:cg-bits']?.actionSuppressed === 'plan', 'plan outcome');
  await sleep(6000); // one more worker pass
  const sent = messages();
  assert.equal(sent.filter(m => m.message === 'Twitch follower goal reached!').length, 1, 'reached runs once (dips and a later end do not repeat it)');
  assert.equal(sent.filter(m => m.message === 'Follower goal ended early').length, 1);
  assert.equal(sent.some(m => m.message === 'Sub goal reached!' || m.message === 'Bits goal reached!'), false);
  const outcomes = (await GoalSet.findById(owner).lean()).outcomes;
  assert.deepEqual([outcomes['twitch:cg-follow'].actionStatus, outcomes['twitch:cg-follow-2'].phase], ['finished', 'failed']);
  stored = await readTwitchGoals(owner);
  assert.deepEqual(stored.goals.find(g => g.id === 'cg-follow').phase, 'ended');
  const journaled = await DomainEventSchema.findOne({ channelID: owner, type: 'channel.goal.updated' }).lean();
  assert.ok(Math.abs(journaled.expiresAt - journaled.journaledAt - 86_400_000) < 60_000, 'goal events are kept one day');
  console.log('PASS real cron: goal events projected by overlay-interactions-v1; reached once on a Twitch crossing, failure on a not-achieved end, retries/dips/late end never repeat, baselines and Premium-on-Free rules recorded without running.');
}

if (target === 'bot') {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
    if (ready) break; await sleep(500);
  }
  assert.ok(ready, 'bot runtime rejects unsigned events');
  await redis.hSet(`accounts:twitch:${owner}:data`, { id: owner, name: 'tg', plan_tier: 'pro', chat_enabled: 'false' });
  async function webhook(type, event, id = randomUUID()) {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ subscription: { id: 'sub-' + type, type, version: '1', status: 'enabled', condition: { broadcaster_user_id: owner }, transport: { method: 'webhook' }, created_at: timestamp, cost: 0 }, event });
    const signature = 'sha256=' + createHmac('sha256', secret).update(id + timestamp + body).digest('hex');
    return (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': id,
      'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': signature, 'Twitch-Eventsub-Message-Type': 'notification' } })).status;
  }
  const event = { id: 'bg-1', broadcaster_user_id: owner, broadcaster_user_login: 'tg', broadcaster_user_name: 'TG', type: 'follow', description: 'Road to 500', current_amount: 420, target_amount: 500, started_at: new Date(Date.now() - 600_000).toISOString() };
  const id = randomUUID();
  assert.ok(await webhook('channel.goal.progress', event, id) < 300);
  assert.equal(await webhook('channel.goal.progress', event, id), 204, 'a Twitch retry is not journaled twice');
  assert.ok(await webhook('channel.goal.end', { ...event, is_achieved: true, ended_at: new Date().toISOString() }) < 300);
  assert.ok(await webhook('channel.goal.begin', { ...event, id: 'bg-2' }) < 300);
  const rows = await until(async () => { const found = await DomainEventSchema.find({ channelID: owner, type: /^channel\.goal\./ }).lean(); return found.length === 3 && found; }, 'journaled goal events');
  assert.deepEqual(rows.map(row => row.type).sort(), ['channel.goal.began', 'channel.goal.ended', 'channel.goal.updated']);
  for (const row of rows) assert.ok(Math.abs(row.expiresAt - row.journaledAt - 86_400_000) < 60_000, 'kept one day');
  assert.ok(await webhook('channel.goal.progress', { ...event, type: 'donations' }) >= 400, 'an unknown goal type is refused');
  assert.equal(await DomainEventSchema.countDocuments({ channelID: owner, type: /^channel\.goal\./ }), 3);
  await sleep(1000);
  assert.equal(messages().length, 0, 'goal events send nothing to chat by themselves');
  console.log('PASS real bot webhook: signed channel.goal.* notifications journaled once with 1-day retention; unknown types refused; nothing sent inline.');
}

const tests = spawnSync('node', ['--test', '--experimental-test-module-mocks', 'dist/goals/twitch.test.js', 'dist/goals/twitch_store.test.js', 'dist/goals/twitch_settle.test.js',
  'dist/goals/model.test.js', 'dist/goals/service_monthly.test.js', 'dist/custom_widgets/goal-source.test.js', 'dist/custom_widgets/session.test.js',
  'dist/domain_events/domain_event_consumers.test.js', 'dist/domain_events/domain_event_contracts.test.js'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_OPTIONS: '' } });
process.stdout.write(tests.stdout.split('\n').filter(line => /^# (tests|pass|fail)|^not ok|^ℹ (tests|pass|fail)|^✖/.test(line)).join('\n') + '\n'); process.stderr.write(tests.stderr.slice(-2000));
assert.equal(tests.status, 0, 'unit tests in the candidate image');
console.log('PASS runtime target: ' + target);
process.exit(0);
