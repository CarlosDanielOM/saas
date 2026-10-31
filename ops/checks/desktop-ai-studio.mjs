/** Exact API candidate, disposable Mongo/Redis, DIMA032 mailbox and mock TTS. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { ObjectId } = createRequire('/app/package.json')('mongodb');
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/);
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
assert.equal(process.env.DIMA032_SEED_STARTUP, 'false');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { PetRuntime, PetRequest } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
const mongo = await getMongoDBConnection('desktop-ai-studio-check'), db = mongo.connection.db;
const redis = await getDragonflyClient('desktop-ai-studio-check');
const base = 'http://127.0.0.1:3000', channel = '99003101', browserToken = 'pet-owner-token';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(20); }
  throw new Error(`Timeout: ${label}`);
}
async function request(path, { method = 'GET', body, token = browserToken } = {}) {
  const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: response.status === 302 ? null : JSON.parse(text) };
}
async function call(path, method = 'GET', body) {
  const result = await request(path, { method, body });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data;
}
async function command(kind, extra = {}) {
  const id = randomUUID();
  await redis.rPush('dima032:test:commands', JSON.stringify({ id, kind, channelId: channel, ...extra }));
  const raw = await until(() => redis.get(`dima032:test:reply:${id}`), `API mailbox ${kind}`);
  const answer = JSON.parse(raw); assert.notEqual(answer.pid, process.pid);
  assert.equal(answer.result?.fixtureError, undefined, JSON.stringify(answer)); return answer.result;
}
async function enqueue(text) { const result = await command('enqueue', { text }); assert.equal(result.error, false); return result.data.speechID; }
async function mintMonitor() {
  const verifier = randomBytes(32).toString('base64url');
  const start = await request('/oauth/authorize?' + new URLSearchParams({ client_id: 'dima-desktop', response_type: 'code',
    scope: 'profile:read desktop:connect', redirect_uri: 'http://127.0.0.1:42781/oauth/callback', state: verifier,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }), { token: null });
  assert.equal(start.status, 302);
  const requestId = new URL(start.headers.get('location')).searchParams.get('request');
  const decision = await request(`/oauth/requests/${requestId}/decision`, { method: 'POST', token: 'oauth-beta-browser-owner', body: { approve: true } });
  assert.equal(decision.status, 200);
  const result = await request('/oauth/token', { method: 'POST', token: null, body: { client_id: 'dima-desktop', grant_type: 'authorization_code',
    code: new URL(decision.body.redirect_uri).searchParams.get('code'), code_verifier: verifier,
    redirect_uri: 'http://127.0.0.1:42781/oauth/callback' } });
  assert.equal(result.status, 200); return result.body.access_token;
}
const sockets = [], clients = [];
async function connect(namespace, auth) {
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket'); sockets.push(ws);
  const events = [], acknowledgements = new Map(); let sequence = 0, socketId, failure;
  ws.on('message', raw => {
    const packet = raw.toString();
    if (packet === '2') return ws.send('3');
    if (packet.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify(auth)}`);
    if (packet.startsWith(`40${namespace},`)) socketId = JSON.parse(packet.slice(`40${namespace},`.length)).sid;
    if (packet.startsWith(`44${namespace},`)) failure = packet;
    if (packet.startsWith(`42${namespace},`)) {
      const rest = packet.slice(`42${namespace},`.length), bracket = rest.indexOf('[');
      const [event, data] = JSON.parse(rest.slice(bracket)); events.push({ event, data, ackId: rest.slice(0, bracket), at: Date.now() });
    }
    if (packet.startsWith(`43${namespace},`)) {
      const rest = packet.slice(`43${namespace},`.length), bracket = rest.indexOf('['), id = Number(rest.slice(0, bracket));
      acknowledgements.get(id)?.(JSON.parse(rest.slice(bracket))[0]); acknowledgements.delete(id);
    }
  });
  await until(() => socketId || failure, `${namespace} join`); assert.ok(!failure, failure);
  const client = { ws, events, namespace, auth, get socketId() { return socketId; }, lease: null,
    emit(event, data) { ws.send(`42${namespace},${JSON.stringify([event, data])}`); },
    send(event, data) { const id = ++sequence; return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { acknowledgements.delete(id); reject(new Error(`ACK ${event}`)); }, 5000);
      acknowledgements.set(id, value => { clearTimeout(timer); resolve(value); });
      ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`);
    }); },
    event(event, predicate = () => true, timeout = 15_000) {
      return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event, timeout);
    },
    acknowledge(playbackId) {
      const item = events.find(value => value.event === 'speech:prepare' && value.data.playback_id === playbackId);
      assert.ok(item?.ackId); ws.send(`43${namespace},${item.ackId}${JSON.stringify([{ v: 1, paused: true,
        playback_id: playbackId, output_generation: item.data.output_generation }])}`);
    } };
  clients.push(client); return client;
}
const inserted = await db.collection('users').insertOne({ name: 'Studio fixture', plan_tier: 'premium',
  accounts: [{ type: 'twitch', id: channel, name: 'studio_fixture' }] });
const ownerId = String(inserted.insertedId), asset = new ObjectId();
await redis.hSet(`token:${browserToken}`, { id: channel, login: 'studio_fixture', display_name: 'Fixture' });
await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
  used: 0, limit: 100, balance: 100, available: true, status: 'available', updatedAt: new Date().toISOString() }));
await db.collection('asset_libraries').insertOne({ _id: channel, usedBytes: 1, assets: [{ id: String(asset),
  kind: 'image', mime: 'image/gif', state: 'ready', name: 'mock.gif', bytes: 1, width: 1, height: 1, createdAt: new Date().toISOString() }] });
let config = await call(`/pets/${channel}/settings`);
async function save(change) { config = await call(`/pets/${channel}/settings`, 'PUT', { revision: config.revision, settings: change(config.settings) }); }
await save(settings => ({ ...settings, enabled: true, sources: { independent: false, readTts: true }, ttsAudio: 'pet',
  tts: { ...settings.tts, enabled: false }, appearance: { kind: 'png', idleAssetId: String(asset), talkingAssetId: String(asset) } }));
const capability = (await call(`/pets/${channel}/overlay-token`, 'POST', {})).token;
const pet = await connect('/pet', { v: 1, capability }); await pet.event('pet:snapshot');
assert.equal((await pet.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: false })).ok, true);
async function acquirePet() {
  pet.lease = await until(async () => { const result = await pet.send('pet:lease', { v: 1, action: 'acquire' });
    return result.ok ? result.data : null; }, 'Pet lease', 20_000);
}
await acquirePet();
let renewing = false;
const renewal = setInterval(() => {
  if (!pet.lease || renewing || pet.ws.readyState !== WebSocket.OPEN) return;
  renewing = true;
  void pet.send('pet:lease', { v: 1, action: 'renew', leaseId: pet.lease.leaseId, generation: pet.lease.generation })
    .then(result => { if (result.ok) pet.lease = result.data; }).finally(() => { renewing = false; });
}, 5000); renewal.unref();
let studio = await call(`/overlay-studio/${channel}`);
const template = studio.scenes[0], ttsWidget = template.widgets.find(widget => widget.kind === 'tts');
studio.scenes = ['a', 'b'].map(id => ({ ...structuredClone(template), id, name: id, widgets: [ttsWidget] }));
studio = await call(`/overlay-studio/${channel}`, 'PUT', studio);
for (const scene of studio.scenes) studio = await call(`/overlay-studio/${channel}/scenes/${scene.id}/publish`, 'POST', { revision: studio.revision });
const clientId = 'desktop-studio-test-client', sources = [];
for (const scene of studio.scenes) {
  const client = await connect(`/overlay-studio/${scene.publicId}`, { clientId }); await client.event('overlay-state');
  sources.push({ scene, client });
}
const legacy = await connect(`/speech/${channel}`, {});
await until(() => legacy.events.some(item => item.event === 'speech-reset'), 'legacy audio player ready');
const monitor = await connect('/desktop-ai', { v: 1, accessToken: await mintMonitor() }); await monitor.event('speech:snapshot');
const providerCount = () => redis.lLen('pet:test:provider-calls');
const idle = () => until(async () => !await redis.get(`twitch:${channel}:tts:processing`), 'queue idle');
const deliver = async speechID => Promise.all(sources.map(async source => ({ ...source,
  event: await source.client.event('overlay-event', event => event.tts?.speechID === speechID) })));
const postEnded = (source, speechID) => source.client.emit('overlay-speech-ended', { eventId: source.event.id, speechID, reason: 'ended' });
try {
  // Pet Read-TTS is the only audible player; Studio receives caption-only events.
  const firstCount = await providerCount(), petSpeech = await enqueue('Pet reads this normal TTS once');
  const firstPrepare = await monitor.event('speech:prepare', value => value.playback_id === petSpeech);
  assert.equal(firstPrepare.source, 'tts');
  assert.ok(!pet.events.some(item => item.event === 'pet:play'));
  assert.ok(!legacy.events.some(item => item.event === 'speech' && item.data.speechID === petSpeech));
  assert.ok(sources.every(source => !source.client.events.some(item => item.event === 'overlay-event' && item.data.tts?.speechID === petSpeech)));
  monitor.acknowledge(petSpeech);
  const petRequest = await until(() => PetRequest.findOne({ 'origin.kind': 'tts-queue', 'origin.id': petSpeech,
    status: { $in: ['ready', 'playing'] } }).lean(), 'read-TTS request');
  const play = await pet.event('pet:play', item => item.requestId === petRequest._id);
  const captions = await deliver(petSpeech);
  assert.ok(captions.every(source => !source.event.tts.ownerClientId && !source.event.media));
  assert.ok(!legacy.events.some(item => item.event === 'speech' && item.data.speechID === petSpeech));
  const audioURL = new URL(play.audio.url), audio = await fetch(base + audioURL.pathname + audioURL.search);
  assert.equal(audio.status, 200); assert.ok((await audio.arrayBuffer()).byteLength > 44);
  const report = (seq, phase) => ({ v: 1, requestId: play.requestId, leaseId: play.leaseId, generation: play.generation,
    seq, phase, positionMs: phase === 'ended' ? 500 : 0 });
  assert.equal((await pet.send('pet:playback', report(0, 'started'))).ok, true);
  assert.equal((await pet.send('pet:playback', report(1, 'ended'))).ok, true);
  await monitor.event('speech:ended', value => value.playback_id === petSpeech); await idle();
  assert.equal(await providerCount(), firstCount + 1, 'read-TTS synthesizes only once');
  assert.equal(pet.events.filter(item => item.event === 'pet:play' && item.data.requestId === play.requestId).length, 1);

  // The earlier player actually ended; reset only the disposable handover wait.
  pet.lease = null; legacy.ws.close();
  await save(settings => ({ ...settings, ttsAudio: 'overlay' }));
  await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } }); await acquirePet();
  const studioCount = await providerCount(), studioSpeech = await enqueue('Studio speaks to one player');
  await monitor.event('speech:prepare', value => value.playback_id === studioSpeech);
  assert.ok(sources.every(source => !source.client.events.some(item => item.event === 'overlay-event' && item.data.tts?.speechID === studioSpeech)),
    'Studio does not receive audio before microphone ACK');
  monitor.acknowledge(studioSpeech);
  const delivery = await deliver(studioSpeech), elected = delivery.find(source => source.event.tts.ownerClientId);
  const caption = delivery.find(source => !source.event.tts.ownerClientId);
  assert.ok(elected && caption); assert.equal(caption.event.media, undefined);
  const eventPath = source => `/overlay-studio/public/${source.scene.publicId}/events/${source.event.id}?` +
    new URLSearchParams({ clientId, socketId: source.client.socketId });
  const ownerView = await call(eventPath(elected)), captionView = await call(eventPath(caption));
  assert.ok(ownerView.media?.url); assert.equal(captionView.media, undefined);
  assert.equal((await fetch(base + ownerView.media.url.replace(elected.scene.publicId, caption.scene.publicId))).status, 404);
  const media = await fetch(base + ownerView.media.url); assert.equal(media.status, 200); assert.ok((await media.arrayBuffer()).byteLength > 44);
  assert.ok(!pet.events.some(item => item.event === 'pet:play' && item.data.requestId !== play.requestId), 'Pet does not play Studio audio again');
  caption.client.emit('overlay-speech-ended', { eventId: caption.event.id, speechID: studioSpeech, reason: 'ended' });
  await pause(100); assert.ok(!monitor.events.some(item => item.event === 'speech:ended' && item.data.playback_id === studioSpeech));
  elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID: studioSpeech, phase: 'playing', position: 0 });
  await pet.event('pet:follow', value => value.followId === studioSpeech);
  postEnded(elected, studioSpeech); await monitor.event('speech:ended', value => value.playback_id === studioSpeech); await idle();
  assert.equal(await providerCount(), studioCount + 1, 'Studio synthesizes only once');

  // Skip is a stop request, not proof of silence. Another Studio recipient
  // cannot release the slot; the elected player's real late stop report can.
  const skippedSpeech = await enqueue('Studio output to skip');
  await monitor.event('speech:prepare', value => value.playback_id === skippedSpeech); monitor.acknowledge(skippedSpeech);
  const skippedDelivery = await deliver(skippedSpeech), skippedOwner = skippedDelivery.find(source => source.event.tts.ownerClientId);
  const wrongRecipient = skippedDelivery.find(source => !source.event.tts.ownerClientId);
  assert.ok(skippedOwner && wrongRecipient);
  await command('control', { action: 'skip' });
  const retired = await until(async () => { const value = await redis.get(`desktop:speech:slot:${channel}`);
    if (!value) return null; const slot = JSON.parse(value); return slot.playbackId === skippedSpeech && slot.retiredProof ? slot : null; }, 'retired Studio output');
  assert.equal(retired.retiredProof.kind, 'tts');
  assert.equal(retired.retiredProof.source, `studio:${skippedOwner.client.socketId}`,
    'elected Studio socket is recorded before its first progress report');
  postEnded(wrongRecipient, skippedSpeech); await pause(100);
  assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${channel}`)).playbackId, skippedSpeech);
  assert.ok(!monitor.events.some(item => item.event === 'speech:ended' && item.data.playback_id === skippedSpeech));
  const following = await enqueue('Studio output after actual stop'); await pause(200);
  assert.ok(sources.every(source => !source.client.events.some(item => item.event === 'overlay-event' && item.data.tts?.speechID === following)));
  postEnded(skippedOwner, skippedSpeech);
  const stopped = await monitor.event('speech:ended', value => value.playback_id === skippedSpeech); assert.equal(stopped.reason, 'stopped');
  await monitor.event('speech:prepare', value => value.playback_id === following); monitor.acknowledge(following);
  const followingDelivery = await deliver(following), followingOwner = followingDelivery.find(source => source.event.tts.ownerClientId);
  assert.ok(followingOwner); postEnded(followingOwner, following);
  await monitor.event('speech:ended', value => value.playback_id === following); await idle();

  // Existing long normal TTS must retain its full audio and a matching output
  // deadline; no short desktop-reply proposal limits this shared queue.
  await redis.set('dima032:test:long-audio', 'true');
  const longCount = await providerCount(), longSpeech = await enqueue('Long normal TTS remains whole');
  const longPrepare = await monitor.event('speech:prepare', value => value.playback_id === longSpeech, 25_000);
  await redis.del('dima032:test:long-audio');
  assert.ok(longPrepare.expires_at - longPrepare.server_time >= 480_000, 'full 300-second audio keeps its protected output deadline');
  monitor.acknowledge(longSpeech);
  const longDelivery = await deliver(longSpeech), longOwner = longDelivery.find(source => source.event.tts.ownerClientId);
  assert.ok(longOwner);
  const longView = await call(eventPath(longOwner));
  const longResponse = await fetch(base + longView.media.url); assert.equal(longResponse.status, 200);
  const longAudio = Buffer.from(await longResponse.arrayBuffer());
  assert.equal(longAudio.length, 9_600_044); assert.equal(longAudio.readUInt32LE(40) / longAudio.readUInt32LE(28), 300);
  assert.equal(await providerCount(), longCount + 1);
  postEnded(longOwner, longSpeech); await monitor.event('speech:ended', value => value.playback_id === longSpeech); await idle();
  console.log('PASS desktop AI Studio: Pet Read-TTS one-owner and no duplicate, delayed microphone ACK, two Studio scenes/one media owner, authenticated media, Pet follow, wrong-recipient terminal, skip retention and elected-player late stop, full 300-second audio deadline');
} finally {
  clearInterval(renewal); for (const socket of sockets) socket.close();
  await mongo.connection.close(); redis.destroy();
}
process.exit(0);
