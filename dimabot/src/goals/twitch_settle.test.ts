import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import Users from '../schemas/users.schema.js';
import type { StoredTwitchGoals, TwitchGoal } from './twitch.js';

mock.module('../utils/databases/mongodb.database.js', { namedExports: { getMongoDBConnection: async () => undefined } });
mock.module('../widget_feed/session-refresh.js', { namedExports: { requestWidgetSessionRefresh: () => undefined } });
let twitch: StoredTwitchGoals | null = null;
mock.module('./twitch-store.js', { namedExports: { readTwitchGoals: async () => structuredClone(twitch) } });
const delivered: string[] = [];
let failDelivery = false;
mock.module('../utils/ast_command_delivery.js', { namedExports: { deliverAstMessage: async (_channel: string, message: { parsedText: string }) => {
  delivered.push(message.parsedText); return { error: failDelivery };
} } });
const { GoalSet, goalSnapshot, changeTwitchGoalRule } = await import('./service.js');
const { settleGoalChannel, settleGoals } = await import('./completion.js');

const now = Date.parse('2026-11-07T12:00:00.000Z');
function goal(overrides: Partial<TwitchGoal> = {}): TwitchGoal {
  return { id: 'g1', type: 'follow', description: 'Road to 500', current: 500, target: 500, startedAt: new Date(now - 7_200_000).toISOString(), phase: 'active',
    achieved: null, endedAt: null, eventAt: new Date(now - 60_000).toISOString(), seenAt: null, missingSince: null, seenBelow: true, aboveSeenAt: null,
    reachedAt: new Date(now - 60_000).toISOString(), reachedBy: 'event', ...overrides };
}
function setup(t: TestContext, initial: Record<string, any> | null, plan = 'pro') {
  let state = structuredClone(initial);
  delivered.length = 0; failDelivery = false;
  const path = (value: any, key: string) => key.split('.').reduce((row, part) => row?.[part], value);
  const query = (value: () => any) => ({ select() { return this; }, sort() { return this; }, lean: async () => structuredClone(value()) });
  t.mock.method(Users, 'findOne', (() => query(() => ({ plan_tier: plan }))) as never);
  t.mock.method(GoalSet, 'findById', (() => query(() => state)) as never);
  t.mock.method(GoalSet, 'create', (async ([doc]: any[]) => { if (state) throw Object.assign(new Error('dup'), { code: 11000 }); state = structuredClone(doc); }) as never);
  t.mock.method(GoalSet, 'updateOne', (async (filter: any, update: any) => {
    if (!state || filter._id !== state._id || filter.revision !== undefined && filter.revision !== state.revision) return { modifiedCount: 0 };
    for (const [key, expected] of Object.entries(filter)) {
      if (key === '_id' || key === 'revision') continue;
      const actual = path(state, key);
      if (expected && typeof expected === 'object' && '$exists' in (expected as object)) { if ((actual !== undefined) !== (expected as any).$exists) return { modifiedCount: 0 }; }
      else if (actual !== expected) return { modifiedCount: 0 };
    }
    for (const [key, value] of Object.entries(update.$set || {})) {
      // Twitch outcome keys contain a colon but no dots: `outcomes.twitch:<id>` is two levels.
      const parts = key.split('.'); let cursor = state; for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
      cursor[parts.at(-1)!] = structuredClone(value);
    }
    for (const key of Object.keys(update.$unset || {})) { const parts = key.split('.'); delete path(state, parts.slice(0, -1).join('.'))?.[parts.at(-1)!]; }
    if (update.$inc?.revision) state.revision += update.$inc.revision;
    return { modifiedCount: 1 };
  }) as never);
  return { get state() { return state!; } };
}
const rule = (type: string, actions: Record<string, unknown>, armedAt = now - 3_600_000) => ({ type,
  ...Object.fromEntries(Object.entries(actions).map(([key, text]) => [key, { type: 'message', text, armedAt }])) });

test('a crossing shown by Twitch runs the completion action once; failures run on a not-achieved end', async t => {
  const h = setup(t, { _id: 'c', revision: 3, goals: [], outcomes: {}, twitchActions: [rule('follow', { completion: 'We did it!', failure: 'Next time' })] });
  twitch = { goals: [goal(), goal({ id: 'g2', current: 300, reachedAt: null, reachedBy: null, phase: 'ended', achieved: false, endedAt: new Date(now - 30_000).toISOString() })],
    receipts: [], access: 'ok', checkedAt: null };
  await settleGoalChannel('c', now);
  await settleGoalChannel('c', now + 5000);
  assert.deepEqual(delivered.sort(), ['Next time', 'We did it!']);
  assert.deepEqual([h.state.outcomes['twitch:g1'].phase, h.state.outcomes['twitch:g1'].actionStatus], ['completed', 'finished']);
  assert.deepEqual([h.state.outcomes['twitch:g2'].phase, h.state.outcomes['twitch:g2'].actionStatus], ['failed', 'finished']);
  const snapshot = await goalSnapshot('c', now);
  assert.equal(snapshot.limit, 4);
  assert.equal(snapshot.goals.length, 0, 'Twitch goals never take a goal slot');
});

test('never runs for what happened before the action was saved, baselines, stale or gone goals', async t => {
  const h = setup(t, { _id: 'c', revision: 1, goals: [], outcomes: {}, twitchActions: [rule('follow', { completion: 'yay', failure: 'boo' }, now - 8 * 3_600_000)] });
  twitch = { goals: [
    goal({ id: 'before', reachedAt: new Date(now - 9 * 3_600_000).toISOString() }),
    goal({ id: 'baseline', reachedBy: 'baseline' }),
    goal({ id: 'stale', reachedAt: new Date(now - 7 * 3_600_000).toISOString() }),
    goal({ id: 'gone', current: 100, reachedAt: null, reachedBy: null, phase: 'missing', missingSince: new Date(now - 1000).toISOString() }),
    goal({ id: 'unknown-end', current: 100, reachedAt: null, reachedBy: null, phase: 'ended', achieved: null, endedAt: new Date(now - 1000).toISOString() })
  ], receipts: [], access: 'ok', checkedAt: null };
  await settleGoalChannel('c', now);
  assert.deepEqual(delivered, []);
  assert.equal(h.state.outcomes['twitch:before'], undefined, 'saved after it happened: nothing recorded, nothing run');
  assert.equal(h.state.outcomes['twitch:baseline'].actionSuppressed, 'not_seen');
  assert.equal(h.state.outcomes['twitch:stale'].actionSuppressed, 'historical_catchup');
  assert.equal(h.state.outcomes['twitch:gone'], undefined);
  assert.equal(h.state.outcomes['twitch:unknown-end'], undefined);
});

test('Bits goal actions need Premium to save and to run; Twitch data itself is free', async t => {
  const h = setup(t, { _id: 'c', revision: 1, goals: [], outcomes: {} }, 'free');
  await assert.rejects(changeTwitchGoalRule('c', 'new_bit', { actions: { completion: { type: 'message', text: 'bits!' } } }, 1), /require Premium/);
  await changeTwitchGoalRule('c', 'follow', { actions: { completion: { type: 'message', text: 'hi' } } }, 1);
  assert.equal(h.state.revision, 2);
  // A Premium rule left from before a downgrade is recorded but not run.
  h.state.twitchActions.push(rule('new_bit', { completion: 'bits!' }));
  twitch = { goals: [goal({ id: 'b', type: 'new_bit' })], receipts: [], access: 'ok', checkedAt: null };
  await settleGoalChannel('c', now);
  assert.deepEqual(delivered, []);
  assert.equal(h.state.outcomes['twitch:b'].actionSuppressed, 'plan');
  const snapshot = await goalSnapshot('c', now);
  assert.deepEqual([snapshot.twitch.goals.length, snapshot.twitch.actionTypes.includes('new_bit')], [1, false], 'free plans see Twitch Bits goals');
});

test('rules: validation, armedAt kept while unchanged, removal, revision checks', async t => {
  const h = setup(t, null, 'pro');
  await assert.rejects(changeTwitchGoalRule('c', 'donation', { actions: {} }, 0), /Unknown Twitch goal type/);
  await assert.rejects(changeTwitchGoalRule('c', 'follow', { actions: { completion: { type: 'shell', text: 'x' } } }, 0), /message or AST/);
  await assert.rejects(changeTwitchGoalRule('c', 'follow', { name: 'x' }, 0), /Only actions/);
  await changeTwitchGoalRule('c', 'follow', { actions: { completion: { type: 'message', text: 'A' } } }, 0);
  const armed = h.state.twitchActions[0].completion.armedAt;
  await new Promise(resolve => setTimeout(resolve, 5));
  await changeTwitchGoalRule('c', 'follow', { actions: { completion: { type: 'message', text: 'A' }, failure: { type: 'ast', text: '$(user)' } } }, 1);
  assert.equal(h.state.twitchActions[0].completion.armedAt, armed, 'unchanged action keeps its time');
  assert.ok(h.state.twitchActions[0].failure.armedAt > armed);
  await assert.rejects(changeTwitchGoalRule('c', 'follow', { actions: {} }, 1), /Goals changed/);
  await changeTwitchGoalRule('c', 'follow', { actions: {} }, 2);
  assert.deepEqual(h.state.twitchActions, []);
});

test('a configuration change during settlement wins; old Twitch outcomes are pruned; rules-only channels settle', async t => {
  const h = setup(t, { _id: 'c', revision: 5, goals: [], twitchActions: [rule('follow', { completion: 'go' })],
    outcomes: { 'twitch:old': { phase: 'completed', sequence: 1, at: now - 31 * 86_400_000, actionStatus: 'finished' }, 'g:2026-01': { phase: 'failed', sequence: 1, at: 0, actionStatus: 'none' } } });
  twitch = { goals: [goal()], receipts: [], access: 'ok', checkedAt: null };
  const update = GoalSet.updateOne;
  let raced = false;
  t.mock.method(GoalSet, 'updateOne', (async (filter: any, change: any) => {
    if (!raced && filter['outcomes.twitch:g1.sequence']) { raced = true; h.state.revision++; }
    return (update as any)(filter, change);
  }) as never);
  await settleGoalChannel('c', now);
  assert.deepEqual(delivered, [], 'the claim lost to the edit');
  assert.equal(h.state.outcomes['twitch:old'], undefined);
  assert.ok(h.state.outcomes['g:2026-01'], 'our own outcomes are untouched');
  await settleGoalChannel('c', now + 5000);
  assert.deepEqual(delivered, ['go']);
  let filter: unknown;
  t.mock.method(GoalSet, 'find', ((query: unknown) => { filter = query; return { select: () => ({ lean: () => ({ cursor: async function* () {} }) }) }; }) as never);
  await settleGoals();
  assert.deepEqual(filter, { $or: [{ 'goals.0': { $exists: true } }, { 'twitchActions.0': { $exists: true } }] });
});

test('a failed delivery is recorded and never retried', async t => {
  const h = setup(t, { _id: 'c', revision: 1, goals: [], outcomes: {}, twitchActions: [rule('follow', { completion: 'go' })] });
  twitch = { goals: [goal()], receipts: [], access: 'ok', checkedAt: null };
  failDelivery = true;
  await settleGoalChannel('c', now);
  await settleGoalChannel('c', now + 5000);
  assert.deepEqual(delivered, ['go']);
  assert.equal(h.state.outcomes['twitch:g1'].actionStatus, 'error');
});

test('review cases: an action saved after a Helix-seen reach never runs; a Helix-seen reach blocks "ends unreached"', async t => {
  const h = setup(t, { _id: 'c', revision: 1, goals: [], outcomes: {}, twitchActions: [rule('follow', { completion: 'late', failure: 'unreached' }, now - 60_000)] });
  twitch = { goals: [
    goal({ id: 'saved-after', reachedAt: new Date(now - 120_000).toISOString(), aboveSeenAt: new Date(now - 120_000).toISOString() }),
    goal({ id: 'dipped', current: 99, target: 100, reachedAt: null, reachedBy: null, aboveSeenAt: new Date(now - 90_000).toISOString(), phase: 'ended', achieved: false, endedAt: new Date(now - 30_000).toISOString() })
  ], receipts: [], access: 'ok', checkedAt: null };
  await settleGoalChannel('c', now);
  assert.deepEqual(delivered, []);
  assert.equal(h.state.outcomes['twitch:saved-after'], undefined);
  assert.equal(h.state.outcomes['twitch:dipped'], undefined);
});
