import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let calls = 0, behavior: 'ok' | 'throw' | 'reject' = 'ok';
mock.module('../utils/logger.js', { namedExports: { warn: () => {
    calls++;
    if (behavior === 'throw') throw new Error('logger failed');
    if (behavior === 'reject') return Promise.reject(new Error('logger failed'));
    return Promise.resolve({ success: true });
} } });
const { warnPetMood } = await import('./mood_warnings.js');
const { safelyResolveMood } = await import('./mood_decoration.js');

test('warnings are bounded and logger failures do not poison later mood resolution', async () => {
    let now = 100_000;
    const clock = mock.method(Date, 'now', () => now);
    behavior = 'throw'; assert.equal(safelyResolveMood(() => { throw new Error('bad'); }, '1'), 'neutral');
    assert.equal(safelyResolveMood(() => 'happy', '1'), 'happy');
    behavior = 'reject'; warnPetMood('instruction', '2'); await Promise.resolve();
    behavior = 'ok';
    for (let i = 0; i < 40; i++) warnPetMood('extraction', String(i + 10));
    assert.equal(calls, 10);
    now += 60_001;
    warnPetMood('extraction', '10'); warnPetMood('extraction', '10');
    assert.equal(calls, 11);
    clock.mock.restore();
});
