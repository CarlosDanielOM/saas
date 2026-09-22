import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    CREATOR_TWITCH_USER_ID,
    canModifyCreatorAdminAssignment
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
