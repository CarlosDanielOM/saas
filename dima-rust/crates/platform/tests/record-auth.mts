// Records the authentication decision table from the frozen TypeScript (`authMiddleware`,
// `optionalAuthMiddleware`, `workspaceOwnerMiddleware`) behind a real Express app, against a
// scratch MongoDB database, scratch keys in Dragonfly database 14 and a local Twitch mock.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//       "$REPO/dima-rust/crates/platform/tests/record-auth.mts"
//
// Only the three middleware files are evaluated (transpiled, with their imports replaced: the
// real `users` model, a Dragonfly client on database 14, a telemetry stub that records the
// bound channel, a logger stub). `fetch` is the real one, with the two Twitch hosts rewritten to
// the mock. Tokens and Twitch ids are random per run; rows name them by kind.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cases = JSON.parse(fs.readFileSync(fileURLToPath(new URL('auth-cases.json', import.meta.url)), 'utf8'));
const { client_id: CLIENT_ID, site_users: fixtureUsers, tokens: TOKENS, rows } = cases;
const root = process.env.DIMABOT_DIR!;
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const express = require('express');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const SOURCES = ['src/middleware/auth.middleware.ts', 'src/middleware/optional.middleware.ts',
    'src/middleware/workspace-owner.middleware.ts', 'src/middleware/types.ts', 'src/schemas/users.schema.ts'];

function load(rel: string, mapping: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    const req = (spec: string) => {
        if (spec in mapping) return mapping[spec];
        throw new Error(`unexpected import ${spec} in ${rel}`);
    };
    const names = Object.keys(extra);
    vm.compileFunction(out, ['exports', 'require', 'module', ...names])(module.exports, req, module, ...names.map(n => extra[n]));
    return module.exports;
}

const run = randomBytes(6).toString('hex');
const tokenOf = (kind: string) => kind === 'long' ? 'a'.repeat(3000) : `${kind}_${run}`;
const idOf = (kind: string) => kind === 'creator' ? '533538623' : `9${createHash('sha256').update(kind + run).digest('hex').replace(/\D/g, '').slice(0, 9)}`;

// ---------------------------------------------------------------- Twitch mock
const calls: string[] = [];
const byToken = new Map<string, any>();
for (const [kind, spec] of Object.entries(TOKENS)) byToken.set(tokenOf(kind), spec);
const mock = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^(Bearer|OAuth) /, '');
    const spec = byToken.get(token);
    const endpoint = req.url!.startsWith('/oauth2/validate') ? 'validate' : req.url!.startsWith('/helix/users') ? 'users' : 'other';
    calls.push(endpoint);
    const reply = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
    if (!spec || endpoint === 'other') return reply(401, '{"status":401,"message":"invalid access token"}');
    const answer = spec[endpoint];
    if (answer === 'drop') { req.socket.destroy(); return; }
    if (endpoint === 'users' && req.headers['client-id'] !== (spec.client ?? CLIENT_ID)) {
        return reply(401, '{"error":"Unauthorized","status":401,"message":"Client ID and OAuth token do not match"}');
    }
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
        .replaceAll('$CLIENT', spec.client ?? CLIENT_ID).replaceAll('$ID', idOf(spec.user))
        .replaceAll('$LOGIN', `login_${spec.user}`);
    reply(answer.status, text);
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${(mock.address() as any).port}`;
const realFetch = globalThis.fetch;
const twitchFetch = (url: unknown, init?: RequestInit) => realFetch(String(url)
    .replace('https://id.twitch.tv', mockBase).replace('https://api.twitch.tv', mockBase), init);

// ---------------------------------------------------------------- stores and middleware
const dbName = `dima_test_platform_${run}`;
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI!, { dbName });
const redis = createClient({ url: `redis://${process.env.DIMA_TEST_DRAGONFLY}/14` });
redis.on('error', () => {});
await redis.connect();
const { default: UsersSchema } = await import(path.join(root, 'src/schemas/users.schema.ts'));

let bound: string | null = null;
let handlerRan = false;
const errors: string[] = [];
const auth = load('src/middleware/auth.middleware.ts', {
    '../utils/observability/telemetry.js': { bindChannel: (c: string) => { bound = c ?? null; } },
    '../utils/databases/dragonfly.database.js': { getDragonflyClient: async () => redis },
    '../utils/logger.js': { error: async (e: any) => { errors.push(e.function); } },
    '../schemas/users.schema.js': { __esModule: true, default: UsersSchema },
}, { fetch: twitchFetch, process: { env: { CLIENT_ID } } });
const optional = load('src/middleware/optional.middleware.ts', { './auth.middleware.js': auth });
const workspace = load('src/middleware/workspace-owner.middleware.ts', {});

const app = express();
const handler = (req: any, res: any) => { handlerRan = true; res.json({ next: true, user: req.user ?? null, bound }); };
app.get('/probe', auth.authMiddleware, handler);
app.get('/probe/:channelID', auth.authMiddleware, handler);
app.get('/optional', optional.optionalAuthMiddleware, handler);
app.get('/workspace', auth.authMiddleware, workspace.workspaceOwnerMiddleware, handler);
app.use((err: any, _req: any, res: any, next: any) => { if (res.headersSent) return; next(err); });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const port = (server.address() as any).port;

function send(target: string, header: string | null) {
    return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (header !== null) headers.Authorization = header;
        const req = http.request({ host: '127.0.0.1', port, path: target, headers }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const keys = new Set<string>();
const recorded: unknown[] = [];
try {
    for (const user of fixtureUsers) {
        await UsersSchema.create({ name: `site_${user}`, accounts: [{ type: 'twitch', id: idOf(user), name: `login_${user}` }] });
    }
    for (const row of rows) {
        const token = row.token ? tokenOf(row.token) : null;
        if (token) { keys.add(`token:${token}`); }
        if (row.seed && token) {
            const id = idOf(row.seed);
            await redis.hSet(`token:${token}`, { id, login: `login_${row.seed}`, display_name: `Display ${row.seed}`, profile_image_url: '' });
            await redis.expire(`token:${token}`, 14000);
        }
        const header = row.header === null ? null : String(row.header).replace('$TOKEN', token ?? '');
        const target = String(row.path).replace('$CHANNEL', idOf('channel'));
        bound = null; handlerRan = false; calls.length = 0; errors.length = 0;
        const response = await send(target, header);
        await new Promise(resolve => setTimeout(resolve, 50));
        const touchedUser = row.user ? await UsersSchema.findOne({ 'accounts.id': idOf(row.user) }).lean() : null;
        if (row.user) keys.add(`twitch:${idOf(row.user)}:last_app_activity_touch`);
        recorded.push({
            name: row.name,
            status: response.status,
            contentType: response.type,
            body: response.body,
            handlerRan,
            twitchCalls: [...calls],
            cached: token ? await redis.exists(`token:${token}`) === 1 : false,
            cacheTtl: token ? await redis.ttl(`token:${token}`) : null,
            touchKeyTtl: row.user ? await redis.ttl(`twitch:${idOf(row.user)}:last_app_activity_touch`) : null,
            activityStamped: row.user ? !!touchedUser?.last_app_activity_at : null,
        });
    }
    const placeholders = (text: string) => {
        let out = text;
        for (const k of [...Object.keys(TOKENS), 'cached_revoked', 'valid', 'nopic', 'nosite', 'channel']) {
            out = out.replaceAll(tokenOf(k), `$TOKEN(${k})`).replaceAll(idOf(k), `$ID(${k})`);
        }
        return out;
    };
    const sha256 = Object.fromEntries(SOURCES.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
    const file = fileURLToPath(new URL('auth-reference.json', import.meta.url));
    fs.writeFileSync(file, placeholders(JSON.stringify({ sha256, rows: recorded }, null, 2)) + '\n');
} finally {
    if (keys.size) await redis.del([...keys]);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await redis.quit();
    server.close();
    mock.close();
}
