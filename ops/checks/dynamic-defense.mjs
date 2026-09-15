// Disposable saas-ops dependencies and mocked providers only.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { FollowDefenseSettingsSchema as Settings } from '/app/dist/schemas/follow_defense_settings.schema.js';
import { StreamSessionSchema as Streams } from '/app/dist/schemas/stream_session.schema.js';
import { FollowRelationshipLedgerSchema as Ledger } from '/app/dist/schemas/follow_relationship_ledger.schema.js';
import { FollowDefenseActionSchema as Actions, FollowDefenseControlSchema as Controls } from '/app/dist/schemas/follow_defense_action.schema.js';
import { getDefenseBaseline, refreshDefenseBaseline } from '/app/dist/utils/follow_defense_baseline.js';
import { processDurableFollowDefenseFollow, processFollowDefenseQueue } from '/app/dist/utils/follow_defense.js';
import { followDefenseKeys, getFollowDefenseStatus, triggerFollowDefenseAttackMode, shouldSuppressFollowAlerts } from '/app/dist/utils/follow_defense_queue.js';
import { enqueueFollowDefenseBan, processFollowDefenseAction } from '/app/dist/utils/follow_defense_actions.js';
import fs from 'node:fs';
const mongo=await getMongoDBConnection('dynamic-check'), redis=await getDragonflyClient('dynamic-check');
const channel='533538623',keys=followDefenseKeys(channel),DAY=86400000;
await Promise.all([Settings.init(),Streams.init(),Ledger.init(),Actions.init(),Controls.init()]);
await Settings.create({channelID:channel});
await redis.hSet(`accounts:twitch:${channel}:data`,{id:channel,name:'fixture',chat_enabled:'false'});
await redis.hSet('accounts:twitch:698614112:data',{id:'698614112',access_token:'dummy-token',expires_at:String(Math.floor(Date.now()/1000)+36000)});
await mongo.connection.db.collection('users').insertOne({accounts:[{type:'twitch',id:channel,name:'fixture'}],plan_tier:'pro'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await sleep(100);}throw new Error(label);}
const end=Math.floor(Date.now()/DAY)*DAY;
await Streams.insertMany(Array.from({length:30},(_,i)=>({channelID:channel,stream_id:`stream-${i}`,started_at:new Date(end-(i+1)*DAY+3600000),ended_at:new Date(end-(i+1)*DAY+7200000),status:'offline',duration_minutes:60,follows:20000})));
await Streams.create({channelID:channel,stream_id:'today',started_at:new Date(end+1000),ended_at:new Date(end+2000),status:'offline',duration_minutes:60,follows:1000000});
await Ledger.insertMany(Array.from({length:7},(_,i)=>({followed_id:channel,follower_id:`historic-${i}`,followed_at:new Date(end-(i+1)*DAY+1000)})));
if(process.env.SAAS_TARGET==='api'){
 await redis.hSet('token:dynamic-owner',{id:channel,login:'fixture',display_name:'Fixture'});
 const api=(body)=>fetch(`http://127.0.0.1:3000/follow-defense/${channel}/settings`,{method:body?'PATCH':'GET',headers:{Authorization:'Bearer dynamic-owner','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await(await api()).json()).data.attackThreshold,null);
 for(const value of [15000,500,null,'', '   ',1234]){
  const response=await api({attackThreshold:value});assert.equal(response.status,200);
  assert.equal((await response.json()).data.attackThreshold,typeof value==='number'?value:null);
 }
 for(const value of [0,-1,1.5,false,{},'oops'])assert.equal((await api({attackThreshold:value})).status,400);
 assert.equal((await(await api()).json()).data.attackThreshold,1234);
 await api({attackThreshold:null});
 console.log('PASS API: new default dynamic, numeric overrides including 500 preserved, empty/null dynamic round trips, invalid input rejected');
}
if(process.env.SAAS_TARGET==='cron'){
 assert.equal(await getDefenseBaseline(channel),null);
 await until(async()=>Boolean((await getDefenseBaseline(channel))?.attackThreshold),'supervised baseline worker');
} else await refreshDefenseBaseline(channel);
const baseline=await getDefenseBaseline(channel);assert.equal(baseline.attackThreshold,40000);assert.equal(baseline.averageDaily,20000);assert.equal(baseline.averageStream,20000);
// Stale data and cache loss never fall back to a small automatic threshold.
await redis.set(`follow:defense:baseline:${channel}`,JSON.stringify({...baseline,calculatedAt:Date.now()-3*DAY}));
assert.equal(await getDefenseBaseline(channel),null);
await refreshDefenseBaseline(channel);
console.log('PASS baseline: real 30-day aggregation, today excluded, worker/cache refresh, stale data disables automatic attack');
if(process.env.SAAS_TARGET!=='cron'){console.log(`PASS ${process.env.SAAS_TARGET}: actual runtime with dynamic settings and historical aggregation`);process.exit(0);}
// Stop only disposable moderation processes while inspecting the resulting queue.
const calls=()=>fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
await until(()=>calls().some(c=>c.ready)&&calls().some(c=>c.raidReady),'workers ready');
process.kill(calls().find(c=>c.ready).ready,'SIGSTOP');process.kill(calls().find(c=>c.raidReady).raidReady,'SIGSTOP');
await until(async()=>Boolean(await redis.get('worker:follow-defense:lock')),'maintenance worker lock');
process.kill(Number((await redis.get('worker:follow-defense:lock')).split('-')[0]),'SIGSTOP');
const follow=id=>({eventID:`dynamic-${id}`,channelID:channel,channelLogin:'fixture',channelName:'Fixture',followerID:String(id),followerLogin:`viewer${id}`,followerName:`Viewer${id}`,followedAt:new Date(Date.now()).toISOString(),receivedAt:Date.now()});
const started=Date.now();
for(let offset=0;offset<10000;offset+=25)await Promise.all(Array.from({length:25},(_,i)=>processDurableFollowDefenseFollow(follow(offset+i))));
assert.equal((await getFollowDefenseStatus(channel)).mode,'protection');assert.equal(await Actions.countDocuments({kind:'ban'}),0);assert.equal(await shouldSuppressFollowAlerts(channel),true);
console.log(`PASS 10,000 non-raid follows: protection and suppressed chat, zero bans (${Date.now()-started}ms)`);
// Keep the same protection wave alive beyond the automatic event-freshness window.
const realNow=Date.now, waveNow=realNow();
try {
 for(let second=1;second<=70;second++) {
  Date.now=()=>waveNow+second*1000;
  for(let i=0;i<3;i++)await processDurableFollowDefenseFollow(follow(30000+second*3+i));
 }
 assert.equal((await getFollowDefenseStatus(channel)).mode,'protection');
 await triggerFollowDefenseAttackMode(channel,'fixture','Fixture');await processFollowDefenseQueue();
 assert.equal((await getFollowDefenseStatus(channel)).mode,'attack');
 assert.equal(await Actions.countDocuments({kind:'ban',authorization:'manual'}),10210,'explicit manual attack includes older followers from the same active wave');
} finally { Date.now=realNow; }
console.log('PASS manual attack remains available with dynamic sensitivity');
await redis.del([keys.state,keys.recent,keys.tracked,keys.settings]);await Actions.deleteMany({});await Controls.deleteMany({});
await Settings.updateOne({channelID:channel},{$set:{attackThreshold:5}});
for(let i=0;i<6;i++)await processDurableFollowDefenseFollow(follow(20000+i));
assert.equal((await getFollowDefenseStatus(channel)).mode,'attack');assert.equal(await Actions.countDocuments({kind:'ban'}),6);
await Actions.deleteMany({});await Controls.deleteMany({});
await enqueueFollowDefenseBan(follow(99999),'DimaBot follow defense protection mode');
await processFollowDefenseAction(async()=>assert.fail('Legacy protection ban must not execute'));
assert.equal((await Actions.findOne({followerID:'99999'}).lean()).status,'cancelled');
console.log('PASS custom threshold overrides baseline; old automatic protection jobs are cancelled');
process.exit(0);
