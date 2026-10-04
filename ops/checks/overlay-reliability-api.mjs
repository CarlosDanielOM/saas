// Runs only in the saas-ops disposable API with disposable Mongo/Redis.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
const require = createRequire('/app/package.json');
const express = require('express'); const { Server } = require('socket.io'); const { createServer } = await import('node:http');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const redis = await getDragonflyClient('reliability-check');
const store = await import('/app/dist/overlays/store.js'); const durable = await import('/app/dist/overlays/delivery-store.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
await store.load('990091').catch(()=>{});
const channel='990181', token='overlay-reliability-owner';
await Users.collection.insertOne({ accounts: [{ type:'twitch', id:channel }], plan_tier:'free' });
await redis.hSet('token:'+token,{ id:channel, login:'reliability', display_name:'Reliability' });
await redis.hSet('token:reliability-other',{ id:'990182', login:'other', display_name:'Other' });
const { ttsQueueHandler } = await import('/app/dist/handlers/tts_queue.handler.js');
const { clipQueueHandler } = await import('/app/dist/handlers/clip_queue.handler.js');
ttsQueueHandler.resumeIfIdle = async()=>{}; clipQueueHandler.subscribeToChannel = async()=>{};
const { piperTtsService } = await import('/app/dist/server/services/tts/piper_tts.service.js');
const audio='/tmp/reliability-speech.wav';
piperTtsService.synthesize=async request=>{assert.equal(request.provider,'piper');await writeFile(audio,'test-speech');return {error:false,outputPath:audio,mimeType:'audio/wav'};};
const live=await import('/app/dist/overlays/live.js');
const { overlayStudioRoute }=await import('/app/dist/server/routes/overlay-studio.route.js');
let server,io; const base='http://127.0.0.1:3211';
async function start(){const app=express();app.use(express.json({limit:'5mb'}));app.use('/overlay-studio',overlayStudioRoute);server=createServer(app);io=new Server(server);live.registerStudio(io);await new Promise(r=>server.listen(3211,'127.0.0.1',r));}
await start();
async function req(method,path,body,status=200,auth=token){const r=await fetch(base+'/overlay-studio/'+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v.data;}
async function until(fn,label){for(let i=0;i<160;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,30));}throw Error('Timeout: '+label);}
async function connect(publicId,clientId=crypto.randomUUID()){
 const ws=new WebSocket(base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket'), ns='/overlay-studio/'+publicId, events=[];
 ws.addEventListener('message',e=>{const m=String(e.data);if(m.startsWith('0'))ws.send(`40${ns},${JSON.stringify({clientId})}`);else if(m==='2')ws.send('3');else if(m.startsWith(`42${ns},`))events.push(JSON.parse(m.slice(m.indexOf(',')+1)));});
 const peer={ws,clientId,events,ack:id=>ws.send(`42${ns},${JSON.stringify(['overlay-ended',id])}`),wait:fn=>until(()=>events.find(fn),'socket')};await peer.wait(e=>e[0]==='overlay-state');return peer;
}
let state=await req('GET',channel);let scene=state.scenes[0];
state.scenes.push({...structuredClone(scene),id:'second',name:'Second',publicId:''});state=await req('PUT',channel,state);
for(const s of state.scenes) state=await req('POST',`${channel}/scenes/${s.id}/publish`,{revision:state.revision});
const first=state.scenes[0],second=state.scenes[1];let a=await connect(first.publicId), b=await connect(second.publicId);
// Owner-only tests and explicit confirmation.
await req('POST',channel+'/test',{kind:'tts',destination:'preview'},403,'reliability-other');
await req('POST',channel+'/test',{kind:'tts',destination:'obs',sceneId:first.id},400);
let preview=await req('POST',channel+'/test',{kind:'tts',destination:'preview',sceneId:first.id});
assert.equal(await(await fetch(base+preview.media.url)).text(),'test-speech');assert(!a.events.some(e=>e[0]==='overlay-event'));assert(!b.events.some(e=>e[0]==='overlay-event'));
await redis.del('overlay:test:'+channel);
let test=await req('POST',channel+'/test',{kind:'tts',destination:'obs',confirmed:true,sceneId:first.id});assert.equal(test.clients,1);
let sent=(await a.wait(e=>e[0]==='overlay-event'))[1];assert(!b.events.some(e=>e[0]==='overlay-event'));
let full=await req('GET',`public/${first.publicId}/events/${sent.id}`,undefined,200,'');assert.equal(await(await fetch(base+full.media.url)).text(),'test-speech');
a.ack(sent.id);await until(async()=>!(await live.eventFor(first.publicId,sent.id)),'ack');
await redis.del('overlay:test:'+channel);
const { TriggerSchema } = await import('/app/dist/schemas/trigger.schema.js');
await TriggerSchema.collection.insertOne({channelID:channel,name:'Fixture image',file:'https://fixture.invalid/image.gif',mediaType:'image/gif',volume:50});
const before = a.events.filter(e=>e[0]==='overlay-event').length;
preview=await req('POST',channel+'/test',{kind:'trigger',destination:'preview'});assert.equal(preview.media.type,'image');assert.equal(preview.media.volume,.5);assert(preview.triggerId);
assert.equal(a.events.filter(e=>e[0]==='overlay-event').length,before);
await redis.del('overlay:test:'+channel);
await req('POST',channel+'/test',{kind:'trigger',destination:'preview',triggerIds:[]},404);
await redis.del('overlay:test:'+channel);
await mkdir('/tmp/overlay-check-bin',{recursive:true});
await writeFile('/tmp/overlay-check-bin/yt-dlp','#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "-o" ]; then shift; printf clip-fixture > "$1"; exit 0; fi\nshift\ndone\nexit 1\n');await chmod('/tmp/overlay-check-bin/yt-dlp',0o755);process.env.PATH='/tmp/overlay-check-bin:'+process.env.PATH;
await redis.set(`twitch:${channel}:clips`,JSON.stringify([{url:'https://clips.twitch.tv/FixtureClip',duration:20}]));
preview=await req('POST',channel+'/test',{kind:'clip',destination:'preview'});assert.equal(preview.media.type,'video');assert.equal(await(await fetch(base+preview.media.url)).text(),'clip-fixture');
assert.equal(a.events.filter(e=>e[0]==='overlay-event').length,before);assert(!b.events.some(e=>e[0]==='overlay-event'));
console.log('PASS isolated clip preparation, real trigger selection, empty filters and no legacy broadcasts');
console.log('PASS generated speech fixture isolation, owner access, confirmation and scene-targeted OBS delivery (mocked providers)');
// File retention and events produced during disconnect, followed by simulated process restart.
a.ws.close();await until(()=>live.studioConnections(channel,state.scenes).scenes[0].sources.some(s=>!s.connected),'disconnect');
await writeFile(audio,'durable-audio');await live.publishStudioMedia(channel,'tts',{type:'audio',title:'durable',volume:1},audio,'audio/wav','durable');
await live.publishStudioTrigger(channel,{url:'https://fixture.invalid/image.gif',mediaType:'image/gif',name:'during disconnect'});
assert.equal(await live.publishStudioAlert(channel,'follow',{user_name:'Retained'},'reliability-journal',Date.now(),'twitch',true),2);
const saved=await(await durable.deliveries()).find({channel,recipients:{$ne:[]}}).toArray();assert(saved.some(d=>d.mediaId));
const clientId=a.clientId; b.ws.close();await new Promise(r=>setTimeout(r,100));
await new Promise(r=>io.close(r));io.emit('close');await start();a=await connect(first.publicId,clientId);
await a.wait(e=>e[0]==='overlay-event'&&e[1].kind==='tts');await a.wait(e=>e[0]==='overlay-event'&&e[1].kind==='trigger');await a.wait(e=>e[0]==='overlay-event'&&e[1].id==='alert-reliability-journal');
const resumed=a.events.find(e=>e[0]==='overlay-event'&&e[1].kind==='tts')[1];full=await req('GET',`public/${first.publicId}/events/${resumed.id}`,undefined,200,'');assert.equal(await(await fetch(base+full.media.url)).text(),'durable-audio');
const partial=await fetch(base+full.media.url,{headers:{Range:'bytes=0-6'}});assert.equal(partial.status,206);assert.equal(await partial.text(),'durable');
assert.equal((await fetch(base+full.media.url,{headers:{Range:'bytes=100-200'}})).status,416);
for(const e of a.events.filter(e=>e[0]==='overlay-event'))a.ack(e[1].id);
await until(async()=>!(await live.eventFor(first.publicId,resumed.id)),'durable ack');
a.ws.close();await new Promise(r=>setTimeout(r,100));a=await connect(first.publicId,clientId);assert(!a.events.some(e=>e[0]==='overlay-event'),'completed items do not replay');
assert.equal(await live.publishStudioAlert(channel,'follow',{},'reliability-journal',Date.now(),'twitch',true),0,'journal dedupe survives acknowledgments and restart');
console.log('PASS restart recovery, new media/trigger retention during disconnect, durable audio and completed-event deduplication');
// Bounded backlog and expiration notices.
for(let i=0;i<205;i++)await live.publishStudioTrigger(channel,{url:'https://fixture.invalid/image.png',mediaType:'image/png',name:'burst-'+i});
const key=first.publicId+':'+a.clientId;
assert.equal(await(await durable.deliveries()).countDocuments({channel,recipients:key}),200);
await a.wait(e=>e[0]==='overlay-expired');assert(live.studioConnections(channel,state.scenes).scenes[0].sources[0].dropped>=5);
const realNow=Date.now;
try { Date.now=()=>realNow()+durable.DELIVERY_TTL_MS+1000; await until(async()=>await(await durable.deliveries()).countDocuments({channel,recipients:key})===0,'expired backlog'); }
finally { Date.now=realNow; }
console.log('PASS age-based expiry removes durable backlog');
console.log('PASS 205-event burst is bounded to 200 pending events with visible expiration notices');
// A newer saved draft and its published snapshot survive additive recovery. Retry is idempotent.
const local=structuredClone(state);local.scenes[0].name='Unsaved local';state.scenes[0].name='New remote';state=await req('PUT',channel,state);
await req('PUT',channel,local,409);const recoveryId=crypto.randomUUID();const recovered=await req('POST',channel+'/recover',{...local,recoveryId});
assert.equal(recovered.scenes.length,4);assert.equal(recovered.scenes.find(s=>s.id===first.id).name,'New remote');assert.deepEqual(recovered.scenes.find(s=>s.id===first.id).published,state.scenes[0].published);
const copy=recovered.scenes.find(s=>s.name==='Unsaved local (recovered)');assert(copy&&!copy.published);assert.notEqual(copy.publicId,first.publicId);assert(copy.widgets.find(w=>w.kind==='alert').designId.startsWith('recovered-'));
assert.equal((await req('POST',channel+'/recover',{...local,recoveryId})).revision,recovered.revision);
await req('POST',channel+'/recover',{...local,recoveryId:crypto.randomUUID()},403,'reliability-other');
const oversized={...local,recoveryId:crypto.randomUUID(),scenes:Array.from({length:25},(_,i)=>({...structuredClone(local.scenes[0]),id:'copy'+i}))};await req('POST',channel+'/recover',oversized,409);
assert.equal((await req('GET',channel)).revision,recovered.revision);
console.log('PASS conflict recovery preserves latest/live state, remaps design references, respects limits and safely retries');
a.ws.close();await new Promise(r=>io.close(r));io.emit('close');process.exit(0);
