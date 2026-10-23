/** Exact session-lifecycle candidate (separate helper check, no startup wait): disposable Mongo/Redis, actual API singleton and dummy providers only. */
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

const providerCount = () => redis.lLen('pet:test:provider-calls');
const usageCharacters = async () => Number(await redis.hGet(`${channel}:tts:usage`, 'total_characters') || 0);
const head = speechID => command('head', { ...(speechID ? { speechID } : {}) });
const parked = speechID => until(async () => { const state=await head(); return state.speechID===speechID&&state.phase==='parked'&&!state.running?state:null; }, 'parked generated head');
const completed = () => until(async () => !(await head()).speechID, 'head terminal cleanup');
const hash = async response => { assert.equal(response.status,200); const { createHash }=await import('node:crypto'); return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'); };
const localAudio = url => base + new URL(url).pathname + new URL(url).search;
let studioNamespace, studioAuth;
async function openStudio() { return connect(studioNamespace,studioAuth,'overlay-state'); }
const liveStudio = () => clients.filter(client=>client.namespace===studioNamespace&&client.ws.readyState===WebSocket.OPEN);
async function closeStudio() { for(const client of liveStudio()) client.ws.close(); await until(()=>liveStudio().length===0,'Studio sockets closed'); await pause(100); }
async function delivery(speechID) {
    return until(()=>liveStudio().flatMap(client=>client.events.map(item=>({client,event:item.data,kind:item.event})))
      .find(item=>item.kind==='overlay-event'&&item.event.tts?.speechID===speechID&&item.event.tts.ownerClientId),'elected session Studio');
}
async function endDelivery(item) { item.client.emit('overlay-speech-ended',{eventId:item.event.id,speechID:item.event.tts.speechID,reason:'ended'}); await completed(); }
async function mediaHash(item) {
    const publicId=item.client.namespace.split('/').at(-1);
    const event=await call(`/overlay-studio/public/${publicId}/events/${item.event.id}?`+new URLSearchParams({clientId:item.client.auth.clientId,socketId:item.client.socketId}));
    assert.ok(event.media?.url); return hash(await fetch(base+event.media.url));
}
async function heldSynthesis(text,later) {
    await redis.del('dima032:test:entered:synthesis'); await redis.set('dima032:test:hold:synthesis','true');
    const count=await providerCount(),usage=await usageCharacters(),speech=await enqueue(text);
    await until(()=>redis.get('dima032:test:entered:synthesis'),'actual provider response barrier');
    const next=later?await enqueue(later):null;
    await closeStudio(); await redis.del('dima032:test:hold:synthesis');
    const state=await parked(speech); assert.equal(await providerCount(),count+1); assert.equal(await usageCharacters(),usage+text.length);
    assert.equal(state.processing,false); assert.equal(state.watchdog,false); assert.ok(state.fileHash); assert.ok(state.fileBytes>0);
    assert.equal((await PetRuntime.findById(ownerId).lean()).ttsReservation,null);
    return { speech,next,count,usage,state,text };
}

try {
    await save(settings=>({...settings,ttsAudio:'overlay'}));
    let studio=await call(`/overlay-studio/${channel}`);
    const scene=studio.scenes[0];
    studio=await call(`/overlay-studio/${channel}/scenes/${scene.id}/publish`,'POST',{revision:studio.revision});
    studioNamespace=`/overlay-studio/${studio.scenes.find(item=>item.id===scene.id).publicId}`; studioAuth={clientId:'dima032-session-client'};
    await openStudio();
    // The exact late DEL interleaving from R3, using the real queue's Redis operation.
    await redis.del('dima032:test:entered:cas','dima032:test:entered:processing-del');
    await redis.set('dima032:test:hold:cas','true'); const skipCount=await providerCount();
    const skipped=await enqueue('Late Redis delete skip'); await until(()=>redis.get('dima032:test:entered:cas'),'late skip claim barrier');
    await closeStudio(); await redis.set('dima032:test:hold:processing-del','true'); await redis.del('dima032:test:hold:cas');
    await until(()=>redis.get('dima032:test:entered:processing-del'),'final processing DEL barrier');
    const skipping=command('control',{action:'skip'}); await pause(100); await redis.del('dima032:test:hold:processing-del'); await skipping;
    assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`),0); assert.equal(await redis.get(`twitch:${channel}:tts:queue:data:${skipped}`),null);
    assert.equal(await providerCount(),skipCount); await completed(); await openStudio();
    // One paid generated head, no background configuration polling, strict FIFO and identical bytes.
    const waiting=await heldSynthesis('Generated head keeps original audio','Later item must not overtake');
    assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`),1);
    await pause(100); const settled=await head(); await pause(500); const unchanged=await head();
    assert.equal(unchanged.configurationReads,settled.configurationReads,'parked head performs no full settings polling');
    assert.equal(unchanged.epoch,settled.epoch); assert.equal(await providerCount(),waiting.count+1);
    await openStudio(); const resumed=await delivery(waiting.speech); assert.equal(await mediaHash(resumed),waiting.state.fileHash);
    assert.equal(await providerCount(),waiting.count+1); assert.equal(await usageCharacters(),waiting.usage+waiting.text.length);
    resumed.client.emit('overlay-speech-ended',{eventId:resumed.event.id,speechID:waiting.speech,reason:'ended'});
    const following=await delivery(waiting.next); assert.equal(await providerCount(),waiting.count+2); await endDelivery(following);
    // Route selection is fresh after park: selected PNG reconnect, no desktop/overlay.
    await save(settings=>({...settings,ttsAudio:'pet'}));
    const reconnect=await heldSynthesis('Pet reconnect uses existing generated file');
    let pet=await readyPet(); const reconnectPlay=await playForSpeech(pet,reconnect.speech);
    const ackIndex=pet.events.findIndex(event=>event.event==='ack:pet:lease'&&event.data.ok);
    assert.ok(pet.events.findIndex(event=>event.event==='pet:play'&&event.data.requestId===reconnectPlay.requestId)>ackIndex);
    assert.equal(await hash(await fetch(localAudio(reconnectPlay.audio.url))),reconnect.state.fileHash);
    assert.equal(await providerCount(),reconnect.count+1); assert.equal(await usageCharacters(),reconnect.usage+reconnect.text.length);
    await playback(pet,reconnectPlay,0,'started'); await playback(pet,reconnectPlay,1,'ended'); await completed(); pet.ws.close(); await pause(100);
    await openStudio();
    for(const setting of ['readTts','master']) {
        const disabled=await heldSynthesis(`Generated audio survives ${setting} disable`);
        const requests=await PetRequest.countDocuments({ownerId,operation:'tts'});
        await save(settings=>setting==='readTts'?({...settings,sources:{...settings.sources,readTts:false}}):({...settings,enabled:false}));
        await parked(disabled.speech); await openStudio(); const item=await delivery(disabled.speech);
        assert.equal(await mediaHash(item),disabled.state.fileHash); assert.equal(await providerCount(),disabled.count+1);
        assert.equal(await usageCharacters(),disabled.usage+disabled.text.length); assert.equal(await PetRequest.countDocuments({ownerId,operation:'tts'}),requests);
        assert.ok((await PetRuntime.findById(ownerId).lean()).ttsReservation,'disabled pet still arbitrates its already-generated normal fallback');
        await endDelivery(item);
        await save(settings=>({...settings,enabled:true,sources:{...settings.sources,readTts:true}}));
    }
    // Two proved-unsent private attempts share origin/audio/usage but not request/action identity.
    await closeStudio(); pet=await readyPet(); await redis.del('dima032:test:entered:private'); await redis.set('dima032:test:hold:private','true');
    const privateCount=await providerCount(),privateUsage=await usageCharacters(),privateText='Retry only a proved unheard private attempt',privateSpeech=await enqueue(privateText);
    await until(()=>redis.get('dima032:test:entered:private'),'private attempt fence response'); pet.ws.close(); await pause(100); await redis.del('dima032:test:hold:private');
    const privatePark=await parked(privateSpeech); assert.equal(pet.events.some(event=>event.event==='pet:play'),false);
    const oldRequest=await PetRequest.findOne({'origin.id':privateSpeech}).lean(); pet=await readyPet(); const retried=await playForSpeech(pet,privateSpeech);
    const newRequest=await PetRequest.findById(retried.requestId).lean(); assert.notEqual(oldRequest._id,newRequest._id); assert.notEqual(oldRequest.actionKey,newRequest.actionKey);
    assert.equal(oldRequest.origin.id,newRequest.origin.id); assert.equal(await hash(await fetch(localAudio(retried.audio.url))),privatePark.fileHash);
    assert.equal(await providerCount(),privateCount+1); assert.equal(await usageCharacters(),privateUsage+privateText.length);
    await playback(pet,retried,0,'started'); await playback(pet,retried,1,'ended'); await completed(); pet.ws.close(); await pause(100); await openStudio();
    // Actual separate compiled cron consumer publishes to actual API listener; local fixture stubs only unrelated effects.
    await save(settings=>({...settings,ttsAudio:'overlay'}));
    for(const dropHint of [false,true]) {
        const ending=await heldSynthesis(`Stream end clears session dropHint=${dropHint}`);
        const producer=await separateProducer({streamEnd:true,channelId:channel,dropHint}); assert.equal(producer.ok,true);
        if(dropHint) await command('recover'); // existing bounded recovery, deterministically triggered once
        await completed(); const ended=await head(ending.speech); assert.equal(ended.cleanupPending,true);
        assert.equal((await PetRuntime.findById(ownerId).lean()).ttsReservation,null); await openStudio(); await pause(100);
        assert.equal(liveStudio().some(client=>client.events.some(event=>event.event==='overlay-event'&&event.data.tts?.speechID===ending.speech)),false);
        assert.equal(await providerCount(),ending.count+1); assert.equal(await usageCharacters(),ending.usage+ending.text.length);
    }
    // Stream end also stops possibly-heard private audio; it never reconnects/replays.
    await save(settings=>({...settings,ttsAudio:'pet'})); await closeStudio(); pet=await readyPet();
    const activeSpeech=await enqueue('Active private audio ends with the stream'),activePlay=await playForSpeech(pet,activeSpeech);
    assert.equal((await fetch(localAudio(activePlay.audio.url))).status,200);
    assert.equal((await separateProducer({streamEnd:true,channelId:channel})).ok,true); await completed();
    await pet.event('pet:stop',data=>data.requestId===activePlay.requestId);
    const playCount=pet.events.filter(event=>event.event==='pet:play').length; await pause(200); assert.equal(pet.events.filter(event=>event.event==='pet:play').length,playCount);
    assert.equal((await head(activeSpeech)).cleanupPending,true); assert.equal((await PetRuntime.findById(ownerId).lean()).ttsReservation,null);
    assert.equal(await redis.lLen('pet:test:billing-events'),0,'dummy normal Piper creates no paid or duplicate debit');
    console.log('PASS DIMA032 exact session lifecycle: actual queue/provider/usage, late Redis DEL skip, bounded parked FIFO/no polling, same-file Studio/PNG reconnect, disabled-settings fallback, fresh safe private attempts, compiled cross-process stream consumer/PubSub stop and lost-hint recovery; session-only retention.');
} finally {
    await redis.del('dima032:test:hold:cas','dima032:test:hold:synthesis','dima032:test:hold:private','dima032:test:hold:processing-del');
    clearInterval(renew); for(const socket of sockets) socket.close(); await mongo.connection.close(); redis.destroy();
}
process.exit(0);
