/**
 * Pins the commands page's HTTP behavior (POST/PUT/DELETE /commands/:channelID…) and the shared
 * mutation service the site assistant uses. Runs the real router and the real Mongoose model with
 * its queries answered by an in-memory store (no database, no Dragonfly).
 *
 * PIN_OUT=<file> also writes every request/response/side effect, to diff the route before and after
 * a refactor.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

const OWNER = '1001';
const ADMIN = '2002';
const STRANGER = '3003';
const plans: Record<string, 'free' | 'premium' | 'pro'> = { [OWNER]: 'free' };

const cacheDeletes: string[] = [];
const keywordRefreshes: string[] = [];
const locks = new Map<string, string>();
const redis = {
    del: async (key: string) => { cacheDeletes.push(key); return 1; },
    get: async () => null,
    set: async (key: string, value: string, opts?: { NX?: boolean }) => {
        if (opts?.NX && locks.has(key)) return null;
        locks.set(key, value);
        return 'OK';
    },
    eval: async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
        if (locks.get(opts.keys[0]) === opts.arguments[0]) locks.delete(opts.keys[0]);
        return 1;
    },
};

const chain = <T>(value: () => T | Promise<T>) => {
    const query: any = {
        select: () => query, lean: () => query, maxTimeMS: () => query, sort: () => query, skip: () => query, limit: () => query,
        exec: async () => value(),
        then: (resolve: (v: T) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(value).then(resolve, reject),
    };
    return query;
};

mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => redis } });
mock.module('../../middleware/auth.middleware.js', {
    namedExports: {
        authMiddleware: (req: any, _res: unknown, next: () => void) => { req.user = { id: String(req.headers['x-user'] || '') }; next(); },
    },
});
mock.module('../../middleware/admin.middleware.js', {
    namedExports: {
        getChannelAccessContext: async (requester: string, channel: string, permission: string) => {
            if (requester && requester === channel) return { allowed: true, role: 'owner' };
            if (requester === ADMIN && permission === 'commands:manage') return { allowed: true, role: 'admin' };
            return { allowed: false, role: 'none' };
        },
    },
});
mock.module('../../classes/twitch_streamers.class.js', {
    defaultExport: { getTwitchAccountById: async (id: string) => ({ id, name: 'owner_login', plan_tier: plans[id] ?? 'free' }) },
});
mock.module('../../schemas/users.schema.js', {
    defaultExport: {
        findOne: (filter: any) => chain(() => {
            const id = filter?.accounts?.$elemMatch?.id;
            return id ? { plan_tier: plans[id] ?? 'free', accounts: [{ type: 'twitch', id, name: 'owner_login', actived: true, chat_enabled: true }] } : null;
        }),
    },
});
mock.module('../../utils/keyword_cache.js', {
    namedExports: { refreshKeywordIndex: async (channelID: string, id?: string) => { keywordRefreshes.push(`${channelID}:${id ?? ''}`); } },
});
mock.module('../../schemas/randomuser_settings.schema.js', { namedExports: { RandomUserSettingsSchema: { updateOne: async () => ({}) } } });
mock.module('../../utils/ast_parser/randomuser_settings.js', {
    namedExports: { getRandomUserBlacklist: async () => [], normalizeRandomUserBlacklist: () => [] },
});

const { CommandsSchema } = await import('../../schemas/commands.schema.js');
const { commandRoute } = await import('../routes/command.route.js');
const service = await import('./command_mutations.service.js');

// ---------------------------------------------------------------------------
// In-memory Commands collection behind the real model.
// ---------------------------------------------------------------------------

type Raw = Record<string, any>;
const store = new Map<string, Raw>();
let failNextFind = false;

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function fieldMatches(value: unknown, condition: unknown): boolean {
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && '$ne' in (condition as Raw)) {
        return String(value) !== String((condition as Raw).$ne) && !(value === undefined && (condition as Raw).$ne === undefined);
    }
    if (condition === null) return value === null || value === undefined;
    if (typeof value === 'object' && value !== null && typeof (value as any).toHexString === 'function') return String(value) === String(condition);
    if (typeof condition === 'object' && condition !== null && typeof (condition as any).toHexString === 'function') return String(value) === String(condition);
    if (typeof condition === 'object') return same(value, condition);
    return value === condition;
}

function matches(raw: Raw, filter: Raw): boolean {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === 'activation' && raw.activation === undefined) return fieldMatches('command', condition);
        return fieldMatches(raw[key], condition);
    });
}

function findRaw(filter: Raw): Raw | null {
    if (failNextFind) { failNextFind = false; throw new Error('database down'); }
    for (const raw of store.values()) if (matches(raw, filter)) return raw;
    return null;
}

/** Deep copy that keeps the ObjectId (structuredClone drops its prototype). */
const clone = (raw: Raw): Raw => { const { _id, ...rest } = raw; return { ...structuredClone(rest), _id }; };
const hydrate = (raw: Raw | null) => raw ? CommandsSchema.hydrate(clone(raw)) : null;

function seed(fields: Raw): Raw {
    const doc = new CommandsSchema({ channelID: OWNER, channel: 'owner_login', ...fields });
    const raw = doc.toObject();
    raw.blocks = fields.blocks ?? null;
    store.set(String(raw._id), raw);
    return raw;
}

mock.method(CommandsSchema, 'findOne', (filter: Raw) => chain(() => hydrate(findRaw(filter))));
mock.method(CommandsSchema, 'find', (filter: Raw) => chain(() => [...store.values()].filter((raw) => matches(raw, filter)).map(clone)));
mock.method(CommandsSchema, 'exists', (filter: Raw) => chain(() => { const raw = findRaw(filter); return raw ? { _id: raw._id } : null; }));
mock.method(CommandsSchema, 'findOneAndUpdate', (filter: Raw, update: Raw) => chain(() => {
    const raw = findRaw(filter);
    if (!raw) return null;
    const fields = update.$set ?? update;
    for (const [key, value] of Object.entries(fields)) raw[key] = value === undefined ? undefined : structuredClone(value);
    return hydrate(raw);
}));
mock.method(CommandsSchema, 'findOneAndDelete', (filter: Raw) => chain(() => {
    const raw = findRaw(filter);
    if (!raw) return null;
    store.delete(String(raw._id));
    return hydrate(raw);
}));
mock.method(CommandsSchema, 'create', async (fields: Raw) => {
    const doc = new CommandsSchema(fields);
    const raw = doc.toObject();
    raw.blocks = fields.blocks ?? null;
    store.set(String(raw._id), raw);
    return doc;
});
mock.method(CommandsSchema.prototype, 'save', async function (this: any) {
    const raw = this.toObject();
    store.set(String(raw._id), raw);
    return this;
});

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

let server: Server;
let base = '';
const transcript: unknown[] = [];

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/commands', commandRoute);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (process.env.PIN_OUT) writeFileSync(process.env.PIN_OUT, JSON.stringify(transcript, null, 2));
});

beforeEach(() => {
    store.clear();
    cacheDeletes.length = 0;
    keywordRefreshes.length = 0;
    locks.clear();
    plans[OWNER] = 'free';
    failNextFind = false;
});

/** Generated ids and dates differ per run; everything else must match exactly. */
function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Raw).map(([key, item]) => {
            if (key === '_id' || key === 'createdAt') return [key, typeof item];
            if (key === 'date') return [key, 'date'];
            return [key, normalize(item)];
        }));
    }
    return value;
}

async function call(method: string, path: string, user: string, body?: unknown) {
    cacheDeletes.length = 0;
    keywordRefreshes.length = 0;
    const response = await fetch(`${base}/commands${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-user': user },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json() as Raw;
    const entry = {
        request: `${method} ${path} as ${user}`,
        body,
        status: response.status,
        response: normalize(json),
        cacheDeletes: [...cacheDeletes],
        keywordRefreshes: [...keywordRefreshes],
        stored: normalize([...store.values()].map((raw) => ({ ...raw }))),
    };
    transcript.push(entry);
    return { status: response.status, json, entry };
}

const textBody = (overrides: Raw = {}) => ({
    name: 'dice', cmd: 'dice', func: 'dice', message: 'You rolled $(random 1-6)', channel: 'owner_login',
    cooldown: 10, userLevel: 1, userLevelName: 'everyone', enabled: true, description: 'Roll a die', ...overrides,
});

// ---------------------------------------------------------------------------
// POST /commands/:channelID
// ---------------------------------------------------------------------------

test('POST refuses people without commands:manage before reading anything', async () => {
    const { status, json } = await call('POST', `/${OWNER}`, STRANGER, textBody());
    assert.equal(status, 403);
    assert.deepEqual(json, { error: true, message: 'You do not have access to this channel', status: 403 });
    assert.equal(store.size, 0);
});

test('POST validates required fields, activation, keyword settings, permissions and level', async () => {
    const cases: Array<[Raw, number, string]> = [
        [{ ...textBody(), message: '' }, 400, 'Missing required fields'],
        [{ ...textBody(), channel: undefined }, 400, 'Missing required fields'],
        [{ ...textBody(), activation: 'reward' }, 400, 'Invalid activation type'],
        [{ ...textBody(), keywordSettings: { matchMode: 'start' } }, 400, 'Keyword settings require keyword activation'],
        [{ ...textBody(), permissionExpression: { nope: true } }, 400, ''],
        [{ ...textBody(), userLevel: 11 }, 400, 'userLevel must be an integer between 1 and 10'],
        [{ ...textBody(), userLevel: 1.5 }, 400, 'userLevel must be an integer between 1 and 10'],
        [{ ...textBody(), cooldown: 2 }, 400, 'Command cooldown must be 0 or at least 5 seconds'],
        [{ ...textBody(), message: 'x'.repeat(10_001) }, 400, 'The reply is too long (10001 of 10000 characters)'],
        [{ ...textBody({ authoring: 'blocks', blocks: { type: 'root', children: [] } }) }, 403, 'Block commands need Premium or Pro'],
        [{ activation: 'keyword', name: 'hi', cmd: '!hello there', func: 'x', message: 'hey', channel: 'c', keywordSettings: { matchMode: 'start' } }, 400, 'Keyword must contain words or a phrase, without !, and be at most 60 characters'],
        [{ activation: 'keyword', name: 'hi', cmd: 'hello', func: 'x', message: 'hey', channel: 'c', keywordSettings: { matchMode: 'start' }, cooldown: 1 }, 400, 'Keyword cooldown must be at least 5 seconds'],
    ];
    for (const [body, status, message] of cases) {
        const result = await call('POST', `/${OWNER}`, OWNER, body);
        assert.equal(result.status, status, JSON.stringify(body).slice(0, 80));
        assert.equal(result.json.error, true);
        if (message) assert.equal(result.json.message, message);
        else assert.match(String(result.json.message), /^Invalid permission expression: /);
    }
    assert.equal(store.size, 0);
    const blocks = await call('POST', `/${OWNER}`, OWNER, textBody({ authoring: 'blocks', blocks: { type: 'root', children: [] } }));
    assert.deepEqual(Object.keys(blocks.json), ['error', 'code', 'message', 'status']);
    assert.equal(blocks.json.code, 'plan_required');
});

test('POST creates a text command, clears both cache names and returns the presented command', async () => {
    const { status, json, entry } = await call('POST', `/${OWNER}`, ADMIN, textBody({ name: 'Dice' }));
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json), ['error', 'message', 'command', 'status']);
    assert.equal(json.message, 'Command created');
    assert.equal(json.command.cmd, 'dice');
    assert.equal(json.command.func, 'dice');
    assert.equal(json.command.authoring, 'text');
    assert.equal(json.command.permissionMode, 'level');
    assert.equal(json.command.reserved, false);
    assert.equal(json.command.userLevelName, 'everyone');
    assert.equal('blocks' in json.command, false);
    assert.deepEqual(entry.cacheDeletes, [`${OWNER}:commands:dice`, `${OWNER}:commands:Dice`]);
    assert.equal(store.size, 1);

    const duplicate = await call('POST', `/${OWNER}`, OWNER, textBody());
    assert.equal(duplicate.status, 409);
    assert.deepEqual(Object.keys(duplicate.json), ['error', 'message', 'command', 'status']);
    assert.equal(duplicate.json.message, 'Command already exists');
    assert.equal(duplicate.json.command.cmd, 'dice');
});

test('POST defaults: level 1, cooldown 10, enabled, empty description; the 0-second slot is single', async () => {
    const { json } = await call('POST', `/${OWNER}`, OWNER, { name: 'a', cmd: 'a', func: 'a', message: 'hi', channel: 'c' });
    assert.equal(json.command.userLevel, 1);
    assert.equal(json.command.cooldown, 10);
    assert.equal(json.command.enabled, true);
    assert.equal(json.command.description, '');
    assert.equal((await call('POST', `/${OWNER}`, OWNER, textBody({ cmd: 'zero', cooldown: 0 }))).status, 200);
    const second = await call('POST', `/${OWNER}`, OWNER, textBody({ cmd: 'zero2', cooldown: 0 }));
    assert.equal(second.status, 400);
    assert.equal(second.json.message, 'Only one editable command per channel can have a 0-second cooldown.');
});

test('POST keyword: normalized phrase, func custom, keyword index refreshed instead of command cache', async () => {
    const { status, json, entry } = await call('POST', `/${OWNER}`, OWNER, {
        activation: 'keyword', name: 'Hello', cmd: '  Hello   There ', func: 'whatever', message: 'hey', channel: 'c',
        keywordSettings: { matchMode: 'anywhere' },
    });
    assert.equal(status, 200);
    assert.equal(json.command.cmd, 'hello there');
    assert.equal(json.command.func, 'custom');
    assert.equal(json.command.activation, 'keyword');
    assert.deepEqual(json.command.keywordSettings, { matchMode: 'anywhere' });
    assert.deepEqual(entry.cacheDeletes, []);
    assert.deepEqual(entry.keywordRefreshes, [`${OWNER}:${json.command._id}`]);
});

test('POST hides unexpected failures behind a 500', async () => {
    failNextFind = true;
    const { status, json } = await call('POST', `/${OWNER}`, OWNER, textBody());
    assert.equal(status, 500);
    assert.deepEqual(json, { error: true, message: 'Error creating command', status: 500 });
});

// ---------------------------------------------------------------------------
// PUT /commands/:channelID/:commandID
// ---------------------------------------------------------------------------

test('PUT access, not found, activation change and rename conflicts', async () => {
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    seed({ name: 'coin', cmd: 'coin', func: 'coin', message: 'flip', cooldown: 10 });
    const id = String(dice._id);
    assert.equal((await call('PUT', `/${OWNER}/${id}`, STRANGER, { message: 'x' })).status, 403);
    const missing = await call('PUT', `/${OWNER}/aaaaaaaaaaaaaaaaaaaaaaaa`, OWNER, { message: 'x' });
    assert.deepEqual(missing.json, { error: true, message: 'Command not found for this channel', status: 404 });
    const activation = await call('PUT', `/${OWNER}/${id}`, OWNER, { activation: 'keyword' });
    assert.deepEqual(activation.json, { error: true, message: 'Activation type cannot be changed', status: 400 });
    const keywordSettings = await call('PUT', `/${OWNER}/${id}`, OWNER, { keywordSettings: { matchMode: 'start' } });
    assert.equal(keywordSettings.json.message, 'Keyword settings require keyword activation');
    const conflict = await call('PUT', `/${OWNER}/${id}`, OWNER, { cmd: 'coin' });
    assert.deepEqual(conflict.json, { error: true, message: 'Activation already exists', status: 409 });
    assert.equal(store.get(id)?.cmd, 'dice');
});

test('PUT updates text, renames, and clears the old and new cache names', async () => {
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const id = String(dice._id);
    const { status, json, entry } = await call('PUT', `/${OWNER}/${id}`, ADMIN, { name: 'Die', cmd: 'die', message: 'new reply', cooldown: 15, enabled: false, userLevel: 7 });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json), ['error', 'message', 'command', 'status']);
    assert.equal(json.message, 'Command updated');
    assert.equal(json.command.cmd, 'die');
    assert.equal(json.command.message, 'new reply');
    assert.equal(json.command.enabled, false);
    assert.equal(json.command.userLevel, 7);
    assert.equal(json.command.userLevelName, 'mod');
    assert.equal(json.command.permissionMode, 'level');
    assert.deepEqual(entry.cacheDeletes, [`${OWNER}:commands:dice`, `${OWNER}:commands:die`]);
});

test('PUT permission expression and level rules', async () => {
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const id = String(dice._id);
    const invalid = await call('PUT', `/${OWNER}/${id}`, OWNER, { permissionExpression: { bogus: 1 } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.message, /^Invalid permission expression: /);
    const levelWithout = await call('PUT', `/${OWNER}/${id}`, OWNER, { permissionExpression: null });
    assert.deepEqual(levelWithout.json, { error: true, message: 'Switching to level mode requires a valid userLevel (1-10)', status: 400 });
    const badLevel = await call('PUT', `/${OWNER}/${id}`, OWNER, { userLevel: 0 });
    assert.deepEqual(badLevel.json, { error: true, message: 'userLevel must be an integer between 1 and 10', status: 400 });
    const tags = await call('PUT', `/${OWNER}/${id}`, OWNER, { permissionExpression: { role: 'vip' } });
    assert.equal(tags.status, 200);
    assert.equal(tags.json.command.permissionMode, 'tags');
    const level = await call('PUT', `/${OWNER}/${id}`, OWNER, { permissionExpression: null, userLevel: 5, userLevelName: 'custom label' });
    assert.equal(level.json.command.permissionMode, 'level');
    assert.equal(level.json.command.userLevelName, 'custom label');
    assert.equal(level.json.command.permissionExpression, null);
    const cooldown = await call('PUT', `/${OWNER}/${id}`, OWNER, { cooldown: 3 });
    assert.deepEqual(cooldown.json, { error: true, message: 'Command cooldown must be 0 or at least 5 seconds', status: 400 });
});

test('PUT built-in commands: no blocks, description kept, localized description', async () => {
    const commands = seed({ name: 'commands', cmd: 'commands', func: 'commands', message: '', reserved: true, description: 'stored', cooldown: 10 });
    const id = String(commands._id);
    const blocks = await call('PUT', `/${OWNER}/${id}`, OWNER, { authoring: 'blocks', blocks: {} });
    assert.deepEqual(blocks.json, { error: true, code: 'reserved', message: 'Built-in commands can\'t use blocks', status: 400 });
    const updated = await call('PUT', `/${OWNER}/${id}?language=es`, OWNER, { description: 'mine', message: 'ignored?', cooldown: 20 });
    assert.equal(updated.status, 200);
    assert.equal(store.get(id)?.description, 'stored');
    assert.equal(store.get(id)?.message, '');
    assert.notEqual(updated.json.command.description, 'stored');
    assert.notEqual(updated.json.command.description, 'mine');
});

test('PUT keyword: cooldown minimum, normalized trigger, keyword index refresh', async () => {
    const keyword = seed({ name: 'hi', cmd: 'hello', func: 'custom', message: 'hey', activation: 'keyword', keywordSettings: { matchMode: 'start' }, cooldown: 10 });
    const id = String(keyword._id);
    const low = await call('PUT', `/${OWNER}/${id}`, OWNER, { cooldown: 0 });
    assert.deepEqual(low.json, { error: true, message: 'Keyword cooldown must be at least 5 seconds', status: 400 });
    const { json, entry } = await call('PUT', `/${OWNER}/${id}`, OWNER, { cmd: 'Hello  World', message: 'yo' });
    assert.equal(json.command.cmd, 'hello world');
    assert.equal(json.command.func, 'custom');
    assert.deepEqual(entry.cacheDeletes, []);
    assert.deepEqual(entry.keywordRefreshes, [`${OWNER}:${id}`]);
});

test('PUT block command: settings-only save keeps blocks; text needs a reply', async () => {
    plans[OWNER] = 'premium';
    const blocky = seed({ name: 'b', cmd: 'b', func: 'b', message: 'compiled', authoring: 'blocks', blocks: { v: 1, root: { type: 'root', children: [] } }, cooldown: 10 });
    const id = String(blocky._id);
    const settings = await call('PUT', `/${OWNER}/${id}`, OWNER, { cooldown: 20 });
    assert.equal(settings.status, 200);
    assert.equal(settings.json.command.message, '');
    assert.equal(settings.json.command.authoring, 'blocks');
    assert.equal(store.get(id)?.message, 'compiled');
    const text = await call('PUT', `/${OWNER}/${id}`, OWNER, { authoring: 'text' });
    assert.deepEqual(text.json, { error: true, code: 'missing_message', message: 'Type the new reply to switch back to text', status: 400 });
    const switched = await call('PUT', `/${OWNER}/${id}`, OWNER, { authoring: 'text', message: 'plain' });
    assert.equal(switched.json.command.authoring, 'text');
    assert.equal(store.get(id)?.blocks, null);
});

test('PUT hides unexpected failures behind a 500', async () => {
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll' });
    failNextFind = true;
    const { json } = await call('PUT', `/${OWNER}/${String(dice._id)}`, OWNER, { message: 'x' });
    assert.deepEqual(json, { error: true, message: 'Error updating command', status: 500 });
});

// ---------------------------------------------------------------------------
// DELETE /commands/:channelID/:commandID
// ---------------------------------------------------------------------------

test('DELETE access, not found, built-ins, success and keyword refresh', async () => {
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll' });
    const builtIn = seed({ name: 'commands', cmd: 'commands', func: 'commands', reserved: true });
    const keyword = seed({ name: 'hi', cmd: 'hello', func: 'custom', message: 'hey', activation: 'keyword', keywordSettings: { matchMode: 'start' } });
    assert.equal((await call('DELETE', `/${OWNER}/${String(dice._id)}`, STRANGER)).status, 403);
    const missing = await call('DELETE', `/${OWNER}/aaaaaaaaaaaaaaaaaaaaaaaa`, OWNER);
    assert.deepEqual(missing.json, { error: true, message: 'Command not found for this channel', status: 404 });
    const reserved = await call('DELETE', `/${OWNER}/${String(builtIn._id)}`, OWNER);
    assert.deepEqual(reserved.json, { error: true, message: 'Cannot delete reserved command', status: 403 });
    const deleted = await call('DELETE', `/${OWNER}/${String(dice._id)}`, ADMIN);
    assert.equal(deleted.status, 200);
    assert.deepEqual(Object.keys(deleted.json), ['error', 'message', 'command', 'status']);
    assert.equal(deleted.json.message, 'Command deleted');
    assert.equal(deleted.json.command.cmd, 'dice');
    assert.deepEqual(deleted.entry.cacheDeletes, [`${OWNER}:commands:dice`]);
    const deletedKeyword = await call('DELETE', `/${OWNER}/${String(keyword._id)}`, OWNER);
    assert.deepEqual(deletedKeyword.entry.keywordRefreshes, [`${OWNER}:${String(keyword._id)}`]);
    assert.equal(store.size, 1);
    failNextFind = true;
    const failed = await call('DELETE', `/${OWNER}/${String(builtIn._id)}`, OWNER);
    assert.deepEqual(failed.json, { error: true, message: 'Error deleting command', status: 500 });
});

// ---------------------------------------------------------------------------
// Service-only behavior (site assistant)
// ---------------------------------------------------------------------------

test('service guard: update and delete refuse when the command changed since it was read', async () => {
    if (!('updateChannelCommand' in service)) return;
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const id = String(dice._id);
    await assert.rejects(
        service.updateChannelCommand(OWNER, id, { message: 'new' }, { guard: { message: 'something else' } }),
        (error: unknown) => error instanceof service.CommandMutationError && error.status === 409 && error.code === 'changed',
    );
    assert.equal(store.get(id)?.message, 'roll');
    const updated = await service.updateChannelCommand(OWNER, id, { message: 'new' }, { guard: { message: 'roll' } });
    assert.equal(updated.command.message, 'new');
    await assert.rejects(
        service.deleteChannelCommand(OWNER, id, { guard: { message: 'roll' } }),
        (error: unknown) => error instanceof service.CommandMutationError && error.status === 409,
    );
    assert.equal(store.size, 1);
    await service.deleteChannelCommand(OWNER, id, { guard: { message: 'new' } });
    assert.equal(store.size, 0);
});

test('service restore puts a deleted command back with its id, count and blocks', async () => {
    if (!('restoreDeletedCommand' in service)) return;
    const dice = seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 0, count: 42 });
    const id = String(dice._id);
    const deleted = await service.deleteChannelCommand(OWNER, id);
    assert.equal(store.size, 0);
    cacheDeletes.length = 0;
    const restored = await service.restoreDeletedCommand(OWNER, deleted.raw);
    assert.equal(String(restored.command._id), id);
    assert.equal(store.get(id)?.count, 42);
    assert.deepEqual(cacheDeletes, [`${OWNER}:commands:dice`, `${OWNER}:commands:dice`]);
    // Same trigger taken again in the meantime → conflict, nothing written.
    await service.deleteChannelCommand(OWNER, id);
    seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'someone else' });
    await assert.rejects(service.restoreDeletedCommand(OWNER, deleted.raw), (error: unknown) => error instanceof service.CommandMutationError && error.status === 409);
    assert.equal(store.size, 1);
});
