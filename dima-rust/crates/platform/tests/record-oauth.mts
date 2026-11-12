// Records the OAuth decision table from the frozen `server/oauth/service.ts` and `catalog.ts`
// against a scratch MongoDB database and scratch keys in Dragonfly database 15, by running the
// step script of `oauth-cases.json` (the Rust test runs the same script).
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//       "$REPO/dima-rust/crates/platform/tests/record-oauth.mts"
//
// Only the two OAuth files are evaluated (transpiled; imports replaced by the real Mongoose
// models, a Dragonfly client on database 15 and the real `node:crypto`). It also records the
// cross-compatibility proof: a session issued here (documents as Mongoose stored them, and its
// fixture tokens) for the Rust test to use, and, when `oauth-rust-issued.json` exists, the
// outcome of using a session the Rust service issued with this TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const cases = JSON.parse(fs.readFileSync(here('oauth-cases.json'), 'utf8'));
const root = process.env.DIMABOT_DIR!;
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { createClient } = require('redis');
const { EJSON } = mongoose.mongo.BSON;
const SOURCES = ['src/server/oauth/service.ts', 'src/server/oauth/catalog.ts', 'src/schemas/oauth_client.schema.ts',
    'src/schemas/oauth_grant.schema.ts', 'src/schemas/oauth_session.schema.ts', 'src/schemas/oauth_refresh_token.schema.ts',
    'src/schemas/users.schema.ts'];

function load(rel: string, mapping: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, any> };
    const req = (spec: string) => {
        if (spec in mapping) return mapping[spec];
        throw new Error(`unexpected import ${spec} in ${rel}`);
    };
    const names = Object.keys(extra);
    vm.compileFunction(out, ['exports', 'require', 'module', ...names])(module.exports, req, module, ...names.map(n => extra[n]));
    return module.exports;
}

const run = randomBytes(6).toString('hex');
const b64 = (n: number) => randomBytes(n).toString('base64url');
const hash = (v: string) => createHash('sha256').update(v).digest('base64url');
const idOf = (kind: string) => `9${createHash('sha256').update(kind + run).digest('hex').replace(/\D/g, '').slice(0, 9)}`;
const R = 'http://127.0.0.1:53682/oauth/callback';

const dbName = `dima_test_platform_${run}`;
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI!, { dbName });
const redis = createClient({ url: `redis://${process.env.DIMA_TEST_DRAGONFLY}/15` });
redis.on('error', () => {});
await redis.connect();
const imp = (rel: string) => import(path.join(root, rel));
const { default: Users } = await imp('src/schemas/users.schema.ts');
const { OAuthClient } = await imp('src/schemas/oauth_client.schema.ts');
const { OAuthGrant } = await imp('src/schemas/oauth_grant.schema.ts');
const { OAuthSession } = await imp('src/schemas/oauth_session.schema.ts');
const { OAuthRefreshToken } = await imp('src/schemas/oauth_refresh_token.schema.ts');
const catalog = load('src/server/oauth/catalog.ts', {});
const service = load('src/server/oauth/service.ts', {
    'node:crypto': crypto,
    mongoose,
    '../../schemas/users.schema.js': { __esModule: true, default: Users },
    '../../schemas/oauth_client.schema.js': { OAuthClient },
    '../../schemas/oauth_grant.schema.js': { OAuthGrant },
    '../../schemas/oauth_session.schema.js': { OAuthSession },
    '../../schemas/oauth_refresh_token.schema.js': { OAuthRefreshToken },
    '../../utils/databases/dragonfly.database.js': { getDragonflyClient: async () => redis },
    './catalog.js': catalog,
}, { process: { env: {} } });
const ACTIVE = Object.entries(catalog.OAUTH_SCOPES).filter(([, v]: any) => v.active).map(([k]) => k);

// ------------------------------------------------------------------ the step interpreter
const generated: Record<string, string> = {};
const gen = (kind: string, n: string) => {
    const key = `${kind}${n}`;
    if (!(key in generated)) {
        if (kind === 'verifier') generated[key] = b64(48);
        if (kind === 'state') generated[key] = b64(32);
        if (kind === 'challenge') generated[key] = hash(gen('verifier', n));
    }
    return generated[key];
};
const saved: Record<string, any> = {};
const users: Record<string, string> = {};
const keys = new Set<string>();
const track = (kind: string, secret: string) => keys.add(`oauth:${kind}:${hash(secret)}`);

function resolve(value: any): any {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    if (typeof value !== 'string') return value;
    let m;
    if (value === '$R') return R;
    if (value === '$active') return ACTIVE;
    if (value === '$long_redirect') return R + '#' + 'a'.repeat(301 - R.length - 1);
    if (value === '$long_scope') return 'profile:read '.repeat(40).trim();
    if ((m = value.match(/^\$(challenge|verifier|state)(\d+)$/))) return gen(m[1], m[2]);
    if ((m = value.match(/^\$repeat:(\d+):(.)$/))) return m[2].repeat(Number(m[1]));
    if ((m = value.match(/^\$emoji:(\d+)$/))) return '😀'.repeat(Number(m[1]));
    if ((m = value.match(/^\$v\.([a-z0-9_]+)(?:\.([a-z]+))?$/))) return m[2] ? saved[m[1]]?.[m[2]] : saved[m[1]];
    if (value.includes('$random43')) return value.replace('$random43', b64(32));
    return value;
}

const nameOf = (value: unknown) => Object.entries(generated).find(([, v]) => v === value)?.[0] ?? '?';
const sessionName = (id: unknown) => Object.entries(saved).find(([, v]) => v?.session === id)?.[0] ?? '?';
const userName = (id: unknown) => Object.entries(users).find(([, v]) => v === String(id))?.[0] ?? '?';
const channelName = (id: unknown) => [...cases.site_users, 'stranger'].find((k: string) => idOf(k) === id) ?? '?';

function tokens(response: any) {
    return {
        keys: Object.keys(response),
        access_token: /^dima_at_[A-Za-z0-9_-]{43}$/.test(response.access_token) ? 'dima_at_*' : response.access_token,
        token_type: response.token_type,
        expires_in: response.expires_in,
        refresh_token: /^dima_rt_[A-Za-z0-9_-]{43}$/.test(response.refresh_token) ? 'dima_rt_*' : response.refresh_token,
        scope: response.scope,
        session_id: /^[0-9a-f]{24}$/.test(response.session_id) ? '<session>' : response.session_id,
        refresh_expires_in_hours: Math.round(response.refresh_expires_in / 3600),
    };
}

function standardInput(step: any) {
    const input: Record<string, unknown> = { response_type: 'code', code_challenge_method: 'S256',
        code_challenge: gen('challenge', '1'), state: gen('state', '1'), client_id: step.client ?? 'dima-desktop',
        redirect_uri: 'redirect' in step ? resolve(step.redirect) : R, scope: step.scope ?? 'profile:read desktop:connect' };
    if ('device' in step) input.device_name = resolve(step.device);
    return input;
}

async function approve(id: string, user: string, ok: boolean, save?: string) {
    const url: string = await service.approveAuthorization(id, idOf(user), ok);
    const code = new URL(url).searchParams.get('code');
    let text = url;
    for (const [name, value] of Object.entries(generated)) text = text.replaceAll(value, '$' + name);
    if (code) { track('code', code); if (save) saved[save] = code; text = text.replace(code, '<code>'); }
    return { url: text };
}

async function issue(step: any) {
    const id = await service.startAuthorization({ ...standardInput(step), device_name: 'Issued' });
    track('request', id);
    await approve(id, step.user, true, '__code');
    const response = await service.exchangeCode({ client_id: step.client ?? 'dima-desktop', code: saved.__code,
        code_verifier: gen('verifier', '1'), redirect_uri: R });
    track('access', response.access_token);
    if (step.save) saved[step.save] = { access: response.access_token, refresh: response.refresh_token, session: response.session_id };
    return tokens(response);
}

async function sessionView(id: string) {
    const s: any = await OAuthSession.findById(id).select('+current_refresh_hash').lean();
    if (!s) return { exists: false };
    const day = 86400000;
    return {
        exists: true, revoked: s.revoked_at != null, reason: s.revoke_reason ?? null, client_id: s.client_id,
        channel: channelName(s.channel_id), user: userName(s.user_id), device_name: s.device_name, scopes: s.scopes,
        idle_days: Math.round((s.idle_expires_at - s.last_used_at) / day),
        absolute_days: Math.round((s.expires_at - s.createdAt) / day),
        has_hash: typeof s.current_refresh_hash === 'string' && s.current_refresh_hash.length === 43,
        refresh_tokens: await OAuthRefreshToken.countDocuments({ session_id: s._id }),
        used_tokens: await OAuthRefreshToken.countDocuments({ session_id: s._id, used_at: { $ne: null } }),
    };
}

async function step(s: any): Promise<unknown> {
    switch (s.op) {
        case 'initialize': await service.initializeOAuth(); return {};
        case 'inspect_client': {
            const c: any = await OAuthClient.findOne({ client_id: s.client }).lean();
            return { name: c.name, type: c.type, enabled: c.enabled, redirect_uris: c.redirect_uris,
                allowed_scopes: c.allowed_scopes, timestamps: !!c.createdAt && !!c.updatedAt, version: c.__v };
        }
        case 'set_client': await OAuthClient.collection.updateOne({ client_id: s.client }, { $set: resolve(s.set) }); return {};
        case 'start': {
            const id = await service.startAuthorization(s.input ? resolve(s.input) : standardInput(s));
            track('request', id);
            if (s.save) saved[s.save] = id;
            return { id: /^[A-Za-z0-9_-]{43}$/.test(id) ? '<id>' : id };
        }
        case 'get': {
            const r = await service.getAuthorization(resolve(s.id));
            return { ...r, state: nameOf(r.state), code_challenge: nameOf(r.code_challenge) };
        }
        case 'approve': return approve(resolve(s.id), s.user, s.approve, s.save);
        case 'start_approve': {
            const id = await service.startAuthorization(standardInput(s));
            track('request', id);
            return approve(id, s.user, true, s.save);
        }
        case 'exchange': case 'refresh': {
            const response = s.op === 'exchange' ? await service.exchangeCode(resolve(s.input)) : await service.refreshAccess(resolve(s.input));
            track('access', response.access_token);
            if (s.save) saved[s.save] = { access: response.access_token, refresh: response.refresh_token, session: response.session_id };
            return tokens(response);
        }
        case 'issue': return issue(s);
        case 'authenticate': {
            const identity = await service.authenticateAccess(s.token === undefined ? undefined : resolve(s.token));
            return { keys: Object.keys(identity), session_id: sessionName(identity.session_id), user_id: userName(identity.user_id),
                client_id: identity.client_id, channel_id: channelName(identity.channel_id), scopes: identity.scopes };
        }
        case 'revoke_token': await service.revokeToken(resolve(s.input)); return {};
        case 'revoke_session': await service.revokeSession(resolve(s.session)); return {};
        case 'revoke_user': await service.revokeUserOAuth(s.raw ?? users[s.user]); return {};
        case 'inspect_session': return sessionView(resolve(s.session));
        case 'inspect_grant': {
            const grants: any[] = await OAuthGrant.find({ user_id: users[s.user], client_id: s.client }).lean();
            return { count: grants.length, scopes: grants[0]?.scopes ?? null, revoked: grants[0] ? grants[0].revoked_at != null : null };
        }
        case 'inspect_user_oauth': return {
            grants: await OAuthGrant.countDocuments({ user_id: users[s.user] }),
            sessions: await OAuthSession.countDocuments({ user_id: users[s.user] }),
            refresh_tokens: await OAuthRefreshToken.countDocuments({ session_id: resolve(s.session) }),
        };
        case 'set_account': {
            const id = idOf(s.user);
            await Users.collection.updateOne({ _id: new mongoose.Types.ObjectId(users[s.user]) },
                { $set: { 'accounts.0.id': s.present ? id : `gone_${id}` } });
            return {};
        }
        case 'revoke_grant': {
            const session: any = await OAuthSession.findById(resolve(s.session)).lean();
            await OAuthGrant.collection.updateOne({ _id: session.grant_id }, { $set: { revoked_at: new Date() } });
            return {};
        }
        case 'set_session': {
            const set: Record<string, unknown> = {};
            if (s.past) set[s.past] = new Date(Date.now() - 60000);
            if (s.scopes) set.scopes = s.scopes;
            await OAuthSession.collection.updateOne({ _id: new mongoose.Types.ObjectId(resolve(s.session)) }, { $set: set });
            return {};
        }
        case 'expire_refresh':
            await OAuthRefreshToken.collection.updateOne({ token_hash: hash(resolve(s.token)) }, { $set: { expires_at: new Date(Date.now() - 60000) } });
            return {};
        case 'delete_key': await redis.del(`oauth:${s.kind}:${hash(resolve(s.value))}`); return {};
        case 'key_exists': return { exists: await redis.exists(`oauth:${s.kind}:${hash(resolve(s.value))}`) === 1 };
        case 'rate': keys.add(`oauth:rate:${hash(`test:${run}`)}`); await service.rateLimit(`test:${run}`, s.limit); return {};
        case 'rate_ttl': { const ttl = await redis.ttl(`oauth:rate:${hash(`test:${run}`)}`); return { window: ttl > 50 && ttl <= 60 }; }
        default: throw new Error(`unknown op ${s.op}`);
    }
}

// ---------------------------------------------------------------------------- recording
const ejson = (doc: unknown) => JSON.parse(EJSON.stringify(doc, { relaxed: false }));
try {
    for (const kind of cases.site_users) {
        const user = await Users.create({ name: `site_${kind}`, accounts: [{ type: 'twitch', id: idOf(kind), name: `login_${kind}` }] });
        users[kind] = user._id.toString();
    }
    for (const client of cases.clients) {
        await OAuthClient.create({ client_id: client.client_id, name: client.client_id, type: 'public',
            redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
            allowed_scopes: resolve(client.allowed_scopes), enabled: client.enabled });
    }
    const rows: unknown[] = [];
    for (const s of cases.steps) {
        let outcome;
        try { outcome = { ok: await step(s) }; }
        catch (error: any) {
            outcome = error instanceof catalog.OAuthError
                ? { error: error.code, status: error.status }
                : { error: 'temporarily_unavailable', status: 503, unexpected: String(error?.message ?? error) };
        }
        rows.push({ name: s.name, outcome });
    }

    // Issued here, used by Rust: the stored documents exactly as Mongoose wrote them.
    const tsIssued = await issue({ user: 'cross', save: 'cross' });
    const cross = saved.cross;
    const session: any = await OAuthSession.findById(cross.session).select('+current_refresh_hash').lean();
    const tsDocs = {
        users: [ejson(await Users.findById(users.cross).lean())],
        oauth_clients: [ejson(await OAuthClient.findOne({ client_id: 'dima-desktop' }).lean())],
        oauth_grants: [ejson(await OAuthGrant.findById(session.grant_id).lean())],
        oauth_sessions: [ejson(session)],
        oauth_refresh_tokens: (await OAuthRefreshToken.find({ session_id: session._id }).lean()).map(ejson),
    };
    const accessValue = await redis.get(`oauth:access:${hash(cross.access)}`);

    // Issued by Rust, used here.
    let rustIssued: unknown = null;
    const rustFile = here('oauth-rust-issued.json');
    if (fs.existsSync(rustFile)) {
        const fixture = JSON.parse(fs.readFileSync(rustFile, 'utf8'));
        const db = mongoose.connection.db;
        for (const [collection, docs] of Object.entries(fixture.documents as Record<string, unknown[]>)) {
            // Every date moves by the time since the fixture was issued, so it is as fresh now.
            const shift = Date.now() - Number(fixture.issued_at_ms);
            const moved = (value: any): any => value instanceof Date ? new Date(value.getTime() + shift)
                : Array.isArray(value) ? value.map(moved)
                : value && typeof value === 'object' && value.constructor === Object
                    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, moved(v)])) : value;
            const parsed = docs.map((d: unknown) => moved(EJSON.parse(JSON.stringify(d), { relaxed: false })));
            // A fresh database per fixture user would also do; ids are unique, so insert beside.
            for (const doc of parsed) {
                if (collection === 'oauth_clients') await db.collection(collection).deleteOne({ client_id: (doc as any).client_id });
                await db.collection(collection).insertOne(doc);
            }
        }
        await redis.set(`oauth:access:${hash(fixture.access_token)}`, fixture.access_value, { EX: 600 });
        keys.add(`oauth:access:${hash(fixture.access_token)}`);
        const attempt = async (f: () => Promise<unknown>) => { try { return { ok: await f() }; } catch (e: any) { return { error: e.code ?? String(e) }; } };
        const identity = await attempt(() => service.authenticateAccess(fixture.access_token));
        const refreshed: any = await attempt(() => service.refreshAccess({ client_id: 'dima-desktop', refresh_token: fixture.refresh_token }));
        if (refreshed.ok) track('access', refreshed.ok.access_token);
        const newAccess = refreshed.ok ? await attempt(() => service.authenticateAccess(refreshed.ok.access_token)) : null;
        const reuse = await attempt(() => service.refreshAccess({ client_id: 'dima-desktop', refresh_token: fixture.refresh_token }));
        rustIssued = {
            fixture_sha256: createHash('sha256').update(fs.readFileSync(rustFile)).digest('hex'),
            authenticate: (identity as any).ok ? 'ok' : identity,
            refresh: refreshed.ok ? tokens(refreshed.ok) : refreshed,
            new_access: newAccess && (newAccess as any).ok ? 'ok' : newAccess,
            reuse_of_old_refresh: reuse,
        };
    }

    const sha256 = Object.fromEntries(SOURCES.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
    fs.writeFileSync(here('oauth-reference.json'), JSON.stringify({
        sha256, rows,
        tsIssued: { response: tsIssued, access_token: cross.access, refresh_token: cross.refresh, session_id: cross.session,
            access_value: accessValue, documents: tsDocs },
        rustIssued,
    }, null, 1) + '\n');
} finally {
    if (keys.size) await redis.del([...keys]);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await redis.quit();
}
