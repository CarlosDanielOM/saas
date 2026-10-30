'use strict';
// Source oracle for the native admin-permission middleware port.
//
// The three middleware declarations below are extracted from the actual
// `src/middleware/admin.middleware.ts`, `src/middleware/channel_permissions.ts`
// and `src/middleware/workspace-owner.middleware.ts` text and transpiled by the
// pinned TypeScript compiler; no policy or behavior is re-implemented here.
// Only the module's external boundaries are doubled: the `AdminSchema` Mongoose
// model (an equality/`$in` matcher over in-memory rows, plus `select().lean()`),
// the shared `error` logger and the diagnostic `console`.
//
//   node tests/fixtures/api_admin_reference.cjs --write <absolute dir>
//   node tests/fixtures/api_admin_reference.cjs --check <absolute dir>
//
// `--write` creates the reference exclusively; `--check` requires an exact
// byte match. The native test replays the expected statuses/bodies against a
// real loopback Axum app and a task-owned MongoDB database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');

const root = fs.realpathSync(process.env.DIMA_API_ADMIN_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const read = relative => fs.readFileSync(path.join(root, relative));
const readText = relative => read(relative).toString('utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const adminFile = 'src/middleware/admin.middleware.ts';
const channelFile = 'src/middleware/channel_permissions.ts';
const workspaceFile = 'src/middleware/workspace-owner.middleware.ts';
const loggerFile = 'src/utils/logger.ts';
const routeFile = 'src/server/routes/admin.route.ts';

const pins = {
    [adminFile]: 'f0a4fc3f23d3ba8b355f701b3fc5189ffb31498317205ca06bee90d02a764a49',
    [channelFile]: '2743fa9f21e3e0b441185382b9e2c412b707248627cc6cd879a65aeeb92ea17a',
    [workspaceFile]: '2dcf14a2ef2b16be61ab7502510890c124c9bf81685edb1167ef6ffefb6fff87',
    [loggerFile]: '0c0c94539974a230ecad4a5a4236dfa6b53c2ce3f4242b3f58a558109407bc6d',
    [routeFile]: '1ce4c31b7c229374549b65c225ecd2e09f7d90c1db1f92e0d9735ce067519e31',
};
for (const [relative, expected] of Object.entries(pins)) {
    assert.equal(sha(read(relative)), expected, relative);
}

const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
assert.equal(ts.version, '5.9.3');

const parse = file => {
    const ast = ts.createSourceFile(file, readText(file), ts.ScriptTarget.ES2022, true);
    assert.deepEqual(ast.parseDiagnostics, []);
    return ast;
};
const adminAst = parse(adminFile);
const channelAst = parse(channelFile);
const workspaceAst = parse(workspaceFile);

const isImport = statement => ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement);
const statementsOf = ast => ast.statements.filter(statement => !isImport(statement));
const declarationName = statement => {
    if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return statement.name.text;
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map(declaration => declaration.name.getText()).join(',');
    return null;
};
const isExported = statement => Boolean(statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const evidenceOf = (ast, statements) => statements.map(statement => ({
    name: declarationName(statement),
    kind: ts.SyntaxKind[statement.kind],
    exported: isExported(statement),
}));

const adminStatements = statementsOf(adminAst);
const channelStatements = statementsOf(channelAst);
const workspaceStatements = statementsOf(workspaceAst);

const adminEvidence = evidenceOf(adminAst, adminStatements);
const channelEvidence = evidenceOf(channelAst, channelStatements);
const workspaceEvidence = evidenceOf(workspaceAst, workspaceStatements);

const adminNames = adminEvidence.map(entry => entry.name);
for (const name of [
    'CREATOR_TWITCH_USER_ID',
    'GLOBAL_ADMIN_ROLES',
    'normalizeAdminRole',
    'isCreatorUser',
    'isCreatorTarget',
    'canModifyCreatorAdminAssignment',
    'getGlobalAdminRole',
    'hasGlobalChannelOwnerAccess',
    'expandChannelPermissionChecks',
    'getChannelAccessContext',
    'MAX_ACCESS_PERMISSIONS',
    'parsePermissionList',
    'resolveGrantedPermissions',
    'getChannelAccessDecisions',
    'adminMiddleware',
]) {
    assert(adminNames.includes(name), name);
}

const channelNames = channelEvidence.map(entry => entry.name);
for (const name of [
    'CHANNEL_ADMIN_PERMISSIONS',
    'CHANNEL_WEBSITE_ACCESS_PERMISSIONS',
    'parseChannelAdminPermissions',
    'grantsChatAdminRole',
]) {
    assert(channelNames.includes(name), name);
}
const workspaceNames = workspaceEvidence.map(entry => entry.name);
assert(workspaceNames.includes('workspaceOwnerMiddleware'));
for (const name of ['adminMiddleware', 'CREATOR_TWITCH_USER_ID', 'getChannelAccessDecisions']) {
    assert(adminEvidence.find(entry => entry.name === name)?.exported, `${name} exported`);
}
for (const name of ['parseChannelAdminPermissions', 'grantsChatAdminRole', 'CHANNEL_ADMIN_PERMISSIONS']) {
    assert(channelEvidence.find(entry => entry.name === name)?.exported, `${name} exported`);
}
const adminMiddlewareStatement = adminStatements.find(statement => declarationName(statement) === 'adminMiddleware');
assert(ts.isFunctionDeclaration(adminMiddlewareStatement), 'adminMiddleware declaration');
assert.deepEqual(adminMiddlewareStatement.parameters.map(parameter => parameter.type.getText(adminAst)), [
    'AuthRequest',
    'Response',
    'NextFunction',
]);
assert.equal(adminMiddlewareStatement.type.getText(adminAst), 'Promise<void>');

const workspaceMiddlewareStatement = workspaceStatements.find(statement => declarationName(statement) === 'workspaceOwnerMiddleware');
assert(ts.isFunctionDeclaration(workspaceMiddlewareStatement), 'workspaceOwnerMiddleware declaration');
assert.deepEqual(workspaceMiddlewareStatement.parameters.map(parameter => parameter.type.getText(workspaceAst)), [
    'Request',
    'Response',
    'NextFunction',
]);
assert.equal(workspaceMiddlewareStatement.type.getText(workspaceAst), 'void');

// Both admin add/remove routes still enforce the creator-assignment policy.
const policyCallSites = readText(routeFile).match(
    /!canModifyCreatorAdminAssignment\(requesterID, channelIdStr, (?:twitchAccount\.id|adminIdStr)\)/g
);
assert.equal(policyCallSites?.length, 2, 'creator assignment policy call sites');

const transpile = (ast, statements) => {
    const sourceText = statements.map(statement => statement.getText(ast)).join('\n\n');
    const transpiled = ts.transpileModule(sourceText, {
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true,
    });
    assert.deepEqual(transpiled.diagnostics, []);
    return transpiled;
};
const adminTranspiled = transpile(adminAst, adminStatements);
const channelTranspiled = transpile(channelAst, channelStatements);
const workspaceTranspiled = transpile(workspaceAst, workspaceStatements);

const evaluate = (transpiled, context) => {
    const names = Object.keys(context);
    const run = new Function(...names, 'exports', `${transpiled.outputText}\nreturn exports;`);
    return run(...names.map(name => context[name]), {});
};

const channelApi = evaluate(channelTranspiled, {});
const workspaceApi = evaluate(workspaceTranspiled, {});
assert.equal(typeof channelApi.parseChannelAdminPermissions, 'function');
assert.equal(typeof channelApi.grantsChatAdminRole, 'function');
assert.equal(typeof workspaceApi.workspaceOwnerMiddleware, 'function');

function normalize(value) {
    if (value instanceof Date) return '<date>';
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
}

// Mongo query double: equality on scalars and `$in` against a scalar or array
// field, which is every filter shape these three modules issue.
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function matches(row, filter) {
    return Object.entries(filter).every(([field, condition]) => {
        const value = row[field];
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
            const keys = Object.keys(condition);
            assert.deepEqual(keys, ['$in'], `unsupported filter operator ${keys.join(',')}`);
            if (Array.isArray(value)) return value.some(entry => condition.$in.includes(entry));
            return condition.$in.includes(value);
        }
        return value === condition;
    });
}
function project(row, select) {
    if (!select) return { ...row };
    const fields = String(select).trim().split(/\s+/);
    const projected = {};
    for (const field of fields) if (has(row, field)) projected[field] = row[field];
    if (has(row, '_id')) projected._id = row._id;
    return projected;
}

function adminHarness(initialRows, options = {}) {
    const state = {
        rows: initialRows.map(row => ({ ...row })),
        mongoLog: [],
        errorLog: [],
        consoleLog: [],
    };
    const query = (op, filter) => {
        let select = null;
        const execute = async () => {
            state.mongoLog.push({ op, filter: normalize(filter), select });
            if (options.mongoError) throw new Error('injected:mongo');
            const matched = state.rows
                .filter(row => matches(row, filter))
                .map(row => project(row, select));
            return op === 'findOne' ? (matched[0] ?? null) : matched;
        };
        const handle = {
            select(projection) {
                select = projection;
                return handle;
            },
            lean() {
                return execute();
            },
            then(resolve, reject) {
                return execute().then(resolve, reject);
            },
        };
        return handle;
    };
    const context = {
        AdminSchema: {
            find(filter) {
                return query('find', filter);
            },
            findOne(filter) {
                return query('findOne', filter);
            },
        },
        error: async (data, logOptions) => {
            state.errorLog.push({ data: normalize(data), options: logOptions });
            return { success: true };
        },
        console: {
            log: function log() {
                state.consoleLog.push([...arguments]);
            },
        },
    };
    return { api: evaluate(adminTranspiled, context), state };
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

const errorLogFunctions = state => state.errorLog.map(entry => entry.data.function);

async function middlewareScenario(spec) {
    const harness = adminHarness(spec.rows || [], { mongoError: spec.mongoError === true });
    const request = { user: spec.userId === null ? undefined : { id: spec.userId, login: 'fixture', display_name: 'Fixture' } };
    const response = responseRecorder();
    let nextCalls = 0;
    const next = () => {
        nextCalls += 1;
        if (response.statusCode === null) {
            response.statusCode = 200;
            response.body = {
                globalAdminRole: request.globalAdminRole ?? null,
                isSuperAdmin: has(request, 'isSuperAdmin') ? request.isSuperAdmin : null,
                next: nextCalls,
            };
        }
    };
    await harness.api.adminMiddleware(request, response, next);
    return {
        name: spec.name,
        userId: spec.userId,
        rows: spec.rows || [],
        mongoError: spec.mongoError === true,
        expected: {
            status: response.statusCode,
            body: response.body,
            next: nextCalls,
            errorLog: errorLogFunctions(harness.state),
            queries: harness.state.mongoLog.length,
        },
    };
}

async function helperScenario(spec) {
    const harness = adminHarness(spec.rows || []);
    const api = harness.api;
    let value;
    switch (spec.function) {
        case 'getGlobalAdminRole':
            value = await api.getGlobalAdminRole(...spec.args);
            break;
        case 'hasGlobalChannelOwnerAccess':
            value = await api.hasGlobalChannelOwnerAccess(...spec.args);
            break;
        case 'getChannelAccessContext':
            value = await api.getChannelAccessContext(...spec.args);
            break;
        case 'getChannelAccessDecisions':
            value = await api.getChannelAccessDecisions(...spec.args);
            break;
        default:
            throw new Error(`unknown helper ${spec.function}`);
    }
    return {
        name: spec.name,
        function: spec.function,
        args: spec.args,
        rows: spec.rows || [],
        expected: { value: normalize(value), queries: harness.state.mongoLog.length },
    };
}

const decodeArg = value => {
    if (value && typeof value === 'object' && value.$undefined === true) return undefined;
    return value;
};

function pureScenario(spec, api) {
    const fn = api[spec.function];
    assert.equal(typeof fn, 'function', spec.function);
    const value = fn(...spec.args.map(decodeArg));
    return { name: spec.name, function: spec.function, args: spec.args, expected: normalize(value) };
}

function channelScenario(spec) {
    return pureScenario(spec, channelApi);
}

function workspaceScenario(spec) {
    const request = { user: spec.userId === null ? undefined : { id: spec.userId } };
    const response = responseRecorder();
    let nextCalls = 0;
    workspaceApi.workspaceOwnerMiddleware(request, response, () => {
        nextCalls += 1;
        if (response.statusCode === null) {
            response.statusCode = 200;
            response.body = { next: nextCalls };
        }
    });
    return {
        name: spec.name,
        userId: spec.userId,
        expected: { status: response.statusCode, body: response.body, next: nextCalls },
    };
}

const adminRow = (overrides = {}) => ({ actived: true, ...overrides });

async function middlewareCases() {
    const cases = [];
    const add = async spec => cases.push(await middlewareScenario(spec));

    await add({ name: 'unauthenticated', userId: null, rows: [] });
    await add({ name: 'empty-id', userId: '', rows: [] });
    await add({ name: 'no-admin-row', userId: 'user-1', rows: [] });
    await add({ name: 'inactive-admin', userId: 'user-1', rows: [adminRow({ adminID: 'user-1', actived: false, role: 'super' })] });
    await add({
        name: 'channel-admin-passes',
        userId: 'user-1',
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', role: 'channel', permissions: ['commands:view'] })],
    });
    await add({ name: 'support-admin-passes', userId: 'user-1', rows: [adminRow({ adminID: 'user-1', role: 'support' })] });
    await add({ name: 'super-admin-passes', userId: 'user-1', rows: [adminRow({ adminID: 'user-1', role: 'super' })] });
    await add({ name: 'creator-admin-passes', userId: 'user-1', rows: [adminRow({ adminID: 'user-1', role: 'creator' })] });
    await add({ name: 'creator-without-row-is-denied', userId: '533538623', rows: [] });
    await add({
        name: 'creator-with-inactive-row-is-denied',
        userId: '533538623',
        rows: [adminRow({ adminID: '533538623', actived: false, role: 'creator' })],
    });
    await add({ name: 'missing-role-passes', userId: 'user-1', rows: [adminRow({ adminID: 'user-1' })] });
    await add({ name: 'unknown-role-passes', userId: 'user-1', rows: [adminRow({ adminID: 'user-1', role: 'owner' })] });
    await add({
        name: 'other-channel-row-passes',
        userId: 'user-1',
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-2', role: 'channel' })],
    });
    await add({ name: 'mongo-error', userId: 'user-1', rows: [adminRow({ adminID: 'user-1', role: 'super' })], mongoError: true });
    return cases;
}

async function helperCases() {
    const cases = [];
    const add = async spec => cases.push(await helperScenario(spec));
    const superRow = adminRow({ adminID: 'user-1', role: 'super' });

    await add({ name: 'role-absent-id', function: 'getGlobalAdminRole', args: [null], rows: [] });
    await add({ name: 'role-empty-id', function: 'getGlobalAdminRole', args: [''], rows: [] });
    await add({ name: 'role-creator-fallback', function: 'getGlobalAdminRole', args: ['533538623'], rows: [] });
    await add({
        name: 'role-creator-row',
        function: 'getGlobalAdminRole',
        args: ['user-1'],
        rows: [adminRow({ adminID: 'user-1', role: 'creator' })],
    });
    await add({ name: 'role-super-row', function: 'getGlobalAdminRole', args: ['user-1'], rows: [superRow] });
    await add({
        name: 'role-both-rows',
        function: 'getGlobalAdminRole',
        args: ['user-1'],
        rows: [superRow, adminRow({ adminID: 'user-1', role: 'creator' })],
    });
    await add({
        name: 'role-inactive-super',
        function: 'getGlobalAdminRole',
        args: ['user-1'],
        rows: [adminRow({ adminID: 'user-1', actived: false, role: 'super' })],
    });
    await add({
        name: 'role-channel-only',
        function: 'getGlobalAdminRole',
        args: ['user-1'],
        rows: [adminRow({ adminID: 'user-1', role: 'channel' })],
    });
    await add({
        name: 'role-unknown-value',
        function: 'getGlobalAdminRole',
        args: ['user-1'],
        rows: [adminRow({ adminID: 'user-1', role: 'owner' })],
    });

    await add({ name: 'owner-missing-target', function: 'hasGlobalChannelOwnerAccess', args: ['user-1', null], rows: [] });
    await add({ name: 'owner-creator-requester', function: 'hasGlobalChannelOwnerAccess', args: ['533538623', 'chan-9'], rows: [] });
    await add({
        name: 'owner-super-other-channel',
        function: 'hasGlobalChannelOwnerAccess',
        args: ['user-1', 'chan-9'],
        rows: [superRow],
    });
    await add({
        name: 'owner-super-creator-channel',
        function: 'hasGlobalChannelOwnerAccess',
        args: ['user-1', '533538623'],
        rows: [superRow],
    });
    await add({
        name: 'owner-creator-target-by-creator',
        function: 'hasGlobalChannelOwnerAccess',
        args: ['533538623', '533538623'],
        rows: [],
    });
    await add({
        name: 'owner-channel-admin',
        function: 'hasGlobalChannelOwnerAccess',
        args: ['user-1', 'chan-9'],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-9', role: 'channel', permissions: ['dashboard:view'] })],
    });

    await add({
        name: 'context-owner',
        function: 'getChannelAccessContext',
        args: ['chan-1', 'chan-1', ['dashboard:view']],
        rows: [],
    });
    await add({
        name: 'context-creator',
        function: 'getChannelAccessContext',
        args: ['533538623', 'chan-1', ['dashboard:view']],
        rows: [],
    });
    await add({
        name: 'context-super',
        function: 'getChannelAccessContext',
        args: ['user-1', 'chan-1', ['settings:manage']],
        rows: [superRow],
    });
    await add({
        name: 'context-super-creator-channel-with-grant',
        function: 'getChannelAccessContext',
        args: ['user-1', '533538623', ['dashboard:view']],
        rows: [superRow, adminRow({ adminID: 'user-1', channelID: '533538623', role: 'channel', permissions: ['dashboard:view'] })],
    });
    await add({
        name: 'context-legacy-triggers-all',
        function: 'getChannelAccessContext',
        args: ['user-1', 'chan-1', ['triggers:edit']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', permissions: ['triggers:all'] })],
    });
    await add({
        name: 'context-wildcard',
        function: 'getChannelAccessContext',
        args: ['user-1', 'chan-1', ['settings:view']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', permissions: ['*'] })],
    });
    await add({
        name: 'context-inactive-row',
        function: 'getChannelAccessContext',
        args: ['user-1', 'chan-1', ['dashboard:view']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', actived: false, permissions: ['dashboard:view'] })],
    });
    await add({
        name: 'context-unrelated-permission',
        function: 'getChannelAccessContext',
        args: ['user-1', 'chan-1', ['settings:view']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', permissions: ['commands:view'] })],
    });
    await add({
        name: 'context-dimafx-all',
        function: 'getChannelAccessContext',
        args: ['user-1', 'chan-1', ['dimafx:delete']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', permissions: ['dimafx:all'] })],
    });
    await add({
        name: 'context-missing-ids',
        function: 'getChannelAccessContext',
        args: [null, 'chan-1', ['dashboard:view']],
        rows: [],
    });

    await add({
        name: 'decisions-owner',
        function: 'getChannelAccessDecisions',
        args: ['chan-1', 'chan-1', ['analytics:view', 'billing:view']],
        rows: [],
    });
    await add({
        name: 'decisions-admin-partial',
        function: 'getChannelAccessDecisions',
        args: ['user-1', 'chan-1', ['dashboard:view', 'commands:view', 'triggers:edit']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', permissions: ['dashboard:view', 'triggers:all'] })],
    });
    await add({
        name: 'decisions-none',
        function: 'getChannelAccessDecisions',
        args: ['user-1', 'chan-1', ['dashboard:view', 'commands:view']],
        rows: [],
    });
    await add({
        name: 'decisions-global-super',
        function: 'getChannelAccessDecisions',
        args: ['user-1', 'chan-1', ['dashboard:view', 'commands:view']],
        rows: [superRow],
    });
    await add({
        name: 'decisions-duplicate-request',
        function: 'getChannelAccessDecisions',
        args: ['user-1', 'chan-1', ['dashboard:view', 'dashboard:view']],
        rows: [adminRow({ adminID: 'user-1', channelID: 'chan-1', permissions: ['dashboard:view'] })],
    });
    await add({
        name: 'decisions-missing-ids',
        function: 'getChannelAccessDecisions',
        args: [null, 'chan-1', ['analytics:view']],
        rows: [],
    });
    return cases;
}

function pureCases() {
    const cases = [];
    const add = spec => cases.push(pureScenario(spec, adminHarness([]).api));
    const tooMany = Array.from({ length: 21 }, (_, index) => `p${index}:view`).join(',');

    add({ name: 'expand-triggers-edit', function: 'expandChannelPermissionChecks', args: [['triggers:edit']] });
    add({ name: 'expand-dimafx-view', function: 'expandChannelPermissionChecks', args: [['dimafx:view']] });
    add({ name: 'expand-commands-manage', function: 'expandChannelPermissionChecks', args: [['commands:manage']] });
    add({
        name: 'expand-mixed-order',
        function: 'expandChannelPermissionChecks',
        args: [['triggers:view', '*', 'dimafx:edit', 'triggers:view']],
    });
    add({ name: 'expand-empty', function: 'expandChannelPermissionChecks', args: [[]] });

    add({ name: 'parse-absent', function: 'parsePermissionList', args: [] });
    add({ name: 'parse-single', function: 'parsePermissionList', args: ['dashboard:view, commands:view,dashboard:view'] });
    add({ name: 'parse-array', function: 'parsePermissionList', args: [['dashboard:view', 'settings:view']] });
    add({ name: 'parse-empty-string', function: 'parsePermissionList', args: [''] });
    add({ name: 'parse-injection', function: 'parsePermissionList', args: ['dashboard:view,$where'] });
    add({ name: 'parse-too-many', function: 'parsePermissionList', args: [tooMany] });
    add({ name: 'parse-null', function: 'parsePermissionList', args: [null] });
    add({ name: 'parse-max-length', function: 'parsePermissionList', args: ['a'.repeat(64)] });
    add({ name: 'parse-over-length', function: 'parsePermissionList', args: ['a'.repeat(65)] });
    add({ name: 'parse-uppercase', function: 'parsePermissionList', args: ['Dashboard:View'] });
    add({ name: 'parse-surrounding-whitespace', function: 'parsePermissionList', args: [' \u00a0dashboard:view\u3000 '] });
    add({ name: 'parse-inner-line-break', function: 'parsePermissionList', args: ['dashboard\n:view'] });
    add({ name: 'parse-unicode', function: 'parsePermissionList', args: ['permissioné'] });

    add({
        name: 'resolve-partial',
        function: 'resolveGrantedPermissions',
        args: [['dashboard:view', 'triggers:all'], ['dashboard:view', 'commands:view', 'triggers:edit']],
    });
    add({ name: 'resolve-wildcard', function: 'resolveGrantedPermissions', args: [['*'], ['dashboard:view', 'settings:view']] });
    add({ name: 'resolve-empty-granted', function: 'resolveGrantedPermissions', args: [[], ['dashboard:view']] });

    add({
        name: 'can-modify-owner',
        function: 'canModifyCreatorAdminAssignment',
        args: ['channel-owner', 'channel-owner', '533538623'],
    });
    add({
        name: 'can-modify-creator',
        function: 'canModifyCreatorAdminAssignment',
        args: ['533538623', 'another-channel', '533538623'],
    });
    add({
        name: 'can-modify-global-admin-denied',
        function: 'canModifyCreatorAdminAssignment',
        args: ['global-admin', 'channel-owner', '533538623'],
    });
    add({
        name: 'can-modify-other-target',
        function: 'canModifyCreatorAdminAssignment',
        args: ['global-admin', 'channel-owner', 'regular-admin'],
    });

    add({ name: 'is-creator-user-true', function: 'isCreatorUser', args: ['533538623'] });
    add({ name: 'is-creator-user-null', function: 'isCreatorUser', args: [null] });
    add({ name: 'is-creator-target-other', function: 'isCreatorTarget', args: ['regular-admin'] });
    return cases;
}

function channelPermissionCases() {
    const cases = [];
    const add = spec => cases.push(channelScenario(spec));
    add({ name: 'parse-wildcard', function: 'parseChannelAdminPermissions', args: [['*']] });
    add({ name: 'parse-wildcard-mixed', function: 'parseChannelAdminPermissions', args: [['*', 'commands:view']] });
    add({ name: 'parse-commands-manage', function: 'parseChannelAdminPermissions', args: [['commands:manage']] });
    add({ name: 'parse-tts-manage', function: 'parseChannelAdminPermissions', args: [['tts:manage']] });
    add({ name: 'parse-admins-view', function: 'parseChannelAdminPermissions', args: [['admins:view']] });
    add({ name: 'parse-tts-view', function: 'parseChannelAdminPermissions', args: [['tts:view']] });
    add({ name: 'parse-settings-manage', function: 'parseChannelAdminPermissions', args: [['settings:manage']] });
    add({
        name: 'parse-tts-manage-settings-view',
        function: 'parseChannelAdminPermissions',
        args: [['tts:manage', 'settings:view']],
    });
    add({ name: 'parse-chat-admin', function: 'parseChannelAdminPermissions', args: [['chat:admin']] });
    add({
        name: 'parse-chat-admin-commands-view',
        function: 'parseChannelAdminPermissions',
        args: [['chat:admin', 'commands:view']],
    });
    add({ name: 'parse-commands-view', function: 'parseChannelAdminPermissions', args: [['commands:view']] });
    add({ name: 'parse-duplicates', function: 'parseChannelAdminPermissions', args: [['commands:view', 'commands:view']] });
    add({ name: 'parse-empty-array', function: 'parseChannelAdminPermissions', args: [[]] });
    add({ name: 'parse-unknown', function: 'parseChannelAdminPermissions', args: [['owner:everything']] });
    add({ name: 'parse-mixed-type', function: 'parseChannelAdminPermissions', args: [['dashboard:view', 7]] });
    add({ name: 'parse-null', function: 'parseChannelAdminPermissions', args: [null] });
    add({ name: 'grants-wildcard', function: 'grantsChatAdminRole', args: [['*']] });
    add({ name: 'grants-existing-mixed-wildcard', function: 'grantsChatAdminRole', args: [['*', 'chat:admin']] });
    add({ name: 'grants-chat-admin', function: 'grantsChatAdminRole', args: [['chat:admin']] });
    add({ name: 'grants-commands-manage', function: 'grantsChatAdminRole', args: [['dashboard:view', 'commands:manage']] });
    add({ name: 'grants-null', function: 'grantsChatAdminRole', args: [null] });
    return cases;
}

function workspaceCases() {
    return [
        { name: 'workspace-creator', userId: '533538623' },
        { name: 'workspace-other', userId: '1234' },
        { name: 'workspace-empty-id', userId: '' },
        { name: 'workspace-missing', userId: null },
    ].map(workspaceScenario);
}

async function reference() {
    return {
        metadata: {
            pins,
            typescript: ts.version,
            creatorTwitchUserId: adminHarness([]).api.CREATOR_TWITCH_USER_ID,
            maxAccessPermissions: adminHarness([]).api.MAX_ACCESS_PERMISSIONS,
            channelAdminPermissions: channelApi.CHANNEL_ADMIN_PERMISSIONS,
            channelWebsiteAccessPermissions: channelApi.CHANNEL_WEBSITE_ACCESS_PERMISSIONS,
            routePolicyCallSites: policyCallSites.length,
            exports: {
                adminMiddleware: {
                    exported: true,
                    parameters: adminMiddlewareStatement.parameters.map(parameter => parameter.type.getText(adminAst)),
                    returns: adminMiddlewareStatement.type.getText(adminAst),
                },
                workspaceOwnerMiddleware: {
                    exported: true,
                    parameters: workspaceMiddlewareStatement.parameters.map(parameter => parameter.type.getText(workspaceAst)),
                    returns: workspaceMiddlewareStatement.type.getText(workspaceAst),
                },
            },
            differences: [
                'The unconditional console.log("adminMiddleware") diagnostic is not reproduced; the native logger and observability replace it.',
                'A JavaScript Error.stack string is not part of the native log payload.',
                'non-string entries in a stored permissions array are ignored instead of compared as JavaScript values.',
                'req.globalAdminRole/isSuperAdmin become one typed request extension present only for creator and super.',
            ],
        },
        middlewareCases: await middlewareCases(),
        helperCases: await helperCases(),
        pureCases: pureCases(),
        channelPermissionCases: channelPermissionCases(),
        workspaceCases: workspaceCases(),
    };
}

(async () => {
    const [mode, directory, ...extra] = process.argv.slice(2);
    assert(['--write', '--check'].includes(mode) && directory && path.isAbsolute(directory) && extra.length === 0, 'usage: --write|--check <absolute dir>');
    const file = path.join(directory, 'api-admin-reference.json');
    const rendered = JSON.stringify(await reference(), null, 2) + '\n';
    if (mode === '--write') {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(file, rendered, { flag: 'wx' });
        console.log(JSON.stringify({ file, sha256: sha(Buffer.from(rendered)), cases: JSON.parse(rendered).middlewareCases.length }));
    } else {
        const actual = fs.readFileSync(file);
        assert.equal(sha(actual), sha(Buffer.from(rendered)), 'reference bytes changed');
        console.log(JSON.stringify({ file, sha256: sha(actual), cases: JSON.parse(rendered).middlewareCases.length, exact: true }));
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
