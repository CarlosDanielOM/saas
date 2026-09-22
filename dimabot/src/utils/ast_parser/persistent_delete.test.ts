import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';

test('deleting a persistent channel variable removes the stored value', async () => {
    const stored = new Map([['score', '42']]);
    const makeContext = () => createExecutionContext({
        userPlan: 'premium',
        loadChannelVariable: async name => stored.get(name) ?? '',
        saveChannelVariable: async (name, value) => { stored.set(name, value); },
        deleteChannelVariable: async name => { stored.delete(name); }
    });

    await evaluate(parse('%del(*score)').ast, makeContext());
    const result = await evaluate(parse('^(*score)').ast, makeContext());

    assert.equal(stored.has('score'), false);
    assert.equal(result.value, 'false');
});

test('deleting and editing a selected user array affects only that user', async () => {
    const stored = new Map([
        ['items:alice', '["a","b"]'],
        ['items:bob', '["x","y"]']
    ]);
    const makeContext = () => createExecutionContext({
        userPlan: 'premium',
        userId: 'caller-id',
        userLogin: 'caller',
        loadUserVariable: async (name, login) => stored.get(`${name}:${login ?? 'caller'}`) ?? '',
        saveUserVariable: async (name, value, login) => { stored.set(`${name}:${login ?? 'caller'}`, value); },
        deleteUserVariable: async (name, login) => { stored.delete(`${name}:${login ?? 'caller'}`); }
    });

    await evaluate(parse('%del(**items(bob)[0])').ast, makeContext());
    assert.equal(stored.get('items:bob'), '["y"]');
    assert.equal(stored.get('items:alice'), '["a","b"]');

    await evaluate(parse('%del(**items(alice))').ast, makeContext());
    assert.equal(stored.has('items:alice'), false);
    assert.equal(stored.get('items:bob'), '["y"]');
});
