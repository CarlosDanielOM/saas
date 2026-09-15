import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDefenseBaseline } from './follow_defense_baseline.js';
const days = Array.from({ length: 30 }, (_, i) => ({ day: String(i), follows: 20000 }));
const streams = days.map(d => ({ ...d, count: 1 }));
test('20k/day channel gets a 40k wave threshold, keeping 10k below attack', () => {
    const result = calculateDefenseBaseline(days, streams, [], 123);
    assert.equal(result.averageDaily, 20000); assert.equal(result.attackThreshold, 40000);
    assert.equal(result.calculatedAt, 123);
});
test('completed-stream average protects channels streaming less often', () => {
    const result = calculateDefenseBaseline(days.map(d => ({ ...d, follows: 1000 })), streams.slice(0, 3), []);
    assert.equal(result.attackThreshold, 40000);
});
test('known attack days cannot train the baseline upward', () => {
    const result = calculateDefenseBaseline([...days.slice(0, 29), { day: '29', follows: 10000000 }], streams, ['29']);
    assert.equal(result.averageDaily, 20000); assert.equal(result.attackThreshold, 40000);
});
test('sparse history waits for manual attack and small channels have a floor', () => {
    assert.equal(calculateDefenseBaseline(days.slice(0, 6), streams.slice(0, 6), []).attackThreshold, null);
    assert.equal(calculateDefenseBaseline(days, streams.slice(0, 2), []).attackThreshold, null);
    assert.equal(calculateDefenseBaseline(days.map(d => ({ ...d, follows: 1 })), streams.map(s => ({ ...s, follows: 1 })), []).attackThreshold, 500);
});
