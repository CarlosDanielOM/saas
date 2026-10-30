'use strict';
// Source oracle for the native API-auth middleware port.
//
// The middleware declarations below are extracted from the actual
// `src/middleware/auth.middleware.ts` text and transpiled by the pinned
// TypeScript compiler; no behavior is re-implemented here. Only the module's
// external boundaries are doubled: `fetch` (Twitch), the Dragonfly client
// (hash/string cache with injectable errors), the `users` Mongoose model
// (`updateOne` capture), `error` (shared logger) and `bindChannel` (telemetry
// context). Type/export mapping is read from the TypeScript AST.
//
//   node tests/fixtures/api_auth_reference.cjs --write <absolute dir>
//   node tests/fixtures/api_auth_reference.cjs --check <absolute dir>
//
// `--write` creates the reference exclusively; `--check` requires an exact
// byte match. Rust replays the expected statuses/bodies against a loopback
// provider and task-owned Redis/Mongo fixtures.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');

const root = fs.realpathSync(process.env.DIMA_API_AUTH_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const read = relative => fs.readFileSync(path.join(root, relative));
const readText = relative => read(relative).toString('utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const pins = {
    'src/middleware/auth.middleware.ts': '9ff83234e83278aa4b1c1059fda6e95bb7d2bf2025a9d87e420257561181cfb5',
    'src/middleware/types.ts': 'bec2725ffcda18fb992c5aefdc610dd46bc6873c01a4940cf41c47773f795ae3',
    'src/utils/observability/telemetry.ts': '44c9a71e5699abf9ef49242beaf8b883bbc9825e977de29e371011912ce52c2b',
    'src/utils/databases/dragonfly.database.ts': '0d08dd4cdb931633473227fb59f043251b7be59a09a034ef6f392e0f64aebe9c',
    'src/utils/logger.ts': '0c0c94539974a230ecad4a5a4236dfa6b53c2ce3f4242b3f58a558109407bc6d',
    'src/schemas/users.schema.ts': 'f324f0837b01866a0caf28854c0261b8a2e28f0fb577cd5ae370e45c352fad13',
    'node_modules/typescript/lib/typescript.js': '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
};
for (const [relative, expected] of Object.entries(pins)) {
    assert.equal(sha(read(relative)), expected, relative);
}
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)), nodeSha);
assert.equal(process.versions.node, '24.22.1');

const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
assert.equal(ts.version, '5.9.3');

const middlewareFile = 'src/middleware/auth.middleware.ts';
const typesFile = 'src/middleware/types.ts';
const parse = file => {
    const ast = ts.createSourceFile(file, readText(file), ts.ScriptTarget.ES2022, true);
    assert.deepEqual(ast.parseDiagnostics, []);
    return ast;
};
const middlewareAst = parse(middlewareFile);
const typesAst = parse(typesFile);

const declarationName = statement => {
    if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return statement.name.text;
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map(declaration => declaration.name.getText()).join(',');
    return null;
};
const isExported = statement => Boolean(statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const statementsOf = ast => ast.statements.filter(statement => !ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement));
const middlewareStatements = statementsOf(middlewareAst);

const identifierCounts = (ast, name) => {
    let count = 0;
    const visit = node => {
        if (ts.isIdentifier(node) && node.text === name) count += 1;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return count;
};

const middlewareEvidence = middlewareStatements.map(statement => ({
    name: declarationName(statement),
    kind: ts.SyntaxKind[statement.kind],
    exported: isExported(statement),
}));
const middlewareNames = middlewareEvidence.map(entry => entry.name);
assert.deepEqual(middlewareNames, [
    'CACHE_KEY_PREFIX',
    'CACHE_TTL',
    'TWITCH_VALIDATE_URL',
    'TWITCH_USERS_URL',
    'ACTIVITY_TOUCH_TTL',
    'touchLastAppActivity',
    'validateTwitchToken',
    'getUserFromToken',
    'isTokenCached',
    'getCachedToken',
    'cacheToken',
    'authMiddleware',
]);
const authStatement = middlewareStatements.at(-1);
assert(ts.isFunctionDeclaration(authStatement) && authStatement.name.text === 'authMiddleware');
assert(isExported(authStatement));
assert.deepEqual(authStatement.parameters.map(parameter => parameter.type.getText(middlewareAst)), [
    'AuthRequest',
    'Response',
    'NextFunction',
]);
assert.equal(authStatement.type.getText(middlewareAst), 'Promise<void>');

// A private helper with no call site is dead source; the native port omits it
// instead of keeping an unused Redis EXISTS round trip.
const isTokenCachedCount = identifierCounts(middlewareAst, 'isTokenCached');
assert.equal(isTokenCachedCount, 1, 'isTokenCached must have exactly its declaration and no references');

const typeNames = [
    'AuthenticatedUser',
    'AuthRequest',
    'TwitchTokenValidation',
    'TwitchUser',
    'TwitchUsersResponse',
    'CachedTokenData',
    'ErrorResponse',
];
const typeEvidence = Object.fromEntries(typeNames.map(name => {
    const found = typesAst.statements.filter(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === name);
    assert.equal(found.length, 1, name);
    const declaration = found[0];
    assert(isExported(declaration), name);
    const heritage = (declaration.heritageClauses || []).flatMap(clause => clause.types.map(type => type.getText(typesAst)));
    return [name, {
        exported: true,
        extends: heritage,
        members: declaration.members.map(member => ({
            name: member.name.getText(typesAst),
            optional: Boolean(member.questionToken),
            type: member.type.getText(typesAst),
        })),
    }];
}));
assert.deepEqual(typeEvidence.AuthRequest.extends, ['Request']);
assert.deepEqual(typeEvidence.AuthRequest.members.map(member => member.name), ['user']);

// Execute the real source declarations with only boundary doubles supplied.
const sourceText = middlewareStatements.map(statement => statement.getText(middlewareAst)).join('\n\n')
    + '\nexport { authMiddleware, touchLastAppActivity, validateTwitchToken, getUserFromToken, getCachedToken, cacheToken, CACHE_KEY_PREFIX, CACHE_TTL, ACTIVITY_TOUCH_TTL, TWITCH_VALIDATE_URL, TWITCH_USERS_URL };';
const transpiled = ts.transpileModule(sourceText, {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
});
assert.deepEqual(transpiled.diagnostics, []);
const exportedNames = ['authMiddleware', 'touchLastAppActivity', 'validateTwitchToken', 'getUserFromToken', 'getCachedToken', 'cacheToken', 'CACHE_KEY_PREFIX', 'CACHE_TTL', 'ACTIVITY_TOUCH_TTL', 'TWITCH_VALIDATE_URL', 'TWITCH_USERS_URL'];
const moduleObject = new Module(path.join(root, middlewareFile), module);
moduleObject.filename = path.join(root, middlewareFile);
moduleObject._compile(transpiled.outputText, moduleObject.filename);
const api = moduleObject.exports;
for (const name of exportedNames) assert.notEqual(api[name], undefined, name);

const tokenKey = token => `token:${token}`;
const activityKey = id => `twitch:${id}:last_app_activity_touch`;
assert.equal(api.CACHE_KEY_PREFIX, 'token:');
assert.equal(api.CACHE_TTL, 14000);
assert.equal(api.ACTIVITY_TOUCH_TTL, 86400);
assert.equal(api.TWITCH_VALIDATE_URL, 'https://id.twitch.tv/oauth2/validate');
assert.equal(api.TWITCH_USERS_URL, 'https://api.twitch.tv/helix/users');
assert.equal(api.CACHE_TTL, 14000);

const redisName = method => ({
    hGetAll: 'HGETALL',
    hSet: 'HSET',
    expire: 'EXPIRE',
    exists: 'EXISTS',
    set: 'SET',
}[method]);

function harness(initial = {}) {
    const state = {
        hashes: new Map(Object.entries(initial.hashes || {})),
        warm: new Set(initial.warm || []),
        usersMatch: initial.usersMatch !== false,
        replies: [...(initial.replies || [])],
        errors: { ...(initial.errors || {}) },
        cacheLog: [],
        fetchLog: [],
        bindLog: [],
        errorLog: [],
        mongoLog: [],
        next: 0,
    };
    const boundary = (name, ...args) => {
        state.cacheLog.push([name, ...args]);
        if (state.errors[name]) throw new Error(`injected:${name}`);
    };
    const cache = {
        async hGetAll(key) {
            boundary('hGetAll', key);
            const hash = state.hashes.get(key);
            return hash ? { ...hash } : {};
        },
        async hSet(key, value) {
            boundary('hSet', key, value);
            state.hashes.set(key, { ...value });
            return 1;
        },
        async expire(key, seconds) {
            boundary('expire', key, seconds);
            return 1;
        },
        async exists(key) {
            boundary('exists', key);
            return state.warm.has(key) ? 1 : 0;
        },
        async set(key, value) {
            boundary('set', key, value);
            state.warm.add(key);
            return 'OK';
        },
    };
    const fetch = async (url, options = {}) => {
        state.fetchLog.push({ url: String(url), headers: { ...(options.headers || {}) } });
        const reply = state.replies.shift();
        if (!reply) throw new Error(`unexpected fetch ${url}`);
        if (reply.throws) throw new Error(reply.throws);
        const status = reply.status ?? 200;
        return {
            status,
            ok: status >= 200 && status < 300,
            async json() {
                if (reply.badJson) throw new SyntaxError('Unexpected token < in JSON');
                return reply.json;
            },
        };
    };
    const context = {
        fetch,
        bindChannel: value => {
            if (state.errors.bindChannel) throw new Error('injected:bindChannel');
            state.bindLog.push(value);
        },
        getDragonflyClient: async () => cache,
        error: async (data, options) => {
            state.errorLog.push({ data, options });
            return { success: true };
        },
        UsersSchema: {
            async updateOne(filter, update) {
                state.mongoLog.push({ filter, update });
                if (state.errors.updateOne) throw new Error('injected:updateOne');
                return { matchedCount: state.usersMatch ? 1 : 0, modifiedCount: state.usersMatch ? 1 : 0 };
            },
        },
    };
    const run = new Function(...Object.keys(context), 'exports', `${transpiled.outputText}\nreturn exports;`);
    return { api: run(...Object.values(context), {}), state };
}

const user1 = {
    id: '1001',
    login: 'alpha',
    display_name: 'Alpha',
    profile_image_url: 'https://static.invalid/alpha.png',
    type: '',
    broadcaster_type: '',
    created_at: '2020-01-01T00:00:00Z',
};
const user2 = {
    id: '1002',
    login: 'beta',
    display_name: 'Beta',
    profile_image_url: 'https://static.invalid/beta.png',
    type: 'staff',
    broadcaster_type: 'partner',
    created_at: '2021-01-01T00:00:00Z',
};
const validation = {
    client_id: 'fixture-client',
    login: 'alpha',
    scopes: ['user:read:email'],
    user_id: '1001',
    expires_in: 14124,
};
const validateOk = { status: 200, json: validation };
const usersOk = { status: 200, json: { data: [user1, user2] } };

// Dates are generated at execution time; keep the shape, not the instant.
function normalize(value) {
    if (value instanceof Date) return '<date>';
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
}

function requestObject(spec) {
    return {
        headers: { ...(spec.headers || {}) },
        params: spec.channelID ? { channelID: spec.channelID } : {},
        user: undefined,
    };
}

function responseRecorder() {
    return {
        statusCode: null,
        body: null,
        writes: 0,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            this.writes += 1;
            return this;
        },
    };
}

async function invoke(harnessState, requestSpec, response, next) {
    await harnessState.api.authMiddleware(requestSpec, response, next);
}

async function scenario(spec) {
    const harnessState = harness(spec.initial);
    const request = requestObject(spec);
    const response = responseRecorder();
    let nextCalls = 0;
    const envBefore = process.env.CLIENT_ID;
    if (spec.clientId !== undefined) {
        if (spec.clientId === null) delete process.env.CLIENT_ID;
        else process.env.CLIENT_ID = spec.clientId;
    }
    const next = () => {
        nextCalls += 1;
        if (response.statusCode === null) {
            // Protected-handler double: the real fixture endpoint answers 200
            // with the identity, bound channel and single-next marker.
            response.statusCode = 200;
            response.body = {
                user: request.user ?? null,
                bind: harnessState.state.bindLog.at(-1) ?? null,
                next: nextCalls,
            };
        }
    };
    try {
        await invoke(harnessState, request, response, next);
    } catch (error) {
        assert.fail(`middleware threw: ${error && error.message}`);
    } finally {
        if (spec.clientId !== undefined) {
            if (envBefore === undefined) delete process.env.CLIENT_ID;
            else process.env.CLIENT_ID = envBefore;
        }
    }
    return {
        name: spec.name,
        request: {
            headers: request.headers,
            channelID: request.params.channelID || null,
            clientId: spec.clientId === undefined ? null : spec.clientId,
        },
        initial: spec.initial || {},
        expected: {
            status: response.statusCode,
            body: response.body,
            writes: response.writes,
            next: nextCalls,
            user: request.user ?? null,
            bind: harnessState.state.bindLog.at(-1) ?? null,
            redis: harnessState.state.cacheLog.map(([method, ...rest]) => {
                const op = redisName(method);
                if (op === 'EXPIRE') return { op, key: rest[0], ttl: rest[1] };
                return { op, key: rest[0] };
            }),
            fetch: harnessState.state.fetchLog,
            mongo: harnessState.state.mongoLog.map(({ filter, update }) => ({
                filter,
                set: normalize(update.$set),
                setOnInsert: normalize(update.$setOnInsert),
            })),
            errors: harnessState.state.errorLog,
        },
    };
}

async function cases() {
    const results = [];
    const add = async spec => results.push(await scenario(spec));
    const withCache = (token, value = { id: '1001', login: 'alpha', display_name: 'Alpha', profile_image_url: 'https://static.invalid/alpha.png' }) => ({
        hashes: { [tokenKey(token)]: value },
    });
    const hitWarm = token => ({ ...withCache(token), warm: [activityKey('1001')] });

    await add({ name: 'no-header', headers: {}, initial: {} });
    await add({ name: 'bearer-empty', headers: { authorization: 'Bearer ' }, initial: {} });
    await add({
        name: 'raw-token',
        headers: { authorization: 'raw-token' },
        initial: { replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'bearer-token',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'lowercase-bearer',
        headers: { authorization: 'bearer fixture-token' },
        initial: { replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'capitalized-header',
        headers: { Authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({ name: 'cache-hit', headers: { authorization: 'Bearer cached-token' }, initial: withCache('cached-token') });
    await add({
        name: 'cache-hit-channel',
        headers: { authorization: 'Bearer cached-token' },
        channelID: 'chan-77',
        initial: withCache('cached-token'),
    });
    await add({
        name: 'cache-hit-empty-profile',
        headers: { authorization: 'Bearer cached-token' },
        initial: withCache('cached-token', { id: '1001', login: 'alpha', display_name: 'Alpha', profile_image_url: '' }),
    });
    await add({
        name: 'cache-empty-id',
        headers: { authorization: 'Bearer cached-token' },
        initial: { ...withCache('cached-token', { id: '', login: 'alpha' }), replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'cache-miss',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'cache-miss-channel',
        headers: { authorization: 'Bearer fixture-token' },
        channelID: 'chan-9',
        initial: { replies: [validateOk, usersOk] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'validate-401',
        headers: { authorization: 'Bearer bad-token' },
        initial: { replies: [{ status: 401 }] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'validate-network',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [{ throws: 'connect ECONNREFUSED' }] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'validate-json',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [{ status: 200, badJson: true }] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'users-http-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, { status: 403, json: { error: 'Forbidden' } }] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'users-json-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, { status: 200, badJson: true }] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'users-empty',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, { status: 200, json: { data: [] } }] },
        clientId: 'fixture-client',
    });
    await add({
        name: 'cache-read-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], errors: { hGetAll: true } },
        clientId: 'fixture-client',
    });
    await add({
        name: 'cache-write-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], errors: { hSet: true } },
        clientId: 'fixture-client',
    });
    await add({
        name: 'cache-expire-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], errors: { expire: true } },
        clientId: 'fixture-client',
    });
    await add({ name: 'activity-warm', headers: { authorization: 'Bearer cached-token' }, initial: hitWarm('cached-token') });
    await add({
        name: 'activity-nomatch',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], usersMatch: false },
        clientId: 'fixture-client',
    });
    await add({
        name: 'activity-mongo-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], errors: { updateOne: true } },
        clientId: 'fixture-client',
    });
    await add({
        name: 'activity-exists-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], errors: { exists: true } },
        clientId: 'fixture-client',
    });
    await add({
        name: 'activity-set-error',
        headers: { authorization: 'Bearer fixture-token' },
        initial: { replies: [validateOk, usersOk], errors: { set: true } },
        clientId: 'fixture-client',
    });
    await add({
        name: 'outer-error',
        headers: { authorization: 'Bearer cached-token' },
        initial: { ...withCache('cached-token'), errors: { bindChannel: true } },
    });
    return results;
}

async function clientIdRefresh() {
    const observe = async clientId => {
        const harnessState = harness({ replies: [validateOk, usersOk] });
        const request = requestObject({ headers: { authorization: 'Bearer fixture-token' } });
        const response = responseRecorder();
        const before = process.env.CLIENT_ID;
        if (clientId === null) delete process.env.CLIENT_ID;
        else process.env.CLIENT_ID = clientId;
        try {
            await invoke(harnessState, request, response, () => {
                if (response.statusCode === null) response.statusCode = 200;
            });
        } finally {
            if (before === undefined) delete process.env.CLIENT_ID;
            else process.env.CLIENT_ID = before;
        }
        return { status: response.statusCode, headers: harnessState.state.fetchLog.map(entry => entry.headers) };
    };
    return { first: await observe('client-a'), second: await observe('client-b'), missing: await observe(null) };
}

function nativeHashes() {
    const files = [
        'src/middleware/auth.middleware.rs',
        'src/middleware/types.rs',
        'tests/fixtures/api_auth_reference.cjs',
    ];
    return Object.fromEntries(files.map(file => [file, sha(read(file))]));
}

async function reference() {
    return {
        metadata: {
            pins,
            nodeSha,
            versions: {
                node: process.versions.node,
                v8: process.versions.v8,
                icu: process.versions.icu,
                unicode: process.versions.unicode,
                typescript: ts.version,
            },
            middleware: {
                file: middlewareFile,
                exports: {
                    authMiddleware: {
                        exported: true,
                        parameters: authStatement.parameters.map(parameter => parameter.type.getText(middlewareAst)),
                        returns: authStatement.type.getText(middlewareAst),
                    },
                },
                declarations: middlewareEvidence,
                isTokenCachedReferences: isTokenCachedCount,
            },
            types: {
                file: typesFile,
                interfaces: typeEvidence,
            },
            constants: {
                cacheKeyPrefix: api.CACHE_KEY_PREFIX,
                cacheTtl: api.CACHE_TTL,
                validateUrl: api.TWITCH_VALIDATE_URL,
                usersUrl: api.TWITCH_USERS_URL,
                activityTouchTtl: api.ACTIVITY_TOUCH_TTL,
            },
            compiledSha: sha(transpiled.outputText),
            nativeHashes: nativeHashes(),
            differences: [
                'JS Error.stack is not part of the native log payload.',
                'A validation/user JSON body outside the declared interface is rejected as a failed upstream call instead of being used with absent fields.',
                'An unset CLIENT_ID omits the Client-Id header; fetch(Headers) would stringify it to "undefined".',
                'Express req.params.channelID is read from Axum raw route params; the userId fallback and empty-value fallback are preserved.',
            ],
        },
        cases: await cases(),
        clientIdRefresh: await clientIdRefresh(),
    };
}

(async () => {
    const [mode, directory, ...extra] = process.argv.slice(2);
    assert(['--write', '--check'].includes(mode) && directory && path.isAbsolute(directory) && extra.length === 0, 'usage: --write|--check <absolute dir>');
    const file = path.join(directory, 'api-auth-reference.json');
    const rendered = JSON.stringify(await reference(), null, 2) + '\n';
    if (mode === '--write') {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(file, rendered, { flag: 'wx' });
        console.log(JSON.stringify({ file, sha256: sha(Buffer.from(rendered)), cases: JSON.parse(rendered).cases.length }));
    } else {
        const actual = fs.readFileSync(file);
        assert.equal(sha(actual), sha(Buffer.from(rendered)), 'reference bytes changed');
        console.log(JSON.stringify({ file, sha256: sha(actual), cases: JSON.parse(rendered).cases.length, exact: true }));
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
