import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const require=createRequire('/app/package.json');const {createClient}=require('redis');
execFileSync('node',['--test','dist/utils/observability/telemetry.test.js','dist/utils/domain_event_consumer.test.js'],{stdio:'inherit'});
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
const t=await import('/app/dist/utils/observability/telemetry.js');
const redis=await getDragonflyClient('observability-fixture');assert(redis.isReady);
t.telemetryTesting.reset();
await t.restoreContext({traceId:'c'.repeat(32),spanId:'d'.repeat(16),sampled:true},'123',async()=>{await redis.set('observability:test','value');assert.equal(await redis.get('observability:test'),'value');assert.equal(await redis.get('observability:missing'),null);assert.equal(await redis.ping(),'PONG');});
const snapshot=t.telemetryTesting.snapshot();assert(snapshot.metrics.some(m=>m.kind==='cache_lookup'&&m.outcome==='hit'));assert(snapshot.metrics.some(m=>m.kind==='cache_lookup'&&m.outcome==='miss'));assert(snapshot.spans.every(s=>s.channel==='123'));
await t.flushTelemetry();const inspector=createClient({url:'redis://redis:6379'});await inspector.connect();const batch=(await inspector.lRange(t.TELEMETRY_INBOX,0,99)).map(JSON.parse).find(b=>b.spans.some(s=>s.channel==='123'));assert(batch);assert(batch.metrics.some(m=>m.kind==='cache'));
// Analytics Redis failures must not affect application work; reconnect on the next flush.
t.telemetryTesting.stop();const original=process.env.DRAGONFLY_HOST;process.env.DRAGONFLY_HOST='127.0.0.1';t.startTelemetry();t.observe('event','outage-test');await t.flushTelemetry();assert(t.telemetryTesting.snapshot().dropped>0);process.env.DRAGONFLY_HOST=original;t.observe('event','recovered');await t.flushTelemetry();assert((await inspector.lRange(t.TELEMETRY_INBOX,0,99)).map(JSON.parse).some(b=>b.metrics.some(m=>m.name==='recovered')));
// Exercise the real HTTP server where present, including an unavailable analytics backend.
if(process.env.SAAS_TARGET==='api'||process.env.OBS_TEST_TARGET==='api'){const response=await fetch('http://127.0.0.1:3000/observability/api/session');assert.equal(response.status,503);const blocked=await fetch('http://127.0.0.1:3000/observability/not-allowed');assert.equal(blocked.status,404);await fetch('http://127.0.0.1:3000/observability-test-unmatched');}

if(process.env.SAAS_TARGET==='bot'){
 let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch('http://127.0.0.1:3333/eventsub',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status===403;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,500));}assert(ready,'real bot webhook ready');
 const id='observability-fixture',timestamp=new Date().toISOString(),body=JSON.stringify({challenge:'analytics-ok',subscription:{type:'channel.chat.message'}});
 const signature='sha256='+createHmac('sha256',process.env.TWITCH_EVENTSUB_SECRET).update(id+timestamp+body).digest('hex');
 const challenge=await fetch('http://127.0.0.1:3333/eventsub',{method:'POST',body,headers:{'content-type':'application/json','Twitch-Eventsub-Message-Id':id,'Twitch-Eventsub-Message-Timestamp':timestamp,'Twitch-Eventsub-Message-Type':'webhook_callback_verification','Twitch-Eventsub-Message-Signature':signature}});assert.equal(challenge.status,200);assert.equal(await challenge.text(),'analytics-ok');
 const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');const mongo=await getMongoDBConnection('observability-check');
 const {CommandsSchema}=await import('/app/dist/schemas/commands.schema.js');const {ChannelModerationSettingsSchema}=await import('/app/dist/schemas/channel_moderation_settings.schema.js');const {messageHandler}=await import('/app/dist/handlers/message.handler.js');
 await redis.hSet('accounts:twitch:998801:data',{id:'998801',name:'observabilityfixture',plan_tier:'pro'});await redis.set('app:twitch:token','dummy-app',{EX:3600});await redis.hSet('accounts:twitch:698614112:data',{id:'698614112',access_token:'dummy',expires_at:String(Math.floor(Date.now()/1000)+3600)});
 await ChannelModerationSettingsSchema.create({channelID:'998801',channel:'observabilityfixture',enabled:false});await CommandsSchema.create({channelID:'998801',channel:'observabilityfixture',cmd:'analyticscheck',name:'analyticscheck',func:'custom',message:'Fixture success',cooldown:0,enabled:true,userLevel:1});
 t.telemetryTesting.reset();await t.restoreContext({traceId:'e'.repeat(32),spanId:'f'.repeat(16),sampled:true},'998801',()=>messageHandler('998801',{chatter_user_id:'viewer-id',chatter_user_login:'viewer',chatter_user_name:'Viewer',badges:[],message_id:'fixture-chat',message:{text:'!analyticscheck',fragments:[]}}));
 const data=t.telemetryTesting.snapshot();assert(data.metrics.some(m=>m.kind==='chat'&&m.outcome==='ok'));assert(data.metrics.some(m=>m.kind==='command'&&m.name==='analyticscheck'));assert(data.metrics.some(m=>m.kind==='chat_stage'&&m.name==='delivery'));assert(data.metrics.some(m=>m.kind==='database'&&m.channel==='998801'));assert(data.spans.filter(s=>s.kind==='command'||s.kind==='chat').every(s=>s.traceId==='e'.repeat(32)));await t.flushTelemetry();await mongo.disconnect();
}
if(process.env.SAAS_TARGET==='cron'){const cmdlines=fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).flatMap(pid=>{try{return[fs.readFileSync('/proc/'+pid+'/cmdline','utf8')]}catch{return[]}});assert(cmdlines.some(c=>c.includes('dist/workers/timer.worker.js')),'cron must start its actual workers');}
await new Promise(r=>setTimeout(r,11000));const exports=(await inspector.lRange(t.TELEMETRY_INBOX,0,99)).map(JSON.parse);assert(exports.some(b=>b.service===process.env.SAAS_TARGET&&b.metrics.some(m=>m.kind==='runtime')),'running service must export runtime telemetry');
t.telemetryTesting.stop();await inspector.quit();await redis.quit();console.log('Runtime, Redis proxy, bounded export, outage recovery and tracing checks passed');process.exit(0);
