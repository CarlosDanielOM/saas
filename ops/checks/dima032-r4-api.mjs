/** Exact R4 session/control fences: real Dragonfly Lua + actual queue/adapter/socket, separate <300s helper check. */
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
async function playForSpeech(pet,speech) {
    const request=await until(()=>PetRequest.findOne({'origin.kind':'tts-queue','origin.id':speech,status:{$in:['ready','playing']}}).sort({createdAt:-1}).lean(),'private queue request');
    return pet.event('pet:play',data=>data.requestId===request._id);
}
const playback = (pet, play, seq, phase) => pet.send('pet:playback', { v: 1, requestId: play.requestId, leaseId: play.leaseId, generation: play.generation, seq, phase, positionMs: phase === 'ended' ? 500 : 0 });

const providerCount = () => redis.lLen('pet:test:provider-calls');
const usageCharacters = async () => Number(await redis.hGet(`${channel}:tts:usage`, 'total_characters') || 0);
const head = speechID => command('head', { ...(speechID ? { speechID } : {}) });
const completed = () => until(async () => !(await head()).speechID, 'head terminal cleanup');
let studioNamespace, studioAuth;
async function openStudio() { return connect(studioNamespace,studioAuth,'overlay-state'); }
const liveStudio = () => clients.filter(client=>client.namespace===studioNamespace&&client.ws.readyState===WebSocket.OPEN);
async function closeStudio() { for(const client of liveStudio()) client.ws.close(); await until(()=>liveStudio().length===0,'Studio sockets closed'); await pause(100); }
async function delivery(speechID) {
    return until(()=>liveStudio().flatMap(client=>client.events.map(item=>({client,event:item.data,kind:item.event})))
      .find(item=>item.kind==='overlay-event'&&item.event.tts?.speechID===speechID&&item.event.tts.ownerClientId),'elected session Studio');
}
async function endDelivery(item) { item.client.emit('overlay-speech-ended',{eventId:item.event.id,speechID:item.event.tts.speechID,reason:'ended'}); await completed(); }

async function bounded(operation, label) {
    let timer;
    try { return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),1500);})]); }
    finally { clearTimeout(timer); }
}
const processingKey=`twitch:${channel}:tts:processing`, queueKey=`twitch:${channel}:tts:queue`;
try {
    await save(settings=>({...settings,ttsAudio:'overlay'}));
    let studio=await call(`/overlay-studio/${channel}`);const scene=studio.scenes[0];
    studio=await call(`/overlay-studio/${channel}/scenes/${scene.id}/publish`,'POST',{revision:studio.revision});
    studioNamespace=`/overlay-studio/${studio.scenes.find(item=>item.id===scene.id).publicId}`;studioAuth={clientId:'dima032-r4-client'};
    await openStudio();
    // Hold the response of the actual atomic POP (payload+marker already read),
    // then cross the actual separate cron consumer's atomic stream boundary.
    await redis.del('dima032:test:entered:redis-pop');await redis.set('dima032:test:hold:redis-pop','true');
    const oldCount=await providerCount(),oldUsage=await usageCharacters(),old=await enqueue('Old dequeued session must not restart');
    await until(()=>redis.get('dima032:test:entered:redis-pop'),'actual Dragonfly atomic POP response');
    assert.equal((await head()).speechID,undefined);
    assert.equal((await separateProducer({streamEnd:true,channelId:channel})).ok,true);
    await redis.del('dima032:test:hold:redis-pop');
    await until(async()=>!(await head()).processing,'old atomic dequeue retired');
    assert.equal(await providerCount(),oldCount);assert.equal(await usageCharacters(),oldUsage);
    assert.equal(await redis.get(`twitch:${channel}:tts:queue:data:${old}`),null);
    // RESET has no exposed SET->DEL interval. Suspend only its later publication:
    // old queue is gone while a new enqueue uses the new marker atomically.
    await redis.del('dima032:test:entered:cas');await redis.set('dima032:test:hold:cas','true');
    const unsent=await enqueue('Queued before atomic reset');
    await until(()=>redis.get('dima032:test:entered:cas'),'admitted before output removal');
    await closeStudio();await redis.del('dima032:test:hold:cas');
    await until(async()=>await redis.zCard(queueKey)===1&&!(await head()).processing,'unsynthesized old queue retained');
    assert.equal(await providerCount(),oldCount);
    const previousSession=await redis.get(`twitch:${channel}:tts:session`);
    await redis.del('dima032:test:entered:session-publish');await redis.set('dima032:test:hold:session-publish','true');
    const resetting=separateProducer({streamEnd:true,channelId:channel,holdHint:true});
    await until(()=>redis.get('dima032:test:entered:session-publish'),'actual RESET complete before delayed hint');
    const nextSession=await redis.get(`twitch:${channel}:tts:session`);assert.ok(nextSession);assert.notEqual(nextSession,previousSession);
    assert.equal(await redis.zCard(queueKey),0);assert.equal(await redis.get(`twitch:${channel}:tts:queue:data:${unsent}`),null);
    await openStudio();await redis.del('dima032:test:entered:cas');await redis.set('dima032:test:hold:cas','true');
    const fresh=await enqueue('New session survives old cleanup');
    await until(()=>redis.get('dima032:test:entered:cas'),'new-session queue admitted while old publication waits');
    assert.equal(JSON.parse(await redis.get(`twitch:${channel}:tts:queue:data:${fresh}`)).queueSession,nextSession);
    assert.equal((await head()).speechID,fresh);
    await redis.del('dima032:test:hold:session-publish');assert.equal((await resetting).ok,true);
    assert.equal((await head()).speechID,fresh,'late old hint cannot stop a new-session head');
    await redis.del('dima032:test:hold:cas');const freshDelivery=await delivery(fresh);
    assert.equal(await providerCount(),oldCount+1);await endDelivery(freshDelivery);
    // Actual elected legacy owner retirement, followed by ordinary reports with
    // read-TTS/master disabled. No fixture invokes the queue terminal directly.
    const legacy=await connect(`/speech/${channel}`,{},'speech-reset');
    for(const action of ['skip','clear'])for(const setting of ['readTts','master']) {
        await save(settings=>({...settings,enabled:true,sources:{...settings.sources,readTts:true}}));
        const owned=await enqueue(`Read owner ${action} ${setting}`);await legacy.event('speech',data=>data.speechID===owned);
        assert.equal((await head()).electedOwner?.speechId,owned);await command('control',{action});await completed();
        assert.equal((await head()).electedOwner,null,'every terminal path retires its elected owner');
        await save(settings=>setting==='readTts'?({...settings,sources:{...settings.sources,readTts:false}}):({...settings,enabled:false}));
        const normal=await enqueue(`Ordinary after ${action} ${setting}`);await legacy.event('speech',data=>data.speechID===normal);
        legacy.emit('speech-playback',{speechID:normal,phase:'playing',position:0.5});
        await until(async()=>(await head(normal)).position===0.5,'ordinary elected progress accepted');
        legacy.emit('speech-ended',{speechID:normal,reason:'ended'});
        await until(async()=>await redis.get(processingKey)===null,'ordinary terminal releases real queue');
    }
    legacy.ws.close();await pause(100);
    // A real independent admission/play remains active through all controls.
    // Only its fixture deadline is extended so slow diagnostics do not expire it.
    await save(settings=>({...settings,enabled:true,sources:{independent:true,readTts:true},tts:{...settings.tts,enabled:true}}));
    const pet=await readyPet();
    const independent=await separateProducer({action:{channelId:channel,operation:'talk',text:'Independent stays playing',
        origin:{kind:'chat-command',id:randomUUID(),occurredAt:new Date().toISOString()},actionKey:'dima032-r4',actor:{userId:channel,displayName:'Fixture'}}});
    assert.equal(independent.status,'accepted');const play=await pet.event('pet:play',data=>data.requestId===independent.requestId);
    assert.equal((await playback(pet,play,0,'started')).ok,true);
    await PetRequest.updateOne({_id:play.requestId,status:'playing'},{$set:{phaseDeadline:new Date(Date.now()+120000)}});
    for(const stage of ['reserve','independent'])for(const action of ['skip','clear','stream-end']) {
        if(stage==='reserve')await PetRuntime.updateOne({_id:ownerId,activeRequestId:play.requestId},{$set:{notBefore:new Date(Date.now()+120000)}});
        const count=await providerCount(),usage=await usageCharacters(),speech=await enqueue(`Pending ${stage} ${action}`);
        await until(async()=>{const state=await head(),runtime=await PetRuntime.findById(ownerId).lean();return state.speechID===speech&&state.pendingWait&&(stage==='reserve'?state.phase==='preparing'&&!runtime.ttsReservation:state.activePumps===1&&runtime.ttsReservation?.speechId===speech);},`actual ${stage} wait`);
        const before=await PetRuntime.findById(ownerId).lean(),started=Date.now();
        await bounded((async()=>{
            if(action==='stream-end')assert.equal((await separateProducer({streamEnd:true,channelId:channel})).ok,true);
            else await command('control',{action});
            await completed();
        })(),'pending cancellation waited for its120-second deadline');
        assert.ok(Date.now()-started<1500);const after=await PetRuntime.findById(ownerId).lean(),state=await head();
        assert.equal(state.activePumps,0);assert.equal(state.electedOwner,null);assert.equal(after.ttsReservation,null);
        assert.equal(after.activeRequestId,play.requestId);assert.equal(after.generation,before.generation);
        assert.equal(after.lease.leaseId,before.lease.leaseId);assert.equal(after.lease.holderPeerId,before.lease.holderPeerId);
        assert.equal((await PetRequest.findById(play.requestId).lean()).status,'playing');
        assert.equal(pet.events.some(event=>event.event==='pet:stop'&&event.data.requestId===play.requestId),false);
        assert.equal(await providerCount(),count+(stage==='reserve'?0:1));
        assert.equal(await usageCharacters(),usage+(stage==='reserve'?0:`Pending ${stage} ${action}`.length));
        await PetRuntime.updateOne({_id:ownerId,activeRequestId:play.requestId},{$set:{notBefore:new Date(0)}});
        await command('observe',{ownerId});
    }
    assert.equal((await playback(pet,play,1,'ended')).ok,true);
    pet.lease=null;pet.ws.close();
    // R7: enable during the real initial processing SET, exactly at head capacity.
    // Claims are fixture-owned capacity pressure, never fabricated generated files.
    await save(settings=>({...settings,sources:{independent:false,readTts:false},ttsAudio:'pet'}));
    await until(async()=>(await PetRuntime.findById(ownerId).lean()).notBefore.getTime()<=Date.now(),'old independent lease handover',20000);
    await redis.del('dima032:test:entered:processing-set');await redis.set('dima032:test:hold:processing-set','true');
    let selected;
    try {
        const count=await providerCount(),usage=await usageCharacters(),text='Read TTS enable waits for head capacity',speech=await enqueue(text);
        await until(()=>redis.get('dima032:test:entered:processing-set'),'initial processing SET while disabled');
        assert.equal((await head()).speechID,undefined);
        const held=await command('capacity',{action:'hold'});assert.equal(held.ownedClaims,128);assert.equal(held.totalClaims,128);assert.equal(held.heads,0);
        await save(settings=>({...settings,sources:{...settings.sources,readTts:true}}));
        selected=await readyPet();await closeStudio();
        await redis.del('dima032:test:entered:processing-del');await redis.set('dima032:test:hold:processing-del','true');
        await redis.del('dima032:test:hold:processing-set');
        await until(()=>redis.get('dima032:test:entered:processing-del'),'final capacity-requeue DEL response held');
        assert.equal(await redis.zCard(queueKey),1);assert.equal((await head()).processing,true);
        assert.equal(await providerCount(),count);assert.equal(await usageCharacters(),usage);
        assert.ok(await redis.get(`twitch:${channel}:tts:queue:data:${speech}`));
        const laterText='Capacity wake preserves FIFO follower',later=await enqueue(laterText);
        assert.deepEqual(await redis.zRange(queueKey,0,-1),[speech,later]);
        const released=await command('capacity',{action:'release'});assert.equal(released.ownedClaims,0);
        // The callback had an event-loop turn while the old dispatch still owned
        // execution. Finishing DEL must preserve that wake without a new signal.
        assert.equal((await head()).processing,true);assert.equal(await providerCount(),count);assert.equal(await usageCharacters(),usage);
        await redis.del('dima032:test:hold:processing-del');
        // No new enqueue, ready signal or control: normal capacity retirement resumes it.
        const resumed=await playForSpeech(selected,speech);assert.equal(await providerCount(),count+1);assert.equal(await usageCharacters(),usage+text.length);
        assert.deepEqual(await redis.zRange(queueKey,0,-1),[later]);
        assert.equal((await playback(selected,resumed,0,'started')).ok,true);assert.equal((await playback(selected,resumed,1,'ended')).ok,true);
        const following=await playForSpeech(selected,later);assert.equal(await providerCount(),count+2);assert.equal(await usageCharacters(),usage+text.length+laterText.length);
        assert.equal((await playback(selected,following,0,'started')).ok,true);assert.equal((await playback(selected,following,1,'ended')).ok,true);await completed();
    } finally {
        await redis.del('dima032:test:hold:processing-set','dima032:test:hold:processing-del');await command('capacity',{action:'release'});
    }
    // R7: one exact request read fails only within this control's ALS context.
    // Possible playback must receive its exact stop before that cleanup await ends.
    const oldText='Private audio stops despite lost cleanup read',nextText='Successor must keep its own identity';
    const beforeFault=await providerCount(),faultUsage=await usageCharacters(),oldSpeech=await enqueue(oldText),oldPlay=await playForSpeech(selected,oldSpeech);
    const audioResponse=await fetch(base+new URL(oldPlay.audio.url).pathname+new URL(oldPlay.audio.url).search);assert.equal(audioResponse.status,200);await audioResponse.arrayBuffer();
    assert.equal((await playback(selected,oldPlay,0,'started')).ok,true);
    await redis.del('dima032:test:provider-prior-private-state');await redis.set('dima032:test:terminal-before-provider',oldPlay.requestId);
    const successor=await enqueue(nextText);
    await redis.del('dima032:test:entered:release-read');await redis.set('dima032:test:hold:release-read','true');
    const controlling=command('control',{action:'skip',failPrivateRead:oldPlay.requestId});
    try {
        await until(()=>redis.get('dima032:test:entered:release-read'),'exact control private read response');
        const stop=await until(()=>selected.events.find(event=>event.event==='pet:stop'&&event.data.requestId===oldPlay.requestId)?.data,'stop before cleanup read settles',1500);
        assert.equal(stop.generation,oldPlay.generation);assert.equal(await providerCount(),beforeFault+1);
        assert.equal(await PetRequest.countDocuments({'origin.kind':'tts-queue','origin.id':successor}),0,'successor cannot overlap pending old cleanup');
        await redis.del('dima032:test:hold:release-read');const result=await controlling;assert.equal(result.injectedReadFailures,1);
        await until(async()=>['cancelled','completed','failed','expired'].includes((await PetRequest.findById(oldPlay.requestId).lean()).status),'old private request terminal');
        const nextPlay=await playForSpeech(selected,successor);assert.notEqual(nextPlay.requestId,oldPlay.requestId);
        assert.equal((await playback(selected,nextPlay,0,'started')).ok,true);
        assert.equal((await playback(selected,oldPlay,1,'ended')).ok,false,'late old terminal cannot claim the new request');
        const current=await PetRuntime.findById(ownerId).lean();assert.equal(current.activeRequestId,nextPlay.requestId);assert.equal(current.generation,nextPlay.generation);
        assert.equal((await PetRequest.findById(nextPlay.requestId).lean()).status,'playing');
        assert.equal(selected.events.some(event=>event.event==='pet:stop'&&event.data.requestId===nextPlay.requestId),false);
        assert.equal(await providerCount(),beforeFault+2);assert.equal(await usageCharacters(),faultUsage+oldText.length+nextText.length);
        const priorStates=(await redis.lRange('dima032:test:provider-prior-private-state',0,-1)).map(raw=>JSON.parse(raw));
        assert.equal(priorStates.length,1,'only the successor provider runs after the fault');
        assert.equal(priorStates[0].requestId,oldPlay.requestId);assert.ok(['cancelled','completed','failed','expired'].includes(priorStates[0].status),'old private identity must be terminal before any successor provider call');
        assert.equal((await playback(selected,nextPlay,1,'ended')).ok,true);await completed();
        selected.lease=null;selected.ws.close();const fresh=await readyPet();await pause(100);
        assert.equal(fresh.events.some(event=>event.event==='pet:play'),false,'reconnect must not replay the uncertain old item');
        assert.equal(await providerCount(),beforeFault+2);assert.equal(await redis.zCard(queueKey),0);
    } finally {await redis.del('dima032:test:hold:release-read','dima032:test:terminal-before-provider');await controlling;}
    assert.equal(await redis.lLen('pet:test:billing-events'),0);
    console.log('PASS DIMA032 actual Lua/session/owner/wait fences plus enable-at-capacity backpressure and exact private stop/cancel across a lost control-read reply; same paid identities, no overlap/replay.');
} finally {
    await redis.del('dima032:test:hold:redis-pop','dima032:test:hold:session-publish','dima032:test:hold:cas','dima032:test:hold:processing-set','dima032:test:hold:processing-del','dima032:test:hold:release-read','dima032:test:terminal-before-provider');
    clearInterval(renew);for(const socket of sockets)socket.close();await mongo.connection.close();redis.destroy();
}
process.exit(0);
