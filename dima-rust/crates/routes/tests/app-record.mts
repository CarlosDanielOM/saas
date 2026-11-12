// Records the application shell, the OAuth routes and the analytics proxy of the frozen reference
// by replaying `app-cases.json` against it over real loopback HTTP; the Rust test
// (`app_recordings.rs`) replays the same requests against `dima_routes` and compares.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//       "$REPO/dima-rust/crates/routes/tests/app-record.mts"
//
// How the app is built, and why it is the reference's middleware order: the real source of
// `src/server/server.ts` is transpiled and evaluated as it is; only its imports are replaced
// (the same technique as `crates/platform/tests/record-oauth.mts`). So every `app.use` and
// `app.get` runs in the file's own order, by construction, and a drift check of the files'
// SHA-256 fails the Rust test when the reference changes. Replaced imports:
//
// - every router of `./routes/*` except the analytics proxy: an empty `express.Router()`
//   (importing them would load most of the backend: the bot's Twitch clients, the TTS and clip
//   queues, the site agent, Qdrant, Polar, and their timers and connections at import time);
// - `httpTelemetry`: a pass-through (the real one starts the telemetry exporter on Dragonfly;
//   the Rust observer is outside the compared surface);
// - `getDirname` (and `import.meta.url`, which a CommonJS evaluation cannot hold): a scratch
//   directory whose `routes/public` holds the fixture files of `app-cases.json`;
// - `getSiteAnalyticsSnapshot` and `getReservedCommandsPayload`: fakes with the fixture values
//   (their services are ported and recorded by their own packages);
// - `./oauth/routes.js`: the real `routes.ts` with the real `service.ts` and `catalog.ts` on a
//   scratch MongoDB database and Dragonfly database 8; the desktop AI, pet and credit services
//   it calls are recording fakes (their packages port them), and `fetch` reaches a local mock
//   of Twitch's token validation instead of `id.twitch.tv`;
// - `observability.route.ts`: real, with `fetch` sent to a local mock of the analytics service
//   instead of `http://dima-analytics:3210`.
//
// Nothing reaches a real outside host. The scratch database, the Dragonfly keys and the scratch
// directory are removed at the end, also on failure.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'production';
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const cases = JSON.parse(fs.readFileSync(here('app-cases.json'), 'utf8'));
const root = process.env.DIMABOT_DIR!;
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { createClient } = require('redis');

const SOURCES = ['src/server/server.ts', 'src/server/oauth/routes.ts', 'src/server/oauth/service.ts',
    'src/server/oauth/catalog.ts', 'src/server/routes/observability.route.ts'];

function load(rel: string, mapping: (spec: string) => unknown, extra: Record<string, unknown> = {}) {
    let source = fs.readFileSync(path.join(root, rel), 'utf8');
    source = source.replaceAll('import.meta.url', JSON.stringify('file:///fixture/src/server/server.ts'));
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, any> };
    const names = Object.keys(extra);
    vm.compileFunction(out, ['exports', 'require', 'module', ...names])(module.exports, mapping, module,
        ...names.map(n => extra[n]));
    return module.exports;
}
const fixed = (table: Record<string, unknown>, rel: string) => (spec: string) => {
    if (spec in table) return table[spec];
    throw new Error(`unexpected import ${spec} in ${rel}`);
};

const run = randomBytes(6).toString('hex');
const hash = (v: string) => createHash('sha256').update(v).digest('base64url');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dima-app-record-'));
const serverDir = path.join(scratch, 'server');
const publicDir = path.join(serverDir, 'routes', 'public');
const mtime = new Date(cases.public.mtime);
for (const [rel, content] of Object.entries<string>(cases.public.files)) {
    const file = path.join(publicDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.utimesSync(file, mtime, mtime);
}

// ------------------------------------------------------------------------------ local mocks
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return (server.address() as net.AddressInfo).port;
}
const twitch = http.createServer((req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^OAuth /, '');
    const user = cases.browser_tokens[token];
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/oauth2/validate' || !user) {
        res.statusCode = 401; res.end('{"status":401,"message":"invalid access token"}'); return;
    }
    res.end(JSON.stringify({ client_id: cases.client_id, login: 'viewer_one', scopes: [], user_id: user, expires_in: 3600 }));
});
let upstream: any[] = [];
const analytics = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        upstream.push({ method: req.method, target: req.url, authorization: req.headers.authorization ?? null,
            content_type: req.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8'),
            cookie: req.headers.cookie ?? null, forwarded_for: req.headers['x-forwarded-for'] ?? null });
        const answer = cases.analytics[(req.url ?? '').split('?')[0]] ?? { status: 404, body: '{"message":"no"}' };
        if (answer.drop) { req.socket.destroy(); return; }
        res.statusCode = answer.status; res.end(answer.body);
    });
});
const twitchPort = await listen(twitch);
const analyticsPort = await listen(analytics);
const realFetch = globalThis.fetch;
const shimFetch = (url: string, init: any) => realFetch(String(url)
    .replace('https://id.twitch.tv', `http://127.0.0.1:${twitchPort}`)
    .replace('http://dima-analytics:3210', `http://127.0.0.1:${analyticsPort}`), init);

// ------------------------------------------------------------------------- stores, services
const dbName = `dima_test_routes_${run}`;
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI!, { dbName });
const redis = createClient({ url: `redis://${process.env.DIMA_TEST_DRAGONFLY}/8` });
redis.on('error', () => {});
await redis.connect();
const imp = (rel: string) => import(path.join(root, rel));
const { default: Users } = await imp('src/schemas/users.schema.ts');
const { OAuthClient } = await imp('src/schemas/oauth_client.schema.ts');
const { OAuthGrant } = await imp('src/schemas/oauth_grant.schema.ts');
const { OAuthSession } = await imp('src/schemas/oauth_session.schema.ts');
const { OAuthRefreshToken } = await imp('src/schemas/oauth_refresh_token.schema.ts');
const env = { PUBLIC_API_URL: cases.issuer, DASHBOARD_URL: cases.website, CLIENT_ID: cases.client_id };
const catalog = load('src/server/oauth/catalog.ts', fixed({}, 'catalog.ts'));
const service = load('src/server/oauth/service.ts', fixed({
    'node:crypto': crypto, mongoose,
    '../../schemas/users.schema.js': { __esModule: true, default: Users },
    '../../schemas/oauth_client.schema.js': { OAuthClient },
    '../../schemas/oauth_grant.schema.js': { OAuthGrant },
    '../../schemas/oauth_session.schema.js': { OAuthSession },
    '../../schemas/oauth_refresh_token.schema.js': { OAuthRefreshToken },
    '../../utils/databases/dragonfly.database.js': { getDragonflyClient: async () => redis },
    './catalog.js': catalog,
}, 'service.ts'), { process: { env } });

// Recording fakes of the services other packages port (same behaviour in `app_recordings.rs`).
let calls: any[] = [];
class PetError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
class PetSettingsError extends Error { constructor(public code: string, public status = 400) { super(code); } }
const audioFile = (turn: string) => path.join(publicDir, cases.audio[turn] ?? 'missing.mp3');
const desktop = {
    submitTurn: async (who: any, body: any) => {
        calls.push({ fn: 'submit', who, input: body ?? null });
        if (body?.crash) throw new Error('boom');
        if (body?.fail_code) throw new catalog.OAuthError(body.fail_code, body.fail_status);
        return { turn_id: 't1', status: 'queued', input: body };
    },
    getTurn: async (who: any, id: string, byRequest?: boolean) => {
        calls.push({ fn: 'get', who, id, by_request: !!byRequest });
        return { turn_id: id, by_request: !!byRequest };
    },
    cancelTurn: async (who: any, id: string) => { calls.push({ fn: 'cancel', who, id }); return { turn_id: id, cancelled: true }; },
    cancelSpeech: async (who: any, id: string, body: any) => {
        calls.push({ fn: 'cancel_speech', who, id, input: body ?? null }); return { turn_id: id, speech: 'cancelled', input: body };
    },
    speechEvent: async (who: any, id: string, body: any) => {
        calls.push({ fn: 'speech_event', who, id, input: body ?? null }); return { turn_id: id, event: body };
    },
    claimAudio: async (who: any, id: string, ticket?: string) => {
        calls.push({ fn: 'claim_audio', who, id, ticket: ticket ?? null });
        return { mimeType: 'audio/mpeg', path: audioFile(id) };
    },
};
const pets = {
    getPetConfiguration: async (user: string, channel: string) => {
        calls.push({ fn: 'pet_configuration', user, channel });
        return { enabled: true, profiles: [1], voices: [2], user, channel };
    },
    getPetRuntime: async (user: string, channel: string) => { calls.push({ fn: 'pet_runtime', user, channel }); return { state: 'idle', user, channel }; },
    selectOwnPetPlayback: async (who: any, body: any) => { calls.push({ fn: 'pet_playback', who, input: body ?? null }); return { selected: body }; },
    cancelPetRequest: async (user: string, request: string, command: any) => {
        calls.push({ fn: 'pet_cancel', user, request, command: command ?? null });
        return { cancelled: request, commandId: command ?? null };
    },
};
const credits = {
    getAiCredits: async (user: any, channel: string) => {
        calls.push({ fn: 'credits', user: String(user._id), channel });
        return { balance: 5, plan: 'free' };
    },
    getFreeAiCreditDisplay: async () => ({ label: '5 credits' }),
};
const oauthRoutes = load('src/server/oauth/routes.ts', fixed({
    express, mongoose,
    '../../schemas/users.schema.js': { __esModule: true, default: Users },
    '../../schemas/oauth_grant.schema.js': { OAuthGrant },
    '../../schemas/oauth_session.schema.js': { OAuthSession },
    '../../utils/billing.js': { getAiCredits: credits.getAiCredits },
    '../../utils/ai_credit_display.js': { getFreeAiCreditDisplay: credits.getFreeAiCreditDisplay },
    '../services/pet_settings.service.js': { getPetConfiguration: pets.getPetConfiguration, PetSettingsError },
    '../../pets/state.js': { PetError, cancelPetRequest: pets.cancelPetRequest },
    '../../pets/runtime.js': { getPetRuntime: pets.getPetRuntime },
    '../../pets/selection.js': { selectOwnPetPlayback: pets.selectOwnPetPlayback },
    '../../desktop_ai/service.js': desktop,
    '../../desktop_ai/updates.js': { TURN_STATUS_FEATURE: 'turn-status-v1' },
    './catalog.js': catalog,
    './service.js': service,
}, 'routes.ts'), { process: { env }, fetch: shimFetch, console: { error: () => {} } });
const observability = load('src/server/routes/observability.route.ts', fixed({ express }, 'observability.route.ts'),
    { fetch: shimFetch });
let snapshotFails = false;
const emptyRouters: Record<string, any> = {};
const server = load('src/server/server.ts', (spec: string) => {
    switch (spec) {
        case 'express': return express;
        case 'cors': return cors;
        case 'path': return path;
        case '../utils/observability/telemetry.js': return { httpTelemetry: (_req: any, _res: any, next: any) => next() };
        case './routes/observability.route.js': return observability;
        case '../utils/pollyfills.js': return { getDirname: () => serverDir };
        case '../utils/siteanalytics.js': return { getSiteAnalyticsSnapshot: async () => {
            if (snapshotFails) throw new Error('snapshot failed');
            return cases.snapshot;
        } };
        case './services/command_defaults.service.js': return { getReservedCommandsPayload: (language?: string) =>
            ({ language: language ?? null, ...cases.reserved }) };
        case './oauth/routes.js': return oauthRoutes;
    }
    if (spec.startsWith('./routes/')) {
        return new Proxy({}, { get: (_t, name: string) => name === '__esModule' ? false
            : (emptyRouters[spec + name] ??= express.Router()) });
    }
    throw new Error(`unexpected import ${spec} in server.ts`);
}, { console: { error: () => {} } });

// ---------------------------------------------------------------------------- the requests
function bodyOf(c: any): Buffer | null {
    if (c.json_of_size) return Buffer.from(`{"a":"${'x'.repeat(c.json_of_size - 8)}"}`);
    if (c.form_of_size) return Buffer.from(`a=${'x'.repeat(c.form_of_size - 2)}`);
    if (c.form_params) return Buffer.from(Array.from({ length: c.form_params }, (_, i) => `p${i}=1`).join('&'));
    if (typeof c.body === 'string') return Buffer.from(subst(c.body));
    return null;
}
const captured: Record<string, string> = {};
const subst = (text: string) => text.replace(/\$([A-Z][A-Z0-9_]*)/g, (m, name) => captured[name] ?? m);

function send(port: number, c: any): Promise<{ status: number, headers: [string, string][], body: Buffer }> {
    const body = bodyOf(c);
    const headers = Object.entries<string>(c.headers ?? {}).map(([k, v]) => [k, subst(v)]);
    if (body && !headers.some(([k]) => k === 'content-length')) headers.push(['content-length', String(body.length)]);
    const head = `${c.method} ${subst(c.path)} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n`
        + headers.map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';
    return new Promise((done, fail) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            socket.destroy();
            try { done(parse(Buffer.concat(chunks))); } catch (e) { fail(e); }
        };
        socket.on('data', chunk => {
            chunks.push(chunk);
            if (c.stream) {
                const parsed = tryParse(Buffer.concat(chunks));
                if (parsed && parsed.body.includes('\n\n')) finish();
            }
        });
        socket.on('end', finish);
        socket.on('close', finish);
        socket.on('error', () => finish());
        socket.write(head);
        if (body) socket.write(body);
        if (c.half_close) socket.end();
        setTimeout(finish, 5000);
    });
}
function tryParse(raw: Buffer) { try { return parse(raw); } catch { return null; } }
function parse(raw: Buffer) {
    const split = raw.indexOf('\r\n\r\n');
    if (split < 0) throw new Error('no head');
    const lines = raw.subarray(0, split).toString('latin1').split('\r\n');
    const status = Number(lines[0].split(' ')[1]);
    const headers = lines.slice(1).map(l => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()] as [string, string]; });
    let body = raw.subarray(split + 4);
    if (headers.some(([k, v]) => k === 'transfer-encoding' && v === 'chunked')) {
        const out: Buffer[] = [];
        let at = 0;
        while (at < body.length) {
            const end = body.indexOf('\r\n', at);
            if (end < 0) break;
            const size = parseInt(body.subarray(at, end).toString('latin1'), 16);
            if (!size) break;
            out.push(body.subarray(end + 2, end + 2 + size));
            at = end + 2 + size + 2;
        }
        body = Buffer.concat(out);
    }
    return { status, headers, body };
}

const COMPARED = ['content-type', 'content-length', 'cache-control', 'pragma', 'referrer-policy',
    'x-content-type-options', 'content-security-policy', 'access-control-allow-origin',
    'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-credentials',
    'access-control-max-age', 'access-control-expose-headers', 'vary', 'location', 'etag', 'last-modified',
    'accept-ranges', 'content-range', 'www-authenticate', 'retry-after', 'allow'];

function capture(c: any, response: { headers: [string, string][], body: Buffer }) {
    for (const rule of c.capture ?? []) {
        let text: string | undefined;
        if (rule.from.startsWith('header:')) text = response.headers.find(([k]) => k === rule.from.slice(7))?.[1];
        else {
            let value: any = JSON.parse(response.body.toString('utf8'));
            for (const part of rule.pointer.split('/').slice(1)) value = value?.[part];
            text = value == null ? undefined : String(value);
        }
        if (text !== undefined && rule.pattern) text = text.match(new RegExp(rule.pattern))?.[1];
        if (text === undefined) {
            throw new Error(`${c.name}: nothing to capture as ${rule.as} in ${response.body.toString('utf8').slice(0, 200)}`);
        }
        captured[rule.as] = text;
    }
}

// Generated values are replaced by names, the same way in `app_recordings.rs`: captured values
// by `$NAME`, then times, OAuth tokens, ObjectIds, the refresh lifetime in seconds and codes.
function normalise(text: string): string {
    for (const [name, value] of Object.entries(captured).sort((a, b) => b[1].length - a[1].length)) {
        text = text.split(value).join('$' + name);
    }
    return text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '$DATE')
        .replace(/dima_(at|rt)_[A-Za-z0-9_-]{43}/g, (_m, k) => `$${k.toUpperCase()}_TOKEN`)
        .replace(/\b[0-9a-f]{24}\b/g, '$OID')
        .replace(/"refresh_expires_in":\d+/g, '"refresh_expires_in":$SECONDS')
        .replace(/([?&])code=[A-Za-z0-9_-]{43}/g, '$1code=$SECRET');
}
const normaliseJson = (value: any) => JSON.parse(normalise(JSON.stringify(value)));

const rows: any[] = [];
const port = await listen(http.createServer(await server.server()));
const rateKeys = ['oauth:127.0.0.1', 'desktop:127.0.0.1', `approval:${cases.users[0].twitch_id}`].map(b => `oauth:rate:${hash(b)}`);
try {
    await Promise.all([OAuthClient.init(), OAuthGrant.init(), OAuthSession.init(), OAuthRefreshToken.init(), Users.init()]);
    await service.initializeOAuth();
    for (const user of cases.users) {
        await Users.create({ name: user.name, accounts: [{ type: 'twitch', id: user.twitch_id, name: user.login }] });
    }
    await redis.del(rateKeys);
    for (const c of cases.cases) {
        upstream = []; calls = []; snapshotFails = c.snapshot === 'fail';
        const repeat = c.repeat ?? 1;
        const statuses: Record<string, number> = {};
        let firstRefused: number | null = null;
        let response: any;
        for (let i = 0; i < repeat; i++) {
            response = await send(port, c);
            statuses[response.status] = (statuses[response.status] ?? 0) + 1;
            if (response.status === 429 && firstRefused === null) firstRefused = i;
        }
        capture(c, response);
        const text = response.body.toString('utf8');
        const utf8 = Buffer.from(text, 'utf8').equals(response.body);
        const body = utf8 ? normalise(text) : null;
        const headers = response.headers.filter(([k]: [string, string]) => COMPARED.includes(k))
            .map(([k, v]: [string, string]) => [k, k === 'etag' && (body !== text || c.volatile_etag) ? '$ETAG' : normalise(v)]);
        rows.push({
            name: c.name,
            status: response.status,
            headers,
            body,
            body_base64: utf8 ? null : response.body.toString('base64'),
            ...(repeat > 1 ? { burst: { statuses, first_refused: firstRefused } } : {}),
            ...(c.upstream ? { upstream: normaliseJson(upstream) } : {}),
            ...(c.area ? { calls: normaliseJson(calls) } : {}),
        });
    }
    const sha256 = Object.fromEntries(SOURCES.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
    fs.writeFileSync(here('app-reference.json'), JSON.stringify({ sha256, captured: Object.keys(captured), rows }, null, 1) + '\n');
    console.log(`recorded ${rows.length} rows`);
} catch (error) {
    console.log('RECORDING FAILED', error);
    process.exitCode = 1;
} finally {
    const secrets = ['REQUEST', 'REQUEST2'].map(k => `oauth:request:${hash(captured[k] ?? '')}`)
        .concat(['CODE'].map(k => `oauth:code:${hash(captured[k] ?? '')}`))
        .concat(['AT', 'AT2'].map(k => `oauth:access:${hash(captured[k] ?? '')}`));
    await redis.del([...rateKeys, ...secrets, ...['198.51.100.1', '198.51.100.2'].map(a => `oauth:rate:${hash('oauth:' + a)}`)]);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await redis.quit();
    fs.rmSync(scratch, { recursive: true, force: true });
    twitch.close(); analytics.close();
    process.exit(process.exitCode ?? 0);
}
