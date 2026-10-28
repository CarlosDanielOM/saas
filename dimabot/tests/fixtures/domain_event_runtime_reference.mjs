// Run only in a task-owned container. Fixture generation evaluates allowlisted
// pure modules; --bench uses actual TS/Mongoose against explicit disposable
// fixture resources, with no production environment/configuration loading.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER,'dimabot-migration','explicitly owned container/resources required');
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'package.json'));const ts=require('typescript');
const allowed=new Set(['src/domain_events/domain_event.types.ts','src/domain_events/domain_event_contracts.ts','src/domain_events/twitch_eventsub_events.ts','src/domain_events/polar_events.ts','src/overlays/interaction-model.ts','src/utils/raid_direction.ts','src/utils/shared_chat_origin.ts','src/utils/domain_events.ts','src/schemas/domain_event.schema.ts']);
const hashes={};const cache=new Map();let connection;let mongoose;
function load(relative){
  if(cache.has(relative))return cache.get(relative).exports;
  if(relative==='src/domain_events/domain_event_identity.ts')return {resolveDomainEventOwner(){throw Error('No owner lookup in normalization fixture')}};
  if(relative==='src/utils/observability/telemetry.ts')return {telemetryContext:()=>undefined,observe:()=>{}};
  if(relative==='src/utils/domain_event_wakeups.ts')return {domainEventWakeups:{publish(){}}};
  assert(allowed.has(relative),`Disallowed source ${relative}`);
  const live=path.join(root,relative);
  const source=readFileSync(existsSync(live)?live:path.resolve(root,'../archives/dimabot-typescript/2026-10-28',relative),'utf8');hashes[relative]=createHash('sha256').update(source).digest('hex');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};cache.set(relative,module);
  const localRequire=name=>{
    if(name==='mongoose'){assert(connection,'Mongoose is fixture-only');return {...mongoose,model:connection.model.bind(connection)}};
    assert(name.startsWith('.'),`Disallowed import ${name}`);
    return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative),name)).replace(/\.js$/,'.ts'));
  };
  new vm.Script(`(function(exports,require,module){${compiled}\n})`,{filename:relative}).runInThisContext()(module.exports,localRequire,module);
  return module.exports;
}

const now=Date.parse('2026-09-05T12:00:00.123Z');
const timestamp=new Date(now).toISOString();
const twitch=load('src/domain_events/twitch_eventsub_events.ts');
const polar=load('src/domain_events/polar_events.ts');
const cases=[];
function capture(name,operation,input,sdkDates=[]){
  const actual=structuredClone(input);
  for(const p of sdkDates){const keys=p.split('.');let value=actual.data;for(const key of keys.slice(0,-1))value=value[key];value[keys.at(-1)]=new Date(value[keys.at(-1)]);}
  let expected;try{const result=operation==='twitch'?twitch.normalizeTwitchEventsubDomainEvent(actual):polar.normalizePolarDomainEvent({webhookId:actual.webhookId,event:{type:actual.eventType,timestamp:new Date(actual.timestamp),data:actual.data}});expected={ok:true,result};}catch(e){expected={ok:false,error:e.message}};
  cases.push({name,operation,input,sdkDates,expected});
}
const follow={messageId:'message',messageTimestamp:timestamp,subscription:{type:'channel.follow',version:'2'},event:{broadcaster_user_id:'channel',user_id:'follower'}};
capture('twitch/follow','twitch',follow);
capture('twitch/follow-precise','twitch',{...follow,event:{...follow.event,followed_at:'2026-09-05T12:00:00.123456789Z'}});
capture('twitch/unknown-type-before-message-validation','twitch',{subscription:{type:'unknown'}});
capture('twitch/foreign-notice','twitch',{...follow,subscription:{type:'channel.chat.notification'},event:{broadcaster_user_id:'receiver',source_broadcaster_user_id:'origin'}});
for(const condition of [{to_broadcaster_user_id:'receiver'},{from_broadcaster_user_id:'sender'},{from_broadcaster_user_id:'sender',to_broadcaster_user_id:''}])capture(`twitch/raid/${JSON.stringify(condition)}`,'twitch',{messageId:'raid',subscription:{type:'channel.raid',condition},event:{to_broadcaster_user_id:'receiver',from_broadcaster_user_id:'sender',viewers:20},durableDefenseHandled:true});
for(const [name,change]of [['blank-type',{subscription:{type:' '}}],['missing-message',{messageId:null}],['invalid-source',{source:'other'}],['array-event',{event:[]}],['missing-channel',{event:{user_id:'follower'}}]])capture(`twitch/invalid/${name}`,'twitch',{...follow,...change});
const order={webhookId:'signed-receipt',eventType:'order.paid',timestamp,data:{id:'order',customerId:'customer',productId:'product',subscriptionId:'subscription',paid:true,status:'paid',totalAmount:600,subscription:{id:'subscription',recurringInterval:'year',currentPeriodEnd:timestamp},customer:{id:'customer',externalId:'0123456789abcdef01234567',email:'private@example.test',metadata:{twitch_user_id:'legacy-channel'}},billingName:'Private name'}};
capture('polar/order','polar',order,['subscription.currentPeriodEnd']);
capture('polar/order-requires-native-date','polar',order);
capture('polar/one-time','polar',{...order,data:{id:'order',customerId:'customer',paid:true,status:'paid',subscriptionId:null,productId:null}});
capture('polar/trial-zero','polar',{...order,data:{...order.data,totalAmount:0}},['subscription.currentPeriodEnd']);
for(const value of [-1,1.5,'600',Number.MAX_SAFE_INTEGER+1])capture(`polar/bad-amount/${value}`,'polar',{...order,data:{...order.data,totalAmount:value}},['subscription.currentPeriodEnd']);
capture('polar/conflicting-customer','polar',{...order,data:{...order.data,customer:{id:'other'}}},['subscription.currentPeriodEnd']);
for(const status of ['active','canceled'])capture(`polar/subscription/${status}`,'polar',{webhookId:'sub-receipt',eventType:'subscription.updated',timestamp,data:{id:'sub',customerId:'customer',productId:'product',status,recurringInterval:'month',currentPeriodEnd:timestamp,endsAt:'2026-10-05T12:00:00.000Z'}},['currentPeriodEnd','endsAt']);
capture('polar/state','polar',{webhookId:'state',eventType:'customer.state_changed',timestamp,data:{id:'customer',activeMeters:[{meterId:'meter',consumedUnits:12.5,creditedUnits:10,balance:-2.5}],activeSubscriptions:[{id:'sub',productId:'product',status:'trialing',trialStart:timestamp,trialEnd:null}],grantedBenefits:[{id:'grant',benefitId:'benefit'}]}},['activeSubscriptions.0.trialStart']);
capture('polar/unknown-sdk-date','polar',{webhookId:'unknown',eventType:'product.created',timestamp,data:{id:'product',createdAt:timestamp}},['createdAt']);
capture('polar/unknown-customer','polar',{webhookId:'unknown-customer',eventType:'customer.new',timestamp,data:{id:'customer',externalId:'0123456789abcdef01234567'}});

if(process.argv.includes('--bench')){
  mongoose=require('mongoose');
  const uri=process.env.DIMA_TEST_MONGO_URI;assert(uri,'disposable MongoDB required');
  const dbName=`domain_events_ts_${randomUUID().replaceAll('-','')}`;
  connection=await mongoose.createConnection(uri,{dbName}).asPromise();
  try{
    const schema=load('src/schemas/domain_event.schema.ts').DomainEventSchema;
    await schema.init();const journal=load('src/utils/domain_events.ts').journalDomainEvent;
    const iterations=Number(process.env.DOMAIN_JOURNAL_BENCH_ITERATIONS??1000);assert(Number.isSafeInteger(iterations)&&iterations>0);
    const generic=i=>({source:'migration-fixture',sourceEventId:`receipt-${i}`,type:'fixture.event',topic:'domain',schemaVersion:1,subject:{provider:'fixture',kind:'resource',id:'resource'},payload:{bits:Number.MAX_SAFE_INTEGER,fraction:1.25},retentionSeconds:1});
    let start=performance.now();for(let i=0;i<iterations;i++)assert.equal((await journal(generic(i))).inserted,true);const insertMs=performance.now()-start;
    start=performance.now();for(let i=0;i<iterations;i++)assert.equal((await journal(generic(i))).inserted,false);const duplicateMs=performance.now()-start;
    assert.equal(await schema.countDocuments({}),iterations);
    console.log(JSON.stringify({implementation:'typescript',workload:'domain-event-durable-journal',iterations,inserted:iterations,duplicates:iterations,insertMs,duplicateMs,insertNsPerOperation:insertMs*1e6/iterations,duplicateNsPerOperation:duplicateMs*1e6/iterations,writeConcern:{w:1,j:true},node:process.version}));
  }finally{await connection.dropDatabase();await connection.close();}
}else{
  writeFileSync(new URL('domain_event_runtime_cases.json',import.meta.url),JSON.stringify({sourceHashes:hashes,cases},null,2)+'\n');
  console.log(JSON.stringify({cases:cases.length,sourceFiles:Object.keys(hashes).length}));
}
