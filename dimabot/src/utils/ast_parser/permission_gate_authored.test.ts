import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from './parser.js';
import { createExecutionContext, evaluate, registerFunction } from './evaluator.js';

registerFunction('test.authored.gated7', () => Promise.resolve('ran-ok'), {
    description: 'test', syntax: 'test.authored.gated7', category: 'test',
    examples: ['test.authored.gated7'], minUserLevel: 7
});

async function evalGated(userLevel: number, enforceFunctionPermissions: boolean): Promise<string> {
    const context = createExecutionContext();
    context.userLevel = userLevel;
    context.enforceFunctionPermissions = enforceFunctionPermissions;
    const { ast, error } = parse('$(test.authored.gated7)');
    assert.equal(error, undefined);
    const result = await evaluate(ast, context);
    return String(result.value);
}

test('LLM path denies a gated function for a viewer', async () => {
    const value = await evalGated(1, true);
    assert.match(value, /^Error: permission denied/i);
    assert.match(value, /userlevel 7/);
});

test('authored command path allows a gated function for a viewer', async () => {
    const value = await evalGated(1, false);
    assert.equal(value, 'ran-ok');
});

test('authored event path allows a gated function at broadcaster level', async () => {
    const value = await evalGated(10, false);
    assert.equal(value, 'ran-ok');
});
