// Disposable dependencies and duel-fixtures only. No live data or providers.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const require=createRequire('/app/package.json');
const svc=await import('/app/dist/duel/service.js'),domain=await import('/app/dist/duel/model.js');
const {duelCommand}=await import('/app/dist/commands/duel.command.js');
const {DuelModeratorRestore}=await import('/app/dist/duel/completion.js');
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('duel-test');const redis=await getDragonflyClient('duel-test');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const {encrypt}=await import('/app/dist/utils/crypto.js');
const channel='991801',other='991802';
for(const [id,name,tier] of [[channel,'duelfixture','pro'],[other,'other','free'],['698614112','domdimabot','pro']]){
 await Users.collection.insertOne({accounts:[{id,type:'twitch',name,has_permissions:true,up_to_date_permissions:true,actived:true,chat_enabled:false,access_token:encrypt('fixture'),refresh_token:encrypt('fixture-refresh'),access_token_expires_at:Math.floor(Date.now()/1000)+3600}],plan_tier:tier});
 await redis.hSet('accounts:twitch:'+id+':data',{id,name,has_permissions:'true',access_token:'fixture',expires_at:String(Math.floor(Date.now()/1000)+3600),userPlan:tier});
}
await redis.set('app:twitch:token','fixture',{EX:3600});
await redis.hSet('token:duel-owner',{id:channel,login:'duelfixture',display_name:'Duel Fixture'});
await redis.hSet('token:duel-other',{id:other,login:'other',display_name:'Other'});
await svc.DuelChannel.init();await DuelModeratorRestore.init();
let base='http://127.0.0.1:3000',server,io;
if(process.env.SAAS_TARGET!=='api'){
 const express=require('express'),app=express();app.use(express.json());app.use('/widgets',(await import('/app/dist/server/routes/widgets.route.js')).widgetsRoute);
 server=createServer(app);io=new(require('socket.io').Server)(server,{connectionStateRecovery:{}});(await import('/app/dist/server/services/duel-overlay.service.js')).registerDuelOverlay(io);
 await new Promise(resolve=>server.listen(3210,'127.0.0.1',resolve));base='http://127.0.0.1:3210';
}
const root='/widgets/'+channel+'/duel';
async function request(method,path,body,status=200,token='duel-owner',headers={}){const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data.data;}
const calls=()=>{try{return readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
const chats=()=>calls().filter(c=>c.path==='/helix/chat/messages');const mods=()=>calls().filter(c=>c.path.includes('/moderation/'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check,message,seconds=10){for(let n=0;n<seconds*20;n++){if(await check())return;await sleep(50);}throw new Error(message);}
async function config(patch){const s=await request('GET',root);return request('POST',root+'/configure',{...s.settings,...patch},200,'duel-owner',{'If-Match':String(s.revision),'Idempotency-Key':crypto.randomUUID()});}
const once=()=>execFileSync('node',['/app/dist/workers/duel.worker.js','--once'],{encoding:'utf8'});
async function finish(){await svc.DuelChannel.updateOne({_id:channel},{$set:{'run.endsAt':Date.now()-1,dueAt:Date.now()-1}});once();await wait(async()=>(await svc.loadDuel(channel)).run?.completedAt,'duel completion');}
function connect(token,ready=true){
 const ws=new WebSocket(base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket'),packets=[];
 ws.addEventListener('message',event=>{const text=String(event.data);if(text.startsWith('0'))ws.send('40/overlays/duel/'+channel+','+JSON.stringify({token}));else if(text==='2')ws.send('3');else{packets.push(text);if(ready&&text.includes('duel-state'))ws.send('42/overlays/duel/'+channel+','+JSON.stringify(['duel-ready',{version:1}]));}});
 const heartbeat=setInterval(()=>{if(ready&&ws.readyState===1)ws.send('42/overlays/duel/'+channel+','+JSON.stringify(['duel-ready',{version:1}]));},1000);
 return {ws,packets,close(){clearInterval(heartbeat);ws.close();}};
}
await request('GET',root,undefined,401,'');await request('GET',root,undefined,403,'duel-other');
const {AdminSchema}=await import('/app/dist/schemas/admin.schema.js');await AdminSchema.collection.insertOne({channelID:channel,adminID:other,actived:true,permissions:['dashboard:view']});await request('GET',root,undefined,403,'duel-other');await AdminSchema.updateOne({adminID:other},{$set:{permissions:['*']}});await request('GET',root,undefined,200,'duel-other');await AdminSchema.deleteMany({adminID:other});
await request('GET','/widgets/'+other+'/duel',undefined,403,'duel-other');
let state=await request('GET',root);assert.equal(state.settings.timeoutSeconds,60);assert.equal(state.settings.timeoutEnabled,true);
for(const value of [0,-1,1.5,1209601,'60'])await request('POST',root+'/configure',{...state.settings,timeoutSeconds:value},400,'duel-owner',{'If-Match':String(state.revision),'Idempotency-Key':crypto.randomUUID()});
await request('POST',root+'/configure',{...state.settings,winner:'left'},400,'duel-owner',{'If-Match':String(state.revision),'Idempotency-Key':crypto.randomUUID()});
const key=crypto.randomUUID(),body={...state.settings,timeoutEnabled:false};const saved=await request('POST',root+'/configure',body,200,'duel-owner',{'If-Match':String(state.revision),'Idempotency-Key':key});await request('POST',root+'/configure',body,200,'duel-owner',{'If-Match':String(state.revision),'Idempotency-Key':key});assert.equal((await request('GET',root)).revision,saved.revision);await request('POST',root+'/configure',body,409,'duel-owner',{'If-Match':String(state.revision),'Idempotency-Key':crypto.randomUUID()});
assert((await duelCommand(channel,'alice',false,'alice')).error);assert((await duelCommand(channel,'alice',false,'duelfixture')).error);await redis.sAdd('twitch:'+channel+':editors','editor');assert((await duelCommand(channel,'editor',false,'bob')).error);assert((await duelCommand(channel,'alice',false,'editor')).error);
const token=(await request('POST',root+'/overlay-token',{})).token;assert.equal(token.length,43);
await request('POST',root+'/configure',body,401,token,{'If-Match':'0','Idempotency-Key':'unauthorized'});
const invalid=connect('x'.repeat(43));await wait(()=>invalid.packets.some(p=>p.startsWith('44/')),'invalid token rejection');invalid.close();
const unread=connect(token,false);await wait(()=>unread.packets.some(p=>p.includes('duel-state')),'state');assert.equal(await svc.overlayActive(await svc.loadDuel(channel)),false,'unready socket is not active');unread.close();await sleep(600);
const source=connect(token);await wait(async()=>await svc.overlayActive(await svc.loadDuel(channel)),'ready OBS presence');
const snapshot=JSON.parse(source.packets.find(p=>p.includes('duel-state')).split(',').slice(1).join(','))[1];assert.equal(snapshot.tokenHash,undefined);
// Force an unreadable snapshot without changing its revision, then recover.
const currentConfig=(await svc.loadDuel(channel)).settings;
await svc.DuelChannel.updateOne({_id:channel},{$set:{settings:null}});
await wait(()=>source.packets.some(p=>p.includes('duel-error')),'temporary state error');
await wait(async()=>!await redis.get(svc.presenceKey(channel)),'failed source clears presence');
const snapshotCount=source.packets.filter(p=>p.includes('duel-state')).length;
await svc.DuelChannel.updateOne({_id:channel},{$set:{settings:currentConfig}});
await wait(()=>source.packets.filter(p=>p.includes('duel-state')).length>snapshotCount,'fresh snapshot after recovery');
await wait(async()=>await svc.overlayActive(await svc.loadDuel(channel)),'recovered readiness');
const before=chats().length,modBefore=mods().length;
assert.equal((await duelCommand(channel,'alice',false,'@bob')).message,'','overlay suppresses challenge');await wait(()=>source.packets.some(p=>p.includes('"opponent":"bob"')),'challenge prompt');
assert((await duelCommand(channel,'alice',false,'accept')).error,'only challenged user accepts');
const accepted=await Promise.all([duelCommand(channel,'bob',false,'accept'),duelCommand(channel,'bob',false,'accept')]);assert.equal(accepted.filter(r=>!r.error).length,1);assert.equal(accepted.find(r=>!r.error).message,'');
let run=(await svc.loadDuel(channel)).run;assert.equal(run.mode,'overlay');assert.equal(run.phrases.length,0);assert(['left','right'].includes(run.winner));assert.equal(run.endsAt-run.startedAt,11400);
source.close();await wait(async()=>!await svc.overlayActive(await svc.loadDuel(channel)),'disconnect clears presence');
await sleep(1200);once();assert.equal(chats().length,before,'no early winner or battle messages');
await sleep(Math.max(0,run.endsAt-Date.now()+100));if(process.env.SAAS_TARGET!=='cron')once();await wait(()=>chats().length===before+1,'supervised winner after end');assert(chats().at(-1).at>=run.endsAt);assert.equal(chats().at(-1).body.message,domain.winnerMessage(run));assert.equal(mods().length,modBefore,'disabled timeout makes no moderation calls');once();assert.equal(chats().length,before+1,'winner cannot repeat');
assert((await duelCommand(channel,'alice',false,'bob')).message.includes('has challenged'));const chatCount=chats().length;await duelCommand(channel,'bob',false,'accept');run=(await svc.loadDuel(channel)).run;assert.equal(run.mode,'chat');assert(run.phrases.length>=2&&run.phrases.length<=4);
await svc.DuelChannel.updateOne({_id:channel},{$set:{'run.phrases':run.phrases.map((p,i)=>({...p,at:Date.now()-1000+i})),dueAt:Date.now()-1000}});for(let i=0;i<run.phrases.length;i++)once();await wait(()=>chats().length===chatCount+run.phrases.length,'chat narration');assert.equal(chats().length,chatCount+run.phrases.length,'chat narration retained');await finish();assert.equal(chats().length,chatCount+run.phrases.length+1);
await config({timeoutEnabled:true,timeoutSeconds:17});writeFileSync('/tmp/saas-fixtures/mods.json',JSON.stringify(['991811','991812']));
await duelCommand(channel,'alice',false,'bob');await duelCommand(channel,'bob',true,'accept','WRONG_REQUESTING_MODERATOR');run=(await svc.loadDuel(channel)).run;await finish();const ban=calls().filter(c=>c.path==='/helix/moderation/bans').at(-1);assert.equal(ban.body.data.duration,17);assert.equal(ban.query.moderator_id,'698614112');const restore=await DuelModeratorRestore.findById(run.id).lean();assert(restore);assert(restore.dueAt>Date.now()+16000);await DuelModeratorRestore.updateOne({_id:run.id},{$set:{dueAt:Date.now()-1}});once();assert.equal(await DuelModeratorRestore.countDocuments({_id:run.id}),0,'new worker restores moderator');
await config({timeoutEnabled:true});await duelCommand(channel,'alice',false,'bob');await duelCommand(channel,'bob',false,'accept');await config({timeoutEnabled:false});const n=mods().length;await finish();assert.equal(mods().length,n,'switch off applies to an accepted battle');
await config({timeoutEnabled:true});writeFileSync('/tmp/saas-fixtures/fail-ban','1');await duelCommand(channel,'alice',false,'bob');await duelCommand(channel,'bob',false,'accept');const winnerBefore=chats().length;await finish();assert.equal(chats().length,winnerBefore+1,'permission failure does not hide winner');assert((await svc.loadDuel(channel)).run.timeoutError);unlinkSync('/tmp/saas-fixtures/fail-ban');
// Twitch may apply demotion but lose the response: restoration must remain durable.
writeFileSync('/tmp/saas-fixtures/mods.json',JSON.stringify(['991811','991812']));
writeFileSync('/tmp/saas-fixtures/fail-remove-response','1');
await duelCommand(channel,'alice',false,'bob');await duelCommand(channel,'bob',false,'accept');
const bansBefore=calls().filter(c=>c.path==='/helix/moderation/bans').length;
run=(await svc.loadDuel(channel)).run;await finish();
assert((await svc.loadDuel(channel)).run.timeoutError);
assert.equal(calls().filter(c=>c.path==='/helix/moderation/bans').length,bansBefore);
await wait(()=>JSON.parse(readFileSync('/tmp/saas-fixtures/mods.json','utf8')).length===2,'restore after lost removal response');
unlinkSync('/tmp/saas-fixtures/fail-remove-response');
const source2=connect(token);await wait(async()=>await svc.overlayActive(await svc.loadDuel(channel)),'reconnect');await config({enabled:false});assert.equal(await svc.overlayActive(await svc.loadDuel(channel)),false);assert((await duelCommand(channel,'alice',false,'bob')).message.includes('has challenged'));await duelCommand(channel,'bob',false,'decline');await config({enabled:true});
const replacement=(await request('POST',root+'/overlay-token',{})).token;assert.notEqual(replacement,token);await wait(()=>source2.ws.readyState===3,'rotated source disconnected');source2.close();assert.equal(await svc.authorizeDuelOverlay(channel,token),false);await redis.set(svc.presenceKey(channel),JSON.stringify({hash:svc.tokenHash(replacement),at:Date.now()-6000}),{EX:5});assert.equal(await svc.overlayActive(await svc.loadDuel(channel)),false,'stale presence falls back to chat');
const winners=new Set(Array.from({length:128},()=>domain.createRun({id:'test',challenger:'alice',opponent:'bob',expiresAt:Date.now()},domain.defaultSettings(),true,Date.now()).winner));assert.deepEqual([...winners].sort(),['left','right']);
if(io)await new Promise(resolve=>io.close(resolve));
await redis.quit();await (await getMongoDBConnection('duel-test-close')).disconnect();console.log('PASS duel '+process.env.SAAS_TARGET+': overlay/chat, deadlines, settings, tokens, concurrency, timeout safety and durable moderator restoration');process.exit(0);
