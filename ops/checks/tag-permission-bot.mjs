// Tag-permission bot behavior check. Runs inside the saas-ops candidate with
// disposable Mongo/Redis and mocked Twitch/Qdrant providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { messageHandler } from '/app/dist/handlers/message.handler.js';
import { ChannelModerationSettingsSchema, buildDefaultModerationRules } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { resolveUserIdentity } from '/app/dist/utils/permissions/roles.js';
import { shouldLogPermissionError } from '/app/dist/utils/permissions/error_rate_limit.js';

await getMongoDBConnection('tag-permission-bot-check');
const redis = await getDragonflyClient('tag-permission-bot-check');
const callsPath = '/tmp/saas-fixtures/calls.jsonl';
const channel = 'tag-permission-bot-channel';
const marker = 'TAG_PERMISSION_COMMAND_EXECUTED';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => {
    try {
        return fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
        return [];
    }
};
async function until(predicate, label) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await predicate()) return;
        await sleep(100);
    }
    throw new Error(`timeout: ${label}`);
}

// The actual bot entrypoint must be ready in the isolated candidate.
let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
        ready = (await fetch('http://127.0.0.1:3333/eventsub', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        })).status === 403;
    } catch {}
    if (ready) break;
    await sleep(500);
}
assert.ok(ready, 'bot webhook ready and rejects unsigned events');

// A failure in either elevated-role lookup discards both cache-derived roles
// while retaining Twitch badge roles. The message pipeline can continue.
const partiallyFailingCache = {
    async sIsMember(key) {
        if (key.includes(':editors')) return 1;
        throw new Error('admin lookup unavailable');
    }
};
const fallbackIdentity = await resolveUserIdentity(channel, {
    chatter_user_id: 'mod-user',
    chatter_user_login: 'moduser',
    badges: [{ set_id: 'moderator' }]
}, partiallyFailingCache);
assert.equal(fallbackIdentity.level, 7, 'cache failure falls back to moderator badge level');
assert.deepEqual([...fallbackIdentity.tags].sort(), ['everyone', 'mod'], 'no partial editor/admin elevation survives');

let broadcasterCacheReads = 0;
const broadcasterIdentity = await resolveUserIdentity(channel, {
    chatter_user_id: channel,
    chatter_user_login: 'streamer',
    badges: []
}, {
    async sIsMember() {
        broadcasterCacheReads += 1;
        throw new Error('broadcaster must not read role cache');
    }
});
assert.equal(broadcasterIdentity.level, 10);
assert.equal(broadcasterCacheReads, 0, 'broadcaster bypasses editor/admin cache reads');

const rateLimitKey = `candidate-check:${Date.now()}`;
assert.equal(shouldLogPermissionError(rateLimitKey, 1_000, 60_000), true);
assert.equal(shouldLogPermissionError(rateLimitKey, 30_000, 60_000), false);
assert.equal(shouldLogPermissionError(rateLimitKey, 61_000, 60_000), true);

// Seed the dependencies used by the real message handler.
await redis.hSet(`accounts:twitch:${channel}:data`, {
    id: channel,
    name: 'tagpermissionfixture',
    plan_tier: 'free'
});
await redis.hSet('accounts:twitch:698614112:data', {
    id: '698614112',
    access_token: 'dummy-token',
    expires_at: String(Math.floor(Date.now() / 1000) + 36_000)
});

const capsRule = buildDefaultModerationRules().find(rule => rule.type === 'caps');
await ChannelModerationSettingsSchema.create({
    channelID: channel,
    channel: 'tagpermissionfixture',
    enabled: true,
    offenseWindowSeconds: 3_600,
    rules: [capsRule],
    settingsVersion: 1
});
await CommandsSchema.create({
    channelID: channel,
    channel: 'tagpermissionfixture',
    name: 'marker',
    cmd: 'marker',
    func: 'marker',
    message: marker,
    cooldown: 0,
    enabled: true,
    userLevel: 1,
    userLevelName: 'everyone',
    permissionExpression: null
});

const commandMessage = (id, text, userID = 'viewer-user', login = 'vieweruser') => ({
    chatter_user_id: userID,
    chatter_user_login: login,
    chatter_user_name: 'ViewerUser',
    message_id: id,
    badges: [],
    message: { text, fragments: [] }
});

// Prove the seeded command normally executes.
fs.writeFileSync(callsPath, '');
await messageHandler(channel, commandMessage('message-clean', '!marker hello'));
await until(() => calls().some(call => call.message === marker), 'control command response');

// A command-shaped message that triggers moderation must stop before command
// dispatch. The warning/notice can run asynchronously, but the marker cannot.
fs.writeFileSync(callsPath, '');
await messageHandler(channel, commandMessage('message-blocked', '!marker THIS COMMAND MUST NEVER EXECUTE'));
await until(() => calls().some(call => call.warn === 'viewer-user'), 'moderation warning for command message');
await sleep(250);
assert.equal(calls().some(call => call.message === marker), false, 'moderated command never executes');

// A named viewer can pass a role-restricted command; a different viewer cannot.
await CommandsSchema.updateOne({ channelID: channel, cmd: 'marker' }, { $set: {
    permissionExpression: { or: [{ role: 'vip' }, { role: 'mod' }, { user: { id: '12345', login: 'user123' } }] }
} });
await redis.del(`${channel}:commands:marker`);
fs.writeFileSync(callsPath, '');
await messageHandler(channel, commandMessage('message-named-allowed', '!marker hello', '12345', 'renamed'));
await until(() => calls().some(call => call.message === marker), 'named account command response after rename');
fs.writeFileSync(callsPath, '');
await messageHandler(channel, commandMessage('message-other-denied', '!marker hello', '67890', 'otheruser'));
await sleep(250);
assert.equal(calls().some(call => call.message === marker), false, 'other viewer cannot use role-restricted command');

// A named account can also be excluded from universal command access.
await CommandsSchema.updateOne({ channelID: channel, cmd: 'marker' }, { $set: {
    permissionExpression: { and: [{ role: 'everyone' }, { not: { user: { id: '12345', login: 'user123' } } }] }
} });
await redis.del(`${channel}:commands:marker`);
fs.writeFileSync(callsPath, '');
await messageHandler(channel, commandMessage('message-named-denied', '!marker hello', '12345', 'renamed'));
await sleep(250);
assert.equal(calls().some(call => call.message === marker), false, 'excluded named account cannot use everyone command');
await messageHandler(channel, commandMessage('message-other-allowed', '!marker hello', '67890', 'otheruser'));
await until(() => calls().some(call => call.message === marker), 'other viewer allowed by everyone rule');

console.log('PASS bot: moderation precedes commands, role-cache failures preserve badge roles, broadcaster bypasses cache, errors are rate-limited');
process.exit(0);
