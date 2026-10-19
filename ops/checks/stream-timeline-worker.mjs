import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { StreamSessionSchema as Sessions } from '/app/dist/schemas/stream_session.schema.js';
import { DomainEventSchema as Events } from '/app/dist/schemas/domain_event.schema.js';
import { DomainEventDeliverySchema as Deliveries } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { StreamActivitySchema as Activity } from '/app/dist/schemas/stream_activity.schema.js';
import { captureStreamActivity, getStreamActivity } from '/app/dist/utils/stream_activity.js';
import { StreamMarkerSchema as Markers } from '/app/dist/schemas/stream_timeline.schema.js';
await getMongoDBConnection('timeline-worker-check');
const channel='533538623', now=Date.now(), start=new Date(now-3600000);
const session=await Sessions.create({channelID:channel,stream_id:'worker-fixture',started_at:start,status:'live'});
for(let i=0;i<20;i++) await captureStreamActivity({channelID:channel,eventID:`worker-${i}`,kind:'command',key:'hello',actor:`u${i%4}`,occurredAt:new Date(now-1000)});
const fixtures=[['channel.follow','channel.follow.received',{}],['channel.subscribe','channel.subscription.received',{tier:'1000',is_gift:false}],['channel.subscription.gift','channel.subscription.gifted',{tier:'1000',total:3,is_anonymous:false}],['channel.bits.use','channel.bits.received',{bits:100}],['channel.raid','channel.raid.received',{from_broadcaster_user_id:'999',from_broadcaster_user_name:'Raider',to_broadcaster_user_id:channel,viewers:30}]];
for(const [original,type,extra] of fixtures){
 const sourceEventId=`worker-${original}`;
 await Events.create({eventKey:['twitch-eventsub',sourceEventId,type].map(encodeURIComponent).join(':'),source:'twitch-eventsub',sourceEventId,type,topic:'channel',channelID:channel,
  subject:{provider:'twitch',kind:'streaming-account',id:channel},occurredAt:new Date(now-5000),expiresAt:new Date(now+86400000),
  payload:{subscription:{type:original},event:{broadcaster_user_id:channel,user_id:'444',user_name:'Viewer',...extra}},metadata:{originalEventType:original}});
}
// The running supervisor's children must do this work; this check never calls the projector or consumer.
const deadline=Date.now()+60000;
let activity;
do{
 activity=await getStreamActivity(channel,session._id,'pro');
 if(activity.totals?.commands===20&&activity.totals?.raids===1&&!activity.pending) break;
 await new Promise(resolve=>setTimeout(resolve,250));
}while(Date.now()<deadline);
assert.equal(activity.totals?.commands,20);
assert.equal(activity.totals?.follows,1);assert.equal(activity.totals?.subs,4);assert.equal(activity.totals?.bits,100);assert.equal(activity.totals?.raids,1);
assert.equal((await Markers.findOne({kind:'raid'}).lean()).value,30);
assert.equal(await Activity.countDocuments({processed:false}),0);
assert.equal(await Markers.countDocuments({channelID:channel}),5);
assert.equal(await Deliveries.countDocuments({consumer:'stream-timeline-v1',status:'succeeded'}),5);
console.log('PASS CRON runtime: supervisor projects command receipts and consumes follow/sub/gift/bits/raid journal events into markers and exact aggregates');
process.exit(0);
