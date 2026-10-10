// Run only with saas-ops, disposable Mongo/Redis, and duel-fixtures (cron target).
// The full duel-backend check exceeds the cron candidate's memory limit next to every
// supervised worker, so this drives the real duel worker over finished runs: only tracked
// runs (overlay, default rules, tracking on) are recorded, and custom HP reaches the winner message.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const svc=await import('/app/dist/duel/service.js'),domain=await import('/app/dist/duel/model.js'),stats=await import('/app/dist/duel/stats.js');
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('duel-cron-test');const redis=await getDragonflyClient('duel-cron-test');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const {encrypt}=await import('/app/dist/utils/crypto.js');
const channel='991801';
for(const [id,name] of [[channel,'duelfixture'],['698614112','domdimabot']]){
 await Users.collection.insertOne({accounts:[{id,type:'twitch',name,has_permissions:true,up_to_date_permissions:true,actived:true,chat_enabled:false,access_token:encrypt('fixture'),refresh_token:encrypt('fixture-refresh'),access_token_expires_at:Math.floor(Date.now()/1000)+3600}],plan_tier:'pro'});
 await redis.hSet('accounts:twitch:'+id+':data',{id,name,has_permissions:'true',access_token:'fixture',expires_at:String(Math.floor(Date.now()/1000)+3600),userPlan:'pro'});
}
await redis.set('app:twitch:token','fixture',{EX:3600});
await svc.DuelChannel.init();await stats.DuelResult.init();
const chats=()=>{try{return readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(c=>c.path==='/helix/chat/messages');}catch{return [];}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A finished run is stored as due; the worker announces, records (or not) and completes it.
async function settle(settings,overlay,strip){
 const now=Date.now(),run=domain.createRun({id:crypto.randomUUID(),challenger:'alice',opponent:'bob',expiresAt:now},{...domain.defaultSettings(),timeoutEnabled:false,...settings},overlay,now-120000);
 if(strip)delete run.tracked; // Runs accepted before this release have no tracked flag.
 run.endsAt=now-1;run.phrases=[];
 await svc.DuelChannel.deleteMany({_id:channel});
 await svc.DuelChannel.create({_id:channel,settings:{...domain.defaultSettings(),timeoutEnabled:false,...settings},run,dueAt:now-1,leaseUntil:0,revision:1,statsRevision:0});
 for(let i=0;i<40;i++){execFileSync('node',['/app/dist/workers/duel.worker.js','--once'],{encoding:'utf8'});const doc=await svc.DuelChannel.findById(channel).lean();if(doc.run.completedAt)return {run,doc,recorded:!!await stats.DuelResult.exists({_id:run.id})};await sleep(250);}
 throw new Error('duel did not complete');
}
let result=await settle({},true);assert.equal(result.run.tracked,true);assert(result.recorded,'tracked overlay fight recorded');assert.equal(result.doc.statsRevision,1);
result=await settle({},true,true);assert(result.recorded,'older overlay runs still count');
const custom={...domain.DEFAULT_RULES,hp:200};const chatsBefore=chats().length;
result=await settle({rules:custom},true);assert.equal(result.run.tracked,false);assert(!result.recorded,'custom-rule fights are never recorded');assert.equal(result.doc.statsRevision,0);
const hp=domain.remainingHp(result.run.turns,result.run.winner,200),message=chats().slice(chatsBefore).map(c=>JSON.stringify(c.body)).find(b=>b.includes('has won the duel'));assert(message?.includes(`with ${hp} HP left`),'winner message counts HP from the custom pool: '+message);
result=await settle({},false);assert(!result.recorded,'chat duels are never recorded');
result=await settle({leaderboard:false,rivalries:false},true);assert(!result.recorded,'both switches off: nothing recorded');
result=await settle({leaderboard:false},true);assert(result.recorded,'rivalries alone still record results');
assert.equal(await stats.DuelResult.countDocuments({channel}),3);
await redis.quit();await (await getMongoDBConnection('duel-cron-close')).disconnect();
console.log('PASS duel cron: tracked/legacy/custom-rule/chat/switch-off runs through the real duel worker, custom HP in the winner message');process.exit(0);
