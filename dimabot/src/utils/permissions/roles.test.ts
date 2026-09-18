import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createBroadcasterIdentity,
    createDefaultIdentity,
    createUserIdentity,
    deriveBadgeLevel,
    deriveBadgeTags,
    editorsIdsKey,
    editorsKey,
    adminsIdsKey,
    adminsKey,
    parseUserIdentity,
    resolveUserIdentity,
    serializeUserIdentity
} from './roles.js';
import { FakeRoleCache } from './fake_role_cache.js';
import type { IChatMessage } from '../../interfaces/twitch/eventsub.interface.js';
function message(badges: Array<{ set_id: string }>, chatterUserID = 'user-1', chatterLogin = 'viewer'): IChatMessage {
    return {
        chatter_user_id: chatterUserID,
        chatter_user_login: chatterLogin,
        chatter_user_name: 'Viewer',
        badges,
        message: { text: 'hi' }
    } as unknown as IChatMessage;
}

test('default chatter resolves to level 1 with only the everyone tag', async () => {
    const identity = await resolveUserIdentity('channel-1', message([]), new FakeRoleCache());
    assert.equal(identity.level, 1);
    assert.deepEqual([...identity.tags].sort(), ['everyone']);
});

test('subscriber badge maps to level 2 and the sub tag', async () => {
    const identity = await resolveUserIdentity('channel-1', message([{ set_id: 'subscriber' }]), new FakeRoleCache());
    assert.equal(identity.level, 2);
    assert.deepEqual([...identity.tags].sort(), ['everyone', 'sub']);
});

test('vip badge maps to level 5 and the vip tag', async () => {
    const identity = await resolveUserIdentity('channel-1', message([{ set_id: 'vip' }]), new FakeRoleCache());
    assert.equal(identity.level, 5);
    assert.deepEqual([...identity.tags].sort(), ['everyone', 'vip']);
});

test('founder badge maps to level 6 and implies the sub tag', async () => {
    const identity = await resolveUserIdentity('channel-1', message([{ set_id: 'founder' }]), new FakeRoleCache());
    assert.equal(identity.level, 6);
    assert.deepEqual([...identity.tags].sort(), ['everyone', 'founder', 'sub']);
});

test('moderator badges map to level 7 and the mod tag', async () => {
    for (const set_id of ['moderator', 'lead_moderator']) {
        const identity = await resolveUserIdentity('channel-1', message([{ set_id }]), new FakeRoleCache());
        assert.equal(identity.level, 7, `${set_id} should be level 7`);
        assert.deepEqual([...identity.tags].sort(), ['everyone', 'mod']);
    }
});

test('multi-role chatters keep every tag instead of collapsing to the max role', async () => {
    const identity = await resolveUserIdentity(
        'channel-1',
        message([{ set_id: 'subscriber' }, { set_id: 'moderator' }]),
        new FakeRoleCache()
    );
    assert.equal(identity.level, 7);
    assert.deepEqual([...identity.tags].sort(), ['everyone', 'mod', 'sub']);
});

test('the broadcaster keeps numeric override at 10 plus the broadcaster tag', async () => {
    const identity = await resolveUserIdentity('channel-1', message([], 'channel-1', 'streamer'), new FakeRoleCache());
    assert.equal(identity.level, 10);
    assert.ok(identity.tags.has('broadcaster'));
    assert.ok(identity.tags.has('everyone'));
});

test('a role-cache read failure falls back to badge roles without blocking the message', async () => {
    const cache = new FakeRoleCache();
    cache.sIsMember = async (key) => {
        if (key.includes(':editors')) return 1;
        throw new Error('admin role read failed');
    };

    const identity = await resolveUserIdentity(
        'channel-1',
        message([{ set_id: 'subscriber' }, { set_id: 'moderator' }]),
        cache
    );

    assert.equal(identity.level, 7);
    assert.deepEqual([...identity.tags].sort(), ['everyone', 'mod', 'sub']);
});

test('the broadcaster bypasses editor and admin cache reads', async () => {
    const cache = new FakeRoleCache();
    let cacheReads = 0;
    cache.sIsMember = async () => {
        cacheReads += 1;
        throw new Error('cache should not be read');
    };

    const identity = await resolveUserIdentity('channel-1', message([], 'channel-1', 'streamer'), cache);

    assert.equal(identity.level, 10);
    assert.deepEqual([...identity.tags].sort(), ['broadcaster', 'everyone']);
    assert.equal(cacheReads, 0);
});

test('deriveBadgeLevel keeps legacy max-level semantics across combinations', () => {
    assert.equal(deriveBadgeLevel([]), 1);
    assert.equal(deriveBadgeLevel([{ set_id: 'subscriber' }]), 2);
    assert.equal(deriveBadgeLevel([{ set_id: 'subscriber' }, { set_id: 'vip' }]), 5);
    assert.equal(deriveBadgeLevel([{ set_id: 'vip' }, { set_id: 'founder' }]), 6);
    assert.equal(deriveBadgeLevel([{ set_id: 'founder' }, { set_id: 'moderator' }]), 7);
    assert.equal(deriveBadgeLevel(undefined), 1);
});

test('deriveBadgeTags handles missing badges defensively', () => {
    assert.deepEqual([...deriveBadgeTags(undefined)], []);
    assert.deepEqual([...deriveBadgeTags(null)], []);
});

test('editor membership resolves through the canonical ID set first', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsIdsKey('channel-1'), ['user-1']);
    cache.setMembers(editorsKey('channel-1'), ['somebodyelse']);

    const identity = await resolveUserIdentity('channel-1', message([]), cache);
    assert.equal(identity.level, 8);
    assert.deepEqual([...identity.tags].sort(), ['editor', 'everyone']);
});

test('editor membership falls back to the normalized-login set while ID caches repopulate', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsKey('channel-1'), ['viewer']);

    const identity = await resolveUserIdentity('channel-1', message([]), cache);
    assert.equal(identity.level, 8);
    assert.ok(identity.tags.has('editor'));
});

test('admin membership resolves through the canonical ID set first', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(adminsIdsKey('channel-1'), ['user-1']);
    cache.setMembers(adminsKey('channel-1'), ['somebodyelse']);

    const identity = await resolveUserIdentity('channel-1', message([]), cache);
    assert.equal(identity.level, 9);
    assert.deepEqual([...identity.tags].sort(), ['admin', 'everyone']);
});

test('admin membership falls back to the normalized-login set', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(adminsKey('channel-1'), ['viewer']);

    const identity = await resolveUserIdentity('channel-1', message([]), cache);
    assert.equal(identity.level, 9);
    assert.ok(identity.tags.has('admin'));
});

test('a mod who is also an editor and admin keeps all tags with level 9', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsIdsKey('channel-1'), ['user-1']);
    cache.setMembers(adminsIdsKey('channel-1'), ['user-1']);

    const identity = await resolveUserIdentity('channel-1', message([{ set_id: 'moderator' }]), cache);
    assert.equal(identity.level, 9);
    assert.deepEqual([...identity.tags].sort(), ['admin', 'editor', 'everyone', 'mod']);
});

test('the broadcaster override beats editor and admin levels', async () => {
    const cache = new FakeRoleCache();
    cache.setMembers(editorsIdsKey('channel-1'), ['channel-1']);
    cache.setMembers(adminsIdsKey('channel-1'), ['channel-1']);

    const identity = await resolveUserIdentity('channel-1', message([], 'channel-1', 'streamer'), cache);
    assert.equal(identity.level, 10);
    assert.ok(identity.tags.has('broadcaster'));
});

test('createBroadcasterIdentity carries level 10 and everyone+broadcaster tags', () => {
    const identity = createBroadcasterIdentity();
    assert.equal(identity.level, 10);
    assert.deepEqual([...identity.tags].sort(), ['broadcaster', 'everyone']);
});

test('createDefaultIdentity is a plain viewer', () => {
    const identity = createDefaultIdentity();
    assert.equal(identity.level, 1);
    assert.deepEqual([...identity.tags], ['everyone']);
});

test('createUserIdentity always includes the everyone tag', () => {
    assert.deepEqual([...createUserIdentity(5, []).tags], ['everyone']);
    assert.deepEqual([...createUserIdentity(5, ['vip']).tags].sort(), ['everyone', 'vip']);
});

test('serialized identities round-trip through parseUserIdentity', () => {
    const identity = createUserIdentity(7, ['mod', 'sub']);
    const parsed = parseUserIdentity(serializeUserIdentity(identity));
    assert.equal(parsed.level, 7);
    assert.deepEqual([...parsed.tags].sort(), ['everyone', 'mod', 'sub']);
});

test('parseUserIdentity never fabricates authorization from garbage', () => {
    for (const bad of [undefined, null, 'mod', 7, {}, { level: 'nine' }, { level: 3, tags: 'sub' }]) {
        const parsed = parseUserIdentity(bad, 3);
        assert.equal(parsed.level, 3, `fallback level for ${JSON.stringify(bad)}`);
        assert.deepEqual([...parsed.tags], ['everyone']);
    }
});

test('parseUserIdentity clamps out-of-range levels into the 1..10 window', () => {
    assert.equal(parseUserIdentity({ level: 99 }).level, 10);
    assert.equal(parseUserIdentity({ level: -5 }).level, 1);
    assert.deepEqual([...parseUserIdentity({ level: 99, tags: ['vip'] }).tags].sort(), ['everyone', 'vip']);
});
