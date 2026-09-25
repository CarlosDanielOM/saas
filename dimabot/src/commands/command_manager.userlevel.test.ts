import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveChatUserLevel } from './command_manager.command.js';

test('numeric -ul= values 1 through 10 map to the canonical level name', () => {
    assert.deepEqual(resolveChatUserLevel('1'), { userLevel: 1, userLevelName: 'everyone' });
    assert.deepEqual(resolveChatUserLevel('7'), { userLevel: 7, userLevelName: 'mod' });
    assert.deepEqual(resolveChatUserLevel('10'), { userLevel: 10, userLevelName: 'broadcaster' });
    assert.deepEqual(resolveChatUserLevel('07'), { userLevel: 7, userLevelName: 'mod' });
});

test('named -ul= values stay on the legacy map', () => {
    assert.deepEqual(resolveChatUserLevel('mod'), { userLevel: 7, userLevelName: 'mod' });
    assert.deepEqual(resolveChatUserLevel('broadcaster'), { userLevel: 10, userLevelName: 'broadcaster' });
    assert.deepEqual(resolveChatUserLevel('founder'), { userLevel: 6, userLevelName: 'founder' });
});

test('streamer is an alias for broadcaster', () => {
    assert.deepEqual(resolveChatUserLevel('streamer'), { userLevel: 10, userLevelName: 'broadcaster' });
});

test('unknown numbers and names are rejected', () => {
    assert.equal(resolveChatUserLevel('0'), null);
    assert.equal(resolveChatUserLevel('11'), null);
    assert.equal(resolveChatUserLevel('99'), null);
    assert.equal(resolveChatUserLevel('founders'), null);
    assert.equal(resolveChatUserLevel(''), null);
});
