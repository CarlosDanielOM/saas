import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAuthoredAstUserLevel } from './special_parser.userlevel.js';

test('treats event payloads without a chat chatter as broadcaster', () => {
    assert.equal(resolveAuthoredAstUserLevel({
        broadcaster_user_id: '123',
        broadcaster_user_login: 'streamer',
        broadcaster_user_name: 'Streamer'
    }), 10);
});

test('keeps inferred viewer level for chat commands', () => {
    assert.equal(resolveAuthoredAstUserLevel({
        chatter_user_id: '456',
        chatter_user_login: 'viewer',
        chatter_user_name: 'Viewer',
        badges: []
    }), 1);
});

test('infers moderator level from chat badges', () => {
    assert.equal(resolveAuthoredAstUserLevel({
        chatter_user_id: '789',
        chatter_user_login: 'mod',
        chatter_user_name: 'Mod',
        badges: [{ set_id: 'moderator' }]
    }), 7);
});

test('uses an explicit userLevel when provided', () => {
    assert.equal(resolveAuthoredAstUserLevel({
        chatter_user_id: '456',
        chatter_user_login: 'viewer',
        chatter_user_name: 'Viewer'
    }, 10), 10);
});

test('treats follow/cheer/raid subjects as broadcaster-owned events', () => {
    assert.equal(resolveAuthoredAstUserLevel({
        user_id: '111',
        user_login: 'follower',
        user_name: 'Follower',
        broadcaster_user_id: '123'
    }), 10);
    assert.equal(resolveAuthoredAstUserLevel({
        from_broadcaster_user_id: '222',
        from_broadcaster_user_login: 'raider',
        from_broadcaster_user_name: 'Raider',
        to_broadcaster_user_id: '123'
    }), 10);
});
