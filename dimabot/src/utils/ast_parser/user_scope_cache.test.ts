import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from './parser.js';

const stored = new Map<string, string>();
mock.module('../databases/dragonfly.database.js', {
    namedExports: {
        getDragonflyClient: async () => ({
            get: async (key: string) => stored.get(key) ?? null,
            set: async (key: string, value: string) => { stored.set(key, value); },
            expire: async () => true
        })
    }
});

const { createExecutionContext, evaluate } = await import('./evaluator.js');

test('selected user cache writes do not overwrite the caller', async () => {
    const context = createExecutionContext({
        broadcasterId: 'channel',
        scopeName: 'command',
        userId: 'caller-id',
        userLogin: 'caller'
    });
    const { ast, error } = parse('%(##score 3) %(##score(alice) 7) %(##score) %(##score(alice))');
    assert.equal(error, undefined);

    const result = await evaluate(ast, context);

    assert.equal(result.value, '3 7');
    assert.equal(stored.get('twitch:channel:scope:command:command:score:id:caller-id'), '3');
    assert.equal(stored.get('twitch:channel:scope:command:command:score:login:alice'), '7');
});
