// Actual-source oracle for temporary role removal announcements.
// Run only with the pinned isolated Node/TypeScript toolchain:
//   node tests/fixtures/temporary_roles_announcements_reference.cjs --write <empty-dir>
//   node tests/fixtures/temporary_roles_announcements_reference.cjs --check <dir>
// The fixture executes the real announcement helper and the real
// sendTwitchChatMessage source against an in-memory Redis list and mocked
// token/URL/logger/delivery seams. It never contacts Twitch or a real cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const FIXED_NOW = '2026-10-31T00:00:00.000Z';
const CLIENT_ID = 'fixture-client';
const SUCCESS = JSON.stringify({ data: [{ is_sent: true, message_id: 'm1' }] });
const HELD = JSON.stringify({ data: [{ is_sent: false, message_id: 'm2' }] });

const files = {
    helper: path.join(root, 'src/utils/temporary_roles_announcements.ts'),
    chat: path.join(root, 'src/functions/chats/send_message.chat.ts'),
    tokens: path.join(root, 'src/utils/tokens.ts'),
    tsLogger: path.join(root, 'src/utils/logger.ts'),
    links: path.resolve(root, '../archives/dimabot-typescript/2026-10-28/src/utils/links.ts'),
    astDelivery: path.join(root, 'src/utils/ast_command_delivery.ts'),
    specialParser: path.join(root, 'src/handlers/special_parser.handler.ts'),
    dragonflyTs: path.join(root, 'src/utils/databases/dragonfly.database.ts'),
    oracle: __filename,
    package: path.join(root, 'package.json'),
    lock: path.join(root, 'package-lock.json'),
    nativeAnnouncements: path.join(root, 'src/utils/temporary_roles_announcements.rs'),
    nativePlain: path.join(root, 'src/functions/chats/send_message_plain.rs'),
    nativeTest: path.join(root, 'tests/temporary_roles_announcements.rs'),
    chatsModule: path.join(root, 'src/functions/chats/mod.rs'),
    utilsModule: path.join(root, 'src/utils/mod.rs'),
    cargoManifest: path.join(root, 'Cargo.toml'),
    auth: path.join(root, 'src/functions/mod.rs'),
    transport: path.join(root, 'src/utils/twitch.rs'),
    nativeLogger: path.join(root, 'src/utils/logger.rs'),
    jsCompat: path.join(root, 'src/utils/js_compat.rs'),
    number: path.join(root, 'src/utils/json_number.rs'),
    dragonfly: path.join(root, 'src/utils/databases/dragonfly.database.rs'),
    testDigest: path.join(root, 'tests/support/sha256.rs'),
    lib: path.join(root, 'src/lib.rs'),
};
const sha = value => crypto.createHash('sha256').update(fs.readFileSync(value)).digest('hex');

let helperCode;
let chatCode;

function compile() {
    const options = {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    };
    helperCode = ts.transpileModule(fs.readFileSync(files.helper, 'utf8'), options).outputText;
    chatCode = ts.transpileModule(fs.readFileSync(files.chat, 'utf8'), options).outputText;
}

function provenance() {
    if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || ts.version !== '5.9.3') {
        throw Error('wrong oracle toolchain');
    }
    if (sha(files.helper) !== '8a5854ffdc9137e7a4bda2e7f0f60d105dfac360a4a69fb63a34b18f8eb17684'
        || sha(files.chat) !== '3b5f93b525902d21675c6bf922f3a86b4e2150020b03a1c469ffbc87b54b9639') {
        throw Error('accepted announcement/chat source changed');
    }
    const helperText = fs.readFileSync(files.helper, 'utf8');
    const helperAst = ts.createSourceFile(files.helper, helperText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = name => helperAst.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    const exportedAsync = list => list.length === 1
        && list[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && list[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    const enqueue = declarations('enqueueTemporaryRoleRemovalAnnouncement');
    const flush = declarations('flushTemporaryRoleRemovalAnnouncements');
    const role = helperAst.statements.filter(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'TemporaryRole');
    if (!exportedAsync(enqueue)
        || enqueue[0].parameters.map(parameter => `${parameter.name.getText(helperAst)}:${parameter.type?.getText(helperAst)}`).join(',') !== 'channelID:string,role:TemporaryRole,username:string,userID:string'
        || enqueue[0].type?.getText(helperAst) !== 'Promise<void>') {
        throw Error('enqueue source signature changed');
    }
    if (!exportedAsync(flush)
        || flush[0].parameters.map(parameter => `${parameter.name.getText(helperAst)}:${parameter.type?.getText(helperAst)}`).join(',') !== 'channelID:string'
        || flush[0].type?.getText(helperAst) !== 'Promise<{ sent: number }>') {
        throw Error('flush source signature changed');
    }
    if (role.length !== 1 || role[0].type.getText(helperAst) !== "'vip' | 'moderator'") {
        throw Error('TemporaryRole source type changed');
    }
    if (!/PENDING_KEY_PREFIX = 'twitch:temporary-roles:pending-announcements'/.test(helperText)
        || !/PENDING_TTL_SECONDS = 14 \* 24 \* 60 \* 60/.test(helperText)
        || !/COMPRESSION_THRESHOLD = 5/.test(helperText)) {
        throw Error('announcement constants changed');
    }

    const chatText = fs.readFileSync(files.chat, 'utf8');
    const chatAst = ts.createSourceFile(files.chat, chatText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let declaration;
    for (const statement of chatAst.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const candidate of statement.declarationList.declarations) {
            if (candidate.name.getText(chatAst) === 'sendTwitchChatMessage') declaration = candidate;
        }
    }
    if (!declaration || !ts.isArrowFunction(declaration.initializer)) throw Error('chat export changed');
    const parameters = declaration.initializer.parameters
        .map(parameter => `${parameter.name.getText(chatAst)}${parameter.questionToken ? '?' : ''}:${parameter.type?.getText(chatAst)}${parameter.initializer ? `=${parameter.initializer.getText(chatAst)}` : ''}`)
        .join(',');
    if (parameters !== 'channelID:string,message:string,replyToMessageId:string | null=null,context?:SendMessageContext') {
        throw Error('chat source signature changed');
    }
    if (!/const MODERATOR_ID = '698614112'/.test(chatText) || !/for_source_only:\s*true/.test(chatText)) {
        throw Error('chat source contract changed');
    }

    return {
        node: process.version,
        v8: process.versions.v8,
        typescript: ts.version,
        hashes: {
            ...Object.fromEntries(Object.entries(files).map(([key, value]) => [key, sha(value)])),
            node: sha(process.execPath),
            typescript: sha(require.resolve('typescript')),
            typescriptPackage: sha(require.resolve('typescript/package.json')),
        },
        boundary: 'Actual enqueueTemporaryRoleRemovalAnnouncement/flushTemporaryRoleRemovalAnnouncements source executed with an in-memory queue and the actual sendTwitchChatMessage source; getAppToken, links, logger, fetch and deliverAstMessage are mocked. Source hashes record contract evidence, not execution of the mocked modules.',
    };
}

class FakeDate {
    constructor() {
        return { toISOString: () => FIXED_NOW };
    }
}

function makeCache() {
    const lists = new Map();
    const commands = [];
    return {
        lists,
        commands,
        async rPush(key, value) {
            commands.push(['rPush', key, value]);
            const items = lists.get(key) ?? [];
            items.push(value);
            lists.set(key, items);
            return items.length;
        },
        async expire(key, seconds) {
            commands.push(['expire', key, seconds]);
            return lists.has(key) ? 1 : 0;
        },
        async lRange(key, start, end) {
            commands.push(['lRange', key, start, end]);
            const items = [...(lists.get(key) ?? [])];
            return end === -1 ? items.slice(start) : items.slice(start, end + 1);
        },
        async del(key) {
            commands.push(['del', key]);
            return lists.delete(key) ? 1 : 0;
        },
    };
}

function chatEnv(spec) {
    const calls = { fetch: [], logs: [], delivered: [] };
    const responses = [...(spec.responses ?? [])];
    const getAppToken = async () => (spec.tokenMissing ? null : 'fixture-app-token');
    const fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.fetch.push({ url, headers: options.headers, body });
        const next = responses.shift();
        if (!next) throw Error('unscripted fetch');
        if (next.throw) throw Error(next.throw);
        return { status: next.status, json: async () => JSON.parse(next.body) };
    };
    const deliverAstMessage = async (...args) => {
        calls.delivered.push(args);
        return { error: false, message: 'AST message delivered', status: 200 };
    };
    const logError = async (value, options) => {
        calls.logs.push({ function: value.function, channelID: options?.channelId, destination: options?.destination });
    };
    const logWarn = async (value, options) => {
        calls.logs.push({ function: value.function, channelID: options?.channelId, destination: options?.destination });
    };
    return { calls, getAppToken, fetch, deliverAstMessage, logError, logWarn, process: { env: { CLIENT_ID } } };
}

function loadChat(env) {
    const exports = {};
    const requireMock = id => {
        if (id.endsWith('ast_command_delivery.js')) return { deliverAstMessage: env.deliverAstMessage };
        if (id.endsWith('logger.js')) return { error: env.logError, warn: env.logWarn };
        if (id.endsWith('links.js')) return { getTwitchHelixUrl: endpoint => `https://api.twitch.tv/helix/${endpoint}` };
        if (id.endsWith('tokens.js')) return { getAppToken: env.getAppToken };
        if (id.endsWith('special_parser.handler.js')) {
            return {
                parseSpecialCommands: async () => {
                    throw Error('a context-free send must not parse special commands');
                },
            };
        }
        throw Error(`unexpected chat import ${id}`);
    };
    const factory = vm.runInNewContext(
        `(function(exports,require,fetch,process){${chatCode}\n})`,
        { Date: FakeDate },
        { filename: files.chat }
    );
    factory(exports, requireMock, env.fetch, env.process);
    if (typeof exports.sendTwitchChatMessage !== 'function') throw Error('chat runtime export missing');
    return exports;
}

function loadHelper(cache, chat) {
    const exports = {};
    const requireMock = id => {
        if (id.endsWith('databases/dragonfly.database.js')) return { getDragonflyClient: async () => cache };
        if (id.endsWith('chats/send_message.chat.js')) return chat;
        throw Error(`unexpected helper import ${id}`);
    };
    const factory = vm.runInNewContext(
        `(function(exports,require){${helperCode}\n})`,
        { Date: FakeDate },
        { filename: files.helper }
    );
    factory(exports, requireMock);
    if (typeof exports.enqueueTemporaryRoleRemovalAnnouncement !== 'function'
        || typeof exports.flushTemporaryRoleRemovalAnnouncements !== 'function') {
        throw Error('helper runtime exports missing');
    }
    return exports;
}

const keyFor = channel => `twitch:temporary-roles:pending-announcements:${channel}`;
const item = (role, username, userID = 'ignored') => JSON.stringify({ role, username, userID, removedAt: FIXED_NOW });

async function runEnqueue(spec) {
    const cache = makeCache();
    const helper = loadHelper(cache, loadChat(chatEnv({ responses: [] })));
    await helper.enqueueTemporaryRoleRemovalAnnouncement(spec.channel, spec.role, spec.username, spec.userID);
    return {
        id: spec.id,
        role: spec.role,
        username: spec.username,
        userID: spec.userID,
        payload: cache.lists.get(keyFor(spec.channel))?.[0] ?? null,
        commands: cache.commands,
    };
}

async function runFlush(spec) {
    const cache = makeCache();
    cache.lists.set(keyFor(spec.channel), [...spec.items]);
    const env = chatEnv(spec);
    const helper = loadHelper(cache, loadChat(env));
    let returned;
    let thrown = null;
    try {
        returned = await helper.flushTemporaryRoleRemovalAnnouncements(spec.channel);
    } catch (error) {
        thrown = String(error.message);
    }
    const retained = cache.lists.has(keyFor(spec.channel)) ? [...cache.lists.get(keyFor(spec.channel))] : null;
    return {
        id: spec.id,
        channel: spec.channel,
        items: spec.items,
        responses: spec.responses,
        expected: {
            sent: returned ? returned.sent : null,
            thrown,
            sends: env.calls.fetch.map(call => call.body.message),
            logs: env.calls.logs.map(log => log.function),
            retained: spec.items.length ? retained !== null : null,
            commands: cache.commands.map(command => command[0]),
        },
    };
}

async function runPlain(spec) {
    const env = chatEnv(spec);
    const chat = loadChat(env);
    const returned = await chat.sendTwitchChatMessage('fixture-channel', spec.message);
    return {
        id: spec.id,
        message: spec.message,
        tokenMissing: !!spec.tokenMissing,
        ignoreReason: !!spec.ignoreReason,
        responses: spec.responses,
        expected: {
            json: JSON.parse(JSON.stringify(returned)),
            requests: env.calls.fetch.map(call => ({
                body: call.body,
                authorization: call.headers.Authorization,
                clientId: call.headers['Client-Id'],
                contentType: call.headers['Content-Type'],
            })),
            logs: env.calls.logs.map(log => log.function),
        },
    };
}

const enqueueSpecs = [
    { id: 'enqueue-vip', channel: 'fixture-enqueue-vip', role: 'vip', username: '  @@Alice ', userID: '  12345  ' },
    { id: 'enqueue-moderator', channel: 'fixture-enqueue-moderator', role: 'moderator', username: '', userID: '' },
];

const flushSpecs = [
    { id: 'flush-empty', channel: 'fixture-flush-empty', items: [], responses: [] },
    {
        id: 'flush-single-vip',
        channel: 'fixture-flush-single-vip',
        items: [item('vip', '@@Alice')],
        responses: [{ status: 200, body: SUCCESS }],
    },
    {
        id: 'flush-userid-fallback',
        channel: 'fixture-flush-userid-fallback',
        items: [item('moderator', '', '  @@Bob_99 ')],
        responses: [{ status: 200, body: SUCCESS }],
    },
    {
        id: 'flush-five-individual',
        channel: 'fixture-flush-five',
        items: [1, 2, 3, 4, 5].map(index => item('vip', `user${index}`)),
        responses: [1, 2, 3, 4, 5].map(() => ({ status: 200, body: SUCCESS })),
    },
    {
        id: 'flush-six-compressed',
        channel: 'fixture-flush-six',
        items: [1, 2, 3, 4, 5, 6].map(index => item('vip', `user${index}`)),
        responses: [{ status: 200, body: SUCCESS }],
    },
    {
        id: 'flush-mixed-order',
        channel: 'fixture-flush-mixed',
        items: [item('moderator', 'Carol'), item('vip', 'Alice'), item('vip', 'Bob')],
        responses: [1, 2, 3].map(() => ({ status: 200, body: SUCCESS })),
    },
    {
        id: 'flush-dedupe',
        channel: 'fixture-flush-dedupe',
        items: [item('vip', '@@Alice'), item('vip', '@alice'), item('vip', ' ALICE ')],
        responses: [{ status: 200, body: SUCCESS }],
    },
    {
        id: 'flush-malformed',
        channel: 'fixture-flush-malformed',
        items: [
            'not json',
            'null',
            JSON.stringify({ role: 'admin', username: 'x' }),
            JSON.stringify({ role: 1, username: 'x' }),
            JSON.stringify({ role: 'vip' }),
            item('vip', '', '  @@ID  '),
        ],
        responses: [{ status: 200, body: SUCCESS }],
    },
    {
        id: 'flush-all-invalid',
        channel: 'fixture-flush-all-invalid',
        items: ['not json', item('vip', '', '')],
        responses: [],
    },
    {
        id: 'flush-rejected',
        channel: 'fixture-flush-rejected',
        items: [item('vip', 'alice'), item('vip', 'bob')],
        responses: [
            { status: 200, body: SUCCESS },
            { status: 400, body: JSON.stringify({ error: 'BadRequest', message: 'bad message' }) },
        ],
    },
    {
        id: 'flush-status-default',
        channel: 'fixture-flush-status-default',
        items: [item('vip', 'alice')],
        responses: [{ status: 500, body: '{}' }],
    },
    {
        id: 'flush-compressed-default',
        channel: 'fixture-flush-compressed-default',
        items: [1, 2, 3, 4, 5, 6].map(index => item('vip', `user${index}`)),
        responses: [{ status: 500, body: '{}' }],
    },
    {
        id: 'flush-held',
        channel: 'fixture-flush-held',
        items: [1, 2, 3, 4, 5, 6].map(index => item('moderator', `user${index}`)),
        responses: [{ status: 200, body: HELD }],
    },
    {
        id: 'flush-invalid-json',
        channel: 'fixture-flush-invalid-json',
        items: [item('vip', 'alice')],
        responses: [{ status: 200, body: 'invalid' }],
    },
    {
        id: 'flush-success-without-data',
        channel: 'fixture-flush-success-without-data',
        items: [1, 2, 3, 4, 5, 6].map(index => item('vip', `user${index}`)),
        responses: [{ status: 200, body: '{}' }],
    },
];

const plainSpecs = [
    { id: 'plain-empty-data', message: 'hello', responses: [{ status: 200, body: '{"data":[]}' }] },
    { id: 'plain-null-data', message: 'hello', responses: [{ status: 200, body: '{"data":null}' }] },
    {
        id: 'plain-success',
        message: 'hello world',
        responses: [{ status: 200, body: SUCCESS }],
    },
    {
        id: 'plain-held',
        message: 'hello',
        responses: [{ status: 200, body: HELD }],
    },
    {
        id: 'plain-status',
        message: 'hello',
        responses: [{ status: 400, body: JSON.stringify({ error: 'BadRequest', message: 'bad message' }) }],
    },
    {
        id: 'plain-token-missing',
        message: 'hello',
        tokenMissing: true,
        responses: [],
    },
    {
        id: 'plain-blank',
        message: '   ',
        responses: [],
    },
    {
        id: 'plain-invalid-json',
        message: 'hello',
        responses: [{ status: 200, body: 'invalid' }],
        ignoreReason: true,
    },
    {
        id: 'plain-no-data',
        message: 'hello',
        responses: [{ status: 200, body: '{}' }],
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

    const enqueue = [];
    for (const spec of enqueueSpecs) enqueue.push(await runEnqueue(spec));
    const flush = [];
    for (const spec of flushSpecs) flush.push(await runFlush(spec));
    const plain = [];
    for (const spec of plainSpecs) plain.push(await runPlain(spec));

    const output = `${JSON.stringify({
        schema: 1,
        provenance: provenanceValue,
        constants: {
            fixedNow: FIXED_NOW,
            ttlSeconds: 14 * 24 * 60 * 60,
            threshold: 5,
            keyPrefix: 'twitch:temporary-roles:pending-announcements',
            clientId: CLIENT_ID,
        },
        enqueue,
        flush,
        plain,
    }, null, 2)}\n`;
    const target = path.join(directory, 'temporary_roles_announcements_cases.json');
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
