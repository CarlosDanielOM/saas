import test from 'node:test';
import assert from 'node:assert/strict';
import { newGoal, goalLimit, eligible } from './model.js';
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
