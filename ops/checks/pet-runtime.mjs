/** Exact-candidate API check. Only disposable Mongo/Redis plus staged pet-runtime-fixtures. */
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
const { OAuthSession } = await import('/app/dist/schemas/oauth_session.schema.js');
const { ChannelAIPersonalitySchema } = await import('/app/dist/schemas/channel_ai_personality.schema.js');
const { PetReadiness } = await import('/app/dist/pets/readiness.schema.js');
const { admitPetAction } = await import('/app/dist/pets/admission.js');
const { invalidatePet, notifyPet, runtimeFor } = await import('/app/dist/pets/state.js');
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
const mongoOnlyRecovery = process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED?.toLowerCase() === 'false';
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
    if (message.startsWith(`42${namespace},`)) { const packet = JSON.parse(message.slice(`42${namespace},`.length)), [event, data] = packet; events.push({ event, data, offset: packet.length > 2 ? packet.at(-1) : undefined }); if (events.length > 500) events.shift(); }
    if (message.startsWith(`43${namespace},`)) {
      const rest = message.slice(`43${namespace},`.length), bracket = rest.indexOf('[');
      acks.get(Number(rest.slice(0, bracket)))?.(JSON.parse(rest.slice(bracket))[0]); acks.delete(Number(rest.slice(0, bracket)));
    }
  });
  await once(ws, 'open');
  await until(() => failure || joined, 'namespace authentication');
  if (reject) { assert.ok(failure, 'namespace must reject'); ws.close(); return failure; }
  assert.ok(!failure, JSON.stringify(failure));
  const result = { ws, events, get joinedInfo() { return joinedInfo; },
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
assert.equal(configuration.schemaVersion, 2);
assert.equal(await PetSettingsSchema.countDocuments(), 0);
const save = async change => {
  const result = await call(settingsPath, { method: 'PUT', token: 'pet-owner-token', body: { revision: configuration.revision, settings: change(configuration.settings) } });
  assert.equal(result.status, 200, JSON.stringify(result.body)); configuration = result.body.data; return configuration;
};
await save(settings => ({ ...settings, appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) }, enabled: true, behavior: { ...settings.behavior, cooldownSeconds: 0 } }));
const desktopToken = await mint(), secondToken = await mint(), foreignToken = await mint('oauth-beta-browser-other');
const narrow = await mint('oauth-beta-browser-owner', 'desktop:connect pet:read');
assert.ok((await connect('/desktop', { v: 1, accessToken: narrow.access_token }, true)).message.includes('insufficient_scope'));
// Unrelated site namespaces retain actual Socket.IO recovery.
const site = await connect('/site/analytics/registered-channels', {}, false, false);
await site.event('registered-channels');
const sitePacket = site.events.find(item => item.event === 'registered-channels');
assert.ok(site.joinedInfo.pid && sitePacket.offset, 'global recovery remains configured');
site.ws.terminate(); await pause(100);
const restoredSite = await connect('/site/analytics/registered-channels', { pid: site.joinedInfo.pid, offset: sitePacket.offset }, false, false);
assert.equal(restoredSite.joinedInfo.sid, site.joinedInfo.sid, 'existing namespace restores its session');
const desktop = await connect('/desktop', { v: 1, accessToken: desktopToken.access_token });
assert.equal((await desktop.event('desktop:hello')).sessionId, desktopToken.session_id);
await connect('/desktop', { v: 1, accessToken: desktopToken.access_token, pid: desktop.joinedInfo.pid, offset: 'stale' }, true);
const overlap = await connect('/desktop', { v: 1, accessToken: desktopToken.access_token });
await connect('/desktop', { v: 1, accessToken: desktopToken.access_token }, true);
const second = await connect('/desktop', { v: 1, accessToken: secondToken.access_token });
const foreign = await connect('/desktop', { v: 1, accessToken: foreignToken.access_token });
const ready = { v: 1, audioReady: true, renderReady: true, vtsReady: true };
assert.equal((await desktop.send('pet:ready', ready)).ok, true);
assert.equal((await second.send('pet:ready', ready)).ok, true);
let runtime = (await call(`/pets/${owner}/runtime`, { token: 'pet-owner-token' })).body.data;
assert.deepEqual(Object.keys(runtime).sort(), ['active', 'generation', 'sessions', 'v']);
assert.equal(runtime.sessions.length, 2, 'same OAuth session is one aggregate candidate');
assert.equal(runtime.sessions.find(session => session.sessionId === desktopToken.session_id).audioReady, true);
assert.ok(!runtime.sessions.some(session => session.sessionId === foreignToken.session_id));
let foreignSettings = structuredClone(configuration.settings);
foreignSettings.playback = { target: 'desktop', desktopSessionId: foreignToken.session_id, vtsSessionId: null };
assert.equal((await call(settingsPath, { method: 'PUT', token: 'pet-owner-token', body: { revision: configuration.revision, settings: foreignSettings } })).status, 409);
const select = (token, roles, revision = configuration.revision) => call('/v1/me/pet/playback', { method: 'PUT', token,
  body: { commandId: randomUUID(), revision, roles } });
let result = await select(desktopToken.access_token, ['audio', 'vts']); assert.equal(result.status, 200); configuration = result.body;
const acquire = async client => { const ack = await client.send('pet:lease', { v: 1, action: 'acquire' }); assert.equal(ack.ok, true, JSON.stringify(ack)); client.lease = ack.data; return ack.data; };
await save(settings => ({ ...settings, appearance: { ...settings.appearance, kind: 'vts' } }));
let lease = await acquire(desktop);
assert.equal((await overlap.send('pet:lease', { v: 1, action: 'acquire' })).error.code, 'player_not_selected' /* unready overlap */);
await overlap.send('pet:ready', { ...ready, audioReady: false });
const before = desktop.mark();
await desktop.send('pet:ready', ready); await pause(150);
assert.ok(desktop.events.slice(before).filter(item => item.event === 'pet:snapshot').length <= 1, 'unchanged readiness does not republish snapshots');
const action = (text = 'Hello pet', operation = 'talk') => ({ channelId: owner, operation, text,
  origin: { kind: 'chat-command', id: randomUUID(), occurredAt: new Date().toISOString() }, actionKey: 'command:pet:0', actor: { userId: owner, displayName: 'Fixture' } });
async function separateProducer(input, env = {}) {
  const child = spawn(process.execPath, ['/tmp/saas-fixtures/producer.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  child.stdin.end(JSON.stringify(input));
  const [code] = await once(child, 'close'); clearTimeout(timer);
  assert.equal(code, 0, stderr);
  const line = stdout.split('\n').find(line => line.startsWith('PET_RESULT:'));
  assert.ok(line, stdout); const result = JSON.parse(line.slice('PET_RESULT:'.length));
  assert.notEqual(result.pid, process.pid); assert.equal(result.peers, 0); return result;
}
const identityFor = (play, seq, phase = 'started') => ({ v: 1, requestId: play.requestId, leaseId: play.leaseId, generation: play.generation, seq, phase, positionMs: phase === 'ended' ? 500 : 0 });
const assertNoReplay = async client => { await pause(150); assert.equal(client.events.filter(item => item.event === 'pet:play').length, 0); };
if (mongoOnlyRecovery) {
  // Neither this API nor its separate producer may publish hints. Recovery must
  // discover durable acceptance without a healthy notifyPet shortcut.
  const started = Date.now();
  const produced = await separateProducer(action('Mongo-only durable recovery'));
  assert.ok(produced.result, JSON.stringify(produced));
  assert.equal(produced.result.status, 'accepted');
  assert.ok(produced.elapsedMs < 2000, 'disabled hints must not delay admission');
  const requestId = produced.result.requestId;
  const play = await desktop.event('pet:play', data => data.requestId === requestId, 25_000);
  assert.ok(Date.now() - started < 25_000, '15-second bounded recovery plus provider/scheduling allowance');
  const playIndex = desktop.events.findIndex(item => item.event === 'pet:play' && item.data.requestId === requestId);
  assert.equal(desktop.events[playIndex - 1]?.data.request.status, 'ready');
  assert.equal((await desktop.send('pet:playback', identityFor(play, 0))).ok, true);
  assert.equal((await desktop.send('pet:playback', identityFor(play, 1, 'ended'))).ok, true);
  await desktop.event('pet:request', data => data.request.requestId === requestId && data.request.status === 'completed', 25_000);
  await until(() => desktop.latestSnapshot()?.active === null && second.latestSnapshot()?.active === null, 'Mongo-only terminal recovery reaches all renderers', 25_000);
  assert.equal((await PetRequest.findById(requestId).lean()).status, 'completed');
  assert.equal(desktop.events.filter(item => item.event === 'pet:play' && item.data.requestId === requestId).length, 1);
  assert.equal((await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'tts').length, 1);
  clearInterval(renewal); for (const socket of sockets) socket.close();
  console.log('PASS pet Mongo-only recovery: separate producer, hints disabled, bounded play/terminal recovery, no replay');
  process.exit(0);
}
const projected = await PetReadiness.findById(ownerId).lean();
assert.ok(projected && projected.expiresAt <= projected.authorizationExpiresAt);
// Isolate malformed projections from the live API refresh loop so every fence case is deterministic.
const shadowId = new ObjectId(), shadowChannel = '99003109';
await mongo.connection.db.collection('users').insertOne({ _id: shadowId, plan_tier: 'premium', accounts: [{ type: 'twitch', id: shadowChannel }] });
await PetSettingsSchema.create({ userId: shadowId, revision: configuration.revision, settings: configuration.settings, updatedAt: new Date() });
await PetRuntime.create({ _id: String(shadowId), channelId: shadowChannel, generation: lease.generation,
  lease: { leaseId: 'shadow-lease', holderPeerId: 'unconnected-shadow', expiresAt: new Date(Date.now() + 60_000) } });
for (const change of [{ generation: lease.generation + 1 }, { settingsRevision: configuration.revision + 1 },
  { sessionId: secondToken.session_id }, { expiresAt: new Date(0) }, { authorizationExpiresAt: new Date(0) }]) {
  await PetReadiness.replaceOne({ _id: String(shadowId) }, { ...projected, _id: String(shadowId), ...change }, { upsert: true });
  assert.equal((await separateProducer({ ...action('Stale readiness fence'), channelId: shadowChannel })).error, 'vts_unavailable');
}
await Promise.all([PetReadiness.deleteOne({ _id: String(shadowId) }), PetSettingsSchema.deleteOne({ userId: shadowId }),
  PetRuntime.deleteOne({ _id: String(shadowId) }), mongo.connection.db.collection('users').deleteOne({ _id: shadowId })]);
const input = action();
await assert.rejects(admitPetAction({ ...input, origin: { ...input.origin, id: '' } }), /invalid_origin/);
assert.equal((await desktop.send('pet:lease', { v: 1, action: 'renew', leaseId: lease.leaseId, generation: lease.generation + 1 })).error.code, 'stale_lease');
assert.equal((await desktop.send('pet:lease', { v: 1, action: 'renew', leaseId: { $ne: null }, generation: lease.generation })).error.code, 'invalid_message');
await until(() => PetReadiness.findOne({ _id: ownerId, generation: lease.generation, settingsRevision: configuration.revision, sessionId: desktopToken.session_id }).lean(), 'API publishes generation-bound VTS readiness');
const produced = await separateProducer(input);
assert.ok(produced.result, JSON.stringify(produced));
const concurrent = await Promise.all([admitPetAction(input), admitPetAction(input)]);
assert.equal(produced.result.requestId, concurrent[0].requestId);
assert.equal(concurrent[0].requestId, concurrent[1].requestId);
const requestId = concurrent[0].requestId;
await assert.rejects(admitPetAction({ ...input, text: 'changed' }), /idempotency_conflict/);
const play = await desktop.event('pet:play', data => data.requestId === requestId);
const playIndex = desktop.events.findIndex(item => item.event === 'pet:play' && item.data.requestId === requestId);
assert.equal(desktop.events[playIndex - 1]?.event, 'pet:request', 'selected socket receives ready immediately before the sole play');
assert.equal(desktop.events[playIndex - 1]?.data.request.status, 'ready');
assert.equal(desktop.events[playIndex - 1]?.data.request.requestId, requestId);
assert.equal(play.audio.durationMs, 500);
assert.ok(Number.isSafeInteger(play.startBefore));
assert.ok(!play.audio.url.includes('/speech/audio/'));
const media = await fetch(base + new URL(play.audio.url).pathname + new URL(play.audio.url).search);
assert.equal(media.status, 200); assert.equal((await media.arrayBuffer()).byteLength, 16044);
assert.match(media.headers.get('cache-control'), /no-store/);
assert.equal((await fetch(base + `/pets/playback/${requestId}/audio`)).status, 401);
await assert.rejects(admitPetAction(action('Busy')), /busy/);
assert.equal((await desktop.send('pet:playback', identityFor(play, 0))).ok, true);
await until(() => PetRequest.findOne({ _id: requestId, status: 'playing' }).lean(), 'persist actual playing');
const mouth = { ...identityFor(play, 0), value: 0.5 }; delete mouth.phase;
const burst = await Promise.all([desktop.send('pet:mouth', mouth), desktop.send('pet:playback', identityFor(play, 1, 'progress'))]);
assert.ok(burst.every(ack => ack.ok));
const injected = desktop.events.filter(item => item.event === 'pet:mouth').length + overlap.events.filter(item => item.event === 'pet:mouth').length;
assert.equal(injected, 1, 'one selected VTS peer, even during same-session overlap');
overlap.ws.close();
assert.equal((await desktop.send('pet:playback', identityFor(play, 2, 'ended'))).ok, true);
await until(() => desktop.latestSnapshot()?.active === null && second.latestSnapshot()?.active === null, 'terminal wake reaches every renderer');
await desktop.event('pet:request', data => data.request.requestId === requestId && data.request.status === 'completed');
assert.equal((await admitPetAction(input)).status, 'completed');
assert.equal((await fetch(base + new URL(play.audio.url).pathname + new URL(play.audio.url).search)).status, 403);
assert.equal((await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'tts').length, 1);
const firstBilling = (await redis.lRange('pet:test:billing-events', 0, -1)).map(JSON.parse);
assert.equal(firstBilling.length, 1, 'completed replay performs no duplicate ingest');
assert.equal(firstBilling[0].external_id, `${requestId}:tts`);
assert.equal(firstBilling[0].metadata.request_id, `${requestId}:tts`);
assert.equal(firstBilling[0].metadata.usage_source, 'pet');
// Redis is advisory even in a real producer process: a refused connection cannot delay Mongo admission.
const outage = await separateProducer(action('Durable admission while Redis hints are unavailable'), { DRAGONFLY_PORT: '1' });
assert.ok(outage.result, JSON.stringify(outage));
assert.ok(outage.elapsedMs < 2000, 'Mongo acceptance must not wait for Redis connect/reconnect');
// Explicitly prompt the healthy API after proving producer acceptance (recovery also remains enabled).
await notifyPet(ownerId);
const outagePlay = await desktop.event('pet:play', data => data.requestId === outage.result.requestId);
await desktop.send('pet:playback', identityFor(outagePlay, 0, 'error'));
// The next request resets request-scoped sequence, under the same lease.
const next = await admitPetAction(action('Second speech'));
const nextPlay = await desktop.event('pet:play', data => data.requestId === next.requestId);
assert.equal((await desktop.send('pet:playback', identityFor(nextPlay, 0))).ok, true);
assert.equal((await desktop.send('pet:playback', identityFor(nextPlay, 1, 'ended'))).ok, true);
// Missing required appearance is rejected before providers even with a selected desktop.
let providerCount = await redis.lLen('pet:test:provider-calls');
await save(settings => ({ ...settings, appearance: { kind: 'png', idleAssetId: null, talkingAssetId: null } }));
await assert.rejects(admitPetAction(action('Invisible PNG')), /appearance_unavailable/);
assert.equal(await redis.lLen('pet:test:provider-calls'), providerCount);
await save(settings => ({ ...settings, appearance: { kind: 'vts', idleAssetId: null, talkingAssetId: null }, playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null } }));
await assert.rejects(admitPetAction(action('Missing VTS')), /vts_unavailable/);
assert.equal(await redis.lLen('pet:test:provider-calls'), providerCount);
await save(settings => ({ ...settings, appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) }, playback: { target: 'desktop', desktopSessionId: desktopToken.session_id, vtsSessionId: desktopToken.session_id } }));
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } }); lease = await acquire(desktop);
// Cancellation aborts a provider and never falls back/retries an ambiguous result.
await redis.set('pet:test:provider-mode', 'hold');
const cancelled = await admitPetAction(action('Cancel during synthesis'));
await until(() => PetRequest.findOne({ _id: cancelled.requestId, status: 'synthesizing' }).lean(), 'provider phase persisted');
result = await call(`/v1/me/pet/requests/${cancelled.requestId}/cancel`, { method: 'POST', token: desktopToken.access_token, body: { commandId: randomUUID() } });
assert.equal(result.body.status, 'cancelled');
await redis.del('pet:test:provider-mode');
await until(() => PetRuntime.findOne({ _id: ownerId, activeRequestId: null }).lean(), 'cancel frees runtime');
await pause(100);
assert.equal((await desktop.send('pet:lease', { v: 1, action: 'acquire' })).error.code, 'lease_unavailable', 'handover waits previous conservative lease expiry');
// Replace lease timing only in disposable Mongo so this check need not wait 15 seconds per handover.
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } });
lease = await acquire(desktop);
await save(settings => ({ ...settings, behavior: { ...settings.behavior, respondToChat: false, respondToEvents: false } }));
await assert.rejects(admitPetAction(action('Disabled command')), /trigger_disabled/);
const disabledEvent = action('Disabled event'); disabledEvent.origin.kind = 'twitch-event';
await assert.rejects(admitPetAction(disabledEvent), /trigger_disabled/);
await save(settings => ({ ...settings, behavior: { ...settings.behavior, respondToChat: true, respondToEvents: true } }));
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } }); lease = await acquire(desktop);
const countBefore = await redis.lLen('pet:test:provider-calls');
await redis.set('pet:test:provider-mode', 'ambiguous');
const failed = await admitPetAction(action('Ambiguous provider'));
await until(() => PetRequest.findOne({ _id: failed.requestId, status: 'failed' }).lean(), 'ambiguous failure is terminal');
assert.equal(await redis.lLen('pet:test:provider-calls'), countBefore + 1, 'no provider retry');
await redis.del('pet:test:provider-mode');
// No-tool LLM is raw spoken text; its AST-looking reply never executes.
const askInput = action('Say something friendly', 'ask');
const ask = await admitPetAction(askInput);
const askPlay = await desktop.event('pet:play', data => data.requestId === ask.requestId);
const calls = (await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse);
assert.deepEqual(calls.find(item => item.kind === 'llm').body.tools, []);
assert.ok(calls.some(item => item.kind === 'tts' && item.body.text.includes('$(counter must-not-evaluate)')));
assert.equal((await desktop.send('pet:playback', identityFor(askPlay, 0))).ok, true);
assert.equal((await desktop.send('pet:playback', identityFor(askPlay, 1, 'ended'))).ok, true);
const queued = (await redis.lRange('pet:test:billing-events', 0, -1)).map(JSON.parse);
for (const phase of ['llm', 'tts']) {
  const billed = queued.filter(item => item.external_id === `${ask.requestId}:${phase}`);
  assert.equal(billed.length, 1, `exactly one ${phase} ingest`);
  assert.equal(billed[0].metadata.request_id, `${ask.requestId}:${phase}`);
  assert.equal(billed[0].metadata.usage_source, 'pet');
}
const beforeAskReplay = { providers: await redis.lLen('pet:test:provider-calls'), billing: queued.length };
assert.equal((await admitPetAction(askInput)).status, 'completed');
await pause(100);
assert.equal(await redis.lLen('pet:test:provider-calls'), beforeAskReplay.providers);
assert.equal(await redis.lLen('pet:test:billing-events'), beforeAskReplay.billing);
// Exhausted/unverified credits use the existing provider fallback policy.
await credits('unavailable');
await save(settings => ({ ...settings, tts: { enabled: true, provider: 'fish', language: 'es', voice: '7b5626abdaa044babfc3829ec15acf31' } }));
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } });
lease = await acquire(desktop);
const fallback = await admitPetAction(action('Use free fallback'));
const fallbackPlay = await desktop.event('pet:play', data => data.requestId === fallback.requestId);
assert.equal(fallbackPlay.audio.mimeType, 'audio/wav');
await desktop.send('pet:playback', identityFor(fallbackPlay, 0, 'error'));
// Keep unavailable-credit Piper fallback for the admission-only crash fixture;
// paid Fish in this provider fixture deliberately returns HTTP 503.
// A crash between request insert and runtime CAS is resolved by an identical duplicate.
const partialInput = action('Recover uncommitted admission');
const partialState = await runtimeFor(ownerId, owner), partialId = randomUUID();
await PetRequest.create({ _id: partialId, ...partialInput, ownerId,
  payloadHash: createHash('sha256').update(JSON.stringify({ operation: partialInput.operation, text: partialInput.text, actor: partialInput.actor, occurredAt: partialInput.origin.occurredAt })).digest('hex'),
  admitted: false, generation: partialState.generation, settingsRevision: configuration.revision, status: 'accepted', version: 1,
  phaseDeadline: new Date(Date.now() + 60_000), createdAt: new Date(), expiresAt: new Date(Date.now() + 86400_000) });
const partialDuplicate = await admitPetAction(partialInput);
assert.equal(partialDuplicate.requestId, partialId);
assert.equal((await PetRequest.findById(partialId).lean()).admitted, true);
const partialPlay = await desktop.event('pet:play', data => data.requestId === partialId);
await desktop.send('pet:playback', identityFor(partialPlay, 0, 'error'));
await credits();
// Public capability and original asset ownership/deletion guards.
const badAssets = { ...configuration.settings, appearance: { kind: 'png', idleAssetId: String(foreignAsset), talkingAssetId: String(assetId) } };
assert.equal((await call(settingsPath, { method: 'PUT', token: 'pet-owner-token', body: { revision: configuration.revision, settings: badAssets } })).status, 404);
await save(settings => ({ ...settings, appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) } }));
assert.equal((await call(`/asset-library/${owner}/${assetId}`, { method: 'DELETE', token: 'pet-owner-token' })).status, 409);

let tokenState = (await call(`/pets/${owner}/overlay-token`, { method: 'POST', token: 'pet-owner-token', body: {} })).body.data;
assert.match(tokenState.token, /^[\w-]{43}$/);
assert.equal((await call(`/pets/${owner}/overlay-token`, { method: 'POST', token: 'pet-owner-token', body: {} })).body.data.token, tokenState.token);
const assetResponse = await fetch(`${base}/pets/public/${tokenState.token}/assets/${assetId}`);
assert.equal(assetResponse.status, 200); assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), gif, 'original GIF bytes');
assert.equal((await fetch(`${base}/pets/public/${tokenState.token}/assets/${foreignAsset}`)).status, 404);
const publicBody = (await call(`/pets/public/${tokenState.token}`)).body.data;
assert.ok(!JSON.stringify(publicBody).includes('personality'));
assert.ok(!('sessions' in publicBody.runtime));
const browser = await connect('/pet', { v: 1, capability: tokenState.token });
const duplicateBrowser = await connect('/pet', { v: 1, capability: tokenState.token });
await save(settings => ({ ...settings, tts: { enabled: true, provider: 'piper', language: 'es', voice: 'es_MX-ald-medium' }, playback: { ...settings.playback, target: 'browser' } }));
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } });
const readiness = browser.send('pet:ready', ready), acquisition = browser.send('pet:lease', { v: 1, action: 'acquire' });
assert.equal((await readiness).ok, true); const browserLeaseAck = await acquisition;
assert.equal(browserLeaseAck.ok, true, 'ready/acquire burst serializes'); browser.lease = browserLeaseAck.data;
await duplicateBrowser.send('pet:ready', ready);
assert.equal((await duplicateBrowser.send('pet:lease', { v: 1, action: 'acquire' })).error.code, 'lease_unavailable');
const browserRequest = await admitPetAction(action('Browser only'));
const browserPlay = await browser.event('pet:play', data => data.requestId === browserRequest.requestId);
await assertNoReplay(duplicateBrowser);
assert.equal((await browser.send('pet:playback', identityFor(browserPlay, 0))).ok, true);
await desktop.event('pet:request', data => data.request.requestId === browserRequest.requestId && data.request.status === 'playing');
await browser.send('pet:playback', identityFor(browserPlay, 1, 'ended'));
// Browser audio with a VTS appearance requires the selected controller throughout dispatch/playback.
await save(settings => ({ ...settings, appearance: { ...settings.appearance, kind: 'vts' }, playback: { ...settings.playback, vtsSessionId: desktopToken.session_id } }));
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } });
await acquire(browser);
await redis.set('pet:test:provider-mode', 'hold');
const losingVts = await admitPetAction(action('Lose VTS during generation'));
await until(() => PetRequest.findOne({ _id: losingVts.requestId, status: 'synthesizing' }).lean(), 'VTS-dependent provider phase');
await desktop.send('pet:ready', { ...ready, vtsReady: false });
await until(() => PetRequest.findOne({ _id: losingVts.requestId, status: 'cancelled', errorCode: 'vts_unavailable' }).lean(), 'VTS loss invalidates browser audio');
await redis.del('pet:test:provider-mode');
await assert.rejects(admitPetAction(action('Still no VTS')), /vts_unavailable/);
assert.equal((await separateProducer(action('Separate producer also sees lost VTS'))).error, 'vts_unavailable');
await desktop.send('pet:ready', ready);
const rotated = await call(`/pets/${owner}/overlay-token`, { method: 'POST', token: 'pet-owner-token', body: { rotate: true, version: tokenState.version } });
assert.equal(rotated.status, 200);
assert.equal((await call(`/pets/public/${tokenState.token}`)).status, 401);
assert.equal((await call(`/pets/${owner}/overlay-token`, { method: 'POST', token: 'pet-owner-token', body: { rotate: true, version: tokenState.version } })).status, 409);
await until(() => browser.ws.readyState !== WebSocket.OPEN, 'rotation disconnects old capability');
// Durable provider phase recovery terminates unknown outcomes without regeneration.
const fake = randomUUID();
const state = await runtimeFor(ownerId, owner);
await PetRequest.create({ _id: fake, ownerId, channelId: owner, operation: 'talk', text: 'Do not retry', origin: { kind: 'twitch-event', id: randomUUID(), occurredAt: new Date().toISOString() },
  actionKey: 'event:0', actor: { userId: owner, displayName: 'Fixture' }, payloadHash: 'test', admitted: true,
  generation: state.generation, settingsRevision: configuration.revision, status: 'synthesizing', version: 1,
  phaseDeadline: new Date(0), createdAt: new Date(), expiresAt: new Date(Date.now() + 86400_000) });
await PetRuntime.updateOne({ _id: ownerId }, { $set: { activeRequestId: fake } });
const recoveryCount = await redis.lLen('pet:test:provider-calls');
await notifyPet(ownerId);
await until(() => PetRequest.findOne({ _id: fake, status: 'expired', errorCode: 'provider_outcome_unknown' }).lean(), 'bounded recovery unknown outcome', 20_000);
assert.equal(await redis.lLen('pet:test:provider-calls'), recoveryCount);
// Revoked sessions disappear from the owner-only candidate set.
await OAuthSession.updateOne({ _id: secondToken.session_id }, { $set: { revoked_at: new Date() } });
assert.ok(!(await call(`/pets/${owner}/runtime`, { token: 'pet-owner-token' })).body.data.sessions.some(session => session.sessionId === secondToken.session_id));
clearInterval(renewal);
for (const ws of sockets) ws.close();
console.log('PASS pet runtime: exact Socket.IO contract, consent/owner isolation, readiness/telemetry bursts, sole lease, durable dedup/busy, private delivery, actual playback/terminal broadcast, no-tools AI/stable usage, verified-credit fallback, token rotation, unknown-outcome recovery and revocation.');
process.exit(0);
