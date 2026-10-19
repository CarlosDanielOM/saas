import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { StreamSessionSchema as Sessions } from '/app/dist/schemas/stream_session.schema.js';
import { StreamViewerSnapshotSchema as Snapshots } from '/app/dist/schemas/stream_viewer_snapshot.schema.js';
import { DomainEventSchema as Events } from '/app/dist/schemas/domain_event.schema.js';
import { DashboardInsightsSchema as Summary } from '/app/dist/schemas/dashboard_insights.schema.js';
import { insightIntervals, assignInsightFollow, calculateInsights, queueDashboardInsights as queue, refreshDashboardInsightsOnce as refresh } from '/app/dist/utils/dashboard_insights.js';
import { dashboardRangeStart } from '/app/dist/utils/dashboard_activity.js';
await getMongoDBConnection('insight-check'); const redis = await getDragonflyClient('insight-check');
await Promise.all([Sessions.init(), Snapshots.init(), Events.init(), Summary.init()]);
const channel='99007701',other='99007702',now=new Date(),expiry=new Date(+now+86400000),hour=3600000;
const fixed=new Date('2026-10-19T12:00:00Z');
const start=new Date('2026-10-18T23:00:00Z');
const session={_id:'overnight',started_at:start,ended_at:new Date(+start+2*hour),status:'offline',follows:8};
const snapshot=(offset,game='Game A',viewers=20)=>({session_id:session._id,captured_at:new Date(+start+offset),viewers,game_name:game});
// Multi-game split, weighted audience, final tail, missing start and long gaps.
const snapshots=[];for(let m=0;m<120;m+=5)snapshots.push(snapshot(m*60000,m<60?'Game A':'Game B',m<60?20:40));
const intervals=insightIntervals([session],snapshots);
assignInsightFollow(intervals,new Date(+start+hour-1));assignInsightFollow(intervals,new Date(+start+hour));assignInsightFollow(intervals,session.ended_at);
let report=calculateInsights([session],intervals,[],30,true,fixed);
assert.equal(report.weekdays.find(row=>row.weekday===0).streams,1);assert.equal(report.weekdays.find(row=>row.weekday===1).streams,0);
assert.equal(report.games[0].game,'Game B');assert.equal(report.games[0].viewerHours,40);assert.equal(report.games[0].follows,1);
assert.equal(report.games[1].viewerHours,20);assert.equal(report.games[1].follows,1);assert.equal(report.bestDay,null);assert.equal(report.bestGrowthGame,null);
assert.equal(report.weekdays.find(row=>row.streams).averageViewers,30);
const gap=insightIntervals([session],[snapshot(5*60000),snapshot(90*60000),snapshot(115*60000)]);
assert.equal(insightIntervals([session],[{...snapshot(0),game_name:null},snapshot(300000)]).length,1);
assert.equal(gap.length,1);assert.equal(gap[0].to-gap[0].from,5*60000);
assert.equal(calculateInsights([session],intervals,[start],30,true,fixed).streams,0);
assert.equal(calculateInsights([session],intervals,[session.ended_at],30,true,fixed).streams,1);
assert.equal(calculateInsights([session],intervals,[],30,false,fixed,true).games[0].follows,null);
const overlapping=insightIntervals([session,{...session,_id:'overlap'}],[snapshot(0),{...snapshot(0),session_id:'overlap'},snapshot(5*60000),{...snapshot(5*60000),session_id:'overlap'}]);
assignInsightFollow(overlapping,new Date(+start+1000));assert.equal(overlapping.reduce((n,row)=>n+row.follows,0),0);
// Practical sample guard requires two comparable groups; ties are deterministic.
const compare=[];const compareIntervals=[];
for(let i=0;i<6;i++){const d=new Date(Date.UTC(2026,9,6+(i%2)+7*Math.floor(i/2)));const s={_id:'s'+i,started_at:d,ended_at:new Date(+d+hour),status:'offline',follows:i%2?4:2};compare.push(s);compareIntervals.push({from:+d,to:+d+hour,session:s._id,game:i%2?'B':'A',viewers:10,follows:i%2?4:2});}
const comparison=calculateInsights(compare,compareIntervals,[],30,false,new Date('2026-10-29T00:00:00Z'));
assert.equal(comparison.bestDay,3);assert.equal(comparison.bestGrowthGame,'B');
const edge7=dashboardRangeStart(7,fixed),edge30=dashboardRangeStart(30,fixed);
const edges=[edge7,new Date(+edge7-1),edge30,new Date(+edge30-1)].map((at,i)=>({_id:'edge'+i,started_at:at,ended_at:new Date(+at+hour),status:'offline',follows:1}));
assert.equal(calculateInsights(edges,[],[],7,false,fixed).streams,1);
assert.equal(calculateInsights(edges,[],[],30,false,fixed).streams,3);
console.log('PASS CALCULATIONS: overnight UTC grouping, multi-game duration weighting, follow boundaries, gaps, raids, overlaps and sample guards');
await Users.create({name:'Insight Fixture',plan_tier:'free',accounts:[{type:'twitch',id:channel,name:'insightfixture',actived:true,has_permissions:true}]});
await redis.hSet('token:insight-owner',{id:channel,login:'insightfixture',display_name:'Fixture'});
await redis.hSet('token:insight-other',{id:other,login:'other',display_name:'Other'});
const request=(path,token='insight-owner')=>fetch('http://127.0.0.1:3000'+path,{headers:token?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(5000)});
if(process.env.SAAS_TARGET==='api'){
 assert.equal((await request(`/dashboard/${channel}/insights`,null)).status,401);
 assert.equal((await request(`/dashboard/${channel}/insights`,'insight-other')).status,403);
 for(const path of ['/dashboard/nope/insights',`/dashboard/${channel}/insights?days=8`,`/dashboard/${channel}/insights?raids=bad`])assert.equal((await request(path)).status,400);
 const cold=await(await request(`/dashboard/${channel}/insights`)).json();assert.equal(cold.data.pending,true);assert.equal(cold.data.summary,null);
}
// Live, orphaned, other-tenant and out-of-window sessions must not enter the cache.
const at=new Date(+now-3*hour),id=new mongoose.Types.ObjectId();
await Sessions.collection.insertMany([
 {_id:id,channelID:channel,started_at:at,ended_at:new Date(+at+2*hour),status:'offline',follows:12},
 {_id:new mongoose.Types.ObjectId(),channelID:channel,started_at:at,ended_at:null,status:'live',follows:999},
 {_id:new mongoose.Types.ObjectId(),channelID:channel,started_at:at,ended_at:new Date(+at+hour),status:'orphaned',follows:999},
 {_id:new mongoose.Types.ObjectId(),channelID:other,started_at:at,ended_at:new Date(+at+hour),status:'offline',follows:999},
 {_id:new mongoose.Types.ObjectId(),channelID:channel,started_at:new Date(+dashboardRangeStart(30,now)-1),ended_at:new Date(+dashboardRangeStart(30,now)+hour),status:'offline',follows:999}
].map((row,index)=>({...row,stream_id:'fixture-'+index})));
await Snapshots.collection.insertMany(Array.from({length:24},(_,i)=>({channelID:channel,session_id:id,captured_at:new Date(+at+i*300000),game_name:i<12?'First game':'Second game',viewers:i<12?10:30})));
const event=(key,type,occurredAt,extra={})=>({eventKey:key,source:'twitch-eventsub',sourceEventId:key,type,topic:'channel',schemaVersion:1,channelID:channel,occurredAt,expiresAt:expiry,payload:{SECRET_PERSON:'never return this'},metadata:{},...extra});
await Events.collection.insertMany([event('raid','channel.raid.received',at),event('outside-follow','channel.follow.received',new Date(+at-1)),event('expired-follow','channel.follow.received',at,{expiresAt:new Date(+now-1)}),event('future-follow','channel.follow.received',new Date(+now+hour))]);
await queue(channel);
if(process.env.SAAS_TARGET==='cron'){
 const {StreamActivitySchema:Activity}=await import('/app/dist/schemas/stream_activity.schema.js');
 const {DashboardActivitySummarySchema:Usage}=await import('/app/dist/schemas/dashboard_activity.schema.js');
 await Activity.collection.insertMany([
  {_id:'insights-command',channelID:channel,session_id:id,occurredAt:at,kind:'command',key:'hello',label:'!hello',processed:true,emotes:[],expiresAt:expiry},
  {_id:'insights-emote',channelID:channel,session_id:id,occurredAt:at,kind:'message',processed:true,emotes:[{key:'twitch:25',label:'Kappa',count:2}],expiresAt:expiry}
 ]);
 const deadline=Date.now()+30000;while(Date.now()<deadline&&!(await Summary.findById(channel).lean())?.payload)await new Promise(r=>setTimeout(r,100));
 const row=await Summary.findById(channel).lean();assert.equal(row.payload['30:include'].streams,1);assert.equal(row.payload['30:exclude'].streams,0);
 const usageDeadline=Date.now()+15000;while(Date.now()<usageDeadline&&!(await Usage.findById(channel).lean())?.payload)await new Promise(r=>setTimeout(r,100));
 const usage=await Usage.findById(channel).lean();assert.equal(usage.payload['7'].commandRuns,1);assert.equal(usage.payload['7'].emoteUses,2);
 console.log('PASS CRON: real supervised dashboard worker prepares both ranges/raid variants and continues processing command/emote metadata');process.exit(0);
}
await refresh();let state=await Summary.findById(channel).lean();
assert.equal(state.payload['30:include'].streams,1);assert.equal(state.payload['30:exclude'].streams,0);assert.equal(state.payload['30:exclude'].excludedStreams,1);
assert.equal(state.payload['30:include'].games[0].game,'Second game');assert.equal(state.payload['30:include'].games[0].viewerHours,30);
assert.equal(state.payload['30:include'].games[1].follows,0);assert.equal(state.payload['7:include'].streams,1);
// 100k retained follow timestamps are read only by the worker, in 500-row batches.
for(let offset=0;offset<100000;offset+=2000)await Events.collection.insertMany(Array.from({length:2000},(_,i)=>event(`heavy-${offset+i}`,'channel.follow.received',new Date(+at+((offset+i)%7200000)))));
// outside-follow is also in the retained range, so remove the fixture-only row to test exact cap.
await Events.deleteOne({eventKey:'outside-follow'});
await Summary.updateOne({_id:channel},{$set:{nextRefreshAt:new Date(0)}});
let started=performance.now();await refresh();const processingMs=Math.round(performance.now()-started);
state=await Summary.findById(channel).lean();assert.equal(state.payload['30:include'].limited,false);assert.equal(state.payload['30:include'].games.reduce((n,g)=>n+g.follows,0),100000);
const before=+state.updatedAt;const times=[];let bytes=0;
await Promise.all(Array.from({length:50},async()=>{const t=performance.now(),r=await request(`/dashboard/${channel}/insights?days=30&raids=include`);assert.equal(r.status,200);const body=await r.text();times.push(performance.now()-t);bytes=Math.max(bytes,Buffer.byteLength(body));assert.doesNotMatch(body,/SECRET_PERSON|never return|eventKey|sourceEventId/);assert.equal(JSON.parse(body).data.summary.games.length,2);}));
assert.equal(+(await Summary.findById(channel).lean()).updatedAt,before,'reads do not recompute reports');times.sort((a,b)=>a-b);const p95Ms=Math.round(times[47]);assert.ok(p95Ms<2000);assert.ok(bytes<15000);
// Above the explicit cap, report partial data and suppress recommendations/growth rates.
await Events.collection.insertOne(event('over-cap','channel.follow.received',at));await Summary.updateOne({_id:channel},{$set:{nextRefreshAt:new Date(0)}});await refresh();
state=await Summary.findById(channel).lean();assert.equal(state.payload['30:include'].limited,true);assert.equal(state.payload['30:include'].bestDay,null);assert.equal(state.payload['30:include'].games[0].followsPerHour,null);
await Summary.updateOne({_id:channel},{$set:{error:true}});assert.equal((await(await request(`/dashboard/${channel}/insights`)).json()).data.stale,true);
console.log(JSON.stringify({check:'dashboard-insights-heavy',sourceFollows:100000,processingMs,batchSize:500,readers:50,p95Ms,responseBytes:bytes}));
console.log('PASS API: cached 7/30 reports, authentication/isolation, raids, completed-only sessions, timestamps/expiry, privacy, processing caps and heavy-data response time');
process.exit(0);
