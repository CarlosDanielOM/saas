// Actual-source oracle for sendAnnouncement (chat/announcements).
// Run only with the pinned isolated Node/TypeScript toolchain:
//   node tests/fixtures/announcement_chat_reference.cjs --write <empty-dir>
//   node tests/fixtures/announcement_chat_reference.cjs --check <dir>
// The fixture executes the real announcement.chat.ts source. getTwitchModeratorHeader,
// getTwitchHelixUrl and the logger are mocked. It never contacts Twitch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const ACCEPTED_ANNOUNCEMENT_SHA256 = '63d9ec7275bae66c9d244455e700f6ca3b11482c95a9498433b4272599c60355';

const files = {
    announcement: path.join(root, 'src/functions/chats/announcement.chat.ts'),
    header: path.join(root, 'src/utils/header.ts'),
    native: path.join(root, 'src/functions/chats/announcement.chat.rs'),
    nativeTest: path.join(root, 'tests/announcement_chat.rs'),
    oracle: __filename,
    chatsModule: path.join(root, 'src/functions/chats/mod.rs'),
    auth: path.join(root, 'src/functions/mod.rs'),
    transport: path.join(root, 'src/utils/twitch.rs'),
    nativeLinks: path.join(root, 'src/utils/links.rs'),
    nativeLogger: path.join(root, 'src/utils/logger.rs'),
    package: path.join(root, 'package.json'),
    lock: path.join(root, 'package-lock.json'),
};
const sha = value => crypto.createHash('sha256').update(fs.readFileSync(value)).digest('hex');

let announcementCode;

function compile() {
    announcementCode = ts.transpileModule(fs.readFileSync(files.announcement, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
}

function provenance() {
    if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || ts.version !== '5.9.3') {
        throw Error('wrong oracle toolchain');
    }
    if (sha(files.announcement) !== ACCEPTED_ANNOUNCEMENT_SHA256) {
        throw Error('accepted announcement source changed');
    }
    const sourceText = fs.readFileSync(files.announcement, 'utf8');
    const source = ts.createSourceFile(files.announcement, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'sendAnnouncement');
    const send = declarations[0];
    const exportedAsync = declarations.length === 1
        && send.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && send.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    const parameters = send?.parameters.map(parameter => {
        const initializer = parameter.initializer ? `=${parameter.initializer.getText(source)}` : '';
        return `${parameter.name.getText(source)}:${parameter.type?.getText(source)}${initializer}`;
    }).join(',');
    if (!exportedAsync
        || parameters !== "channelID:string,moderatorID:string,message:string,color:string='purple'"
        || send.type?.getText(source) !== 'Promise<SendAnnouncementResponse>') {
        throw Error('sendAnnouncement source signature changed');
    }
    if (!sourceText.includes("getTwitchHelixUrl('chat/announcements'")
        || !sourceText.includes("method: 'POST'")
        || !sourceText.includes("message: 'Announcement sent'")
        || !sourceText.includes("'Failed to send announcement'")
        || !sourceText.includes("message: 'Internal server error'")
        || !sourceText.includes('status: 403')
        || !sourceText.includes('status: 500')
        || !sourceText.includes("type: 'error'")
        || !sourceText.includes('moderator_id: TWITCH_BOT_ACCOUNT_ID')
        || !sourceText.includes("function: 'sendAnnouncement'")
        || !sourceText.includes("operation: 'send_announcement'")
        || !sourceText.includes("apiEndpoint: 'chat/announcements'")) {
        throw Error('announcement source contract changed');
    }
    return {
        node: process.version,
        v8: process.versions.v8,
        typescript: ts.version,
        hashes: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, sha(value)])),
        boundary: 'Actual sendAnnouncement source executed in a VM. getTwitchModeratorHeader, getTwitchHelixUrl and logger.error are mocked. fetch is in-memory. Source hashes record contract evidence, not execution of the mocked modules.',
    };
}

function makeEnv(spec) {
    const calls = { header: [], urls: [], fetch: [], logs: [] };
    const getTwitchModeratorHeader = async (channelID, moderatorID) => {
        calls.header.push({ channelID, moderatorID });
        if (spec.headerError) return { error: true, message: spec.headerError };
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
    const getTwitchHelixUrl = (endpoint, params) => {
        calls.urls.push({ endpoint, params: params ?? null });
        if (params === undefined || params === null || params === '') return `https://api.twitch.tv/helix/${endpoint}`;
        return `https://api.twitch.tv/helix/${endpoint}?${params}`;
    };
    const fetch = async (url, options) => {
        calls.fetch.push({
            url,
            method: options.method,
            headers: options.headers,
            body: JSON.parse(options.body),
        });
        return {
            status: spec.httpStatus,
            json: async () => {
                if (spec.httpStatus === 204) throw SyntaxError('204 must not be parsed');
                return JSON.parse(spec.responseBody);
            },
        };
    };
    const logError = async (value, options) => {
        calls.logs.push({
            function: value.function,
            channelID: value.channelID,
            moderatorID: value.moderatorID,
            operation: value.operation,
            apiEndpoint: value.apiEndpoint,
            method: value.method,
            destination: options?.destination,
            channelId: options?.channelId,
        });
    };
    return { calls, getTwitchModeratorHeader, getTwitchHelixUrl, fetch, logError };
}

function loadAnnouncement(env) {
    const exports = {};
    const requireMock = id => {
        if (id.endsWith('/header.js') || id.endsWith('\\header.js')) {
            return {
                TWITCH_BOT_ACCOUNT_ID: '698614112',
                getTwitchModeratorHeader: env.getTwitchModeratorHeader,
            };
        }
        if (id.endsWith('/links.js') || id.endsWith('\\links.js')) {
            return { getTwitchHelixUrl: env.getTwitchHelixUrl };
        }
        if (id.endsWith('/logger.js') || id.endsWith('\\logger.js')) return { error: env.logError };
        throw Error(`unexpected announcement import ${id}`);
    };
    const factory = vm.runInNewContext(
        `(function(exports, require, fetch){${announcementCode}\n})`,
        { URLSearchParams, JSON, Error, SyntaxError },
        { filename: files.announcement }
    );
    factory(exports, requireMock, env.fetch);
    if (typeof exports.sendAnnouncement !== 'function') throw Error('sendAnnouncement runtime export missing');
    return exports;
}

async function runCase(spec) {
    const env = makeEnv(spec);
    const api = loadAnnouncement(env);
    const args = [spec.channelID, spec.moderatorID, spec.message];
    if (Object.hasOwn(spec, 'colorArgument')) args.push(spec.colorArgument);
    const returned = await api.sendAnnouncement(...args);
    const fetchCall = env.calls.fetch[0] ?? null;
    const urlCall = env.calls.urls[0] ?? null;
    const query = urlCall ? new URLSearchParams(urlCall.params ?? '') : null;
    const color = fetchCall ? fetchCall.body.color : (spec.colorArgument ?? 'purple');
    return {
        id: spec.id,
        channelID: spec.channelID,
        moderatorID: spec.moderatorID,
        message: spec.message,
        color,
        httpStatus: spec.httpStatus ?? null,
        responseBody: spec.httpStatus === 204 ? null : (spec.responseBody ?? null),
        headerError: spec.headerError ?? null,
        request: fetchCall ? {
            url: fetchCall.url,
            method: fetchCall.method,
            query: urlCall.params,
            endpoint: urlCall.endpoint,
            broadcasterId: query.get('broadcaster_id'),
            moderatorId: query.get('moderator_id'),
            headerChannelID: env.calls.header[0]?.channelID ?? null,
            headerModeratorID: env.calls.header[0]?.moderatorID ?? null,
            body: fetchCall.body,
            authorization: fetchCall.headers.Authorization ?? null,
            clientId: fetchCall.headers['Client-Id'] ?? null,
            contentType: fetchCall.headers['Content-Type'] ?? null,
        } : null,
        response: JSON.parse(JSON.stringify(returned)),
        responseJson: JSON.stringify(returned),
        logs: env.calls.logs,
    };
}

const specs = [
    {
        id: 'success-204',
        channelID: 'channel-1',
        moderatorID: 'mod-9',
        message: 'hello',
        httpStatus: 204,
        responseBody: '',
    },
    {
        id: 'error-with-message',
        channelID: 'channel-2',
        moderatorID: 'mod-9',
        message: 'too long',
        colorArgument: 'blue',
        httpStatus: 400,
        responseBody: JSON.stringify({ error: 'Bad Request', message: 'message is too long' }),
    },
    {
        id: 'error-without-message',
        channelID: 'channel-3',
        moderatorID: 'mod-9',
        message: 'nope',
        httpStatus: 401,
        responseBody: JSON.stringify({ error: 'Unauthorized' }),
    },
    {
        id: 'header-denied',
        channelID: 'channel-4',
        moderatorID: 'mod-9',
        message: 'hello',
        headerError: "Bot's account does not have the permissions required",
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
    const output = `${JSON.stringify({
        schema: 1,
        provenance: provenanceValue,
        cases,
    }, null, 2)}\n`;
    const target = path.join(directory, 'announcement_chat_cases.json');
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
