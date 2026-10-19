import assert from 'node:assert/strict';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {getMongoDBConnection} from '/app/dist/utils/databases/mongodb.database.js';
import {getDragonflyClient} from '/app/dist/utils/databases/dragonfly.database.js';
import {getChannelEmoteCatalog as catalog} from '/app/dist/utils/twitch_emotes.js';
import {getTtsEmoteNames} from '/app/dist/utils/tts/emote_names.util.js';
import {getChannelEmoteNames} from '/app/dist/utils/ai/emote_context.ai.js';
import {DashboardActivityDailySchema as Daily,DashboardActivitySummarySchema as Summary} from '/app/dist/schemas/dashboard_activity.schema.js';
import {queueDashboardActivity as queue,refreshDashboardActivityOnce as refresh,dashboardDayStart,dashboardRangeStart} from '/app/dist/utils/dashboard_activity.js';
import Users from '/app/dist/schemas/users.schema.js';
await getMongoDBConnection('dashboard-emote-check');const redis=await getDragonflyClient('dashboard-emote-check');
await Promise.all([Daily.init(),Summary.init()]);
const directory='/tmp/saas-fixtures',channel='99008801',other='99008802',empty='99008803',failed='99008804',malformed='99008805';
const now=new Date(),expiresAt=new Date(+now+86400000),day=dashboardDayStart(now);
const own=Array.from({length:60},(_,i)=>({id:'owner_'+i,name:'MyEmote'+i}));
fs.writeFileSync(`${directory}/emotes-${channel}.json`,JSON.stringify(own));
fs.writeFileSync(`${directory}/emotes-global.json`,JSON.stringify([{id:'25',name:'Kappa'}]));
fs.writeFileSync(`${directory}/emote-mode-${failed}`,'fail');fs.writeFileSync(`${directory}/emote-mode-${malformed}`,'malformed');
let looked=await catalog(channel);assert.equal(looked.status,'ready');assert.equal(looked.emotes.length,60);
assert.equal((await catalog(other)).emotes.length,0);assert.equal((await catalog(empty)).status,'ready');
assert.equal((await catalog(failed)).status,'unavailable');assert.equal((await catalog(malformed)).status,'unavailable');
const log=()=>fs.readFileSync(`${directory}/calls.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
let calls=log().filter(row=>row.emoteCatalog===channel).length;
await Promise.all(Array.from({length:20},()=>catalog(channel)));assert.equal(log().filter(row=>row.emoteCatalog===channel).length,calls);
// Both old consumers reuse the complete ID/name catalog while retaining their output contracts.
assert.deepEqual((await getTtsEmoteNames(channel)).sort(),['Kappa',...own.map(row=>row.name)].sort());
assert.deepEqual((await getChannelEmoteNames(channel)).sort(),own.slice(0,40).map(row=>row.name).sort());
assert.equal(log().filter(row=>row.emoteCatalog===channel).length,calls);
assert.deepEqual(await getChannelEmoteNames(empty),['Kappa']);
assert.deepEqual(await getTtsEmoteNames(empty),['Kappa']);
// On an outage, a recent last-good list is visibly stale; after a day it is unavailable.
const key=`twitch:${channel}:emote-catalog:v1`;
await redis.set(key,JSON.stringify({emotes:own,checkedAt:new Date(+now-7200000).toISOString(),retryAt:0}));
fs.writeFileSync(`${directory}/emote-mode-${channel}`,'fail');looked=await catalog(channel);assert.equal(looked.status,'stale');assert.equal(looked.emotes.length,60);
await redis.set(key,JSON.stringify({emotes:own,checkedAt:new Date(+now-2*86400000).toISOString(),retryAt:0}));assert.equal((await catalog(channel)).status,'unavailable');
fs.unlinkSync(`${directory}/emote-mode-${channel}`);await redis.del(key);await catalog(channel);
if(process.env.SAAS_TARGET==='bot'){
 assert.ok(log().some(row=>row.emoteCatalog===channel));
 console.log('PASS BOT: shared native channel catalog, complete names for speech, AI names/global fallback contract, cache isolation/deduplication, empty/failure/stale/expired handling');process.exit(0);
}
const rows=[...own.map((emote,i)=>({_id:`own-${i}`,channelID:channel,day,kind:'emote',key:`twitch:${emote.id}`,label:emote.name,count:i+1,firstAt:now,expiresAt})),
 ...Array.from({length:6},(_,i)=>({_id:`global-${i}`,channelID:channel,day,kind:'emote',key:`twitch:global_${i}`,label:own[i].name,count:1000,firstAt:now,expiresAt})),
 {_id:'cmd',channelID:channel,day,kind:'command',key:'hello',label:'!hello',count:9,firstAt:now,expiresAt},
 {_id:'old',channelID:channel,day:new Date(+dashboardRangeStart(7,now)-86400000),kind:'emote',key:'twitch:owner_0',label:own[0].name,count:5,firstAt:now,expiresAt},
 {_id:'tenant',channelID:other,day,kind:'emote',key:'twitch:owner_0',label:own[0].name,count:999999,firstAt:now,expiresAt},
 {_id:'expired',channelID:channel,day,kind:'emote',key:'twitch:owner_0',label:own[0].name,count:999999,firstAt:now,expiresAt:new Date(+now-1)}];
await Daily.collection.insertMany(rows);await queue(channel);
if(process.env.SAAS_TARGET==='cron'){
 const deadline=Date.now()+30000;while(Date.now()<deadline&&!(await Summary.findById(channel).lean())?.payload?.['7']?.emoteCatalog)await new Promise(r=>setTimeout(r,100));
 const state=await Summary.findById(channel).lean();assert.equal(state.payload['7'].streamerEmoteUses,1830);assert.equal(state.payload['30'].streamerEmoteUses,1835);assert.equal(state.payload['7'].commandRuns,9);
 assert.equal(state.payload['7'].streamerEmotes[0].key,'twitch:owner_59');assert.equal(state.payload['7'].emoteUses,7830);
 console.log('PASS CRON: real supervised dashboard worker prepares both scopes independently before top-five ranking and preserves command totals');process.exit(0);
}
await refresh();const state=await Summary.findById(channel).lean();assert.equal(state.payload['7'].streamerEmoteUses,1830);assert.equal(state.payload['30'].streamerEmoteUses,1835);
assert.equal(state.payload['7'].streamerEmotes.length,5);assert.equal(state.payload['7'].emotes.some(row=>row.key.startsWith('twitch:owner_')),false,'own emotes below global top-five still rank in own scope');
await Users.create({name:'Emote Fixture',plan_tier:'free',accounts:[{type:'twitch',id:channel,name:'emotefixture',actived:true,has_permissions:true}]});
await redis.hSet('token:emote-owner',{id:channel,login:'emotefixture',display_name:'Fixture'});await redis.hSet('token:emote-other',{id:other,login:'other',display_name:'Other'});
const request=(params='',token='emote-owner')=>fetch(`http://127.0.0.1:3000/dashboard/${channel}/activity${params}`,{headers:token?{Authorization:`Bearer ${token}`}:{}});
assert.equal((await request('',null)).status,401);assert.equal((await request('','emote-other')).status,403);assert.equal((await request('?emoteScope=nope')).status,400);
for(const tier of ['free','premium','pro']){
 await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:tier}});
 const ownBody=await(await request()).json();assert.equal(ownBody.data.summary.emoteScope,'streamer');assert.equal(ownBody.data.summary.emoteUses,1830);assert.equal(ownBody.data.summary.emotes[0].key,'twitch:owner_59');assert.equal(ownBody.data.summary.commandRuns,9);
 const all=await(await request('?emoteScope=all')).json();assert.equal(all.data.summary.emoteUses,7830);assert.equal(all.data.summary.emotes.length,5);assert.ok(all.data.summary.emotes[0].key.startsWith('twitch:global_'));assert.equal(all.data.summary.streamerEmotes,undefined);
 assert.equal((await(await request('?days=30')).json()).data.summary.emoteUses,1835);
}
calls=log().filter(row=>row.emoteCatalog===channel).length;const timings=[];let bytes=0;
await Promise.all(Array.from({length:50},async(_,i)=>{const t=performance.now(),response=await request(`?days=${i%2?7:30}&emoteScope=${i%2?'streamer':'all'}`);assert.equal(response.status,200);const body=await response.text();bytes=Math.max(bytes,Buffer.byteLength(body));timings.push(performance.now()-t);}));
assert.equal(log().filter(row=>row.emoteCatalog===channel).length,calls,'dashboard reads never call Twitch');timings.sort((a,b)=>a-b);assert.ok(timings[47]<2000);
// Old summaries must never silently pass all emotes off as owned during rollout.
await Summary.updateOne({_id:channel},{$unset:{'payload.7.emoteCatalog':1,'payload.7.streamerEmotes':1,'payload.7.streamerEmoteUses':1}});
const legacy=await(await request()).json();assert.equal(legacy.data.pending,true);assert.deepEqual(legacy.data.summary.emotes,[]);assert.equal(legacy.data.summary.emoteUses,null);
console.log(JSON.stringify({check:'dashboard-emote-scopes',concurrentReads:50,p95Ms:Math.round(timings[47]),maxBytes:bytes,catalogCallsDuringReads:0}));
console.log('PASS API: ID-based ownership vs same-name outsiders, both ranges/scopes, complete own ranks/totals, access/privacy/isolation, legacy cache upgrade and provider failure semantics');process.exit(0);
