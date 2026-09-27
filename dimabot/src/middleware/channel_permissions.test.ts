import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNEL_WEBSITE_ACCESS_PERMISSIONS, grantsChatAdminRole, parseChannelAdminPermissions } from './channel_permissions.js';

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

test('chat and website permissions are independent', () => {
    assert.deepEqual(parseChannelAdminPermissions(['chat:admin']), ['chat:admin']);
    assert.deepEqual(parseChannelAdminPermissions(['chat:admin', 'commands:view']), [
        'dashboard:view', 'chat:admin', 'commands:view'
    ]);
    assert.deepEqual(parseChannelAdminPermissions(['commands:view']), ['dashboard:view', 'commands:view']);
    assert.equal(grantsChatAdminRole(['commands:view']), false);
    assert.equal(grantsChatAdminRole(['chat:admin']), true);
    assert.deepEqual(CHANNEL_WEBSITE_ACCESS_PERMISSIONS, ['*', 'dashboard:view']);
});

test('unknown, empty, and malformed grants fail closed', () => {
    for (const value of [[], ['owner:everything'], ['*', 'chat:admin'], ['dashboard:view', 7], null]) {
        assert.equal(parseChannelAdminPermissions(value), null);
    }
});
