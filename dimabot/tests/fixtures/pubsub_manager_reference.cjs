'use strict';
// Actual-source oracle for the Pub/Sub manager.
// Run only in the pinned isolated Node/TypeScript toolchain:
//   node tests/fixtures/pubsub_manager_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/pubsub_manager_reference.cjs --check <absolute-dir>
//
// It transpiles and executes the real `src/classes/pubsub_manager.class.ts` with
// three doubles and never opens a socket:
//
// * `redis` is replaced by an in-memory client pair. `duplicate()` returns a
//   fresh client on one shared bus, `subscribe(channel, listener)` reproduces
//   `@redis/client`'s behaviour of issuing SUBSCRIBE only for the first listener
//   on a channel and merely attaching later listeners, and `deliver()` invokes
//   each attached listener as `(message, channel)`. This mirrors
//   `node_modules/@redis/client/dist/lib/client/pub-sub.js` `subscribe`
//   (lines 64-77) and `#emitPubSubMessage` (lines 345-347) of the pinned
//   5.12.1 build.
// * `getDragonflyClient` returns that client pair and records its caller label.
// * `../utils/logger.js` records every `error`/`info` call with its payload and
//   options.
//
// `Date.now()` is frozen, so the appended `timestamp` is deterministic.
//
// Boundary recorded in the output: the real `@redis/client` 5.12.1 build never
// emits a client-level `'message'` event (the only `'message'` occurrence in
// `dist/lib` is the protocol command name at `pub-sub.js:18`), so the source's
// `subscriber.on('message', this.handleMessage.bind(this))` listener is dead
// code. `handleMessage` is therefore exercised by a direct call, which is the
// only way its `try/catch` can run.

process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');

const root = fs.realpathSync(
    process.env.DIMA_PUBSUB_MANAGER_SOURCE_ROOT || path.resolve(__dirname, '../..')
);
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const redisVersion = JSON.parse(fs.readFileSync(local.resolve('redis/package.json'), 'utf8')).version;
const clientRequire = Module.createRequire(local.resolve('redis/package.json'));
const clientVersion = JSON.parse(
    fs.readFileSync(clientRequire.resolve('@redis/client/package.json'), 'utf8')
).version;

assert.equal(process.versions.node, '24.22.1');
assert.equal(ts.version, '5.9.3');
assert.equal(redisVersion, '5.12.1');
assert.equal(clientVersion, '5.12.1');

const FIXED_NOW = 1767323045000;
const CLIP_TEMPLATE = 'twitch:{}:clip:request';

const sources = {
    manager: 'src/classes/pubsub_manager.class.ts',
    oracle: 'tests/fixtures/pubsub_manager_reference.cjs',
};
const pinned = {
    manager: '809861004ff6f9c53e32a44098ff3f8d63348f49eab976abe57ccf0b763ecc88',
};
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

const RealDate = Date;
function freezeClock() {
    class FrozenDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(FIXED_NOW);
            else super(...args);
        }
        static now() {
            return FIXED_NOW;
        }
    }
    global.Date = FrozenDate;
}

// --- module loader -------------------------------------------------------
const cache = new Map();
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
        !result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error),
        `${file} failed to transpile`
    );
    return result.outputText;
}
function load(file, resolve, fresh) {
    if (!fresh && cache.has(file)) return cache.get(file);
    const record = { exports: {} };
    new Function('require', 'module', 'exports', '__filename', compile(file))(
        resolve,
        record,
        record.exports,
        path.join(root, file)
    );
    cache.set(file, record.exports);
    return record.exports;
}

// --- mutable case state --------------------------------------------------
const state = {
    base: null,
    duplicates: 0,
    connects: 0,
    published: [],
    logs: [],
    dragonflyCallers: [],
    bus: new Map(),
    failOn: null,
    messageListeners: 0,
};

function reset() {
    state.base = makeClient('base');
    state.duplicates = 0;
    state.connects = 0;
    state.published = [];
    state.logs = [];
    state.dragonflyCallers = [];
    state.bus = new Map();
    state.failOn = null;
    state.messageListeners = 0;
}

function channelState(channel) {
    let entry = state.bus.get(channel);
    if (!entry) {
        entry = { listeners: new Set(), commands: 0 };
        state.bus.set(channel, entry);
    }
    return entry;
}

function busSnapshot(channel) {
    const entry = state.bus.get(channel);
    return entry
        ? { listeners: entry.listeners.size, commands: entry.commands }
        : { listeners: 0, commands: 0 };
}

function deliver(channel, message) {
    const entry = state.bus.get(channel);
    if (!entry) return;
    for (const listener of entry.listeners) listener(message, channel);
}

function makeClient(role) {
    const listeners = new Map();
    const client = {
        role,
        connected: false,
        on(event, listener) {
            const list = listeners.get(event) || [];
            list.push(listener);
            listeners.set(event, list);
            if (event === 'message') state.messageListeners += 1;
            return client;
        },
        async connect() {
            if (state.failOn === 'connect') throw Error('connect failed');
            client.connected = true;
            state.connects += 1;
        },
        duplicate() {
            state.duplicates += 1;
            return makeClient(`${role}:duplicate`);
        },
        async publish(channel, message) {
            if (state.failOn === 'publish') throw Error('publish failed');
            if (!client.connected) throw Error('The client is closed');
            state.published.push({ channel, message });
            deliver(channel, message);
            return 1;
        },
        async subscribe(channel, listener) {
            if (state.failOn === 'subscribe') throw Error('subscribe failed');
            const entry = channelState(channel);
            // @redis/client issues SUBSCRIBE only when the channel has no
            // listener yet; later listeners are attached locally.
            if (entry.listeners.size === 0) entry.commands += 1;
            entry.listeners.add(listener);
        },
        async unsubscribe(channel) {
            if (state.failOn === 'unsubscribe') throw Error('unsubscribe failed');
            state.bus.delete(channel);
        },
    };
    return client;
}

const loggerDouble = {
    async error(payload, options) {
        state.logs.push({ level: 'error', payload, options });
    },
    async info(payload, options) {
        state.logs.push({ level: 'info', payload, options });
    },
};

function resolveManager(id) {
    if (id === 'redis') {
        return {
            createClient() {
                throw Error('createClient is never used by the manager');
            },
        };
    }
    if (id === '../utils/databases/dragonfly.database.js') {
        return {
            async getDragonflyClient(caller) {
                state.dragonflyCallers.push(caller);
                return state.base;
            },
        };
    }
    if (id === '../utils/logger.js') return loggerDouble;
    throw Error(`unexpected manager import ${id}`);
}

function manager() {
    return load(sources.manager, resolveManager, true).pubSubManager;
}

// --- cases ----------------------------------------------------------------
const cases = [];
const record = (name, kind, input, expect) =>
    cases.push({ name, kind, input, expect, replay: 'native' });
const recordSource = (name, kind, input, expect) =>
    cases.push({ name, kind, input, expect, replay: 'source-only' });

async function publishCase(name, data) {
    reset();
    await manager().publish('oracle:publish', data);
    const sent = state.published.at(-1);
    record(
        name,
        'publish-payload',
        { dataJson: JSON.stringify(data), timestamp: FIXED_NOW },
        { channel: sent.channel, payload: sent.message }
    );
}

async function publishCases() {
    await publishCase('publish_object_fields_then_timestamp', { channelID: '123', session: 'abc' });
    await publishCase('publish_existing_timestamp_keeps_its_position', {
        timestamp: 1,
        channelID: '123',
    });
    await publishCase('publish_nested_and_scalar_fields', {
        clipID: 'c1',
        nested: { a: [1, 2, 'x'], b: null },
        flag: true,
        nothing: null,
    });
    await publishCase('publish_empty_object', {});
    await publishCase('publish_array_spread', ['a', 'b']);
    await publishCase('publish_string_spread', 'ab');
    await publishCase('publish_null_spread', null);
    await publishCase('publish_number_spread', 42);
    await publishCase('publish_undefined_fields_are_dropped', { a: undefined, b: 1 });
    await publishCase('publish_escapes_quotes_and_controls', { text: 'a"b\\c\nd\te\u0001' });
    await publishCase('publish_unicode_and_surrogate_pair', { text: 'caf\u00e9 \ud83d\ude00' });
    await publishCase('publish_lone_surrogate', { text: '\ud800' });
    await publishCase('publish_mixed_key_order', { b: 1, 2: 'two', a: 2, 1: 'one' });
}

function clipCases() {
    for (const [name, channelID] of [
        ['clip_channel_numeric', '123'],
        ['clip_channel_colon', 'a:b'],
        ['clip_channel_empty', ''],
        ['clip_channel_braces', '{}'],
    ]) {
        record(name, 'clip-channel', { channelID }, { channel: `twitch:${channelID}:clip:request` });
    }
}

async function subscribeCases() {
    reset();
    let first = 0;
    const one = manager();
    await one.subscribe('oracle:single', () => {
        first += 1;
    });
    deliver('oracle:single', JSON.stringify({ channelID: '123' }));
    recordSource(
        'subscribe_single_dispatch',
        'subscribe-dispatch',
        { subscribes: 1, deliveries: 1 },
        { first, ...busSnapshot('oracle:single') }
    );

    reset();
    let replacedFirst = 0;
    let replacedSecond = 0;
    const two = manager();
    await two.subscribe('oracle:replace', () => {
        replacedFirst += 1;
    });
    await two.subscribe('oracle:replace', () => {
        replacedSecond += 1;
    });
    deliver('oracle:replace', JSON.stringify({ channelID: '123' }));
    recordSource(
        'subscribe_replacement_calls_the_new_handler_once_per_listener',
        'subscribe-dispatch',
        { subscribes: 2, deliveries: 1 },
        { first: replacedFirst, second: replacedSecond, ...busSnapshot('oracle:replace') }
    );

    reset();
    let afterUnsubscribe = 0;
    const three = manager();
    await three.subscribe('oracle:unsubscribe', () => {
        afterUnsubscribe += 1;
    });
    const before = busSnapshot('oracle:unsubscribe');
    await three.unsubscribe('oracle:unsubscribe');
    deliver('oracle:unsubscribe', JSON.stringify({ channelID: '123' }));
    recordSource(
        'unsubscribe_stops_dispatch_and_removes_the_handler',
        'subscribe-dispatch',
        { subscribes: 1, unsubscribes: 1, deliveries: 1 },
        {
            calls: afterUnsubscribe,
            commandsBeforeUnsubscribe: before.commands,
            ...busSnapshot('oracle:unsubscribe'),
        }
    );

    reset();
    const four = manager();
    await four.unsubscribe('oracle:none');
    recordSource(
        'unsubscribe_before_init_is_a_noop',
        'lifecycle',
        { unsubscribes: 1 },
        { duplicates: state.duplicates, connects: state.connects, dragonflyCallers: state.dragonflyCallers }
    );

    reset();
    await manager().publish('oracle:init', { a: 1 });
    recordSource(
        'publish_before_init_initializes_both_clients',
        'lifecycle',
        { publishes: 1 },
        {
            duplicates: state.duplicates,
            connects: state.connects,
            dragonflyCallers: state.dragonflyCallers,
            messageListeners: state.messageListeners,
            initLogs: state.logs.filter(log => log.level === 'info'),
        }
    );
}

async function failureCases() {
    reset();
    const one = manager();
    await one.init();
    state.failOn = 'publish';
    let publishFailure = null;
    try {
        await one.publish('oracle:fail', { a: 1 });
    } catch (error) {
        publishFailure = error.message;
    }
    recordSource(
        'publish_failure_is_logged_and_rethrown',
        'failure',
        { scenario: 'publisher throws' },
        { caught: publishFailure, logs: state.logs.filter(log => log.level === 'error') }
    );

    reset();
    const two = manager();
    await two.init();
    state.failOn = 'subscribe';
    let subscribeFailure = null;
    let leakedCalls = 0;
    try {
        await two.subscribe('oracle:fail', () => {
            leakedCalls += 1;
        });
    } catch (error) {
        subscribeFailure = error.message;
    }
    // The source keeps the map entry after a failed subscribe, so a later
    // dispatch through the (dead) client-level handler still finds it.
    two.handleMessage('oracle:fail', JSON.stringify({ channelID: '123' }));
    recordSource(
        'subscribe_failure_keeps_the_handler_in_the_map',
        'failure',
        { scenario: 'subscriber throws' },
        {
            caught: subscribeFailure,
            subscribeCommands: busSnapshot('oracle:fail').commands,
            leakedCalls,
            errorLogs: state.logs.filter(log => log.level === 'error').length,
        }
    );

    reset();
    state.failOn = 'connect';
    const three = manager();
    let initFailure = null;
    try {
        await three.publish('oracle:initfail', { a: 1 });
    } catch (error) {
        initFailure = error.message;
    }
    recordSource(
        'init_failure_is_logged_by_init_and_by_the_caller',
        'failure',
        { scenario: 'connect throws' },
        {
            caught: initFailure,
            functions: state.logs
                .filter(log => log.level === 'error')
                .map(log => log.payload.function),
            duplicates: state.duplicates,
            connects: state.connects,
        }
    );

    // The half-initialized clients are still assigned, so the next publish
    // skips `init()` and fails on a closed client: the source is not retryable.
    state.failOn = null;
    let afterInitFailure = null;
    try {
        await three.publish('oracle:initfail', { a: 1 });
    } catch (error) {
        afterInitFailure = error.message;
    }
    recordSource(
        'publish_after_a_failed_init_does_not_retry',
        'failure',
        { scenario: 'connect throws, then a publish' },
        { caught: afterInitFailure, duplicates: state.duplicates, connects: state.connects }
    );
}

async function malformedCases() {
    reset();
    const one = manager();
    let handled = 0;
    await one.subscribe('oracle:malformed', () => {
        handled += 1;
    });
    let listenerError = null;
    try {
        deliver('oracle:malformed', 'not json');
    } catch (error) {
        listenerError = { name: error.name, message: error.message };
    }
    recordSource(
        'malformed_payload_throws_out_of_the_channel_listener',
        'malformed',
        { payload: 'not json' },
        { threw: listenerError !== null, error: listenerError, handlerCalls: handled }
    );

    reset();
    const two = manager();
    let swallowed = 0;
    await two.subscribe('oracle:malformed', () => {
        swallowed += 1;
    });
    two.handleMessage('oracle:malformed', 'not json');
    recordSource(
        'handle_message_swallows_invalid_json_and_logs',
        'malformed',
        { payload: 'not json' },
        {
            handlerCalls: swallowed,
            logs: state.logs.filter(log => log.level === 'error'),
        }
    );

    reset();
    const three = manager();
    let valid = 0;
    await three.subscribe('oracle:malformed', () => {
        valid += 1;
    });
    three.handleMessage('oracle:malformed', JSON.stringify({ channelID: '123' }));
    recordSource(
        'handle_message_dispatches_valid_json',
        'malformed',
        { payload: '{"channelID":"123"}' },
        { handlerCalls: valid }
    );
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
    assert(read(sources.manager).includes(`twitch:\${channelID}:clip:request`), 'clip template changed');

    freezeClock();
    await publishCases();
    clipCases();
    await subscribeCases();
    await failureCases();
    await malformedCases();
    global.Date = RealDate;

    const output = `${JSON.stringify(
        {
            schema: 1,
            provenance: {
                node: process.versions.node,
                typescript: ts.version,
                redis: redisVersion,
                redisClient: clientVersion,
                sources: Object.fromEntries(
                    Object.entries(pinned).map(([key, digest]) => [sources[key], digest])
                ),
                oracleSha256: sha(sources.oracle),
            },
            boundaries: {
                transport:
                    'Pub/Sub is an in-memory double on one shared bus; no socket, server or network is contacted',
                redis:
                    'the double reproduces @redis/client 5.12.1: SUBSCRIBE is issued only for the first listener on a channel, later listeners attach locally, and each attached listener is invoked as (message, channel)',
                messageEvent:
                    "the real @redis/client 5.12.1 build never emits a client-level 'message' event (dist/lib/client/pub-sub.js:18 is the protocol command name; #emitPubSubMessage at :345-347 dispatches only to per-channel listener sets), so the source's subscriber.on('message') listener is dead code and handleMessage is exercised by a direct call",
                clock: `Date.now() is frozen at ${FIXED_NOW}`,
                logger:
                    'error/info are recording doubles; their payloads and destination options are recorded verbatim',
                replay:
                    'publish-payload and clip-channel cases are replayed by the native port; every other case is source-side evidence only, because it depends on the double or on a V8 error message',
                clipTemplate: CLIP_TEMPLATE,
            },
            constants: {
                fixedNow: FIXED_NOW,
                clipTemplate: CLIP_TEMPLATE,
                initLabel: 'PubSubManager:init',
                infoMessage: 'PubSub manager initialized',
            },
            cases,
        },
        null,
        2
    )}\n`;
    const target = path.join(directory, 'pubsub-manager-reference.json');
    if (mode === '--write') {
        if (fs.readdirSync(directory).length) throw Error('write directory must be empty');
        fs.writeFileSync(target, output, { flag: 'wx' });
    } else if (fs.readFileSync(target, 'utf8') !== output) {
        throw Error('fixture differs');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
