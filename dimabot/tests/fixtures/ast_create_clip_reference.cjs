// Actual-source oracle for the native `create.clip` AST family.
//
// Run only with the pinned isolated Node/TypeScript toolchain:
//   node tests/fixtures/ast_create_clip_reference.cjs --write <empty-dir>
//   node tests/fixtures/ast_create_clip_reference.cjs --check <dir>
//
// The fixture executes the real `create.clip.ts`, `get_clip.clip.ts`,
// `create_clip.command.ts` and `clip.functions.ts` sources. `getTwitchBotHeader`,
// `getTwitchAppHeader`, `getTwitchHelixUrl`, `logger.error`, the
// `registerFunction` registrar and `fetch` are mocked; `setTimeout` is a
// recording no-op so the 2000 ms retry pause costs no wall-clock time. It never
// contacts Twitch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

const files = {
    create: path.join(root, 'src/functions/clips/create.clip.ts'),
    getClip: path.join(root, 'src/functions/clips/get_clip.clip.ts'),
    command: path.join(root, 'src/commands/create_clip.command.ts'),
    astFamily: path.join(root, 'src/utils/ast_parser/functions/clip.functions.ts'),
    nativeCreate: path.join(root, 'src/functions/clips/create.clip.rs'),
    nativeMod: path.join(root, 'src/functions/clips/mod.rs'),
    nativeCommand: path.join(root, 'src/commands/create_clip.command.rs'),
    nativeCatalog: path.join(root, 'src/utils/ast_parser/runtime/functions.rs'),
    nativeTest: path.join(root, 'tests/ast_create_clip.rs'),
    oracle: __filename,
};

const sha = value => crypto.createHash('sha256').update(fs.readFileSync(value)).digest('hex');

const compiled = new Map();

function compile() {
    for (const key of ['create', 'getClip', 'command', 'astFamily']) {
        const file = files[key];
        compiled.set(key, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
            fileName: file,
        }).outputText);
    }
}

function provenance() {
    if (process.version !== 'v24.22.1'
        || process.versions.v8 !== '13.6.233.17-node.58'
        || ts.version !== '5.9.3') {
        throw Error('wrong oracle toolchain');
    }

    const create = fs.readFileSync(files.create, 'utf8');
    for (const marker of [
        'export async function createClip(channelID: string, options?: CreateClipOptions): Promise<CreateClipResponse>',
        "getTwitchHelixUrl('clips'",
        "params.append('broadcaster_id', channelID)",
        'method: \'POST\'',
        'if (response.status === 404)',
        "'Broadcaster must be live to create a clip'",
        'if (response.status !== 202)',
        'if (!data.data || data.data.length === 0)',
        "'Twitch accepted clip request but did not return a clip ID.'",
        "message: 'Clip created'",
        'status: 202',
        "type: 'success'",
        "message: 'Internal server error'",
        "function: 'createClip'",
        "type: 'permission_error'",
    ]) {
        if (!create.includes(marker)) throw Error(`create.clip.ts contract changed: ${marker}`);
    }

    const getClip = fs.readFileSync(files.getClip, 'utf8');
    for (const marker of [
        'getTwitchAppHeader()',
        "params.append('id', clipID)",
        "'Clip ID is required'",
        'if (data.data.length === 0)',
        "'Clip not found'",
        "message: 'Success'",
        'data: data.data[0]',
        "function: 'getClip'",
    ]) {
        if (!getClip.includes(marker)) throw Error(`get_clip.clip.ts contract changed: ${marker}`);
    }

    const command = fs.readFileSync(files.command, 'utf8');
    for (const marker of [
        'const DEFAULT_CLIP_DURATION = 30;',
        'const MIN_CLIP_DURATION = 5;',
        'const MAX_CLIP_DURATION = 60;',
        'export function parseClipOptions(argument?: string): CreateClipOptions',
        'const firstTokenIsNumber = !isNaN(parsedNumber);',
        'retries < 15',
        'setTimeout(resolve, 2000)',
        'if (createClipFun.status === 503)',
        'if (createClipFun.status && createClipFun.status > 500)',
        "'Clip creation is currently unavailable.'",
        "'There was an internal Twitch server error that we cannot resolve.'",
        "'Clip ID not returned from creation'",
        "'There was an error finding the clip, it may have been created but is taking too long to process. Please check your clips later.'",
        "'There was an unexpected error retrieving the clip data.'",
        'clipData.data.url',
        "type: 'Clip created'",
        "function: 'createClipCommand'",
    ]) {
        if (!command.includes(marker)) throw Error(`create_clip.command.ts contract changed: ${marker}`);
    }

    const family = fs.readFileSync(files.astFamily, 'utf8');
    for (const marker of [
        "registerFunction('create.clip'",
        'minUserLevel: 7',
        'parseClipOptions(rawArgument)',
        'ClipFunctions.createClip(ctx.broadcasterId, options)',
        'https://clips.twitch.tv/${result.clipID}',
    ]) {
        if (!family.includes(marker)) throw Error(`clip.functions.ts contract changed: ${marker}`);
    }

    return {
        node: process.version,
        v8: process.versions.v8,
        typescript: ts.version,
        hashes: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, sha(value)])),
        boundary: 'Actual createClip/getClip/parseClipOptions/createClipCommand/createClipHandler sources executed in a VM. getTwitchBotHeader, getTwitchAppHeader, getTwitchHelixUrl, logger.error, registerFunction, fetch and setTimeout are mocks. Source hashes record contract evidence, not execution of the mocked modules.',
    };
}

function loadModule(file, sandbox) {
    const factory = vm.runInNewContext(
        `(function(exports, require, fetch, setTimeout){${compiled.get(file)}\n})`,
        { URLSearchParams, JSON, Error, SyntaxError, TypeError },
        { filename: file }
    );
    const exports = {};
    factory(exports, sandbox.require, sandbox.fetch, sandbox.setTimeout);
    return exports;
}

function loadFamily(spec) {
    const calls = { fetch: [], delays: [], logs: [], headers: [] };
    const responses = spec.responses ?? [];

    const fetch = async (url, options = {}) => {
        const index = calls.fetch.length;
        calls.fetch.push({
            url,
            method: options.method ?? 'GET',
            headers: options.headers ?? null,
        });
        const scripted = responses.length === 0
            ? { status: 500, body: '{"error":"missing script"}' }
            : responses[Math.min(index, responses.length - 1)];
        return {
            status: scripted.status,
            json: async () => JSON.parse(scripted.body),
        };
    };

    const setTimeout = (callback, millis) => {
        calls.delays.push(millis);
        callback();
    };

    const getTwitchBotHeader = async () => {
        calls.headers.push('bot');
        if (spec.botHeaderError) return { error: true, message: spec.botHeaderError };
        return {
            error: false,
            message: 'Success',
            header: {
                'Client-Id': 'fixture-client',
                Authorization: 'Bearer fixture',
                'Content-Type': 'application/json',
            },
        };
    };

    const getTwitchAppHeader = async () => {
        calls.headers.push('app');
        if (spec.appHeaderError) throw Error('Failed to get Twitch app token');
        return {
            'Client-Id': 'fixture-client',
            Authorization: 'Bearer fixture',
            'Content-Type': 'application/json',
        };
    };

    const getTwitchHelixUrl = (endpoint, params) => (
        params === undefined || params === null || params === ''
            ? `https://api.twitch.tv/helix/${endpoint}`
            : `https://api.twitch.tv/helix/${endpoint}?${params}`
    );

    const logError = async (value, options) => {
        calls.logs.push({
            function: value.function,
            channelID: value.channelID ?? null,
            clipID: value.clipID ?? null,
            error: value.error ?? null,
            destination: options?.destination ?? null,
            channelId: options?.channelId ?? null,
        });
    };

    const registered = new Map();
    const registerFunction = (name, handler, metadata) => {
        registered.set(name, { handler, metadata });
    };

    const clipsIndex = {};
    const commandExports = {};

    const requireMock = id => {
        const name = id.replace(/\\/g, '/');
        if (name.endsWith('/utils/header.js')) {
            return { getTwitchBotHeader, getTwitchAppHeader };
        }
        if (name.endsWith('/utils/links.js')) return { getTwitchHelixUrl };
        if (name.endsWith('/utils/logger.js')) return { error: logError };
        if (name.endsWith('/functions/clips/index.js')) return clipsIndex;
        if (name.endsWith('/commands/create_clip.command.js')) return commandExports;
        if (name.endsWith('/ast_parser/evaluator.js')) return { registerFunction };
        throw Error(`unexpected clip import ${id}`);
    };

    const sandbox = { require: requireMock, fetch, setTimeout };

    const create = loadModule(files.create, sandbox);
    const getClip = loadModule(files.getClip, sandbox);
    clipsIndex.createClip = create.createClip;
    clipsIndex.getClip = getClip.getClip;

    Object.assign(commandExports, loadModule(files.command, sandbox));
    const family = loadModule(files.astFamily, sandbox);
    family.registerClipFunctions();
    if (!registered.has('create.clip')) throw Error('create.clip registration missing');

    return { calls, create, getClip, command: commandExports, registered };
}

function pathWithQuery(url) {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
}

async function runCase(spec) {
    const env = loadFamily(spec);
    const base = {
        id: spec.id,
        mode: spec.mode,
        channelID: spec.channelID ?? 'channel-1',
        argument: spec.argument ?? null,
        clipID: spec.clipID ?? null,
        astArgs: spec.astArgs ?? [],
        astArgument: spec.astArgument ?? null,
        botHeaderError: spec.botHeaderError ?? null,
        appHeaderError: spec.appHeaderError ?? null,
        responses: spec.responses ?? [],
        options: null,
        delays: [],
        logs: env.calls.logs,
        createResponseJson: null,
        getClipResponseJson: null,
        commandResponse: null,
        astResult: null,
        requests: [],
    };

    if (spec.mode === 'create') {
        base.options = spec.options ?? {};
        const args = [base.channelID];
        if (spec.options !== undefined) args.push(spec.options);
        const returned = await env.create.createClip(...args);
        base.createResponseJson = JSON.stringify(returned);
    } else if (spec.mode === 'getClip') {
        const returned = await env.getClip.getClip(spec.clipID);
        base.getClipResponseJson = JSON.stringify(returned);
    } else if (spec.mode === 'command') {
        base.options = JSON.parse(JSON.stringify(env.command.parseClipOptions(spec.argument ?? undefined)));
        const returned = await env.command.createClipCommand(base.channelID, spec.argument ?? undefined);
        base.commandResponse = JSON.parse(JSON.stringify(returned));
        base.delays = env.calls.delays;
    } else if (spec.mode === 'ast') {
        const entry = env.registered.get('create.clip');
        base.astResult = await entry.handler(spec.astArgs ?? [], {
            broadcasterId: base.channelID,
            argument: spec.astArgument,
        });
    } else {
        throw Error(`unknown mode ${spec.mode}`);
    }

    base.requests = env.calls.fetch.map(call => ({
        url: call.url,
        method: call.method,
        pathWithQuery: pathWithQuery(call.url),
        endpoint: new URL(call.url).pathname.replace(/^\//, ''),
    }));
    return base;
}

const CLIP_ID = 'ClipAbc';
const clipBody = JSON.stringify({
    id: CLIP_ID,
    url: `https://clips.twitch.tv/${CLIP_ID}`,
    embed_url: `https://clips.twitch.tv/embed?clip=${CLIP_ID}`,
    broadcaster_id: 'channel-1',
    creator_id: 'channel-1',
    video_id: 'video-1',
    created_at: '2026-10-31T00:00:00Z',
    thumbnail_url: 'https://clips-media-assets.twitch.tv/thumb.jpg',
    duration: 30,
    vod_offset: null,
    is_mutable: true,
});
const created = { status: 202, body: JSON.stringify({ data: [{ id: CLIP_ID, edit_url: 'edit' }] }) };
const found = { status: 200, body: JSON.stringify({ data: [JSON.parse(clipBody)] }) };
const gone = { status: 404, body: JSON.stringify({ data: [] }) };
const repeat = (count, response) => Array.from({ length: count }, () => ({ ...response }));

const specs = [
    // `createClip`
    {
        id: 'create-success-defaults',
        mode: 'create',
        channelID: 'channel-1',
        options: {},
        responses: [created],
    },
    {
        id: 'create-duration-and-title',
        mode: 'create',
        channelID: 'channel-1',
        options: { duration: 30, title: '  Epic win  ' },
        responses: [created],
    },
    {
        id: 'create-odd-duration-and-blank-title',
        mode: 'create',
        channelID: 'channel-1',
        options: { duration: -3, title: '   ' },
        responses: [created],
    },
    {
        id: 'create-not-live',
        mode: 'create',
        channelID: 'channel-offline',
        options: {},
        responses: [{ status: 404, body: '<html>not json</html>' }],
    },
    {
        id: 'create-rejected',
        mode: 'create',
        channelID: 'channel-1',
        options: {},
        responses: [{
            status: 400,
            body: JSON.stringify({ error: 'Bad Request', message: 'missing scope' }),
        }],
    },
    {
        id: 'create-rejected-without-message',
        mode: 'create',
        channelID: 'channel-1',
        options: {},
        responses: [{ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) }],
    },
    {
        id: 'create-id-missing',
        mode: 'create',
        channelID: 'channel-1',
        options: { duration: 45 },
        responses: [{ status: 202, body: JSON.stringify({ data: [] }) }],
    },
    {
        id: 'create-header-denied',
        mode: 'create',
        channelID: 'channel-1',
        options: {},
        botHeaderError: "Bot's account does not have the permissions required",
        responses: [],
    },
    {
        id: 'create-internal-error',
        mode: 'create',
        channelID: 'channel-1',
        options: {},
        responses: [{ status: 202, body: '<html>' }],
    },

    // `getClip`
    {
        id: 'get-found',
        mode: 'getClip',
        channelID: 'channel-1',
        clipID: CLIP_ID,
        responses: [found],
    },
    {
        id: 'get-not-found',
        mode: 'getClip',
        channelID: 'channel-1',
        clipID: 'Gone',
        responses: [gone],
    },
    {
        id: 'get-error-body',
        mode: 'getClip',
        channelID: 'channel-1',
        clipID: CLIP_ID,
        responses: [{
            status: 401,
            body: JSON.stringify({
                error: 'Unauthorized',
                status: 401,
                message: 'Invalid OAuth token',
            }),
        }],
    },
    {
        id: 'get-app-header-denied',
        mode: 'getClip',
        channelID: 'channel-1',
        clipID: CLIP_ID,
        appHeaderError: 'Failed to get Twitch app token',
        responses: [],
    },
    {
        id: 'get-empty-id',
        mode: 'getClip',
        channelID: 'channel-1',
        clipID: '',
        responses: [],
    },
    {
        id: 'get-invalid-json',
        mode: 'getClip',
        channelID: 'channel-1',
        clipID: CLIP_ID,
        responses: [{ status: 200, body: '<html>' }],
    },

    // `createClipCommand`
    {
        id: 'command-success-after-two-polls',
        mode: 'command',
        channelID: 'channel-1',
        argument: '30 Epic win',
        responses: [created, gone, gone, found],
    },
    {
        id: 'command-title-only',
        mode: 'command',
        channelID: 'channel-1',
        argument: 'Epic win',
        responses: [created, found],
    },
    {
        id: 'command-looking-numeric-title',
        mode: 'command',
        channelID: 'channel-1',
        argument: 'NaN win',
        responses: [created, found],
    },
    {
        id: 'command-no-argument',
        mode: 'command',
        channelID: 'channel-1',
        responses: [created, found],
    },
    {
        id: 'command-unavailable',
        mode: 'command',
        channelID: 'channel-1',
        argument: 'Epic win',
        responses: [{
            status: 503,
            body: JSON.stringify({ error: 'Service Unavailable', message: 'down' }),
        }],
    },
    {
        id: 'command-gateway',
        mode: 'command',
        channelID: 'channel-1',
        responses: [{
            status: 502,
            body: JSON.stringify({ error: 'Bad Gateway', message: 'bad' }),
        }],
    },
    {
        id: 'command-create-error',
        mode: 'command',
        channelID: 'channel-1',
        argument: 'Epic win',
        responses: [{
            status: 400,
            body: JSON.stringify({ error: 'Bad Request', message: 'missing scope' }),
        }],
    },
    {
        id: 'command-id-missing',
        mode: 'command',
        channelID: 'channel-1',
        responses: [{ status: 202, body: JSON.stringify({ data: [] }) }],
    },
    {
        id: 'command-not-found-after-retries',
        mode: 'command',
        channelID: 'channel-1',
        responses: [created, ...repeat(16, gone)],
    },
    {
        id: 'command-clip-data-missing',
        mode: 'command',
        channelID: 'channel-1',
        responses: [created, { status: 200, body: JSON.stringify({ data: {} }) }],
    },

    // `createClipHandler`
    {
        id: 'ast-title-argument',
        mode: 'ast',
        channelID: 'channel-1',
        astArgs: ['Epic win'],
        responses: [created],
    },
    {
        id: 'ast-duration-and-title-arguments',
        mode: 'ast',
        channelID: 'channel-1',
        astArgs: ['30', 'chill'],
        responses: [created],
    },
    {
        id: 'ast-context-argument-fallback',
        mode: 'ast',
        channelID: 'channel-1',
        astArgs: [],
        astArgument: '45 clutch',
        responses: [created],
    },
    {
        id: 'ast-out-of-range-duration',
        mode: 'ast',
        channelID: 'channel-1',
        astArgs: ['999', 'x'],
        responses: [created],
    },
    {
        id: 'ast-error-is-empty',
        mode: 'ast',
        channelID: 'channel-1',
        astArgs: ['Epic win'],
        responses: [{ status: 404, body: '<html>not json</html>' }],
    },
];

async function main() {
    const [mode, directory, ...extra] = process.argv.slice(2);
    if (!['--write', '--check'].includes(mode) || !directory || extra.length) {
        throw Error('usage: --write DIR | --check DIR');
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
        throw Error('canonical directory required');
    }
    const provenanceValue = provenance();
    compile();
    const cases = [];
    for (const spec of specs) cases.push(await runCase(spec));
    const output = `${JSON.stringify({ schema: 1, provenance: provenanceValue, cases }, null, 2)}\n`;
    const target = path.join(directory, 'ast_create_clip_cases.json');
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
