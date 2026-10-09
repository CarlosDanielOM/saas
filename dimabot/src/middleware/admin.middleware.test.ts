import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    CREATOR_TWITCH_USER_ID,
    canModifyCreatorAdminAssignment,
    expandChannelPermissionChecks,
    parsePermissionList,
    resolveGrantedPermissions
} from './admin.middleware.js';

test('channel owners can add or remove the creator from their own admin list', () => {
    assert.equal(
        canModifyCreatorAdminAssignment('channel-owner', 'channel-owner', CREATOR_TWITCH_USER_ID),
        true
    );
});

test('the creator can manage their own channel assignments', () => {
    assert.equal(
        canModifyCreatorAdminAssignment(CREATOR_TWITCH_USER_ID, 'another-channel', CREATOR_TWITCH_USER_ID),
        true
    );
});

test('global admins cannot change the creator assignment for somebody else\'s channel', () => {
    assert.equal(
        canModifyCreatorAdminAssignment('global-admin', 'channel-owner', CREATOR_TWITCH_USER_ID),
        false
    );
});

test('creator protection does not restrict other admin targets', () => {
    assert.equal(
        canModifyCreatorAdminAssignment('global-admin', 'channel-owner', 'regular-admin'),
        true
    );
});

test('admin add and remove routes both enforce the creator assignment policy', () => {
    const routeSource = readFileSync(new URL('../server/routes/admin.route.ts', import.meta.url), 'utf8');
    const policyCalls = routeSource.match(
        /!canModifyCreatorAdminAssignment\(requesterID, channelIdStr, (?:twitchAccount\.id|adminIdStr)\)/g
    );

    assert.equal(policyCalls?.length, 2);
});

test('specific trigger and DimaFX checks honor legacy module-wide grants', () => {
    assert.deepEqual(expandChannelPermissionChecks('triggers:edit'), ['*', 'triggers:edit', 'triggers:all']);
    assert.deepEqual(expandChannelPermissionChecks('dimafx:view'), ['*', 'dimafx:view', 'dimafx:all']);
    assert.deepEqual(expandChannelPermissionChecks('commands:manage'), ['*', 'commands:manage']);
});

test('batch access resolves each permission against the granted list', () => {
    assert.deepEqual(
        resolveGrantedPermissions(['dashboard:view', 'triggers:all'], ['dashboard:view', 'commands:view', 'triggers:edit']),
        { 'dashboard:view': true, 'commands:view': false, 'triggers:edit': true }
    );
    assert.deepEqual(
        resolveGrantedPermissions(['*'], ['dashboard:view', 'settings:view']),
        { 'dashboard:view': true, 'settings:view': true }
    );
    assert.deepEqual(resolveGrantedPermissions([], ['dashboard:view']), { 'dashboard:view': false });
});

test('permissions query parsing distinguishes absent, valid and invalid lists', () => {
    assert.equal(parsePermissionList(undefined), null);
    assert.deepEqual(parsePermissionList('dashboard:view, commands:view,dashboard:view'), ['dashboard:view', 'commands:view']);
    assert.deepEqual(parsePermissionList(['dashboard:view', 'settings:view']), ['dashboard:view', 'settings:view']);
    assert.deepEqual(parsePermissionList(''), []);
    assert.deepEqual(parsePermissionList('dashboard:view,$where'), []);
    assert.deepEqual(parsePermissionList(Array.from({ length: 21 }, (_, i) => `p${i}:view`).join(',')), []);
});
