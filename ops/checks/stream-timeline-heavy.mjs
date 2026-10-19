import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { StreamSessionSchema as Sessions } from '/app/dist/schemas/stream_session.schema.js';
import { StreamViewerSnapshotSchema as Snapshots } from '/app/dist/schemas/stream_viewer_snapshot.schema.js';
import { StreamMarkerSchema as Markers } from '/app/dist/schemas/stream_timeline.schema.js';
import { StreamActivitySchema as Activity, StreamActivityAggregateSchema as Aggregate, StreamActivityStateSchema as State } from '/app/dist/schemas/stream_activity.schema.js';
import { captureStreamActivity, extractTimelineEmotes, projectStreamActivityBatch, getStreamActivity } from '/app/dist/utils/stream_activity.js';
import { getStreamTimeline, recordTimelineRedemption } from '/app/dist/utils/stream_timeline.js';
const mongo = await getMongoDBConnection('timeline-heavy'), redis = await getDragonflyClient('timeline-heavy');
await Promise.all([Sessions.init(), Snapshots.init(), Markers.init(), Activity.init(), Aggregate.init(), State.init()]);
const now=Date.now(), start=new Date(now-8*3600000), channel='533538623';
const session=await Sessions.create({channelID:channel,stream_id:'heavy',started_at:start,status:'live'});
const other=await Sessions.create({channelID:'987654321',stream_id:'other',started_at:start,status:'live'});
const historical=await Sessions.create({channelID:channel,stream_id:'historical',started_at:new Date(+start-86400000),ended_at:new Date(+start-50000),status:'offline'});
await Snapshots.insertMany(Array.from({length:97},(_,i)=>({channelID:channel,session_id:session._id,stream_id:'heavy',captured_at:new Date(+start+i*300000),viewers:20+i,messages:i*100,commands:i*10,title:'Test',game_name:'Music'})));
const fragments=[{type:'emote',text:'Kappa',emote:{id:'25'}},{type:'emote',text:'Kappa',emote:{id:'25'}},{type:'text',text:'PRIVATE TEXT DO NOT STORE'}];
const emotes=extractTimelineEmotes({text:'PRIVATE TEXT DO NOT STORE',fragments});
assert.deepEqual(emotes,[{key:'twitch:25',label:'Kappa',count:2}]);
const fixture={channelID:channel,eventID:'first-message',kind:'message',actor:'viewer',actorLabel:'Viewer',occurredAt:new Date(+start+301000),emotes};
await Promise.all([captureStreamActivity(fixture),captureStreamActivity(fixture)]);
assert.equal(await Activity.countDocuments({kind:'message'}),1);
assert.doesNotMatch(JSON.stringify(await Activity.find().lean()),/PRIVATE TEXT/);
await captureStreamActivity({channelID:channel,eventID:'old-follow',kind:'follow',occurredAt:new Date(+start+1000)});
await captureStreamActivity({channelID:channel,eventID:'old-command',kind:'command',key:'hello',label:'!hello',actor:'viewer',actorLabel:'Viewer',outcome:'error',occurredAt:new Date(+start+600000)});
await captureStreamActivity({...fixture,eventID:'outside',occurredAt:new Date(+start-10000)});
assert.equal(await Activity.countDocuments(),3);
async function drain(){let iterations=0;while(await Activity.exists({processed:false})){const count=await projectStreamActivityBatch(1000);if(!count)await new Promise(r=>setTimeout(r,50));if(++iterations>10000)throw Error('Projection did not catch up');}}
await drain();
let activity=await getStreamActivity(channel,session._id,'pro');
assert.equal(activity.totals.commands,1);assert.equal(activity.totals.emotes,2);assert.equal(activity.commands[0].errors,1);
assert.equal(new Date(activity.chatterStartedAt).getTime(),+start+301000);
assert.equal((await getStreamTimeline(channel,String(session._id),'pro')).chatters[0].count,null);
// Force replay of a completed persisted batch, simulating response loss before checkpoint acknowledgement.
const state=await State.findById('projector-v1').lean();
const ids=(await Activity.find().select('_id').lean()).map(r=>r._id);
await State.updateOne({_id:'projector-v1'},{$set:{active:{seq:state.seq,ids},leaseUntil:new Date(0)}});
await projectStreamActivityBatch();
activity=await getStreamActivity(channel,session._id,'pro');assert.equal(activity.totals.commands,1);assert.equal(activity.totals.emotes,2);
await recordTimelineRedemption({id:'reward',broadcaster_user_id:channel,redeemed_at:new Date(+start+700000).toISOString(),reward:{id:'reward-id',title:'Hydrate',cost:300},status:'unfulfilled'});
await drain();
const marker=await Markers.findOne({kind:'redemption'}).lean();assert.equal(marker.cost,300);assert.equal(marker.rewardID,'reward-id');
await mongo.connection.db.collection('users').insertOne({accounts:[{type:'twitch',id:channel,name:'fixture'}],plan_tier:'free',polar_sh_customer_id:'fixture-customer'});
await mongo.connection.db.collection('admins').insertOne({channelID:channel,adminID:'111222333',actived:true,permissions:['analytics:view']});
for(const [token,id] of [['heavy-owner',channel],['heavy-admin','111222333'],['heavy-other','987654321']])await redis.hSet(`token:${token}`,{id,login:'fixture',display_name:'Fixture'});
const base=`http://127.0.0.1:3000/analytics/streams/${channel}`;
const request=(suffix='',token='heavy-owner')=>fetch(base+suffix,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
if(process.env.SAAS_TARGET==='api'){
 assert.equal((await fetch(base)).status,401);assert.equal((await request('','heavy-other')).status,403);
 assert.equal((await request(`/${other._id}`)).status,404);
 let response=await(await request(`/${session._id}`)).json();assert.equal(response.data.activity.capabilities.users,false);assert.equal(response.data.activity.series[0].commands,undefined);
 assert.equal((await request(`/${session._id}/people?kind=command&key=hello&planTier=pro`)).status,403);
 assert.equal((await request(`/${session._id}/compare/${historical._id}`)).status,403);
 await mongo.connection.db.collection('users').updateOne({'accounts.id':channel},{$set:{plan_tier:'premium'}});
 assert.equal((await request(`/${session._id}/compare/${historical._id}`)).status,200);
 assert.equal((await request(`/${session._id}/people?kind=command&key=hello`)).status,403);
 await mongo.connection.db.collection('users').updateOne({'accounts.id':channel},{$set:{plan_tier:'pro'}});
 response=await(await request(`/${session._id}/people?kind=command&key=hello`)).json();assert.equal(response.data.items[0].label,'Viewer');assert.equal(response.data.items[0].count,1);
 assert.equal((await request(`/${session._id}/people?kind=command&key=hello&cursor=bad`)).status,400);
 assert.equal((await request(`/${session._id}/credits`,'heavy-admin')).status,403);
 assert.equal((await request(`/${session._id}/credits`)).status,200);
 await Markers.insertMany(Array.from({length:150},(_,i)=>({channelID:channel,session_id:session._id,key:`note-${i}`,kind:'note',label:`Moment ${i}`,occurredAt:new Date(+start+(i+1)*1000),expiresAt:new Date(now+86400000)})));
 const first=await(await request(`/${session._id}/moments`)).json();assert.equal(first.data.events.length,100);assert.ok(first.data.cursor);
 const second=await(await request(`/${session._id}/moments?cursor=${encodeURIComponent(first.data.cursor)}`)).json();assert.equal(second.data.events.length,51);
 assert.equal(new Set([...first.data.events,...second.data.events].map(r=>r.id)).size,151);
 assert.equal((await request(`/${session._id}/moments?from=-1`)).status,400);
 console.log('PASS API: tier enforcement, tenant isolation, permission separation, comparison, metadata-only details, cursor validation and moment pagination');
}
// Seed actual metadata receipts, then exercise the real incremental projector.
const size=Number(process.env.TIMELINE_LOAD_EVENTS||100000);
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const seedStart=performance.now();
for(let offset=0;offset<size;offset+=2000){
 const count=Math.min(2000,size-offset);
 await Activity.collection.insertMany(Array.from({length:count},(_,j)=>{
  const i=offset+j,command=i%5===0,at=new Date(+start+(i%28000)*1000);
  return {_id:hash(`load-${i}`),channelID:channel,session_id:session._id,occurredAt:at,offset:i%28000,
   kind:command?'command':'message',key:command?`cmd${i%20}`:'',label:command?`!cmd${i%20}`:'',actor:`u${i%100}`,actorLabel:`Viewer ${i%100}`,
   value:1,outcome:i%10===0?'error':'ok',emotes:!command&&i%3===0?[{key:'twitch:25',label:'Kappa',count:2}]:[],processed:false,expiresAt:new Date(now+86400000)};
 }),{ordered:false});
}
const projectionStart=performance.now(),projectionCpuStart=process.cpuUsage();
const processing=drain();
const during=[];
if(process.env.SAAS_TARGET==='api')for(let wave=0;wave<3;wave++){
 await Promise.all(Array.from({length:10},async()=>{const t=performance.now();const r=await request(`/${session._id}`);assert.equal(r.status,200);await r.arrayBuffer();during.push(performance.now()-t);}));
}
await processing;
const projectionCpu=process.cpuUsage(projectionCpuStart);
const projectionMs=performance.now()-projectionStart;
activity=await getStreamActivity(channel,session._id,'pro');
assert.equal(activity.totals.commands,Math.ceil(size/5)+1);assert.equal(activity.totals.messages,size-Math.ceil(size/5)+1);
assert.equal(activity.pending,false);assert.ok(activity.series.length<=96);
const actorTotal=await Aggregate.aggregate([{$match:{channelID:channel,session_id:session._id,scope:'actor',kind:'command'}},{$group:{_id:null,count:{$sum:'$count'}}}]);
assert.equal(actorTotal[0].count,activity.totals.commands);
const query=Aggregate.find({channelID:channel,session_id:session._id,scope:'rank',kind:'command'}).sort({count:-1,_id:1}).limit(20);
const explain=await query.explain('executionStats');
assert.ok(explain.executionStats.totalDocsExamined<=100,`Too much rank query work: ${explain.executionStats.totalDocsExamined}`);
if(process.env.SAAS_TARGET==='api'){
 const times=[];let bytes=0;
 for(const concurrency of [1,10,50]){
  const samples=[];
  await Promise.all(Array.from({length:concurrency},async()=>{
   const t=performance.now(),r=await request(`/${session._id}`);assert.equal(r.status,200);
   const text=await r.text();bytes=Math.max(bytes,Buffer.byteLength(text));
   const body=JSON.parse(text);assert.equal(body.data.activity.totals.commands,Math.ceil(size/5)+1);
   samples.push(performance.now()-t);
  }));
  samples.sort((a,b)=>a-b);const p95=samples[Math.ceil(samples.length*.95)-1];times.push({concurrency,p95Ms:Math.round(p95)});
  assert.ok(p95<2000,`Timeline p95 exceeded 2s: ${p95}`);
 }
 assert.ok(bytes<250000,`Response too large: ${bytes}`);
 during.sort((a,b)=>a-b);const duringP95=during[Math.ceil(during.length*.95)-1];assert.ok(duringP95<2000);
 const detailStarted=performance.now();const detail=await request(`/${session._id}/people?kind=command&key=cmd0`);assert.equal(detail.status,200);await detail.arrayBuffer();const detailMs=performance.now()-detailStarted;assert.ok(detailMs<1000);
 const storage=await mongo.connection.db.command({dbStats:1});
 console.log(JSON.stringify({check:'timeline-load',events:size,duringProjectionP95Ms:Math.round(duringP95),detailMs:Math.round(detailMs),projectionCpuMs:Math.round((projectionCpu.user+projectionCpu.system)/1000),projectionProcessRssBytes:process.memoryUsage().rss,dbDataBytes:storage.dataSize,dbIndexBytes:storage.indexSize,seedAndProjectionMs:Math.round(performance.now()-seedStart),projectionMs:Math.round(projectionMs),maxResponseBytes:bytes,queries:times,rankDocsExamined:explain.executionStats.totalDocsExamined}));
}
console.log(`PASS: ${size} metadata events projected without raw scans on timeline reads; retry fence, distinct buckets, exact command totals, actor totals, and indexed ranking`);
process.exit(0);
