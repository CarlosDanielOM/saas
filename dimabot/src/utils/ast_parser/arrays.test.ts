import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';

async function evaluateInput(input: string, setup?: (context: ReturnType<typeof createExecutionContext>) => void) {
    const context = createExecutionContext();
    setup?.(context);

    const { ast, error } = parse(input);
    assert.equal(error, undefined);

    return evaluate(ast, context);
}

const withItems = (context: ReturnType<typeof createExecutionContext>) => {
    context.variables.set('items', JSON.stringify(['a', 'b', 'c']));
};

test('literal array with index accessor', async () => {
    const result = await evaluateInput('%[apple, banana, cherry][1]');

    assert.equal(result.value, 'banana');
});

test('literal array with length accessor', async () => {
    const result = await evaluateInput('%[a, b][].length');

    assert.equal(result.value, '2');
});

test('literal array with negative index accessor', async () => {
    const result = await evaluateInput('%[x, y, z][-1]');

    assert.equal(result.value, 'z');
});

test('literal array without accessor still returns all values', async () => {
    const result = await evaluateInput('%[1,2,3]');

    assert.equal(result.value, '1,2,3');
});

test('literal array length accessor composes with arithmetic', async () => {
    const result = await evaluateInput('*(%[1,2,3][].length * 1.5)');

    assert.equal(result.value, '4.5');
});

test('negative index reads the last element', async () => {
    const result = await evaluateInput('%(items[-1])', withItems);

    assert.equal(result.value, 'c');
});

test('negative index wraps to the first element', async () => {
    const result = await evaluateInput('%(items[-3])', withItems);

    assert.equal(result.value, 'a');
});

test('out-of-range negative index returns empty', async () => {
    const result = await evaluateInput('%(items[-4])', withItems);

    assert.equal(result.value, '');
});

test('expression inside index brackets works', async () => {
    const result = await evaluateInput('%(items[*(1+1)])', withItems);

    assert.equal(result.value, 'c');
});

test('exists check supports negative index', async () => {
    const result = await evaluateInput('^(items[-1])', withItems);

    assert.equal(result.value, 'true');
});

test('exists check reports false for out-of-range negative index', async () => {
    const result = await evaluateInput('^(items[-9])', withItems);

    assert.equal(result.value, 'false');
});

test('%del() removes the last element with negative index', async () => {
    const result = await evaluateInput('%del(items[-1]) %(items[])', withItems);

    assert.equal(result.value, '["a","b"]');
});

test('setIndex with negative index replaces the last element', async () => {
    const result = await evaluateInput('%(items[-1] ZZZ) %(items[])', withItems);

    assert.equal(result.value, '["a","b","ZZZ"]');
});

test('decimal literals work in arithmetic and comparisons', async () => {
    const result = await evaluateInput('*(5.5 > 5 ? "yes" : "no")');

    assert.equal(result.value, 'yes');
});

test('decimal addition keeps precision', async () => {
    const result = await evaluateInput('*(1.5 + 2.25)');

    assert.equal(result.value, '3.75');
});

test('member access dot is still split from names', async () => {
    const result = await evaluateInput('%(items[].length)', withItems);

    assert.equal(result.value, '3');
});

test('comparison does not coerce numeric prefixes', async () => {
    const result = await evaluateInput('*(5abc == 5 ? "yes" : "no")');

    assert.equal(result.value, 'no');
});

test('numeric equality still works after tightening', async () => {
    const result = await evaluateInput('*(5 == 5 ? "yes" : "no")');

    assert.equal(result.value, 'yes');
});
