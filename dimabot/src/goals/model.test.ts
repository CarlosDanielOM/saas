import test from 'node:test';
import assert from 'node:assert/strict';
import { newGoal, goalLimit, eligible, goalActions, nextGoalOutcome, type GoalOutcome } from './model.js';
const now = Date.parse('2026-10-13T12:00:00Z');
const base = { name: 'Community goal', metric: 'follows', mode: 'total', target: 100 };
test('plan limits and Bits entitlement', () => {
  assert.deepEqual(['free', 'premium', 'pro'].map(p => goalLimit(p as 'free' | 'premium' | 'pro')), [2, 3, 4]);
  assert.throws(() => newGoal({ ...base, metric: 'bits' }, 'free', 'g', now));
  assert.equal(newGoal({ ...base, metric: 'bits' }, 'premium', 'g', now).metric, 'bits');
});
test('current total supports follows/subs only and never accumulates events', () => {
  for (const metric of ['follows', 'subs']) {
    const goal = newGoal({ ...base, metric, mode: 'current' }, 'free', 'g', now);
    assert.equal(goal.mode, 'current');
    assert.equal(eligible(goal, now, now), false);
  }
  for (const plan of ['premium', 'pro'] as const) assert.throws(() => newGoal({ ...base, metric: 'bits', mode: 'current' }, plan, 'g', now));
  assert.equal(newGoal(base, 'free', 'g', now).mode, 'total', 'existing since-creation mode keeps its identity');
});
test('invalid inputs never become goals', () => {
  for (const target of [0, -1, 1.5, NaN, Infinity, '100', 1_000_000_001]) assert.throws(() => newGoal({ ...base, target }, 'free', 'g', now));
  for (const value of [null, [], {}, { ...base, name: '   ' }, { ...base, metric: 'donations' }, { ...base, mode: 'unknown' }, { ...base, mode: 'rolling', windowSeconds: 90 * 86400 + 1 }]) assert.throws(() => newGoal(value, 'free', 'g', now));
});
test('total begins at creation, fixed is start-inclusive/end-exclusive, rolling expires at boundary', () => {
  const total = newGoal(base, 'free', 'g', now);
  assert(!eligible(total, now - 1, now)); assert(eligible(total, now, now)); assert(!eligible(total, now + 1, now));
  const fixed = newGoal({ ...base, mode: 'fixed', startsAt: new Date(now + 1000).toISOString(), endsAt: new Date(now + 2000).toISOString() }, 'free', 'g', now);
  assert(!eligible(fixed, now + 999, now + 3000)); assert(eligible(fixed, now + 1000, now + 3000)); assert(!eligible(fixed, now + 2000, now + 3000));
  const rolling = newGoal({ ...base, mode: 'rolling', windowSeconds: 60 }, 'free', 'g', now);
  assert(eligible(rolling, now, now + 59_999)); assert(!eligible(rolling, now, now + 60_000));
  assert.throws(() => newGoal({ ...base, mode: 'fixed', startsAt: new Date(now - 120000).toISOString(), endsAt: new Date(now + 2000).toISOString() }, 'free', 'g', now));
});

test('actions validate independently, preserve literal messages and restrict failure modes', () => {
  assert.deepEqual(goalActions(undefined, 'total'), {});
  assert.deepEqual(goalActions({completion:{type:'message',text:'$(chat.send literal)'}}, 'total'), {completion:{type:'message',text:'$(chat.send literal)'}});
  for (const mode of ['fixed','rolling'] as const) assert.equal(goalActions({failure:{type:'ast',text:'$(chat.send failed)'}}, mode).failure?.type, 'ast');
  for (const value of [null, [], {unexpected:{}}, {completion:{type:'other',text:'x'}}, {completion:{type:['message'],text:'x'}}, {completion:{type:'message',text:' '}}, {completion:{type:'message',text:'x'.repeat(501)}}, {completion:{type:'ast',text:'x'.repeat(4001)}}]) assert.throws(() => goalActions(value, 'rolling'));
  for (const mode of ['total','current'] as const) assert.throws(() => goalActions({failure:{type:'message',text:'x'}}, mode));
});
test('rolling goals fail only after succeeding and can complete again', () => {
  const goal = newGoal({...base,mode:'rolling',windowSeconds:60}, 'free', 'g', now);
  const completed: GoalOutcome = {phase:'completed',sequence:1,at:now,actionStatus:'finished'};
  const failed: GoalOutcome = {...completed,phase:'failed',sequence:2};
  assert.equal(nextGoalOutcome(goal, 99, undefined, now), null);
  assert.equal(nextGoalOutcome(goal, 100, undefined, now), 'completed');
  assert.equal(nextGoalOutcome(goal, 120, completed, now), null);
  assert.equal(nextGoalOutcome(goal, 99, completed, now), 'failed');
  assert.equal(nextGoalOutcome(goal, 0, failed, now), null);
  assert.equal(nextGoalOutcome(goal, 100, failed, now), 'completed');
});
test('fixed deadlines and non-rolling outcomes are terminal', () => {
  const goal = newGoal({...base,mode:'fixed',startsAt:new Date(now+1000).toISOString(),endsAt:new Date(now+2000).toISOString()}, 'free', 'g', now);
  assert.equal(nextGoalOutcome(goal,100,undefined,now),null);
  assert.equal(nextGoalOutcome(goal,99,undefined,now+1999),null);
  assert.equal(nextGoalOutcome(goal,99,undefined,now+2000),'failed');
  assert.equal(nextGoalOutcome(goal,100,undefined,now+2000),'completed');
  for (const mode of ['fixed','total','current'] as const) {
    for (const phase of ['completed','failed'] as const) assert.equal(nextGoalOutcome({...goal,mode},100,{phase,sequence:1,at:now,actionStatus:'error'},now+3000),null);
  }
});
