import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from './parser.js';
import { createExecutionContext, evaluate, registerFunction } from './evaluator.js';
import { evaluateTimer, snapshotTimerContext, MAX_TIMER_SECONDS, MAX_TIMER_DEPTH } from './timer.js';
import type { FunctionNode, RootNode } from './types.js';

const parseTimer = (source: string) => {
    const result = parse(source);
    assert.equal(result.error, undefined);
    return result.ast.children[0] as FunctionNode;
};
const context = () => createExecutionContext({ broadcasterId: 'test', userId: 'viewer', userLevel: 1 });

test('timer defers nested actions and returns no immediate body text', async () => {
    let effects = 0;
    registerFunction('timer.testaction', async () => { effects++; return ''; });
    let captured: RootNode | undefined;
    const ctx = context();
    const result = await evaluateTimer(parseTimer('$(timer 300 5 minutes over $(timer.testaction))'), ctx,
        async (seconds, body) => { assert.equal(seconds, 300); captured = body; });
    assert.equal(result.value, '');
    assert.equal(effects, 0);
    assert.ok(captured);
    assert.equal((await evaluate(captured, ctx)).value, '5 minutes over');
    assert.equal(effects, 1);
});

test('duration can be computed while the body remains lazy', async () => {
    const ctx = context();
    ctx.variables.set('seconds', '300');
    let duration = 0;
    await evaluateTimer(parseTimer('$(timer %(seconds) "Time is up!")'), ctx,
        async (seconds) => { duration = seconds; });
    assert.equal(duration, 300);
});

for (const source of ['$(timer)', '$(timer 300)', '$(timer -1 $(timer.testaction))',
    '$(timer 0 $(timer.testaction))', '$(timer nope $(timer.testaction))',
    `$(timer ${MAX_TIMER_SECONDS + 1} $(timer.testaction))`, '$(timer Infinity hi)']) {
    test(`rejects invalid timer without scheduling: ${source}`, async () => {
        const result = await evaluateTimer(parseTimer(source), context(), async () => assert.fail('scheduled invalid timer'));
        assert.match(String(result.value), /^timer:/);
    });
}

test('nesting and channel validation do not execute the timer body', async () => {
    for (const overrides of [{ timerDepth: MAX_TIMER_DEPTH }, { broadcasterId: '' }, { platform: 'youtube' }]) {
        const result = await evaluateTimer(parseTimer('$(timer 300 $(timer.testaction))'), { ...context(), ...overrides },
            async () => assert.fail('scheduled invalid timer'));
        assert.match(String(result.value), /^timer:/);
    }
});

test('cache snapshot preserves identity, authorization, variables and loop values without callbacks', () => {
    const ctx = context();
    ctx.authorization = { origin: 'llm', identity: { level: 1, tags: ['subscriber'] } };
    ctx.variables.set('name', 'Original');
    ctx.loopVars!.set('i', '3');
    const saved = JSON.parse(JSON.stringify(snapshotTimerContext(ctx)));
    ctx.variables.set('name', 'Changed');
    assert.deepEqual(saved.variables, [['name', 'Original']]);
    assert.deepEqual(saved.loopVars, [['i', '3']]);
    assert.equal(saved.enforceFunctionPermissions, true);
    assert.deepEqual(saved.authorization, ctx.authorization);
    assert.equal(saved.timerDepth, 1);
    assert.equal(saved.saveUserVariable, undefined);
});

test('deferred restricted actions retain the original caller permission gate', async () => {
    registerFunction('timer.restricted', async () => assert.fail('permission bypass'), {
        description: 'test', syntax: 'timer.restricted', category: 'test', examples: ['timer.restricted'], minUserLevel: 7
    });
    const ctx = context();
    let body: RootNode | undefined;
    await evaluateTimer(parseTimer('$(timer 300 $(timer.restricted))'), ctx, async (_seconds, node) => { body = node; });
    assert.ok(body);
    assert.match(String((await evaluate(body, ctx)).value), /permission denied/i);
});
