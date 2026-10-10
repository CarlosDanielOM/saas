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
// Turn-based battle invariants: alternate turns unless an extra turn was rolled,
// damage within the move's range, and the first fighter to reach 0 HP loses.
function checkBattle(run){
 const hp={left:100,right:100},heals={left:0,right:0};assert(run.turns.length>0);assert.notEqual(run.fighters.left,run.fighters.right);
 run.turns.forEach((t,i)=>{const spec=t.move==='heal'?domain.HEAL:domain.MOVES[t.move];assert(spec,'known move');assert.equal(t.hitAt-t.at,spec.windup);
  if(i){const prev=run.turns[i-1];assert.equal(t.attacker===prev.attacker,t.bonus,'extra turn keeps the attacker');assert(t.at>=prev.at+(prev.move==='heal'?domain.HEAL:domain.MOVES[prev.move]).duration+(prev.comboHeal?domain.COMBO_HEAL.extra:0));}
  assert(hp.left>0&&hp.right>0,'no turns after a knockout');
  if(t.move==='heal'){assert(hp[t.attacker]<=domain.HEAL.threshold,'only hurt fighters heal');assert(t.heal>=domain.HEAL.min&&t.heal<=domain.HEAL.max);assert(++heals[t.attacker]<=domain.HEAL.perFighter,'heal limit');assert.equal(t.damage,0);hp[t.attacker]=Math.min(100,hp[t.attacker]+t.heal);return;}
  assert(t.raw>=spec.min&&t.raw<=spec.max,'damage range');const hit=t.raw*(t.crit?2:1);
  if(t.defended&&t.move==='special')assert.equal(t.damage,hit,'specials shatter the defense at full damage');else if(t.defended){if(t.move==='normal'){assert.equal(t.damage,0);assert.equal(t.crit,false,'a blocked crit is just a block');}else assert.equal(t.damage,Math.round(hit*domain.HEAVY_DEFENDED_RATIO),'heavy -80%');}else assert.equal(t.damage,hit,'crit doubles damage');
  const defender=t.attacker==='left'?'right':'left';hp[defender]=Math.max(0,hp[defender]-t.damage);
  if(t.comboHeal){assert(t.defended&&t.move!=='special','only blocked normal/heavy attacks chain a heal');assert(hp[defender]>0&&t.comboHeal<=domain.HEAL.max&&hp[defender]+t.comboHeal<=100);assert(++heals[defender]<=domain.HEAL.perFighter,'combo heals use charges');hp[defender]+=t.comboHeal;}});
 const loser=run.winner==='left'?'right':'left';assert.equal(hp[loser],0);assert(hp[run.winner]>0);assert.equal(run.turns.at(-1).attacker,run.winner);assert.equal(domain.remainingHp(run.turns,run.winner),hp[run.winner]);
 assert.equal(run.endsAt-run.startedAt,run.turns.at(-1).hitAt+domain.KNOCKOUT_MS);
}
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
assert((await duelCommand(channel,'alice',false,'alice')).error);assert((await duelCommand(channel,'duelfixture',false,'duelfixture')).error,'the streamer cannot duel itself');await redis.sAdd('twitch:'+channel+':editors','editor');
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
let run=(await svc.loadDuel(channel)).run;assert.equal(run.mode,'overlay');assert.equal(run.phrases.length,0);assert(['left','right'].includes(run.winner));checkBattle(run);
await wait(()=>source.packets.some(p=>p.includes(run.id)&&p.includes('"turns"')),'overlay receives the battle');const live=JSON.parse(source.packets.find(p=>p.includes(run.id)&&p.includes('"turns"')).split(',').slice(1).join(','))[1];assert.deepEqual(live.run.turns,run.turns,'overlay animates the server battle');assert.deepEqual(live.run.fighters,run.fighters);
source.close();await wait(async()=>!await svc.overlayActive(await svc.loadDuel(channel)),'disconnect clears presence');
// Fights now run 15-40 s; pull the real deadline in so the check stays inside the helper's 300 s limit.
await svc.DuelChannel.updateOne({_id:channel},{$set:{'run.endsAt':Date.now()+8000,dueAt:Date.now()+8000}});run=(await svc.loadDuel(channel)).run;
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
// Streamer fights: auto-accepted, enraged, never timed out (even when losing).
const bansBeforeStreamer=calls().filter(c=>c.path==='/helix/moderation/bans').length,modsBeforeStreamer=mods().length;
const vsStreamer=await duelCommand(channel,'alice',false,'@duelfixture');assert(!vsStreamer.error,vsStreamer.message);assert.match(vsStreamer.message,/enraged streamer accepts/);
let streamerRun=(await svc.loadDuel(channel)).run;assert.equal((await svc.loadDuel(channel)).challenge,null,'no accept step');assert.equal(streamerRun.enraged,'right');assert.equal(streamerRun.opponent,'duelfixture');checkBattle(streamerRun);
assert.equal((await duelCommand(channel,'bob',false,'@duelfixture')).status,409,'one fight at a time');
await svc.DuelChannel.updateOne({_id:channel},{$set:{'run.winner':'left'}});await finish();
assert.equal(calls().filter(c=>c.path==='/helix/moderation/bans').length,bansBeforeStreamer,'a losing streamer is never timed out');assert.equal(mods().length,modsBeforeStreamer,'no moderation lookups for the streamer');assert.match(chats().at(-1).body.message,/defeated the enraged streamer @duelfixture/);
const byStreamer=await duelCommand(channel,'duelfixture',false,'@bob');assert.match(byStreamer.message,/enraged streamer @duelfixture has challenged @bob/);assert.equal((await svc.loadDuel(channel)).challenge.enraged,'left');
await duelCommand(channel,'bob',false,'accept');streamerRun=(await svc.loadDuel(channel)).run;assert.equal(streamerRun.enraged,'left');checkBattle(streamerRun);await finish();
// Editors may duel (normal odds) and are never timed out; challenges last 30 seconds.
const bansBeforeEditor=calls().filter(c=>c.path==='/helix/moderation/bans').length,modsBeforeEditor=mods().length;
assert(!(await duelCommand(channel,'editor',false,'@bob')).error,'editors can challenge');let editorChallenge=(await svc.loadDuel(channel)).challenge;
assert(editorChallenge.expiresAt-Date.now()<=30000&&editorChallenge.expiresAt-Date.now()>25000,'30-second challenge');assert.equal(editorChallenge.enraged??null,null,'editors are not enraged');
await svc.DuelChannel.updateOne({_id:channel},{$set:{'challenge.expiresAt':Date.now()-1,dueAt:Date.now()-1}});once();assert.equal((await svc.loadDuel(channel)).challenge,null,'an unanswered challenge expires');
assert(!(await duelCommand(channel,'alice',false,'@editor')).error,'editors can be challenged');assert(!(await duelCommand(channel,'editor',false,'accept')).error,'editors can accept');
let editorRun=(await svc.loadDuel(channel)).run;assert.equal(editorRun.enraged??null,null);checkBattle(editorRun);
await svc.DuelChannel.updateOne({_id:channel},{$set:{'run.winner':'left'}});await finish();
assert.equal(calls().filter(c=>c.path==='/helix/moderation/bans').length,bansBeforeEditor,'a losing editor is never timed out');assert.equal(mods().length,modsBeforeEditor,'no moderation lookups for an editor');
const enragedWins=Array.from({length:2000},()=>domain.simulateBattle(undefined,'right')).filter(b=>b.winner==='right').length/2000;assert(enragedWins>.75&&enragedWins<.9,'the enraged streamer usually wins, but not always: '+enragedWins);
const runs=Array.from({length:2000},()=>domain.createRun({id:'test',challenger:'alice',opponent:'bob',expiresAt:Date.now()},domain.defaultSettings(),true,Date.now()));runs.forEach(checkBattle);
assert.deepEqual([...new Set(runs.map(r=>r.winner))].sort(),['left','right']);const share=runs.filter(r=>r.winner==='left').length/runs.length;assert(share>.43&&share<.57,'no side is favoured: '+share);
const moves=runs.flatMap(r=>r.turns.map(t=>t.move)),count=m=>moves.filter(x=>x===m).length;assert(count('normal')>count('heavy')&&count('heavy')>count('special')&&count('special')>0,'normal > heavy > special');
assert(runs.some(r=>r.turns.some(t=>t.bonus)),'extra turns happen');
const defendable=runs.flatMap(r=>r.turns.filter(t=>t.move!=='special')),defended=defendable.filter(t=>t.defended);assert(defended.length/defendable.length>.11&&defended.length/defendable.length<.19,'small defense chance');assert(defended.some(t=>t.move==='normal')&&defended.some(t=>t.move==='heavy'));
const narrated=Array.from({length:300},()=>domain.createRun({id:'test',challenger:'alice',opponent:'bob',expiresAt:Date.now()},domain.defaultSettings(),false,Date.now())).flatMap(r=>r.phrases.map(p=>p.text));assert(narrated.some(t=>/uses (Shield Wall|Ghost Step|Arcane Ward)/.test(t)),'chat narrates defenses');
const attacks=runs.flatMap(r=>r.turns.filter(t=>t.move!=='heal')),critShare=attacks.filter(t=>t.crit).length/attacks.length;assert(critShare>.06&&critShare<.12,'crit chance: '+critShare);assert(attacks.some(t=>t.crit&&t.move==='special'),'specials can crit');
assert(runs.some(r=>r.turns.some(t=>t.move==='heal')),'heals happen');assert(runs.some(r=>r.turns.some(t=>t.comboHeal>0)),'block combos heal');assert(narrated.some(t=>/COMBO! @\w+ blocks with/.test(t)),'chat narrates combo heals');assert(narrated.some(t=>/angel descends|healing potion|life glyphs/.test(t)),'chat narrates heals');assert(narrated.some(t=>/CRITICAL/.test(t)),'chat narrates crits');assert(runs.some(r=>r.turns.some(t=>t.move==='special'&&t.defended)),'specials can shatter a defense');assert(narrated.some(t=>/shatters it/.test(t)),'chat narrates shattered defenses');assert.deepEqual([...new Set(runs.flatMap(r=>[r.fighters.left,r.fighters.right]))].sort(),['knight','mage','ronin']);
const chatRun=domain.createRun({id:'test',challenger:'alice',opponent:'bob',expiresAt:Date.now()},{...domain.defaultSettings(),language:'es'},false,Date.now());assert(chatRun.phrases.every(p=>p.at>chatRun.startedAt&&p.at<chatRun.endsAt));assert.match(domain.winnerMessage(chatRun),/ha ganado el duelo contra @\w+ con \d+ HP restantes\.$/);
assert.equal(domain.winnerMessage({...chatRun,turns:undefined}),'@'+domain.winnerLogin(chatRun)+' ha ganado el duelo contra @'+domain.loserLogin(chatRun)+'.','legacy runs keep the old message');
if(io)await new Promise(resolve=>io.close(resolve));
await redis.quit();await (await getMongoDBConnection('duel-test-close')).disconnect();console.log('PASS duel '+process.env.SAAS_TARGET+': overlay/chat, deadlines, settings, tokens, concurrency, timeout safety and durable moderator restoration');process.exit(0);
