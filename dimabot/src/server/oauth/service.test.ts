/**
 * startAuthorization: client and redirect_uri are trusted first (JSON errors), later failures
 * return to the callback (RFC 6749 §4.1.2.1), and state is optional and echoed exactly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, mock, test } from 'node:test';

process.env.PUBLIC_API_URL = 'https://api.domdimabot.com';
const ISSUER = 'https://api.domdimabot.com';
const CALLBACK = 'http://127.0.0.1:42781/oauth/callback';
const CHALLENGE = createHash('sha256').update('fixture-verifier').digest('base64url');
const DESKTOP_STATE = 'S1_-'.repeat(10) + 'abc';
const store = new Map<string, string>();
const clients = new Map<string, any>();
let redisFailure: Error | null = null, mongoFailure: Error | null = null;
const query = (value: unknown) => ({ lean: async () => { if (mongoFailure) throw mongoFailure; return value; } });
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    set: async (key: string, value: string) => { if (redisFailure) throw redisFailure; store.set(key, value); return 'OK'; },
    get: async (key: string) => store.get(key) ?? null,
    getDel: async (key: string) => { const value = store.get(key) ?? null; store.delete(key); return value; }
}) } });
mock.module('../../schemas/oauth_client.schema.js', { namedExports: { OAuthClient: {
    findOne: (filter: { client_id: string }) => query(clients.get(filter.client_id)?.enabled ? clients.get(filter.client_id) : null)
} } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {} } });
mock.module('../../schemas/oauth_refresh_token.schema.js', { namedExports: { OAuthRefreshToken: {} } });
mock.module('../../schemas/users.schema.js', { defaultExport: { findOne: () => query({ _id: 'user-a' }) } });
const { OAuthError } = await import('./catalog.js');
const { OAuthRedirectError, approveAuthorization, hash, startAuthorization } = await import('./service.js');

beforeEach(() => {
    store.clear(); clients.clear(); redisFailure = mongoFailure = null;
    clients.set('dima-desktop', { client_id: 'dima-desktop', enabled: true,
        redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
        allowed_scopes: ['profile:read', 'credits:read', 'desktop:connect', 'pet:read'] });
    clients.set('limited', { client_id: 'limited', enabled: true, redirect_uris: ['http://127.0.0.1/oauth/callback'], allowed_scopes: ['profile:read'] });
    clients.set('disabled', { client_id: 'disabled', enabled: false, redirect_uris: ['http://127.0.0.1/oauth/callback'], allowed_scopes: ['profile:read'] });
});

/** The desktop app's request; an undefined override omits that parameter. */
function params(overrides: Record<string, unknown> = {}) {
    const input: Record<string, unknown> = { client_id: 'dima-desktop', response_type: 'code', redirect_uri: CALLBACK,
        scope: 'profile:read credits:read desktop:connect', state: DESKTOP_STATE, code_challenge: CHALLENGE,
        code_challenge_method: 'S256', device_name: 'Streaming PC', ...overrides };
    for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
    return input;
}
const stored = (id: string) => JSON.parse(store.get(`oauth:request:${hash(id)}`) ?? 'null');
async function failure(input: Record<string, unknown>): Promise<unknown> {
    try { await startAuthorization(input); } catch (error) { return error; }
    throw new Error('startAuthorization should have failed');
}
async function redirected(overrides: Record<string, unknown>, error: string, state: string | null) {
    const label = JSON.stringify(overrides);
    const caught = await failure(params(overrides));
    if (!(caught instanceof OAuthRedirectError)) throw new Error(`${label}: expected a redirect, got ${String(caught)}`);
    assert.equal(caught.code, error, label);
    const url = new URL(caught.location);
    assert.equal(url.origin + url.pathname, overrides.redirect_uri ?? CALLBACK, label);
    assert.deepEqual([...url.searchParams.keys()].sort(),
        ['error', 'error_description', 'iss', ...(state === null ? [] : ['state'])].sort(), label);
    assert.equal(url.searchParams.get('error'), error, label);
    assert.equal(url.searchParams.get('iss'), ISSUER, label);
    assert.equal(url.searchParams.get('state'), state, label);
    const description = url.searchParams.get('error_description')!;
    assert.match(description, /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/, label);
    for (const value of Object.values(overrides)) {
        if (typeof value === 'string' && value) assert.equal(description.includes(value), false, `${label}: input is never echoed`);
    }
    assert.equal(store.size, 0, `${label}: nothing is stored`);
}

test('the desktop request (43-character state) is stored and the callback echoes state, iss and code', async () => {
    const id = await startAuthorization(params());
    assert.match(id, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(stored(id), { client_id: 'dima-desktop', redirect_uri: CALLBACK,
        scopes: ['profile:read', 'credits:read', 'desktop:connect'], state: DESKTOP_STATE,
        code_challenge: CHALLENGE, device_name: 'Streaming PC' });
    const callback = new URL(await approveAuthorization(id, '123', true));
    assert.equal(callback.origin + callback.pathname, CALLBACK);
    assert.equal(callback.searchParams.get('state'), DESKTOP_STATE);
    assert.equal(callback.searchParams.get('iss'), ISSUER);
    assert.match(callback.searchParams.get('code')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(callback.searchParams.get('error'), null);
    const ipv6 = await startAuthorization(params({ redirect_uri: 'http://[::1]:42781/oauth/callback', device_name: undefined }));
    assert.equal(stored(ipv6).redirect_uri, 'http://[::1]:42781/oauth/callback');
    assert.equal(stored(ipv6).device_name, 'Desktop computer');
});

test('any 1-500 character VSCHAR state is stored as given and echoed exactly', async () => {
    for (const state of ['abcdefghij0123456789', 'a', 'x'.repeat(500), ' !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~', '%20+&state=x']) {
        const approved = await startAuthorization(params({ state }));
        assert.equal(stored(approved).state, state);
        assert.equal(new URL(await approveAuthorization(approved, '123', true)).searchParams.get('state'), state);
        const denied = await startAuthorization(params({ state }));
        const callback = new URL(await approveAuthorization(denied, '123', false));
        assert.equal(callback.searchParams.get('state'), state);
        assert.equal(callback.searchParams.get('error'), 'access_denied');
    }
});

test('without state, the request works and neither approve nor deny adds one to the callback', async () => {
    const approved = await startAuthorization(params({ state: undefined }));
    assert.equal(Object.hasOwn(stored(approved), 'state'), false);
    let callback = new URL(await approveAuthorization(approved, '123', true));
    assert.equal(callback.searchParams.has('state'), false);
    assert.equal(callback.searchParams.get('iss'), ISSUER);
    assert.ok(callback.searchParams.get('code'));
    const denied = await startAuthorization(params({ state: undefined }));
    callback = new URL(await approveAuthorization(denied, '123', false));
    assert.deepEqual([...callback.searchParams.keys()], ['iss', 'error']);
    assert.equal(callback.searchParams.get('error'), 'access_denied');
});

test('client and redirect_uri failures stay JSON errors and never redirect, even with other bad parameters', async () => {
    const cases: [Record<string, unknown>, string][] = [
        [{ client_id: 'unknown' }, 'invalid_client'], [{ client_id: undefined }, 'invalid_client'],
        [{ client_id: 'disabled' }, 'invalid_client'], [{ client_id: ['dima-desktop', 'other'] }, 'invalid_client'],
        [{ client_id: 'x'.repeat(101) }, 'invalid_client'],
        [{ redirect_uri: undefined }, 'invalid_request'], [{ redirect_uri: 'https://evil.invalid/oauth/callback' }, 'invalid_request'],
        [{ redirect_uri: 'http://localhost:42781/oauth/callback' }, 'invalid_request'],
        [{ redirect_uri: 'http://127.0.0.1:42781/other' }, 'invalid_request'],
        [{ redirect_uri: 'http://127.0.0.1/oauth/callback' }, 'invalid_request'],
        [{ redirect_uri: `${CALLBACK}?redirect=evil` }, 'invalid_request'], [{ redirect_uri: `${CALLBACK}#fragment` }, 'invalid_request'],
        [{ redirect_uri: [CALLBACK, 'http://127.0.0.1:42782/oauth/callback'] }, 'invalid_request']
    ];
    const alsoBad = [{}, { response_type: 'token' }, { code_challenge_method: 'plain' }, { state: '' }, { scope: '*' }, { device_name: 'bad\nname' }];
    for (const [override, code] of cases) for (const extra of alsoBad) {
        const label = JSON.stringify({ ...override, ...extra });
        const caught = await failure(params({ ...extra, ...override }));
        assert.ok(caught instanceof OAuthError, label);
        assert.equal(caught instanceof OAuthRedirectError, false, label);
        assert.equal((caught as InstanceType<typeof OAuthError>).code, code, label);
        assert.equal((caught as InstanceType<typeof OAuthError>).status, 400, label);
    }
    assert.equal(store.size, 0);
});

test('later failures redirect to the validated callback with error, a static description, iss and the valid state', async () => {
    const cases: [Record<string, unknown>, string][] = [
        [{ response_type: 'token' }, 'unsupported_response_type'], [{ response_type: 'code token' }, 'unsupported_response_type'],
        [{ response_type: undefined }, 'invalid_request'], [{ response_type: ['code', 'code'] }, 'invalid_request'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge_method: undefined }, 'invalid_request'],
        [{ code_challenge_method: 's256' }, 'invalid_request'],
        [{ code_challenge: 'short' }, 'invalid_request'], [{ code_challenge: undefined }, 'invalid_request'],
        [{ code_challenge: `${CHALLENGE}=` }, 'invalid_request'], [{ code_challenge: [CHALLENGE, CHALLENGE] }, 'invalid_request'],
        [{ scope: '*' }, 'invalid_scope'], [{ scope: 'usage:read' }, 'invalid_scope'], [{ scope: 'profile:read  credits:read' }, 'invalid_scope'],
        [{ scope: '' }, 'invalid_scope'], [{ scope: undefined }, 'invalid_scope'], [{ scope: ['profile:read', 'credits:read'] }, 'invalid_scope'],
        [{ scope: 'x'.repeat(501) }, 'invalid_scope'],
        [{ client_id: 'limited', scope: 'profile:read credits:read' }, 'invalid_scope'],
        [{ device_name: 'bad\nname' }, 'invalid_request'], [{ device_name: '   ' }, 'invalid_request'],
        [{ device_name: 'x'.repeat(81) }, 'invalid_request'], [{ device_name: ['PC', 'PC'] }, 'invalid_request'],
        [{ redirect_uri: 'http://[::1]:42781/oauth/callback', scope: '*' }, 'invalid_scope']
    ];
    for (const [override, error] of cases) {
        await redirected(override, error, DESKTOP_STATE);
        await redirected({ ...override, state: 'short state' }, error, 'short state');
        await redirected({ ...override, state: undefined }, error, null);
    }
});

test('an invalid state fails as invalid_request and is never echoed', async () => {
    for (const state of ['', 'x'.repeat(501), 'bad\nstate', 'tab\tstate', 'café', '\u007f', ['a', 'b'], { a: 'b' }, 42]) {
        await redirected({ state }, 'invalid_request', null);
        // Another reported error still leaves the bad state out.
        await redirected({ state, response_type: 'token' }, 'unsupported_response_type', null);
    }
});

test('server errors are not turned into redirects', async () => {
    redisFailure = new Error('redis down');
    assert.equal(await failure(params()), redisFailure);
    redisFailure = null; mongoFailure = new Error('mongo down');
    assert.equal(await failure(params({ response_type: 'token' })), mongoFailure);
});
