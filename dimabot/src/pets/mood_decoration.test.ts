import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefetchMoodCueSettings, safelyBuildMoodInstruction, safelyFilterMoodCues, safelyResolveMood } from './mood_decoration.js';

test('decoration errors become neutral mood or no prompt', () => {
    const fail = (): never => { throw new Error('bad mood data'); };
    assert.equal(safelyResolveMood(fail), 'neutral');
    assert.equal(safelyBuildMoodInstruction(fail), '');
    assert.equal(safelyResolveMood(() => 'happy'), 'happy');
    assert.equal(safelyBuildMoodInstruction(() => '[happy]'), '[happy]');
});
test('optional cue lookup never waits and tolerates failures', async () => {
    let finish!: (value: string) => void;
    const ready = prefetchMoodCueSettings(() => new Promise<string>(resolve => { finish = resolve; }));
    assert.equal(ready(), undefined);
    finish('settings'); await Promise.resolve(); assert.equal(ready(), 'settings');
    const rejected = prefetchMoodCueSettings(() => Promise.reject(new Error('unavailable')));
    const thrown = prefetchMoodCueSettings<string>(() => { throw new Error('unavailable'); });
    await Promise.resolve(); assert.equal(rejected(), undefined); assert.equal(thrown(), undefined);
});
test('cue filtering cannot discard or interrupt speech', () => {
    assert.equal(safelyFilterMoodCues('[happy] Hi', () => 'Hi'), 'Hi');
    assert.equal(safelyFilterMoodCues('[happy] Hi', () => ' '), '[happy] Hi');
    assert.equal(safelyFilterMoodCues('[happy] Hi', () => { throw new Error('bad settings'); }), '[happy] Hi');
});
