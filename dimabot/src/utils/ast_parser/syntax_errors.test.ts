import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from './parser.js';
import { renderAstWithSourceReference } from './render.js';
import { createExecutionContext, evaluate } from './evaluator.js';

test('unclosed AST calls, quotes, and arrays report parse errors', () => {
    for (const source of ['$(user', '%(x', '"unterminated', '%[one,two']) {
        assert.match(parse(source).error ?? '', /unclosed/i, source);
    }
});

test('extra closing delimiters report parse errors', () => {
    for (const source of ['$(user))', '%(x])', '*(1 + 2))']) {
        assert.match(parse(source).error ?? '', /unexpected closing/i, source);
    }
});

test('valid nested syntax and a URL remain valid', () => {
    for (const source of ['$(say score (5-3))', '%(items[0])', '$(say https://example.com/path)']) {
        assert.equal(parse(source).error, undefined, source);
    }
});

test('authored templates surface an unclosed AST call', async () => {
    const rendered = await renderAstWithSourceReference('before $(user', createExecutionContext());
    assert.match(rendered.parsedText, /\[Parse error:.*unclosed/i);
});

test('authored templates surface errors inside a balanced expression', async () => {
    const rendered = await renderAstWithSourceReference('before $(say %[one,two)', createExecutionContext());
    assert.match(rendered.parsedText, /\[Parse error:.*unclosed array/i);
});

test('template interpolation surfaces malformed inner AST', async () => {
    const { ast, error } = parse('"Hello ${%(x}"');
    assert.equal(error, undefined);
    const result = await evaluate(ast, createExecutionContext());
    assert.match(String(result.value), /\[Parse error:.*unclosed/i);
});
