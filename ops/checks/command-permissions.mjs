// Command permission expression API check (TAG_PERMISSION_SYSTEM.md §5).
// Runs inside the saas-ops api candidate with disposable Mongo/Redis.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import Commands from '/app/dist/classes/command.class.js';

const mongo = await getMongoDBConnection('command-permissions-check');
const redis = await getDragonflyClient('command-permissions-check');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const channel = 'cmd-perm-channel';
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'cmdperm' });
await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: 'cmdperm' }], plan_tier: 'free' });
await redis.hSet('token:cmd-perm-owner', { id: channel, login: 'cmdperm', display_name: 'CmdPerm' });

let up = false;
for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:3000/commands'); up = true; break; } catch { await sleep(500); } }
assert.ok(up, 'api ready');

const api = (method, path, body) => fetch(`http://127.0.0.1:3000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cmd-perm-owner' },
    ...(body ? { body: JSON.stringify(body) } : {})
});

const baseCommand = {
    name: 'greet', cmd: 'greet', func: 'greet', message: 'hello there', channel: 'cmdperm',
    cooldown: 10, enabled: true
};

// --- Create: valid expression -> tag mode; numeric fields still stored ---
{
    const created = await (await api('POST', `/commands/${channel}`, {
        ...baseCommand, userLevel: 1, userLevelName: 'everyone',
        permissionExpression: { or: [{ role: 'sub' }, { role: 'vip' }] }
    })).json();
    assert.equal(created.error, false, JSON.stringify(created));
    assert.deepEqual(created.command.permissionExpression, { or: [{ role: 'sub' }, { role: 'vip' }] });
    assert.equal(created.command.userLevel, 1, 'numeric fields remain stored while tag mode is active');
    const doc = await CommandsSchema.findOne({ channelID: channel, cmd: 'greet' }).lean();
    assert.deepEqual(doc.permissionExpression, { or: [{ role: 'sub' }, { role: 'vip' }] });
}

const greetID = (await CommandsSchema.findOne({ channelID: channel, cmd: 'greet' }).select('_id'))._id.toString();

// --- Create/update: invalid expressions are rejected with 400 ---
{
    const bad = await api('POST', `/commands/${channel}`, { ...baseCommand, cmd: 'badexp', name: 'badexp', func: 'badexp', permissionExpression: { role: 'supermod' }, userLevel: 1, userLevelName: 'everyone' });
    assert.equal(bad.status, 400, 'unknown role rejected on create');
    assert.match((await bad.json()).message, /invalid permission expression/i);

    const empty = await api('POST', `/commands/${channel}`, { ...baseCommand, cmd: 'emptyexp', name: 'emptyexp', func: 'emptyexp', permissionExpression: {}, userLevel: 1, userLevelName: 'everyone' });
    assert.equal(empty.status, 400, 'tag mode cannot be empty (universal access is {role:everyone})');

    const invalidUpdate = await api('PUT', `/commands/${channel}/${greetID}`, { permissionExpression: { and: [] } });
    assert.equal(invalidUpdate.status, 400, 'empty group rejected on update');

    const nullWithoutLevel = await api('PUT', `/commands/${channel}/${greetID}`, { permissionExpression: null });
    assert.equal(nullWithoutLevel.status, 400, 'level-mode switch requires a valid level/name pair');
}

// --- Create: level mode persists when expression is omitted or null ---
{
    const level = await (await api('POST', `/commands/${channel}`, {
        ...baseCommand, cmd: 'levelcmd', name: 'levelcmd', func: 'levelcmd',
        userLevel: 7, userLevelName: 'mod', permissionExpression: null
    })).json();
    assert.equal(level.error, false, JSON.stringify(level));
    assert.equal(level.command.permissionExpression, null);
}

// --- List/get include the expression plus a non-localized mode ---
{
    const list = await (await api('GET', `/commands/${channel}`)).json();
    const greet = list.commands.find(command => command.cmd === 'greet');
    assert.equal(greet.permissionMode, 'tags');
    assert.deepEqual(greet.permissionExpression, { or: [{ role: 'sub' }, { role: 'vip' }] });
    const levelCmd = list.commands.find(command => command.cmd === 'levelcmd');
    assert.equal(levelCmd.permissionMode, 'level');
}

// --- Update: missing expression leaves mode unchanged; null + pair switches ---
{
    const bodyEdit = await api('PUT', `/commands/${channel}/${greetID}`, { message: 'hello there v2' });
    assert.equal(bodyEdit.status, 200);
    assert.deepEqual((await bodyEdit.json()).command.permissionExpression, { or: [{ role: 'sub' }, { role: 'vip' }] }, 'missing field keeps tag mode');

    const everyone = await api('PUT', `/commands/${channel}/${greetID}`, { permissionExpression: { role: 'everyone' } });
    assert.equal(everyone.status, 200, 'universal tag access is the explicit everyone role');
    assert.deepEqual((await everyone.json()).command.permissionExpression, { role: 'everyone' });

    const switchToLevel = await api('PUT', `/commands/${channel}/${greetID}`, { permissionExpression: null, userLevel: 5, userLevelName: 'vip' });
    assert.equal(switchToLevel.status, 200);
    const switched = (await switchToLevel.json()).command;
    assert.equal(switched.permissionExpression, null, 'explicit null switches to level mode');
    assert.equal(switched.userLevel, 5);
    assert.equal(switched.userLevelName, 'vip');

    // The still-live dashboard uses the legacy level labels (5=founders,
    // 6=vip, 10=streamer); those edits must keep working unchanged.
    const legacyCreate = await (await api('POST', `/commands/${channel}`, {
        ...baseCommand, cmd: 'legacycmd', name: 'legacycmd', func: 'legacycmd',
        userLevel: 6, userLevelName: 'vip', permissionExpression: null
    })).json();
    assert.equal(legacyCreate.error, false, 'create accepts the legacy dashboard level name');
    assert.equal(legacyCreate.command.userLevel, 6);
    assert.equal(legacyCreate.command.userLevelName, 'vip');

    const legacyEdit = await api('PUT', `/commands/${channel}/${greetID}`, { userLevel: 6, userLevelName: 'vip' });
    assert.equal(legacyEdit.status, 200, 'edit accepts the legacy dashboard level name');
    assert.equal((await legacyEdit.json()).command.userLevelName, 'vip');

    const outOfRange = await api('PUT', `/commands/${channel}/${greetID}`, { userLevel: 11, userLevelName: 'everyone' });
    assert.equal(outOfRange.status, 400, 'out-of-range level rejected');
}

// --- Renaming an already-cached command invalidates both cache keys ---
{
    // Prime the one-hour command cache under the old name first.
    const primed = await Commands.getCommandFromDB(channel, 'greet');
    assert.equal(primed.error, false, 'old name resolves before the rename');
    assert.equal(primed.command.cmd, 'greet');

    const rename = await api('PUT', `/commands/${channel}/${greetID}`, { cmd: 'greetrenamed' });
    assert.equal(rename.status, 200);

    const oldLookup = await Commands.getCommandFromDB(channel, 'greet');
    assert.equal(oldLookup.error, true, 'old command name is not executable through a stale cache entry');

    const newLookup = await Commands.getCommandFromDB(channel, 'greetrenamed');
    assert.equal(newLookup.error, false, 'renamed command resolves immediately');
    assert.equal(newLookup.command.cmd, 'greetrenamed');
}

// --- Shared fixtures keep server-side validation in lockstep ---
{
    const fs = await import('node:fs');
    const fixtures = JSON.parse(fs.readFileSync('/tmp/saas-fixtures/permission-expressions.json', 'utf8'));
    const { validateExpression } = await import('/app/dist/utils/permissions/expression.js');
    for (const { name, expression } of fixtures.valid) {
        assert.equal(validateExpression(expression).ok, true, `fixture ${name} validates server-side`);
    }
    for (const { name, expression } of fixtures.invalid) {
        assert.equal(validateExpression(expression).ok, false, `fixture ${name} is rejected server-side`);
    }
}

console.log('PASS api: permission expression create/update/list round-trip, 400 on invalid/empty, level-mode switch, rename cache invalidation, fixture lockstep');
process.exit(0);
