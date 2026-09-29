import assert from 'node:assert/strict';
import test from 'node:test';
import { planGlobalAstVariables } from './ast_variable_migration.js';

test('global migration keeps the newest legacy value per channel and user', () => {
    const at = (seconds: number) => new Date(seconds * 1000);
    const plan = planGlobalAstVariables([
        { channelID: 'one', scopeType: 'redemption', scopeName: 'shield', userId: 'u', userLogin: 'viewer', variables: { shield: '2', coins: '4' }, updatedAt: at(1) },
        { channelID: 'one', scopeType: 'command', scopeName: 'shield', userId: 'u', userLogin: 'viewer', variables: { shield: '5' }, updatedAt: at(2) },
        { channelID: 'one', scopeType: 'command', scopeName: 'shield', userId: 'v', userLogin: 'other', variables: { shield: '7' }, updatedAt: at(3) },
        { channelID: 'two', scopeType: 'command', scopeName: 'shield', userId: 'u', userLogin: 'viewer', variables: { shield: '9' }, updatedAt: at(4) }
    ]);
    assert.deepEqual(plan.map(({ channelID, userId, variables }) => ({ channelID, userId, variables })), [
        { channelID: 'two', userId: 'u', variables: { shield: '9' } },
        { channelID: 'one', userId: 'v', variables: { shield: '7' } },
        { channelID: 'one', userId: 'u', variables: { shield: '5', coins: '4' } }
    ]);
});
