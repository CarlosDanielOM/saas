/** Exact API candidate: disposable Mongo/Redis, actual API singleton and dummy providers only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { ObjectId } = createRequire('/app/package.json')('mongodb');
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/);
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { PetRuntime, PetRequest } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { admitPetAction } = await import('/app/dist/pets/admission.js');
const mongo = await getMongoDBConnection('dima032-check'), db = mongo.connection.db;
const redis = await getDragonflyClient('dima032-check'), base = 'http://127.0.0.1:3000', channel = '99003101', token = 'pet-owner-token';
const sockets = [], clients = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(25); } throw new Error(`Timeout: ${label}`); }
async function call(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json(); assert.equal(response.status, 200, JSON.stringify(envelope)); return envelope.data;
}
async function command(kind, extra = {}) {
    const id = randomUUID(); await redis.rPush('dima032:test:commands', JSON.stringify({ id, kind, channelId: channel, ...extra }));
    const raw = await until(() => redis.get(`dima032:test:reply:${id}`), `API fixture ${kind}`); const result = JSON.parse(raw);
    assert.notEqual(result.pid, process.pid, 'mailbox runs actual API singleton, not check-process copy');
    assert.equal(result.result?.fixtureError, undefined, JSON.stringify(result)); return result.result;
}
async function enqueue(text) { const result = await command('enqueue', { text }); assert.equal(result.error, false, JSON.stringify(result)); return result.data.speechID; }
async function connect(namespace, auth, first) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/socket.io/?EIO=4&transport=websocket'); sockets.push(ws);
    const events = [], acks = new Map(); let sequence = 0, socketId;
    ws.on('message', raw => {
        const packet = raw.toString();
        if (packet === '2') return ws.send('3');
        if (packet.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify(auth)}`);
        if (packet.startsWith(`40${namespace},`)) socketId = JSON.parse(packet.slice(`40${namespace},`.length)).sid;
        if (packet.startsWith(`44${namespace},`)) throw new Error(packet);
        if (packet.startsWith(`42${namespace},`)) { const [event, data] = JSON.parse(packet.slice(`42${namespace},`.length)); events.push({ event, data }); }
        if (packet.startsWith(`43${namespace},`)) { const rest = packet.slice(`43${namespace},`.length), bracket = rest.indexOf('['); acks.get(Number(rest.slice(0, bracket)))?.(JSON.parse(rest.slice(bracket))[0]); }
    });
    const client = { ws, auth, namespace, events, get socketId() { return socketId; }, lease: null,
        emit(event, data) { ws.send(`42${namespace},${JSON.stringify([event, data])}`); },
        send(event, data) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`ACK ${event}`)), 5000); acks.set(id, value => { clearTimeout(timer); acks.delete(id); resolve(value); }); ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`); }); },
        event(event, predicate = () => true) { return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event); }
    };
    await until(() => socketId, 'namespace join'); if (first) await client.event(first); clients.push(client); return client;
}
const renew = setInterval(() => { for (const client of clients) if (client.lease && !client.renewing && client.ws.readyState === WebSocket.OPEN) {
    client.renewing = true; void client.send('pet:lease', { v: 1, action: 'renew', leaseId: client.lease.leaseId, generation: client.lease.generation }).then(ack => { client.lease = ack.ok ? ack.data : null; }).finally(() => { client.renewing = false; });
} }, 5000); renew.unref();
const inserted = await db.collection('users').insertOne({ name: 'DIMA032 disposable', plan_tier: 'premium', accounts: [{ type: 'twitch', id: channel, name: 'dima032_fixture' }] });
const ownerId = String(inserted.insertedId), asset = new ObjectId();
await redis.hSet(`token:${token}`, { id: channel, login: 'dima032_fixture', display_name: 'Fixture' });
await db.collection('asset_libraries').insertOne({ _id: channel, usedBytes: 1, assets: [{ id: String(asset), kind: 'image', mime: 'image/gif', state: 'ready', name: 'mock.gif', bytes: 1, width: 1, height: 1, createdAt: new Date().toISOString() }] });
let config = await call(`/pets/${channel}/settings`); assert.equal(config.schemaVersion, 3);
assert.deepEqual(config.settings.sources, { independent: true, readTts: false }); assert.equal(config.settings.ttsAudio, 'pet');
async function save(change) { config = await call(`/pets/${channel}/settings`, 'PUT', { revision: config.revision, settings: change(config.settings) }); return config; }
await save(settings => ({ ...settings, enabled: true, sources: { independent: false, readTts: true },
    tts: { ...settings.tts, enabled: false }, appearance: { kind: 'png', idleAssetId: String(asset), talkingAssetId: String(asset) }, behavior: { ...settings.behavior, cooldownSeconds: 0 } }));
const capability = (await call(`/pets/${channel}/overlay-token`, 'POST', {})).token;
async function readyPet() {
    const pet = await connect('/pet', { v: 1, capability }, 'pet:snapshot');
    assert.equal((await pet.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: false })).ok, true);
    pet.lease = await until(async () => { const ack = await pet.send('pet:lease', { v: 1, action: 'acquire' }); return ack.ok ? ack.data : null; }, 'PNG lease', 20000); return pet;
}
const playback = (pet, play, seq, phase) => pet.send('pet:playback', { v: 1, requestId: play.requestId, leaseId: play.leaseId, generation: play.generation, seq, phase, positionMs: phase === 'ended' ? 500 : 0 });
const idle = () => until(async () => !await redis.get(`twitch:${channel}:tts:processing`), 'normal queue release');
const providerCount = () => redis.lLen('pet:test:provider-calls');
const usageCharacters = async () => Number(await redis.hGet(`${channel}:tts:usage`, 'total_characters') || 0);
const localAudio = url => base + new URL(url).pathname + new URL(url).search;
try {
    let pet = await readyPet();
    const before = await providerCount(), chars = await usageCharacters(), text = 'Normal queue uses existing synthesis once';
    const speech = await enqueue(text), play = await pet.event('pet:play');
    assert.equal((await PetRequest.findById(play.requestId).lean()).origin.id, speech);
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), speech, 'pet-only PNG admission reaches normal TTS with no desktop/overlay');
    const audio = await fetch(localAudio(play.audio.url)); assert.equal(audio.status, 200); const bytes = Buffer.from(await audio.arrayBuffer()); assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal((await playback(pet, play, 0, 'started')).ok, true); assert.equal((await playback(pet, play, 1, 'ended')).ok, true); await idle();
    assert.equal(await providerCount(), before + 1); assert.equal(await usageCharacters(), chars + text.length); assert.equal(await redis.lLen('pet:test:billing-events'), 0, 'free fixture adds no duplicate paid debit');
    const legacy = await connect(`/speech/${channel}`, {}, 'speech-reset');
    for (const fetchTicket of [false, true]) {
        const mark = legacy.events.length, count = await providerCount(); const id = await enqueue(`Lost started ACK fetch=${fetchTicket}`);
        const p = await pet.event('pet:play', data => data.requestId !== play.requestId && !pet.events.some(item => item.event === 'tested-play' && item.data === data.requestId));
        pet.events.push({ event: 'tested-play', data: p.requestId });
        if (fetchTicket) { const response = await fetch(localAudio(p.audio.url)); assert.equal(response.status, 200); await response.arrayBuffer(); assert.equal((await PetRequest.findById(p.requestId).lean()).audioFetched, true); }
        pet.ws.close(); await idle(); await pause(150);
        assert.equal(legacy.events.slice(mark).some(event => event.event === 'speech' && event.data.speechID === id), false, 'uncertain play never falls back');
        assert.equal(await providerCount(), count + 1);
        assert.notEqual((await PetRequest.findById(p.requestId).lean()).status, 'ready');
        pet = await readyPet(); assert.equal(pet.events.some(event => event.event === 'pet:play'), false, 'fresh namespace snapshot cannot replay');
    }
    // True pre-delivery unavailable player: same generated bytes go to elected legacy once.
    await pet.send('pet:ready', { v: 1, audioReady: false, renderReady: true, vtsReady: false });
    const count = await providerCount(), id = await enqueue('Same-file fallback');
    const fallback = await legacy.event('speech', data => data.speechID === id);
    const fallbackBytes = Buffer.from(await (await fetch(localAudio(fallback.audioUrl))).arrayBuffer()); assert.deepEqual(fallbackBytes, bytes);
    assert.equal(await providerCount(), count + 1); legacy.emit('speech-ended', { speechID: id, reason: 'ended' }); await idle();
    // Real independent producer holds its Mongo request; pending normal TTS must reserve before waiting.
    await save(settings => ({ ...settings, sources: { independent: true, readTts: true }, tts: { ...settings.tts, enabled: true } }));
    pet.ws.close(); pet = await readyPet();
    const action = suffix => ({ channelId: channel, operation: 'talk', text: `Independent ${suffix}`, origin: { kind: 'chat-command', id: randomUUID(), occurredAt: new Date().toISOString() }, actionKey: 'dima032', actor: { userId: channel, displayName: 'Fixture' } });
    const admitted = await admitPetAction(action('first')); const independentPlay = await pet.event('pet:play', data => data.requestId === admitted.requestId);
    const waiting = await enqueue('Wait for independent pet');
    await until(async () => (await PetRuntime.findById(ownerId).lean()).ttsReservation?.speechId === waiting, 'shared pending turn');
    const contenders = await Promise.allSettled([admitPetAction(action('concurrent-a')), admitPetAction(action('concurrent-b'))]);
    assert.ok(contenders.every(result => result.status === 'rejected' && result.reason.code === 'busy'));
    await playback(pet, independentPlay, 0, 'started'); await playback(pet, independentPlay, 1, 'ended');
    const handoff = await pet.event('pet:play', data => data.requestId !== admitted.requestId);
    await command('control', { action: 'skip' }); await idle(); assert.ok(pet.events.some(event => event.event === 'pet:stop' && event.data.requestId === handoff.requestId));
    // Studio-only audio; two scenes deliberately reuse clientId, one exact recipient owns media.
    legacy.ws.close(); await save(settings => ({ ...settings, ttsAudio: 'overlay' }));
    let studio = await call(`/overlay-studio/${channel}`); const original = studio.scenes[0], tts = original.widgets.find(widget => widget.kind === 'tts');
    studio.scenes = ['a', 'b'].map(id => ({ ...structuredClone(original), id, name: id, widgets: [tts] }));
    studio = await call(`/overlay-studio/${channel}`, 'PUT', studio);
    for (const scene of studio.scenes) studio = await call(`/overlay-studio/${channel}/scenes/${scene.id}/publish`, 'POST', { revision: studio.revision });
    const clientId = 'dima032-shared-client-id'; const sources = [];
    for (const scene of studio.scenes) sources.push({ scene, client: await connect(`/overlay-studio/${scene.publicId}`, { clientId }, 'overlay-state') });
    const studioSpeech = await enqueue('Studio owns normal queue and silent follow');
    const deliveries = await Promise.all(sources.map(async source => ({ ...source, event: await source.client.event('overlay-event', event => event.tts?.speechID === studioSpeech) })));
    const elected = deliveries.find(source => source.event.tts.ownerClientId), caption = deliveries.find(source => !source.event.tts.ownerClientId);
    assert.ok(elected && caption); assert.equal(caption.event.media, undefined);
    const eventPath = source => `/overlay-studio/public/${source.scene.publicId}/events/${source.event.id}?` + new URLSearchParams({ clientId, socketId: source.client.socketId });
    const full = await call(eventPath(elected)); assert.ok(full.media?.url);
    assert.equal((await call(eventPath(caption))).media, undefined);
    const wrongScene = await fetch(base + full.media.url.replace(elected.scene.publicId, caption.scene.publicId)); assert.equal(wrongScene.status, 404);
    const studioMedia = await fetch(base + full.media.url); assert.equal(studioMedia.status, 200); assert.deepEqual(Buffer.from(await studioMedia.arrayBuffer()), bytes);
    elected.client.emit('overlay-ended', elected.event.id); await pause(50); assert.ok((await call(eventPath(elected))).media, 'generic ACK preserves elected speech correlation');
    caption.client.emit('overlay-speech-ended', { eventId: caption.event.id, speechID: studioSpeech, reason: 'ended' }); await pause(50); assert.equal(await redis.get(`twitch:${channel}:tts:processing`), studioSpeech);
    const followMark = pet.events.length;
    elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID: studioSpeech, phase: 'playing', position: 0 });
    const follow = await pet.event('pet:follow', data => data.followId === studioSpeech); assert.equal(follow.envelope.stepMs, 40); assert.ok(follow.envelope.values.length <= 1500);
    elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID: studioSpeech, phase: 'progress', position: 0.5 });
    await until(() => pet.events.slice(followMark).filter(event => event.event === 'pet:follow').length === 2, 'advancing follow');
    elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID: studioSpeech, phase: 'progress', position: 0.5 }); await pause(100);
    assert.equal(pet.events.slice(followMark).filter(event => event.event === 'pet:follow').length, 2);
    elected.client.ws.close(); await idle();
    assert.equal((await fetch(base + full.media.url)).status, 404);
    const reconnected = await connect(elected.client.namespace, { clientId }, 'overlay-state');
    assert.equal(reconnected.events.some(event => event.event === 'overlay-event' && event.data.id === elected.event.id), false);
    const stale = await fetch(base + eventPath(elected)); assert.equal(stale.status, 404);
    const fresh = await fetch(base + eventPath({ ...elected, client: reconnected })); assert.equal(fresh.status, 404);
    const end = await pet.event('pet:follow-end', data => data.followId === studioSpeech); assert.equal(end.generation, follow.generation);
    console.log('PASS DIMA032 exact API: actual normal queue+mock synthesis/usage, PNG-only private playback once, lost ACK/fetch disconnect no replay, same-file fallback, concurrent Mongo admission reservation, skip, elected Studio media/captions/report ownership, follow and stale HTTP epochs.');
} finally {
    clearInterval(renew); for (const socket of sockets) socket.close();
    await mongo.connection.close(); redis.destroy();
}
process.exit(0);
