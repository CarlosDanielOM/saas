import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import mongoose from '/app/node_modules/mongoose/index.js';
const {Types}=mongoose;
import {getMongoDBConnection} from '/app/dist/utils/databases/mongodb.database.js';
import {getDragonflyClient} from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import {StreamActivitySchema as Activity,StreamActivityStateSchema as State} from '/app/dist/schemas/stream_activity.schema.js';
import {DashboardActivityDailySchema as Daily,DashboardActivitySummarySchema as Summary} from '/app/dist/schemas/dashboard_activity.schema.js';
import {projectDashboardActivityBatch as project,refreshDashboardActivityOnce as refresh,queueDashboardActivity as queue,dashboardRangeStart} from '/app/dist/utils/dashboard_activity.js';
const mongo=await getMongoDBConnection('dashboard-activity-check'),redis=await getDragonflyClient('dashboard-activity-check');
await Promise.all([Activity.init(),State.init(),Daily.init(),Summary.init()]);
const channel='99006601',other='99006602',session=new Types.ObjectId(),now=new Date(),at=new Date(+now-3600000),expiry=new Date(+now+86400000);
await Users.create({name:'Dashboard Fixture',plan_tier:'free',accounts:[{type:'twitch',id:channel,name:'dashboardfixture',actived:true,has_permissions:true,chat_enabled:true}]});
await redis.hSet('token:usage-owner',{id:channel,login:'dashboardfixture',display_name:'Fixture'});
await redis.hSet('token:usage-other',{id:other,login:'other',display_name:'Other'});
const request=(path,token='usage-owner')=>fetch('http://127.0.0.1:3000'+path,{headers:token?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(5000)});
const receipt=(id,kind,extra={})=>({_id:id,channelID:channel,session_id:session,occurredAt:at,kind,key:kind==='command'?'hello':'',label:kind==='command'?'!hello':'',actor:'SECRET_ACTOR',actorLabel:'PRIVATE_PERSON',emotes:[],processed:true,expiresAt:expiry,...extra});
async function settle(channelID=channel){await queue(channelID);for(let i=0;i<20;i++){await refresh();const row=await Summary.findById(channelID).lean();if(row?.payload&&!row.error&&row.updatedAt>=row.dirtyAt)return row;}throw new Error('Summary did not settle');}
if(process.env.SAAS_TARGET==='api'){
 assert.equal((await request(`/dashboard/${channel}/activity`,null)).status,401);
 assert.equal((await request(`/dashboard/${channel}/activity`,'usage-other')).status,403);
 assert.equal((await request(`/dashboard/${channel}/activity?days=8`)).status,400);
 assert.equal((await request('/dashboard/nope/activity')).status,400);
 const cold=await(await request(`/dashboard/${channel}/activity`)).json();assert.equal(cold.data.pending,true);assert.equal(cold.data.summary,null);
}
await Activity.collection.insertMany([receipt('a','command'),receipt('b','message',{emotes:[{key:'twitch:25',label:'Kappa',count:3}]}),receipt('c','message',{emotes:[{key:'twitch:25',label:'Kappa',count:2},{key:'bttv:untracked',label:'Nope',count:99}]})]);
if(process.env.SAAS_TARGET==='cron'){
 const deadline=Date.now()+30000;while(Date.now()<deadline&&await Activity.countDocuments({dashboardProcessed:true})<3)await new Promise(r=>setTimeout(r,100));
 const until=Date.now()+15000;while(Date.now()<until&&!(await Summary.findById(channel).lean())?.payload)await new Promise(r=>setTimeout(r,100));
 const row=await Summary.findById(channel).lean();assert.equal(row.payload['7'].commandRuns,1);assert.equal(row.payload['7'].emoteUses,5);
 assert.equal(await Activity.countDocuments({processed:true}),3);
 console.log('PASS CRON: actual supervised dashboard worker backfills retained metadata without replaying timeline state or calling providers');process.exit(0);
}
assert.equal(await project(3),3);
let state=await settle(),period=state.payload['7'];assert.equal(period.commandRuns,1);assert.equal(period.emoteUses,5);assert.equal(period.commands[0].label,'!hello');
assert.equal(period.emotes.length,1);assert.doesNotMatch(JSON.stringify(period),/SECRET_ACTOR|PRIVATE_PERSON|bttv/);
// Retry a fully applied batch after losing the completion receipt.
await State.updateOne({_id:'dashboard-daily-v1'},{$set:{active:{seq:1,ids:['a','b','c']},leaseUntil:new Date(0)}});
await project();state=await settle();assert.equal(state.payload['7'].commandRuns,1);assert.equal(state.payload['7'].emoteUses,5);
// Recover a partially applied batch: one daily row has already advanced its fence.
await Activity.collection.insertMany([receipt('d','command'),receipt('e','message',{emotes:[{key:'twitch:25',label:'Kappa',count:4}]})]);
await Daily.updateOne({channelID:channel,kind:'command'},{$inc:{count:1},$set:{lastSeq:2}});
await State.updateOne({_id:'dashboard-daily-v1'},{$set:{seq:2,active:{seq:2,ids:['d','e']},leaseUntil:new Date(0)}});
await project();state=await settle();assert.equal(state.payload['7'].commandRuns,2);assert.equal(state.payload['7'].emoteUses,9);
// UTC exact boundaries, late records, future and logically expired records.
const start7=dashboardRangeStart(7,now),start30=dashboardRangeStart(30,now);
await Activity.collection.insertMany([
 receipt('edge7','command',{occurredAt:start7}),receipt('outside7','command',{occurredAt:new Date(+start7-1)}),
 receipt('edge30','command',{occurredAt:start30}),receipt('outside30','command',{occurredAt:new Date(+start30-1)}),
 receipt('expired','command',{expiresAt:new Date(+now-1)}),receipt('future','command',{occurredAt:new Date(+now+3600000)}),
 receipt('tenant','command',{channelID:other,label:'!private-other'})
]);
while(await project()){}
state=await settle();assert.equal(state.payload['7'].commandRuns,3);assert.equal(state.payload['30'].commandRuns,5);
assert.equal((await Daily.findOne({channelID:channel,kind:'command',day:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()))}).lean()).expiresAt.getTime(),expiry.getTime());
assert.ok(Daily.schema.indexes().some(([keys,options])=>keys.expiresAt===1&&options.expireAfterSeconds===0));
assert.equal(await Activity.countDocuments({dashboardProcessed:true,processed:true}),10);
// Cold source backlog is reported, rather than being presented as a measured zero.
await Activity.collection.insertOne(receipt('backlog','command'));
state=await settle();assert.equal(state.payload['7'].pending,true);await project();
// Seed 100k real source metadata receipts, process only bounded 500-row batches.
const size=100000,hash=value=>createHash('sha256').update(value).digest('hex');
for(let offset=0;offset<size;offset+=2000)await Activity.collection.insertMany(Array.from({length:Math.min(2000,size-offset)},(_,j)=>{
 const i=offset+j;return receipt(hash(`load-${i}`),i%5===0?'command':'message',{key:i%5===0?`cmd${i%20}`:'',label:i%5===0?`!cmd${i%20}`:'',emotes:i%5!==0?[{key:'twitch:25',label:'Kappa',count:2}]:[]});
}));
const started=performance.now();let count=0,batch;while(batch=await project()){assert.ok(batch<=500);count+=batch;}assert.equal(count,size);
const projectionMs=Math.round(performance.now()-started);state=await settle();period=state.payload['7'];assert.equal(period.commandRuns,20004);assert.equal(period.emoteUses,160009);assert.ok(period.commands.length<=5);assert.ok(period.emotes.length<=5);
for(const tier of ['free','premium','pro']){
 await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:tier}});
 const r=await request(`/dashboard/${channel}/activity?days=7&actor=SECRET_ACTOR&kind=command`);assert.equal(r.status,200);const body=await r.json();
 assert.equal(body.data.summary.commandRuns,20004);assert.equal(body.data.summary.pending,false);
 assert.doesNotMatch(JSON.stringify(body),/SECRET_ACTOR|PRIVATE_PERSON|!private-other|daily|people|failures/);
}
await Summary.updateOne({_id:channel},{$set:{error:true}});assert.equal((await(await request(`/dashboard/${channel}/activity`)).json()).data.stale,true);
await Summary.updateOne({_id:channel},{$set:{error:false}});
const times=[];let bytes=0;
await Promise.all(Array.from({length:50},async()=>{const start=performance.now(),r=await request(`/dashboard/${channel}/activity?days=30`);assert.equal(r.status,200);const text=await r.text();bytes=Math.max(bytes,Buffer.byteLength(text));assert.equal(JSON.parse(text).data.summary.commandRuns,20006);times.push(performance.now()-start);}));
times.sort((a,b)=>a-b);const p95=Math.round(times[Math.ceil(times.length*.95)-1]);assert.ok(p95<2000);assert.ok(bytes<20000);
console.log(JSON.stringify({check:'dashboard-activity-heavy',sourceEvents:size,projectionMs,maxBatch:500,concurrentReaders:50,p95Ms:p95,maxResponseBytes:bytes}));
console.log('PASS API: aggregate-only free/premium/pro ranks, authorization, 7/30 UTC boundaries, expired/future filtering, native-only emotes, late/backfill/retry recovery, private metadata excluded and bounded reads');
process.exit(0);
