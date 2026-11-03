/** DIMA-044 exact-candidate API behavior check. Uses existing pet-runtime/OAuth provider fixtures only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { GridFSBucket, ObjectId } = createRequire('/app/package.json')('mongodb');
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/, 'disposable database required');
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const mongo = await getMongoDBConnection('pet-runtime-check');
const redis = await getDragonflyClient('pet-runtime-check');
const { PetRequest, PetRuntime } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { PetSettingsSchema } = await import('/app/dist/schemas/pet_settings.schema.js');
const { upsertChannelTtsSettings } = await import('/app/dist/schemas/channel_tts_settings.schema.js');
const { OAuthSession } = await import('/app/dist/schemas/oauth_session.schema.js');
const { PetReadiness } = await import('/app/dist/pets/readiness.schema.js');
const { admitPetAction } = await import('/app/dist/pets/admission.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
const owner = '99003101', other = '99003102', base = 'http://127.0.0.1:3000';
const inserted = await mongo.connection.db.collection('users').insertMany([
  { name: 'Pet owner', plan_tier: 'premium', polar_sh_customer_id: 'pet-test-customer', accounts: [{ type: 'twitch', id: owner, name: 'pet_owner' }] },
  { name: 'Other owner', plan_tier: 'pro', accounts: [{ type: 'twitch', id: other, name: 'pet_other' }] }
]);
const ownerId = String(inserted.insertedIds[0]);
for (const [token, id] of [['pet-owner-token', owner], ['pet-other-token', other]]) await redis.hSet(`token:${token}`, { id, login: id, display_name: 'Pet fixture' });
async function credits(status = 'available') {
  await redis.del(`twitch:${owner}:ai:exhaust`, `${owner}:ai:exhaust`);
  await redis.set(`twitch:${owner}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
    used: status === 'exhausted' ? 100 : 0, limit: 100, balance: status === 'exhausted' ? 0 : 100,
    available: status !== 'unavailable', status, updatedAt: new Date().toISOString() }));
}
await credits();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(30); }
  throw new Error(`Timed out: ${message}`);
}
async function call(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: response.status === 302 ? null : await response.json() };
}
async function mint(browser = 'oauth-beta-browser-owner', scope = 'profile:read credits:read desktop:connect pet:read pet:receive pet:control pet:playback:select') {
  const verifier = randomBytes(32).toString('base64url');
  const start = await call('/oauth/authorize?' + new URLSearchParams({ client_id: 'dima-desktop', response_type: 'code', scope,
    redirect_uri: 'http://127.0.0.1:42781/oauth/callback', state: verifier,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', device_name: 'Fixture PC' }));
  assert.equal(start.status, 302, JSON.stringify(start.body));
  const id = new URL(start.headers.get('location')).searchParams.get('request');
  const decision = await call(`/oauth/requests/${id}/decision`, { method: 'POST', token: browser, body: { approve: true } });
  assert.equal(decision.status, 200);
  const exchange = await call('/oauth/token', { method: 'POST', body: { client_id: 'dima-desktop', grant_type: 'authorization_code',
    code: new URL(decision.body.redirect_uri).searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://127.0.0.1:42781/oauth/callback' } });
  assert.equal(exchange.status, 200); return exchange.body;
}
const sockets = [], connectedClients = [];
const renewal = setInterval(() => { for (const client of connectedClients) {
  if (!client.lease || client.renewing || client.ws.readyState !== WebSocket.OPEN) continue;
  const lease = client.lease; client.renewing = true;
  void client.send('pet:lease', { v: 1, action: 'renew', leaseId: lease.leaseId, generation: lease.generation })
    .then(ack => { if (client.lease?.leaseId === lease.leaseId) client.lease = ack.ok ? ack.data : null; })
    .catch(() => { client.lease = null; }).finally(() => { client.renewing = false; });
} }, 5000); renewal.unref();
async function connect(namespace, auth, reject = false, needsSnapshot = true) {
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws);
  const events = [], acks = new Map(); let sequence = 0, joined = false, joinedInfo, failure;
  ws.on('message', raw => {
    const message = raw.toString();
    if (message === '2') return ws.send('3');
    if (message.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify(auth)}`);
    if (message.startsWith(`40${namespace},`)) { joined = true; joinedInfo = JSON.parse(message.slice(`40${namespace},`.length)); }
    if (message.startsWith(`44${namespace},`)) failure = JSON.parse(message.slice(`44${namespace},`.length));
    if (message.startsWith(`42${namespace},`)) {
      const packet = JSON.parse(message.slice(`42${namespace},`.length)), [event, data] = packet;
      if (namespace === '/desktop' || namespace === '/pet') {
        assert.equal(packet.length, 2, `${namespace} wire event must be exactly [event, object], without a recovery offset`);
        assert.equal(typeof event, 'string'); assert.ok(data && typeof data === 'object' && !Array.isArray(data));
      }
      events.push({ event, data, offset: packet.length > 2 ? packet.at(-1) : undefined, receivedAt: Date.now() }); if (events.length > 500) events.shift();
    }
    if (message.startsWith(`43${namespace},`)) {
      const rest = message.slice(`43${namespace},`.length), bracket = rest.indexOf('[');
      acks.get(Number(rest.slice(0, bracket)))?.(JSON.parse(rest.slice(bracket))[0]); acks.delete(Number(rest.slice(0, bracket)));
    }
  });
  await once(ws, 'open');
  await until(() => failure || joined, 'namespace authentication');
  if (reject) { assert.ok(failure, 'namespace must reject'); ws.close(); return failure; }
  assert.ok(!failure, JSON.stringify(failure));
  let disconnected = false;
  ws.on('message', raw => { if (raw.toString().startsWith(`41${namespace},`)) disconnected = true; });
  const result = { ws, events, get disconnected() { return disconnected; }, get joinedInfo() { return joinedInfo; },
    send(event, data) { const id = ++sequence; return new Promise((resolve, rejectAck) => {
      const timer = setTimeout(() => { acks.delete(id); rejectAck(new Error(`Missing ack ${event}`)); }, 5000);
      acks.set(id, value => { clearTimeout(timer); resolve(value); }); ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`);
    }); },
    event(event, predicate = () => true, timeout = 10_000) { return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event, timeout); },
    mark() { return events.length; },
    latestSnapshot() { return events.filter(item => item.event === 'pet:snapshot').at(-1)?.data; }
  };
  if (needsSnapshot) await result.event('pet:snapshot'); connectedClients.push(result); return result;
}
const assetId = new ObjectId(), foreignAsset = new ObjectId();
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const upload = new GridFSBucket(mongo.connection.db, { bucketName: 'private_assets' }).openUploadStreamWithId(assetId, 'pet.gif', { metadata: { owner, mime: 'image/gif' } });
const stored = once(upload, 'finish'); upload.end(gif); await stored;
await mongo.connection.db.collection('asset_libraries').insertMany([
  { _id: owner, usedBytes: gif.length, assets: [{ id: String(assetId), name: 'pet.gif', kind: 'image', mime: 'image/gif', bytes: gif.length, width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }] },
  { _id: other, usedBytes: 1, assets: [{ id: String(foreignAsset), name: 'foreign.gif', kind: 'image', mime: 'image/gif', bytes: 1, width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }] }
]);
const settingsPath = `/pets/${owner}/settings`;
let configuration = (await call(settingsPath, { token: 'pet-owner-token' })).body.data;
assert.equal(configuration.schemaVersion, 3);
assert.equal(await PetSettingsSchema.countDocuments(), 0);
const save = async change => {
  const result = await call(settingsPath, { method: 'PUT', token: 'pet-owner-token', body: { revision: configuration.revision, settings: change(configuration.settings) } });
  assert.equal(result.status, 200, JSON.stringify(result.body)); configuration = result.body.data; return configuration;
};
await save(settings => ({ ...settings, appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) }, enabled: true, behavior: { ...settings.behavior, cooldownSeconds: 0 } }));
const desktopToken = await mint(), secondToken = await mint(), foreignToken = await mint('oauth-beta-browser-other');
const narrow = await mint('oauth-beta-browser-owner', 'desktop:connect pet:read');
assert.ok((await connect('/desktop', { v: 1, accessToken: narrow.access_token }, true)).message.includes('insufficient_scope'));
const desktop = await connect('/desktop', { v: 1, accessToken: desktopToken.access_token });
assert.deepEqual((await desktop.event('desktop:hello')).features, ['reauth']);
const ready = { v: 1, audioReady: true, renderReady: true, vtsReady: true };
assert.equal((await desktop.send('pet:ready', ready)).ok, true);
const selected = await call('/v1/me/pet/playback', { method: 'PUT', token: desktopToken.access_token,
  body: { commandId: randomUUID(), revision: configuration.revision, roles: ['audio', 'vts'] } });
assert.equal(selected.status, 200); configuration = selected.body;
await save(settings => ({ ...settings, appearance: { ...settings.appearance, kind: 'vts' } }));
const leaseAck = await desktop.send('pet:lease', { v: 1, action: 'acquire' });
assert.equal(leaseAck.ok, true, JSON.stringify(leaseAck)); desktop.lease = leaseAck.data;
const produced = await admitPetAction({ channelId: owner, operation: 'talk', text: 'Connection reliability fixture',
  origin: { kind: 'chat-command', id: randomUUID(), occurredAt: new Date().toISOString() },
  actionKey: 'command:pet:0', actor: { userId: owner, displayName: 'Fixture' } });
const play = await desktop.event('pet:play', data => data.requestId === produced.requestId);
assert.equal((await desktop.send('pet:playback', { v: 1, requestId: play.requestId, leaseId: play.leaseId,
  generation: play.generation, seq: 0, phase: 'started', positionMs: 0 })).ok, true);
const before = await PetRuntime.findById(ownerId).lean();
const beforeProjection = await PetReadiness.findById(ownerId).lean();
const peerId = desktop.latestSnapshot().peerId;
const refreshed = await call('/oauth/token', { method: 'POST', body: { client_id: 'dima-desktop',
  grant_type: 'refresh_token', refresh_token: desktopToken.refresh_token } });
assert.equal(refreshed.status, 200); assert.equal(refreshed.body.session_id, desktopToken.session_id);
const replacement = refreshed.body.access_token;
const { hash } = await import('/app/dist/server/oauth/service.js');
const accessKey = token => `oauth:access:${hash(token)}`;
// Swap before expiry, as the client must do, then expire the old token without a 10-minute wait.
// The unit suite separately proves that the reauth handler skips an already-expired old-token precheck.
assert.ok(await redis.get(accessKey(desktopToken.access_token)));
assert.deepEqual(await desktop.send('desktop:reauth', { v: 1, accessToken: replacement }), { ok: true, data: {} });
assert.equal(await redis.del(accessKey(desktopToken.access_token)), 1);
assert.equal(await redis.get(accessKey(desktopToken.access_token)), null);
const after = await PetRuntime.findById(ownerId).lean();
assert.equal(after.generation, before.generation); assert.equal(after.activeRequestId, before.activeRequestId);
assert.equal(after.lease.leaseId, before.lease.leaseId); assert.equal(after.lease.holderPeerId, before.lease.holderPeerId);
assert.equal(after.notBefore.getTime(), before.notBefore.getTime());
assert.equal(desktop.latestSnapshot().peerId, peerId);
assert.equal((await PetRequest.findById(play.requestId).lean()).status, 'playing');
assert.equal((await desktop.send('pet:lease', { v: 1, action: 'renew', leaseId: play.leaseId, generation: play.generation })).ok, true,
  'ordinary handlers use the replacement after the old token has expired');
assert.equal((await desktop.send('pet:ready', ready)).ok, true);
const projection = await PetReadiness.findById(ownerId).lean();
assert.equal(projection.peerId, beforeProjection.peerId); assert.equal(projection.generation, beforeProjection.generation);
console.log('PASS live socket reauth: feature, peer, lease, active playback, generation, VTS proof and new-token revalidation');

// Cancellation runs invalidatePet in the real API process, whose VTS controller remains ready.
const started = Date.now();
const cancelled = await call(`/v1/me/pet/requests/${play.requestId}/cancel`, { method: 'POST', token: replacement,
  body: { commandId: randomUUID() } });
assert.equal(cancelled.status, 200); desktop.lease = null;
const invalidated = await PetRuntime.findById(ownerId).lean();
const republished = await PetReadiness.findById(ownerId).lean();
assert.equal(invalidated.generation, before.generation + 1); assert.equal(invalidated.lease, null);
assert.ok(republished, 'ready VTS proof exists immediately after invalidation returns');
assert.equal(republished.generation, invalidated.generation); assert.equal(republished.peerId, peerId);
assert.ok(Date.now() - started < 5000, 'does not wait for the readiness tick');
assert.ok(invalidated.notBefore.getTime() >= after.lease.expiresAt.getTime(), 'handover barrier is preserved');
const current = await call('/v1/me/pet', { token: replacement });
assert.equal(current.status, 200); assert.ok(!current.body.runtime.issues.includes('vts_unavailable'));
console.log('PASS immediate new-generation readiness after real API cancellation; conservative lease barrier preserved');

// Each failure uses a second peer without the lease, so the healthy VTS controller stays connected.
for (const [token, code] of [[secondToken.access_token, 'invalid_token'], [foreignToken.access_token, 'invalid_token']]) {
  const client = await connect('/desktop', { v: 1, accessToken: replacement });
  assert.deepEqual(await client.send('desktop:reauth', { v: 1, accessToken: token }), { ok: false, error: { code } });
  await until(() => client.disconnected || client.ws.readyState !== WebSocket.OPEN, 'failed reauth disconnects');
}
const reduced = `dima_at_${randomBytes(32).toString('base64url')}`;
const fullIdentity = JSON.parse(await redis.get(accessKey(replacement)));
await redis.set(accessKey(reduced), JSON.stringify({ ...fullIdentity, scopes: ['desktop:connect', 'pet:read'] }), { EX: 60 });
const scopeClient = await connect('/desktop', { v: 1, accessToken: replacement });
assert.deepEqual(await scopeClient.send('desktop:reauth', { v: 1, accessToken: reduced }), { ok: false, error: { code: 'insufficient_scope' } });
await until(() => scopeClient.disconnected, 'scope rejection disconnect');
const legacy = await connect('/desktop', { v: 1, accessToken: replacement });
for (const value of [{ v: 1 }, { v: 1, accessToken: 4 }, { v: 1, accessToken: replacement, extra: true }]) {
  assert.deepEqual(await legacy.send('desktop:reauth', value), { ok: false, error: { code: 'invalid_message' } });
}
const legacyToken = `dima_at_${randomBytes(32).toString('base64url')}`;
await redis.set(accessKey(legacyToken), JSON.stringify(fullIdentity), { EX: 60 });
// First retire the spare peer, retaining the controller; the next legacy peer never reauthenticates.
legacy.ws.close(); await until(() => legacy.ws.readyState === WebSocket.CLOSED, 'spare peer closed'); await pause(100);
const oldClient = await connect('/desktop', { v: 1, accessToken: legacyToken });
assert.equal(await redis.del(accessKey(legacyToken)), 1);
assert.equal((await oldClient.send('pet:ready', ready)).error.code, 'invalid_token');
await until(() => oldClient.disconnected, 'legacy expiry disconnects');
assert.equal((await desktop.send('pet:ready', ready)).ok, true, 'healthy controller still connected');
console.log('PASS session/user mismatches, narrowed scopes, malformed messages, and unchanged legacy expiry behavior');

const logEntries = await until(async () => {
  const keys = await redis.keys(`logger:twitch:${owner}:info:*`);
  const entries = keys.length ? (await redis.mGet(keys)).filter(Boolean).map(JSON.parse).map(row => row.data) : [];
  return entries.some(row => row.event === 'reauth' && row.reason === 'ok') &&
    entries.some(row => row.event === 'invalidated' && row.reason === 'cancelled') &&
    entries.some(row => row.event === 'reauth' && row.reason === 'insufficient_scope') ? entries : null;
}, 'allowlisted lifecycle diagnostic records');
const logged = JSON.stringify(logEntries);
for (const secret of [replacement, desktopToken.access_token, reduced, legacyToken]) assert.ok(!logged.includes(secret));
console.log('PASS lifecycle diagnostics record outcomes without tokens');
clearInterval(renewal); for (const socket of sockets) socket.close();
for (const suite of ['socket', 'state', 'readiness', 'diagnostics', 'socket_adapter', 'delivery']) {
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', `/app/dist/pets/${suite}.test.js`],
    { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit', timeout: 30_000 });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, `${suite} packaged suite`);
}
console.log('PASS DIMA-044 exact-candidate API behavior and packaged regression suites');
process.exit(0);
