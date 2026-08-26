import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../parser.js';
import { createExecutionContext, evaluate } from '../evaluator.js';
import { registerStringFunctions } from './string.functions.js';

registerStringFunctions();

async function evaluateInput(input: string) {
    const context = createExecutionContext();
    const { ast, error } = parse(input);
    assert.equal(error, undefined);

    return evaluate(ast, context);
}

test('upper converts to uppercase', async () => {
    const result = await evaluateInput('$(upper hello world)');

    assert.equal(result.value, 'HELLO WORLD');
});

test('lower converts to lowercase', async () => {
    const result = await evaluateInput('$(lower HeLLo WoRLD)');

    assert.equal(result.value, 'hello world');
});

test('title capitalizes each word', async () => {
    const result = await evaluateInput('$(title hello world)');

    assert.equal(result.value, 'Hello World');
});

test('capitalize only uppercases the first letter', async () => {
    const result = await evaluateInput('$(capitalize hELLO)');

    assert.equal(result.value, 'HELLO');
});

test('trim removes surrounding whitespace', async () => {
    const result = await evaluateInput('$(trim "  padded  ")');

    assert.equal(result.value, 'padded');
});

test('length returns the string length', async () => {
    const result = await evaluateInput('$(length hello world)');

    assert.equal(result.value, '11');
});

test('slice with start and end', async () => {
    const result = await evaluateInput('$(slice 0 5 hello world)');

    assert.equal(result.value, 'hello');
});

test('slice with start only goes to the end', async () => {
    const result = await evaluateInput('$(slice 6 hello world)');

    assert.equal(result.value, 'world');
});

test('slice supports negative indexes like arrays', async () => {
    const result = await evaluateInput('$(slice 0 -6 hello world)');

    assert.equal(result.value, 'hello');
});

test('slice without numeric start returns empty', async () => {
    const result = await evaluateInput('$(slice hello world)');

    assert.equal(result.value, '');
});

test('replace substitutes all occurrences', async () => {
    const result = await evaluateInput('$(replace o 0 foo boo)');

    assert.equal(result.value, 'f00 b00');
});

test('replace supports quoted multi-word search', async () => {
    const result = await evaluateInput('$(replace "old text" "new text" the old text here)');

    assert.equal(result.value, 'the new text here');
});

test('replace with empty search returns text unchanged', async () => {
    const result = await evaluateInput('$(replace "" x hello)');

    assert.equal(result.value, 'hello');
});

test('string functions compose with variables and escapes', async () => {
    const result = await evaluateInput('%(name \\:\\)) $(upper %(name))');

    assert.equal(result.value, ':)');
});
