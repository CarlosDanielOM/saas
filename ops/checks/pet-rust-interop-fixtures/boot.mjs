/** Disposable API-only test control. Never include this import in a production environment. */
import './providers.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';

// NODE_OPTIONS also reaches the check process. Only the real API owns this listener.
if (process.argv[1]?.endsWith('/dist/server/index.js')) {
  assert.equal(process.env.PET_RUST_INTEROP_FIXTURE, 'disposable-v1');
  assert.equal(process.env.MONGO_URI, 'mongodb://mongo:27017/saas_ops_oauth_beta_test');
  assert.equal(process.env.DRAGONFLY_HOST, 'redis');
  assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
  const addresses = Object.values(networkInterfaces()).flat().filter(value => value.family === 'IPv4' && !value.internal);
  assert.equal(addresses.length, 1, 'one isolated bridge interface required');
  const address = addresses[0].address;
  assert.match(address, /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/);
  // Media must advertise this disposable API's real origin, so the production
  // Rust same-origin guard and ticket authorization run unchanged.
  process.env.PUBLIC_API_URL = `http://${address}:3000`;
  const secret = randomBytes(32).toString('hex');
  const manifest = '/tmp/pet-rust-interop.json';
  const base = 'http://127.0.0.1:3000', owner = '99003101';
  const state = { initialized: false, probeFinished: false, finished: false, failure: null, token: null, ownerId: null,
    sessionId: null, peer: null, wire: [], snapshot: null, injected: false, admissions: [], plays: [] };
  let busy = false;
  const clone = value => structuredClone(value);
  async function call(path, { token, method = 'GET', body } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers,
      body: response.status === 302 ? null : await response.json() };
  }
  async function setup() {
    assert.equal(state.initialized, false);
    const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
    const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
    const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
    const { getIO } = await import('/app/dist/server/websocket.js');
    const { GridFSBucket, ObjectId } = createRequire('/app/package.json')('mongodb');
    const mongo = await getMongoDBConnection('pet-rust-interop');
    const redis = await getDragonflyClient('pet-rust-interop');
    assert.equal(await mongo.connection.db.collection('users').countDocuments(), 0, 'fresh disposable database required');
    const inserted = await mongo.connection.db.collection('users').insertOne({ name: 'Rust fixture', plan_tier: 'premium',
      polar_sh_customer_id: 'pet-test-customer', accounts: [{ type: 'twitch', id: owner, name: 'pet_owner' }] });
    state.ownerId = String(inserted.insertedId);
    await redis.hSet('token:pet-owner-token', { id: owner, login: owner, display_name: 'Pet fixture' });
    await redis.set(`twitch:${owner}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
      used: 0, limit: 100, balance: 100, available: true, status: 'available', updatedAt: new Date().toISOString() }));
    const assetId = new ObjectId(), gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const upload = new GridFSBucket(mongo.connection.db, { bucketName: 'private_assets' })
      .openUploadStreamWithId(assetId, 'pet.gif', { metadata: { owner, mime: 'image/gif' } });
    const stored = once(upload, 'finish'); upload.end(gif); await stored;
    await mongo.connection.db.collection('asset_libraries').insertOne({ _id: owner, usedBytes: gif.length,
      assets: [{ id: String(assetId), name: 'pet.gif', kind: 'image', mime: 'image/gif', bytes: gif.length,
        width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }] });
    const current = await call(`/pets/${owner}/settings`, { token: 'pet-owner-token' });
    assert.equal(current.status, 200);
    const configuration = current.body.data;
    const saved = await call(`/pets/${owner}/settings`, { token: 'pet-owner-token', method: 'PUT', body: {
      revision: configuration.revision, settings: { ...configuration.settings, enabled: true,
        appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) },
        behavior: { ...configuration.settings.behavior, cooldownSeconds: 0 } } } });
    assert.equal(saved.status, 200);
    const verifier = randomBytes(32).toString('base64url');
    const redirect = 'http://127.0.0.1:42781/oauth/callback';
    const start = await call('/oauth/authorize?' + new URLSearchParams({ client_id: 'dima-desktop', response_type: 'code',
      scope: 'profile:read credits:read desktop:connect pet:read pet:receive pet:control pet:playback:select',
      redirect_uri: redirect, state: verifier, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', device_name: 'Rust interop fixture' }));
    assert.equal(start.status, 302);
    const id = new URL(start.headers.get('location')).searchParams.get('request');
    const decision = await call(`/oauth/requests/${id}/decision`, { method: 'POST', token: 'oauth-beta-browser-owner', body: { approve: true } });
    assert.equal(decision.status, 200);
    const exchanged = await call('/oauth/token', { method: 'POST', body: { client_id: 'dima-desktop', grant_type: 'authorization_code',
      code: new URL(decision.body.redirect_uri).searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect } });
    assert.equal(exchanged.status, 200);
    state.token = exchanged.body.access_token; state.sessionId = exchanged.body.session_id;
    assert.ok(getIO(), 'actual API Socket.IO server required');
    getIO().of('/desktop').on('connection', socket => {
      socket.onAnyOutgoing((name, value) => {
        if (state.injected || !name.startsWith('pet:')) return;
        state.wire.push({ name, value: clone(value) });
        if (state.wire.length > 128) state.wire.shift();
        if (name === 'pet:snapshot') state.snapshot = clone(value);
        if (name === 'pet:play') {
          const previous = state.wire.at(-2);
          if (previous?.name !== 'pet:request' || previous.value.request.status !== 'ready' ||
              previous.value.request.requestId !== value.requestId || previous.value.generation !== value.generation)
            state.failure = 'actual API ready/play wire adjacency failed';
          state.plays.push(clone(value));
        }
      });
    });
    state.initialized = true;
    await writeFile(manifest, JSON.stringify({ fixture: 'disposable-v1', secret, accessToken: state.token,
      sessionId: state.sessionId, channelId: owner, address }), { mode: 0o600, flag: 'wx' });
    return { ok: true };
  }
  async function control(action) {
    if (action === 'setup') return setup();
    assert.ok(state.initialized); assert.equal(state.failure, null);
    const { petPeers } = await import('/app/dist/pets/peers.js');
    const peers = [...petPeers.values()].filter(peer => peer.sessionId === state.sessionId && peer.socket.connected);
    if (action === 'admit') {
      assert.equal(peers.length, 1, 'one actual Rust peer required');
      assert.ok(state.admissions.length < 2);
      const { admitPetAction } = await import('/app/dist/pets/admission.js');
      const input = { channelId: owner, operation: 'talk', text: `Rust actual API request ${state.admissions.length + 1}`,
        origin: { kind: 'chat-command', id: randomUUID(), occurredAt: new Date().toISOString() },
        actionKey: 'command:pet:0', actor: { userId: owner, displayName: 'Rust fixture' } };
      const result = await admitPetAction(input);
      state.admissions.push(result.requestId);
      assert.equal(new Set(state.admissions).size, state.admissions.length);
      return { requestId: result.requestId };
    }
    if (action === 'stale') {
      assert.equal(peers.length, 1); assert.equal(state.plays.length, 2); assert.ok(state.snapshot);
      const ready = state.wire.findLast(item => item.name === 'pet:request' &&
        item.value.request.requestId === state.admissions[1] && item.value.request.status === 'ready').value;
      const terminal = state.wire.findLast(item => item.name === 'pet:request' &&
        item.value.request.requestId === state.admissions[0] && item.value.request.status === 'completed').value;
      assert.equal(ready.generation, terminal.generation);
      const olderB = { ...clone(ready.request), status: 'synthesizing', version: ready.request.version - 1 };
      // Deliberate obsolete traffic, after the genuine adjacent pair. Rust holds B's
      // sole play while these real wire events exercise its production merge guards.
      const packets = [
        ['pet:snapshot', { ...clone(state.snapshot), generation: ready.generation, active: olderB }],
        ['pet:snapshot', { ...clone(state.snapshot), generation: ready.generation, active: clone(terminal.request) }],
        ['pet:request', clone(terminal)],
        ['pet:request', { ...clone(terminal), request: { ...clone(terminal.request), status: 'ready', version: terminal.request.version + 1 } }],
      ];
      state.injected = true;
      for (const [name, value] of packets) peers[0].socket.emit(name, value);
      peers[0].socket.emit('fixture:barrier', { v: 1, kind: 'stale' });
      state.injected = false;
      return { packets: packets.length, readyVersion: ready.request.version };
    }
    if (action === 'replay') {
      assert.equal(peers.length, 1); state.injected = true;
      for (const value of state.plays) peers[0].socket.emit('pet:play', value);
      peers[0].socket.emit('fixture:barrier', { v: 1, kind: 'replay' }); state.injected = false;
      return { ok: true };
    }
    if (action === 'finish') {
      const { PetRequest } = await import('/app/dist/schemas/pet_runtime.schema.js');
      const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
      const rows = await PetRequest.find({ ownerId: state.ownerId }).lean();
      assert.equal(rows.length, 2); assert.ok(rows.every(row => row.admitted && row.status === 'completed'));
      assert.equal(new Set(rows.map(row => row.generation)).size, 1);
      assert.equal(state.plays.length, 2); assert.deepEqual(state.plays.map(play => play.requestId), state.admissions);
      const calls = await (await getDragonflyClient('pet-rust-interop')).lRange('pet:test:provider-calls', 0, -1);
      assert.equal(calls.length, 2); assert.ok(calls.every(call => JSON.parse(call).kind === 'tts'));
      const billing = (await (await getDragonflyClient('pet-rust-interop')).lRange('pet:test:billing-events', 0, -1)).map(JSON.parse);
      assert.equal(billing.length, 2, 'two accepted mocked billing ingests, no replay');
      assert.deepEqual(billing.map(event => event.external_id).sort(), state.admissions.map(id => `${id}:tts`).sort());
      assert.ok(billing.every(event => event.metadata.usage_source === 'pet' && event.metadata.request_id === event.external_id));
      state.probeFinished = true;
      return { ok: true, admissions: 2, naturalPlays: 2, mockProviderCalls: 2 };
    }
    if (action === 'accept') { assert.ok(state.probeFinished); state.finished = true; return { ok: true }; }
    if (action === 'abort') { state.failure = 'host probe aborted'; return { ok: true }; }
    throw new Error('unknown fixture action');
  }
  const server = createServer(async (request, response) => {
    // setup/status are loopback-only; all host controls require the random private secret.
    const local = request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::ffff:127.0.0.1';
    const action = request.url?.slice(1);
    if (request.method !== 'POST' || !(local && ['setup', 'status'].includes(action) || request.headers.authorization === `Bearer ${secret}`)) {
      response.writeHead(403).end(); return;
    }
    if (action === 'status') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ initialized: state.initialized, finished: state.finished, failure: state.failure })); return;
    }
    if (busy) { response.writeHead(409).end(); return; }
    busy = true;
    try { const value = await control(action); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); }
    catch { state.failure = `fixture ${action} failed`; response.writeHead(500).end(JSON.stringify({ error: state.failure })); }
    finally { busy = false; }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.maxConnections = 4;
  server.listen(3101, '0.0.0.0');
  const watchdog = setTimeout(() => { server.close(); void unlink(manifest).catch(() => {}); process.exit(1); }, 180_000);
  watchdog.unref();
}
