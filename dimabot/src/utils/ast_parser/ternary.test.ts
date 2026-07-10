import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';

test('supports an empty consequent in a ternary expression', async () => {
    const context = createExecutionContext();
    context.variables.set('sumiso', '17');

    const { ast, error } = parse('*(^(sumiso) ? : %(sumiso 42))');
    assert.equal(error, undefined);

    const result = await evaluate(ast, context);

    assert.equal(result.value, '');
    assert.equal(context.variables.get('sumiso'), '17');
});
