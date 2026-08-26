import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from './parser.js';
import { createExecutionContext, evaluate, registerFunction } from './evaluator.js';

registerFunction('say', async (args) => args.join(' '));
registerFunction('noop', async () => '');

async function evaluateInput(input: string, setup?: (context: ReturnType<typeof createExecutionContext>) => void) {
    const context = createExecutionContext();
    setup?.(context);

    const { ast, error } = parse(input);
    assert.equal(error, undefined);

    return evaluate(ast, context);
}

test('balanced parens inside function args are preserved, not cut', async () => {
    const result = await evaluateInput('$(say score (5-3))');

    assert.equal(result.value, 'score ( 5 - 3 )');
});

test('nested balanced parens inside function args survive', async () => {
    const result = await evaluateInput('$(say nested ((deep)) end)');

    assert.equal(result.value, 'nested ( ( deep ) ) end');
});

test('escaped paren inside function args does not close the call', async () => {
    const result = await evaluateInput('$(say hello \\:\\))');

    assert.equal(result.value, 'hello :)');
});

test('escaped semicolon inside function args stays literal', async () => {
    const result = await evaluateInput('$(say smiley \\;) done)');

    assert.equal(result.value, 'smiley ; done');
});

test('escaped question mark stays literal', async () => {
    const result = await evaluateInput('$(say what\\?)');

    assert.equal(result.value, 'what?');
});

test('escaped open and close parens stay literal', async () => {
    const result = await evaluateInput('$(say escaped \\( and \\) here)');

    assert.equal(result.value, 'escaped ( and ) here');
});

test('escaped backslash resolves to a single backslash', async () => {
    const result = await evaluateInput('$(say backslash \\\\)');

    assert.equal(result.value, 'backslash \\');
});

test('escaped emoticon works as a variable value', async () => {
    const result = await evaluateInput('%(mood \\:\\)) %(mood)');

    assert.equal(result.value, ':)');
});

test('quoted strings with parens keep working unchanged', async () => {
    const result = await evaluateInput('$(say "quoted :) here")');

    assert.equal(result.value, 'quoted :) here');
});

test('unbalanced open paren degrades gracefully to literals', async () => {
    const result = await evaluateInput('$(say unbalanced (oops)');

    assert.equal(result.value, 'unbalanced ( oops )');
});

test('function args evaluate sequentially so last write wins', async () => {
    const result = await evaluateInput('$(noop %(a 1) %(a 2)) %(a)');

    assert.equal(result.value, '2');
});

test('text after a function call is still appended', async () => {
    const result = await evaluateInput('$(say hello world) tail');

    assert.equal(result.value, 'hello world tail');
});
