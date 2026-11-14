import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';
import { OAuthError } from './catalog.js';

const buckets: string[] = [];
const limits = new Map<string, number>();
const counts = new Map<string, number>();
let authenticated = 0;
const unused = async () => assert.fail('not used by these routes');
class PetError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
mock.module('./service.js', { namedExports: {
    hash: (value: string) => `h(${value})`,
    rateLimit: async (bucket: string, limit: number) => {
        buckets.push(bucket);
        const count = (counts.get(bucket) ?? 0) + 1;
        counts.set(bucket, count);
        if (count > (limits.get(bucket) ?? limit)) throw new OAuthError('slow_down', 429);
    },
    authenticateAccess: async (token: unknown) => {
        authenticated++;
        if (typeof token !== 'string' || !token.startsWith('dima_at_')) throw new OAuthError('invalid_token', 401);
        return { session_id: 's', user_id: 'u', client_id: 'dima-desktop', channel_id: '1', scopes: ['profile:read'] };
    },
    oauthIssuer: () => 'https://api.domdimabot.com', oauthWebsite: () => 'https://domdimabot.com',
    approveAuthorization: unused, exchangeCode: unused, getAuthorization: unused, getClient: unused,
    refreshAccess: unused, revokeSession: unused, revokeToken: unused, startAuthorization: unused,
    OAuthRedirectError: class extends OAuthError {}
} });
mock.module('../../schemas/users.schema.js', { defaultExport: {} });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: {} } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {} } });
mock.module('../../utils/billing.js', { namedExports: { getAiCredits: unused } });
mock.module('../../utils/ai_credit_display.js', { namedExports: { getFreeAiCreditDisplay: unused } });
mock.module('../services/pet_settings.service.js', { namedExports: { getPetConfiguration: unused, PetSettingsError: PetError } });
mock.module('../../pets/state.js', { namedExports: { PetError, cancelPetRequest: unused } });
mock.module('../../pets/runtime.js', { namedExports: { getPetRuntime: unused } });
mock.module('../../pets/selection.js', { namedExports: { selectOwnPetPlayback: unused } });
mock.module('../../desktop_ai/service.js', { namedExports: { submitTurn: unused, getTurn: unused, cancelTurn: unused,
    cancelSpeech: unused, claimAudio: unused, speechEvent: unused } });
mock.module('../../desktop_ai/updates.js', { namedExports: { TURN_STATUS_FEATURE: 'turn-status' } });
const { oauthRoute, oauthApiRoute } = await import('./routes.js');

const app = express();
app.use('/oauth', oauthRoute);
app.use('/v1', oauthApiRoute);
const server = createServer(app).listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => { server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const viaCloudflare = (client: string) => ({ 'X-Real-IP': '162.158.10.1', 'CF-Connecting-IP': client });
const token = `dima_at_${'a'.repeat(43)}`;
beforeEach(() => { buckets.length = 0; limits.clear(); counts.clear(); authenticated = 0; });

test('OAuth routes are limited per real client, not per proxy', async () => {
    assert.equal((await fetch(`${base}/oauth/metadata`, { headers: viaCloudflare('203.0.113.7') })).status, 200);
    assert.equal((await fetch(`${base}/oauth/metadata`, { headers: viaCloudflare('203.0.113.8') })).status, 200);
    assert.equal((await fetch(`${base}/oauth/metadata`)).status, 200);
    assert.deepEqual(buckets, ['oauth:203.0.113.7', 'oauth:203.0.113.8', 'oauth:127.0.0.1']);
    limits.set('oauth:203.0.113.7', 0);
    const limited = await fetch(`${base}/oauth/metadata`, { headers: viaCloudflare('203.0.113.7') });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual(await limited.json(), { error: 'slow_down' });
    assert.equal((await fetch(`${base}/oauth/metadata`, { headers: viaCloudflare('203.0.113.8') })).status, 200, 'neighbour unaffected');
});

test('desktop API is limited per client IP and, with a bearer token, per installation', async () => {
    const headers = { ...viaCloudflare('203.0.113.7'), Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/v1/me/ai/capabilities`, { headers })).status, 200);
    assert.deepEqual(buckets.sort(), ['desktop-token:h(' + token + ')', 'desktop:203.0.113.7']);
    buckets.length = 0;
    for (const authorization of ['', 'Basic abc', 'Bearer ', 'Bearer a b']) {
        const other: Record<string, string> = viaCloudflare('203.0.113.7');
        if (authorization) other.Authorization = authorization;
        await fetch(`${base}/v1/me/ai/capabilities`, { headers: other });
    }
    assert.deepEqual(buckets, Array(4).fill('desktop:203.0.113.7'), 'no token bucket without one bearer token');
});

test('an exhausted installation is refused from any IP, and other installations behind its IP are not', async () => {
    limits.set(`desktop-token:h(${token})`, 0);
    authenticated = 0;
    for (const client of ['203.0.113.7', '198.51.100.9']) {
        const response = await fetch(`${base}/v1/me/ai/capabilities`, { headers: { ...viaCloudflare(client), Authorization: `Bearer ${token}` } });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '60');
    }
    assert.equal(authenticated, 0, 'limited requests never reach token lookup');
    const other = `dima_at_${'b'.repeat(43)}`;
    assert.equal((await fetch(`${base}/v1/me/ai/capabilities`, { headers: { ...viaCloudflare('203.0.113.7'), Authorization: `Bearer ${other}` } })).status, 200);
});

test('an exhausted IP is refused for every token', async () => {
    limits.set('desktop:203.0.113.7', 0);
    const response = await fetch(`${base}/v1/me/ai/capabilities`, { headers: { ...viaCloudflare('203.0.113.7'), Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 429);
    assert.equal(authenticated, 0);
    assert.deepEqual(buckets, ['desktop:203.0.113.7'], 'a request the IP limit refuses creates no per-token counter');
    assert.equal((await fetch(`${base}/v1/me/ai/capabilities`, { headers: { ...viaCloudflare('203.0.113.8'), Authorization: `Bearer ${token}` } })).status, 200);
});

test('rotating a spoofed header keeps counting the true address', async () => {
    for (const forged of ['192.0.2.1', '192.0.2.2']) {
        await fetch(`${base}/oauth/metadata`, { headers: { 'X-Real-IP': forged, 'CF-Connecting-IP': '203.0.113.7' } });
    }
    assert.deepEqual(buckets, ['oauth:conflict:real:192.0.2.1', 'oauth:conflict:cf:203.0.113.7',
        'oauth:conflict:real:192.0.2.2', 'oauth:conflict:cf:203.0.113.7']);
});
