// Role-cache + stream-lifecycle behavior check for the cron target
// (TAG_PERMISSION_SYSTEM.md §2.1 / §4.2.1): canonical twitch: editor/admin
// keys, ID-first identity resolution, lifecycle cleanup, and the stream
// operations domain-event wiring that runs inside the cron worker.
import assert from 'node:assert/strict';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import {
    refreshEditorCache,
    clearChannelRoleCache,
    resolveUserIdentity,
    editorsKey,
    editorsIdsKey,
    adminsKey,
    adminsIdsKey,
    legacyEditorsKey
} from '/app/dist/utils/permissions/roles.js';

const redis = await getDragonflyClient('role-cache-check');
const channel = 'role-cache-channel';

// 1. Editor refresh writes the canonical login + ID sets and removes legacy keys.
await redis.sAdd(legacyEditorsKey(channel), 'legacyeditor');
await redis.sAdd(editorsKey(channel), 'staleeditor');
await refreshEditorCache(redis, channel, [
    { user_id: 'id-1', user_login: 'firsteditor' },
    { user_id: 'id-2', user_login: 'secondeditor' }
]);
assert.equal(await redis.sIsMember(editorsKey(channel), 'firsteditor'), 1, 'editor login cached');
assert.equal(await redis.sIsMember(editorsIdsKey(channel), 'id-2'), 1, 'editor id cached');
assert.equal(await redis.sIsMember(editorsKey(channel), 'staleeditor'), 0, 'stale editor cleared by refresh');
assert.equal(await redis.exists(legacyEditorsKey(channel)), 0, 'legacy editor key removed');

// 2. Identity resolution: stable-ID first, normalized-login fallback.
const byId = await resolveUserIdentity(channel, { chatter_user_id: 'id-1', chatter_user_login: 'otherlogin', badges: [] }, redis);
assert.equal(byId.level, 8, 'editor level from ID set');
assert.ok(byId.tags.has('editor'), 'editor tag from ID set');

const byLogin = await resolveUserIdentity(channel, { chatter_user_id: 'not-an-editor', chatter_user_login: 'SecondEditor', badges: [] }, redis);
assert.equal(byLogin.level, 8, 'editor level from normalized-login fallback');

const viewer = await resolveUserIdentity(channel, { chatter_user_id: 'plain', chatter_user_login: 'plain', badges: [] }, redis);
assert.equal(viewer.level, 1, 'non-editor stays level 1');

// 3. Adapter-agnostic: refresh clears the previous editor list even when empty.
await refreshEditorCache(redis, channel, []);
assert.equal(await redis.sIsMember(editorsKey(channel), 'firsteditor'), 0, 'empty refresh clears stale editors');

// 4. Stream-lifecycle cleanup removes canonical and legacy editor/admin keys.
await redis.sAdd(editorsKey(channel), 'editor');
await redis.sAdd(editorsIdsKey(channel), 'editor-id');
await redis.sAdd(legacyEditorsKey(channel), 'legacy');
await redis.sAdd(adminsKey(channel), 'adminone');
await redis.sAdd(adminsIdsKey(channel), 'admin-id');
await redis.hSet(`twitch:${channel}:admins:admin-id`, { adminID: 'admin-id' });
await redis.sAdd(`${channel}:admins`, 'legacyadmin');
await clearChannelRoleCache(redis, channel);
for (const key of [
    editorsKey(channel),
    editorsIdsKey(channel),
    legacyEditorsKey(channel),
    adminsKey(channel),
    adminsIdsKey(channel),
    `twitch:${channel}:admins:admin-id`,
    `${channel}:admins`
]) {
    assert.equal(await redis.exists(key), 0, `${key} cleared by lifecycle cleanup`);
}

// 5. Stream-started domain event wiring invokes the cache refresh path.
const { applyStreamOperationsDomainEvent } = await import('/app/dist/domain_events/stream_operations_events.js');
const calls = [];
const operations = {
    async loadChannelTimersIntoCache(id) { calls.push(`timers:${id}`); },
    async unloadChannelTimersFromCache(id) { calls.push(`unload-timers:${id}`); },
    async getChannelEditors(id, cache) { calls.push(`editors:${id}:${cache}`); return { error: false }; },
    async loadChannelAdminsIntoCache(id) { calls.push(`admins:${id}`); },
    async unVIPExpiredUser(e) { calls.push(`vips:${e.broadcaster_user_id}`); return { error: true, type: 'no_vips_found' }; },
    async resetRedemptionCost() { return { error: false }; },
    async resetSumimetro() {},
    async clearChannelCache() {},
    async clearSpeechFiles() {},
    async clearHistory() {},
    async clearLifecycleCache(id) { calls.push(`lifecycle:${id}`); },
    async hasNewerLifecycleEvent() { return false; }
};
const event = {
    _id: 'check-event-1',
    eventKey: 'event:stream.started',
    source: 'twitch-eventsub',
    sourceEventId: 'source:stream.started',
    type: 'stream.started',
    topic: 'channel',
    schemaVersion: 1,
    channelID: channel,
    occurredAt: new Date(),
    journaledAt: new Date(),
    payload: { event: { broadcaster_user_id: channel, broadcaster_user_login: 'streamer' } },
    metadata: {},
    expiresAt: new Date(Date.now() + 3600000)
};
await applyStreamOperationsDomainEvent(event, operations);
assert.deepEqual(calls, [
    `timers:${channel}`,
    `editors:${channel}:true`,
    `admins:${channel}`,
    `vips:${channel}`
], 'stream.started refreshes timers, editors (with cache), admins and VIPs');

console.log('PASS cron: canonical editor/admin role cache keys, ID-first resolution, lifecycle cleanup, stream.started wiring');
process.exit(0);
