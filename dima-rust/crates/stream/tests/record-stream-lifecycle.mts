// Frozen TypeScript; real scratch Mongo/Dragonfly only, all outside requests forbidden.
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {writeFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`),mongoose=require('mongoose'),{EJSON}=require('bson');
const childOp=process.env.DIMA_LIFECYCLE_CHILD_OP;
const database=process.env.DIMA_LIFECYCLE_CHILD_DB||`dima_test_stream_${crypto.randomUUID().replaceAll('-','')}`,prefix=database+':';
if(!database.startsWith('dima_test_stream_'))throw Error('unsafe scratch database');
if(!childOp)console.log('lifecycle scratch database',database);
process.env.OBSERVABILITY_DISABLED='true';process.env.SECRET_KEY='lifecycle-scratch-only';
process.env.DRAGONFLY_HOST='127.0.0.1';process.env.DRAGONFLY_PORT='6379/6';
let n=0;crypto.randomUUID=(()=>{const x=(++n).toString(16).padStart(2,'0');return `${x.repeat(4)}-${x.repeat(2)}-4${x.slice(1)}${x}-${((n&63)|128).toString(16)}${x}-${x.repeat(6)}`;}) as any;syncBuiltinESMExports();
const now=1794355200000,RealDate=Date;
class FixedDate extends RealDate {constructor(...a:any[]){super(...(a.length?a:[now])as[any]);}static now(){return now;}static [Symbol.hasInstance](v:any){return v instanceof RealDate;}}
Object.defineProperty(FixedDate,'name',{value:'Date'});
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex').slice(0,24);
function ejson(v:any){globalThis.Date=RealDate;try{return EJSON.serialize(v,{relaxed:false});}finally{globalThis.Date=FixedDate as any;}}
const {getDragonflyClient}=await import(`${root}/src/utils/databases/dragonfly.database.ts`),cache=await getDragonflyClient('lifecycle-recording'),send=cache.sendCommand.bind(cache);
cache.exists=(...keys:any[])=>send(['EXISTS',...keys.flat().map(k=>prefix+k)]);
cache.eval=(script:string,o:any)=>send(['EVAL',script,String(o.keys.length),...o.keys.map((k:string)=>prefix+k),...o.arguments]);
cache.set=async()=> 'OK';cache.expire=async()=>1;
globalThis.fetch=(()=>{throw Error('outbound forbidden');})as any;
async function main(){try {
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 const a=await import(`${root}/src/utils/stream_analytics.ts`),{StreamSessionSchema:S}=await import(`${root}/src/schemas/stream_session.schema.ts`),{CronJobIntentSchema:I}=await import(`${root}/src/schemas/cron_job_intent.schema.ts`),{ClipRecommendationConfigSchema:C}=await import(`${root}/src/schemas/clip_recommendation_config.schema.ts`),{default:U}=await import(`${root}/src/schemas/users.schema.ts`);
 const models=[S,I,C,U];await Promise.all(models.map(m=>m.init()));globalThis.Date=FixedDate as any;
 if(childOp){
  const barrier=mongoose.connection.db.collection('lifecycle_test_barrier');
  await barrier.insertOne({_id:process.pid,ready:true});
  const deadline=RealDate.now()+60000;
  while(!await barrier.findOne({_id:'release'})){if(RealDate.now()>deadline)throw Error('race barrier deadline');await new Promise(r=>setTimeout(r,10));}
  n=0;const op=JSON.parse(childOp);let result=null;try{await a[op.kind==='online'?'recordStreamOnlineEvent':'recordStreamOfflineEvent'](op.input);}catch(e:any){result=e.prerequisite?{prerequisite:e.prerequisite}:{error:e.message};}
  await mongoose.connection.db.collection('lifecycle_test_results').insertOne({kind:op.kind,result});return;
 }

 let trace:string[]=[],attempts:any={},fault:string|undefined,stopAfter=0,stopped:any;
 for(const model of [S,I])for(const method of ['updateOne','findOneAndUpdate','insertOne']){
  const original=model.collection[method].bind(model.collection);
  model.collection[method]=async(...args:any[])=>{
   let op='';const [f,u]=args;
   if(model===S){if(method==='findOneAndUpdate')op='createSession';else if(method==='updateOne'){if(u.$set?.status==='orphaned')op='orphanOldSession';else if(u.$set?.status==='offline')op='markSessionOffline';else if(u.$set?.status==='live'&&!u.$unset)op='updateExistingSession';}}
   if(op){attempts[op]=(attempts[op]||0)+1;if(fault===op&&attempts[op]===1){const e:any=Error('injected write conflict');e.code=112;throw e;}}
   const result=await original(...args);
   trace.push(model===S?(op||'receipt'):'job');
   if(stopAfter && trace.length===stopAfter){stopAfter=0;stopped();await new Promise(()=>{});}
   return result;
  };
 }
 const find=S.collection.findOne.bind(S.collection);S.collection.findOne=async(f:any,...rest:any[])=>{
  const op=f.$or?'findActiveSession':f.status==='live'&&f.ended_at===null&&!f.stream_id?'findExistingLiveSession':'';
  if(op){attempts[op]=(attempts[op]||0)+1;if(fault===op&&attempts[op]===1){const e:any=Error('injected write conflict');e.code=112;throw e;}}
  return find(f,...rest);
 };
 const start=new RealDate(now-3600000).toISOString(),end=new RealDate(now-1000).toISOString();
 const online=(channelID='channel',streamID='s1',eventKey:any='online',startedAt=start)=>({kind:'online',input:{channelID,channel:'👋éשם',streamID,startedAt,...(eventKey?{eventKey}:{}),reopenClosed:false}});
 const offline=(channelID='channel',eventKey:any='offline',endedAt=end)=>({kind:'offline',input:{channelID,endedAt,...(eventKey?{eventKey}:{})}});
 const live=(extra:any={})=>({_id:new mongoose.Types.ObjectId('0123456789abcdef01234567'),channelID:'channel',channel:'👋éשם',stream_id:'s1',started_at:new RealDate(start),status:'live',...extra});
 async function snapshot(){
  const maps=new Map<string,string>();for(const d of await S.collection.find({}).toArray())maps.set(String(d._id),String(d._id).startsWith('012345')?String(d._id):hash(`${d.channelID}:${d.stream_id}`));
  const replace=(v:any):any=>typeof v==='string'?[...maps].reduce((s,[old,id])=>s.replaceAll(old,id),v):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
  const docs:any={};for(const m of models){docs[m.collection.name]=(await m.collection.find({},{promoteValues:false}).toArray()).map((d:any)=>{if(m===I)d._id=new mongoose.Types.ObjectId('000000000000000000000000');return replace(ejson(d));}).sort((a:any,b:any)=>JSON.stringify(a._id).localeCompare(JSON.stringify(b._id)));}
  const state=[];for(const key of (await cache.keys(prefix+'*')).sort()){const type=await cache.type(key),ttl=await cache.ttl(key);const value=type==='list'?(await cache.lRange(key,0,-1)).map((v:string)=>replace(JSON.parse(v))):await cache.get(key);state.push({key:replace(key.slice(prefix.length)),type,ttl,value});}
  return {documents:docs,cache:state};
 }
 async function reset(seed:any[],plan:any='pro',enabled:any=true){
  for(const m of models)await m.collection.deleteMany({});const keys=await cache.keys(prefix+'*');if(keys.length)await cache.del(keys);n=0;trace=[];attempts={};fault=undefined;stopAfter=0;
  for(const s of seed){await S.create(s);await S.collection.updateOne({_id:s._id},{$set:{unknown_preserved:'seed'}});}
  if(enabled!==null)await C.create({_id:new mongoose.Types.ObjectId('000000000000000000000010'),channelID:'channel',autoAnalyzeEnabled:enabled});
  if(plan!==null)await U.create({_id:new mongoose.Types.ObjectId('000000000000000000000020'),plan_tier:plan,refreshed_at:new RealDate(now),plan_tier_until:new RealDate(now-86400000),accounts:[{_id:new mongoose.Types.ObjectId('000000000000000000000021'),type:'twitch',id:'channel'}]});
  trace=[];attempts={};return snapshot();
 }
 async function call(op:any){let result=null;try{await a[op.kind==='online'?'recordStreamOnlineEvent':'recordStreamOfflineEvent'](op.input);}catch(e:any){result=e.prerequisite?{prerequisite:e.prerequisite}:{error:e.message};}return result;}
 const cases:any[]=[];
 async function scenario(name:string,seed:any[],ops:any[],plan:any='pro',enabled:any=true,injected?:string){
  const initial=await reset(seed,plan,enabled);const steps=[];
  for(const op of ops){trace=[];attempts={};fault=injected;const randomBefore=n,result=await call(op);steps.push({...op,randomBefore,result,trace:[...trace],attempts:{...attempts},...await snapshot()});fault=undefined;}
  cases.push({name,seed:initial.documents,steps});
 }

 await scenario('fallback-stream-and-time',[],[{kind:'online',input:{channelID:'channel',channel:'👋éשם'}},{kind:'online',input:{channelID:'channel',channel:'👋éשם'}}]);
 await scenario('invalid-start-time',[],[{kind:'online',input:{channelID:'channel',channel:'👋éשם',startedAt:'invalid',eventKey:'invalid-start'}}]);
 await scenario('offline-default-time',[live()],[{kind:'offline',input:{channelID:'channel',eventKey:'default-end'}}]);
 await scenario('first-repeat-same-stream',[],[online(),online(),online('channel','s1','refresh'),online('channel','s1',null)]);
 await scenario('supersede',[live()],[online('channel','s2','online',new RealDate(now-1800000).toISOString()),online('channel','s2','online',new RealDate(now-1800000).toISOString()),offline(),offline(),online('channel','s2','online',new RealDate(now-1800000).toISOString())]);
 await scenario('equal-start-different-stream',[live()],[online('channel','s2')]);
 await scenario('offline-repeat',[live()],[offline(),offline(),online(),offline('channel','other-offline')]);
 await scenario('offline-unkeyed-repeat',[live()],[offline('channel',null),offline('channel',null)]);
 await scenario('offline-before-online',[],[offline(),online(),offline()]);
 await scenario('missing-unkeyed',[],[offline('channel',null),online('','s1'),offline('')]);
 await scenario('stale-online',[live()],[online('channel','old','older',new RealDate(now-7200000).toISOString())]);
 await scenario('stale-offline',[live({started_at:new RealDate(now-500)})],[offline()]);
 await scenario('newer-already-offline',[live({status:'offline',ended_at:new RealDate(end)})],[online('channel','old','older',new RealDate(now-7200000).toISOString())]);
 for(const delta of [-60001,-60000,0,60000,60001])await scenario(`snapshot-window-${delta}`,[live({status:'orphaned',closure_source:'snapshot',ended_at:new RealDate(RealDate.parse(end)+delta),consecutive_offline_checks:2})],[offline()]);
 await scenario('recover-snapshot',[live({status:'orphaned',closure_source:'snapshot',ended_at:new RealDate(end),consecutive_offline_checks:2})],[online()]);
 await scenario('receipt-blocks-reopen',[live({status:'orphaned',closure_source:'snapshot',ended_at:new RealDate(end),consecutive_offline_checks:2,offline_summary_enqueued_at:new RealDate(now)})],[online()]);
 await scenario('closed-no-key',[live({status:'offline',ended_at:new RealDate(end)})],[online('channel','s1',null)]);
 await scenario('legacy-orphan-reopen',[live({status:'orphaned',ended_at:new RealDate(end)})],[{...online('channel','s1',null),input:{...online('channel','s1',null).input,reopenClosed:true}}]);
 for(const plan of [null,'free','premium','pro'])for(const enabled of [null,false,true])await scenario(`plan-${plan}-${enabled}`,[live()],[offline()],plan,enabled);
 await scenario('zero-duration',[live({started_at:new RealDate(end)})],[offline()]);
 await scenario('legacy-repair',[live({status:'orphaned',ended_at:new RealDate(end),consecutive_offline_checks:2})],[{...offline(),input:{...offline().input,repairSessionID:'0123456789abcdef01234567'}}]);
 await scenario('ambiguous',[live(),live({_id:new mongoose.Types.ObjectId('0123456789abcdef01234568'),stream_id:'old',status:'offline',started_at:new RealDate(now-7200000),ended_at:new RealDate(end)})],[offline()]);
 for(const op of ['findExistingLiveSession','updateExistingSession','orphanOldSession','createSession','findActiveSession','markSessionOffline']){
  const seed=op==='createSession'||op==='findExistingLiveSession'?[]:[live()];const action=op==='orphanOldSession'?online('channel','s2','online',new RealDate(now-1800000).toISOString()):op.includes('Offline')||op==='findActiveSession'?offline('channel',null):online();
  await scenario(`retry-${op}`,seed,[action],'pro',true,op);
 }
 for(const op of ['findActiveSession','markSessionOffline'])await scenario(`keyed-no-retry-${op}`,[live()],[offline()],'pro',true,op);

 await scenario('same-stream-race-online-first',[live()],[online(),offline(),online(),offline()]);
 await scenario('same-stream-race-offline-first',[live()],[offline(),online(),online(),offline()]);
 const newOnline=online('channel','s2','online-new',new RealDate(now-1800000).toISOString()),staleOffline=offline('channel','offline',new RealDate(now-2700000).toISOString());
 await scenario('new-stream-race-online-first',[live()],[newOnline,staleOffline,newOnline,staleOffline]);
 await scenario('new-stream-race-offline-first',[live()],[staleOffline,newOnline,newOnline,staleOffline]);
 // Observe every committed Mongo write of normal online/offline, pause immediately after it,
 // then deliver again. The stalled invocation never resumes; no timer keeps it alive.
 const faults=[];
 for(const [name,seed,op]of [['online-first',[],online()],['online-supersede',[live()],online('channel','s2','online',new RealDate(now-1800000).toISOString())],['online-refresh',[live()],online()],['online-recover',[live({status:'orphaned',closure_source:'snapshot',ended_at:new RealDate(end),consecutive_offline_checks:2})],online()],['online-historical',[live()],online('channel','old','older',new RealDate(now-7200000).toISOString())],['online-closed-receipt',[live({status:'offline',ended_at:new RealDate(end)})],online()],['offline',[live()],offline()],['offline-unkeyed',[live()],offline('channel',null)]]as any[]){
  await reset(seed);trace=[];await call(op);const writes=trace.length;
  for(let cut=1;cut<=writes;cut++){
   const initial=await reset(seed);trace=[];attempts={};stopAfter=cut;
   const paused=new Promise<void>(resolve=>{stopped=resolve;});void call(op);
   await Promise.race([paused,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('write not observed')),60000);timer.unref();})]);
   const partial=await snapshot();trace=[];attempts={};const randomBefore=n,result=await call(op);
   faults.push({name,cut,seed:initial.documents,op,partial,randomBefore,result,...await snapshot()});
  }
 }

 const races=[];
 for(const [name,seed,ops]of [['same-online',[],[online(),online()]],['online-offline',[live()],[online(),offline()]],['new-online-stale-offline',[live()],[newOnline,staleOffline]]]as any[]){
  const initial=await reset(seed);await mongoose.connection.db.collection('lifecycle_test_barrier').deleteMany({});await mongoose.connection.db.collection('lifecycle_test_results').deleteMany({});
  const children=ops.map((op:any)=>{const child=spawn(process.execPath,['--import',`${root}/node_modules/tsx/dist/loader.mjs`,process.argv[1]],{env:{...process.env,DIMA_LIFECYCLE_CHILD_DB:database,DIMA_LIFECYCLE_CHILD_OP:JSON.stringify(op)},stdio:['ignore','ignore','inherit']});return new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`child exit ${code}`)));});});
  const deadline=RealDate.now()+60000;
  while(await mongoose.connection.db.collection('lifecycle_test_barrier').countDocuments({ready:true})!==2){if(RealDate.now()>deadline)throw Error('children did not reach barrier');await new Promise(r=>setTimeout(r,10));}
  await mongoose.connection.db.collection('lifecycle_test_barrier').insertOne({_id:'release'});await Promise.all(children);
  const outcomes=await mongoose.connection.db.collection('lifecycle_test_results').find({}).toArray();
  // Durable redelivery settles CAS losers without opening an already closed stream.
  const redeliveries=[];for(const op of ops){const randomBefore=n,result=await call(op);redeliveries.push({op,randomBefore,result});}
  races.push({name,seed:initial.documents,ops,outcomes:outcomes.map((d:any)=>({kind:d.kind,result:d.result})),redeliveries,...await snapshot()});
 }
 await writeFile(process.argv[2],JSON.stringify({now,cases,faults,races},null,2)+'\n');console.log(`recorded ${cases.length} lifecycle scenarios, ${faults.length} write interruptions`);
}finally{globalThis.Date=RealDate;await mongoose.disconnect();if(!childOp){const {MongoClient}=require('mongodb');const cleanup=new MongoClient(process.env.DIMA_TEST_MONGO_URI,{serverSelectionTimeoutMS:5000});try{await cleanup.connect();await cleanup.db(database).dropDatabase();}finally{await cleanup.close();}}if(!childOp){const keys=await cache.keys(prefix+'*');if(keys.length)await cache.del(keys);}await cache.quit();}
}
await main();
