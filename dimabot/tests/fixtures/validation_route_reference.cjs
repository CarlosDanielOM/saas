'use strict';
// Source oracle for the native validation-route port.
//
// The actual `src/server/routes/validation.route.ts` is transpiled by the pinned
// TypeScript compiler and mounted in the pinned Express. Only the route's two
// application-specific imports are doubled at that native boundary:
// `getDragonflyClient` (recording cache with injectable failures) and
// `authMiddleware` (pass-through recorder, so the route handler's own branches
// are observable). The middleware's 401 gate is source-proven separately by
// `tests/fixtures/api_auth_reference.cjs` (`no-header`, `bearer-empty`).
//
//   node tests/fixtures/validation_route_reference.cjs --write <absolute dir>
//   node tests/fixtures/validation_route_reference.cjs --check <absolute dir>
//
// `--write` creates the reference exclusively; `--check` requires an exact byte
// match. Requests travel over loopback HTTP; no production or external service
// is contacted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const http = require('node:http');

const root = fs.realpathSync(
    process.env.DIMA_VALIDATION_ROUTE_SOURCE_ROOT || path.resolve(__dirname, '../..'),
);
const read = relative => fs.readFileSync(path.join(root, relative));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const sourceFile = 'src/server/routes/validation.route.ts';
const pins = {
    [sourceFile]: '80b0ce5be0ffb248d3cedadfa063ecdb389de95f6e8b832ee57e4d049096f46e',
    'src/utils/databases/dragonfly.database.ts':
        '0d08dd4cdb931633473227fb59f043251b7be59a09a034ef6f392e0f64aebe9c',
    'src/middleware/auth.middleware.ts':
        '9ff83234e83278aa4b1c1059fda6e95bb7d2bf2025a9d87e420257561181cfb5',
    'node_modules/typescript/lib/typescript.js':
        '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
    'node_modules/express/package.json':
        'c7db3b72582355c80cdcef1ad7b2c9a8f53557550724c6bef8502e9818c2ebe7',
};
for (const [relative, expected] of Object.entries(pins)) {
    assert.equal(sha(read(relative)), expected, relative);
}
assert.equal(
    sha(fs.readFileSync(process.execPath)),
    '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108',
    'pinned Node binary',
);
assert.equal(process.versions.node, '24.22.1');

const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
assert.equal(ts.version, '5.9.3');
const express = local('express');
assert.equal(local('express/package.json').version, '4.22.2');

const sourceBytes = read(sourceFile);
const sourceText = sourceBytes.toString('utf8');
const sourceAst = ts.createSourceFile(sourceFile, sourceText, ts.ScriptTarget.ES2022, true);
assert.deepEqual(sourceAst.parseDiagnostics, []);
const exportedNames = sourceAst.statements
    .filter(
        statement =>
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .flatMap(statement =>
        statement.declarationList.declarations.map(declaration => declaration.name.getText()),
    );
assert.deepEqual(exportedNames, ['validationRoute'], 'route exports');

const compiled = ts.transpileModule(sourceText, {
    fileName: sourceFile,
    reportDiagnostics: true,
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
    },
});
assert(!compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error));

let scenario;
const requireCalls = [];
const routeRequire = specifier => {
    requireCalls.push(specifier);
    if (specifier === 'express') return express;
    if (specifier === '../../utils/databases/dragonfly.database.js') {
        return {
            getDragonflyClient: async caller => {
                scenario.acquisitions.push(caller);
                if (scenario.clientError) throw new Error('connect ECONNREFUSED 127.0.0.1:1');
                return scenario.cache.client;
            },
        };
    }
    if (specifier === '../../middleware/auth.middleware.js') {
        return {
            authMiddleware: (request, _response, next) => {
                scenario.authCalls.push(request.headers.authorization ?? null);
                next();
            },
        };
    }
    throw new Error(`unexpected route require: ${specifier}`);
};
const moduleRecord = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputText)(
    routeRequire,
    moduleRecord,
    moduleRecord.exports,
);
const router = moduleRecord.exports.validationRoute;
assert(router, 'validationRoute export');
const layers = router.stack
    .filter(layer => layer.route)
    .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).filter(method => layer.route.methods[method]),
    }));
assert.deepEqual(layers, [{ path: '/:channelID', methods: ['post'] }], 'router shape');

const buildCache = seed => {
    const hash = seed.hash ? JSON.parse(JSON.stringify(seed.hash)) : {};
    const sets = seed.sets ? JSON.parse(JSON.stringify(seed.sets)) : {};
    const keys = new Set(seed.keys || []);
    const commands = [];
    const seen = { HGET: 0, SISMEMBER: 0, EXISTS: 0 };
    const fail = name => {
        seen[name] += 1;
        const failure = scenario.cacheError;
        if (failure && failure.command === name && seen[name] > (failure.skip || 0)) {
            throw new Error(`cache command failed: ${name}`);
        }
    };
    const client = {
        async hGet(key, field) {
            commands.push(['HGET', key, field]);
            fail('HGET');
            const fields = Object.prototype.hasOwnProperty.call(hash, key) ? hash[key] : null;
            const value = fields && Object.prototype.hasOwnProperty.call(fields, field)
                ? fields[field]
                : null;
            return value;
        },
        async sIsMember(key, member) {
            commands.push(['SISMEMBER', key, member]);
            fail('SISMEMBER');
            return (sets[key] || []).includes(member) ? 1 : 0;
        },
        async exists(key) {
            commands.push(['EXISTS', key]);
            fail('EXISTS');
            return keys.has(key) ? 1 : 0;
        },
    };
    return { client, commands };
};

// Route-handler branches only: the auth double always calls next().
const hash = (key, id, login) => ({ [key]: { id, login } });
const cases = [
    {
        name: 'owner-cached-raw',
        request: { path: '/owner-channel', channel: 'owner-channel', headerName: 'authorization', authorization: 'owner-token' },
        seed: { hash: hash('token:owner-token', 'owner-channel', 'owner') },
    },
    {
        name: 'owner-cached-bearer-raw-key',
        request: { path: '/owner-channel', channel: 'owner-channel', headerName: 'authorization', authorization: 'Bearer owner-token' },
        seed: { hash: hash('token:Bearer owner-token', 'owner-channel', 'owner') },
    },
    {
        name: 'bearer-cached-stripped-only',
        request: { path: '/owner-channel', channel: 'owner-channel', headerName: 'authorization', authorization: 'Bearer owner-token' },
        seed: { hash: hash('token:owner-token', 'owner-channel', 'owner') },
    },
    {
        name: 'admin-member-and-details',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'admin-token' },
        seed: {
            hash: hash('token:admin-token', 'admin-user', 'moduser'),
            sets: { 'twitch:channel-1:admins': ['moduser'] },
            keys: ['twitch:channel-1:admins:admin-user'],
        },
    },
    {
        name: 'admin-member-no-details',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'admin-token' },
        seed: {
            hash: hash('token:admin-token', 'admin-user', 'moduser'),
            sets: { 'twitch:channel-1:admins': ['moduser'] },
        },
    },
    {
        name: 'admin-not-member',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'viewer-token' },
        seed: { hash: hash('token:viewer-token', 'viewer-user', 'viewer') },
    },
    {
        name: 'invalid-token-missing-hash',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'unknown-token' },
        seed: {},
    },
    {
        name: 'invalid-token-empty-id',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'empty-id-token' },
        seed: { hash: hash('token:empty-id-token', '', 'moduser') },
    },
    {
        name: 'invalid-token-missing-login',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'no-login-token' },
        seed: { hash: { 'token:no-login-token': { id: 'admin-user' } } },
    },
    {
        name: 'missing-token',
        request: { path: '/channel-1', channel: 'channel-1' },
        seed: {},
    },
    {
        name: 'empty-token-header',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: '' },
        seed: {},
    },
    {
        name: 'channel-percent-encoded',
        request: { path: '/chan%20nel', channel: 'chan nel', headerName: 'authorization', authorization: 'space-token' },
        seed: { hash: hash('token:space-token', 'chan nel', 'owner') },
    },
    {
        name: 'header-name-capitalized',
        request: { path: '/owner-channel', channel: 'owner-channel', headerName: 'Authorization', authorization: 'owner-token' },
        seed: { hash: hash('token:owner-token', 'owner-channel', 'owner') },
    },
    {
        name: 'duplicate-authorization-lines',
        request: { path: '/owner-channel', channel: 'owner-channel', duplicateAuthorization: ['dup-one', 'dup-two'] },
        seed: {},
    },
    {
        name: 'hget-id-error',
        request: {
            path: '/owner-channel',
            channel: 'owner-channel',
            headerName: 'authorization',
            authorization: 'owner-token',
            cacheError: { command: 'HGET' },
        },
        seed: { hash: hash('token:owner-token', 'owner-channel', 'owner') },
    },
    {
        name: 'hget-login-error',
        request: {
            path: '/owner-channel',
            channel: 'owner-channel',
            headerName: 'authorization',
            authorization: 'owner-token',
            cacheError: { command: 'HGET', skip: 1 },
        },
        seed: { hash: hash('token:owner-token', 'owner-channel', 'owner') },
    },
    {
        name: 'sismember-error',
        request: {
            path: '/channel-1',
            channel: 'channel-1',
            headerName: 'authorization',
            authorization: 'admin-token',
            cacheError: { command: 'SISMEMBER' },
        },
        seed: { hash: hash('token:admin-token', 'admin-user', 'moduser') },
    },
    {
        name: 'exists-error',
        request: {
            path: '/channel-1',
            channel: 'channel-1',
            headerName: 'authorization',
            authorization: 'admin-token',
            cacheError: { command: 'EXISTS' },
        },
        seed: {
            hash: hash('token:admin-token', 'admin-user', 'moduser'),
            sets: { 'twitch:channel-1:admins': ['moduser'] },
        },
    },
    {
        name: 'acquire-error',
        request: { path: '/channel-1', channel: 'channel-1', headerName: 'authorization', authorization: 'admin-token', clientError: true },
        seed: {},
    },
];

const unhandled = [];
process.on('unhandledRejection', reason => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
});
let consoleErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
    consoleErrors.push(args);
};

const normalizeLog = args => {
    assert.equal(args.length, 4, 'console.error payload, flag, channel and tag');
    const [payload, flag, channel, tag] = args;
    assert.equal(flag, true);
    assert.equal(typeof payload, 'object');
    const copy = { ...payload };
    if (Object.prototype.hasOwnProperty.call(copy, 'timestamp')) {
        assert.equal(typeof copy.timestamp, 'string');
        assert.equal(copy.timestamp.length, 24, copy.timestamp);
        assert.match(copy.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        copy.timestamp = '<timestamp>';
    }
    return { payload: copy, channel, tag };
};

const listen = server =>
    new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

(async () => {
    const app = express();
    app.use((request, _response, next) => {
        scenario.observed.push({
            authorization: request.headers.authorization ?? null,
            capitalized: request.headers.Authorization ?? null,
        });
        next();
    });
    app.use(router);
    const server = http.createServer(app);
    const base = `http://127.0.0.1:${await listen(server)}`;
    const results = [];
    for (const entry of cases) {
        const cache = buildCache(entry.seed);
        scenario = {
            cache,
            clientError: Boolean(entry.request.clientError),
            cacheError: entry.request.cacheError || null,
            acquisitions: [],
            authCalls: [],
            observed: [],
        };
        consoleErrors = [];
        const before = unhandled.length;
        let headers;
        if (entry.request.duplicateAuthorization) {
            headers = new Headers();
            for (const value of entry.request.duplicateAuthorization) {
                headers.append('authorization', value);
            }
        } else {
            headers = {};
            if (entry.request.headerName) headers[entry.request.headerName] = entry.request.authorization;
        }
        let expected;
        if (entry.request.cacheError || entry.request.clientError) {
            let aborted = null;
            try {
                await fetch(base + entry.request.path, {
                    method: 'POST',
                    headers,
                    redirect: 'manual',
                    signal: AbortSignal.timeout(250),
                });
            } catch (error) {
                aborted = error.name;
            }
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(aborted, 'TimeoutError', `${entry.name}: source must not answer`);
            assert.equal(unhandled.length, before + 1, `${entry.name}: unhandled rejection`);
            expected = {
                noResponse: true,
                aborted,
                unhandledRejection: unhandled.at(-1),
                acquisitions: scenario.acquisitions,
                commands: cache.commands,
                logs: consoleErrors.map(normalizeLog),
            };
        } else {
            const reply = await fetch(base + entry.request.path, {
                method: 'POST',
                headers,
                redirect: 'manual',
            });
            const body = await reply.text();
            expected = {
                status: reply.status,
                body: JSON.parse(body),
                contentType: reply.headers.get('content-type'),
                acquisitions: scenario.acquisitions,
                commands: cache.commands,
                logs: consoleErrors.map(normalizeLog),
            };
        }
        assert.equal(scenario.authCalls.length, 1, `${entry.name}: auth double called once`);
        results.push({
            name: entry.name,
            request: {
                method: 'POST',
                path: entry.request.path,
                channel: entry.request.channel,
                headerName: entry.request.headerName ?? null,
                authorization: entry.request.authorization ?? null,
                duplicateAuthorization: entry.request.duplicateAuthorization ?? null,
                clientError: Boolean(entry.request.clientError),
                cacheError: entry.request.cacheError ?? null,
            },
            seed: entry.seed,
            expected,
            observed: {
                authorization: scenario.observed.at(-1)?.authorization ?? null,
                capitalized: scenario.observed.at(-1)?.capitalized ?? null,
            },
        });
    }
    await close(server);
    console.error = originalConsoleError;
    const text = `${JSON.stringify(
        {
            source: { file: sourceFile, sha256: pins[sourceFile] },
            pins,
            runtime: {
                node: process.versions.node,
                typescript: ts.version,
                express: local('express/package.json').version,
            },
            route: { export: 'validationRoute', path: layers[0].path, methods: layers[0].methods },
            requireCalls,
            cases: results,
        },
        null,
        2,
    )}\n`;
    const [mode, directory] = process.argv.slice(2);
    assert(['--write', '--check'].includes(mode) && directory && path.isAbsolute(directory));
    const target = path.join(directory, 'validation-route-reference.json');
    if (mode === '--write') {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(target, text, { flag: 'wx' });
    } else {
        assert.equal(fs.readFileSync(target, 'utf8'), text);
    }
    console.log(
        `${mode} ${target} cases=${results.length} sha256=${crypto.createHash('sha256').update(text).digest('hex')}`,
    );
})().catch(error => {
    console.error = originalConsoleError;
    originalConsoleError(error);
    process.exitCode = 1;
});
