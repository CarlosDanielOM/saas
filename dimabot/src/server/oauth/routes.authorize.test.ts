/**
 * GET /oauth/authorize: untrusted client/redirect_uri answer JSON 400, later failures 302 to the
 * callback, and rate limits or server errors stay JSON.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';

process.env.PUBLIC_API_URL = 'https://api.domdimabot.com';
process.env.DASHBOARD_URL = 'https://domdimabot.com';
const CALLBACK = 'http://127.0.0.1:42781/oauth/callback';
const STATE = 'S'.repeat(43);
const store = new Map<string, string>();
let redisFailure: Error | null = null, mongoFailure: Error | null = null, limited = false;
const client = { client_id: 'dima-desktop', enabled: true, redirect_uris: ['http://127.0.0.1/oauth/callback'],
    allowed_scopes: ['profile:read', 'credits:read', 'desktop:connect'] };
class PetError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
class PetSettingsError extends PetError {}
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    set: async (key: string, value: string) => { if (redisFailure) throw redisFailure; store.set(key, value); return 'OK'; }
}) } });
mock.module('../../schemas/oauth_client.schema.js', { namedExports: { OAuthClient: {
    findOne: (filter: { client_id: string }) => ({ lean: async () => {
        if (mongoFailure) throw mongoFailure;
        return filter.client_id === client.client_id ? client : null;
    } })
} } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {} } });
mock.module('../../schemas/oauth_refresh_token.schema.js', { namedExports: { OAuthRefreshToken: {} } });
mock.module('../../schemas/users.schema.js', { defaultExport: {} });
mock.module('../../schemas/admin.schema.js', { namedExports: { AdminSchema: {} } });
mock.module('../../site_agent/access.js', { namedExports: { resolveAccess: async () => null } });
mock.module('./cimd.js', { namedExports: { RECOGNIZED_CIMD_CLIENTS: [], isCimdClientId: () => false,
    resolveCimdClient: async () => assert.fail('no CIMD client here'), isCimdClientDenied: async () => true } });
mock.module('../../utils/billing.js', { namedExports: { getAiCredits: async () => ({}) } });
mock.module('../../utils/ai_credit_display.js', { namedExports: { getFreeAiCreditDisplay: async () => null } });
mock.module('../services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => ({}), PetSettingsError } });
mock.module('../../pets/state.js', { namedExports: { PetError, cancelPetRequest: async () => ({}) } });
mock.module('../../pets/runtime.js', { namedExports: { getPetRuntime: async () => ({}) } });
mock.module('../../pets/selection.js', { namedExports: { selectOwnPetPlayback: async () => ({}) } });
mock.module('../../desktop_ai/service.js', { namedExports: { submitTurn: async () => ({}), getTurn: async () => ({}),
    cancelTurn: async () => ({}), cancelSpeech: async () => ({}), claimAudio: async () => ({}), speechEvent: async () => ({}) } });
mock.module('../../desktop_ai/updates.js', { namedExports: { TURN_STATUS_FEATURE: 'turn_status' } });
const { OAuthError } = await import('./catalog.js');
const realService = await import('./service.js');
// The router-wide limiter is another concern; only its 429 shape matters here.
mock.module('./service.js', { namedExports: { ...realService,
    rateLimit: async () => { if (limited) throw new OAuthError('slow_down', 429); } } });
const { oauthRoute } = await import('./routes.js');

const app = express();
app.use('/oauth', oauthRoute);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/authorize`;
after(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { store.clear(); redisFailure = mongoFailure = null; limited = false; });

async function authorize(overrides: Record<string, string | undefined> = {}, extra = '') {
    const input: Record<string, string> = {};
    for (const [key, value] of Object.entries({ client_id: 'dima-desktop', response_type: 'code', redirect_uri: CALLBACK,
        scope: 'profile:read', state: STATE, code_challenge: createHash('sha256').update('v').digest('base64url'),
        code_challenge_method: 'S256', ...overrides })) if (value !== undefined) input[key] = value;
    const response = await fetch(`${base}?${new URLSearchParams(input)}${extra}`, { redirect: 'manual' });
    const location = response.headers.get('location');
    return { status: response.status, headers: response.headers, location: location ? new URL(location) : null,
        body: response.status === 302 ? null : await response.json() as Record<string, unknown> };
}
function callbackError(result: Awaited<ReturnType<typeof authorize>>, error: string, state: string | null) {
    assert.equal(result.status, 302);
    assert.equal(result.location!.origin + result.location!.pathname, CALLBACK);
    assert.equal(result.location!.searchParams.get('error'), error);
    assert.ok(result.location!.searchParams.get('error_description'));
    assert.equal(result.location!.searchParams.get('iss'), 'https://api.domdimabot.com');
    assert.equal(result.location!.searchParams.get('state'), state);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
}

test('a valid request still goes to the Dima consent page, with or without state', async () => {
    for (const state of [STATE, 'twenty-char-state-01', undefined]) {
        const result = await authorize({ state });
        assert.equal(result.status, 302);
        assert.equal(result.location!.origin + result.location!.pathname, 'https://domdimabot.com/oauth/authorize');
        assert.match(result.location!.searchParams.get('request')!, /^[A-Za-z0-9_-]{43}$/);
    }
    assert.equal(store.size, 3);
});

test('errors after client and redirect_uri checks redirect to the callback', async () => {
    callbackError(await authorize({ code_challenge_method: 'plain' }), 'invalid_request', STATE);
    callbackError(await authorize({ response_type: 'token', state: 'a b+c&d' }), 'unsupported_response_type', 'a b+c&d');
    callbackError(await authorize({ scope: 'usage:read', state: undefined }), 'invalid_scope', null);
    callbackError(await authorize({ state: '' }), 'invalid_request', null);
    callbackError(await authorize({}, '&state=second'), 'invalid_request', null);
    assert.equal(store.size, 0);
});

test('an unknown client or bad redirect_uri answers JSON 400 and never redirects', async () => {
    for (const [result, error] of [
        [await authorize({ client_id: 'unknown', code_challenge_method: 'plain' }), 'invalid_client'],
        [await authorize({ redirect_uri: 'https://evil.invalid/oauth/callback', scope: '*' }), 'invalid_request'],
        [await authorize({}, '&client_id=other'), 'invalid_client'],
        [await authorize({}, `&redirect_uri=${encodeURIComponent('http://127.0.0.1:42782/oauth/callback')}`), 'invalid_request']
    ] as const) {
        assert.equal(result.status, 400);
        assert.equal(result.location, null);
        assert.deepEqual(result.body, { error });
    }
});

test('rate limits and server errors stay JSON', async () => {
    limited = true;
    let result = await authorize({ code_challenge_method: 'plain' });
    assert.equal(result.status, 429);
    assert.equal(result.location, null);
    assert.deepEqual(result.body, { error: 'slow_down' });
    limited = false;
    const logged = mock.method(console, 'error', () => {});
    try {
        mongoFailure = new Error('mongo down');
        result = await authorize({ code_challenge_method: 'plain' });
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { error: 'temporarily_unavailable' });
        mongoFailure = null; redisFailure = new Error('redis down');
        result = await authorize();
        assert.equal(result.status, 503);
        assert.equal(result.location, null);
    } finally { logged.mock.restore(); }
});
