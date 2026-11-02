// Exact candidate with isolated dependencies only. Never use against a live deployment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CronJobIntentSchema as Intents } from '/app/dist/schemas/cron_job_intent.schema.js';
import { ChannelAIPersonalitySchema as Personality } from '/app/dist/schemas/channel_ai_personality.schema.js';
import { ClipRecommendationSchema as Clips } from '/app/dist/schemas/clip_recommendation.schema.js';
import { enqueueCronJob } from '/app/dist/utils/cron_jobs_queue.js';
import { createDurableCronJobs, durableAutomaticAcceptanceKey } from '/app/dist/utils/durable_cron_jobs.js';

assert.equal(process.env.SAAS_DISPOSABLE_DOWNSTREAM_CHECK, 'yes');
assert.equal(process.env.DRAGONFLY_HOST, 'redis');
assert.equal(new URL(process.env.MONGO_URI).hostname, 'mongo');
await getMongoDBConnection('downstream-durability-check');
assert.equal(mongoose.connection.name, 'saas_ops_downstream_durability_test');
const redis = await getDragonflyClient('downstream-durability-check');
await Intents.init();
const until = async (fn, label, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
};
const target = process.env.SAAS_TARGET;
assert(['api', 'bot', 'cron'].includes(target));
if (target === 'api') assert.equal((await fetch('http://127.0.0.1:3000/config/site/analytics')).status, 200);
if (target === 'bot') await until(async () => { try { return (await fetch('http://127.0.0.1:3333/eventsub', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status === 403; } catch { return false; } }, 'bot ready');

const memoryQueue = 'cron:stream-memory:queue';
const clipQueue = 'cron:clip-recommendations:queue';
const future = Math.floor(Date.now() / 1000) + 3600;
const inputs = [
 {job:'stream-memory-summary',queueKey:memoryQueue,channelID:'fixture-future-memory',data:{source:'stream_offline',sessionID:'future-memory',notBeforeUnix:future}},
 {job:'clip-recommendation-analysis',queueKey:clipQueue,channelID:'fixture-future-clip',data:{source:'stream_offline',sessionID:'future-clip',vodUrl:'https://fixture.invalid/future-vod',notBeforeUnix:future}}
];
for (const input of inputs) {
 const result = await enqueueCronJob(input); assert.equal(result.enqueued, true);
 assert.equal((await Intents.findOne({jobID:result.job.id}).lean()).status, 'queued');
 assert.equal((await enqueueCronJob(input)).enqueued, false);
}
const legacyInput = {job:'stream-memory-summary',queueKey:memoryQueue,channelID:'fixture-legacy',data:{source:'stream_offline',sessionID:'bare-marker'}};
const bareMarker = 'cron:jobs:accepted:stream-memory-summary:fixture-legacy:bare-marker';
await redis.set(bareMarker,'1');
const bare = await enqueueCronJob(legacyInput);
assert.equal(bare.enqueued,false);
assert.equal((await Intents.findOne({jobID:bare.job.id}).lean()).status,'legacy_accepted');
// FLUSHDB is legal only for the explicitly named isolated dependency; cron has
// live test worker locks, so the full loss scenario runs on api and bot instead.
if (target !== 'cron') {
 assert.equal(process.env.SAAS_DISPOSABLE_DOWNSTREAM_CHECK, 'yes');
 assert.equal(process.env.DRAGONFLY_HOST, 'redis');
 await redis.flushDb();
 for (const input of inputs) assert.equal((await enqueueCronJob(input)).enqueued, false);
 assert.equal(await Intents.countDocuments({status:'queued',queueKey:{$in:[memoryQueue,clipQueue]}}), 2);
 const afterDue = createDurableCronJobs({now:()=>new Date((future+1)*1000),cache:async()=>redis});
 for (const key of [memoryQueue,clipQueue]) {
   const restored = await afterDue.recover(key,{limit:100});
   assert.equal(restored.published,1); assert.equal(await redis.lLen(key),1);
 }
 console.log('PASS full disposable Redis loss preserves real producer acceptance in Mongo.');
}

let nowMs = Date.now();
const durable = createDurableCronJobs({now:()=>new Date(nowMs),cache:async()=>redis});
const queue = 'fixture:durable:queue';
const make = (id, data={}) => ({id,job:'fixture-job',requestedAt:new Date(nowMs).toISOString(),channelID:'fixture',dedupeKey:`fixture:${id}`,data});
const prep = async job => durable.prepare(job,queue,{dedupeSeconds:60,acceptanceKey:durableAutomaticAcceptanceKey(job)});
const first = make('queue-loss',{source:'stream_offline',sessionID:'queue-loss'});
await prep(first); await durable.publish(first,queue);
const marker = durableAutomaticAcceptanceKey(first);
assert.equal(await redis.get(marker), '1'); await redis.del(queue);
assert.equal(await redis.get(marker), '1');
let recovered = await durable.recover(queue,{limit:100}); assert.equal(recovered.published,1);
assert.equal(await redis.lLen(queue),1);
const claims = await Promise.all([durable.claim(first,queue,'one'),durable.claim(first,queue,'two')]);
assert.deepEqual(claims.map(c=>c.status).sort(),['busy','claimed']);
const winner = claims.find(c=>c.status==='claimed').claim;
assert.equal(await durable.complete({...winner,token:'stale'}),false);
assert.equal(await durable.complete(winner),true);
await redis.del([queue,marker]); nowMs += 86400000;
assert.equal((await prep({...first,id:'queue-loss-duplicate'})).created,false);
assert.equal((await durable.claim(first,queue,'duplicate')).status,'terminal');
assert.equal((await durable.recover(queue,{limit:100})).published,0);
console.log('PASS queue-only loss, duplicate claim, fencing and permanent automatic dedupe.');

// Simulate both an outage and a lost response after Redis accepted the Lua write.
for (const afterWrite of [false,true]) {
 const fault = make(`publication-${afterWrite}`); await prep(fault);
 const failing = createDurableCronJobs({now:()=>new Date(nowMs),cache:async()=>({eval:async (...args)=>{
   if (afterWrite) await redis.eval(...args);
   throw new Error('fixture publication failure');
 }})});
 await assert.rejects(()=>failing.publish(fault,queue),/fixture publication failure/);
 assert.equal((await Intents.findOne({jobID:fault.id}).lean()).status,'queued');
 await redis.del(queue);
 assert.equal((await durable.recover(queue,{limit:100})).published,1);
 assert.equal((await redis.lRange(queue,0,-1)).filter(raw=>JSON.parse(raw).id===fault.id).length,1);
 const faultClaim = await durable.claim(fault,queue,'fault-owner'); assert.equal(faultClaim.status,'claimed');
 assert.equal(await durable.complete(faultClaim.claim),true);
 await redis.del(queue);
}
const restart = make('new-process'); await prep(restart); await durable.publish(restart,queue); await redis.del(queue);
const childSource = `import {getMongoDBConnection} from '/app/dist/utils/databases/mongodb.database.js';
import {createDurableCronJobs} from '/app/dist/utils/durable_cron_jobs.js';
await getMongoDBConnection('restart-check');
const result=await createDurableCronJobs({now:()=>new Date(${nowMs})}).recover('fixture:durable:queue',{limit:100});
if(result.published!==1) throw new Error(JSON.stringify(result)); process.exit(0);`;
const restarted = spawnSync(process.execPath,['--input-type=module','-e',childSource],{encoding:'utf8',timeout:30000,env:process.env});
assert.equal(restarted.status,0,restarted.stdout+restarted.stderr); assert.equal(await redis.lLen(queue),1); await redis.del(queue);
const restartClaim = await durable.claim(restart,queue,'restart-owner'); assert.equal(restartClaim.status,'claimed');
assert.equal(await durable.complete(restartClaim.claim),true);
const retryJob = make('retry-canonical'); await prep(retryJob);
const retryClaim = await durable.claim(retryJob,queue,'retry-owner'); assert.equal(retryClaim.status,'claimed');
const changed = {...retryJob,data:{attempt:2}};
assert.equal(await durable.retry(retryClaim.claim,changed,new Date(nowMs+10000)),true);
assert.equal((await durable.recover(queue,{limit:100})).published,0);
nowMs += 10001;
assert.equal((await durable.recover(queue,{limit:100})).published,1);
assert.equal(JSON.parse((await redis.lRange(queue,0,-1))[0]).data.attempt,2); await redis.del(queue);
const retryDone = await durable.claim(changed,queue,'retry-winner'); assert.equal(retryDone.status,'claimed');
assert.equal(await durable.complete(retryDone.claim),true);
console.log('PASS publication outage/lost reply, separate-process recovery and canonical scheduled retry.');

const legacy = make('legacy-bare',{source:'stream_offline',sessionID:'legacy-bare'});
const legacyKey = durableAutomaticAcceptanceKey(legacy);
assert.equal((await durable.prepare(legacy,queue,{dedupeSeconds:60,acceptanceKey:legacyKey,legacyAccepted:true})).status,'legacy_accepted');
assert.equal((await durable.recover(queue,{limit:100})).published,0);
const adopted = {...legacy,id:'legacy-payload',data:{...legacy.data,proof:'original'}};
const adoptedClaim = await durable.claim(adopted,queue,'adopter');
assert.equal(adoptedClaim.status,'claimed'); assert.equal(adoptedClaim.job.data.proof,'original');
assert.equal(await durable.complete(adoptedClaim.claim),true);
assert.equal((await durable.claim(legacy,queue,'duplicate')).status,'terminal');
const interrupted = make('interrupted'); await prep(interrupted);
const held = await durable.claim(interrupted,queue,'lost-owner'); assert.equal(held.status,'claimed');
nowMs += 5*60*1000+1;
recovered = await durable.recover(queue,{limit:100}); assert.equal(recovered.uncertain,1);
assert.equal((await Intents.findById(held.claim.intentId).lean()).status,'uncertain');
assert.equal(await durable.complete(held.claim),false);
assert.equal((await durable.claim(interrupted,queue,'new-owner')).status,'terminal');
const dead = make('dead'); await prep(dead); const deadClaim = await durable.claim(dead,queue,'owner');
assert.equal(await durable.dead(deadClaim.claim,'fixture'),true);
assert.equal((await durable.claim(dead,queue,'other')).status,'terminal');
console.log('PASS legacy acceptance/adoption, expired claims become uncertain, terminal work is not replayed.');

const manual = make('manual-original', {source:'manual'}); await prep(manual);
const manualClaim = await durable.claim(manual,queue,'manual-owner');
assert.equal(manualClaim.status,'claimed'); assert.equal(await durable.complete(manualClaim.claim),true);
nowMs += 60001;
assert.equal((await durable.claim({...manual,id:'manual-delayed-alias'},queue,'stale-owner')).status,'terminal');
assert.equal(await Intents.countDocuments({activeKey:`${queue}\0${manual.dedupeKey}`}),1);
const freshManual = {...manual,id:'manual-fresh',requestedAt:new Date(nowMs).toISOString()};
const freshClaim = await durable.claim(freshManual,queue,'fresh-owner');
assert.equal(freshClaim.status,'claimed'); assert.equal(await durable.complete(freshClaim.claim),true);
console.log('PASS delayed legacy aliases stay terminal after dedupe expiry; genuinely new requests can run.');

// Future and blocked work cannot consume a bounded recovery pass.
for (let i=0;i<110;i++) await prep(make(`future-${i}`,{notBeforeUnix:Math.floor(nowMs/1000)+3600}));
for (let i=0;i<110;i++) {
 const blocked = make(`blocked-${i}`); await prep(blocked);
 await Intents.updateOne({jobID:blocked.id},{$set:{nextPublishAt:new Date(nowMs+3600000)}});
}
for (let i=0;i<105;i++) await prep(make(`due-${i}`));
recovered = await durable.recover(queue,{limit:100}); assert.equal(recovered.examined,100); assert.equal(recovered.published,100);
recovered = await durable.recover(queue,{limit:100}); assert.equal(recovered.examined,5); assert.equal(recovered.published,5);
assert.equal(await redis.lLen(queue),105);
console.log('PASS bounded recovery drains ready backlog despite 110 future jobs.');

if (target === 'cron') {
  await Personality.collection.insertOne({channelID:'fixture-memory',streamSummariesEnabled:false});
  const pending = {id:'fixture-memory-pending',job:'stream-memory-summary',requestedAt:new Date().toISOString(),channelID:'fixture-memory',data:{source:'stream_offline',sessionID:'pending-without-transport'}};
  await createDurableCronJobs().prepare(pending,memoryQueue,{dedupeSeconds:60,acceptanceKey:durableAutomaticAcceptanceKey(pending)});
  assert.equal((await Intents.findOne({jobID:pending.id}).lean()).status,'queued');
  await until(async()=> (await Intents.findOne({jobID:pending.id}).lean())?.status === 'completed','actual memory worker pending recovery',75000);
  const memory = await enqueueCronJob({job:'stream-memory-summary',queueKey:memoryQueue,channelID:'fixture-memory',data:{source:'stream_offline',sessionID:'memory-worker'}});
  assert.equal(memory.enqueued,true);
  await until(async()=> (await Intents.findOne({jobID:memory.job.id}).lean())?.status === 'completed','actual memory worker completed');
  await Clips.collection.insertOne({channelID:'fixture-clip',vodUrl:'https://fixture.invalid/vod',queueJobID:'fixture-clip-completed',status:'completed',billingStatus:'charged',analysisCompletedAt:new Date(),candidateCount:1,approvedCount:1});
  const clip = {id:'fixture-clip-completed',job:'clip-recommendation-analysis',requestedAt:new Date().toISOString(),channelID:'fixture-clip',data:{vodUrl:'https://fixture.invalid/vod'}};
  await redis.lPush(clipQueue,JSON.stringify(clip));
  await until(async()=> (await Intents.findOne({jobID:clip.id}).lean())?.status === 'completed','actual clip worker completed');
  const stale = {...clip,id:'fixture-stale-clip',requestedAt:new Date(Date.now()-7*86400000).toISOString()};
  await redis.lPush(clipQueue,JSON.stringify(stale));
  await until(async()=> (await Intents.findOne({jobID:stale.id}).lean())?.status === 'dead','actual clip worker stale deadline');
  assert.equal(await Clips.countDocuments({queueJobID:stale.id}),0);
  console.log('PASS actual cron supervisor memory and clip workers: disabled memory, completed clip, expired clip dead-letter.');
}

const run = (args,label) => {
  const child = spawnSync(process.execPath,args,{cwd:'/app',encoding:'utf8',timeout:180000,maxBuffer:12*1024*1024,env:{...process.env,NODE_OPTIONS:''}});
  if (child.status !== 0) { process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); }
  assert.equal(child.status,0,`${label}: ${child.error || ''}`);
  assert.match(child.stdout,/ℹ tests [1-9][0-9]*/);
  assert.match(child.stdout,/ℹ fail 0/);
  assert.match(child.stdout,/ℹ skipped 0/);
  console.log(`${label}: ${child.stdout.split('\n').filter(line=>/ℹ (tests|pass|fail|skipped) /.test(line)).join(' ')}`);
};
run(['src/scripts/test_domain_pipeline.script.mjs','--test-reporter=spec'],'allowlisted domain pipeline');
run(['--experimental-test-module-mocks','--import','tsx','--test',
  'src/utils/durable_cron_jobs.test.ts',
  'src/utils/ai/clip_recommendations/clip_recommendation_claims.test.ts',
  'src/utils/ai/clip_recommendations/vod_clip_recommendation_runner.test.ts',
  'src/utils/ai/clip_recommendations/clip_recommendation_recovery.test.ts',
  'src/utils/ai/clip_recommendations/clip_recommendation_reconciliation.test.ts',
  'src/utils/ai/memory/stream_memory_runner_fencing.test.ts',
  'src/utils/ai/memory/stream_memory_apply_fencing.test.ts'], 'durable/clip/memory regressions');
console.log(`PASS downstream exact candidate: ${target}`);
process.exit(0);
