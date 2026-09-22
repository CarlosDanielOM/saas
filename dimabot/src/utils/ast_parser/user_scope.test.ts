import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';

test('persistent user variables keep selected users separate in one evaluation', async () => {
    const values = new Map([
        ['score:alice', 'AliceValue'],
        ['score:bob', 'BobValue']
    ]);
    const reads: string[] = [];
    const context = createExecutionContext({
        userId: 'caller-id',
        userLogin: 'caller',
        userPlan: 'premium',
        loadUserVariable: async (name, targetUserLogin) => {
            const key = `${name}:${targetUserLogin ?? 'caller'}`;
            reads.push(key);
            return values.get(key) ?? '';
        },
        saveUserVariable: async (name, value, targetUserLogin) => {
            values.set(`${name}:${targetUserLogin ?? 'caller'}`, value);
        }
    });

    const source = '%(**score(alice)) %(**score(bob)) %(**score(alice) 7) %(**score(alice)) %(**score(bob))';
    const { ast, error } = parse(source);
    assert.equal(error, undefined);
    const result = await evaluate(ast, context);

    assert.equal(result.value, 'AliceValue BobValue 7 BobValue');
    assert.equal(values.get('score:alice'), '7');
    assert.equal(values.get('score:bob'), 'BobValue');
    assert.deepEqual(reads, ['score:alice', 'score:bob']);
});
