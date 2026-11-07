import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHelixGoal, parseTwitchGoalEvent, publicTwitchGoals, reduceTwitchGoalEvent, reduceTwitchGoalsHelix, seTwitchGoals, twitchGoalsPermission,
  twitchGoalTypesFor, twitchGoalViews, visibleTwitchGoals, type StoredTwitchGoals } from './twitch.js';

const t0 = Date.parse('2026-11-07T12:00:00.000Z');
const iso = (ms: number) => new Date(t0 + ms).toISOString();
const raw = (current: number, extra: Record<string, unknown> = {}) => ({ id: 'g1', broadcaster_user_id: '1', type: 'follow', description: 'Road to 500',
  current_amount: current, target_amount: 500, started_at: iso(-3_600_000), ...extra });
const event = (type: 'begin' | 'progress' | 'end', current: number, extra: Record<string, unknown> = {}) => parseTwitchGoalEvent(`channel.goal.${type}`, raw(current, extra));
function apply(state: StoredTwitchGoals | null, type: 'begin' | 'progress' | 'end', current: number, at: number, receipt: string, extra: Record<string, unknown> = {}) {
  return reduceTwitchGoalEvent(state, event(type, current, extra), iso(at), receipt, t0 + at);
}

test('parsing: both follower spellings, quoted numbers, strict ids and types', () => {
  assert.equal(parseTwitchGoalEvent('channel.goal.progress', raw('420' as never)).current, 420);
  assert.equal(parseHelixGoal({ ...raw(1), type: 'follower', created_at: iso(0) }).type, 'follow');
  const ended = parseTwitchGoalEvent('channel.goal.end', raw(500, { is_achieved: true, ended_at: iso(5) }));
  assert.deepEqual([ended.kind, ended.achieved, ended.endedAt], ['end', true, iso(5)]);
  assert.equal(parseTwitchGoalEvent('channel.goal.progress', raw(1, { description: 'x'.repeat(80) })).description.length, 40);
  for (const bad of [{ id: 'a.b' }, { id: '$x' }, { type: 'donation' }, { current_amount: -1 }, { current_amount: 1.5 }, { started_at: 'yesterday' }]) {
    assert.throws(() => parseTwitchGoalEvent('channel.goal.progress', raw(1, bad)), JSON.stringify(bad));
  }
  assert.throws(() => parseTwitchGoalEvent('channel.hype_train.begin', raw(1)));
});

test('a crossing shown by events is eligible; first seen already reached is a baseline', () => {
  let state = apply(null, 'begin', 400, 0, 'r1')!;
  state = apply(state, 'progress', 499, 1000, 'r2')!;
  assert.equal(state.goals[0].reachedAt, null);
  state = apply(state, 'progress', 500, 2000, 'r3')!;
  assert.deepEqual([state.goals[0].reachedAt, state.goals[0].reachedBy], [iso(2000), 'event']);
  // Latched: going down (net goals) and back up never moves it.
  state = apply(state, 'progress', 480, 3000, 'r4')!;
  state = apply(state, 'progress', 510, 4000, 'r5')!;
  assert.equal(state.goals[0].reachedAt, iso(2000));
  const first = apply(null, 'progress', 520, 0, 'x1')!;
  assert.equal(first.goals[0].reachedBy, 'baseline');
});

test('duplicates and older events change nothing; end is final', () => {
  let state = apply(null, 'progress', 450, 2000, 'r1')!;
  assert.equal(apply(state, 'progress', 460, 3000, 'r1'), null, 'same receipt');
  assert.equal(apply(state, 'progress', 300, 1000, 'r2'), null, 'older event');
  state = apply(state, 'end', 470, 3000, 'r3', { is_achieved: false, ended_at: iso(3000) })!;
  assert.deepEqual([state.goals[0].phase, state.goals[0].achieved, state.goals[0].current], ['ended', false, 470]);
  assert.equal(apply(state, 'progress', 600, 4000, 'r4'), null, 'nothing after the end');
  assert.equal(apply(state, 'begin', 0, 5000, 'r5'), null);
});

test('begin after progress keeps the newer amount; an end with is_achieved counts as reached', () => {
  let state = apply(null, 'progress', 420, 2000, 'r1')!;
  state = apply(state, 'begin', 400, 1000, 'r2') ?? state;
  assert.equal(state.goals[0].current, 420);
  state = apply(state, 'end', 480, 3000, 'r3', { is_achieved: true, ended_at: iso(3000) })!;
  assert.deepEqual([state.goals[0].reachedAt, state.goals[0].reachedBy, state.goals[0].achieved], [iso(3000), 'event', true]);
});

test('Helix: new goals, grace for recent events, missing is recoverable, baseline when first seen reached', () => {
  const row = (current: number, id = 'g1') => parseHelixGoal({ ...raw(current), id, created_at: iso(-3_600_000) });
  let state = reduceTwitchGoalsHelix(null, [row(510)], iso(0), t0);
  assert.deepEqual([state.goals[0].reachedBy, state.access], ['baseline', 'ok'], 'already there on first sight: never fires');
  // Seen below, then Helix sees it reached: no latch yet (the crossing event may still be on its way).
  state = reduceTwitchGoalsHelix(null, [row(450)], iso(0), t0);
  state = reduceTwitchGoalsHelix(state, [row(505)], iso(60_000), t0 + 60_000);
  assert.deepEqual([state.goals[0].reachedAt, state.goals[0].aboveSeenAt], [null, iso(60_000)]);
  const delayed = apply(state, 'progress', 500, 50_000, 'late')!;
  assert.equal(delayed.goals[0].reachedBy, 'event', 'the delayed crossing event still counts');
  const muchLater = apply(state, 'progress', 530, 60_000 + 11 * 60_000, 'later')!;
  assert.equal(muchLater.goals[0].reachedBy, 'baseline', 'a crossing missed long ago never fires on the next follow');
  // An event right before the read keeps its amount over Helix's.
  let fresh = apply(null, 'progress', 470, 100_000, 'e1')!;
  fresh = reduceTwitchGoalsHelix(fresh, [row(460)], iso(110_000), t0 + 110_000);
  assert.equal(fresh.goals[0].current, 470);
  // Not listed: missing (hidden), not ended; listed again: back.
  let gone = reduceTwitchGoalsHelix(fresh, [], iso(300_000), t0 + 300_000);
  assert.deepEqual([gone.goals[0].phase, visibleTwitchGoals(gone, t0 + 300_000).length], ['missing', 0]);
  assert.equal(reduceTwitchGoalsHelix(gone, [row(475)], iso(400_000), t0 + 400_000).goals[0].phase, 'active');
  assert.equal(apply(gone, 'progress', 480, 200_000, 'old')!.goals[0].phase, 'missing', 'an event from before the read does not bring it back');
  assert.equal(apply(gone, 'progress', 480, 350_000, 'new')!.goals[0].phase, 'active');
  gone = apply(gone, 'end', 480, 360_000, 'end', { is_achieved: false, ended_at: iso(360_000) })!;
  assert.equal(gone.goals[0].phase, 'ended');
  // A stale Helix list never revives an ended goal.
  assert.equal(reduceTwitchGoalsHelix(gone, [row(480)], iso(370_000), t0 + 370_000).goals[0].phase, 'ended');
  // A goal that just started isn't marked missing by a read that went out before it.
  const brandNew = apply(null, 'begin', 0, 1000, 'b', { started_at: iso(500) })!;
  assert.equal(reduceTwitchGoalsHelix(brandNew, [], iso(2000), t0 + 2000).goals[0].phase, 'active');
});

test('permission keeps known goals; plans; views and widget projections', () => {
  const state = apply(null, 'progress', 420, 0, 'r1')!;
  const denied = twitchGoalsPermission(state, iso(10));
  assert.deepEqual([denied.access, denied.goals.length], ['permission', 1]);
  assert.deepEqual(twitchGoalTypesFor('free').includes('new_bit'), false);
  assert.deepEqual(twitchGoalTypesFor('premium').includes('new_cheerer'), true);
  const views = twitchGoalViews(state, t0);
  assert.equal(views[0].percent, 84);
  const [widget] = publicTwitchGoals(views);
  assert.deepEqual([widget.source, widget.metric, widget.mode, widget.name, widget.status], ['twitch', 'follows', 'twitch', 'Road to 500', 'active']);
  assert.equal(JSON.stringify(widget).includes('reachedBy'), false, 'internal fields stay out of widgets');
  const ended = apply(state, 'end', 500, 1000, 'r2', { is_achieved: true, ended_at: iso(1000) })!;
  assert.equal(visibleTwitchGoals(ended, t0 + 3_600_000)[0].status, 'ended');
  assert.equal(visibleTwitchGoals(ended, t0 + 2 * 3_600_000 + 1000).length, 0, 'ended goals show for two hours');
});

test('StreamElements goal keys for Twitch-sourced layers', () => {
  const goal = (id: string, type: string, current: number, extra: Record<string, unknown> = {}) =>
    parseTwitchGoalEvent('channel.goal.progress', { ...raw(current), id, type, target_amount: 1000, ...extra });
  let state: StoredTwitchGoals | null = null;
  for (const [i, next] of [goal('f', 'follow', 420), goal('p', 'subscription', 30), goal('c', 'new_subscription_count', 7), goal('b', 'new_bit', 900)].entries()) {
    state = reduceTwitchGoalEvent(state, next, iso(i), `r${i}`, t0);
  }
  const { data, sources } = seTwitchGoals(twitchGoalViews(state, t0));
  assert.deepEqual(data, { 'follower-goal': { amount: 420 }, 'subscriber-goal': { amount: 7 }, 'cheer-goal': { amount: 900 }, 'tip-goal': { amount: 0 } });
  assert.equal(sources['subscriber-goal'].id, 'c', 'sub counts win over points');
  assert.equal(sources['tip-goal'], undefined);
  assert.deepEqual(seTwitchGoals([]).data['follower-goal'], { amount: 0 }, 'no Twitch goal: 0, never our own goal');
});

test('review cases: a Helix-seen reach dates the crossing; a reached goal that dips and ends is never "unreached"', () => {
  const row = (current: number) => parseHelixGoal({ ...raw(current), created_at: iso(-3_600_000) });
  // Helix 99 then 100 at +60 s; an event at +180 s (101) must not move the crossing past +60 s.
  let state = reduceTwitchGoalsHelix(null, [row(499)], iso(0), t0);
  state = reduceTwitchGoalsHelix(state, [row(500)], iso(60_000), t0 + 60_000);
  state = apply(state, 'progress', 501, 180_000, 'later')!;
  assert.deepEqual([state.goals[0].reachedAt, state.goals[0].reachedBy], [iso(60_000), 'event']);
  // Helix 99 then 100, a dip to 99 and a not-achieved end: reached (baseline), never a failure.
  let dipped = reduceTwitchGoalsHelix(null, [row(499)], iso(0), t0);
  dipped = reduceTwitchGoalsHelix(dipped, [row(500)], iso(60_000), t0 + 60_000);
  dipped = reduceTwitchGoalsHelix(dipped, [row(499)], iso(120_000), t0 + 120_000);
  dipped = apply(dipped, 'end', 499, 180_000, 'end', { is_achieved: false, ended_at: iso(180_000) })!;
  assert.deepEqual([dipped.goals[0].phase, dipped.goals[0].achieved, dipped.goals[0].reachedAt, dipped.goals[0].reachedBy], ['ended', false, iso(60_000), 'baseline']);
});
