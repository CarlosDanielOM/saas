import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { PetPeer } from './peers.js';

const scopes = ['desktop:connect', 'pet:read', 'pet:receive'];
const identity = { session_id: 'session-a', user_id: 'owner-a', channel_id: '123', client_id: 'desktop', scopes };
const tokens = new Map<string, typeof identity>();
const authenticated: unknown[] = [], diagnostics: any[] = [];
const peers = new Map<string, PetPeer>();
let gate: Promise<void> | undefined;
class PetError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
class OAuthError extends PetError {}
class PetSettingsError extends PetError {}
const query = (value: unknown) => ({ select: () => query(value), lean: async () => value });
const runtime = { generation: 7, lease: { leaseId: 'lease-a', holderPeerId: '' }, activeRequestId: 'request-a' };
mock.module('./diagnostics.js', { namedExports: { petDiagnostic: (...args: any[]) => diagnostics.push(args) } });
mock.module('./tts_bridge.js', { namedExports: { scheduleReadTtsResume: () => {} } });
mock.module('../server/oauth/service.js', { namedExports: {
    hash: (token: string) => token,
    authenticateAccess: async (token: unknown) => {
        authenticated.push(token);
        if (token === 'new' && gate) await gate;
        const found = tokens.get(String(token));
        if (!found) throw new OAuthError('invalid_token', 401);
        return found;
    }
} });
mock.module('../server/oauth/catalog.js', { namedExports: { OAuthError } });
mock.module('../server/services/pet_settings.service.js', { namedExports: {
    PetSettingsError, requirePetPlan: async () => {}, getPetConfiguration: async () => ({})
} });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => ({ pTTL: async (key: string) => key.endsWith(':new') ? 600_000 : 1000 })
} });
mock.module('./readiness.js', { namedExports: { refreshPetReadiness: async () => {} } });
mock.module('../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {
    findById: () => query({ device_name: 'Fixture', expires_at: new Date(Date.now() + 900_000), idle_expires_at: new Date(Date.now() + 900_000) })
} } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PetRuntime: { findById: () => query(runtime) }, PetRequest: {}
} });
mock.module('./tokens.js', { namedExports: { authenticatePetCapability: async () => ({ runtime: { _id: identity.user_id, channelId: '123', tokenHash: 'cap' } }) } });
mock.module('./peers.js', { namedExports: { petPeers: peers, selectedVtsController: async () => null } });
mock.module('./state.js', { namedExports: {
    PetError, LEASE_TTL_MS: 15000, finishRequest: async () => {}, notifyPet: async () => {}, runtimeFor: async () => runtime,
    invalidatePet: async () => { assert.fail('reauth must never invalidate playback'); }
} });
mock.module('./runtime.js', { namedExports: {
    startPetRuntime: async () => async () => {}, isSelectedPlayer: async () => true, sendPetSnapshot: async () => {}
} });
mock.module('../desktop_ai/activity.js', { namedExports: {
    confirmRetiredSpeechActivity: async () => false, hasSafeDesktopPetStop: async () => false
} });
const { registerPetSockets } = await import('./socket.js');

async function fixture(context: { after: (fn: () => unknown) => void }, kind = '/desktop') {
    peers.clear(); tokens.clear(); diagnostics.length = 0; authenticated.length = 0; gate = undefined;
    tokens.set('old', { ...identity }); tokens.set('new', { ...identity, scopes: [...scopes, 'pet:control'] });
    const namespaces = new Map<string, any>();
    const io = { of: (name: string) => {
        const ns = { use(fn: unknown) { this.middleware = fn; }, on(_event: string, fn: unknown) { this.connection = fn; }, middleware: undefined as any, connection: undefined as any };
        namespaces.set(name, ns); return ns;
    } };
    const close = await registerPetSockets(io as any); context.after(close);
    const handlers = new Map<string, Function>(), emitted: any[] = [];
    const socket = { handshake: { auth: kind === '/desktop' ? { v: 1, accessToken: 'old' } : { v: 1, capability: 'cap' }, query: {} },
        recovered: false, data: {} as any, connected: true,
        emit: (...args: any[]) => emitted.push(args), on: (name: string, fn: Function) => handlers.set(name, fn), once: () => {},
        disconnect: () => { socket.connected = false; }
    };
    const ns = namespaces.get(kind);
    await new Promise<void>((resolve, reject) => ns.middleware(socket, (error: unknown) => error ? reject(error) : resolve()));
    ns.connection(socket);
    const peer = socket.data.petPeer as PetPeer;
    peer.audioReady = peer.renderReady = peer.vtsReady = true;
    runtime.lease.holderPeerId = peer.id;
    const send = (event: string, data: unknown) => new Promise<any>(resolve => handlers.get(event)!(data, resolve));
    return { socket, peer, send, handlers, emitted };
}

test('reauth advertises support and preserves peer, lease, active request, readiness and generation after old-token expiry', async t => {
    const c = await fixture(t), before = structuredClone(runtime), peerId = c.peer.id;
    assert.deepEqual(c.emitted[0], ['desktop:hello', { v: 1, sessionId: identity.session_id, channelId: '123', scopes, features: ['reauth'] }]);
    await c.peer.revalidate(); const oldExpiry = c.peer.authorizationExpiresAt;
    tokens.delete('old'); authenticated.length = 0;
    assert.deepEqual(await c.send('desktop:reauth', { v: 1, accessToken: 'new' }), { ok: true, data: {} });
    assert.deepEqual(authenticated, ['new', 'new'], 'reauth never prechecks the expired handshake token');
    assert.equal(peers.get(peerId), c.peer); assert.deepEqual(runtime, before);
    assert.ok(c.peer.audioReady && c.peer.renderReady && c.peer.vtsReady && c.socket.connected);
    assert.ok(c.peer.validatedAt > 0 && c.peer.authorizationExpiresAt > oldExpiry);
    assert.deepEqual(c.peer.scopes, [...scopes, 'pet:control']);
    await c.peer.revalidate();
    assert.equal(authenticated.at(-1), 'new');
    assert.deepEqual(await c.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: true }), { ok: true, data: {} });
    assert.equal(c.socket.connected, true);
    assert.equal(diagnostics.at(-1)[1], 'reauth'); assert.equal(diagnostics.at(-1)[2].reason, 'ok');
});
for (const field of ['session_id', 'user_id'] as const) test(`reauth rejects mismatched ${field} and disconnects`, async t => {
    const c = await fixture(t); tokens.set('new', { ...identity, [field]: 'different' });
    assert.deepEqual(await c.send('desktop:reauth', { v: 1, accessToken: 'new' }), { ok: false, error: { code: 'invalid_token' } });
    assert.equal(c.socket.connected, false); assert.equal(diagnostics.at(-1)[2].reason, 'invalid_token');
});
for (const scope of scopes) test(`reauth requires ${scope}`, async t => {
    const c = await fixture(t); tokens.set('new', { ...identity, scopes: scopes.filter(s => s !== scope) });
    assert.deepEqual(await c.send('desktop:reauth', { v: 1, accessToken: 'new' }), { ok: false, error: { code: 'insufficient_scope' } });
    assert.equal(c.socket.connected, false);
});
test('invalid replacement token returns invalid_token', async t => {
    const c = await fixture(t);
    assert.equal((await c.send('desktop:reauth', { v: 1, accessToken: 'unknown' })).error.code, 'invalid_token');
    assert.equal(c.socket.connected, false);
});
test('idle timer revalidates the new token after the old token expires following a swap', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const c = await fixture(t);
    assert.equal((await c.send('desktop:reauth', { v: 1, accessToken: 'new' })).ok, true);
    tokens.delete('old'); authenticated.length = 0;
    t.mock.timers.tick(15_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(authenticated, ['new']); assert.equal(c.socket.connected, true);
});
test('reauth validates the exact input schema without exposing tokens', async t => {
    const c = await fixture(t);
    for (const value of [null, [], {}, { v: 2, accessToken: 'new' }, { v: 1 }, { v: 1, accessToken: 4 }, { v: 1, accessToken: 'new', extra: true }]) {
        assert.deepEqual(await c.send('desktop:reauth', value), { ok: false, error: { code: 'invalid_message' } });
    }
    assert.equal(c.socket.connected, true);
    assert.ok(diagnostics.length > 0);
    assert.doesNotMatch(JSON.stringify(diagnostics), /accessToken|unknown/);
});
test('only reauth skips the precheck; unchanged legacy clients still fail when their old token expires', async t => {
    const c = await fixture(t); tokens.delete('old');
    assert.equal((await c.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: true })).error.code, 'invalid_token');
    assert.equal(c.socket.connected, false);
});
test('reauth shares the ordered control queue and rate limit', async t => {
    const c = await fixture(t), blocked = Promise.withResolvers<void>(); gate = blocked.promise;
    const first = c.send('desktop:reauth', { v: 1, accessToken: 'new' });
    const next = c.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: true });
    assert.deepEqual(authenticated, ['old', 'new'], 'next message waits for reauth');
    tokens.delete('old'); blocked.resolve();
    assert.equal((await first).ok, true); assert.equal((await next).ok, true);
    gate = undefined;
    let limited = 0;
    for (let i = 0; i < 35; i++) if ((await c.send('desktop:reauth', { v: 1, accessToken: 'new' })).error?.code === 'rate_limited') limited++;
    assert.ok(limited > 0);
});
test('reauth is never registered on the browser namespace', async t => {
    const c = await fixture(t, '/pet'); assert.equal(c.handlers.has('desktop:reauth'), false);
});
