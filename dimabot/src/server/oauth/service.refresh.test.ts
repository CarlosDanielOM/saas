/**
 * Refresh rotation with a 60 s grace for the token just replaced: replays and overlapping refreshes get the same
 * successor, while reuse outside the grace still ends the session. In-memory Mongo/Redis fakes; Redis keys expire on a
 * fake clock, and a barrier makes two refreshes reach the compare-and-set together.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, mock, test } from 'node:test';
import { Types } from 'mongoose';
import { OAuthError } from './catalog.js';

process.env.PUBLIC_API_URL = 'https://api.domdimabot.com';
delete process.env.MCP_PUBLIC_URL;
const DESKTOP = 'https://api.domdimabot.com/v1', MCP = 'https://mcp.domdimabot.com/mcp';
const CALLBACK = 'http://127.0.0.1:42781/oauth/callback';
const APP = 'https://app.example/oauth/client.json', APP_CALLBACK = 'https://app.example/callback';
const VERIFIER = 'v'.repeat(43), CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, want]) => {
        const have = doc[key];
        if (want === null) return have == null;
        if (want && typeof want === 'object' && !(want instanceof Types.ObjectId)) {
            if ('$gt' in want) return have > want.$gt;
            if ('$elemMatch' in want) return (have ?? []).some((item: Doc) => matches(item, want.$elemMatch));
        }
        if (Array.isArray(have)) return have.map(String).includes(String(want));
        return String(have) === String(want);
    });
}
/** Reads return snapshots, like Mongo; the stored document changes only through writes. */
const copy = <T extends Doc | null | undefined>(doc: T): T => (doc ? { ...doc } : doc);
const chain = <T>(value: T): Promise<T> & { select: () => any; lean: () => any } =>
    Object.assign(Promise.resolve(value), { select: () => chain(value), lean: () => chain(value) });
const apply = (doc: Doc, change: Doc) => {
    Object.assign(doc, change.$set ?? {});
    for (const [field, { $each }] of Object.entries(change.$addToSet ?? {}) as [string, { $each: string[] }][]) {
        doc[field] = [...new Set([...(doc[field] ?? []), ...$each])];
    }
};

/** Redis with EX on a fake clock; `graceWrite` delays or fails grace-record writes. */
const store = new Map<string, { value: string; ex?: number; expiresAt?: number }>();
let clock = 0;
const graceWrite: { delayMs: number; fail: boolean } = { delayMs: 0, fail: false };
const live = (key: string) => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now() + clock) { store.delete(key); return undefined; }
    return entry;
};
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    set: async (key: string, value: string, options?: { EX?: number }) => {
        if (key.startsWith('oauth:refresh:grace:')) {
            if (graceWrite.delayMs) await new Promise(resolve => setTimeout(resolve, graceWrite.delayMs));
            if (graceWrite.fail) throw new Error('redis down');
        }
        store.set(key, { value, ex: options?.EX, expiresAt: options?.EX ? Date.now() + clock + options.EX * 1000 : undefined });
        return 'OK';
    },
    get: async (key: string) => live(key)?.value ?? null,
    getDel: async (key: string) => { const value = live(key)?.value ?? null; store.delete(key); return value; },
    del: async (key: string) => Number(store.delete(key))
}) } });

const users: Doc[] = [], clients: Doc[] = [], grants: Doc[] = [], sessions: Doc[] = [], refreshTokens: Doc[] = [];
const cimdDocs = new Map<string, Doc>(), adminAccess = new Set<string>();
let deletedTokens = 0;
/** Holds refreshes at the compare-and-set until `want` of them are there, so they race on it. */
let barrier: { want: number; arrived: number; release: () => void; ready: Promise<void> } | null = null;
function armBarrier(want: number) {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    barrier = { want, arrived: 0, release, ready };
}

mock.module('../../schemas/users.schema.js', { defaultExport: {
    findOne: (filter: Doc) => chain(copy(users.find(user => matches(user, filter)) ?? null)),
    exists: async (filter: Doc) => users.find(user => matches(user, filter)) ? { _id: 'exists' } : null
} });
mock.module('../../schemas/oauth_client.schema.js', { namedExports: { OAuthClient: {
    findOne: (filter: Doc) => chain(copy(clients.find(client => matches(client, filter)) ?? null))
} } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {
    findOne: (filter: Doc) => chain(copy(grants.find(grant => matches(grant, filter)) ?? null)),
    findOneAndUpdate: async (filter: Doc, change: Doc) => {
        let grant = grants.find(item => matches(item, filter));
        if (!grant) grants.push(grant = { _id: new Types.ObjectId(), ...filter, scopes: [] });
        apply(grant, change);
        return copy(grant);
    }
} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {
    create: async (doc: Doc) => { const session = { _id: new Types.ObjectId(), revoked_at: null, ...doc }; sessions.push(session); return copy(session); },
    findOne: (filter: Doc) => chain(copy(sessions.find(session => matches(session, filter)) ?? null)),
    findOneAndUpdate: async (filter: Doc, change: Doc) => {
        if (barrier && 'current_refresh_hash' in filter) {
            if (++barrier.arrived >= barrier.want) barrier.release();
            await barrier.ready;
        }
        const session = sessions.find(item => matches(item, filter));
        if (session) apply(session, change);
        return copy(session ?? null);
    },
    updateOne: async (filter: Doc, change: Doc) => { const session = sessions.find(item => matches(item, filter)); if (session) apply(session, change); }
} } });
mock.module('../../schemas/oauth_refresh_token.schema.js', { namedExports: { OAuthRefreshToken: {
    create: async (doc: Doc) => { const token = { _id: new Types.ObjectId(), used_at: null, ...doc }; refreshTokens.push(token); return copy(token); },
    findOne: (filter: Doc) => chain(copy(refreshTokens.find(token => matches(token, filter)) ?? null)),
    updateOne: async (filter: Doc, change: Doc) => { const token = refreshTokens.find(item => matches(item, filter)); if (token) apply(token, change); },
    deleteOne: async (filter: Doc) => {
        const index = refreshTokens.findIndex(item => matches(item, filter));
        if (index >= 0) { refreshTokens.splice(index, 1); deletedTokens++; }
        return { deletedCount: index >= 0 ? 1 : 0 };
    }
} } });
mock.module('../../schemas/admin.schema.js', { namedExports: { AdminSchema: {} } });
mock.module('../../site_agent/access.js', { namedExports: {
    resolveAccess: async (requester: string, channel: string) => requester === channel || adminAccess.has(`${requester}>${channel}`) ?
        { channelId: channel, channelLogin: `login_${channel}`, role: requester === channel ? 'owner' : 'admin', plan: 'free', savedLang: null } : null
} });
mock.module('./cimd.js', { namedExports: {
    RECOGNIZED_CIMD_CLIENTS: [],
    isCimdClientId: (value: unknown) => typeof value === 'string' && value.startsWith('https://'),
    resolveCimdClient: async (clientID: string) => {
        const client = cimdDocs.get(clientID);
        if (!client) throw new OAuthError('invalid_client');
        return client;
    },
    isCimdClientDenied: async () => false
} });
const { approveAuthorization, authenticateAccess, exchangeCode, hash, refreshAccess, revokeSession, startAuthorization } = await import('./service.js');

const ownerID = new Types.ObjectId();
beforeEach(() => {
    for (const list of [users, clients, grants, sessions, refreshTokens]) list.length = 0;
    store.clear(); cimdDocs.clear(); adminAccess.clear();
    clock = 0; deletedTokens = 0; barrier = null;
    Object.assign(graceWrite, { delayMs: 0, fail: false });
    users.push({ _id: ownerID, name: 'Owner', accounts: [{ type: 'twitch', id: '100', name: 'owner_one' }] },
        { _id: new Types.ObjectId(), name: 'Admin', accounts: [{ type: 'twitch', id: '200', name: 'admin_two' }] });
    for (const client_id of ['dima-desktop', 'other-desktop']) {
        clients.push({ client_id, name: client_id, enabled: true, redirect_uris: ['http://127.0.0.1/oauth/callback'],
            allowed_scopes: ['profile:read', 'desktop:connect'] });
    }
    cimdDocs.set(APP, { client_id: APP, client_name: 'Example App', redirect_uris: [APP_CALLBACK], document_host: 'app.example', recognized: false });
    adminAccess.add('200>300');
});

const SCOPE = 'profile:read desktop:connect';
async function mint(params: Doc = { client_id: 'dima-desktop', redirect_uri: CALLBACK, scope: SCOPE }, twitchID = '100', channelID?: string) {
    const id = await startAuthorization({ response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', ...params });
    const code = new URL(await approveAuthorization(id, twitchID, true, channelID)).searchParams.get('code')!;
    return exchangeCode({ client_id: params.client_id, code, redirect_uri: params.redirect_uri, code_verifier: VERIFIER });
}
const mintApp = () => mint({ client_id: APP, redirect_uri: APP_CALLBACK, scope: 'channel:read', resource: MCP }, '200', '300');
const refresh = (refresh_token: string, extra: Doc = {}) => refreshAccess({ client_id: 'dima-desktop', refresh_token, ...extra });
const session = (id: string) => sessions.find(item => String(item._id) === id)!;
const graceKey = (token: string) => `oauth:refresh:grace:${hash(token)}`;
async function refused(promise: Promise<unknown>, code: string) {
    await assert.rejects(promise, (error: unknown) => error instanceof OAuthError && error.code === code && error.status === 400, code);
}
const alive = async (access: string, resource = DESKTOP) => (await authenticateAccess(access, { resource })).session_id;
async function dead(access: string, resource = DESKTOP) {
    await assert.rejects(authenticateAccess(access, { resource }), (error: unknown) => error instanceof OAuthError && error.code === 'invalid_token');
}
async function until(condition: () => boolean) {
    for (let i = 0; i < 1000 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(condition(), 'condition never became true');
}

test('a replay within the grace gets a new access token and the same successor; the session lives', async () => {
    const first = await mint();
    const rotated = await refresh(first.refresh_token);
    assert.notEqual(rotated.refresh_token, first.refresh_token);
    assert.equal(store.get(graceKey(first.refresh_token))?.ex, 60, 'grace record keyed by the replaced token, 60 s');
    const replay = await refresh(first.refresh_token, { scope: SCOPE, resource: DESKTOP });
    assert.equal(replay.refresh_token, rotated.refresh_token);
    assert.notEqual(replay.access_token, rotated.access_token);
    assert.deepEqual(Object.keys(replay).sort(), Object.keys(rotated).sort(), 'same response shape');
    assert.deepEqual([replay.token_type, replay.expires_in, replay.scope, replay.session_id],
        [rotated.token_type, rotated.expires_in, rotated.scope, rotated.session_id]);
    assert.ok(replay.refresh_expires_in > 0);
    for (const access of [first.access_token, rotated.access_token, replay.access_token]) assert.equal(await alive(access), first.session_id);
    assert.equal(session(first.session_id).revoked_at, null);
    // A second replay in the window is answered the same way; rotation then carries on from the successor.
    assert.equal((await refresh(first.refresh_token)).refresh_token, rotated.refresh_token);
    const next = await refresh(rotated.refresh_token);
    assert.notEqual(next.refresh_token, rotated.refresh_token);
    assert.equal(await alive(next.access_token), first.session_id);
});

test('a replay after the grace expired is reuse: the session is revoked', async () => {
    const first = await mint();
    const rotated = await refresh(first.refresh_token);
    clock = 59_000;
    assert.equal((await refresh(first.refresh_token)).refresh_token, rotated.refresh_token, 'still inside 60 s');
    clock = 61_000;
    await refused(refresh(first.refresh_token), 'invalid_grant');
    assert.equal(session(first.session_id).revoke_reason, 'refresh_reuse');
    await dead(rotated.access_token);
    await refused(refresh(rotated.refresh_token), 'invalid_grant');
});

test('a replay after the successor was itself rotated is reuse: the session is revoked', async () => {
    const first = await mint();
    const second = await refresh(first.refresh_token);
    const third = await refresh(second.refresh_token);
    // The token just replaced still has its own grace, which points at the current token.
    assert.equal((await refresh(second.refresh_token)).refresh_token, third.refresh_token);
    await refused(refresh(first.refresh_token), 'invalid_grant');
    assert.equal(session(first.session_id).revoke_reason, 'refresh_reuse');
    await dead(third.access_token);
});

test('two concurrent refreshes of one token both succeed with the same successor; the loser\'s record is gone', async () => {
    const first = await mint();
    armBarrier(2);
    const [a, b] = await Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
    assert.equal(barrier!.arrived, 2, 'both reached the compare-and-set');
    assert.equal(a.refresh_token, b.refresh_token);
    assert.notEqual(a.access_token, b.access_token);
    assert.equal(await alive(a.access_token), first.session_id);
    assert.equal(await alive(b.access_token), first.session_id);
    const stored = session(first.session_id);
    assert.equal(stored.revoked_at, null);
    assert.equal(stored.current_refresh_hash, hash(a.refresh_token));
    assert.equal(deletedTokens, 1);
    const records = refreshTokens.filter(item => String(item.session_id) === first.session_id);
    assert.deepEqual(records.map(item => [item.token_hash, item.used_at instanceof Date]),
        [[hash(first.refresh_token), true], [hash(a.refresh_token), false]], 'only the replaced token and the issued successor remain');
    assert.notEqual((await refresh(a.refresh_token)).refresh_token, a.refresh_token, 'the shared successor rotates normally');
});

test('three at once also share one successor', async () => {
    const first = await mint();
    armBarrier(3);
    const results = await Promise.all([1, 2, 3].map(() => refresh(first.refresh_token)));
    assert.equal(new Set(results.map(item => item.refresh_token)).size, 1);
    assert.equal(new Set(results.map(item => item.access_token)).size, 3);
    assert.equal(deletedTokens, 2);
    assert.equal(session(first.session_id).revoked_at, null);
});

test('a replay that arrives between the swap and the grace write waits for the grace', async () => {
    const first = await mint();
    graceWrite.delayMs = 300;
    const winner = refresh(first.refresh_token);
    await until(() => session(first.session_id).current_refresh_hash !== hash(first.refresh_token));
    const started = Date.now();
    const late = await refresh(first.refresh_token);
    assert.ok(Date.now() - started >= 200, 'it waited for the record');
    assert.equal(late.refresh_token, (await winner).refresh_token);
    assert.equal(session(first.session_id).revoked_at, null);
});

test('a failed grace write keeps the refresh working and only removes the grace', async () => {
    const warned = mock.method(console, 'warn', () => {});
    try {
        graceWrite.fail = true;
        const first = await mint();
        const rotated = await refresh(first.refresh_token);
        assert.equal(await alive(rotated.access_token), first.session_id, 'the normal refresh is unaffected');
        assert.equal(store.has(graceKey(first.refresh_token)), false);
        await refused(refresh(first.refresh_token), 'invalid_grant');
        assert.equal(session(first.session_id).revoke_reason, 'refresh_reuse', 'without a grace, a replay is reuse');
        // Concurrent: the loser waits for a grace that never comes, then revokes.
        const other = await mint();
        armBarrier(2);
        const started = Date.now();
        const settled = await Promise.allSettled([refresh(other.refresh_token), refresh(other.refresh_token)]);
        assert.ok(Date.now() - started >= 1400, 'the loser waited about 1.5 s');
        assert.deepEqual(settled.map(item => item.status).sort(), ['fulfilled', 'rejected']);
        const failure = settled.find(item => item.status === 'rejected') as PromiseRejectedResult;
        assert.equal((failure.reason as InstanceType<typeof OAuthError>).code, 'invalid_grant');
        assert.equal(session(other.session_id).revoke_reason, 'refresh_reuse');
        assert.ok(warned.mock.callCount() >= 2);
        assert.ok(warned.mock.calls.every(call => !JSON.stringify(call.arguments).includes('dima_rt_')), 'no token in the log');
    } finally { warned.mock.restore(); }
});

test('during the grace a wrong client, scope or resource is refused and the session stays', async () => {
    const first = await mint();
    const rotated = await refresh(first.refresh_token);
    await refused(refreshAccess({ client_id: 'other-desktop', refresh_token: first.refresh_token }), 'invalid_grant');
    await refused(refreshAccess({ client_id: APP, refresh_token: first.refresh_token }), 'invalid_grant');
    await refused(refresh(first.refresh_token, { scope: 'profile:read' }), 'invalid_scope');
    await refused(refresh(first.refresh_token, { scope: `${SCOPE} credits:read` }), 'invalid_scope');
    await refused(refresh(first.refresh_token, { resource: MCP }), 'invalid_target');
    assert.equal(session(first.session_id).revoked_at, null);
    assert.equal(await alive(rotated.access_token), first.session_id);
    assert.equal((await refresh(first.refresh_token)).refresh_token, rotated.refresh_token, 'the real client still gets the successor');
});

test('during the grace, a channel-selection app is refused once the approver loses the channel', async () => {
    const first = await mintApp();
    const rotated = await refreshAccess({ client_id: APP, refresh_token: first.refresh_token });
    adminAccess.delete('200>300');
    await refused(refreshAccess({ client_id: APP, refresh_token: first.refresh_token }), 'invalid_grant');
    adminAccess.add('200>300');
    const replay = await refreshAccess({ client_id: APP, refresh_token: first.refresh_token, resource: MCP });
    assert.equal(replay.refresh_token, rotated.refresh_token);
    assert.equal(await alive(replay.access_token, MCP), first.session_id);
});

test('a grace replay never revives a revoked session', async () => {
    const first = await mint();
    await refresh(first.refresh_token);
    await revokeSession(first.session_id);
    await refused(refresh(first.refresh_token), 'invalid_grant');
    assert.equal(session(first.session_id).revoke_reason, 'user_revoked');
});

test('Dragonfly holds no plaintext refresh token; a grace record opens only with the token it was sealed for', async () => {
    const a = await mint(), b = await mint();
    const aNext = await refresh(a.refresh_token), bNext = await refresh(b.refresh_token);
    await refresh(a.refresh_token);
    const tokens = [a.refresh_token, aNext.refresh_token, b.refresh_token, bNext.refresh_token];
    for (const [key, { value }] of store) {
        assert.equal(`${key} ${value}`.includes('dima_rt_'), false, key);
        for (const token of tokens) assert.equal(`${key} ${value}`.includes(token.slice(8)), false, key);
    }
    const record = JSON.parse(store.get(graceKey(a.refresh_token))!.value);
    assert.deepEqual(Object.keys(record).sort(), ['data', 'iv', 'next_hash', 'session_id', 'tag', 'v']);
    assert.equal(record.next_hash, hash(aNext.refresh_token));
    // A's record under B's key cannot be opened with B's token: treated as reuse.
    store.set(graceKey(b.refresh_token), { ...store.get(graceKey(a.refresh_token))! });
    await refused(refresh(b.refresh_token), 'invalid_grant');
    assert.equal(session(b.session_id).revoke_reason, 'refresh_reuse');
    // A tampered record (session moved) fails authentication too.
    store.set(graceKey(a.refresh_token), { value: JSON.stringify({ ...record, session_id: b.session_id }) });
    await refused(refresh(a.refresh_token), 'invalid_grant');
    assert.equal(session(a.session_id).revoke_reason, 'refresh_reuse');
});
