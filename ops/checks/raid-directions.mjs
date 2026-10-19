import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHmac } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Eventsub from '/app/dist/schemas/eventsub.schema.js';
import { DomainEventSchema as Events } from '/app/dist/schemas/domain_event.schema.js';
import { RaidAnalyticsHistorySchema as History, RaidAnalyticsSummarySchema as Summary } from '/app/dist/schemas/raid_analytics.schema.js';
import { RaidSubscriptionPreferenceSchema as Preferences } from '/app/dist/schemas/raid_subscription_preference.schema.js';
import { RaidSessionSchema as Sessions } from '/app/dist/schemas/raid_session.schema.js';
import { normalizeTwitchEventsubDomainEvent as normalize } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { validateDomainEventContract } from '/app/dist/domain_events/domain_event_contracts.js';
import { journalDomainEvent } from '/app/dist/utils/domain_events.js';
import { applyRaidAnalyticsEvent, projectRaidSummaryOnce, queueRaidSummary, raidRangeStart } from '/app/dist/utils/raid_analytics.js';
import { acceptsRaidNotification, shouldRepairRaid } from '/app/dist/utils/raid_subscriptions.js';
import { buildExpectedEventsubCondition } from '/app/dist/utils/eventsub_condition.js';
import { reconcileEventsubs } from '/app/dist/utils/eventsub_reconciliation.js';
import { applyFollowDefenseDomainEvent } from '/app/dist/domain_events/follow_defense_events.js';
import { DomainEventDeliverySchema as Deliveries } from '/app/dist/schemas/domain_event_delivery.schema.js';

const mongo=await getMongoDBConnection('raid-directions-check'), redis=await getDragonflyClient('raid-directions-check');
await Promise.all([Eventsub.init(),Events.init(),History.init(),Summary.init(),Preferences.init(),Sessions.init()]);
const channel='99005501', peer='99005502', third='99005503', now=Date.now(), at=new Date(now-3600000);
await Users.create({name:'Raid Fixture',accounts:[{type:'twitch',id:channel,name:'raidfixture',actived:true,has_permissions:true,chat_enabled:true}]});
await redis.hSet(`accounts:twitch:${channel}:data`,{id:channel,name:'raidfixture',actived:'true',has_permissions:'true',chat_enabled:'true',access_token:'dummy',expires_at:String(Math.floor(now/1000)+3600)});
await redis.set('app:twitch:token','app-token');
await redis.hSet('token:raid-owner',{id:channel,login:'raidfixture',display_name:'Fixture'});
await redis.hSet('token:raid-other',{id:peer,login:'other',display_name:'Other'});
const headers={Authorization:'Bearer raid-owner','Content-Type':'application/json'}, api='http://127.0.0.1:3000';
const request=(path,method='GET',body,token='raid-owner')=>fetch(api+path,{method,headers:{...headers,Authorization:`Bearer ${token}`},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
const remote=(id,condition)=>({id,type:'channel.raid',version:'1',condition,status:'enabled',cost:0,created_at:new Date().toISOString(),transport:{method:'webhook',callback:'https://subscriptions.domdimabot.com/eventsub'}});
let incoming, outgoing;
if(process.env.SAAS_TARGET==='api'){
 const catalog=await(await request('/site/events')).json();assert.ok(catalog.data.some(row=>row.type==='channel.raid.outgoing'));assert.ok(catalog.data.some(row=>row.type==='channel.raid'));
 const create=async(type,condition)=>{const r=await request(`/eventsubs/${channel}`,'POST',{type,version:'1',condition,config:{message:'',clipEnabled:false,minViewers:0}});assert.equal(r.status,201,await r.clone().text());return(await r.json()).data;};
 incoming=await create('channel.raid',{to_broadcaster_user_id:channel});outgoing=await create('channel.raid.outgoing',{from_broadcaster_user_id:channel});
 assert.notEqual(incoming._id,outgoing._id);assert.equal(outgoing.type,'channel.raid.outgoing');
 const listing=await(await request(`/eventsubs/${channel}`)).json();assert.deepEqual(listing.data.map(row=>row.type).sort(),['channel.raid','channel.raid.outgoing']);
 assert.equal((await request(`/eventsubs/${channel}`,'POST',{type:'channel.raid.outgoing',version:'1',condition:{from_broadcaster_user_id:peer}})).status,400);
 assert.equal((await request(`/eventsubs/${channel}/${outgoing._id}`,'PATCH',{condition:{from_broadcaster_user_id:peer}})).status,400);
 assert.equal((await request(`/dashboard/${channel}/raids?days=7`,'GET',null,'raid-other')).status,403);
 assert.equal((await request(`/dashboard/${channel}/raids?days=365`)).status,400);
}else{
 const a=remote('in',{to_broadcaster_user_id:channel}),b=remote('out',{from_broadcaster_user_id:channel});
 incoming=await Eventsub.create({...a,channelID:channel,channel:'raidfixture',enabled:true,message:'',minViewers:0,clipEnabled:false});
 outgoing=await Eventsub.create({...b,channelID:channel,channel:'raidfixture',enabled:true,message:'',minViewers:0,clipEnabled:false});
 fs.writeFileSync('/tmp/saas-fixtures/remote.json',JSON.stringify([a,b]));
}
assert.deepEqual(buildExpectedEventsubCondition({type:'channel.raid',condition:{from_broadcaster_user_id:'old'}},channel),{from_broadcaster_user_id:channel});
const event={from_broadcaster_user_id:peer,from_broadcaster_user_login:'friendly',from_broadcaster_user_name:'Friendly',to_broadcaster_user_id:channel,to_broadcaster_user_login:'raidfixture',to_broadcaster_user_name:'RaidFixture',viewers:30};
async function envelope(sub,raw,id,when=at){
 const input=normalize({messageId:id,messageTimestamp:when.toISOString(),subscription:{id:sub.id,type:'channel.raid',version:'1',condition:sub.condition},event:raw,durableDefenseHandled:true});
 validateDomainEventContract(input);
 return(await journalDomainEvent(input)).event;
}
const received=await envelope(incoming,event,'incoming-A');
const sent=await envelope(outgoing,{...event,from_broadcaster_user_id:channel,from_broadcaster_user_login:'raidfixture',to_broadcaster_user_id:peer,to_broadcaster_user_login:'friendly',to_broadcaster_user_name:'Friendly'},'outgoing-A',new Date(+at+600000));
assert.equal(received.type,'channel.raid.received');assert.equal(received.channelID,channel);
assert.equal(sent.type,'channel.raid.sent');assert.equal(sent.channelID,channel);assert.equal(sent.metadata.durableDefenseHandled,undefined);
await applyFollowDefenseDomainEvent(sent);assert.equal(await Sessions.countDocuments(),0);
if(process.env.SAAS_TARGET!=='cron')await Promise.all([applyRaidAnalyticsEvent(received),applyRaidAnalyticsEvent(received),applyRaidAnalyticsEvent(sent)]);
else for(let i=0;i<150&&await History.countDocuments()<2;i++)await new Promise(r=>setTimeout(r,200));
assert.equal(await History.countDocuments(),2);
const receivedB=await envelope(incoming,{...event,from_broadcaster_user_id:third,from_broadcaster_user_name:'Next Raider',viewers:50},'incoming-B',new Date(+at+120000));
if(process.env.SAAS_TARGET!=='cron')await applyRaidAnalyticsEvent(receivedB);
for(const [i,seconds] of [10,130,360].entries())await Events.create({eventKey:`follow-${i}`,source:'twitch-eventsub',sourceEventId:`follow-${i}`,type:'channel.follow.received',topic:'channel',channelID:channel,occurredAt:new Date(+at+seconds*1000),expiresAt:new Date(now+86400000),payload:{event:{user_id:`u${i}`}}});
if(process.env.SAAS_TARGET!=='cron')await projectRaidSummaryOnce();
else{
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){const snapshot=(await Summary.findById(channel).lean())?.payload?.['7'];if(snapshot?.totals.find(row=>row._id==='incoming')?.raids===2&&snapshot?.totals.find(row=>row._id==='outgoing')?.raids===1)break;await new Promise(r=>setTimeout(r,200));}
 assert.equal(await Deliveries.countDocuments({consumer:'raid-history-v1',status:'succeeded'}),3);
}
let state=await Summary.findById(channel).lean(), period=state.payload['7'];
assert.equal(period.totals.find(row=>row._id==='incoming').raids,2);assert.equal(period.totals.find(row=>row._id==='incoming').viewers,80);
assert.equal(period.totals.find(row=>row._id==='outgoing').raids,1);
if(process.env.SAAS_TARGET!=='cron'){
 assert.equal((await History.findOne({peerID:peer,direction:'incoming'}).lean()).followsAfter,1);
 assert.equal((await History.findOne({peerID:third,direction:'incoming'}).lean()).followsAfter,2);
 assert.ok(period.incoming.find(row=>row.peerID===peer).lastOutgoingAt);
}
assert.equal(await acceptsRaidNotification({id:outgoing.id,condition:outgoing.condition},{from_broadcaster_user_id:channel,to_broadcaster_user_id:peer}),true);
await Eventsub.updateOne({_id:outgoing._id},{$set:{enabled:false}});
assert.equal(await acceptsRaidNotification({id:outgoing.id,condition:outgoing.condition},{from_broadcaster_user_id:channel,to_broadcaster_user_id:peer}),false);
assert.equal(await acceptsRaidNotification({id:incoming.id,condition:incoming.condition},event),true);
assert.equal(await acceptsRaidNotification({id:'stale-remote',condition:incoming.condition},event),false);
await Eventsub.updateOne({_id:outgoing._id},{$set:{enabled:true}});

if(process.env.SAAS_TARGET==='api'){
 const count=await History.countDocuments();
 await reconcileEventsubs({requestDelayMs:0});
 assert.ok(await Eventsub.findById(incoming._id));assert.ok(await Eventsub.findById(outgoing._id));
 assert.equal(await Eventsub.countDocuments({channelID:channel,type:'channel.raid'}),2,'Repair must normalize empty unused raid conditions instead of duplicating each direction');
 for(const mode of ['http','throw']){
  fs.writeFileSync('/tmp/saas-fixtures/fail-delete',mode);
  assert.equal((await request(`/eventsubs/${channel}/${outgoing._id}`,'DELETE')).status,mode==='throw'?500:502);
  assert.equal(await shouldRepairRaid(channel,'outgoing'),true);
  assert.ok(await Eventsub.findById(outgoing._id));assert.equal(await History.countDocuments(),count);
 }
 fs.unlinkSync('/tmp/saas-fixtures/fail-delete');
 assert.equal((await request(`/eventsubs/${channel}/${outgoing._id}`,'DELETE')).status,200);
 assert.equal(await shouldRepairRaid(channel,'outgoing'),false);assert.equal(await shouldRepairRaid(channel,'incoming'),true);
 assert.equal(await History.countDocuments(),count);assert.ok(await Eventsub.findById(incoming._id));
 await reconcileEventsubs({requestDelayMs:0});
 assert.equal(await Eventsub.countDocuments({channelID:channel,'condition.from_broadcaster_user_id':channel}),0);
 assert.equal(await History.countDocuments(),count);
 assert.equal((await request(`/eventsubs/${channel}/${incoming._id}`,'DELETE')).status,200);
 assert.equal(await shouldRepairRaid(channel,'incoming'),false);
 const recreated=await request(`/eventsubs/${channel}`,'POST',{type:'channel.raid.outgoing',version:'1',condition:{from_broadcaster_user_id:channel},config:{message:''}});assert.equal(recreated.status,201);
 assert.equal(await shouldRepairRaid(channel,'outgoing'),true);assert.equal(await shouldRepairRaid(channel,'incoming'),false);
 const size=100000;
 for(let offset=0;offset<size;offset+=2000)await Events.collection.insertMany(Array.from({length:Math.min(2000,size-offset)},(_,j)=>({eventKey:`load-${offset+j}`,source:'twitch-eventsub',sourceEventId:`load-${offset+j}`,type:'channel.follow.received',topic:'channel',schemaVersion:1,channelID:channel,occurredAt:new Date(+at+30000),journaledAt:new Date(),payload:{event:{}},metadata:{},expiresAt:new Date(now+86400000)})));
 await History.updateMany({channelID:channel},{$set:{followsComputedAt:new Date(0)}});await queueRaidSummary(channel);await projectRaidSummaryOnce();
 state=await Summary.findById(channel).lean();assert.equal(state.payload['7'].totals.find(row=>row._id==='incoming').followsAfter,100003);
 // Late arrival repairs from provider occurrence time; no history is deleted or re-attributed by arrival time.
 await Events.create({eventKey:'late',source:'twitch-eventsub',sourceEventId:'late',type:'channel.follow.received',topic:'channel',channelID:channel,occurredAt:new Date(+at+60000),expiresAt:new Date(now+86400000),payload:{event:{}}});
 await History.updateMany({channelID:channel},{$set:{followsComputedAt:new Date(0)}});await queueRaidSummary(channel);await projectRaidSummaryOnce();
 const times=[];let bytes=0;
 await Promise.all(Array.from({length:50},async()=>{const begin=performance.now(),r=await request(`/dashboard/${channel}/raids?days=7`);assert.equal(r.status,200);const text=await r.text();bytes=Math.max(bytes,Buffer.byteLength(text));assert.equal(JSON.parse(text).data.summary.totals.find(row=>row._id==='incoming').followsAfter,100004);times.push(performance.now()-begin);}));
 times.sort((a,b)=>a-b);const p95=times[Math.ceil(times.length*.95)-1];assert.ok(p95<2000);assert.ok(bytes<30000);
 console.log(JSON.stringify({check:'raid-dashboard-load',sourceFollows:size,concurrentReaders:50,p95Ms:Math.round(p95),maxResponseBytes:bytes}));
 // Exact timestamp ties have a stable winner, so one follow cannot count in two raid windows.
 await History.insertMany(['0','1'].map(key=>({_id:key.repeat(64),channelID:third,direction:'incoming',peerID:peer,occurredAt:at,viewers:1,expiresAt:new Date(now+86400000)})));
 await Events.create({eventKey:'tied-follow',source:'twitch-eventsub',sourceEventId:'tied-follow',type:'channel.follow.received',topic:'channel',channelID:third,occurredAt:new Date(+at+10000),expiresAt:new Date(now+86400000),payload:{event:{}}});
 await queueRaidSummary(third);await projectRaidSummaryOnce();
 assert.equal((await History.findById('0'.repeat(64)).lean()).followsAfter,0);
 assert.equal((await History.findById('1'.repeat(64)).lean()).followsAfter,1);
 // UTC boundaries and logical expiry apply before Mongo's asynchronous TTL cleanup.
 const scope='99005504',clock=new Date(),day=86400000,start7=raidRangeStart(7,clock),start30=raidRangeStart(30,clock);
 await History.insertMany([
  [start7,1], [new Date(+start7-1),2], [start30,4], [new Date(+start30-1),8],
  [new Date(+clock-1000),16,new Date(+clock-1)], [new Date(+clock+day),32]
 ].map(([occurredAt,viewers,expiresAt],i)=>({_id:`boundary-${i}`,channelID:scope,direction:'outgoing',peerID:peer,occurredAt,viewers,expiresAt:expiresAt||new Date(+clock+day)})));
 await queueRaidSummary(scope);
 for(let i=0;i<10&&!(await Summary.findById(scope).lean())?.payload;i++)await projectRaidSummaryOnce();
 const boundary=await Summary.findById(scope).lean();
 assert.equal(boundary.payload['7'].totals[0].raids,1);assert.equal(boundary.payload['7'].totals[0].viewers,1);
 assert.equal(boundary.payload['30'].totals[0].raids,3);assert.equal(boundary.payload['30'].totals[0].viewers,7);
 assert.equal(+(await History.findOne({channelID:channel,peerID:peer,direction:'incoming'}).lean()).expiresAt,+received.expiresAt);
 await applyRaidAnalyticsEvent({...received,eventKey:'already-expired',expiresAt:new Date(+clock-1)});
 assert.equal(await History.countDocuments({channelID:channel}),3);
 assert.ok(History.schema.indexes().some(([keys,options])=>keys.expiresAt===1&&options.expireAfterSeconds===0));
 console.log('PASS API: independent subscriptions, owner-bound conditions, disable/delete/re-add, deletion survives reconciliation, history preserved, temporal follow counts with overlap/late repair, bounded dashboard reads and tenant isolation');
}

if(process.env.SAAS_TARGET==='bot'){
 fs.writeFileSync('/tmp/saas-fixtures/calls.jsonl','');
 async function notify(sub,raw){const id=randomUUID(),ts=new Date().toISOString(),body=JSON.stringify({subscription:{...remote(sub.id,sub.condition)},event:raw});const signature='sha256='+createHmac('sha256',process.env.TWITCH_EVENTSUB_SECRET).update(id+ts+body).digest('hex');const r=await fetch('http://127.0.0.1:3333/eventsub',{method:'POST',headers:{'Content-Type':'application/json','Twitch-Eventsub-Message-Id':id,'Twitch-Eventsub-Message-Timestamp':ts,'Twitch-Eventsub-Message-Signature':signature,'Twitch-Eventsub-Message-Type':'notification'},body});assert.equal(r.status,204);return id;}
 const raw={...event,from_broadcaster_user_id:channel,from_broadcaster_user_login:'raidfixture',to_broadcaster_user_id:peer,to_broadcaster_user_login:'friendly',to_broadcaster_user_name:'Friendly'};
 const silent=await notify(outgoing,raw);
 for(let i=0;i<60&&!await Events.exists({sourceEventId:silent});i++)await new Promise(r=>setTimeout(r,100));
 assert.equal((await Events.findOne({sourceEventId:silent}).lean()).type,'channel.raid.sent');
 await new Promise(r=>setTimeout(r,300));
 let calls=fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim();assert.doesNotMatch(calls,/"chat"|shoutouts|clips|moderation/);
 await Eventsub.updateOne({_id:outgoing._id},{$set:{message:'Raiding $(raid.channel) with $(raid.viewers)!'}});
 await notify(outgoing,raw);
 for(let i=0;i<60&&!fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').includes('"chat"');i++)await new Promise(r=>setTimeout(r,100));
 calls=fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const chat=calls.find(call=>call.chat);assert.ok(chat);assert.equal(chat.chat.broadcaster_id,channel);assert.match(chat.chat.message,/Raiding Friendly with 30!/);
 assert.equal(calls.some(call=>/shoutouts|clips|moderation/.test(call.endpoint||'')),false);
 await Eventsub.updateOne({_id:outgoing._id},{$set:{enabled:false}});const blocked=await notify(outgoing,raw);await new Promise(r=>setTimeout(r,300));assert.equal(await Events.exists({sourceEventId:blocked}),null);
 const inbound=await notify(incoming,event);for(let i=0;i<60&&!await Events.exists({sourceEventId:inbound});i++)await new Promise(r=>setTimeout(r,100));assert.ok(await Events.exists({sourceEventId:inbound}));
 console.log('PASS BOT: signed outgoing EventSub journals silently or posts only to the sending channel; no protection/clips/shoutouts; disabled outgoing does not affect incoming');
}
if(process.env.SAAS_TARGET==='cron')console.log('PASS CRON: real raid summary worker prepares incoming/outgoing history without dashboard source scans');
process.exit(0);
