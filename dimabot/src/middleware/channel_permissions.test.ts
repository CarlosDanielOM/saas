import assert from 'node:assert/strict';
import test from 'node:test';
import { grantsChatAdminRole, parseChannelAdminPermissions } from './channel_permissions.js';

test('full access remains the single wildcard grant', () => {
    assert.deepEqual(parseChannelAdminPermissions(['*']), ['*']);
    assert.equal(parseChannelAdminPermissions(['*', 'commands:view']), null);
    assert.equal(grantsChatAdminRole(['*']), true);
});

test('custom manage permissions include their view and dashboard grants', () => {
    assert.deepEqual(parseChannelAdminPermissions(['commands:manage']), ['dashboard:view', 'commands:manage', 'commands:view']);
    assert.deepEqual(parseChannelAdminPermissions(['admins:view']), ['dashboard:view', 'admins:view', 'settings:view']);
    assert.equal(grantsChatAdminRole(['dashboard:view', 'commands:manage']), false);
    assert.equal(grantsChatAdminRole(['chat:admin']), true);
});

test('unknown, empty, and malformed grants fail closed', () => {
    for (const value of [[], ['owner:everything'], ['*', 'chat:admin'], ['dashboard:view', 7], null]) {
        assert.equal(parseChannelAdminPermissions(value), null);
    }
});
