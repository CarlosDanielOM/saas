'use strict';
// Actual-source oracle for `src/utils/raid_subscriptions.ts`.
//
// Run only in an isolated toolchain:
//   node tests/fixtures/raid_subscriptions_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/raid_subscriptions_reference.cjs --check <absolute-dir>
//
// The fixture transpiles and executes the real `src/utils/raid_subscriptions.ts`
// with in-memory model persistence. It never contacts a database, cache,
// Twitch endpoint or network.
//
// Boundaries (also recorded in the output's `boundaries`):
// * `src/utils/raid_direction.ts` was retired after its native port; the
//   preserved archived source is loaded so the real `raid_subscriptions.ts`
//   import resolves. Direction policy itself is not restated here.
// * `src/schemas/eventsub.schema.ts` was retired after its native port; the
//   preserved archived source builds the real Mongoose model, and only
//   `Model.findOne` is replaced by a recorder with an in-memory row matcher.
//   The recorded chain values are the arguments the source passes, not
//   reimplemented casting.
// * `src/schemas/raid_subscription_preference.schema.ts` is still live; its
//   real model is loaded and `exists`/`findById` are replaced by recorders with
//   the same Mongoose surface (`select({_id:1}).lean()` and `.lean()`).
// * `Model.exists` is `findOne(filter).select({_id:1}).lean()` in Mongoose 8;
//   the recorder keeps that exact existence contract (a document, not a bool).
// * No value encoder, number rule or date formatter is reimplemented. Event
//   payloads are plain JSON, so `String(x || '')` semantics are exercised by
//   the real source.
//
// The repository Node version is recorded, not asserted: this fixture asserts
// only the TypeScript/Mongoose/BSON versions whose cast/query behavior it uses.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');

const root = path.resolve(__dirname, '../..');
const requireFromRoot = Module.createRequire(path.join(root, 'package.json'));
const ts = requireFromRoot('typescript');
const mongoose = requireFromRoot('mongoose');
const bsonRequire = Module.createRequire(requireFromRoot.resolve('mongoose'));
const BSON = bsonRequire('bson');
const bsonVersion = JSON.parse(
    fs.readFileSync(path.join(path.dirname(bsonRequire.resolve('bson')), '..', 'package.json'), 'utf8'),
).version;

assert.equal(ts.version, '5.9.3');
assert.equal(mongoose.version, '8.24.2');
assert.equal(bsonVersion, '6.10.4');

const sources = {
    subscriptions: 'src/utils/raid_subscriptions.ts',
    preferenceSchema: 'src/schemas/raid_subscription_preference.schema.ts',
    archivedEventsub: '../archives/dimabot-typescript/2026-10-28/src/schemas/eventsub.schema.ts',
    archivedDirection: '../archives/dimabot-typescript/2026-10-28/src/utils/raid_direction.ts',
    oracle: 'tests/fixtures/raid_subscriptions_reference.cjs',
};
const read = file => fs.readFileSync(path.resolve(root, file), 'utf8');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root, file))).digest('hex');

// --- module loading -------------------------------------------------------
function compile(file) {
    const result = ts.transpileModule(read(file), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    });
    assert(
        !result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
        `${file} failed to transpile`,
    );
    return result.outputText;
}

const cache = new Map();
function load(file, resolve) {
    if (cache.has(file)) return cache.get(file);
    const record = {exports: {}};
    new Function('require', 'module', 'exports', '__filename', compile(file))(
        resolve,
        record,
        record.exports,
        path.resolve(root, file),
    );
    cache.set(file, record.exports);
    return record.exports;
}

// --- real Mongoose models on a disconnected instance ----------------------
const instance = new mongoose.Mongoose();
instance.set('autoCreate', false);
instance.set('autoIndex', false);
const mongooseFacade = {
    Schema: instance.Schema,
    model: instance.model.bind(instance),
    Types: instance.Types,
};
function mongooseResolve(id) {
    if (id === 'mongoose') return mongooseFacade;
    throw Error(`unexpected schema import ${id}`);
}

const preferenceModule = load(sources.preferenceSchema, mongooseResolve);
const Preferences = preferenceModule.RaidSubscriptionPreferenceSchema;
const eventsubModule = load(sources.archivedEventsub, mongooseResolve);
const Eventsub = eventsubModule.default;
const directionModule = load(sources.archivedDirection, id => {
    throw Error(`unexpected direction import ${id}`);
});
const {raidDirection} = directionModule;
assert.equal(typeof Preferences.exists, 'function');
assert.equal(typeof Preferences.findById, 'function');
assert.equal(typeof Eventsub.findOne, 'function');

// --- mutable case state ---------------------------------------------------
const state = {preferences: [], eventsubs: [], calls: [], fail: null};

function reset(overrides) {
    state.preferences = [];
    state.eventsubs = [];
    state.calls = [];
    state.fail = null;
    Object.assign(state, overrides || {});
}

function matches(row, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            throw Error(`unsupported operator in ${key}`);
        }
        const actual = key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), row);
        return actual === expected;
    });
}

function matchRow(rows, filter) {
    return rows.find(row => matches(row, filter)) || null;
}

// `Model.exists` contract: a document (projected to `_id`) or null. Each
// recorder pushes its call before applying the injected failure, so error
// cases prove the source's read ordering.
Preferences.exists = async filter => {
    state.calls.push({op: 'exists', filter});
    if (state.fail === 'preferences') throw Error('injected preference read failure');
    const row = matchRow(state.preferences, filter);
    return row ? {_id: row._id} : null;
};
Preferences.findById = id => ({
    lean: async () => {
        state.calls.push({op: 'findById', filter: {_id: id}});
        if (state.fail === 'preferences') throw Error('injected preference read failure');
        return state.preferences.find(row => String(row._id) === String(id)) || null;
    },
});
// The recorder keeps the chain surface the source calls and records the exact
// filter/projection/maxTimeMS; it is deliberately not a Mongoose query.
Eventsub.findOne = filter => {
    const call = {op: 'findOne', filter, projection: null, maxTimeMS: null};
    return {
        select(projection) {
            call.projection = projection;
            return this;
        },
        maxTimeMS(value) {
            call.maxTimeMS = value;
            return this;
        },
        lean: async () => {
            state.calls.push(call);
            if (state.fail === 'eventsubs') throw Error('injected eventsub read failure');
            return matchRow(state.eventsubs, filter);
        },
    };
};

// --- real source module ---------------------------------------------------
const subscriptions = load(sources.subscriptions, id => {
    if (id === '../schemas/eventsub.schema.js') return eventsubModule;
    if (id === '../schemas/raid_subscription_preference.schema.js') return preferenceModule;
    if (id === './raid_direction.js') return directionModule;
    if (id === 'node:crypto') return crypto;
    throw Error(`unexpected raid_subscriptions import ${id}`);
});
const {raidPreferenceID, isRaidDeleted, shouldRepairRaid, acceptsRaidNotification} = subscriptions;
assert.equal(typeof raidPreferenceID, 'function');

// --- case helpers ---------------------------------------------------------
function condition(from, to) {
    if (from === undefined && to === undefined) return undefined;
    const value = {};
    if (from !== undefined) value.from_broadcaster_user_id = from;
    if (to !== undefined) value.to_broadcaster_user_id = to;
    return value;
}
function event(from, to) {
    if (from === undefined && to === undefined) return {};
    const value = {};
    if (from !== undefined) value.from_broadcaster_user_id = from;
    if (to !== undefined) value.to_broadcaster_user_id = to;
    return value;
}
function preference(channelID, direction, deleted) {
    const row = {_id: `${channelID}:${direction}`, channelID, direction};
    if (deleted !== undefined) row.deleted = deleted;
    return row;
}
function config(channelID, direction, enabled, id) {
    const field = direction === 'outgoing' ? 'from_broadcaster_user_id' : 'to_broadcaster_user_id';
    const row = {channelID, type: 'channel.raid', condition: {[field]: channelID}};
    if (enabled !== undefined) row.enabled = enabled;
    if (id !== undefined) row.id = id;
    return row;
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

const cases = [];

async function record(name, kind, subject, run) {
    reset(subject.state);
    const direction = raidDirection(subject.subscription && subject.subscription.condition);
    const field = direction === 'outgoing' ? 'from_broadcaster_user_id' : 'to_broadcaster_user_id';
    let expect;
    try {
        const value = await run();
        expect = {ok: true, value};
    } catch (error) {
        expect = {ok: false, error: error && error.message ? error.message : String(error)};
    }
    const rows = kind === 'accepts' ? state.eventsubs : [];
    const findOne = [...state.calls].reverse().find(call => call.op === 'findOne');
    const matched = findOne ? matchRow(rows, findOne.filter) : null;
    cases.push({
        name,
        kind,
        input: clone(subject),
        expect,
        observed: {
            direction,
            eventField: field,
            calls: clone(state.calls),
            // Projection-equivalent view of the row the source query matched.
            // Only `enabled` and `id` survive `select('enabled id')`.
            preference: clone(matchRow(state.preferences, {
                _id: `${subject.channelID}:${direction}`,
            })),
            config: clone(matched ? {enabled: matched.enabled, id: matched.id} : null),
        },
    });
}

function acceptsCase(name, {id, condition: subjectCondition, event: subjectEvent, preferences = [], eventsubs = [], channelID = 'channel-a', fail = null}) {
    const subscription = {};
    if (id !== undefined) subscription.id = id;
    if (subjectCondition !== undefined) subscription.condition = subjectCondition;
    return record(name, 'accepts', {
        subscription,
        event: subjectEvent,
        channelID,
        state: {preferences, eventsubs, fail},
    }, () => acceptsRaidNotification(subscription, subjectEvent));
}

function deletedCase(name, {direction, preferences, channelID = 'channel-a', fail = null}) {
    return record(name, 'deleted', {
        subscription: {condition: direction === 'outgoing' ? condition(channelID) : condition(undefined, channelID)},
        event: {},
        channelID,
        state: {preferences, fail},
    }, () => isRaidDeleted(channelID, direction));
}

function repairCase(name, {direction, preferences, channelID = 'channel-a', fail = null}) {
    return record(name, 'repair', {
        subscription: {condition: direction === 'outgoing' ? condition(channelID) : condition(undefined, channelID)},
        event: {},
        channelID,
        state: {preferences, fail},
    }, () => shouldRepairRaid(channelID, direction));
}

// --- deletion probe and repair gate --------------------------------------
async function collect() {
    await deletedCase('deleted_incoming_missing_row', {direction: 'incoming', preferences: []});
    await deletedCase('deleted_outgoing_missing_row', {direction: 'outgoing', preferences: []});
    await deletedCase('deleted_incoming_true', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'incoming', true)],
});
    await deletedCase('deleted_incoming_false', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'incoming', false)],
});
    await deletedCase('deleted_outgoing_true', {
    direction: 'outgoing',
    preferences: [preference('channel-a', 'outgoing', true)],
});
    await deletedCase('deleted_scoped_by_direction', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'outgoing', true)],
});
    await deletedCase('deleted_scoped_by_channel', {
    direction: 'incoming',
    preferences: [preference('channel-b', 'incoming', true)],
});

    await repairCase('repair_incoming_missing_row', {direction: 'incoming', preferences: []});
    await repairCase('repair_outgoing_missing_row', {direction: 'outgoing', preferences: []});
    await repairCase('repair_incoming_deleted_true', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'incoming', true)],
});
    await repairCase('repair_incoming_deleted_false', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'incoming', false)],
});
    await repairCase('repair_outgoing_deleted_false', {
    direction: 'outgoing',
    preferences: [preference('channel-a', 'outgoing', false)],
});
    await repairCase('repair_incoming_deleted_absent', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'incoming')],
});
    await repairCase('repair_incoming_deleted_zero', {
    direction: 'incoming',
    preferences: [preference('channel-a', 'incoming', 0)],
});

// --- notification admission ----------------------------------------------
    await acceptsCase('accepts_incoming_default_no_rows', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
});
    await acceptsCase('accepts_undefined_condition_is_incoming', {
    condition: undefined,
    event: event(undefined, 'channel-a'),
});
    await acceptsCase('accepts_outgoing_default_no_rows', {
    condition: condition('channel-a'),
    event: event('channel-a'),
});
    await acceptsCase('accepts_incoming_remote_id_without_config', {
    id: 'remote-1',
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
});
    await acceptsCase('accepts_outgoing_remote_id_without_config', {
    id: 'remote-1',
    condition: condition('channel-a'),
    event: event('channel-a'),
});
    await acceptsCase('accepts_deleted_incoming_skips_config', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    preferences: [preference('channel-a', 'incoming', true)],
    eventsubs: [config('channel-a', 'incoming', true, 'remote-1')],
});
    await acceptsCase('accepts_deleted_outgoing_skips_config', {
    condition: condition('channel-a'),
    event: event('channel-a'),
    preferences: [preference('channel-a', 'outgoing', true)],
    eventsubs: [config('channel-a', 'outgoing', true, 'remote-1')],
});
    await acceptsCase('accepts_active_preference_incoming', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    preferences: [preference('channel-a', 'incoming', false)],
});
    await acceptsCase('accepts_active_preference_outgoing', {
    condition: condition('channel-a'),
    event: event('channel-a'),
    preferences: [preference('channel-a', 'outgoing', false)],
});
    await acceptsCase('accepts_incoming_config_enabled_id_match', {
    id: 'remote-1',
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-a', 'incoming', true, 'remote-1')],
});
    await acceptsCase('accepts_incoming_config_enabled_no_id', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-a', 'incoming', true, 'remote-1')],
});
    await acceptsCase('accepts_incoming_config_enabled_absent', {
    id: 'remote-1',
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-a', 'incoming', undefined, 'remote-1')],
});
    await acceptsCase('accepts_incoming_config_remote_id_mismatch', {
    id: 'remote-2',
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-a', 'incoming', true, 'remote-1')],
});
    await acceptsCase('accepts_incoming_config_missing_id_with_subscription_id', {
    id: 'remote-1',
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-a', 'incoming', true)],
});
    await acceptsCase('accepts_incoming_config_disabled', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-a', 'incoming', false, 'remote-1')],
});
    await acceptsCase('accepts_incoming_config_for_other_channel', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    eventsubs: [config('channel-b', 'incoming', true, 'remote-1')],
});
    await acceptsCase('accepts_outgoing_ignores_incoming_config', {
    condition: condition('channel-a'),
    event: event('channel-a'),
    eventsubs: [config('channel-a', 'incoming', true, 'remote-1')],
});
    await acceptsCase('accepts_outgoing_config_enabled_id_match', {
    id: 'remote-1',
    condition: condition('channel-a'),
    event: event('channel-a'),
    eventsubs: [config('channel-a', 'outgoing', true, 'remote-1')],
});
    await acceptsCase('accepts_outgoing_config_disabled', {
    condition: condition('channel-a'),
    event: event('channel-a'),
    eventsubs: [config('channel-a', 'outgoing', false, 'remote-1')],
});
    await acceptsCase('accepts_condition_from_and_empty_to_is_outgoing', {
    condition: condition('channel-a', ''),
    event: event('channel-a'),
});
    await acceptsCase('accepts_condition_both_fields_is_incoming', {
    condition: condition('channel-a', 'channel-b'),
    event: event(undefined, 'channel-a'),
});
    await acceptsCase('accepts_missing_event_channel', {
    condition: condition(undefined, 'channel-a'),
    event: {},
});
    await acceptsCase('accepts_empty_event_channel', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, ''),
});
    await acceptsCase('accepts_false_event_channel', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, false),
});
    await acceptsCase('accepts_zero_event_channel', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 0),
});
    await acceptsCase('accepts_numeric_event_channel_is_stringified', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 42),
    eventsubs: [config('42', 'incoming', true, 'remote-1')],
});

// Error ordering: a preference read failure prevents the remote lookup, and a
// remote lookup failure surfaces after the deletion probe succeeded.
    await acceptsCase('accepts_preference_error_skips_config', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    fail: 'preferences',
});
    await acceptsCase('accepts_config_error_after_clean_probe', {
    condition: condition(undefined, 'channel-a'),
    event: event(undefined, 'channel-a'),
    fail: 'eventsubs',
});
    await deletedCase('deleted_error_propagates', {direction: 'incoming', preferences: [], fail: 'preferences'});
    await repairCase('repair_error_propagates', {direction: 'incoming', preferences: [], fail: 'preferences'});
}

// --- output ---------------------------------------------------------------
async function main() {
    await collect();
    const mode = process.argv[2];
    const directory = process.argv[3];
    assert(mode === '--write' || mode === '--check', 'usage: <--write|--check> <absolute-dir>');
    assert(path.isAbsolute(directory), 'fixture directory must be absolute');
    if (mode === '--write') assert.equal(fs.readdirSync(directory).length, 0, 'write directory must be empty');

    const output = `${JSON.stringify({
        schema: 1,
        provenance: {
            node: process.versions.node,
            typescript: ts.version,
            mongoose: mongoose.version,
            bson: bsonVersion,
            sources: {
                [sources.subscriptions]: sha(sources.subscriptions),
                [sources.preferenceSchema]: sha(sources.preferenceSchema),
                [sources.archivedEventsub]: sha(sources.archivedEventsub),
                [sources.archivedDirection]: sha(sources.archivedDirection),
            },
            oracleSha256: sha(sources.oracle),
        },
        boundaries: {
            direction: 'src/utils/raid_direction.ts is retired; the preserved archived source is loaded, and the native port reuses utils::eventsub::raid_direction_value',
            eventsubSchema: 'src/schemas/eventsub.schema.ts is retired; the preserved archived source builds the real model, and Model.findOne is a recorder with an in-memory matcher',
            preferenceSchema: 'src/schemas/raid_subscription_preference.schema.ts is live; exists/findById are recorders with the Mongoose 8 existence/lean contract',
            storage: 'no driver is contacted; preference and eventsub rows are in-memory JSON documents',
            projections: 'the source projection string `enabled id` is recorded verbatim; the native projection is {enabled:1,id:1}',
        },
        constants: {
            eventType: 'channel.raid',
            maxTimeMS: 1500,
            configProjection: 'enabled id',
            existenceProjection: {_id: 1},
            defaultIncoming: true,
        },
        cases,
    }, null, 2)}\n`;

    const target = path.join(directory, 'raid-subscriptions-reference.json');
    if (mode === '--write') {
        fs.writeFileSync(target, output, {flag: 'wx'});
    } else {
        assert.equal(fs.readFileSync(target, 'utf8'), output, 'fixture differs');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
