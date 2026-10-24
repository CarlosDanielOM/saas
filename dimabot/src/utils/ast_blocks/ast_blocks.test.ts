import assert from 'node:assert/strict';
import test from 'node:test';

import { compileBlocks, importCommandText, BlocksError, MAX_COMMAND_TEXT } from './index.js';

let seq = 0;
const id = () => `t${(seq += 1)}`;
const lit = (value: string) => ({ id: id(), type: 'literal', value });
const fn = (name: string, args: unknown[] = []) => ({ id: id(), type: 'function', name, args });
const getVar = (name: string, storage = 'memory', extra: Record<string, unknown> = {}) => ({ id: id(), type: 'getVar', name, storage, ...extra });
const setVar = (name: string, value: unknown, storage = 'memory', extra: Record<string, unknown> = {}) => ({ id: id(), type: 'setVar', name, storage, value, ...extra });
const binary = (left: unknown, operator: string, right: unknown) => ({ id: id(), type: 'binary', operator, left, right });
const root = (...children: unknown[]) => ({ id: id(), type: 'root', children });

const compile = (...children: unknown[]) => compileBlocks(root(...children)).text;

test('plain text stays exactly as typed, smileys and spacing included', () => {
    assert.equal(compile(lit('Hello '), fn('user'), lit('! :) welcome   back')), 'Hello $(user)! :) welcome   back');
});

test('text that looks like an expression is escaped so chat shows it', () => {
    assert.equal(compile(lit('type $(user) to see')), 'type \\$(user) to see');
    const back = importCommandText('type \\$(user) to see');
    assert.deepEqual(back.root.children.map((c) => c.type), ['literal']);
    assert.equal((back.root.children[0] as { value: string }).value, 'type $(user) to see');
});

test('function arguments with spaces or symbols are quoted', () => {
    assert.equal(compile(fn('say', [lit('hello there'), lit('-5'), lit('ok')])), '$(say "hello there" "-5" ok)');
});

test('death counter and its reply', () => {
    const text = compile(setVar('deaths', binary(getVar('deaths', 'db'), '+', lit('1')), 'db'), lit('Deaths: '), getVar('deaths', 'db'));
    assert.equal(text, '%(*deaths *(%(*deaths) + 1))Deaths: %(*deaths)');
});

test('if/else with a group branch becomes quoted text with ${…}', () => {
    const ternary = { id: id(), type: 'ternary', test: binary(fn('user'), '==', lit('cdom201')), consequent: lit('Welcome back, boss'),
        alternate: { id: id(), type: 'group', children: [lit('Hi '), fn('user')] } };
    assert.equal(compile(ternary), '*(($(user) == cdom201) ? "Welcome back, boss" : "Hi ${$(user)}")');
});

test('per-viewer variables, lists and list items', () => {
    assert.equal(compile(getVar('points', 'dbUser', { userSelector: fn('touser') })), '%(**points($(touser)))');
    assert.equal(compile(setVar('list', { id: id(), type: 'arrayLiteral', items: [lit('one'), lit('two words')] }, 'memory', { accessor: { type: 'append' } })),
        '%(list[] %[one, "two words"])');
    assert.equal(compile(getVar('list', 'memory', { accessor: { type: 'index', index: lit('0') } })), '%(list[0])');
    assert.equal(compile(getVar('list', 'cache', { accessor: { type: 'random' } })), '%(#list[random])');
    assert.equal(compile({ id: id(), type: 'deleteVar', name: 'list', storage: 'db', accessor: { type: 'clear' } }), '%del(*list[])');
});

test('repeat loops keep the real loop syntax', () => {
    const loop = { id: id(), type: 'forLoop', loopVar: 'i', mode: 'range',
        init: { id: id(), type: 'loopAssign', name: 'i', operator: '=', value: lit('0') },
        condition: binary({ id: id(), type: 'loopVar', name: 'i' }, '<', lit('3')),
        update: { id: id(), type: 'loopAssign', name: 'i', operator: '++' },
        body: [fn('say', [lit('ping'), { id: id(), type: 'loopVar', name: 'i' }])] };
    assert.equal(compile(loop), '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })');
});

test('imported commands come back as the same text meaning', () => {
    const sources = [
        '$(user) hugs $(touser) <3',
        '*($(random 6) == 0 ? "BANG! ${$(user)} is out" : "click... survives")',
        '%(*deaths *(%(*deaths) + 1))Deaths so far: %(*deaths)',
        'Thanks for the raid $(raid.channel)! #(so $(raid.channel))',
        '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })',
        '*(for #x in %(list[]) { $(say #x) })',
        '^(*seen) &t %del(##tmp(&p1)) *(-1 + 2)'
    ];
    for (const source of sources) {
        const imported = importCommandText(source);
        assert.equal(imported.advancedCount, 0, source);
        const compiled = compileBlocks(JSON.parse(JSON.stringify(imported.root)));
        assert.equal(importCommandText(compiled.text).root.children.length, imported.root.children.length, source);
    }
});

test('unclear expressions stay as advanced pieces with their exact text', () => {
    const imported = importCommandText('hi %(pen $(randomuser) extra) bye');
    assert.equal(imported.advancedCount, 1);
    const raw = imported.root.children.find((c) => c.type === 'raw') as { source: string };
    assert.equal(raw.source, '%(pen $(randomuser) extra)');
    assert.equal(compileBlocks(imported.root).text, 'hi %(pen $(randomuser) extra) bye');
});

test('save errors point at the block', () => {
    const empty = { id: 'empty-if', type: 'binary', operator: '==', left: null, right: lit('x') };
    assert.throws(() => compileBlocks(root(empty)), (err: unknown) => err instanceof BlocksError && err.blockId === 'empty-if');
    assert.throws(() => compileBlocks(root(fn('say', [{ id: 'r1', type: 'raw', source: '$(x)' }]))),
        (err: unknown) => err instanceof BlocksError && err.blockId === 'r1');
    assert.throws(() => compileBlocks(root(getVar('bad name'))), BlocksError);
    assert.throws(() => compileBlocks(root(lit('price \\$5'))), BlocksError);
    assert.throws(() => compileBlocks(root(lit('x'.repeat(MAX_COMMAND_TEXT + 1)))), /too long/);
    assert.throws(() => compileBlocks(root()), /at least one block/);
    assert.throws(() => compileBlocks({ type: 'root' }), BlocksError);
});

test('a raw piece edited into plain text is rejected', () => {
    assert.throws(() => compileBlocks(root({ id: 'r2', type: 'raw', source: 'just text' })),
        (err: unknown) => err instanceof BlocksError && err.blockId === 'r2');
});

test('ids are kept, and missing or duplicate ids are replaced', () => {
    const a = { id: 'same', type: 'literal', value: 'a ' };
    const b = { id: 'same', type: 'function', name: 'user', args: [] };
    const { root: saved } = compileBlocks({ id: 'r', type: 'root', children: [a, b] });
    assert.equal(saved.children[0].id, 'same');
    assert.notEqual(saved.children[1].id, 'same');
});
