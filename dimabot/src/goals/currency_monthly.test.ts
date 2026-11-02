import test from 'node:test';
import assert from 'node:assert/strict';
import { newGoal } from './model.js';
import { customGoalDelta, goalCurrency, goalWeightedAmount, type GoalCurrency } from './currency.js';
import { goalMonthAt, goalMonthForKey, nextGoalMonth } from './monthly.js';

const currency: GoalCurrency = { code: 'USD', bitValue: 1, subscriptionValue: 175,
  items: [{ key: 'streamloots_chest', label: 'Chest', unitAmount: 250, feeBasisPoints: 1000 }] };
const base = { name: 'Monthly support', metric: 'currency', target: 25_000, mode: 'monthly', timeZone: 'America/New_York', currency };
const now = Date.parse('2026-10-30T12:00:00Z');

test('currency goals require Premium, explicit 2-decimal configuration and cannot use active ledgers', () => {
  assert.throws(() => newGoal(base, 'free', 'goal', now), /Premium/);
  assert.throws(() => newGoal({ ...base, mode: 'current', timeZone: undefined }, 'premium', 'goal', now));
  const goal = newGoal(base, 'premium', 'goal', now);
  assert.equal(goal.startsAt, now);
  assert.deepEqual(goal.currency, currency);
  assert.equal(goal.timeZone, 'America/New_York');
  assert.equal(goalWeightedAmount(currency.bitValue, 250) + goalWeightedAmount(currency.subscriptionValue, 3), 775);
});

test('currency and custom item arithmetic rounds once per transaction, without float or overflow', () => {
  assert.equal(customGoalDelta(currency, 'streamloots_chest', 1), 225);
  assert.equal(customGoalDelta({ ...currency, items: [{ ...currency.items[0], feeBasisPoints: 2000 }] }, 'streamloots_chest', 1), 200);
  assert.equal(goalWeightedAmount(1, 3, 5000), 2);
  assert.equal(customGoalDelta(currency, 'other_item', 1), null);
  assert.throws(() => goalWeightedAmount(1_000_000_000, 1_000_000_000));
  for (const qty of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, '1']) assert.throws(() => customGoalDelta(currency, 'streamloots_chest', qty as number));
});

test('currency configuration rejects invalid rates, unknown codes, keys and empty effective sources', () => {
  for (const invalid of [
    { ...currency, code: 'JPY' }, { ...currency, bitValue: -1 }, { ...currency, bitValue: 1.5 },
    { ...currency, subscriptionValue: '175' }, { ...currency, items: [{ ...currency.items[0], feeBasisPoints: 10001 }] },
    { ...currency, items: [{ ...currency.items[0], unitAmount: 0 }] }, { ...currency, items: [{ ...currency.items[0], key: 'A.b' }] },
    { ...currency, items: [currency.items[0], currency.items[0]] },
    { ...currency, bitValue: 0, subscriptionValue: 0, items: [] },
    { ...currency, bitValue: 0, subscriptionValue: 0, items: [{ ...currency.items[0], feeBasisPoints: 10000 }] }
  ]) assert.throws(() => goalCurrency(invalid));
  assert.equal(goalCurrency({ ...currency, bitValue: 0, subscriptionValue: 0 }).items.length, 1);
});

test('calendar months use local midnight across DST, December rollover, and exact end boundaries', () => {
  const march = goalMonthForKey('2026-03', 'America/New_York');
  assert.equal(new Date(march.startsAt).toISOString(), '2026-03-01T05:00:00.000Z');
  assert.equal(new Date(march.endsAt).toISOString(), '2026-04-01T04:00:00.000Z');
  assert.equal(goalMonthAt(march.endsAt - 1, 'America/New_York').key, '2026-03');
  assert.equal(goalMonthAt(march.endsAt, 'America/New_York').key, '2026-04');
  const nov = goalMonthForKey('2026-11', 'America/New_York');
  assert.equal(new Date(nov.startsAt).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(new Date(nov.endsAt).toISOString(), '2026-12-01T05:00:00.000Z');
  const december = goalMonthForKey('2026-12', 'America/New_York');
  assert.equal(nextGoalMonth(december.key, 'America/New_York').key, '2027-01');
  assert.equal(new Date(december.endsAt).toISOString(), '2027-01-01T05:00:00.000Z');
  assert.equal(new Date(goalMonthForKey('2026-10', 'Asia/Kathmandu').startsAt).toISOString(), '2026-09-30T18:15:00.000Z');
  assert.throws(() => newGoal({ ...base, timeZone: 'Mars/Olympus' }, 'premium', 'g', now));
  assert.throws(() => newGoal({ ...base, timeZone: '+05:00' }, 'premium', 'g', now));
});
