/**
 * Exact-candidate API check for pet queues. Disposable Mongo/Redis plus staged
 * pet-runtime-fixtures only (mock Piper/OpenRouter/Polar).
 *
 * - $(pet.talk) waits in the normal TTS queue: TTS, TTS, pet.talk, TTS play in that order.
 * - TTS skip during a pet turn stops the pet and continues with the next message.
 * - $(pet.ask) in the pet's own queue waits instead of failing busy, respects the
 *   cooldown between replies, keeps FIFO order and rejects past the queue size.
 * - $(pet.ask) set to the TTS queue keeps its place among TTS messages.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { GridFSBucket, ObjectId } = createRequire('/app/package.json')('mongodb');
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/, 'disposable database required');
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const mongo = await getMongoDBConnection('pet-queue-check');
const redis = await getDragonflyClient('pet-queue-check');
const { PetRequest, PetRuntime } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { admitPetAction } = await import('/app/dist/pets/admission.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
const owner = '99003101', base = 'http://127.0.0.1:3000', token = 'pet-owner-token';
const inserted = await mongo.connection.db.collection('users').insertOne(
  { name: 'Pet owner', plan_tier: 'premium', polar_sh_customer_id: 'pet-test-customer', accounts: [{ type: 'twitch', id: owner, name: 'pet_owner' }] });
const ownerId = String(inserted.insertedId);
await redis.hSet(`token:${token}`, { id: owner, login: owner, display_name: 'Pet fixture' });
await redis.set(`twitch:${owner}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION, used: 0, limit: 100, balance: 100,
  available: true, status: 'available', updatedAt: new Date().toISOString() }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(25); }
  throw new Error(`Timed out: ${message}`);
}
async function call(path, { method = 'GET', body, auth = true } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const sockets = [];
async function connect(namespace, auth) {
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket'); sockets.push(ws);
  const events = [], acks = new Map(); let sequence = 0, joined = false, failure;
  ws.on('message', raw => {
    const message = raw.toString();
    if (message === '2') return ws.send('3');
    if (message.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify(auth)}`);
    if (message.startsWith(`40${namespace},`)) joined = true;
    if (message.startsWith(`44${namespace},`)) failure = message;
    if (message.startsWith(`42${namespace},`)) { const [event, data] = JSON.parse(message.slice(`42${namespace},`.length)); events.push({ event, data, at: Date.now() }); }
    if (message.startsWith(`43${namespace},`)) {
      const rest = message.slice(`43${namespace},`.length), bracket = rest.indexOf('[');
      acks.get(Number(rest.slice(0, bracket)))?.(JSON.parse(rest.slice(bracket))[0]); acks.delete(Number(rest.slice(0, bracket)));
    }
  });
  await once(ws, 'open');
  await until(() => failure || joined, `${namespace} join`);
  assert.ok(!failure, failure);
  return { ws, events,
    send(event, data) { const id = ++sequence; return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { acks.delete(id); reject(new Error(`Missing ack ${event}`)); }, 5000);
      acks.set(id, value => { clearTimeout(timer); resolve(value); }); ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`);
    }); },
    emit(event, data) { ws.send(`42${namespace},${JSON.stringify([event, data])}`); },
    event(event, predicate = () => true, timeout) { return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event, timeout); } };
}
// Private PNG appearance for a browser-source pet.
const assetId = new ObjectId();
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const upload = new GridFSBucket(mongo.connection.db, { bucketName: 'private_assets' }).openUploadStreamWithId(assetId, 'pet.gif', { metadata: { owner, mime: 'image/gif' } });
const stored = once(upload, 'finish'); upload.end(gif); await stored;
await mongo.connection.db.collection('asset_libraries').insertOne({ _id: owner, usedBytes: gif.length,
  assets: [{ id: String(assetId), name: 'pet.gif', kind: 'image', mime: 'image/gif', bytes: gif.length, width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }] });

// Settings: new queue fields round-trip, are validated, and default for older saved shapes.
const settingsPath = `/pets/${owner}/settings`;
let configuration = (await call(settingsPath)).body.data;
assert.equal(configuration.settings.behavior.queueSize, 5);
assert.equal(configuration.settings.behavior.askLane, 'independent');
const put = settings => call(settingsPath, { method: 'PUT', body: { revision: configuration.revision, settings } });
for (const behavior of [{ queueSize: 0 }, { queueSize: 11 }, { queueSize: 2.5 }, { askLane: 'later' }]) {
  const bad = await put({ ...configuration.settings, behavior: { ...configuration.settings.behavior, ...behavior } });
  assert.equal(bad.status, 400, `rejects ${JSON.stringify(behavior)}`);
}
const legacyBehavior = { ...configuration.settings.behavior }; delete legacyBehavior.queueSize; delete legacyBehavior.askLane;
let saved = await put({ ...configuration.settings, appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) }, enabled: true, behavior: legacyBehavior });
assert.equal(saved.status, 200, JSON.stringify(saved.body)); configuration = saved.body.data;
assert.deepEqual([configuration.settings.behavior.queueSize, configuration.settings.behavior.askLane], [5, 'independent'], 'older dashboard saves keep defaults');

// One browser-source pet player and one legacy speech overlay.
const capability = (await call(`/pets/${owner}/overlay-token`, { method: 'POST', body: {} })).body.data.token;
const pet = await connect('/pet', { v: 1, capability });
await pet.event('pet:snapshot');
assert.equal((await pet.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: false })).ok, true);
let lease = null;
async function acquire() {
  await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } }); // Skip the 15 s handover barrier in disposable Mongo.
  const ack = await until(async () => { const value = await pet.send('pet:lease', { v: 1, action: 'acquire' }); return value.ok ? value : null; }, 'pet lease');
  lease = ack.data;
}
const renew = setInterval(() => { if (lease) void pet.send('pet:lease', { v: 1, action: 'renew', leaseId: lease.leaseId, generation: lease.generation })
  .then(ack => { if (ack.ok) lease = ack.data; }).catch(() => {}); }, 4000); renew.unref();
async function save(change) {
  const result = await put(change(configuration.settings));
  assert.equal(result.status, 200, JSON.stringify(result.body)); configuration = result.body.data;
  await acquire(); // Saving invalidates the lease like any settings change.
}
await acquire();
const speech = await connect(`/speech/${owner}`, {});
await speech.event('speech-reset');
const tts = async text => { const result = await call(`/speech/${owner}`, { method: 'POST', auth: false, body: { text } }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data.speechID; };
const action = (text, operation = 'talk') => ({ channelId: owner, operation, text,
  origin: { kind: 'chat-command', id: randomUUID(), occurredAt: new Date().toISOString() }, actionKey: 'command:pet:0', actor: { userId: owner, displayName: 'Fixture' } });
const timeline = [];
const seen = new Set();
const record = () => {
  for (const item of speech.events) if (item.event === 'speech' && !seen.has(`s:${item.data.speechID}`)) { seen.add(`s:${item.data.speechID}`); timeline.push(`tts:${item.data.speechID}`); }
  for (const item of pet.events) if (item.event === 'pet:play' && !seen.has(`p:${item.data.requestId}`)) { seen.add(`p:${item.data.requestId}`); timeline.push(`pet:${item.data.requestId}`); }
  return timeline;
};
const playOf = requestId => pet.event('pet:play', data => data.requestId === requestId, 20_000);
async function finishPet(play) {
  const id = phase => ({ v: 1, requestId: play.requestId, leaseId: play.leaseId, generation: play.generation, seq: phase === 'ended' ? 1 : 0, phase, positionMs: phase === 'ended' ? 500 : 0 });
  assert.equal((await pet.send('pet:playback', id('started'))).ok, true);
  assert.equal((await pet.send('pet:playback', id('ended'))).ok, true);
  await until(() => PetRequest.findOne({ _id: play.requestId, status: 'completed' }).lean(), 'pet request completes');
}
const endSpeech = speechID => speech.emit('speech-ended', { speechID, reason: 'ended' });
const steady = async expected => { await pause(400); assert.deepEqual(record(), expected); };

// 1) TTS, TTS, pet.talk, TTS keep their arrival order; the pet holds the queue while it talks.
await save(settings => ({ ...settings, behavior: { ...settings.behavior, cooldownSeconds: 0 } }));
const a = await tts('first message'), b = await tts('second message');
const talk = await admitPetAction(action('Pet says hi in order'));
assert.equal(talk.status, 'queued');
const talkRow = await PetRequest.findById(talk.requestId).lean();
assert.equal(talkRow.lane, 'tts'); assert.ok(await redis.exists(`twitch:${owner}:tts:queue:data:${talkRow.ttsSpeechId}`), 'pet.talk is a TTS queue item');
const c = await tts('third message');
await until(() => record().length === 1, 'A dispatched'); await steady([`tts:${a}`]);
endSpeech(a); await until(() => record().length === 2, 'B dispatched'); await steady([`tts:${a}`, `tts:${b}`]);
endSpeech(b);
const talkPlay = await playOf(talk.requestId);
await steady([`tts:${a}`, `tts:${b}`, `pet:${talk.requestId}`]);
const status = await call(`/speech/${owner}/status`);
assert.equal(status.body.data.queueLength, 1, 'C still waits behind the pet');
await finishPet(talkPlay);
await until(() => record().length === 4, 'C dispatched after the pet');
assert.deepEqual(record(), [`tts:${a}`, `tts:${b}`, `pet:${talk.requestId}`, `tts:${c}`]);
endSpeech(c); await pause(200);

// 2) Skip during a pet turn stops the pet and moves on to the next TTS message.
const skipped = await admitPetAction(action('Skip me'));
const d = await tts('after the skip');
await playOf(skipped.requestId);
assert.equal((await call(`/speech/${owner}/control`, { method: 'POST', body: { action: 'skip' } })).status, 200);
await until(() => PetRequest.findOne({ _id: skipped.requestId, status: 'cancelled' }).lean(), 'skip cancels the pet request');
await until(() => record().includes(`tts:${d}`), 'D dispatched after skip');
endSpeech(d); await pause(200);
await acquire(); // Cancelling the active pet request ends its lease, like a dashboard cancel.

// 3) pet.ask in the pet's own queue: waits instead of busy, FIFO, cooldown spacing, queue size.
await save(settings => ({ ...settings, behavior: { ...settings.behavior, cooldownSeconds: 2, queueSize: 2, askLane: 'independent' } }));
const first = await admitPetAction(action('Ask one', 'ask'));
assert.equal(first.status, 'queued');
const firstPlay = await playOf(first.requestId);
const second = await admitPetAction(action('Ask two', 'ask')), third = await admitPetAction(action('Ask three', 'ask'));
assert.deepEqual([second.status, third.status], ['queued', 'queued'], 'busy pet queues instead of failing');
await assert.rejects(admitPetAction(action('Ask four', 'ask')), /queue_full/);
assert.equal((await PetRequest.findById(first.requestId).lean()).lane, 'independent');
await finishPet(firstPlay);
const firstAccepted = (await PetRuntime.findById(ownerId).lean()).lastAcceptedAt;
const secondPlay = await playOf(second.requestId);
const secondAccepted = (await PetRuntime.findById(ownerId).lean()).lastAcceptedAt;
assert.ok(secondAccepted - firstAccepted >= 2000, `cooldown spaces queued replies (${secondAccepted - firstAccepted} ms)`);
assert.equal((await PetRequest.findById(third.requestId).lean()).status, 'queued', 'third waits its turn');
await finishPet(secondPlay);
await finishPet(await playOf(third.requestId));
const asks = record().filter(item => [first, second, third].some(request => item === `pet:${request.requestId}`));
assert.deepEqual(asks, [first, second, third].map(request => `pet:${request.requestId}`), 'FIFO');
// The pet's own queue never holds up normal TTS.
const e = await tts('independent of pet asks');
await until(() => record().includes(`tts:${e}`), 'normal TTS dispatches'); endSpeech(e); await pause(200);

// 4) pet.ask set to the TTS queue keeps its place among TTS messages.
await save(settings => ({ ...settings, behavior: { ...settings.behavior, cooldownSeconds: 0, askLane: 'tts' } }));
const f = await tts('before the ask');
const sharedAsk = await admitPetAction(action('Ask in the TTS queue', 'ask'));
assert.equal((await PetRequest.findById(sharedAsk.requestId).lean()).lane, 'tts');
const g = await tts('after the ask');
await until(() => record().includes(`tts:${f}`), 'F dispatched'); await pause(300);
assert.ok(!record().includes(`pet:${sharedAsk.requestId}`), 'the ask waits for F');
endSpeech(f);
const sharedPlay = await playOf(sharedAsk.requestId);
await pause(300); assert.ok(!record().includes(`tts:${g}`), 'G waits for the ask');
await finishPet(sharedPlay);
await until(() => record().includes(`tts:${g}`), 'G dispatched after the ask');
const tail = record().slice(-3);
assert.deepEqual(tail, [`tts:${f}`, `pet:${sharedAsk.requestId}`, `tts:${g}`]);
endSpeech(g);
const llmCalls = (await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'llm');
assert.equal(llmCalls.length, 4, 'one LLM call per pet.ask, none for pet.talk');

// Released desktop/browser players reject unknown statuses: queued is never on the wire.
const statuses = pet.events.flatMap(item => [item.data?.active?.status, item.data?.request?.status, item.data?.terminal?.request?.status]).filter(Boolean);
assert.ok(statuses.length > 0 && !statuses.includes('queued'), `wire statuses: ${[...new Set(statuses)]}`);
clearInterval(renew);
for (const ws of sockets) ws.close();
console.log('PASS pet queue: pet.talk keeps TTS order (TTS, TTS, pet.talk, TTS), TTS skip stops the pet, independent pet.ask queue waits/FIFO/cooldown/size, TTS-lane pet.ask order, queue settings validation/defaults.');
process.exit(0);
