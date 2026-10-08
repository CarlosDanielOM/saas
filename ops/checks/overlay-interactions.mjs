import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Eventsub from '/app/dist/schemas/eventsub.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { applyInteractionEvent, Interaction, interactionSnapshot, resyncInteractions } from '/app/dist/overlays/interactions.js';
import { activateInteraction, interactionReadiness } from '/app/dist/overlays/interaction-subscriptions.js';
import { createTwitchEventsubApp } from '/app/dist/bot/eventsub.twitch.js';
import { publicState, load, change, validateState, Studio } from '/app/dist/overlays/store.js';
import { registerStudio } from '/app/dist/overlays/live.js';
import { createServer } from 'node:http';
import { Server } from '/app/node_modules/socket.io/dist/index.js';
const target=process.env.SAAS_INTERACTION_TARGET,channel='990702',other='990703',dir='/tmp/saas-fixtures';
const write=(name,value)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(value));
const calls=()=>fs.existsSync(`${dir}/calls.jsonl`)?fs.readFileSync(`${dir}/calls.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function until(check,label){for(let i=0;i<160;i++){if(await check())return;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out: '+label);}
await getMongoDBConnection('interaction-check');const redis=await getDragonflyClient('interaction-check');
await Promise.all([DomainEventSchema.init(),DomainEventDeliverySchema.init(),Interaction.init(),Eventsub.init()]);
for(const id of [channel,other]){await Users.collection.insertOne({name:'Fixture',accounts:[{type:'twitch',id,name:'interactionfixture',actived:true,has_permissions:true,chat_enabled:false}]});await redis.hSet(`accounts:twitch:${id}:data`,{id,name:'interactionfixture',actived:'true',has_permissions:'true',chat_enabled:'false',access_token:'dummy-streamer-token',expires_at:String(Math.floor(Date.now()/1000)+3600)});await redis.hSet('token:fixture-'+id,{id,login:'interactionfixture',display_name:'Fixture'});}
await redis.set('app:twitch:token','app-token');write('remote',[]);
const status=await interactionReadiness(channel);assert.equal(status.poll.state,'missing');assert.equal(status.prediction.state,'missing');
await Promise.all([activateInteraction(channel,'poll'),activateInteraction(channel,'poll')]);assert.equal(calls().length,3,'concurrent activation is idempotent');
await activateInteraction(channel,'prediction');assert.equal(calls().length,7);assert(calls().every(c=>c.authorization==='Bearer app-token'));
await activateInteraction(channel,'poll');assert.equal(calls().length,7);
assert.equal((await interactionReadiness(channel)).prediction.state,'ready');
// A stale local record must not hide a deleted remote subscription.
let remote=JSON.parse(fs.readFileSync(`${dir}/remote.json`));remote=remote.filter(r=>r.type!=='channel.poll.end');write('remote',remote);await activateInteraction(channel,'poll');assert.equal(calls().length,8);
write('scopes',[]);assert.equal((await interactionReadiness(channel)).poll.state,'permission');await assert.rejects(()=>activateInteraction(channel,'poll'),e=>e.status===403);assert.equal(calls().length,8);write('scopes',['channel:read:polls','channel:read:predictions']);
remote=JSON.parse(fs.readFileSync(`${dir}/remote.json`)).filter(r=>r.type!=='channel.prediction.lock');write('remote',remote);write('pending',true);assert.equal((await activateInteraction(channel,'prediction')).prediction.state,'pending');write('pending',false);remote=JSON.parse(fs.readFileSync(`${dir}/remote.json`)).map(r=>({...r,status:'enabled'}));write('remote',remote);
write('failure',true);write('remote',remote.filter(r=>r.type!=='channel.poll.end'));await assert.rejects(()=>activateInteraction(channel,'poll'),e=>e.status===502);write('failure',false);await activateInteraction(channel,'poll');
console.log('PASS manual activation: complete lifecycle, app authorization, duplicates, missing remote, permission denial, pending callback and provider failure.');
if(target==='api'){
 const request=async(method,path,body,expected=200,token='fixture-'+channel)=>{const response=await fetch('http://127.0.0.1:3000/overlay-studio/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result.data;};
 await request('GET',channel+'/twitch-events');await request('POST',channel+'/twitch-events/poll',{});await request('POST',channel+'/twitch-events/invalid',{},400);await request('POST',channel+'/twitch-events/poll',{},403,'fixture-'+other);await request('GET',channel+'/twitch-events',null,401,'bad-token');
 let state=await request('GET',channel);state.scenes[0].widgets.push({id:'poll',kind:'poll',x:20,y:20,width:560,height:360,visible:true,locked:false,interactionDesign:'compact'},{id:'prediction',kind:'prediction',x:600,y:20,width:560,height:460,visible:true,locked:false,interactionDesign:'card'});
 state=await request('PUT',channel,state);const invalid=structuredClone(state);invalid.scenes[0].widgets.at(-1).interactionDesign='custom';await request('PUT',channel,invalid,400);
 state=await request('POST',`${channel}/scenes/${state.scenes[0].id}/publish`,{revision:state.revision});assert.equal(state.scenes[0].published.widgets.at(-2).interactionDesign,'compact');
 console.log('PASS actual API: owner/auth, invalid kind/design, save and published presets.');
}
let webhookServer,webhookURL='http://127.0.0.1:3333/eventsub';
if(target!=='bot'){webhookServer=createTwitchEventsubApp({handleEvent:async()=>{}}).listen(0,'127.0.0.1');await new Promise(r=>webhookServer.once('listening',r));webhookURL=`http://127.0.0.1:${webhookServer.address().port}/eventsub`;}
const start=new Date(Date.now()-30000).toISOString(),deadline=new Date(Date.now()+30000).toISOString();
const poll={broadcaster_user_id:channel,id:'poll-1',title:'Choose a game',started_at:start,ends_at:deadline,choices:[{id:'a',title:'Adventure',votes:0},{id:'b',title:'Racing',votes:0}]};
const prediction={...poll,id:'prediction-1',locks_at:deadline,outcomes:[{id:'a',title:'Yes',users:0,channel_points:0,color:'blue',top_predictors:[{user_id:'private-user'}]},{id:'b',title:'No',users:0,channel_points:0,color:'pink'}]};
async function send(type,event,receipt=crypto.randomUUID(),forged=false){const timestamp=new Date().toISOString(),body=JSON.stringify({subscription:{id:'fixture-'+type,type,version:'1',condition:{broadcaster_user_id:channel}},event});const signature='sha256='+crypto.createHmac('sha256',process.env.TWITCH_EVENTSUB_SECRET).update(receipt).update(timestamp).update(body).digest('hex');const response=await fetch(webhookURL,{method:'POST',headers:{'Content-Type':'application/json','Twitch-Eventsub-Message-Id':receipt,'Twitch-Eventsub-Message-Timestamp':timestamp,'Twitch-Eventsub-Message-Type':'notification','Twitch-Eventsub-Message-Signature':forged?'sha256=bad':signature},body});return {status:response.status,receipt};}
async function complete(receipt){const event=await DomainEventSchema.findOne({sourceEventId:receipt}).lean();assert(event);if(target==='cron')await until(async()=> (await DomainEventDeliverySchema.findOne({eventKey:event.eventKey,consumer:'overlay-interactions-v1'}).lean())?.status==='succeeded','real cron projection '+receipt);else await applyInteractionEvent(event);return event;}
for(const [type,data] of [['channel.poll.begin',poll],['channel.prediction.begin',prediction]]){const r=await send(type,data);assert.equal(r.status,204);await complete(r.receipt);}
let state=await interactionSnapshot(channel);assert.deepEqual(state.poll.choices.map(c=>c.votes),[0,0]);assert(!JSON.stringify(state).includes('private-user'));
poll.choices[0].votes=20;poll.choices[0].channel_points_votes=12;poll.choices[1].votes=10;let sent=await send('channel.poll.progress',poll,'duplicate-progress');assert.equal(sent.status,204);await complete(sent.receipt);const projected=(await interactionSnapshot(channel)).poll;assert.deepEqual(projected.choices.map(c=>[c.votes,c.channelPointsVotes]),[[20,12],[10,0]]);const revision=projected.revision;
assert.equal((await send('channel.poll.progress',poll,'duplicate-progress')).status,204);assert.equal(await DomainEventSchema.countDocuments({sourceEventId:'duplicate-progress'}),1);assert.equal((await interactionSnapshot(channel)).poll.revision,revision);
prediction.outcomes[0].channel_points=1000;prediction.outcomes[0].users=5;sent=await send('channel.prediction.progress',prediction);assert.equal(sent.status,204);await complete(sent.receipt);
sent=await send('channel.prediction.lock',{...prediction,locked_at:new Date().toISOString()});assert.equal(sent.status,204);await complete(sent.receipt);
sent=await send('channel.prediction.progress',prediction);await complete(sent.receipt);assert.equal((await interactionSnapshot(channel)).prediction.phase,'locked');
sent=await send('channel.prediction.end',{...prediction,status:'resolved',winning_outcome_id:'b',ended_at:new Date().toISOString()});assert.equal(sent.status,204);await complete(sent.receipt);assert.equal((await interactionSnapshot(channel)).prediction.winnerId,'b');
sent=await send('channel.poll.end',{...poll,status:'completed',ended_at:new Date().toISOString()});assert.equal(sent.status,204);await complete(sent.receipt);
sent=await send('channel.poll.progress',poll);await complete(sent.receipt);assert.equal((await interactionSnapshot(channel)).poll.phase,'completed');
assert.equal((await send('channel.poll.progress',poll,'forged',true)).status,403);assert.equal((await send('channel.poll.progress',{...poll,choices:[]},'invalid')).status,503);assert.equal(await DomainEventSchema.countDocuments({sourceEventId:{$in:['forged','invalid']}}),0);
assert.equal((await interactionSnapshot(other)).poll,null);
console.log(`PASS ${target} signed ingestion/projection: seven events, zero/progress, duplicates, lock/end monotonicity, privacy, owner isolation and malformed/signature rejection${target==='cron'?' through the real cron consumer':''}.`);
// State is durable without a browser source. Helix recovery supplies a resource begun during downtime.
const newer={...prediction,id:'prediction-2',status:'LOCKED',started_at:new Date().toISOString(),locked_at:new Date().toISOString()};write('prediction-recovery',[newer]);await resyncInteractions(channel,['prediction']);assert.equal((await interactionSnapshot(channel)).prediction.id,'prediction-2');assert.equal((await interactionSnapshot(channel)).prediction.phase,'locked');
write('poll-recovery',[{...poll,id:'poll-recovered',status:'ACTIVE',started_at:new Date().toISOString()}]);await resyncInteractions(channel,['poll']);assert.equal((await interactionSnapshot(channel)).poll.choices[0].channelPointsVotes,12);
if(target==='api'){
 const saved=await load(channel),publicId=saved.scenes[0].publicId;
 const publicResponse=await fetch('http://127.0.0.1:3000/overlay-studio/public/'+publicId);const publicData=(await publicResponse.json()).data;assert.equal(publicData.interactions.poll.choices[0].channelPointsVotes,12);assert.equal(publicData.interactions.prediction.id,'prediction-2');assert(!JSON.stringify(publicData).includes('private-user'));
 const sockets=[];
 async function connect(base,clientId=crypto.randomUUID()){
  const ws=new WebSocket(base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket'),messages=[],ns='/overlay-studio/'+publicId;sockets.push(ws);
  ws.addEventListener('message',event=>{const message=String(event.data);if(message.startsWith('0'))ws.send(`40${ns},${JSON.stringify({clientId})}`);else if(message==='2')ws.send('3');else if(message.startsWith('42'))messages.push(JSON.parse(message.slice(message.indexOf(',')+1)));});
  await until(()=>messages.some(m=>m[0]==='overlay-state'),'socket hydration');return {ws,messages,clientId};
 }
 const a=await connect('http://127.0.0.1:3000');assert.equal(a.messages.find(m=>m[0]==='overlay-state')[1].interactions.prediction.id,'prediction-2');assert.equal(a.messages.find(m=>m[0]==='overlay-state')[1].interactions.poll.choices[0].channelPointsVotes,12);
 const nextPoll={...poll,id:'poll-2',started_at:new Date(Date.now()+1000).toISOString()};sent=await send('channel.poll.begin',nextPoll);await complete(sent.receipt);await until(()=>a.messages.some(m=>m[0]==='overlay-interactions'&&m[1].poll?.id==='poll-2'),'socket live state');
 a.ws.close();const b=await connect('http://127.0.0.1:3000',a.clientId);assert.equal(b.messages.find(m=>m[0]==='overlay-state')[1].interactions.poll.id,'poll-2');
 // A fresh controller (API restart) reconstructs state from Mongo, not peer memory.
 const server=createServer(),io=new Server(server);registerStudio(io);await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=await connect('http://127.0.0.1:'+server.address().port);assert.equal(c.messages.find(m=>m[0]==='overlay-state')[1].interactions.prediction.phase,'locked');
 // Remove widgets from the published scene: public sources stop receiving those aggregates.
 await Studio.updateOne({_id:channel},{$set:{'scenes.0.published.widgets':[]},$inc:{'scenes.0.revision':1}});await until(()=>b.messages.some(m=>m[0]==='overlay-interactions'&&m[1].poll===null&&m[1].prediction===null),'removed widgets clear state');
 assert.equal((await (await fetch('http://127.0.0.1:3000/overlay-studio/public/'+publicId)).json()).data.interactions.poll,null);
 for(const ws of sockets)ws.close();await new Promise(r=>io.close(r));console.log('PASS OBS transport: public snapshot, live totals, reconnect, fresh controller recovery and published widget scoping.');
}
if(webhookServer)await new Promise(r=>webhookServer.close(r));
const tests=spawnSync('node',['--test','--experimental-test-module-mocks','dist/overlays/interaction-model.test.js','dist/domain_events/twitch_eventsub_events.test.js','dist/utils/eventsub_config.test.js','dist/utils/eventsub_reconciliation.test.js'],{encoding:'utf8',timeout:60000,env:{...process.env,NODE_OPTIONS:''}});process.stdout.write(tests.stdout||'');process.stderr.write(tests.stderr||'');assert.equal(tests.status,0);
console.log('PASS isolation: EVENTSUB_RECONCILIATION_ENABLED='+process.env.EVENTSUB_RECONCILIATION_ENABLED);
process.exit(0);
