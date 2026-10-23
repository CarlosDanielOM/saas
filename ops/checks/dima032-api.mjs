/** Exact API candidate: disposable Mongo/Redis, actual API singleton and dummy providers only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
async function until(fn, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(25); } throw new Error(`Timeout: ${label}`); }
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
        send(event, data) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`ACK ${event}`)), 5000); acks.set(id, value => { clearTimeout(timer); acks.delete(id); events.push({ event: `ack:${event}`, data: value }); resolve(value); }); ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`); }); },
        event(event, predicate = () => true) { return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event); }
    };
    await until(() => socketId, 'namespace join'); if (first) await client.event(first); clients.push(client); return client;
}
async function separateProducer(input) {
    const child = spawn(process.execPath, ['/tmp/saas-fixtures/producer.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000); child.stdin.end(JSON.stringify(input));
    const [code] = await once(child, 'close'); clearTimeout(timer); assert.equal(code, 0, stderr);
    const line = stdout.split('\n').find(line => line.startsWith('DIMA032_PRODUCER:')); assert.ok(line, stdout);
    const result = JSON.parse(line.slice('DIMA032_PRODUCER:'.length)); assert.notEqual(result.pid, process.pid); assert.equal(result.peers, 0); return result.result;
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
async function playForSpeech(pet, speech) { const request = await until(() => PetRequest.findOne({ 'origin.kind': 'tts-queue', 'origin.id': speech, status: { $in: ['ready','playing'] } }).sort({ createdAt: -1 }).lean(), 'TTS request'); return pet.event('pet:play', data => data.requestId === request._id); }
const playback = (pet, play, seq, phase) => pet.send('pet:playback', { v: 1, requestId: play.requestId, leaseId: play.leaseId, generation: play.generation, seq, phase, positionMs: phase === 'ended' ? 500 : 0 });
const idle = () => until(async () => !await redis.get(`twitch:${channel}:tts:processing`), 'normal queue release');
const providerCount = () => redis.lLen('pet:test:provider-calls');
const usageCharacters = async () => Number(await redis.hGet(`${channel}:tts:usage`, 'total_characters') || 0);
const localAudio = url => base + new URL(url).pathname + new URL(url).search;
try {
    const startup = JSON.parse(await redis.get('dima032:test:startup'));
    const restarted = await PetRuntime.findById(startup.ownerId).lean();
    assert.equal(restarted.generation, 8); assert.equal(restarted.ttsReservation, null);
    assert.equal(restarted.notBefore.getTime(), startup.notBefore);
    assert.equal((await PetRequest.findById('restart-possibly-heard').lean()).status, 'cancelled');
    const startupCount = await providerCount(), startupOverlay = await connect(`/speech/${startup.channel}`, {}, 'speech-reset');
    assert.ok(Date.now() < startup.notBefore, 'fixture reaches the old conservative lease barrier');
    await pause(150); assert.equal(await providerCount(), startupCount, 'startup backlog cannot synthesize before safe turn');
    const startupAudio = await until(() => startupOverlay.events.find(event => event.event === 'speech' && event.data.speechID === 'restart-backlog')?.data, 'restart backlog after lease barrier', 50000);
    assert.ok(Date.now() >= startup.notBefore); assert.equal(await providerCount(), startupCount + 1);
    startupOverlay.emit('speech-ended', { speechID: startupAudio.speechID, reason: 'ended' }); startupOverlay.ws.close();
    let pet = await readyPet();
    const before = await providerCount(), chars = await usageCharacters(), text = 'Normal queue uses existing synthesis once';
    const speech = await enqueue(text), play = await playForSpeech(pet, speech);
    assert.equal((await PetRequest.findById(play.requestId).lean()).origin.id, speech);
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), speech, 'pet-only PNG admission reaches normal TTS with no desktop/overlay');
    const audio = await fetch(localAudio(play.audio.url)); assert.equal(audio.status, 200); const bytes = Buffer.from(await audio.arrayBuffer()); assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal((await playback(pet, play, 0, 'started')).ok, true); assert.equal((await playback(pet, play, 1, 'ended')).ok, true); await idle();
    assert.equal(await providerCount(), before + 1); assert.equal(await usageCharacters(), chars + text.length); assert.equal(await redis.lLen('pet:test:billing-events'), 0, 'free fixture adds no duplicate paid debit');
    // Existing unheard PNG-only backlog resumes on ready+lease, without another enqueue/control.
    const firstBacklog = await enqueue('PNG first item'); const firstBacklogPlay = await playForSpeech(pet, firstBacklog);
    const secondBacklog = await enqueue('PNG waiting item'); pet.ws.close(); await idle();
    assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`), 1);
    await redis.set('pet:test:provider-mode', 'hold'); pet = await readyPet();
    const leaseAck = pet.events.findIndex(event => event.event === 'ack:pet:lease' && event.data.ok);
    assert.ok(leaseAck >= 0); const readyStarted = Date.now();
    assert.equal((await pet.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: false })).ok, true);
    assert.ok(Date.now() - readyStarted < 1500, 'provider resume never blocks the socket control queue');
    const secondBacklogPlay = await playForSpeech(pet, secondBacklog); await redis.del('pet:test:provider-mode');
    assert.ok(pet.events.findIndex(event => event.event === 'pet:play' && event.data.requestId === secondBacklogPlay.requestId) > leaseAck, 'lease ACK precedes first resumed play');
    assert.notEqual(firstBacklogPlay.requestId, secondBacklogPlay.requestId);
    await playback(pet, secondBacklogPlay, 0, 'started'); await playback(pet, secondBacklogPlay, 1, 'ended'); await idle();
    const legacy = await connect(`/speech/${channel}`, {}, 'speech-reset');
    for (const fetchTicket of [false, true]) {
        const mark = legacy.events.length, count = await providerCount(); const id = await enqueue(`Lost started ACK fetch=${fetchTicket}`);
        const p = await playForSpeech(pet, id);
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
    const handoff = await playForSpeech(pet, waiting);
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
    const liveStudio = () => clients.filter(client => client.namespace.startsWith('/overlay-studio/') && client.ws.readyState === WebSocket.OPEN);
    const studioDelivery = speechID => until(() => liveStudio().flatMap(client => client.events.map(event => ({ client, event: event.data, kind: event.event }))).find(item => item.kind === 'overlay-event' && item.event.tts?.speechID === speechID && item.event.tts.ownerClientId), 'elected Studio delivery');
    // Delayed REAL Mongo claim response crosses skip before any normal synthesis/debit.
    await redis.set('dima032:test:hold:cas', 'true'); const cancelledCount = await providerCount();
    const cancelledSpeech = await enqueue('Cancel delayed claim');
    await until(() => redis.get('dima032:test:entered:cas'), 'CAS barrier');
    await command('control', { action: 'skip' }); const afterSkip = await enqueue('Next item survives cancelled claim');
    assert.equal(await providerCount(), cancelledCount); await redis.del('dima032:test:hold:cas');
    const nextDelivery = await studioDelivery(afterSkip);
    assert.equal(await providerCount(), cancelledCount + 1);
    assert.equal(liveStudio().some(client => client.events.some(event => event.event === 'overlay-event' && event.data.tts?.speechID === cancelledSpeech)), false);
    nextDelivery.client.emit('overlay-speech-ended', { eventId: nextDelivery.event.id, speechID: afterSkip, reason: 'ended' }); await idle();
    for (const phase of ['retain', 'persist']) {
        await redis.set(`dima032:test:hold:${phase}`, 'true');
        const old = await enqueue(`Late ${phase} must not play`);
        await until(() => redis.get(`dima032:test:entered:${phase}`), `${phase} barrier`);
        const next = await enqueue(`New item after ${phase}`);
        const ending = command('end', { speechID: old }); await pause(50); await redis.del(`dima032:test:hold:${phase}`); await ending;
        const current = await studioDelivery(next);
        assert.equal(liveStudio().some(client => client.events.some(event => event.event === 'overlay-event' && event.data.tts?.speechID === old)), false);
        const storedOld = await db.collection('overlay_deliveries').findOne({ speechID: old }); assert.ok(!storedOld?.mediaId, 'stale retained media released');
        current.client.emit('overlay-speech-ended', { eventId: current.event.id, speechID: next, reason: 'ended' }); await idle();
    }
    // Opted-in VTS offline keeps one legacy owner; reconnect/settings validity cannot bypass its turn.
    const offlineLegacy = await connect(`/speech/${channel}`, {}, 'speech-reset');
    for (const kind of ['vts', 'png']) {
        await save(settings => ({ ...settings, ttsAudio: 'pet', appearance: { kind, idleAssetId: null, talkingAssetId: null }, playback: { ...settings.playback, vtsSessionId: null } }));
        const offlineSpeech = await enqueue(`Unavailable ${kind} still uses one fallback`); await offlineLegacy.event('speech', data => data.speechID === offlineSpeech);
        await pause(100); assert.ok((await PetRuntime.findById(ownerId).lean()).ttsReservation);
        assert.equal(liveStudio().some(client => client.events.some(event => event.event === 'overlay-event' && event.data.tts?.speechID === offlineSpeech && event.data.media)), false);
        await save(settings => ({ ...settings, appearance: { kind: 'png', idleAssetId: String(asset), talkingAssetId: String(asset) } }));
        await assert.rejects(admitPetAction(action('reconnected-during-overlay')), error => error.code === 'busy');
        assert.equal(await redis.get(`twitch:${channel}:tts:processing`), offlineSpeech);
        offlineLegacy.emit('speech-ended', { speechID: offlineSpeech, reason: 'ended' }); await idle();
    }
    // Automatic loss at the final private attempted-CAS response is still provably unheard.
    pet = await readyPet(); await redis.set('dima032:test:hold:private', 'true');
    const privateCount = await providerCount(), unheard = await enqueue('Private pre-emission invalidation');
    await until(() => redis.get('dima032:test:entered:private'), 'private pre-emission barrier');
    await command('invalidate', { ownerId });
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), unheard, 'automatic pre-play invalidation keeps normal queue');
    await redis.del('dima032:test:hold:private'); const unheardFallback = await offlineLegacy.event('speech', data => data.speechID === unheard);
    assert.equal(pet.events.some(event => event.event === 'pet:play'), false);
    assert.deepEqual(Buffer.from(await (await fetch(localAudio(unheardFallback.audioUrl))).arrayBuffer()), bytes);
    assert.equal(await providerCount(), privateCount + 1); offlineLegacy.emit('speech-ended', { speechID: unheard, reason: 'ended' }); await idle(); offlineLegacy.ws.close();
    await save(settings => ({ ...settings, ttsAudio: 'overlay' }));
    // Disconnect every live Studio while an unheard backlog exists. Grace is not output readiness.
    const activeBacklog = await enqueue('Studio active before disconnect'); await studioDelivery(activeBacklog);
    const backlogCount = await providerCount(); await redis.del('dima032:test:entered:cas'); await redis.set('dima032:test:hold:cas', 'true');
    const queuedBacklog = await enqueue('Studio unheard backlog'); const reconnectSource = liveStudio()[0];
    for (const client of liveStudio()) client.ws.close(); await pause(100); await redis.del('dima032:test:hold:cas');
    await idle(); await pause(150); assert.equal(await providerCount(), backlogCount, 'disconnected grace cannot bill the waiting item');
    assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`), 1);
    await connect(reconnectSource.namespace, reconnectSource.auth, 'overlay-state');
    const resumedBacklog = await studioDelivery(queuedBacklog); assert.equal(await providerCount(), backlogCount + 1);
    resumedBacklog.client.emit('overlay-speech-ended', { eventId: resumedBacklog.event.id, speechID: queuedBacklog, reason: 'ended' }); await idle();
    // Output disappears after a real provider result: hold generated file, never re-synthesize.
    await redis.set('dima032:test:hold:synthesis', 'true'); const synthesisCount = await providerCount();
    const retainedSpeech = await enqueue('Preserve generated file while source missing');
    await until(() => redis.get('dima032:test:entered:synthesis'), 'synthesis result barrier');
    const returning = liveStudio()[0]; for (const client of liveStudio()) client.ws.close();
    await pause(100); await redis.del('dima032:test:hold:synthesis'); await pause(200);
    assert.equal(await providerCount(), synthesisCount + 1);
    assert.equal((await command('head')).speechID, retainedSpeech); assert.equal((await command('head')).phase, 'parked');
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), null, 'parked paid head releases execution lock');
    assert.equal((await PetRuntime.findById(ownerId).lean()).ttsReservation, null);
    await connect(returning.namespace, returning.auth, 'overlay-state'); const retainedDelivery = await studioDelivery(retainedSpeech);
    assert.equal(await providerCount(), synthesisCount + 1); retainedDelivery.client.emit('overlay-speech-ended', { eventId: retainedDelivery.event.id, speechID: retainedSpeech, reason: 'ended' }); await idle();
    // Real 300s normal WAV (9.6MB) remains whole; a paused Studio turn outlives240s.
    await call(`/overlay-studio/${channel}/queue`, 'POST', { action: 'pause', platform: 'all' });
    await redis.set('dima032:test:long-audio', 'true'); const longStarted = Date.now(), longSpeech = await enqueue('Long normal audio must stay protected');
    const longDelivery = await studioDelivery(longSpeech); await redis.del('dima032:test:long-audio');
    const longRuntime = await PetRuntime.findById(ownerId).lean(); assert.ok(longRuntime.ttsReservation.expiresAt.getTime() >= longStarted + 510000);
    assert.equal((await separateProducer({ action: action('paused-long-media'), now: longStarted + 241000 })).error, 'busy');
    const longPublic = longDelivery.client.namespace.split('/').at(-1);
    const longFull = await call(`/overlay-studio/public/${longPublic}/events/${longDelivery.event.id}?` + new URLSearchParams({ clientId: longDelivery.client.auth.clientId, socketId: longDelivery.client.socketId }));
    assert.equal(longFull.tts.durationMs, 60000); const longMedia = await fetch(base + longFull.media.url); assert.equal(longMedia.status, 200);
    const longBytes = Buffer.from(await longMedia.arrayBuffer()); assert.equal(longBytes.length, 9600044); assert.equal(longBytes.readUInt32LE(40) / longBytes.readUInt32LE(28), 300);
    await call(`/overlay-studio/${channel}/queue`, 'POST', { action: 'resume', platform: 'all' });
    longDelivery.client.emit('overlay-speech-playback', { eventId: longDelivery.event.id, speechID: longSpeech, phase: 'playing', position: 0 });
    longDelivery.client.emit('overlay-speech-ended', { eventId: longDelivery.event.id, speechID: longSpeech, reason: 'ended' }); await idle();
    console.log('PASS DIMA032 exact API: actual normal queue+mock synthesis/usage, PNG-only private playback once, lost ACK/fetch disconnect no replay, same-file fallback, concurrent Mongo admission reservation, skip, elected Studio media/captions/report ownership, follow and stale HTTP epochs.');
} finally {
    await redis.del('dima032:test:hold:cas', 'dima032:test:hold:retain', 'dima032:test:hold:persist', 'dima032:test:hold:private', 'dima032:test:hold:synthesis', 'dima032:test:long-audio', 'pet:test:provider-mode');
    clearInterval(renew); for (const socket of sockets) socket.close();
    await mongo.connection.close(); redis.destroy();
}
process.exit(0);
