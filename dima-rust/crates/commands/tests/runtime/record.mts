// Records what the real TypeScript of P4-CMD-RUNTIME does, for `tests/runtime_reference.rs`:
// command lookups (`Commands.getCommandFromDB`) and the cache keys they write, the count update,
// availability changes (`setAvailability`, `recoverAvailability`) with the documents they leave
// and the Twitch requests they send, chat history, the admin role cache load, the stream
// online/offline resets, and the pure helpers.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/commands/tests/runtime/record.mts" \
//     "$REPO/dima-rust/crates/commands/tests/runtime/reference.json"
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference.
// Stores: a throwaway MongoDB database `dima_test_commands_rec_<random>` (dropped at the end,
// also after a failure) and Dragonfly logical database 11, where every key this script touches
// holds one of its channel ids (99000000x), removed before and after. Twitch is replaced by a
// recording `fetch` (no request leaves the process) and `utils/header.ts` by a stub
// (`stub_hooks.mjs`); the logger, telemetry and metrics modules are stubs too. The clock is
// frozen (`Date` replaced before anything is imported). Random UUIDs become `uuid-<n>` by
// first appearance in each case's stored documents (walked in `_id` order).
//
// Provenance: `reference` is the commit of the checkout's last change to `src/`, `sources` the
// SHA-256 of every TypeScript file whose behaviour is recorded.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const NOW_MS = Date.UTC(2026, 10, 12, 9, 30, 0, 250);
let frozen = NOW_MS;
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0) super(frozen);
        else super(...(args as [any]));
    }
    static now() {
        return frozen;
    }
}
Object.defineProperty(FrozenDate, 'name', { value: 'Date' });
(globalThis as any).Date = FrozenDate;

register(new URL('./stub_hooks.mjs', import.meta.url).href, import.meta.url);

const out = process.argv[2];
if (!out) throw new Error('usage: record.mts <out.json>');
if (process.env.TZ !== 'UTC') throw new Error('run with TZ=UTC');
const uri = process.env.DIMA_TEST_MONGO_URI;
const dragonflyAddress = process.env.DIMA_TEST_DRAGONFLY;
if (!uri || !dragonflyAddress) throw new Error('eval "$(dima-rust/tools/test-env)" first');
const [dfHost, dfPort] = dragonflyAddress.split(':');
process.env.DRAGONFLY_HOST = dfHost;
process.env.DRAGONFLY_PORT = `${dfPort}/11`;

const root = process.cwd();
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
const { EJSON, ObjectId } = mongoose.mongo.BSON;
const imported = async (file: string) => import(pathToFileURL(path.join(root, 'src', file)).href);

const SOURCES = [
    'classes/command.class.ts',
    'classes/chat_history.ts',
    'classes/cooldown.class.ts',
    'utils/availability/service.ts',
    'utils/availability/schema.ts',
    'utils/cache.ts',
    'utils/permissions/roles.ts',
    'middleware/channel_permissions.ts',
    'handlers/special_parser.userlevel.ts',
    'utils/ast_parser/randomuser_settings.ts',
    'utils/ast_variable_migration.ts',
    'schemas/commands.schema.ts',
    'schemas/redemption_reward.schema.ts',
    'schemas/admin.schema.ts',
];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sources = Object.fromEntries(SOURCES.map((file) => [file, sha256(readFileSync(path.join(root, 'src', file), 'utf8'))]));
const reference = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim();

const database = `dima_test_commands_rec_${randomInt(1e9)}`;
const base = new URL(uri);
base.pathname = `/${database}`;
await mongoose.connect(base.toString());
let redis: any = null;
try {

const { default: Commands } = await imported('classes/command.class.ts');
const { default: ChatHistory } = await imported('classes/chat_history.ts');
const availability = await imported('utils/availability/service.ts');
const cache = await imported('utils/cache.ts');
const { resolveAuthoredAstUserLevel } = await imported('handlers/special_parser.userlevel.ts');
const { normalizeRandomUserBlacklist } = await imported('utils/ast_parser/randomuser_settings.ts');
const { planGlobalAstVariables } = await imported('utils/ast_variable_migration.ts');
const { getDragonflyClient } = await imported('utils/databases/dragonfly.database.ts');
redis = await getDragonflyClient('record');

const CHANNEL_A = '990000001';
const CHANNEL_B = '990000002';
const CHANNEL_C = '990000003';

async function cleanKeys() {
    for (const pattern of ['*99000000*']) {
        for (const key of await redis.keys(pattern)) await redis.del(key);
    }
}

// ---------------------------------------------------------------------------------------------
// Fetch: a scripted Twitch.
// ---------------------------------------------------------------------------------------------
let script: Array<{ status: number; body: string }> = [];
let requests: Array<Record<string, unknown>> = [];
(globalThis as any).fetch = async (url: string, init: any = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ method: init.method ?? 'GET', url: String(url), headers, body: init.body ?? null });
    const next = script.shift();
    if (!next) throw new Error('fetch failed');
    return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
};

// ---------------------------------------------------------------------------------------------
// Seeds (inserted as they are, bypassing Mongoose; the Rust test inserts the same documents).
// ---------------------------------------------------------------------------------------------
const oid = (n: number) => new ObjectId(`64a0000000000000000${String(n).padStart(5, '0')}`);
function command(n: number, channelID: string, cmd: unknown, extra: Record<string, unknown> = {}) {
    return {
        _id: oid(n), name: typeof cmd === 'string' ? cmd : 'x', cmd, activation: 'command', func: 'custom',
        message: `reply ${n}`, authoring: 'text', responses: [], variables: {}, type: 'command', platform: 'twitch',
        reserved: false, description: 'd', cooldown: 10, count: 0, userLevelName: 'everyone', userLevel: 0,
        permissionExpression: null, permissions: {}, enabled: true, paused: false, channel: 'chan', channelID,
        premiumRequired: false, premiumLevelRequired: 0, createdAt: new RealDate(NOW_MS - 86_400_000),
        date: { day: 11, month: 11, year: 2026 }, __v: 0, ...extra,
    };
}
const nfc = 'café';
const nfd = 'café';
const COMMANDS = [
    command(1, CHANNEL_A, 'hola'),
    command(2, CHANNEL_A, 'Mayus'),
    command(3, CHANNEL_A, 'off', { enabled: false }),
    command(4, CHANNEL_A, 'kw', { activation: 'keyword' }),
    command(5, CHANNEL_A, 'both'),
    command(6, CHANNEL_A, 'both', { activation: 'keyword' }),
    command(7, CHANNEL_A, 'ñandú'),
    command(8, CHANNEL_A, nfc),
    command(9, CHANNEL_A, '!bang'),
    command(10, CHANNEL_A, 'dup', { message: 'first' }),
    command(11, CHANNEL_A, 'dup', { message: 'second' }),
    command(12, CHANNEL_A, 'real', { name: 'alias' }),
    command(13, CHANNEL_A, 'a'.repeat(500)),
    command(14, CHANNEL_A, '日本語'),
    command(15, CHANNEL_A, 'مرحبا'),
    command(16, CHANNEL_A, '🎉fiesta'),
    command(17, CHANNEL_A, ['arr1', 'arr2']),
    command(18, CHANNEL_A, 'legacy', { activation: undefined }),
    command(19, CHANNEL_A, 'nullact', { activation: null }),
    command(20, CHANNEL_B, 'other'),
    command(21, CHANNEL_B, 'hola', { message: 'hola from B' }),
    command(22, CHANNEL_A, 'zw​j'),
    command(23, CHANNEL_A, 'disabled2', { enabled: false, cooldown: 0 }),
];
for (const doc of COMMANDS) if (doc.activation === undefined) delete (doc as any).activation;

function reward(n: number, channelID: string, extra: Record<string, unknown> = {}) {
    return {
        _id: oid(1000 + n), eventsubID: `sub-${n}`, channelID, channel: 'chan', rewardID: `reward-${n}`,
        title: `Reward ${n}`, type: 'custom', prompt: '', originalCost: 100, cost: 100, isEnabled: true,
        message: '', costChange: 0, returnToOriginalCost: false, duration: 0, cooldown: 0,
        backgroundColor: '#000000', createdFrom: 'domdimabot', createdFor: 'twitch', __v: 0, ...extra,
    };
}
const REWARDS = [
    reward(1, CHANNEL_A, { title: 'Hydrate' }),
    reward(2, CHANNEL_A, { title: 'Stretch', createdFor: undefined }),
    reward(3, CHANNEL_A, { title: 'Same' }),
    reward(4, CHANNEL_A, { title: 'Same' }),
    reward(5, CHANNEL_A, { title: 'Kick one', createdFor: 'kick' }),
    reward(6, CHANNEL_A, { title: 'Off reward', isEnabled: false }),
];
for (const doc of REWARDS) if (doc.createdFor === undefined) delete (doc as any).createdFor;

function admin(n: number, extra: Record<string, unknown>) {
    return {
        _id: oid(2000 + n), adminName: `Admin${n}`, adminID: `a${n}`, channelName: 'chan', channelID: CHANNEL_C,
        role: 'channel', actived: true, permissions: ['chat:admin'],
        createdAt: new RealDate(NOW_MS - 1000), updatedAt: new RealDate(NOW_MS - 1000), __v: 0, ...extra,
    };
}
const ADMINS = [
    admin(1, {}),
    admin(2, { permissions: ['*'], adminName: 'ÉLODIE' }),
    admin(3, { permissions: ['dashboard:view'] }),
    admin(4, { actived: false }),
    admin(5, { adminID: '' }),
    admin(6, { channelID: CHANNEL_B }),
];

const ejson = (value: unknown) => EJSON.serialize(value, { relaxed: false });
const db = () => mongoose.connection.db;

async function reseed() {
    for (const name of ['commands', 'redemptionrewards', 'admins']) await db().collection(name).deleteMany({});
    await db().collection('commands').insertMany(COMMANDS.map((d) => ({ ...d })));
    await db().collection('redemptionrewards').insertMany(REWARDS.map((d) => ({ ...d })));
    await db().collection('admins').insertMany(ADMINS.map((d) => ({ ...d })));
    await cleanKeys();
}

// The documents of `collection` that differ from the seed (UUIDs normalised), and the seed
// ids that are gone.
async function documents(collection: string) {
    const seed = { commands: COMMANDS, redemptionrewards: REWARDS, admins: ADMINS }[collection] as any[];
    const seeded = new Map(seed.map((doc) => [String(doc._id), JSON.stringify(ejson(doc))]));
    // Raw number types (int32, int64, double), not JavaScript numbers.
    const docs = await db().collection(collection).find({}, { promoteValues: false }).sort({ _id: 1 }).toArray();
    const uuids = new Map<string, string>();
    const walk = (value: any): any => {
        if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
            if (!uuids.has(value)) uuids.set(value, `uuid-${uuids.size + 1}`);
            return uuids.get(value);
        }
        if (Array.isArray(value)) return value.map(walk);
        if (value && typeof value === 'object' && value.constructor === Object) {
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
        }
        return value;
    };
    const present = new Set(docs.map((doc: any) => String(doc._id)));
    return {
        changed: ejson(docs.map(walk)).filter((doc: any) => seeded.get(doc._id.$oid) !== JSON.stringify(doc)),
        deleted: [...seeded.keys()].filter((id) => !present.has(id)),
    };
}

async function keyState(pattern: string) {
    const keys = (await redis.keys(pattern)).sort();
    const state: Record<string, unknown> = {};
    for (const key of keys) {
        const type = await redis.type(key);
        const ttl = await redis.ttl(key);
        let value: unknown;
        if (type === 'string') value = await redis.get(key);
        else if (type === 'set') value = (await redis.sMembers(key)).sort();
        else if (type === 'hash') value = await redis.hGetAll(key);
        else if (type === 'list') value = await redis.lRange(key, 0, -1);
        state[key] = { type, ttl, value };
    }
    return state;
}

// ---------------------------------------------------------------------------------------------
// 1. Lookups.
// ---------------------------------------------------------------------------------------------
const lookups: unknown[] = [];
{
    await reseed();
    frozen = NOW_MS;
    const names = [
        'hola', 'Hola', 'HOLA', '!hola', 'Mayus', 'mayus', 'off', 'kw', 'both', 'ñandú', 'Nándu',
        nfc, nfd, '!bang', 'bang', 'dup', 'alias', 'real', 'a'.repeat(500), 'a'.repeat(499), 'a'.repeat(501),
        '日本語', 'مرحبا', '🎉fiesta', 'arr1', 'arr2', 'arr',
        'legacy', 'nullact', 'other', 'nope', '', ' hola', 'hola ', 'zw​j', 'zwj', 'disabled2',
        'العربية́', 'x'.repeat(2000),
    ];
    for (const name of names) {
        const steps = [];
        for (let i = 0; i < 2; i++) {
            const result = await Commands.getCommandFromDB(CHANNEL_A, name);
            const key = `${CHANNEL_A}:commands:${name}`;
            const cached = await redis.get(key);
            steps.push({
                error: result.error,
                message: result.message,
                id: result.command ? String(result.command._id) : null,
                enabled: result.command ? result.command.enabled ?? null : null,
                cacheKey: cached ? { id: JSON.parse(cached)._id, ttl: await redis.ttl(key) } : null,
            });
        }
        lookups.push({ channel: CHANNEL_A, name, steps });
    }
    // The same name in channel B.
    const b = await Commands.getCommandFromDB(CHANNEL_B, 'hola');
    lookups.push({ channel: CHANNEL_B, name: 'hola', steps: [{ error: b.error, message: b.message, id: b.command ? String(b.command._id) : null }] });
}

// ---------------------------------------------------------------------------------------------
// 2. The count update and the reference's stale entries.
// ---------------------------------------------------------------------------------------------
const writes: unknown[] = [];
{
    await reseed();
    await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    const updated = await Commands.updateCommandInDB(CHANNEL_A, 'hola', { count: 5 });
    const after = await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    const missing = await Commands.updateCommandInDB(CHANNEL_A, 'nope', { count: 1 });
    const fractional = await Commands.updateCommandInDB(CHANNEL_A, 'Mayus', { count: 2.5 });
    const large = await Commands.updateCommandInDB(CHANNEL_A, 'ñandú', { count: 3_000_000_000 });
    writes.push({
        name: 'count_update',
        results: [updated, missing, fractional, large].map((r: any) => ({ error: r.error, message: r.message })),
        afterLookup: { message: after.message, count: after.command?.count },
        cacheKeyAfter: await redis.exists(`${CHANNEL_A}:commands:hola`),
        documents: await documents('commands'),
    });
}
{
    // A writer that changes MongoDB and dies before deleting the key: the cached command stays.
    await reseed();
    await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    await db().collection('commands').updateOne({ _id: oid(1) }, { $set: { message: 'changed' } });
    const stale = await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    writes.push({ name: 'killed_writer', served: stale.command?.message, message: stale.message, ttl: await redis.ttl(`${CHANNEL_A}:commands:hola`) });
}
{
    // Account deletion's deleteMany never deletes the key.
    await reseed();
    await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    await db().collection('commands').deleteMany({ channelID: CHANNEL_A });
    const stale = await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    writes.push({ name: 'delete_many', served: stale.command ? String(stale.command._id) : null, message: stale.message });
}
{
    // A lookup that read MongoDB before an update and stores what it read after the update's
    // delete: the old command stays for the key's lifetime.
    await reseed();
    const { CommandsSchema } = await imported('schemas/commands.schema.ts');
    const original = CommandsSchema.findOne;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    let readDone: () => void = () => {};
    const read = new Promise<void>((resolve) => { readDone = resolve; });
    CommandsSchema.findOne = function (this: unknown, ...args: any[]) {
        const query = original.apply(this, args);
        if (gated) return query;
        gated = true;
        return { then: (ok: any, fail: any) => query.exec().then(async (doc: unknown) => { readDone(); await gate; return doc; }).then(ok, fail) };
    } as any;
    const reader = Commands.getCommandFromDB(CHANNEL_A, 'off');
    await read;
    const update = await Commands.updateCommandInDB(CHANNEL_A, 'off', { enabled: true });
    release();
    await reader;
    CommandsSchema.findOne = original;
    const stale = await Commands.getCommandFromDB(CHANNEL_A, 'off');
    const stored = await db().collection('commands').findOne({ _id: oid(3) });
    writes.push({ name: 'read_write_race', update: update.message, served: stale.command?.enabled, stored: stored?.enabled, message: stale.message, ttl: await redis.ttl(`${CHANNEL_A}:commands:off`) });
}
{
    // `!cmd del`.
    await reseed();
    await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    const deleted = await Commands.deleteCommand(CHANNEL_A, 'hola');
    const missing = await Commands.deleteCommand(CHANNEL_A, 'nope');
    const after = await Commands.getCommandFromDB(CHANNEL_A, 'hola');
    writes.push({
        name: 'delete',
        results: [deleted, missing].map((r: any) => ({ error: r.error, message: r.message, id: r.command ? String(r.command._id) : null })),
        after: after.message,
        documents: await documents('commands'),
    });
}

// ---------------------------------------------------------------------------------------------
// 3. Availability.
// ---------------------------------------------------------------------------------------------
const ok = (enabled: boolean) => ({ status: 200, body: JSON.stringify({ data: [{ id: 'x', is_enabled: enabled }] }) });
type Step = { op: 'set'; target: string; channel?: string; name: string; enabled: boolean; seconds?: number; twitch?: Array<{ status: number; body: string }>; headerFailure?: string }
    | { op: 'advance'; ms: number }
    | { op: 'recover'; twitch?: Array<{ status: number; body: string }> }
    | { op: 'lookup'; name: string };
const AVAILABILITY: Array<{ name: string; steps: Step[] }> = [
    { name: 'disable_command', steps: [{ op: 'lookup', name: 'hola' }, { op: 'set', target: 'command', name: 'hola', enabled: false }, { op: 'lookup', name: 'hola' }] },
    { name: 'disable_command_case_and_bang', steps: [{ op: 'set', target: 'command', name: '!HOLA', enabled: false }] },
    { name: 'enable_command_timed', steps: [{ op: 'set', target: 'command', name: 'off', enabled: true, seconds: 300 }] },
    { name: 'enable_command_timed_twice', steps: [{ op: 'set', target: 'command', name: 'off', enabled: true, seconds: 300 }, { op: 'advance', ms: 10_000 }, { op: 'set', target: 'command', name: 'off', enabled: true, seconds: 600 }] },
    { name: 'timed_then_untimed', steps: [{ op: 'set', target: 'command', name: 'off', enabled: true, seconds: 300 }, { op: 'set', target: 'command', name: 'off', enabled: true }] },
    { name: 'timed_restore', steps: [{ op: 'set', target: 'command', name: 'hola', enabled: false, seconds: 60 }, { op: 'advance', ms: 61_000 }, { op: 'recover' }, { op: 'lookup', name: 'hola' }] },
    { name: 'command_not_found', steps: [{ op: 'set', target: 'command', name: 'nope', enabled: false }] },
    { name: 'command_ambiguous', steps: [{ op: 'set', target: 'command', name: 'dup', enabled: false }] },
    { name: 'command_keyword_ignored', steps: [{ op: 'set', target: 'command', name: 'kw', enabled: false }] },
    { name: 'command_regex_characters', steps: [{ op: 'set', target: 'command', name: 'h.la', enabled: false }] },
    { name: 'command_unicode_case', steps: [{ op: 'set', target: 'command', name: 'ÑANDÚ', enabled: false }] },
    { name: 'duration_zero', steps: [{ op: 'set', target: 'command', name: 'hola', enabled: false, seconds: 0 }] },
    { name: 'duration_fraction', steps: [{ op: 'set', target: 'command', name: 'hola', enabled: false, seconds: 1.5 }] },
    { name: 'duration_too_long', steps: [{ op: 'set', target: 'command', name: 'hola', enabled: false, seconds: 604_801 }] },
    { name: 'duration_nan', steps: [{ op: 'set', target: 'command', name: 'hola', enabled: false, seconds: NaN }] },
    { name: 'duration_max', steps: [{ op: 'set', target: 'command', name: 'hola', enabled: false, seconds: 604_800 }] },
    { name: 'empty_name', steps: [{ op: 'set', target: 'command', name: '   ', enabled: false }] },
    { name: 'unknown_target', steps: [{ op: 'set', target: 'timer', name: 'hola', enabled: false }] },
    { name: 'reward_by_id', steps: [{ op: 'set', target: 'redemption', name: 'reward-1', enabled: false, twitch: [ok(false)] }] },
    { name: 'reward_by_title', steps: [{ op: 'set', target: 'redemption', name: 'hydrate', enabled: false, twitch: [ok(false)] }] },
    { name: 'reward_missing_created_for', steps: [{ op: 'set', target: 'redemption', name: 'Stretch', enabled: false }] },
    { name: 'reward_kick', steps: [{ op: 'set', target: 'redemption', name: 'Kick one', enabled: false }] },
    { name: 'reward_ambiguous', steps: [{ op: 'set', target: 'redemption', name: 'same', enabled: false }] },
    { name: 'reward_not_found', steps: [{ op: 'set', target: 'redemption', name: 'Nothing', enabled: false }] },
    { name: 'reward_twitch_error', steps: [{ op: 'set', target: 'redemption', name: 'Hydrate', enabled: false, twitch: [{ status: 404, body: JSON.stringify({ error: 'Not Found', status: 404, message: 'reward not found' }) }] }] },
    { name: 'reward_twitch_error_no_message', steps: [{ op: 'set', target: 'redemption', name: 'Hydrate', enabled: false, twitch: [{ status: 500, body: JSON.stringify({ error: 'Internal Server Error' }) }] }] },
    { name: 'reward_not_confirmed', steps: [{ op: 'set', target: 'redemption', name: 'Hydrate', enabled: false, twitch: [ok(true)] }] },
    { name: 'reward_no_credential', steps: [{ op: 'set', target: 'redemption', name: 'Hydrate', enabled: false, headerFailure: '[⚠️] Streamer not found for ID: {id} [/⚠️]' }] },
    { name: 'reward_retry_recovers', steps: [{ op: 'set', target: 'redemption', name: 'Hydrate', enabled: false, twitch: [{ status: 503, body: JSON.stringify({ error: 'Service Unavailable', status: 503, message: 'try later' }) }] }, { op: 'advance', ms: 10_000 }, { op: 'recover' }, { op: 'advance', ms: 21_000 }, { op: 'recover', twitch: [ok(false)] }] },
    { name: 'reward_timed_restore', steps: [{ op: 'set', target: 'redemption', name: 'Hydrate', enabled: false, seconds: 60, twitch: [ok(false)] }, { op: 'advance', ms: 60_000 }, { op: 'recover', twitch: [ok(true)] }] },
    { name: 'reward_enable_disabled', steps: [{ op: 'set', target: 'redemption', name: 'Off reward', enabled: true, twitch: [ok(true)] }] },
];
const availabilityCases: unknown[] = [];
for (const testCase of AVAILABILITY) {
    await reseed();
    frozen = NOW_MS;
    requests = [];
    const results: unknown[] = [];
    for (const step of testCase.steps) {
        script = 'twitch' in step && step.twitch ? [...step.twitch] : [];
        (globalThis as any).__headerFailure = 'headerFailure' in step ? step.headerFailure : undefined;
        if (step.op === 'set') {
            try {
                await availability.setAvailability(step.target, step.channel ?? CHANNEL_A, step.name, step.enabled, step.seconds);
                results.push({ ok: true });
            } catch (error) {
                results.push({ error: error instanceof Error ? error.message : String(error) });
            }
        } else if (step.op === 'advance') {
            frozen += step.ms;
            results.push({ now: frozen });
        } else if (step.op === 'recover') {
            await availability.recoverAvailability();
            results.push({ recovered: true });
        } else {
            const found = await Commands.getCommandFromDB(CHANNEL_A, step.name);
            results.push({ lookup: found.message, enabled: found.command?.enabled ?? null });
        }
        if (script.length) throw new Error(`${testCase.name}: unused Twitch answers`);
    }
    (globalThis as any).__headerFailure = undefined;
    availabilityCases.push({
        name: testCase.name,
        steps: testCase.steps.map((step) => ({ ...step, seconds: 'seconds' in step ? (Number.isNaN(step.seconds) ? 'NaN' : step.seconds ?? null) : undefined })),
        results,
        requests,
        commands: await documents('commands'),
        rewards: await documents('redemptionrewards'),
    });
}

// ---------------------------------------------------------------------------------------------
// 4. Chat history.
// ---------------------------------------------------------------------------------------------
const history: Record<string, unknown> = {};
{
    await cleanKeys();
    const added = [];
    for (let i = 0; i < 105; i++) {
        const text = i % 7 === 0 ? `emoji 🎉 ${i}` : i % 5 === 0 ? `مرحبا ${i}` : `message ${i}`;
        await ChatHistory.addMessage(CHANNEL_A, `User${i}`, text, i % 3 === 0 ? undefined : ['moderator/1'], 'twitch', i % 4 === 0 ? undefined : `id-${i}`, NOW_MS + i);
        if (i === 0 || i === 99 || i === 100 || i === 104) added.push({ after: i + 1, length: await redis.lLen(`twitch:${CHANNEL_A}:chat:history`) });
    }
    await ChatHistory.addMessage(CHANNEL_A, '', 'no user', [], 'twitch', 'x', NOW_MS);
    await ChatHistory.addMessage(CHANNEL_A, 'user', '', [], 'twitch', 'x', NOW_MS);
    await ChatHistory.addMessage('', 'user', 'no channel', [], 'twitch', 'x', NOW_MS);
    await ChatHistory.addMessage(CHANNEL_A, 'KickUser', 'on kick', undefined, 'kick', undefined, NOW_MS);
    history.lengths = added;
    history.lengthAfterInvalid = await redis.lLen(`twitch:${CHANNEL_A}:chat:history`);
    history.reads = {};
    for (const limit of [7, 1, 0, -5, 30, 100, 200]) {
        (history.reads as any)[String(limit)] = await ChatHistory.getRecentMessages(CHANNEL_A, limit);
    }
    history.kick = await ChatHistory.getRecentMessages(CHANNEL_A, 7, 'kick');
    history.empty = await ChatHistory.getRecentMessages(CHANNEL_B, 7);
    await ChatHistory.clearHistory(CHANNEL_A);
    history.afterClear = await redis.exists(`twitch:${CHANNEL_A}:chat:history`);
    history.kickAfterClear = await redis.exists(`kick:${CHANNEL_A}:chat:history`);
    await cleanKeys();
}

// ---------------------------------------------------------------------------------------------
// 5. Role cache load, stream resets.
// ---------------------------------------------------------------------------------------------
const channelCache: Record<string, unknown> = {};
{
    await reseed();
    await redis.sAdd(`twitch:${CHANNEL_C}:admins`, 'gone');
    await redis.sAdd(`twitch:${CHANNEL_C}:admins:ids`, 'a999');
    await redis.hSet(`twitch:${CHANNEL_C}:admins:a999`, { adminID: 'a999', adminName: 'gone' });
    await redis.set(`${CHANNEL_C}:admins:legacy`, 'x');
    await redis.sAdd(`twitch:${CHANNEL_B}:admins`, 'untouched');
    await cache.loadChannelAdminsIntoCache(CHANNEL_C);
    channelCache.admins = await keyState(`*${CHANNEL_C}*`);
    channelCache.otherChannel = await keyState(`*${CHANNEL_B}*`);
    await cache.loadChannelAdminsIntoCache(CHANNEL_C);
    channelCache.adminsTwice = await keyState(`*${CHANNEL_C}*`);

    await cleanKeys();
    await redis.set(`${CHANNEL_A}:follows:count`, '17');
    await redis.set(`${CHANNEL_A}:commands`, 'legacy');
    await redis.set(`${CHANNEL_A}:sumimetro:alice`, '42');
    await redis.set(`${CHANNEL_A}:sumimetro:bob`, '7');
    await redis.hSet(`${CHANNEL_A}:sumimetro:dominant`, { user: 'alice', value: '42' });
    await redis.set(`${CHANNEL_B}:sumimetro:carol`, '1');
    await cache.clearChannelCache(CHANNEL_A);
    await cache.resetSumimetro(CHANNEL_A);
    channelCache.afterResets = { a: await keyState(`*${CHANNEL_A}*`), b: await keyState(`*${CHANNEL_B}*`) };
    await cleanKeys();
}

// ---------------------------------------------------------------------------------------------
// 6. Pure helpers.
// ---------------------------------------------------------------------------------------------
const userLevels = [
    [{}, undefined], [{ chatter_user_id: '1' }, undefined], [{ chatter_user_login: 'x' }, undefined],
    [{ chatter_user_name: '' }, undefined], [{ chatter_user_id: 0 }, undefined],
    [{ chatter_user_id: '1', badges: [{ set_id: 'moderator' }] }, undefined],
    [{ chatter_user_id: '1', badges: [{ set_id: 'MOD' }] }, undefined],
    [{ chatter_user_id: '1', badges: [{ set_id: '', id: 'lead_mod' }] }, undefined],
    [{ chatter_user_id: '1', badges: [{ id: 'lead_moderator' }] }, undefined],
    [{ chatter_user_id: '1', badges: [{ set_id: 'vip' }, { set_id: 'broadcaster' }] }, undefined],
    [{ chatter_user_id: '1', badges: [null, 'moderator', { set_id: ['mod'] }] }, undefined],
    [{ chatter_user_id: '1', badges: 'moderator' }, undefined],
    [{ badges: [{ set_id: 'moderator' }] }, undefined],
    [{ badges: [{ set_id: 'moderator' }] }, 3], [{}, 3], [{}, 8.5], [{}, -1],
    [{ chatter_user_id: '1', badges: [{ set_id: 'moderator' }] }, 10],
    [{ chatter_user_id: '1' }, Infinity], [{}, NaN], [{ chatter_user_id: '1' }, '9'],
    [{ chatter_user_id: '1', badges: [{ set_id: 'MODERATORİ' }] }, undefined],
].map(([event, level]) => ({
    event, level: typeof level === 'number' && !Number.isFinite(level) ? String(level) : level ?? null,
    expected: resolveAuthoredAstUserLevel(event, level),
}));

const blacklists = [
    [], ['Alice', '@Bob', ' carol ', 'alice'], ['a'.repeat(25)], ['a'.repeat(26)], [''], ['@'], ['@@x'],
    ['user name'], ['ñandú'], ['Kelvin'], ['x-y'], [1], 'alice', null, { 0: 'a' },
    Array.from({ length: 200 }, (_, i) => `u${i}`), Array.from({ length: 201 }, (_, i) => `u${i}`),
    [' alice '], ['﻿bob'], ['ALICE', 'alice', 'Alice'], ['x\n'],
].map((input) => ({ input: input === undefined ? null : input, expected: normalizeRandomUserBlacklist(input) }));

const astRows = [
    { channelID: 'c', scopeType: 'command', scopeName: 'a', userId: 'u1', userLogin: 'Alice', variables: { x: '1', '2': 'two', y: 'old' }, updatedAt: new RealDate(1000), _id: 'b' },
    { channelID: 'c', scopeType: 'command', scopeName: 'b', userId: 'u1', userLogin: 'alice', variables: { y: 'new', z: 'z', '10': 'ten' }, updatedAt: new RealDate(2000), _id: 'a' },
    { channelID: 'c', scopeType: 'global', scopeName: 'global', userId: 'u1', userLogin: 'alice', variables: { g: 'global' }, updatedAt: new RealDate(3000), _id: 'c' },
    { channelID: 'c', scopeType: 'keyword', scopeName: 'k', userId: '', userLogin: 'BOB', variables: { b: '1' }, _id: 'e' },
    { channelID: 'c', scopeType: 'keyword', scopeName: 'k2', userId: '', userLogin: 'bob', variables: { b: '2' }, _id: 'f' },
    { channelID: 'd', scopeType: 'command', scopeName: 'a', userId: 'u1', userLogin: 'alice', variables: {}, updatedAt: new RealDate(1000), _id: 'g' },
    { channelID: 'c', scopeType: 'command', scopeName: 'c', userId: 'u2', userLogin: 'Zoë', variables: { q: 'A' }, updatedAt: new RealDate(5000), _id: 'B' },
    { channelID: 'c', scopeType: 'command', scopeName: 'd', userId: 'u2', userLogin: 'zoe', variables: { q: 'a' }, updatedAt: new RealDate(5000), _id: 'a' },
];
const astPlan = {
    rows: astRows.map((row) => ({ ...row, updatedAt: row.updatedAt ? row.updatedAt.getTime() : null })),
    expected: planGlobalAstVariables(astRows as any),
};

// ---------------------------------------------------------------------------------------------
// Done.
// ---------------------------------------------------------------------------------------------
const output = {
    reference,
    sources,
    now: NOW_MS,
    seed: { commands: ejson(COMMANDS), rewards: ejson(REWARDS), admins: ejson(ADMINS) },
    lookups,
    writes,
    availability: availabilityCases,
    history,
    channelCache,
    userLevels,
    blacklists,
    astPlan,
};
writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`);
console.log(`recorded ${lookups.length} lookups, ${writes.length} writes, ${availabilityCases.length} availability cases`);
} finally {
    if (redis) {
        for (const key of await redis.keys('*99000000*')) await redis.del(key);
        await redis.quit();
    }
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
}
