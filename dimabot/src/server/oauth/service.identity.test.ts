/**
 * Identity binding (approver vs channel), audience (RFC 8707), CIMD client records, channel choice,
 * legacy records and the CIMD denylist, against small in-memory Mongo/Redis fakes.
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
            if ('$in' in want) return (Array.isArray(have) ? have : [have]).some(item => want.$in.includes(item));
            if ('$elemMatch' in want) return (have ?? []).some((item: Doc) => matches(item, want.$elemMatch));
        }
        if (Array.isArray(have)) return have.map(String).includes(String(want));
        return String(have) === String(want);
    });
}
const chain = <T>(value: T): Promise<T> & { select: () => any; lean: () => any; limit: () => any } =>
    Object.assign(Promise.resolve(value), { select: () => chain(value), lean: () => chain(value), limit: () => chain(value) });
function apply(doc: Doc, change: Doc) {
    Object.assign(doc, change.$set ?? {});
    for (const [field, { $each }] of Object.entries(change.$addToSet ?? {}) as [string, { $each: string[] }][]) {
        doc[field] = [...new Set([...(doc[field] ?? []), ...$each])];
    }
}
const store = new Map<string, string>();
const users: Doc[] = [], clients: Doc[] = [], grants: Doc[] = [], sessions: Doc[] = [], refreshTokens: Doc[] = [], admins: Doc[] = [];
const cimdDocs = new Map<string, Doc>(), denied = new Set<string>(), adminAccess = new Set<string>();
let documentFetches = 0;

mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    get: async (key: string) => store.get(key) ?? null,
    getDel: async (key: string) => { const value = store.get(key) ?? null; store.delete(key); return value; },
    del: async (key: string) => Number(store.delete(key))
}) } });
mock.module('../../schemas/users.schema.js', { defaultExport: {
    findOne: (filter: Doc) => chain(users.find(user => matches(user, filter)) ?? null),
    exists: async (filter: Doc) => users.find(user => matches(user, filter)) ? { _id: 'exists' } : null
} });
mock.module('../../schemas/oauth_client.schema.js', { namedExports: { OAuthClient: {
    findOne: (filter: Doc) => chain(clients.find(client => matches(client, filter)) ?? null)
} } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {
    findOne: (filter: Doc) => chain(grants.find(grant => matches(grant, filter)) ?? null),
    findOneAndUpdate: async (filter: Doc, change: Doc) => {
        let grant = grants.find(item => matches(item, filter));
        if (!grant) grants.push(grant = { _id: new Types.ObjectId(), ...filter, scopes: [] });
        apply(grant, change);
        return grant;
    }
} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {
    create: async (doc: Doc) => { const session = { _id: new Types.ObjectId(), revoked_at: null, ...doc }; sessions.push(session); return session; },
    findOne: (filter: Doc) => chain(sessions.find(session => matches(session, filter)) ?? null),
    find: (filter: Doc) => chain(sessions.filter(session => matches(session, filter))),
    findOneAndUpdate: async (filter: Doc, change: Doc) => {
        const session = sessions.find(item => matches(item, filter));
        if (session) apply(session, change);
        return session ?? null;
    },
    updateOne: async (filter: Doc, change: Doc) => { const session = sessions.find(item => matches(item, filter)); if (session) apply(session, change); }
} } });
mock.module('../../schemas/oauth_refresh_token.schema.js', { namedExports: { OAuthRefreshToken: {
    create: async (doc: Doc) => { refreshTokens.push({ _id: new Types.ObjectId(), used_at: null, ...doc }); },
    findOne: (filter: Doc) => chain(refreshTokens.find(token => matches(token, filter)) ?? null),
    updateOne: async (filter: Doc, change: Doc) => { const token = refreshTokens.find(item => matches(item, filter)); if (token) apply(token, change); }
} } });
/** Platform staff: the real access check gives them owner-level access on every channel they reach. */
const STAFF = '900';
/** Every access check the OAuth service makes must use the MCP rules (explicit mcp:admin, no staff elevation). */
const accessModes: string[] = [];
mock.module('../../schemas/admin.schema.js', { namedExports: { AdminSchema: {
    find: (filter: Doc) => chain(admins.filter(row => matches(row, filter)))
} } });
mock.module('../../site_agent/access.js', { namedExports: {
    resolveAccess: async (requester: string, channel: string, mode?: string) => (accessModes.push(mode ?? 'site'), requester === channel || adminAccess.has(`${requester}>${channel}`)) ?
        { channelId: channel, channelLogin: `login_${channel}`, role: requester === channel || requester === STAFF ? 'owner' : 'admin', plan: 'free', savedLang: null } : null
} });
mock.module('./cimd.js', { namedExports: {
    RECOGNIZED_CIMD_CLIENTS: [],
    isCimdClientId: (value: unknown) => typeof value === 'string' && value.startsWith('https://'),
    resolveCimdClient: async (clientID: string) => {
        documentFetches++;
        const client = cimdDocs.get(clientID);
        if (!client || denied.has(clientID)) throw new OAuthError('invalid_client');
        return client;
    },
    isCimdClientDenied: async (clientID: string) => denied.has(clientID)
} });
const service = await import('./service.js');
const { approveAuthorization, authenticateAccess, browserChannels, exchangeCode, getAuthorization, hash,
    listConnections, OAuthRedirectError, refreshAccess, startAuthorization } = service;

const ownerID = new Types.ObjectId(), adminID = new Types.ObjectId();
beforeEach(() => {
    for (const list of [users, clients, grants, sessions, refreshTokens, admins]) list.length = 0;
    store.clear(); cimdDocs.clear(); denied.clear(); adminAccess.clear(); documentFetches = 0;
    users.push({ _id: ownerID, name: 'Owner', accounts: [{ type: 'twitch', id: '100', name: 'owner_one' }] },
        { _id: adminID, name: 'Admin', accounts: [{ type: 'twitch', id: '200', name: 'admin_two' }] },
        { _id: new Types.ObjectId(), name: 'Channel', accounts: [{ type: 'twitch', id: '300', name: 'channel_three' }] });
    clients.push({ client_id: 'dima-desktop', name: 'Dima Desktop Beta', enabled: true,
        redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
        allowed_scopes: ['profile:read', 'credits:read', 'desktop:connect'] });
    cimdDocs.set(APP, { client_id: APP, client_name: 'Example\u0007 App', redirect_uris: [APP_CALLBACK, 'http://localhost/cb'],
        document_host: 'app.example', recognized: true });
    admins.push({ adminID: '200', channelID: '300', actived: true, permissions: ['dashboard:view', 'mcp:admin'] },
        { adminID: '200', channelID: '400', actived: true, permissions: ['dashboard:view'] },
        { adminID: '200', channelID: '500', actived: false, permissions: ['*'] });
    adminAccess.add('200>300');
});

const desktopParams = (overrides: Doc = {}) => ({ client_id: 'dima-desktop', response_type: 'code', redirect_uri: CALLBACK,
    scope: 'profile:read desktop:connect', code_challenge: CHALLENGE, code_challenge_method: 'S256', ...overrides });
const appParams = (overrides: Doc = {}) => ({ client_id: APP, response_type: 'code', redirect_uri: APP_CALLBACK,
    scope: 'channel:read channel:write', resource: MCP, code_challenge: CHALLENGE, code_challenge_method: 'S256', ...overrides });
async function code(params: Doc, twitchID: string, channelID?: string) {
    const id = await startAuthorization(params);
    return { id, code: new URL(await approveAuthorization(id, twitchID, true, channelID)).searchParams.get('code')! };
}
const exchange = (auth: { code: string }, params: Doc, overrides: Doc = {}) => exchangeCode({ client_id: params.client_id,
    code: auth.code, redirect_uri: params.redirect_uri, code_verifier: VERIFIER, ...overrides });
async function rejects(promise: Promise<unknown>, code: string, status = 400) {
    await assert.rejects(promise, (error: unknown) => error instanceof OAuthError && error.code === code && error.status === status, code);
}
async function redirectError(params: Doc, code: string) {
    const error = await startAuthorization(params).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof OAuthRedirectError, `${JSON.stringify(params)}: expected a redirect, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(new URL(error.location).searchParams.get('error'), code);
}
const session = (id: string) => sessions.find(item => String(item._id) === id)!;

test('desktop: approver, own channel and the desktop audience are bound end to end', async () => {
    const auth = await code(desktopParams(), '100');
    const tokens = await exchange(auth, desktopParams());
    const stored = session(tokens.session_id);
    assert.deepEqual([stored.user_id, stored.client_id, stored.client_name, stored.requester_id, stored.channel_id, stored.resource, stored.device_name],
        [ownerID.toString(), 'dima-desktop', 'Dima Desktop Beta', '100', '100', DESKTOP, 'Desktop computer']);
    const identity = { session_id: tokens.session_id, user_id: ownerID.toString(), client_id: 'dima-desktop', requester_id: '100',
        channel_id: '100', resource: DESKTOP, scopes: ['profile:read', 'desktop:connect'] };
    assert.deepEqual(await authenticateAccess(tokens.access_token, { resource: DESKTOP }), identity);
    assert.deepEqual(await authenticateAccess(tokens.access_token), identity, 'no audience option: any valid token');
    await rejects(authenticateAccess(tokens.access_token, { resource: MCP }), 'invalid_token', 401);
    await rejects(refreshAccess({ client_id: 'dima-desktop', refresh_token: tokens.refresh_token, resource: MCP }), 'invalid_target');
    const renewed = await refreshAccess({ client_id: 'dima-desktop', refresh_token: tokens.refresh_token, resource: DESKTOP });
    assert.deepEqual(await authenticateAccess(renewed.access_token, { resource: DESKTOP }), identity);
});

test('desktop: an explicit desktop resource works; MCP or repeated resources are invalid_target', async () => {
    const auth = await code(desktopParams({ resource: DESKTOP }), '100');
    await rejects(exchange(auth, desktopParams(), { resource: MCP }), 'invalid_target');
    assert.equal((await exchange(auth, desktopParams(), { resource: DESKTOP })).token_type, 'Bearer', 'a refused resource does not consume the code');
    await redirectError(desktopParams({ resource: MCP }), 'invalid_target');
    await redirectError(desktopParams({ resource: [DESKTOP, DESKTOP] }), 'invalid_target');
    await redirectError(desktopParams({ resource: '' }), 'invalid_target');
    await redirectError(desktopParams({ scope: 'profile:read channel:read' }), 'invalid_scope');
});

test('desktop: channel_id is refused on approve and deny, and the request stays usable', async () => {
    const id = await startAuthorization(desktopParams());
    await rejects(approveAuthorization(id, '100', true, '100'), 'invalid_request');
    await rejects(approveAuthorization(id, '100', false, '300'), 'invalid_request');
    assert.equal(new URL(await approveAuthorization(id, '100', false)).searchParams.get('error'), 'access_denied');
});

test('legacy request, code, session and access records normalize to the approver\'s own channel and the desktop API', async () => {
    const legacyRequest = 'r'.repeat(43);
    store.set(`oauth:request:${hash(legacyRequest)}`, JSON.stringify({ client_id: 'dima-desktop', redirect_uri: CALLBACK,
        scopes: ['profile:read'], code_challenge: CHALLENGE, device_name: 'Old PC' }));
    assert.equal((await getAuthorization(legacyRequest)).request.resource, DESKTOP);
    const legacyCode = 'c'.repeat(43);
    store.set(`oauth:code:${hash(legacyCode)}`, JSON.stringify({ client_id: 'dima-desktop', redirect_uri: CALLBACK,
        scopes: ['profile:read'], code_challenge: CHALLENGE, device_name: 'Old PC', user_id: ownerID.toString(), channel_id: '100' }));
    const fromCode = await exchange({ code: legacyCode }, desktopParams(), { resource: DESKTOP });
    assert.equal(session(fromCode.session_id).requester_id, '100');
    // A session and access token written before this release.
    const tokens = await exchange(await code(desktopParams(), '100'), desktopParams());
    const old = session(tokens.session_id);
    delete old.requester_id; delete old.resource; delete old.client_name;
    const key = `oauth:access:${hash(tokens.access_token)}`;
    const { requester_id: _requester, resource: _resource, ...legacy } = JSON.parse(store.get(key)!);
    store.set(key, JSON.stringify(legacy));
    const identity = await authenticateAccess(tokens.access_token, { resource: DESKTOP });
    assert.equal(identity.requester_id, '100');
    assert.equal(identity.resource, DESKTOP);
    await rejects(authenticateAccess(tokens.access_token, { resource: MCP }), 'invalid_token', 401);
    const renewed = await refreshAccess({ client_id: 'dima-desktop', refresh_token: tokens.refresh_token });
    assert.deepEqual(JSON.parse(store.get(`oauth:access:${hash(renewed.access_token)}`)!), { ...legacy, requester_id: '100', resource: DESKTOP });
    const listed = (await listConnections(ownerID)).find(item => String(item._id) === tokens.session_id)!;
    assert.deepEqual([listed.client_name, listed.channel_id, listed.resource], ['Dima Desktop Beta', '100', DESKTOP]);
});

test('CIMD: the record comes from the resolver; MCP audience and MCP scopes only', async () => {
    const id = await startAuthorization(appParams());
    const { request, client } = await getAuthorization(id);
    assert.deepEqual(client, { client_id: APP, name: 'Example\u0007 App', kind: 'cimd', application_type: 'web',
        redirect_uris: [APP_CALLBACK, 'http://localhost/cb'], allowed_scopes: ['channel:read', 'channel:write'], resources: [MCP],
        channel_selection: true, recognized: true, document_host: 'app.example' });
    assert.equal(request.device_name, 'Example App', 'device name defaults to the sanitized client name');
    await redirectError(appParams({ resource: undefined }), 'invalid_target');
    await redirectError(appParams({ resource: DESKTOP }), 'invalid_target');
    await redirectError(appParams({ resource: [MCP, MCP] }), 'invalid_target');
    await redirectError(appParams({ scope: 'profile:read' }), 'invalid_scope');
    await redirectError(appParams({ scope: 'channel:read stream:act' }), 'invalid_scope');
    await rejects(startAuthorization(appParams({ client_id: 'https://unknown.example/client.json' })), 'invalid_client');
    await rejects(startAuthorization(appParams({ client_id: `https://app.example/${'x'.repeat(500)}` })), 'invalid_client');
});

test('redirects: localhost only for CIMD loopback, any port; https exact', async () => {
    assert.ok(await startAuthorization(appParams({ redirect_uri: 'http://localhost:5555/cb' })));
    assert.ok(await startAuthorization(appParams({ redirect_uri: 'http://localhost:6000/cb' })));
    for (const redirect of ['http://127.0.0.1:5555/cb', 'http://localhost:5555/other', 'http://localhost/cb',
        `${APP_CALLBACK}?x=1`, `${APP_CALLBACK}/`, 'https://app.example/callback#x', 'http://app.example/callback']) {
        await rejects(startAuthorization(appParams({ redirect_uri: redirect })), 'invalid_request');
    }
    await rejects(startAuthorization(desktopParams({ redirect_uri: 'http://localhost:42781/oauth/callback' })), 'invalid_request');
    const native = cimdDocs.get(APP)!;
    native.redirect_uris = ['http://127.0.0.1/cb', 'http://[::1]:8080/cb'];
    assert.equal((await getAuthorization(await startAuthorization(appParams({ redirect_uri: 'http://[::1]:9999/cb' })))).client.application_type, 'native');
});

test('channel choice: required for CIMD, checked at approval and again at exchange', async () => {
    const id = await startAuthorization(appParams());
    await rejects(approveAuthorization(id, '200', true), 'invalid_request');
    await rejects(approveAuthorization(id, '200', true, 'abc'), 'invalid_request');
    await rejects(approveAuthorization(id, '100', true, '300'), 'channel_access_required', 403);
    const approved = new URL(await approveAuthorization(id, '200', true, '300'));
    assert.ok(approved.searchParams.get('code'), 'a refused channel did not consume the request');
    const tokens = await exchange({ code: approved.searchParams.get('code')! }, appParams(), { resource: MCP });
    assert.deepEqual(await authenticateAccess(tokens.access_token, { resource: MCP }), { session_id: tokens.session_id,
        user_id: adminID.toString(), client_id: APP, requester_id: '200', channel_id: '300', resource: MCP,
        scopes: ['channel:read', 'channel:write'] });
    assert.equal(session(tokens.session_id).client_name, 'Example App');
    await rejects(authenticateAccess(tokens.access_token, { resource: DESKTOP }), 'invalid_token', 401);
    // Own channel needs no admin row.
    const own = await exchange(await code(appParams(), '100', '100'), appParams());
    assert.equal((await authenticateAccess(own.access_token, { resource: MCP })).channel_id, '100');
    // Access lost between approval and exchange, and later at refresh.
    const pending = await code(appParams(), '200', '300');
    adminAccess.delete('200>300');
    await rejects(exchange(pending, appParams()), 'invalid_grant');
    await rejects(refreshAccess({ client_id: APP, refresh_token: tokens.refresh_token }), 'invalid_grant');
    adminAccess.add('200>300');
    assert.equal((await refreshAccess({ client_id: APP, refresh_token: tokens.refresh_token, resource: MCP })).token_type, 'Bearer');
});

test('CIMD: the document is fetched only when authorization starts; later steps use the snapshot and the denylist', async () => {
    const id = await startAuthorization(appParams());
    assert.equal(documentFetches, 1);
    cimdDocs.delete(APP);
    assert.equal((await getAuthorization(id)).client.name, 'Example\u0007 App', 'consent reads the stored snapshot');
    const approved = new URL(await approveAuthorization(id, '200', true, '300')).searchParams.get('code')!;
    await rejects(exchange({ code: approved }, appParams(), { client_id: 'https://other.example/client.json' }), 'invalid_grant');
    const tokens = await exchange({ code: approved }, appParams());
    await refreshAccess({ client_id: APP, refresh_token: tokens.refresh_token });
    await service.revokeToken({ client_id: APP, token: tokens.access_token });
    assert.equal(documentFetches, 1, 'consent, decision, exchange, refresh and revocation never fetch');
    // A client denylisted after authorization started is refused at consent, decision and exchange.
    cimdDocs.set(APP, { client_id: APP, client_name: 'Example', redirect_uris: [APP_CALLBACK], document_host: 'app.example', recognized: false });
    const pending = await startAuthorization(appParams());
    const pendingCode = await code(appParams(), '100', '100');
    denied.add(APP);
    await rejects(getAuthorization(pending), 'invalid_client');
    await rejects(approveAuthorization(pending, '100', true, '100'), 'invalid_client');
    await rejects(exchange(pendingCode, appParams()), 'invalid_client');
    // A stored request that claims a CIMD client_id without its snapshot is refused, never fetched.
    const forged = 'f'.repeat(43);
    denied.clear();
    store.set(`oauth:request:${hash(forged)}`, JSON.stringify({ client_id: APP, redirect_uri: APP_CALLBACK, scopes: ['channel:read'],
        code_challenge: CHALLENGE, device_name: 'X', resource: MCP }));
    const before = documentFetches;
    await rejects(getAuthorization(forged), 'invalid_client');
    assert.equal(documentFetches, before);
});

test('a session dies when its approving account leaves the user', async () => {
    const desktop = await exchange(await code(desktopParams(), '100'), desktopParams());
    const app = await exchange(await code(appParams(), '200', '300'), appParams());
    users[0].accounts = []; users[1].accounts = [{ type: 'twitch', id: '201' }];
    await rejects(authenticateAccess(desktop.access_token, { resource: DESKTOP }), 'invalid_token', 401);
    await rejects(authenticateAccess(app.access_token, { resource: MCP }), 'invalid_token', 401);
    await rejects(refreshAccess({ client_id: 'dima-desktop', refresh_token: desktop.refresh_token }), 'invalid_grant');
    await rejects(refreshAccess({ client_id: APP, refresh_token: app.refresh_token }), 'invalid_grant');
});

test('a denylisted CIMD client: sessions and refresh fail without refetching the document', async () => {
    const tokens = await exchange(await code(appParams(), '100', '100'), appParams());
    const fetches = documentFetches;
    assert.ok(await authenticateAccess(tokens.access_token, { resource: MCP }));
    denied.add(APP);
    await rejects(authenticateAccess(tokens.access_token, { resource: MCP }), 'invalid_token', 401);
    await rejects(refreshAccess({ client_id: APP, refresh_token: tokens.refresh_token }), 'invalid_grant');
    assert.equal((await listConnections(ownerID)).some(item => item.client_id === APP), false, 'its connections are listed no more');
    assert.equal(documentFetches, fetches, 'sessions, refresh and the connections list use the cheap denylist check');
    await rejects(startAuthorization(appParams()), 'invalid_client');
    denied.clear();
    assert.equal((await listConnections(ownerID)).find(item => item.client_id === APP)?.client_name, 'Example App');
});

test('browser channels: own channel plus active admin rows the access check accepts', async () => {
    assert.deepEqual(await browserChannels('200'), [{ id: '200', name: 'login_200', role: 'owner' },
        { id: '300', name: 'login_300', role: 'admin' }]);
    assert.deepEqual(await browserChannels('100'), [{ id: '100', name: 'login_100', role: 'owner' }]);
});

test('browser channels: only channels whose owner gave AI apps (mcp:admin); labels follow the relationship', async () => {
    accessModes.length = 0;
    // Full access alone does not include AI apps; staff elevation never counts.
    admins.push({ adminID: STAFF, channelID: '300', actived: true, permissions: ['*'] },
        { adminID: STAFF, channelID: '400', actived: true, permissions: ['*', 'mcp:admin'] });
    for (const id of ['300', '400', STAFF]) adminAccess.add(`${STAFF}>${id}`);
    assert.deepEqual(await browserChannels(STAFF), [{ id: STAFF, name: `login_${STAFF}`, role: 'owner' },
        { id: '400', name: 'login_400', role: 'admin' }]);
    assert.ok(accessModes.length > 0 && accessModes.every(mode => mode === 'mcp'), 'channel checks use the MCP rules');
});

test('every OAuth channel check uses the MCP rules', () => {
    assert.ok(accessModes.every(mode => mode === 'mcp'), `modes seen: ${[...new Set(accessModes)].join(', ')}`);
});
