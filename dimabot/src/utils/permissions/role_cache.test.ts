import assert from 'node:assert/strict';
import test from 'node:test';

import {
    adminsIdsKey,
    adminsKey,
    adminDetailKey,
    addAdminToRoleCache,
    clearChannelRoleCache,
    editorsIdsKey,
    editorsKey,
    isEditorLoginCached,
    legacyEditorsKey,
    populateAdminCache,
    refreshEditorCache,
    removeAdminFromRoleCache,
    ROLE_CACHE_TTL_SECONDS
} from './roles.js';
import { FakeRoleCache } from './fake_role_cache.js';

const CHANNEL = '12345';

test('refreshEditorCache populates both canonical editor sets with TTLs', async () => {
    const cache = new FakeRoleCache();

    await refreshEditorCache(cache, CHANNEL, [
        { user_id: 'id-1', user_login: 'firsteditor' },
        { user_id: 'id-2', user_login: 'secondeditor' }
    ]);

    assert.deepEqual(cache.members(editorsKey(CHANNEL)), ['firsteditor', 'secondeditor']);
    assert.deepEqual(cache.members(editorsIdsKey(CHANNEL)), ['id-1', 'id-2']);
    assert.equal(cache.expirations.get(editorsKey(CHANNEL)), ROLE_CACHE_TTL_SECONDS);
    assert.equal(cache.expirations.get(editorsIdsKey(CHANNEL)), ROLE_CACHE_TTL_SECONDS);
});

test('refreshEditorCache clears stale editors even when the Helix list is empty', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsKey(CHANNEL), ['stale']);
    cache.setMembers(editorsIdsKey(CHANNEL), ['stale-id']);

    await refreshEditorCache(cache, CHANNEL, []);

    assert.deepEqual(cache.members(editorsKey(CHANNEL)), []);
    assert.deepEqual(cache.members(editorsIdsKey(CHANNEL)), []);
});

test('refreshEditorCache removes the legacy non-twitch editor key', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(legacyEditorsKey(CHANNEL), ['legacyeditor']);

    await refreshEditorCache(cache, CHANNEL, [{ user_id: 'id-1', user_login: 'firsteditor' }]);

    assert.equal(cache.sets.has(legacyEditorsKey(CHANNEL)), false);
});

test('populateAdminCache rebuilds canonical sets and detail hashes, clearing stale and legacy keys', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(adminsKey(CHANNEL), ['staleadmin']);
    cache.setMembers(adminsIdsKey(CHANNEL), ['stale-id']);
    cache.setMembers(`${CHANNEL}:admins`, ['legacy-admin']);
    cache.setMembers(`${CHANNEL}:admins:ids`, ['legacy-admin-id']);

    await populateAdminCache(cache, CHANNEL, [
        { adminID: 'admin-1', adminName: 'FirstAdmin', channelName: 'streamer', permissions: ['*'], actived: true },
        { adminID: 'admin-2', adminName: 'SecondAdmin', channelName: 'streamer', permissions: [], actived: false }
    ]);

    assert.deepEqual(cache.members(adminsKey(CHANNEL)), ['firstadmin', 'secondadmin']);
    assert.deepEqual(cache.members(adminsIdsKey(CHANNEL)), ['admin-1', 'admin-2']);

    const detail = await cache.hGetAll(adminDetailKey(CHANNEL, 'admin-1'));
    assert.equal(detail.adminID, 'admin-1');
    assert.equal(detail.adminName, 'firstadmin');
    assert.equal(detail.channelID, CHANNEL);
    assert.equal(detail.permissions, '["*"]');
    assert.equal(detail.actived, 'true');

    assert.equal(cache.sets.has(adminsKey(CHANNEL)) && !cache.members(adminsKey(CHANNEL)).includes('staleadmin'), true);
    assert.equal(cache.members(adminsIdsKey(CHANNEL)).includes('stale-id'), false);
    assert.equal(cache.sets.has(`${CHANNEL}:admins`), false);
    assert.equal(cache.sets.has(`${CHANNEL}:admins:ids`), false);
});

test('addAdminToRoleCache updates the canonical sets and detail hash immediately', async () => {
    const cache = new FakeRoleCache();

    await addAdminToRoleCache(cache, CHANNEL, {
        adminID: 'admin-9',
        adminName: 'NewAdmin',
        channelName: 'streamer',
        permissions: ['*'],
        actived: true
    });

    assert.deepEqual(cache.members(adminsKey(CHANNEL)), ['newadmin']);
    assert.deepEqual(cache.members(adminsIdsKey(CHANNEL)), ['admin-9']);
    const detail = await cache.hGetAll(adminDetailKey(CHANNEL, 'admin-9'));
    assert.equal(detail.adminName, 'newadmin');
    assert.equal(detail.actived, 'true');
});

test('removeAdminFromRoleCache removes login, ID, and detail hash together', async () => {
    const cache = new FakeRoleCache();
    await addAdminToRoleCache(cache, CHANNEL, {
        adminID: 'admin-9',
        adminName: 'NewAdmin',
        channelName: 'streamer',
        permissions: ['*'],
        actived: true
    });

    await removeAdminFromRoleCache(cache, CHANNEL, 'admin-9', 'NewAdmin');

    assert.deepEqual(cache.members(adminsKey(CHANNEL)), []);
    assert.deepEqual(cache.members(adminsIdsKey(CHANNEL)), []);
    assert.deepEqual(await cache.hGetAll(adminDetailKey(CHANNEL, 'admin-9')), {});
});

test('clearChannelRoleCache removes canonical and legacy editor/admin keys', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsKey(CHANNEL), ['editor']);
    cache.setMembers(editorsIdsKey(CHANNEL), ['editor-id']);
    cache.setMembers(legacyEditorsKey(CHANNEL), ['legacy-editor']);
    cache.setMembers(adminsKey(CHANNEL), ['admin']);
    cache.setMembers(adminsIdsKey(CHANNEL), ['admin-id']);
    await cache.hSet(adminDetailKey(CHANNEL, 'admin-id'), { adminID: 'admin-id' });
    cache.setMembers(`${CHANNEL}:admins`, ['legacy-admin']);

    await clearChannelRoleCache(cache, CHANNEL);

    for (const key of [
        editorsKey(CHANNEL),
        editorsIdsKey(CHANNEL),
        legacyEditorsKey(CHANNEL),
        adminsKey(CHANNEL),
        adminsIdsKey(CHANNEL),
        adminDetailKey(CHANNEL, 'admin-id'),
        `${CHANNEL}:admins`
    ]) {
        const remaining = await cache.keys(key);
        assert.deepEqual(remaining, [], `${key} should be cleared`);
    }
});

test('isEditorLoginCached normalizes logins against the canonical login set', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsKey(CHANNEL), ['firsteditor']);

    assert.equal(await isEditorLoginCached(cache, CHANNEL, 'FirstEditor'), true);
    assert.equal(await isEditorLoginCached(cache, CHANNEL, 'firsteditor'), true);
    assert.equal(await isEditorLoginCached(cache, CHANNEL, 'someoneelse'), false);
    assert.equal(await isEditorLoginCached(cache, CHANNEL, ''), false);
});
