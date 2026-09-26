import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
const calls: unknown[][] = [];
mock.module('../availability/service.js', { namedExports: {
    availabilityAdapters: [{ name: 'command' }, { name: 'redemption' }], MAX_AVAILABILITY_SECONDS: 604800,
    setAvailability: async (...args: unknown[]) => { calls.push(args); }
} });
const { registerAvailabilityFunctions } = await import('./functions/availability.functions.js');
const { parse } = await import('./parser.js');
const { evaluate, createExecutionContext } = await import('./evaluator.js');
registerAvailabilityFunctions();
async function run(source: string, authored = true) {
    calls.length = 0;
    const parsed = parse(source); assert.equal(parsed.error, undefined);
    return String((await evaluate(parsed.ast, createExecutionContext({ broadcasterId: 'test-channel', userLevel: 1,
        enforceFunctionPermissions: !authored }))).value);
}
test('enable/disable share the registry and preserve quoted names and duration', async () => {
    assert.equal(await run('$(disable.command discord 300)'), '');
    assert.deepEqual(calls, [['command', 'test-channel', 'discord', false, 300]]);
    assert.equal(await run('$(enable.redemption "Hydrate please" 60)'), '');
    assert.deepEqual(calls, [['redemption', 'test-channel', 'Hydrate please', true, 60]]);
    assert.equal(await run('$(enable.command !discord)'), '');
    assert.deepEqual(calls, [['command', 'test-channel', '!discord', true, undefined]]);
});
test('AI callers need moderator level before availability mutations', async () => {
    for (const action of ['enable.command x', 'disable.command x', 'enable.redemption x', 'disable.redemption x']) {
        assert.match(await run(`$(${action})`, false), /permission denied/i);
        assert.deepEqual(calls, []);
    }
});
test('missing targets and extra arguments give usage without mutating anything', async () => {
    for (const source of ['$(disable.command)', '$(enable.redemption "")', '$(disable.redemption Hydrate please 300)']) {
        assert.match(await run(source), /Usage:/);
        assert.deepEqual(calls, []);
    }
});
