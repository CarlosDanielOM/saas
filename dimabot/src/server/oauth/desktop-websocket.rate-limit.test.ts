import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, mock, test } from 'node:test';
import { WebSocket } from 'ws';
import { OAuthError, OAUTH_RESOURCES } from './catalog.js';

const buckets: string[] = [];
const limits = new Map<string, number>();
let authenticated = 0;
mock.module('./service.js', { namedExports: {
    hash: (value: string) => `h(${value})`,
    oauthWebsite: () => 'https://domdimabot.com',
    rateLimit: async (bucket: string, limit: number) => {
        buckets.push(bucket);
        if (buckets.filter(item => item === bucket).length > (limits.get(bucket) ?? limit)) throw new OAuthError('slow_down', 429);
    },
    authenticateAccess: async (_token: unknown, options?: { resource?: string }) => {
        if (options?.resource !== OAUTH_RESOURCES.desktop) throw new OAuthError('invalid_token', 401);
        authenticated++;
        return { session_id: `s${authenticated}`, user_id: 'u', client_id: 'dima-desktop', channel_id: '1', scopes: ['desktop:connect'] };
    }
} });
const { attachDesktopWebsocket } = await import('./desktop-websocket.js');

const server = createServer();
attachDesktopWebsocket(server);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => { server.close(); });
const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/desktop/ws`;
beforeEach(() => { buckets.length = 0; limits.clear(); authenticated = 0; });
const connect = (headers: Record<string, string> = {}) => new Promise<number>(resolve => {
    const socket = new WebSocket(url, 'dima.desktop.v1', { headers: { Authorization: `Bearer dima_at_${'a'.repeat(43)}`, ...headers } });
    socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.on('error', () => {});
    socket.on('open', () => { socket.terminate(); resolve(101); });
});

test('handshakes are limited per real client, not per proxy', async () => {
    assert.equal(await connect({ 'X-Real-IP': '162.158.10.1', 'CF-Connecting-IP': '203.0.113.7' }), 101);
    assert.equal(await connect({ 'X-Real-IP': '2606:4700::1', 'CF-Connecting-IP': '2001:db8::7' }), 101);
    assert.equal(await connect(), 101);
    assert.deepEqual(buckets, ['ws:203.0.113.7', 'ws:2001:db8:0:0::/64', 'ws:127.0.0.1']);
});

test('a limited client is refused before token lookup; its neighbours are not', async () => {
    limits.set('ws:203.0.113.7', 0);
    assert.notEqual(await connect({ 'X-Real-IP': '162.158.10.1', 'CF-Connecting-IP': '203.0.113.7' }), 101);
    assert.equal(authenticated, 0);
    assert.equal(await connect({ 'X-Real-IP': '162.158.10.1', 'CF-Connecting-IP': '203.0.113.8' }), 101);
});

test('rotating a spoofed header keeps counting the true address', async () => {
    for (const forged of ['192.0.2.1', '192.0.2.2']) await connect({ 'X-Real-IP': forged, 'CF-Connecting-IP': '203.0.113.7' });
    assert.deepEqual(buckets, ['ws:conflict:real:192.0.2.1', 'ws:conflict:cf:203.0.113.7', 'ws:conflict:real:192.0.2.2', 'ws:conflict:cf:203.0.113.7']);
});
