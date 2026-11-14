import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, mock, test } from 'node:test';
import express from 'express';
import { bearerChallenge, OAuthError, OAUTH_RESOURCES } from './catalog.js';

class PetError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
class PetSettingsError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
const identity = { session_id: 'session-1', user_id: 'owner-1', client_id: 'dima-desktop', requester_id: '12345', channel_id: '12345',
    resource: OAUTH_RESOURCES.desktop };
const valid = `dima_at_${'a'.repeat(43)}`, limited = `dima_at_${'b'.repeat(43)}`, mcp = `dima_at_${'c'.repeat(43)}`;
let credits: () => Promise<unknown> = async () => ({ balance: 42 });
let turn: () => Promise<unknown> = async () => ({});
const idle = async () => ({});
mock.module('./service.js', { namedExports: {
    authenticateAccess: async (token: unknown, options?: { resource?: string }) => {
        if (token === mcp && options?.resource !== OAUTH_RESOURCES.desktop) return { ...identity, resource: OAUTH_RESOURCES.mcp, scopes: ['channel:read'] };
        if (options?.resource !== OAUTH_RESOURCES.desktop) throw new OAuthError('invalid_token', 401);
        if (token === valid) return { ...identity, scopes: ['profile:read', 'credits:read', 'pet:read', 'desktop:connect'] };
        if (token === limited) return { ...identity, scopes: ['profile:read'] };
        throw new OAuthError('invalid_token', 401);
    },
    rateLimit: async () => {}, hash: (value: string) => value, oauthWebsite: () => 'https://domdimabot.com', oauthIssuer: () => 'https://api.domdimabot.com',
    approveAuthorization: idle, exchangeCode: idle, refreshAccess: idle, browserChannels: idle, listConnections: idle,
    getAuthorization: async () => ({ request: { device_name: 'Claude', scopes: ['channel:read'], redirect_uri: 'http://localhost:6274/cb',
        resource: OAUTH_RESOURCES.mcp }, client: { client_id: 'https://app.example/client.json', name: 'Example', kind: 'cimd',
        recognized: false, document_host: 'app.example', channel_selection: true } }),
    revokeSession: idle, revokeToken: idle, startAuthorization: idle, OAuthRedirectError: class extends OAuthError {}
} });
mock.module('../../schemas/users.schema.js', { defaultExport: { findById: async () => ({ _id: identity.user_id }) } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {
    findById: () => ({ select: () => ({ lean: async () => ({ device_name: 'Streaming PC', expires_at: '2030-01-01T00:00:00.000Z' }) }) })
} } });
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
const { oauthApiRoute, oauthMetadata, oauthRoute } = await import('./routes.js');

let server: Server, base = '';
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/oauth', oauthRoute);
    app.use('/v1', oauthApiRoute);
    app.all('/.well-known/oauth-authorization-server', oauthMetadata);
    server = createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
async function call(path: string, authorization?: string, init: RequestInit = {}, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra };
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
    assert.equal(bearerChallenge('mcp', 'invalid_token', [], 'https://mcp.example/.well-known/oauth-protected-resource/mcp"\r\nX: 1'),
        'Bearer realm="mcp", error="invalid_token", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcpX: 1"');
});

test('MCP-audience tokens never work on /v1', async () => {
    assert.deepEqual(await call('/v1/me/credits', `Bearer ${mcp}`),
        { status: 401, challenge: 'Bearer realm="dima", error="invalid_token"', body: { error: 'invalid_token' } });
});

test('desktop session response keeps its pre-MCP shape', async () => {
    const result = await call('/v1/desktop/session', `Bearer ${valid}`);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['channel_id', 'client_id', 'device_name', 'expires_at', 'pet_available',
        'protocol_version', 'scopes', 'session_id', 'socket_io', 'user_id']);
});

test('metadata, token and revocation answer any origin without credentials; the rest stays on the Dima website', async () => {
    const evil = { Origin: 'https://evil.example' };
    for (const path of ['/oauth/metadata', '/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/revoke']) {
        const preflight = await fetch(base + path, { method: 'OPTIONS', headers: { ...evil, 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type, mcp-protocol-version' } });
        assert.equal(preflight.status, 204, path);
        assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, MCP-Protocol-Version', path);
        assert.equal(preflight.headers.get('access-control-allow-origin'), '*', path);
        assert.equal(preflight.headers.get('access-control-allow-credentials'), null, path);
    }
    for (const path of ['/oauth/metadata', '/.well-known/oauth-authorization-server']) {
        const response = await fetch(base + path, { headers: evil });
        assert.equal(response.headers.get('access-control-allow-origin'), '*', path);
        assert.equal((await response.json()).client_id_metadata_document_supported, true, path);
    }
    const token = await call('/oauth/token', undefined, { method: 'POST', body: JSON.stringify({ grant_type: 'password' }) }, evil);
    assert.deepEqual(token.body, { error: 'unsupported_grant_type' }, 'errors are readable cross-origin');
    assert.equal((await call('/oauth/revoke', undefined, { method: 'POST', body: JSON.stringify({ token: 'x' }) }, evil)).status, 200);
    for (const path of ['/oauth/requests/abc', '/oauth/browser-session', '/oauth/connections', '/v1/me']) {
        const response = await fetch(base + path, { headers: evil });
        assert.equal(response.status, 403, path);
        assert.equal(response.headers.get('access-control-allow-origin'), null, path);
    }
    const site = await fetch(`${base}/oauth/requests/abc`, { headers: { Origin: 'https://domdimabot.com' } });
    assert.equal(site.headers.get('access-control-allow-origin'), 'https://domdimabot.com');
});

test('consent request shows the client kind, document and callback hosts, audience and channel choice', async () => {
    assert.deepEqual((await call('/oauth/requests/abc')).body, { client_id: 'https://app.example/client.json', client_name: 'Example',
        device_name: 'Claude', scopes: ['channel:read'], redirect_uri: 'http://localhost:6274/cb', client_kind: 'cimd', recognized: false,
        document_host: 'app.example', callback_host: 'localhost:6274', resource: OAUTH_RESOURCES.mcp, channel_selection: true });
    for (const channel_id of [true, ['1', '2']]) {
        assert.deepEqual(await call('/oauth/requests/abc/decision', undefined, { method: 'POST', body: JSON.stringify({ approve: true, channel_id }) }),
            { status: 400, challenge: null, body: { error: 'invalid_request' } }, 'channel_id must be one string');
    }
});
