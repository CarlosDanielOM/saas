// Run only with saas-ops, disposable Mongo/Redis, and widgets-fixtures.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const require=createRequire('/app/package.json');
const svc=await import('/app/dist/widgets/service.js');
const domain=await import('/app/dist/widgets/model.js');
const {catalog}=await import('/app/dist/widgets/catalog.js');
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('widgets-test');const redis=await getDragonflyClient('widgets-test');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const {encrypt}=await import('/app/dist/utils/crypto.js');
if(process.env.SAAS_TARGET==='bot'){
 const response=await fetch('http://127.0.0.1:3333/eventsub',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,403,'normal bot entrypoint rejects unsigned events');
}
await svc.WidgetChannel.init();
assert.equal(catalog.entries.length,419);assert.equal(catalog.packs.length,6);
const channel='991801',other='991802';
await Users.collection.insertOne({accounts:[{id:channel,type:'twitch',name:'widgetfixture',has_permissions:true,up_to_date_permissions:true,actived:true,chat_enabled:false,access_token:encrypt('fixture'),refresh_token:encrypt('fixture-refresh'),access_token_expires_at:Math.floor(Date.now()/1000)+3600}],plan_tier:'pro'});
await Users.collection.insertOne({accounts:[{id:other,type:'twitch'}],plan_tier:'premium'});
await redis.hSet('token:widgets-owner',{id:channel,login:'widgetfixture',display_name:'Widget Fixture'});
await redis.hSet('token:widgets-other',{id:other,login:'other',display_name:'Other'});
await redis.hSet('accounts:twitch:'+channel+':data',{id:channel,name:'widgetfixture',has_permissions:'true',access_token:'fixture',expires_at:String(Math.floor(Date.now()/1000)+3600),userPlan:'pro'});
let base='http://127.0.0.1:3000',testServer,io;
if(process.env.SAAS_TARGET!=='api'){
 const express=require('express');const app=express();app.use(express.json());app.use('/widgets',(await import('/app/dist/server/routes/widgets.route.js')).widgetsRoute);
 testServer=createServer(app);io=new (require('socket.io').Server)(testServer,{connectionStateRecovery:{}});
 (await import('/app/dist/server/services/widgets-overlay.service.js')).registerWidgetOverlay(io);
 await new Promise(resolve=>testServer.listen(3210,'127.0.0.1',resolve));base='http://127.0.0.1:3210';
}
const root='/widgets/'+channel;
async function request(method,path,body,status=200,token='widgets-owner',headers={}){
 const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));const data=value.data;if(data?.resultPhase){assert.equal(data.phase,data.resultPhase==='character-result'?'character-spin':'perk-spin','legacy OBS keeps the correct roulette');return {...data,phase:data.resultPhase};}return data;
}
await request('GET',root,undefined,401,'');await request('GET',root,undefined,403,'widgets-other');
await request('GET','/widgets/'+other,undefined,403,'widgets-other');
await request('GET',root+'/catalog');
let state=await request('GET',root);assert.equal(state.phase,'idle');
async function action(name,body={},status=200,key=crypto.randomUUID(),revision=state.revision){if(status===200&&arguments.length<5){state=await request('GET',root);revision=state.revision;}const result=await request('POST',root+'/actions/'+name,body,status,'widgets-owner',{'Idempotency-Key':key,'If-Match':String(revision)});if(status===200)state=result;return result;}
async function waitPollClaim(){
 // The supervised worker can own the claim while its first AST import finishes.
 // Read Mongo directly so this wait cannot advance the challenge itself.
 for(let i=0;i<225;i++){
  const doc=await svc.WidgetChannel.findById(channel).lean();
  if(!['character-spin','character-result','poll-starting'].includes(doc.state.phase))return;
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 throw new Error('The worker did not finish its poll claim within 45 seconds');
}
await action('configure',{...state.config,spinSeconds:1,pollSeconds:15});
assert.equal(state.config.characterDesign,'cards');
for(const characterDesign of ['invalid',null,42])await action('configure',{...state.config,characterDesign},400);
assert.equal(state.config.channelPointsVoting,false);assert.equal(state.config.channelPointsPerVote,100);
for(const channelPointsPerVote of [0,-1,1.5,1000001])await action('configure',{...state.config,channelPointsVoting:true,channelPointsPerVote},400);
await action('configure',{...state.config,channelPointsVoting:'true'},400);
await action('configure',{...state.config,spinSeconds:1.5},400);
await action('configure',{...state.config,excludedIds:['fake-id']},400);
await action('configure',{...state.config,unexpected:true},400);
await action('select',{packId:'fake'},400);await action('show',{},409,crypto.randomUUID(),0);
for(const role of ['killer','survivor'])for(const mode of ['characters','perks'])for(const design of mode==='characters'?['cards','reel','wheel','elimination']:['cards']){
 await action('select',{packId:`dbd-${role}-${mode}`});
 await action('configure',{...state.config,characterDesign:design});
 state=await request('GET',root);assert.equal(state.config.characterDesign,design,'choice survives a fresh snapshot');
 const key=crypto.randomUUID(),rev=state.revision;await action('start',{},200,key,rev);const draw=state.run.draw;
 assert.equal(draw.design,mode==='perks'?'wheel':design);
 assert(draw.poolIds.every(id=>catalog.entries.find(e=>e.id===id).role===role));
 assert(draw.poolIds.every(id=>catalog.entries.find(e=>e.id===id).kind===(mode==='perks'?'perk':'character')));
 await action('start',{},200,key,rev);assert.equal(state.run.draw.id,draw.id,'same key cannot reroll');
 await action('hide',{},409,key,state.revision);
 await action('configure',{...state.config,characterDesign:design==='cards'?'reel':'cards'},409);
 await action('start',{},409);await action('select',{packId:'dbd-killer-challenge'},409);
 await new Promise(r=>setTimeout(r,1100));state=await request('GET',root);assert.equal(state.phase,'complete');
 await action('configure',{...state.config,characterDesign:design==='cards'?'reel':'cards'});assert.equal(state.run.draw.design,draw.design,'finished draw keeps its frozen design');
}
await action('select',{packId:'dbd-killer-challenge'});
const excluded=catalog.entries.filter(e=>e.role==='killer'&&e.kind==='perk').slice(3).map(e=>e.id);
await action('configure',{...state.config,excludedIds:excluded});await action('start',{},400);
await action('configure',{...state.config,excludedIds:[],characterDesign:'reel',channelPointsVoting:true,channelPointsPerVote:250});
const revision=state.revision;
const starts=await Promise.all(Array.from({length:4},(_,i)=>fetch(base+root+'/actions/start',{method:'POST',headers:{Authorization:'Bearer widgets-owner','Content-Type':'application/json','Idempotency-Key':'race-'+i,'If-Match':String(revision)},body:'{}'}).then(r=>r.status)));
assert.equal(starts.filter(status=>status===200).length,1);assert.equal(starts.filter(status=>status===409).length,3);
// Every other contender must fail via conflict; winner ordering can vary.
state=await request('GET',root);assert.equal(state.phase,'character-spin');assert.equal(state.run.draw.design,'reel');const id=state.run.id;
const raw=await svc.WidgetChannel.findById(channel).lean();assert.deepEqual([...raw.state.run.cards].sort(),[0,1,2,3,4]);assert.deepEqual(state.run.cards,[null,null,null,null,null]);
const token=(await request('POST',root+'/overlay-token',{})).token;
const overlay=(await request('GET',root+'/overlay',undefined,200,token)).state;
function connectWidget(overlayToken){
 const ws=new WebSocket(base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket'),packets=[];
 ws.addEventListener('message',event=>{const text=String(event.data);if(text.startsWith('0'))ws.send('40/overlays/widgets/'+channel+','+JSON.stringify({token:overlayToken}));else if(text==='2')ws.send('3');else packets.push(text);});
 async function waitPacket(check){for(let i=0;i<100;i++){const found=packets.find(check);if(found)return found;await new Promise(r=>setTimeout(r,50));}throw new Error('Widget socket timeout '+JSON.stringify(packets));}
 return {ws,packets,waitPacket};
}
const initialSocket=connectWidget(token);const firstPacket=await initialSocket.waitPacket(text=>text.includes('widgets-state'));const socketState=JSON.parse(firstPacket.slice(firstPacket.indexOf(',')+1))[1];assert.deepEqual(socketState.run.cards,[null,null,null,null,null]);await initialSocket.waitPacket(text=>text.includes('widgets-catalog'));initialSocket.ws.close();
assert.deepEqual(overlay.run.cards,[null,null,null,null,null]);assert.equal(overlay.tokenHash,undefined);
await request('POST',root+'/actions/hide',{},401,token,{'Idempotency-Key':'overlay-write','If-Match':String(state.revision)});
// Complete character using the real worker, even with no readers/OBS clients.
await new Promise(r=>setTimeout(r,1200));
execFileSync('node',['/app/dist/workers/widgets.worker.js','--once'],{encoding:'utf8'});
state=await request('GET',root);assert.equal(state.phase,'character-result');assert.equal(state.run.draw.id,raw.state.run.draw.id);assert(state.nextAt>Date.now(),'character result remains on screen');
await action('configure',{...state.config,characterDesign:'wheel'},409);
await new Promise(r=>setTimeout(r,3100));execFileSync('node',['/app/dist/workers/widgets.worker.js','--once'],{encoding:'utf8'});
await waitPollClaim();
state=await request('GET',root);assert.equal(state.phase,'polling',state.run.error);assert(state.run.pollId);assert.deepEqual(state.run.cards,[null,null,null,null,null]);
let store=JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8'));assert.equal(store.creates,1,'one poll AST executed');
assert.equal(store.polls[0].channel_points_voting_enabled,true);assert.equal(store.polls[0].channel_points_per_vote,250,'widget cost reaches native Twitch via the AST');
assert.deepEqual(store.polls[0].choices.map(c=>c.title),['Card 1','Card 2','Card 3','Card 4','Card 5']);
assert(store.polls[0].title.includes(id.slice(0,8)));
await action('hide');assert.equal(state.visible,false);await action('show');
const stored=await svc.WidgetChannel.findById(channel).lean();const four=stored.state.run.cards.indexOf(4);
store.polls[0].choices.forEach((c,i)=>{c.votes=i===four?25:10;c.channel_points_votes=i===four?20:0;});writeFileSync('/tmp/saas-fixtures/polls.json',JSON.stringify(store));
await svc.WidgetChannel.updateOne({_id:channel},{$set:{'state.nextAt':0,dueAt:0}});state=await request('GET',root);
assert.equal(state.phase,'polling');assert.deepEqual(state.run.cards,[null,null,null,null,null]);assert.equal(state.run.votes[four],25);assert.equal(state.run.channelPointsVotes[four],20,'paid vote breakdown reaches the widget while cards stay hidden');
store.polls[0].status='COMPLETED';writeFileSync('/tmp/saas-fixtures/polls.json',JSON.stringify(store));
await svc.WidgetChannel.updateOne({_id:channel},{$set:{'state.nextAt':0,dueAt:0}});
state=await request('GET',root);assert.equal(state.phase,'reveal');assert.equal(state.run.perkCount,4);assert.equal(state.run.winningCard,four);assert.deepEqual([...state.run.cards].sort(),[0,1,2,3,4]);
assert.equal(state.run.channelPointsVotes[four],20,'winner includes paid extra votes, not just regular votes');
await new Promise(r=>setTimeout(r,3600));execFileSync('node',['/app/dist/workers/widgets.worker.js','--once'],{encoding:'utf8'});
// Observe persisted deadlines rather than sleeping through multiple supervisor transitions.
for(let i=1;i<=4;i++){
 const deadline=Date.now()+15000;
 do{state=await request('GET',root);if(state.phase==='perk-result'&&state.run.perkIds.length===i)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
 assert.equal(state.phase,'perk-result');assert.equal(state.run.perkIds.length,i);assert.equal(state.run.draw.kind,'perk');
 assert(state.nextAt>=state.run.draw.endsAt+3000,'perk result deadline includes the three-second hold');
 const drawId=state.run.draw.id;
 if(state.nextAt-Date.now()>2200){await new Promise(r=>setTimeout(r,2000));state=await request('GET',root);assert.equal(state.phase,'perk-result');assert.equal(state.run.draw.id,drawId);}
 if(i===4){await new Promise(r=>setTimeout(r,Math.max(0,state.nextAt-Date.now())+50));}
}

state=await request('GET',root);assert.equal(state.phase,'complete');assert.equal(state.run.perkIds.length,4);assert.equal(new Set(state.run.perkIds).size,4);
// Zero and tie behavior are domain tests using the real shuffled private values.
for(const target of [0,1,2,3,4]){const s=domain.initial();domain.start(s,1000);const slot=s.run.cards.indexOf(target);domain.reveal(s,s.run.cards.map((_,i)=>i===slot?10:0),2000);assert.equal(s.run.perkCount,target);domain.settle(s,6000);assert.equal(s.phase,target===0?'complete':'perk-spin');}
for(let i=0;i<100;i++){const s=domain.initial();domain.start(s,1000);domain.reveal(s,[0,0,0,0,0],2000);assert(s.run.winningCard>=0&&s.run.winningCard<5);}
// Poll failure never leaks cards or silently chooses a perk count.
await action('reset');writeFileSync('/tmp/saas-fixtures/fail-poll','fail');await action('start');await new Promise(r=>setTimeout(r,1100));state=await request('GET',root);assert.equal(state.phase,'character-result');await new Promise(r=>setTimeout(r,3100));state=await request('GET',root);await waitPollClaim();state=await request('GET',root);assert.equal(state.phase,'poll-error');assert.deepEqual(state.run.cards,[null,null,null,null,null]);unlinkSync('/tmp/saas-fixtures/fail-poll');
await action('retry-poll');assert.equal(state.phase,'polling');
// Accepted-poll recovery does not POST a duplicate, including after a process interruption.
const before=JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8')).creates;
await svc.WidgetChannel.updateOne({_id:channel},{$set:{'state.phase':'poll-starting','state.nextAt':0,dueAt:0}});state=await request('GET',root);assert.equal(state.phase,'polling');assert.equal(JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8')).creates,before);
const revocationSocket=connectWidget(token);await revocationSocket.waitPacket(text=>text.includes('widgets-state'));
const replacement=(await request('POST',root+'/overlay-token',{})).token;await request('GET',root+'/overlay',undefined,401,token);await revocationSocket.waitPacket(text=>text.startsWith('41'));revocationSocket.ws.close();await request('GET',root+'/overlay',undefined,200,replacement);
await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:'free'}});await request('GET',root,undefined,403);await request('GET',root+'/overlay',undefined,401,replacement);
await svc.settleDue();assert((await svc.WidgetChannel.findById(channel).lean()).dueAt>Date.now(),'downgraded channels do not monopolize indexed deadlines');
// Existing three-part poll commands remain free; optional fourth part enables extra votes.
const {parseSpecialCommands}=await import('/app/dist/handlers/special_parser.handler.js');
const ctx={channelID:channel,scopeType:'widgets',scopeName:'poll-options-test',userPlan:'pro',userLevel:10,literalArguments:true};
store=JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8'));store.polls.forEach(p=>p.status='COMPLETED');writeFileSync('/tmp/saas-fixtures/polls.json',JSON.stringify(store));
for(const suffix of ['',';0',';1',';1000000']){
 const result=await parseSpecialCommands('$(start.poll "Compatibility;One/Two;15'+suffix+'")',ctx);assert.equal(result.parsedText.trim(),'');
 store=JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8'));const expected=Number(suffix.slice(1)||0);assert.equal(store.polls[0].channel_points_voting_enabled,expected>0);assert.equal(store.polls[0].channel_points_per_vote,expected);
 store.polls[0].status='COMPLETED';writeFileSync('/tmp/saas-fixtures/polls.json',JSON.stringify(store));
}
const creates=store.creates;
for(const value of ['-1','1.5','1000001','abc','true','100;extra']){const result=await parseSpecialCommands('$(start.poll "Invalid;One/Two;15;'+value+'")',ctx);assert(result.parsedText.trim());assert.equal(JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8')).creates,creates,'invalid cost causes no native poll creation');}
const legacy=domain.initial();delete legacy.config.characterDesign;assert.equal(domain.publicState(legacy).config.characterDesign,'cards');domain.start(legacy,Date.now());assert.equal(legacy.run.draw.design,'cards');delete legacy.config.channelPointsVoting;delete legacy.config.channelPointsPerVote;assert.equal(domain.publicState(legacy).config.channelPointsVoting,false);assert.equal(domain.publicState(legacy).config.channelPointsPerVote,100);
execFileSync(process.execPath,['--experimental-test-module-mocks','--test','/app/dist/widgets/model.test.js','/app/dist/utils/ast_parser/channel_actions.test.js','/app/dist/utils/ast_parser/poll_prediction_actions.test.js','/app/dist/utils/ast_parser/permission_gate_authored.test.js'],{stdio:'inherit',timeout:30000});
console.log('PASS widgets: three-second result pauses, all four character styles, deterministic partial/no-vote ties, 419 entries, 6 presets, Pro/owner/token access, validation, persistence, idempotency, hidden cards, native poll AST, Channel Points settings and live counts, legacy free polls, paid-vote winner, recovery, distinct perks, supervised worker, token revocation');
io?.close();testServer?.close();process.exit(0);
