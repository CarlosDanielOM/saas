import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, mock, test } from 'node:test';
import express from 'express';
import { OAuthError } from './catalog.js';

class PetError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
class PetSettingsError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
const identity = { session_id: 'session-1', user_id: 'owner-1', client_id: 'dima-desktop', channel_id: '12345' };
const valid = `dima_at_${'a'.repeat(43)}`, limited = `dima_at_${'b'.repeat(43)}`;
let credits: () => Promise<unknown> = async () => ({ balance: 42 });
let turn: () => Promise<unknown> = async () => ({});
const idle = async () => ({});
mock.module('./service.js', { namedExports: {
    authenticateAccess: async (token: unknown) => {
        if (token === valid) return { ...identity, scopes: ['profile:read', 'credits:read', 'pet:read'] };
        if (token === limited) return { ...identity, scopes: ['profile:read'] };
        throw new OAuthError('invalid_token', 401);
    },
    rateLimit: async () => {}, hash: (value: string) => value, oauthWebsite: () => 'https://domdimabot.com', oauthIssuer: () => 'https://api.domdimabot.com',
    approveAuthorization: idle, exchangeCode: idle, getAuthorization: idle, getClient: idle, refreshAccess: idle,
    revokeSession: idle, revokeToken: idle, startAuthorization: idle, OAuthRedirectError: class extends OAuthError {}
} });
mock.module('../../schemas/users.schema.js', { defaultExport: { findById: async () => ({ _id: identity.user_id }) } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {} } });
mock.module('../../utils/billing.js', { namedExports: { getAiCredits: () => credits() } });
mock.module('../../utils/ai_credit_display.js', { namedExports: { getFreeAiCreditDisplay: async () => null } });
mock.module('../services/pet_settings.service.js', { namedExports: { PetSettingsError,
    getPetConfiguration: async () => { throw new PetSettingsError('plan_required', 403); } } });
mock.module('../../pets/state.js', { namedExports: { PetError, cancelPetRequest: idle } });
mock.module('../../pets/runtime.js', { namedExports: { getPetRuntime: idle } });
mock.module('../../pets/selection.js', { namedExports: { selectOwnPetPlayback: idle } });
mock.module('../../desktop_ai/service.js', { namedExports: { submitTurn: () => turn(), getTurn: idle, cancelTurn: idle,
    cancelSpeech: idle, claimAudio: idle, speechEvent: idle } });
mock.module('../../desktop_ai/updates.js', { namedExports: { TURN_STATUS_FEATURE: 'turn_status' } });
const { bearerChallenge, oauthApiRoute, oauthRoute } = await import('./routes.js');

let server: Server, base = '';
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/oauth', oauthRoute);
    app.use('/v1', oauthApiRoute);
    server = createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
async function call(path: string, authorization?: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {};
    if (authorization) headers.Authorization = authorization;
    if (init.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { ...init, headers });
    return { status: response.status, challenge: response.headers.get('www-authenticate'), body: await response.json() };
}

test('no credentials: realm only, body still invalid_token for the desktop app', async () => {
    for (const authorization of [undefined, 'Basic dXNlcjpwYXNz', 'Bearerish token']) {
        assert.deepEqual(await call('/v1/me/credits', authorization),
            { status: 401, challenge: 'Bearer realm="dima"', body: { error: 'invalid_token' } }, String(authorization));
    }
});

test('invalid, malformed or expired tokens: error="invalid_token"', async () => {
    for (const authorization of [`Bearer dima_at_${'z'.repeat(43)}`, 'Bearer not-a-dima-token', 'Bearer', 'bearer  spaced', `Bearer ${valid} extra`]) {
        assert.deepEqual(await call('/v1/me/credits', authorization),
            { status: 401, challenge: 'Bearer realm="dima", error="invalid_token"', body: { error: 'invalid_token' } }, authorization);
    }
});

test('missing route scope: 403 names the required scope', async () => {
    assert.deepEqual(await call('/v1/me/credits', `Bearer ${limited}`), { status: 403,
        challenge: 'Bearer realm="dima", error="insufficient_scope", scope="credits:read"', body: { error: 'insufficient_scope' } });
    assert.equal((await call('/v1/me/pet', `Bearer ${limited}`)).challenge, 'Bearer realm="dima", error="insufficient_scope", scope="pet:read"');
    const ok = await call('/v1/me/credits', `Bearer ${valid}`);
    assert.equal(ok.status, 200); assert.equal(ok.challenge, null);
});

test('scope missing deeper in a service: the error carries it into the challenge', async t => {
    turn = async () => { throw new OAuthError('insufficient_scope', 403, ['ai:interact']); };
    t.after(() => { turn = async () => ({}); });
    assert.deepEqual(await call('/v1/me/ai/turns', `Bearer ${valid}`, { method: 'POST', body: '{}' }), { status: 403,
        challenge: 'Bearer realm="dima", error="insufficient_scope", scope="ai:interact"', body: { error: 'insufficient_scope' } });
});

test('other failures carry no Bearer challenge', async t => {
    assert.deepEqual(await call('/v1/me/pet', `Bearer ${valid}`), { status: 403, challenge: null, body: { error: 'plan_required' } });
    assert.deepEqual(await call(`/v1/me/credits?channelID=1`, `Bearer ${valid}`), { status: 400, challenge: null, body: { error: 'invalid_request' } });
    const logged = t.mock.method(console, 'error', () => {});
    credits = async () => { throw new Error('database down'); };
    t.after(() => { credits = async () => ({ balance: 42 }); });
    assert.deepEqual(await call('/v1/me/credits', `Bearer ${valid}`), { status: 503, challenge: null, body: { error: 'temporarily_unavailable' } });
    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(await call('/v1/missing', `Bearer ${valid}`), { status: 404, challenge: null, body: { error: 'not_found' } });
    assert.deepEqual(await call('/oauth/token', undefined, { method: 'POST', body: JSON.stringify({ grant_type: 'password' }) }),
        { status: 400, challenge: null, body: { error: 'unsupported_grant_type' } });
});

test('browser routes are their own realm and never advertise Dima scopes', async () => {
    assert.deepEqual(await call('/oauth/browser-session'), { status: 401, challenge: 'Bearer realm="dima-browser"', body: { error: 'login_required' } });
    assert.deepEqual(await call('/oauth/browser-session', `Bearer ${valid}`),
        { status: 401, challenge: 'Bearer realm="dima-browser", error="invalid_token"', body: { error: 'login_required' } });
});

test('challenge values cannot break out of their quoted strings', () => {
    assert.equal(bearerChallenge('dima'), 'Bearer realm="dima"');
    assert.equal(bearerChallenge('di"ma\\', 'invalid_token"\r\nX-Injected: 1'), 'Bearer realm="dima", error="invalid_tokenX-Injected: 1"');
    assert.equal(bearerChallenge('dima', 'insufficient_scope', ['pet:read', 'a"b', 'two words', '', 'x\ny', 'ai:interact']),
        'Bearer realm="dima", error="insufficient_scope", scope="pet:read ai:interact"');
    assert.equal(bearerChallenge('dima', 'insufficient_scope', ['bad"']), 'Bearer realm="dima", error="insufficient_scope"');
});
