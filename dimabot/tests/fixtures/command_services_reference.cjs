'use strict';
// Actual-source oracle for the command-defaults and command-blocks services.
// Run only in the pinned isolated Node/TypeScript toolchain:
//   node tests/fixtures/command_services_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/command_services_reference.cjs --check <absolute-dir>
//
// It transpiles and executes the real
//   src/server/services/command_defaults.service.ts
//   src/server/services/command_blocks.service.ts
//   src/utils/command_cooldown_write.ts
// against the real Commands/Users Mongoose schemas on a disconnected mongoose
// instance, an in-memory Redis, and in-memory model persistence. It never
// contacts a database, cache, Twitch endpoint or network.
//
// Boundaries (each one is recorded in the output's `boundaries` field):
// * `src/utils/command_cooldown.ts` was retired from the TypeScript tree after
//   its native port; the one-symbol `getMinimumCommandCooldown` policy is
//   supplied here verbatim (pro/premium/otherwise -> 1/3/5) so the real
//   `command_cooldown_write.ts` can load.
// * `src/utils/ast_blocks/` was retired after its native port and its own
//   parity suite. `compileBlocks`/`storedBlocks`/`MAX_COMMAND_TEXT`/
//   `BlocksError` are supplied by a stand-in that only reproduces the two
//   error messages used here plus an echo compile of one canonical literal
//   tree. Block compilation itself is NOT compared by this fixture.
// * `TwitchStreamers.getTwitchAccountById` and `getDragonflyClient` are
//   in-memory doubles, and the Commands model persists through a replaced
//   `collection.insertOne`. The REPLACEMENT ONLY CAPTURES; the save pipeline
//   above it is Mongoose's real one, so the recorded document is exactly the
//   BSON Mongoose would send (minimized `toObject` plus `__v`). No driver is
//   contacted.
//
// `TZ` is forced to UTC and asserted, because the schema's `date.day/month/year`
// defaults use local calendar fields; the native replay must run with TZ=UTC.

process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');

const root = fs.realpathSync(process.env.DIMA_COMMAND_SERVICES_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const mongoose = local('mongoose');
const bsonRequire = Module.createRequire(local.resolve('mongoose'));
const BSON = bsonRequire('bson');
const bsonVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(bsonRequire.resolve('bson')), '..', 'package.json'), 'utf8')).version;

assert.equal(process.versions.node, '24.22.1');
assert.equal(ts.version, '5.9.3');
assert.equal(mongoose.version, '8.24.2');
assert.equal(bsonVersion, '6.10.4');
assert.equal(new Date().getTimezoneOffset(), 0, 'the oracle requires TZ=UTC');

const FIXED_NOW = '2026-03-15T12:00:00.000Z';
const FIXED_TIME = new Date(FIXED_NOW);
const CATALOG_SIZE = 38;

const sources = {
    defaults: 'src/server/services/command_defaults.service.ts',
    blocks: 'src/server/services/command_blocks.service.ts',
    defaultsTest: 'src/server/services/command_defaults.service.test.ts',
    commandsSchema: 'src/schemas/commands.schema.ts',
    availabilitySchema: 'src/utils/availability/schema.ts',
    cooldownWrite: 'src/utils/command_cooldown_write.ts',
    reserved: 'src/config/commands/reservedcommands.json',
    oracle: 'tests/fixtures/command_services_reference.cjs',
};
const pinned = {
    defaults: '166e40f9d70c6bd7850d61d2264ed391306f283364a4f64984d1193a4294ae6c',
    blocks: '878fb7ad269ee8bb5b39ab275058ad1b023d2ec9886052c2940098139d5fc271',
    defaultsTest: '388f4c26bd53b3796c78149a50bfa2842ffa5f41c446e88cba403ad3c64dd0b2',
    commandsSchema: '1a6ed070b37a850b9d358a86b2f97ff0a5e6b977f41ac7b51f2b01e0d9bb7da3',
    availabilitySchema: '98785af1992534d8d723cd429626d4da268aa8bf41023b3e12b01b2bdc4a2b26',
    cooldownWrite: 'efbcf9f1a83b32022b521a46c109acb13b0e4da68cb26970e3d2c15a21d39586',
    reserved: 'd29255d7a1efea936734a80aa6d513f31833b26ef054d307f234885835b69c57',
};
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

// Frozen clock installed after the Mongoose schemas are defined (a subclass of
// Date would not resolve as a schema type) and before any case runs. It fixes
// the service's `new Date()` and the schema's local-calendar defaults.
const RealDate = Date;
function freezeClock() {
    class FrozenDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(FIXED_TIME.getTime());
            else super(...args);
        }
        static now() { return FIXED_TIME.getTime(); }
    }
    global.Date = FrozenDate;
}

// --- module loader -------------------------------------------------------
const cache = new Map();
// The JSON import assertion cannot survive a CommonJS emit, so it is stripped
// before transpilation. The pinned digest still covers the original source.
const sourceOverrides = {
    [sources.defaults]: text => text.replace(/\s*with\s*\{\s*type:\s*'json'\s*\}/, ''),
};
function compile(file) {
    const source = sourceOverrides[file] ? sourceOverrides[file](read(file)) : read(file);
    const result = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    });
    assert(!result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error), `${file} failed to transpile`);
    return result.outputText;
}
function load(file, resolve) {
    const record = {exports: {}};
    new Function('require', 'module', 'exports', '__filename', compile(file))(resolve, record, record.exports, path.join(root, file));
    cache.set(file, record.exports);
    return record.exports;
}

// --- mutable case state --------------------------------------------------
const state = {
    rows: [],
    leases: new Map(),
    planTier: 'free',
    planOwner: null,
    planReads: 0,
    defaultsPlanReads: 0,
    leaseOps: [],
    failOn: null,
};

function reset(overrides) {
    state.rows = [];
    state.leases = new Map();
    state.planTier = 'free';
    state.planOwner = null;
    state.planReads = 0;
    state.defaultsPlanReads = 0;
    state.leaseOps = [];
    state.failOn = null;
    Object.assign(state, overrides || {});
}

// --- real Commands schema on a disconnected mongoose instance ------------
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
    if (id === 'node:crypto') return crypto;
    throw Error(`unexpected schema import ${id}`);
}
const availability = load(sources.availabilitySchema, mongooseResolve);
const commandsSchemaApi = load(sources.commandsSchema, id => {
    if (id === '../utils/availability/schema.js') return availability;
    return mongooseResolve(id);
});
const RealCommands = commandsSchemaApi.CommandsSchema;

function matches(row, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        const actual = row[key];
        if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof RealDate)) {
            if ('$ne' in expected) return String(actual) !== String(expected.$ne);
            throw Error(`unsupported operator in ${key}`);
        }
        return String(actual) === String(expected);
    });
}

// The real Mongoose save path calls `Model.collection.insertOne(obj)`, where
// `obj` is the minimized `toObject` payload plus `__v`. Replacing only that
// store call records the exact persisted BSON and still exercises Mongoose's
// defaults, casting, validation, versioning and error handling.
async function interceptInsertOne(document) {
    // Yield once so two concurrent seeders pass their existence check first.
    await Promise.resolve();
    if (state.failOn && state.failOn.func === document.func) {
        const failure = state.failOn;
        state.failOn = null;
        const error = new Error(failure.message || 'injected save failure');
        if (failure.code) error.code = failure.code;
        throw error;
    }
    if (state.rows.some(row => String(row._id) === String(document._id))) {
        const error = new Error('E11000 duplicate key error');
        error.code = 11000;
        throw error;
    }
    state.rows.push(document);
    return {acknowledged: true, insertedId: document._id};
}
RealCommands.collection.insertOne = interceptInsertOne;
RealCommands.exists = async filter => (state.rows.some(row => matches(row, filter)) ? {_id: true} : null);

// --- in-memory boundaries -------------------------------------------------
const redisDouble = {
    async set(key, token, options) {
        state.leaseOps.push({op: 'set', key, ttl: options?.EX ?? null, nx: options?.NX === true});
        if (options?.NX && state.leases.has(key)) return null;
        state.leases.set(key, token);
        return 'OK';
    },
    async eval(script, options) {
        const key = options.keys[0];
        const token = options.arguments[0];
        const released = state.leases.get(key) === token;
        state.leaseOps.push({op: 'eval', key, released});
        if (released) state.leases.delete(key);
        return released ? 1 : 0;
    },
};
const streamersDouble = {
    getTwitchAccountById: async () => {
        state.defaultsPlanReads += 1;
        return state.planTier === null ? null : {plan_tier: state.planTier};
    },
};
const usersDouble = {
    findOne: () => {
        state.planReads += 1;
        return {
            select() { return this; },
            maxTimeMS() { return this; },
            async lean() { return state.planOwner; },
        };
    },
};
class BlocksErrorStandIn extends Error {
    constructor(message, blockId) {
        super(message);
        this.name = 'BlocksError';
        this.blockId = blockId;
    }
}
const astBlocksStandIn = {
    MAX_COMMAND_TEXT: 10000,
    BlocksError: BlocksErrorStandIn,
    compileBlocks(input) {
        if (!input || typeof input !== 'object' || !Array.isArray(input.children)) {
            throw new BlocksErrorStandIn('The block tree is missing or broken.');
        }
        const literal = input.children.every(child => child && child.type === 'literal' && typeof child.value === 'string');
        assert(literal, 'this oracle only compiles literal trees');
        return {root: input, text: input.children.map(child => child.value).join('')};
    },
    storedBlocks(root) {
        return {v: 1, root};
    },
};

const cooldown = load(sources.cooldownWrite, id => {
    if (id === '../schemas/commands.schema.js') return {CommandsSchema: RealCommands};
    if (id === '../classes/twitch_streamers.class.js') return {__esModule: true, default: streamersDouble};
    if (id === './databases/dragonfly.database.js') return {getDragonflyClient: async () => redisDouble};
    if (id === './command_cooldown.js') {
        return {getMinimumCommandCooldown: plan => (plan === 'pro' ? 1 : plan === 'premium' ? 3 : 5)};
    }
    throw Error(`unexpected cooldown import ${id}`);
});
const defaultsApi = load(sources.defaults, id => {
    if (id === '../../utils/command_cooldown_write.js') return cooldown;
    if (id === '../../schemas/commands.schema.js') return {CommandsSchema: RealCommands};
    if (id === '../../config/commands/reservedcommands.json') return JSON.parse(read(sources.reserved));
    if (id === 'mongoose') return mongoose;
    if (id === 'node:crypto') return crypto;
    throw Error(`unexpected defaults import ${id}`);
});
const blocksApi = load(sources.blocks, id => {
    if (id === '../../schemas/users.schema.js') return {__esModule: true, default: usersDouble};
    if (id === '../../utils/ast_blocks/index.js') return astBlocksStandIn;
    throw Error(`unexpected blocks import ${id}`);
});

// --- helpers --------------------------------------------------------------
// Rows are the exact objects Mongoose passed to `collection.insertOne`, so
// their BSON is the persisted document (minimized `toObject` plus `__v`).
function hex(value) {
    return BSON.serialize(value).toString('hex');
}
const slim = entry => (entry ? {name: entry.name, cmd: entry.cmd, func: entry.func} : null);
function requestError(error) {
    return {
        ok: false,
        status: error.status,
        code: error.code,
        message: error.message,
        blockId: error.blockId ?? null,
        request: error instanceof blocksApi.CommandBlocksRequestError,
    };
}

// --- cases ----------------------------------------------------------------
const cases = [];
const record = (name, kind, input, expect, extra) => cases.push({name, kind, input, expect, replay: 'native', ...(extra || {})});

function reservedCases() {
    const catalog = defaultsApi.getReservedCommandsPayload();
    assert.equal(catalog.commands.length, CATALOG_SIZE);
    record('reserved_payload_raw', 'defaults-pure', {language: null}, {payload: catalog});
    record('reserved_payload_es', 'defaults-pure', {language: 'es'}, {payload: defaultsApi.getReservedCommandsPayload('es')});
    record('reserved_payload_fr', 'defaults-pure', {language: 'fr'}, {payload: defaultsApi.getReservedCommandsPayload('fr')});
    record('reserved_payload_empty_language', 'defaults-pure', {language: ''}, {payload: defaultsApi.getReservedCommandsPayload('')});

    for (const [name, command] of [
        ['reserved_definition_func', {func: 'shoutout', cmd: 'zzz'}],
        ['reserved_definition_cmd', {func: 'zzz', cmd: 'so'}],
        ['reserved_definition_func_precedence', {func: 'shoutout', cmd: 'anuncio'}],
        ['reserved_definition_cmd_only', {func: '', cmd: 'ruletarusa'}],
        ['reserved_definition_missing', {func: 'nope', cmd: 'nope'}],
    ]) {
        record(name, 'defaults-pure', command, {definition: slim(defaultsApi.getReservedCommandDefinition(command))});
    }

    for (const [name, command, language, fallback] of [
        ['reserved_description_en', {func: 'anuncio'}, null, 'fallback'],
        ['reserved_description_es', {func: 'anuncio'}, 'es', 'fallback'],
        ['reserved_description_trimmed', {func: 'anuncio'}, ' ES ', 'fallback'],
        ['reserved_description_unknown_language', {func: 'anuncio'}, 'fr', 'fallback'],
        ['reserved_description_missing_definition', {func: 'nope'}, 'es', 'fallback'],
        ['reserved_description_empty_fallback', {func: 'nope'}, 'es', ''],
    ]) {
        record(name, 'defaults-pure', {command, language, fallback},
            {description: defaultsApi.getLocalizedReservedCommandDescription(command, language, fallback)});
    }

    for (const language of [undefined, null, '', 'es', 'ES', ' en ', 'fr']) {
        record(`normalize_language_${language === undefined ? 'undefined' : JSON.stringify(language)}`, 'defaults-pure',
            {language: language === undefined ? null : language},
            {language: defaultsApi.normalizeSupportedLanguage(language)});
    }
}

async function seedCase(name, seed, options) {
    const {replay = 'native', scenario = null} = options || {};
    reset({failOn: seed.failOn || null});
    if (options && 'planTier' in options) state.planTier = options.planTier;
    const channelID = `oracle-${name}`;
    const seedRows = (seed.rows || []).map(row => ({channelID, activation: 'command', ...row}));
    state.rows.push(...seedRows);
    if (seed.lease) state.leases.set(seed.lease, 'incumbent-token');
    let expect;
    try {
        const created = await defaultsApi.ensureReservedCommands(channelID, 'oracle');
        expect = {ok: true, created, docsHex: state.rows.map(hex)};
    } catch (error) {
        expect = {
            ok: false,
            error: error.message,
            errorKind: error.code === 11000 ? 'duplicate' : 'other',
            docsHex: state.rows.map(hex),
        };
    }
    record(name, 'defaults-seed', {
        channelID,
        channelName: 'oracle',
        seedHex: seedRows.map(hex),
        leaseKey: seed.lease || null,
        planTier: state.planTier,
        scenario,
    }, expect, {replay, observe: {planReads: state.defaultsPlanReads, leaseOps: state.leaseOps}});
}

async function concurrentCase() {
    reset({planTier: 'premium'});
    const channelID = 'oracle-defaults_concurrent';
    const counts = await Promise.all([
        defaultsApi.ensureReservedCommands(channelID, 'oracle'),
        defaultsApi.ensureReservedCommands(channelID, 'oracle'),
    ]);
    const duplicates = [...state.rows.reduce((counts, row) => counts.set(row.func, (counts.get(row.func) || 0) + 1), new Map())]
        .filter(([, count]) => count > 1)
        .map(([func]) => func);
    record('defaults_concurrent_seed', 'defaults-seed', {channelID, channelName: 'oracle', seedHex: [], leaseKey: null, planTier: state.planTier, scenario: null},
        {ok: true, created: counts[0] + counts[1], count: state.rows.length, duplicateFunctions: duplicates},
        {observe: {planReads: state.defaultsPlanReads, leaseOps: state.leaseOps}});
}

async function main() {
    const mode = process.argv[2];
    const directory = process.argv[3];
    if (!['--write', '--check'].includes(mode) || !directory) {
        throw Error('usage: --write <absolute-empty-dir> | --check <absolute-dir>');
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
        throw Error('canonical directory required');
    }
    for (const [key, file] of Object.entries(sources)) {
        if (key === 'oracle') continue;
        assert.equal(sha(file), pinned[key], `${file} changed`);
    }

    freezeClock();
    reservedCases();

    await seedCase('defaults_fresh_channel', {});
    await seedCase('defaults_plan_pro_account', {}, {planTier: 'pro'});
    await seedCase('defaults_plan_missing_account', {}, {planTier: null});
    await seedCase('defaults_existing_custom_command', {
        rows: [{_id: new mongoose.Types.ObjectId('64b000000000000000000001'), func: 'duel', cmd: 'duel', reserved: false, cooldown: 10}],
    });
    await seedCase('defaults_zero_slot_conflict', {
        rows: [{_id: new mongoose.Types.ObjectId('64b000000000000000000002'), func: 'my-custom', cmd: 'mine', reserved: false, cooldown: 0}],
    });
    await seedCase('defaults_lease_contended', {lease: 'command-cooldown-write:oracle-defaults_lease_contended'});
    // A keyword-activation row with the same `func` is invisible to the
    // existence probe, so the first catalog insert collides on a unique `func`
    // index. The duplicate re-check then looks for the generated `_id` and
    // finds nothing, which must re-throw.
    await seedCase('defaults_duplicate_without_row', {
        rows: [{_id: new mongoose.Types.ObjectId('64b000000000000000000003'), func: 'ruletarusa', cmd: 'ruletarusa', activation: 'keyword', reserved: true, cooldown: 10}],
        failOn: {func: 'ruletarusa', code: 11000},
    }, {scenario: 'unique_func_index'});
    // The collection rejects every insert, so the first write fails with a
    // non-duplicate error and nothing is stored.
    await seedCase('defaults_non_duplicate_save_failure', {
        failOn: {func: 'ruletarusa', message: 'injected write failure'},
    }, {scenario: 'collection_validator'});
    await concurrentCase();

    // Blocks: plan read, presentation and the body resolver.
    const planCases = [];
    for (const [name, owner] of [
        ['blocks_plan_free', {plan_tier: 'free'}],
        ['blocks_plan_premium', {plan_tier: 'premium'}],
        ['blocks_plan_pro', {plan_tier: 'pro'}],
        ['blocks_plan_missing_owner', null],
        ['blocks_plan_unknown_tier', {plan_tier: 'gold'}],
    ]) {
        reset({planOwner: owner});
        const plan = await blocksApi.channelPlanTier('oracle-plan');
        planCases.push({name, kind: 'blocks-plan', replay: 'native', input: {owner}, expect: {ok: true, plan, planReads: state.planReads}});
    }
    cases.push(...planCases);

    const presentInputs = [
        ['present_text_command', {name: 'a', authoring: 'text', message: 'hi', blocks: {v: 1, root: {type: 'root', id: 'root', children: []}}}],
        ['present_text_without_authoring', {name: 'b', message: 'hi'}],
        ['present_unknown_authoring', {name: 'c', authoring: 'legacy', message: 'hi', blocks: {v: 1, root: {}}}],
        ['present_blocks_hidden', {name: 'd', authoring: 'blocks', message: 'compiled', blocks: {v: 1, root: {type: 'root', id: 'root', children: []}}}],
    ];
    for (const [name, command] of presentInputs) {
        const plain = JSON.parse(JSON.stringify(command));
        cases.push({name, kind: 'blocks-pure', replay: 'native', input: {command: plain, options: {blocks: false}},
            expect: {output: blocksApi.presentCommand(plain)}});
    }
    const blockCommand = {name: 'd', authoring: 'blocks', message: 'compiled', blocks: {v: 1, root: {type: 'root', id: 'root', children: []}}};
    cases.push({name: 'present_blocks_included', kind: 'blocks-pure', replay: 'native', input: {command: blockCommand, options: {blocks: true}},
        expect: {output: blocksApi.presentCommand(JSON.parse(JSON.stringify(blockCommand)), {blocks: true})}});

    const literalTree = {type: 'root', id: 'root', children: [{type: 'literal', id: 's1', value: 'hi'}]};
    const resolveInputs = [
        ['resolve_settings_only_block_body', {authoring: 'blocks'}, {authoring: 'blocks', reserved: false}, 'premium'],
        ['resolve_blocks_reserved', {authoring: 'blocks', blocks: literalTree}, {authoring: 'text', reserved: true}, 'pro'],
        ['resolve_blocks_free_plan', {authoring: 'blocks', blocks: literalTree}, {authoring: 'text', reserved: false}, 'free'],
        ['resolve_blocks_literal_tree', {authoring: 'blocks', blocks: literalTree}, {authoring: 'text', reserved: false}, 'premium'],
        ['resolve_blocks_missing_tree', {authoring: 'blocks'}, {authoring: 'text', reserved: false}, 'premium'],
        ['resolve_switch_to_text', {authoring: 'text', message: 'hi'}, {authoring: 'blocks', reserved: false}, 'premium'],
        ['resolve_switch_missing_message', {authoring: 'text'}, {authoring: 'blocks', reserved: false}, 'premium'],
        ['resolve_switch_blank_message', {authoring: 'text', message: '   '}, {authoring: 'blocks', reserved: false}, 'premium'],
        ['resolve_plain_text', {authoring: 'text', message: 'hi'}, null, 'free'],
        ['resolve_message_only', {message: 'hi'}, null, 'free'],
        ['resolve_settings_only_text', {}, {authoring: 'blocks', reserved: false}, 'premium'],
        ['resolve_message_at_limit', {authoring: 'text', message: 'x'.repeat(10000)}, null, 'free'],
        ['resolve_too_long_message', {authoring: 'text', message: 'x'.repeat(10001)}, null, 'free'],
        ['resolve_too_long_utf16', {authoring: 'text', message: '\u{1f600}'.repeat(5001)}, null, 'free'],
    ];
    for (const [name, body, current, plan] of resolveInputs) {
        reset({planOwner: {plan_tier: plan}});
        let expect;
        try {
            const output = await blocksApi.resolveCommandBody('oracle-body', body, current);
            expect = {ok: true, output, planReads: state.planReads};
        } catch (error) {
            expect = {...requestError(error), planReads: state.planReads};
        }
        cases.push({name, kind: 'blocks-resolve', replay: 'native', input: {body, current, owner: {plan_tier: plan}}, expect});
    }

    global.Date = RealDate;

    const output = `${JSON.stringify({
        schema: 1,
        provenance: {
            node: process.versions.node,
            typescript: ts.version,
            mongoose: mongoose.version,
            bson: bsonVersion,
            sources: Object.fromEntries(Object.entries(pinned).map(([key, digest]) => [sources[key], digest])),
            oracleSha256: sha(sources.oracle),
        },
        boundaries: {
            cooldownPolicy: 'src/utils/command_cooldown.ts is retired; getMinimumCommandCooldown is supplied verbatim',
            astBlocks: 'src/utils/ast_blocks is retired; compileBlocks/storedBlocks/MAX_COMMAND_TEXT/BlocksError are stand-ins',
            storage: 'Commands persistence is the real Mongoose save pipeline with collection.insertOne replaced by a recorder; TwitchStreamers and Dragonfly are in-memory doubles',
            timezone: 'TZ=UTC is required; date.day/month/year defaults are local calendar fields',
            jsonImport: 'the JSON import assertion is stripped before the CommonJS emit; the pinned digest is of the original source',
            savedDocuments: 'docsHex is the exact object passed to collection.insertOne, i.e. the minimized toObject payload plus __v that Mongoose persists',
            saveErrors: 'the two write-error cases are replayed natively with a unique func index and a collection validator; their recorded messages are source-side evidence only',
        },
        constants: {
            fixedNow: FIXED_NOW,
            namespace: 'dimabot:default-command:v1',
            maxCommandText: 10000,
            catalogSize: CATALOG_SIZE,
            duplicateKeyCode: 11000,
        },
        cases,
    }, null, 2)}\n`;
    const target = path.join(directory, 'command-services-reference.json');
    if (mode === '--write') {
        if (fs.readdirSync(directory).length) throw Error('write directory must be empty');
        fs.writeFileSync(target, output, {flag: 'wx'});
    } else if (fs.readFileSync(target, 'utf8') !== output) {
        throw Error('fixture differs');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
