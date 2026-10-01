import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const require = createRequire('/app/package.json');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('overlay-control-check'); const redis = await getDragonflyClient('overlay-control-check');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const store = await import('/app/dist/overlays/store.js');
const live = await import('/app/dist/overlays/live.js');
const { parse } = await import('/app/dist/utils/ast_parser/parser.js');
const { evaluate, createExecutionContext, getAllRegisteredFunctions } = await import('/app/dist/utils/ast_parser/evaluator.js');
const { registerAllFunctions } = await import('/app/dist/utils/ast_parser/functions/index.js');
const { default: TwitchStreamers } = await import('/app/dist/classes/twitch_streamers.class.js');
const channel = '990081', other = '990082', free = '990083';
for (const [id,tier] of [[channel,'pro'],[other,'pro'],[free,'free']]) {
  await Users.collection.insertOne({ accounts:[{type:'twitch',id},{type:'kick',id:'kick-'+id}], plan_tier:tier });
  await redis.hSet('token:control-'+id,{id,login:'fixture-'+id,display_name:'Fixture'});
}
let base='http://127.0.0.1:3000';
async function request(method,path,body,status=200,token='control-'+channel) {
 const response=await fetch(base+'/overlay-studio/'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result.data;
}
for(const method of ['GET','POST']) {
 await request(method,channel+'/queue',method==='POST'?{action:'clear',platform:'all'}:undefined,401,'');
 await request(method,channel+'/queue',method==='POST'?{action:'clear',platform:'all'}:undefined,403,'control-'+other);
 await request(method,free+'/queue',method==='POST'?{action:'pause',platform:'all'}:undefined,403,'control-'+free);
}
for(const body of [{action:'delete',platform:'all'},{action:'clear',platform:'youtube'},{action:'pause'},{action:['skip'],platform:'twitch'},{}]) await request('POST',channel+'/queue',body,400);
let status=await request('GET',channel+'/queue');assert.equal(status.state.all,false);
status=await request('POST',channel+'/queue',{action:'pause',platform:'twitch'});assert.equal(status.state.all,false,'first platform pause returns a complete state');assert.equal(status.state.platforms.twitch,true);
status=await request('POST',channel+'/queue',{action:'pause',platform:'all'});assert.equal(status.state.all,true);
status=await request('POST',channel+'/queue',{action:'resume',platform:'twitch'});assert.equal(status.state.all,true);assert.equal(status.state.platforms.twitch,false);
assert.equal((await store.Studio.findById(channel).lean()).controls.platforms.twitch,false,'pause state is persisted outside browser and API memory');
assert.equal((await request('GET',other+'/queue',undefined,200,'control-'+other)).state.all,false,'owner isolation');

registerAllFunctions(); TwitchStreamers.getAccountTokenById=async id=>'control-'+id;
const ctx=extra=>createExecutionContext({broadcasterId:channel,platform:'twitch',userLevel:7,userPlan:'pro',...extra});
const run=async(text,extra={})=>(await evaluate(parse(text).ast,ctx(extra))).value;
for(const action of ['pause','resume','skip','clear']) for(const suffix of ['','.twitch','.kick']) assert.equal(await run(`$(overlay.${action}${suffix})`),'');
assert.match(String(await run('$(overlay.clear)',{userLevel:1})),/permission/i);
assert.match(String(await run('$(overlay.clear 990082)')),/Usage/);
assert.match(String(await run('$(overlay.clear)',{broadcasterId:free})),/Pro/);
assert.equal(await run('$(overlay.pause.kick)',{platform:'kick',broadcasterId:'kick-'+channel}),'','linked Kick context resolves its own Studio');
assert.match(String(await run('$(overlay.clear)',{platform:'kick',broadcasterId:'not-linked'})),/Error/);
assert.equal(getAllRegisteredFunctions().filter(entry=>entry.name.startsWith('overlay.')).length,12);
await request('POST',channel+'/queue',{action:'resume',platform:'all'});
console.log('PASS actual API and AST: owner/plan permissions, invalid input, all 12 names, moderator gate, linked account resolution and persisted platform overrides.');

// Exercise the actual Socket.IO controller with synthetic event origins. This
// isolated API instance shares disposable Mongo only, never production data.
const express=require('express'),{Server}=require('socket.io');
const app=express();app.use(express.json());app.use('/overlay-studio',(await import('/app/dist/server/routes/overlay-studio.route.js')).overlayStudioRoute);
const server=createServer(app), io=new Server(server);live.registerStudio(io);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
let state=await request('GET',channel);state.scenes[0].widgets.find(w=>w.kind==='alert').events=['follow'];
state=await request('PUT',channel,state);state=await request('POST',`${channel}/scenes/${state.scenes[0].id}/publish`,{revision:state.revision});const publicId=state.scenes[0].publicId;
async function connect(clientId=crypto.randomUUID()) {
 const ws=new WebSocket(base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket'), messages=[], ns='/overlay-studio/'+publicId;
 ws.addEventListener('message',event=>{const m=String(event.data);if(m.startsWith('0'))ws.send(`40${ns},${JSON.stringify({clientId})}`);else if(m==='2')ws.send('3');else if(m.startsWith('42'))messages.push(JSON.parse(m.slice(m.indexOf(',')+1)));});
 const send=(name,value)=>ws.send(`42${ns},${JSON.stringify([name,value])}`);
 await until(()=>messages.some(m=>m[0]==='overlay-state'));
 return {ws,messages,send,clientId};
}
async function until(fn) {for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('condition timeout');}
const a=await connect(),b=await connect();
for(const platform of ['twitch','kick','other']) live.publishStudioAlert(channel,'follow',{user_name:platform},platform,Date.now(),platform);
await until(()=>a.messages.filter(m=>m[0]==='overlay-event').length===3);
const events=a.messages.filter(m=>m[0]==='overlay-event').map(m=>m[1]);assert.deepEqual(events.map(e=>e.platform),['twitch','kick','other']);
const [tw,ki,ot]=events.map(e=>e.id);
for(const event of events) assert.equal((await request('GET',`public/${publicId}/events/${event.id}`,undefined,200,'')).platform,event.platform);
a.send('overlay-playback',{active:[tw],queued:[ki,ot]});b.send('overlay-playback',{active:[tw],queued:[ki,ot]});
await until(async()=>(await request('GET',channel+'/queue')).needsRefresh===0);
status=await request('GET',channel+'/queue');assert.equal(status.events.length,3,'duplicate OBS sources do not double-count events');
await request('POST',channel+'/queue',{action:'clear',platform:'kick'});
await until(()=>a.messages.some(m=>m[0]==='overlay-control'));
const clear=a.messages.find(m=>m[0]==='overlay-control')[1];assert.deepEqual(clear.eventIds,[ki]);assert.equal(clear.action,'clear');
assert.deepEqual(b.messages.find(m=>m[0]==='overlay-control')[1].eventIds,[ki]);
// Controls are replayed after a lost acknowledgement, carrying original IDs.
a.ws.close();await new Promise(r=>setTimeout(r,80));const reconnected=await connect(a.clientId);
assert.equal(reconnected.messages.find(m=>m[0]==='overlay-state')[1].commands[0].id,clear.id);
reconnected.send('overlay-control-ack',clear.id);await new Promise(r=>setTimeout(r,60));
reconnected.ws.close();await new Promise(r=>setTimeout(r,80));const again=await connect(a.clientId);
assert.deepEqual(again.messages.find(m=>m[0]==='overlay-state')[1].commands,[]);
await request('POST',channel+'/queue',{action:'pause',platform:'twitch'});
await until(()=>again.messages.some(m=>m[0]==='overlay-queue-state'&&m[1].platforms.twitch===true));
assert.equal((await request('GET',`public/${publicId}`,undefined,200,'')).controls.platforms.twitch,true,'new sources inherit persisted pause');
// A source cannot fabricate events owned by another source/account.
again.send('overlay-playback',{active:['foreign-event'],queued:[]});await new Promise(r=>setTimeout(r,60));
assert.equal((await request('GET',channel+'/queue')).events.length,3);
await request('POST',channel+'/queue',{action:'skip',platform:'all'});
await until(()=>again.messages.some(m=>m[0]==='overlay-control'&&m[1].action==='skip'));
assert.deepEqual(new Set(again.messages.find(m=>m[0]==='overlay-control'&&m[1].action==='skip')[1].eventIds),new Set([tw,ki,ot]));
again.ws.close();b.ws.close();await new Promise(resolve=>io.close(resolve));
console.log('PASS Socket.IO: origin labels, exact platform targets, all-scene fanout, deduplicated status, persisted pause on reconnect, missed-command replay/ack and report validation.');
process.exit(0);
