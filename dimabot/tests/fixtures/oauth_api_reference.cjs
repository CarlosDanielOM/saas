'use strict';
// Actual-source OAuth HTTP oracle. Run only in the pinned isolated toolchain:
//   node tests/fixtures/oauth_api_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/oauth_api_reference.cjs --check <absolute-dir>
// Requires Node 24.22.1, TypeScript 5.9.3, and the workspace's Express 4.
// Express and express.json() run for real over loopback. Mongo, Redis, and
// Twitch validate are stubs. desktop-websocket.ts is not loaded: the socket
// is not an Express route. oauth_debug_cache.ts is not loaded: its native
// reuse lives in utils/twitch.rs and follow_ledger.rs.
// Writes oauth-api-reference.json. The directory must be absolute and outside
// this repository. --write uses flag wx and requires an empty directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');
const http = require('node:http');
const root = fs.realpathSync(process.env.DIMA_OAUTH_API_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const express = local('express');
const expressVersion = JSON.parse(fs.readFileSync(local.resolve('express/package.json'), 'utf8')).version;
assert.equal(process.versions.node, '24.22.1');
assert.equal(ts.version, '5.9.3');
const [expressMajor, expressMinor, expressPatch] = expressVersion.split('.').map(Number);
assert.equal(expressMajor, 4);
assert(expressMinor > 19 || (expressMinor === 19 && expressPatch >= 2), expressVersion);
delete process.env.PUBLIC_API_URL;
delete process.env.DASHBOARD_URL;
delete process.env.CLIENT_ID;
const PINS = [
    ['src/server/oauth/catalog.ts', '4608d6cc655bb101b2d871923f7b06432edde6e8b1de5ca197b364641061456a'],
    ['src/server/oauth/service.ts', '525e04c8b7b78b849165ffb07233fefe1f3f4421a379d14a049386dbc2405726'],
    ['src/server/oauth/routes.ts', 'a387e88a604a263de03324005f001208731de1c6b718f735d818a7bd4ed493a7'],
];
const RATE_LIMIT_LUA = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n";
const SESSION_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';
const GRANT_ID = '507f1f77bcf86cd799439013';
const WEBSITE = 'https://domdimabot.com';
function compile(text, file) {
    const result = ts.transpileModule(text, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true},
    });
    assert(!result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error), file);
    return result.outputText;
}
function load(text, file, resolve) {
    const moduleRecord = {exports: {}};
    new Function('require', 'module', 'exports', compile(text, file))(resolve, moduleRecord, moduleRecord.exports);
    return moduleRecord.exports;
}
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
for (const [file, pin] of PINS) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    assert.equal(digest, pin, file);
}
const catalog = load(read(PINS[0][0]), PINS[0][0], id => { throw new Error(`unexpected catalog import ${id}`); });
const ACTIVE = Object.entries(catalog.OAUTH_SCOPES).filter(([, scope]) => scope.active).map(([name]) => name);
const oracle = {
    calls: null,
    forceCount: null,
    forceError: null,
    access: new Map(),
};
function resetCalls() {
    oracle.calls = {evals: [], gets: [], clientFinds: 0, refreshFinds: 0, findById: 0, logs: []};
}
resetCalls();
function query(value, count) {
    if (count) count();
    const thenable = {
        select() { return thenable; },
        lean() { return thenable; },
        then(ok, bad) { return Promise.resolve(value).then(ok, bad); },
    };
    return thenable;
}
function idOf(hex) {
    return {toString() { return hex; }};
}
const sessionDocument = {
    _id: idOf(SESSION_ID),
    user_id: idOf(USER_ID),
    grant_id: idOf(GRANT_ID),
    client_id: 'dima-desktop',
    channel_id: '12345',
    scopes: ACTIVE,
    current_refresh_hash: 'fixture',
};
const desktopClient = {
    client_id: 'dima-desktop',
    name: 'Dima Desktop Beta',
    enabled: true,
    redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
    allowed_scopes: ACTIVE.slice(),
};
class PetError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; this.name = 'PetError'; }
}
class PetSettingsError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; this.name = 'PetSettingsError'; }
}
function banned(name) {
    return () => { throw new Error(`${name} is outside the mongo-free oracle`); };
}
const redis = {
    async eval(script, options) {
        assert.equal(script, RATE_LIMIT_LUA);
        const key = options?.keys?.[0] ?? null;
        if (oracle.forceError) {
            oracle.calls.evals.push({script, key, count: null});
            throw oracle.forceError;
        }
        const count = oracle.forceCount ?? 1;
        oracle.calls.evals.push({script, key, count});
        return count;
    },
    async get(key) {
        oracle.calls.gets.push(key);
        if (String(key).startsWith('oauth:access:')) return oracle.access.get(key) ?? null;
        return null;
    },
    async set() {},
    async getDel() { return null; },
    async del() {},
};
function getDragonflyClient(name) {
    assert.equal(name, 'OAuth');
    return redis;
}
const UsersSchema = {
    async exists() { return {_id: USER_ID}; },
    async findById() { oracle.calls.findById += 1; throw new Error('findById is outside the ordering cases'); },
    findOne: () => query(null),
};
const OAuthClient = {
    findOne(filter) {
        oracle.calls.clientFinds += 1;
        const client = filter?.client_id === 'dima-desktop' && filter.enabled === true ? desktopClient : null;
        return query(client);
    },
};
const OAuthGrant = {
    findOne: () => query({scopes: ACTIVE.slice()}),
};
const OAuthSession = {
    findOne: () => query(sessionDocument),
};
const OAuthRefreshToken = {
    findOne() {
        oracle.calls.refreshFinds += 1;
        return query(null);
    },
};
const mongooseStub = {Types: {ObjectId: {isValid() { return false; }}}};
function resolve(id) {
    if (id === 'express') return express;
    if (id === 'mongoose') return mongooseStub;
    if (id === 'node:crypto' || id === 'crypto') return require('node:crypto');
    if (id === './catalog.js' || id.endsWith('/catalog.js')) return catalog;
    if (id === './service.js' || id.endsWith('/service.js')) return service;
    if (id.endsWith('/users.schema.js')) return UsersSchema;
    if (id.endsWith('/oauth_client.schema.js')) return {OAuthClient};
    if (id.endsWith('/oauth_grant.schema.js')) return {OAuthGrant};
    if (id.endsWith('/oauth_session.schema.js')) return {OAuthSession};
    if (id.endsWith('/oauth_refresh_token.schema.js')) return {OAuthRefreshToken};
    if (id.endsWith('/dragonfly.database.js')) return {getDragonflyClient};
    if (id.endsWith('/billing.js')) return {getAiCredits: banned('getAiCredits')};
    if (id.endsWith('/ai_credit_display.js')) return {getFreeAiCreditDisplay: banned('getFreeAiCreditDisplay')};
    if (id.endsWith('/pet_settings.service.js')) return {getPetConfiguration: banned('getPetConfiguration'), PetSettingsError};
    if (id.endsWith('/pets/state.js')) return {PetError, cancelPetRequest: banned('cancelPetRequest')};
    if (id.endsWith('/pets/runtime.js')) return {getPetRuntime: banned('getPetRuntime')};
    if (id.endsWith('/pets/selection.js')) return {selectOwnPetPlayback: banned('selectOwnPetPlayback')};
    throw new Error(`unexpected import ${id}`);
}
const service = load(read(PINS[1][0]), PINS[1][0], resolve);
const routes = load(read(PINS[2][0]), PINS[2][0], resolve);
const tokenDesktop = `dima_at_${'a'.repeat(43)}`;
const tokenProfile = `dima_at_${'b'.repeat(43)}`;
const code = 'c'.repeat(43);
const verifier = 'd'.repeat(43);
const refresh = `dima_rt_${'e'.repeat(43)}`;
function identity(scopes) {
    return JSON.stringify({
        session_id: SESSION_ID,
        user_id: USER_ID,
        client_id: 'dima-desktop',
        channel_id: '12345',
        scopes,
    });
}
oracle.access.set(`oauth:access:${service.hash(tokenDesktop)}`, identity(['desktop:connect']));
oracle.access.set(`oauth:access:${service.hash(tokenProfile)}`, identity(['profile:read']));
global.fetch = () => { throw new Error('fetch is outside the mongo-free oracle'); };
const notComparable = [
    'full authorize/approve/token/refresh/reuse/revoke (GETDEL atomicity, refresh reuse CAS, session rotation, index installation, ObjectId persistence)',
    'browser-session and decision (real Twitch validate HTTP plus user lookup)',
    'connections and grants list-and-delete',
    'GET /v1/me success body (needs findById user document)',
    'GET /v1/desktop/session',
    'credits and all four pet routes (real adapters, also cross-team)',
    'desktop websocket (separate server upgrade, not Express; covered by native loopback tests)',
    'websocket 5s timeout and 15s heartbeat (time-based)',
    'application/x-www-form-urlencoded duplicate keys (express.urlencoded is not mounted)',
];
const secret = 'c'.repeat(8);
const specs = [
    {name: 'metadata', comparison: 'metadata-json', mount: 'oauth', method: 'GET', path: '/oauth/metadata'},
    {name: 'metadata-matching-origin', comparison: 'metadata-json', mount: 'oauth', method: 'GET', path: '/oauth/metadata', origin: WEBSITE},
    {name: 'metadata-origin-reject', comparison: 'error-json', mount: 'oauth', method: 'GET', path: '/oauth/metadata', origin: 'https://evil.example'},
    {name: 'metadata-options', comparison: 'options', mount: 'oauth', method: 'OPTIONS', path: '/oauth/metadata', origin: WEBSITE},
    {name: 'metadata-rate-limit', comparison: 'error-json', mount: 'oauth', method: 'GET', path: '/oauth/metadata', forceCount: 601},
    {name: 'token-unsupported', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'unsupported_grant_type', body: {grant_type: 'client_credentials', client_id: 'dima-desktop'}},
    {name: 'token-missing-grant', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'unsupported_grant_type', body: {client_id: 'dima-desktop'}},
    {name: 'token-client-secret', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'invalid_client', body: {grant_type: 'authorization_code', client_id: 'dima-desktop', client_secret: secret}},
    {name: 'token-authorization-header', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'invalid_client', authorization: 'Bearer abc', body: {grant_type: 'authorization_code', client_id: 'dima-desktop'}},
    {name: 'token-numeric-field', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'invalid_request', body: {grant_type: 'authorization_code', code: 1}},
    {name: 'token-array-body', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'invalid_request', rawBody: '[]'},
    {name: 'token-authorization-code', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'authorization_code', body: {grant_type: 'authorization_code', client_id: 'dima-desktop', code, code_verifier: verifier}},
    {name: 'token-refresh', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'refresh_token', body: {grant_type: 'refresh_token', client_id: 'dima-desktop', refresh_token: refresh}},
    {name: 'token-unknown-client', comparison: 'error-json', mount: 'oauth', method: 'POST', path: '/oauth/token', dispatch: 'invalid_client', body: {grant_type: 'authorization_code', client_id: 'unknown-client', code, code_verifier: verifier}},
    {name: 'auth-before-query', comparison: 'ordering', mount: 'desktop', method: 'GET', path: '/v1/me?extra=1'},
    {name: 'auth-invalid-bearer', comparison: 'ordering', mount: 'desktop', method: 'GET', path: '/v1/me?extra=1', authorization: 'Bearer not-a-token'},
    {name: 'scope-before-query', comparison: 'ordering', mount: 'desktop', method: 'GET', path: '/v1/me?extra=1', authorization: `Bearer ${tokenDesktop}`},
    {name: 'query-after-scope', comparison: 'ordering', mount: 'desktop', method: 'GET', path: '/v1/me?extra=1', authorization: `Bearer ${tokenProfile}`},
    {name: 'not-found-oauth', comparison: 'not-found', mount: 'oauth', method: 'GET', path: '/oauth/no-such'},
    {name: 'not-found-post-metadata', comparison: 'not-found', mount: 'oauth', method: 'POST', path: '/oauth/metadata'},
    {name: 'not-found-desktop', comparison: 'not-found', mount: 'desktop', method: 'GET', path: '/v1/no-such'},
    {name: 'redis-failure-503', comparison: 'error-json', mount: 'oauth', method: 'GET', path: '/oauth/metadata', forceError: true},
    {name: 'malformed-json', comparison: 'express-parse', mount: 'oauth', method: 'POST', path: '/oauth/token', rawBody: '{'},
];
function header(response, name) {
    return response.headers.get(name);
}
function callsOf() {
    const evals = oracle.calls.evals;
    return {
        rateLimitEvals: evals.length,
        rateLimitScript: evals[0]?.script ?? null,
        rateLimitKey: evals[0]?.key ?? null,
        rateLimitCount: evals[0]?.count ?? null,
        accessGets: oracle.calls.gets.filter(key => String(key).startsWith('oauth:access:')).length,
        codeGets: oracle.calls.gets.filter(key => String(key).startsWith('oauth:code:')).length,
        clientFinds: oracle.calls.clientFinds,
        refreshFinds: oracle.calls.refreshFinds,
        usersFindById: oracle.calls.findById,
        log: oracle.calls.logs,
    };
}
function deviation(spec, response) {
    if (spec.comparison === 'options') {
        return {nativeStatus: 204, nativeBody: '', note: 'Express sendStatus(204) sends text/plain No Content. The native body is empty.'};
    }
    if (spec.comparison === 'express-parse') {
        return {
            status: 400,
            error: 'invalid_request',
            boundaryHeaders: true,
            note: 'Express body-parser answers before the OAuth error handler. Native answers 400 invalid_request and the boundary still sets the security headers. The HTML body is not compared.',
        };
    }
    return null;
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
(async () => {
    const [mode, directory, ...extra] = process.argv.slice(2);
    assert(mode === '--write' || mode === '--check');
    assert(directory && path.isAbsolute(directory) && extra.length === 0);
    assert.equal(fs.realpathSync(directory), directory);
    assert(directory !== root && !directory.startsWith(root + path.sep));
    if (mode === '--write') assert.deepEqual(fs.readdirSync(directory), []);
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());
    app.use('/oauth', routes.oauthRoute);
    app.use('/v1', routes.oauthApiRoute);
    const server = http.createServer(app);
    const originalError = console.error;
    console.error = (...args) => {
        oracle.calls.logs.push(args.map(arg => (arg instanceof Error ? arg.name : String(arg))));
    };
    try {
        const port = await listen(server);
        const cases = [];
        for (const spec of specs) {
            resetCalls();
            oracle.forceCount = spec.forceCount ?? null;
            oracle.forceError = spec.forceError ? new Error('redis down') : null;
            const headers = {};
            if (spec.origin) headers.origin = spec.origin;
            if (spec.authorization) headers.authorization = spec.authorization;
            let raw = spec.rawBody ?? null;
            if (raw === null && spec.body !== undefined) raw = JSON.stringify(spec.body);
            if (raw !== null) headers['content-type'] = 'application/json';
            const response = await fetch(`http://127.0.0.1:${port}${spec.path}`, {method: spec.method, headers, body: raw ?? undefined});
            const text = await response.text();
            const contentType = header(response, 'content-type');
            cases.push({
                name: spec.name,
                comparison: spec.comparison,
                mount: spec.mount,
                dispatch: spec.dispatch ?? null,
                request: {
                    method: spec.method,
                    path: spec.path,
                    origin: spec.origin ?? null,
                    authorization: spec.authorization ?? null,
                    body: spec.body ?? null,
                    rawBody: spec.rawBody ?? null,
                },
                expected: {
                    status: response.status,
                    contentType,
                    bodyText: spec.comparison === 'express-parse' ? null : text,
                    error: contentType?.startsWith('application/json') ? JSON.parse(text).error ?? null : null,
                    headers: {
                        'cache-control': header(response, 'cache-control'),
                        pragma: header(response, 'pragma'),
                        'referrer-policy': header(response, 'referrer-policy'),
                        'x-content-type-options': header(response, 'x-content-type-options'),
                    },
                    cors: {
                        origin: header(response, 'access-control-allow-origin'),
                        vary: header(response, 'vary'),
                        headers: header(response, 'access-control-allow-headers'),
                        methods: header(response, 'access-control-allow-methods'),
                    },
                    wwwAuthenticate: header(response, 'www-authenticate'),
                    retryAfter: header(response, 'retry-after'),
                },
                calls: callsOf(),
                nativeDeviation: deviation(spec, response),
            });
            oracle.forceCount = null;
            oracle.forceError = null;
        }
        const rendered = JSON.stringify({
            sources: PINS.map(([file, sha256]) => ({file, sha256})),
            typescript: ts.version,
            node: process.versions.node,
            express: expressVersion,
            rateLimitLua: RATE_LIMIT_LUA,
            output: 'oauth-api-reference.json',
            formDuplicateCoverage: false,
            notComparable,
            cases,
        }, null, 2) + '\n';
        const target = path.join(directory, 'oauth-api-reference.json');
        if (mode === '--write') fs.writeFileSync(target, rendered, {flag: 'wx'});
        else assert.equal(fs.readFileSync(target, 'utf8'), rendered);
        console.log(`${mode} ${target} sha256=${crypto.createHash('sha256').update(rendered).digest('hex')}`);
    } finally {
        console.error = originalError;
        await close(server);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
