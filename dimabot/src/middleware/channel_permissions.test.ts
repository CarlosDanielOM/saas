import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNEL_WEBSITE_ACCESS_PERMISSIONS, grantsChatAdminRole, grantsMcpAdmin, parseChannelAdminPermissions } from './channel_permissions.js';

test('full access remains the single wildcard grant', () => {
    assert.deepEqual(parseChannelAdminPermissions(['*']), ['*']);
    assert.equal(parseChannelAdminPermissions(['*', 'commands:view']), null);
    assert.equal(grantsChatAdminRole(['*']), true);
});

test('custom manage permissions include their view and dashboard grants', () => {
    assert.deepEqual(parseChannelAdminPermissions(['commands:manage']), ['dashboard:view', 'commands:manage', 'commands:view']);
    assert.deepEqual(parseChannelAdminPermissions(['tts:manage']), ['dashboard:view', 'tts:manage', 'tts:view']);
    assert.deepEqual(parseChannelAdminPermissions(['admins:view']), ['dashboard:view', 'admins:view', 'settings:view']);
    assert.equal(grantsChatAdminRole(['dashboard:view', 'commands:manage']), false);
    assert.equal(grantsChatAdminRole(['chat:admin']), true);
});

test('TTS grants are independent from bot settings grants', () => {
    assert.deepEqual(parseChannelAdminPermissions(['tts:view']), ['dashboard:view', 'tts:view']);
    assert.deepEqual(parseChannelAdminPermissions(['settings:manage']), ['dashboard:view', 'settings:manage', 'settings:view']);
    assert.deepEqual(parseChannelAdminPermissions(['tts:manage', 'settings:view']), [
        'dashboard:view', 'tts:manage', 'settings:view', 'tts:view'
    ]);
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

test('AI apps (mcp:admin) is explicit: full access does not include it, but can be combined with it', () => {
    assert.equal(grantsMcpAdmin(['*']), false);
    assert.deepEqual(parseChannelAdminPermissions(['*', 'mcp:admin']), ['*', 'mcp:admin']);
    assert.deepEqual(parseChannelAdminPermissions(['mcp:admin', '*']), ['*', 'mcp:admin']);
    assert.equal(grantsMcpAdmin(parseChannelAdminPermissions(['*', 'mcp:admin'])), true);
    assert.equal(parseChannelAdminPermissions(['*', 'mcp:admin', 'commands:view']), null);
    // Connecting an AI app needs the website too: the grant brings dashboard access with it.
    assert.deepEqual(parseChannelAdminPermissions(['mcp:admin', 'commands:view']), ['dashboard:view', 'mcp:admin', 'commands:view']);
    assert.equal(grantsMcpAdmin(['dashboard:view', 'commands:view']), false);
    assert.equal(grantsMcpAdmin(undefined), false);
});
