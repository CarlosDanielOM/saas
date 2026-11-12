// Reference recording; owns exactly one random scratch database, never production-copy data.
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`);
const mongoose=require('mongoose'),{EJSON}=require('bson');
const now=1794355200000,RealDate=Date;
class FixedDate extends RealDate {constructor(...args:any[]){super(...(args.length?args:[now]) as [any]);}static now(){return now;}}
process.env.SECRET_KEY='subscription-test-only-key';
// Isolate the reference logger: errors are recorded below; cache logging is a local mock.
const {getDragonflyClient}=await import(`${root}/src/utils/databases/dragonfly.database.ts`);
const cache=await getDragonflyClient('logger');
cache.set=async()=> 'OK';cache.expire=async()=>1;
// Mongoose clones dates by constructor.name; preserve that tag under a fixed clock.
Object.defineProperty(FixedDate,'name',{value:'Date'});
const database=`dima_test_stream_${randomUUID().replaceAll('-','')}`;
try {
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 const {StreamSubscriptionLedgerSchema:L}=await import(`${root}/src/schemas/stream_subscription_ledger.schema.ts`);
 const {recordSubscriptionLedgerStart:start,recordSubscriptionLedgerEnd:end}=await import(`${root}/src/utils/stream_analytics.ts`);
 await L.init();globalThis.Date=FixedDate as any;
 const steps:any[]=[];
 const base={streamer_id:' channel ',user_id:' viewer ',tier:' PRIME ',streamer_name:' שם👋é ',user_name:'\ufeff👋éשם\u00a0',subbed_at:new RealDate(now-10000),eventKey:'first'};
 async function run(name:string,kind:string,input:any,seed?:any){
  if(seed)await L.collection.insertOne(seed);
  await (kind==='start'?start:end)(input);
  const docs=(await L.collection.find({},{promoteValues:false}).sort({user_id:1,subbed_at:1,_id:1}).toArray()).map((d:any)=>{const v=EJSON.serialize(d,{relaxed:false});v._id={$oid:"000000000000000000000000"};return v;});
  steps.push({name,kind,input:EJSON.serialize(input,{relaxed:false}),seed:seed?EJSON.serialize(seed,{relaxed:false}):null,documents:docs});
 }
 await run('first','start',base);await run('repeat','start',base);
 await run('new-key-active','start',{...base,eventKey:'second'});
 await run('upgrade','start',{...base,tier:'2000',eventKey:'upgrade',subbed_at:new RealDate(now-9000)});
 await run('stale-start','start',{...base,eventKey:'stale'});
 await run('end','end',{streamer_id:'channel',user_id:'viewer',eventKey:'end',ended_at:new RealDate(now-8000)});
 await run('equal-ended-start','start',{...base,eventKey:'equal',subbed_at:new RealDate(now-8000)});
 await run('end-first','end',{streamer_id:'channel',user_id:'out-of-order',eventKey:'end-first',ended_at:new RealDate(now)});
 await run('late-start','start',{...base,user_id:'out-of-order',eventKey:'late'});
 await run('gift','start',{...base,user_id:'gift',tier:'3000',is_gift:true,eventKey:'gift'});
 await run('no-key-names','start',{streamer_id:'channel',user_id:'unnamed'});
 await run('empty-key','start',{streamer_id:'channel',user_id:'unnamed',eventKey:''});
 await run('missing-key-existing','start',{streamer_id:'channel',user_id:'gift',tier:'weird'});
 await run('newer-end','end',{streamer_id:'channel',user_id:'viewer',ended_at:new RealDate(now),eventKey:'end-again'});
 await run('older-end','end',{streamer_id:'channel',user_id:'viewer',ended_at:new RealDate(now-1),eventKey:'old-end'});
 const seed={platform:'twitch',streamer_id:'channel',user_id:'limit',streamer_login:'',streamer_name:'',user_login:'',user_name:'',sub_tier_raw:'',sub_tier_normalized:'unknown',is_gift:false,status:'active',subbed_at:new RealDate(now-1000),ended_at:null,last_event_at:new RealDate(now-1000),applied_event_keys:Array.from({length:10000},(_,i)=>`h${i}`),created_at:new RealDate(now),updated_at:new RealDate(now),__v:0};
 await run('history-limit','start',{streamer_id:'channel',user_id:'limit',eventKey:'limit-new'},seed);
 const faults:any[]=[];
 const collection=L.collection;
 for(const kind of ['start','end'])for(const existing of ['new','active','ended']){
  await collection.deleteMany({});
  const input={streamer_id:'fault',user_id:'fault',eventKey:'seed',subbed_at:new RealDate(now-1),ended_at:new RealDate(now-1)};
  if(existing!=='new')await start(input);if(existing==='ended')await end({...input,eventKey:'seed-end'});
  const operation=kind==='start'?start:end,event={...input,eventKey:'fault',subbed_at:new RealDate(now),ended_at:new RealDate(now)};
  const method=existing==='new'||(existing==='ended'&&kind==='start')?'insertOne':'updateOne';
  const original=collection[method].bind(collection);
  collection[method]=async(...args:any[])=>{const result=await original(...args);throw new Error('injected timeout after commit');};
  try{await operation(event);}catch{}finally{collection[method]=original;}
  const once=(await collection.find({},{promoteValues:false}).sort({_id:1}).toArray()).map((d:any)=>{const v=EJSON.serialize(d,{relaxed:false});v._id={$oid:"000000000000000000000000"};return v;});
  await operation(event);
  const replay=(await collection.find({},{promoteValues:false}).sort({_id:1}).toArray()).map((d:any)=>{const v=EJSON.serialize(d,{relaxed:false});v._id={$oid:"000000000000000000000000"};return v;});
  if(JSON.stringify(once)!==JSON.stringify(replay))throw new Error('reference replay changed committed document');
  faults.push({kind,existing,once,replay});
 }
 const races:any[]=[];
 for(const active of [false,true])for(const same of [true,false]){
  await collection.deleteMany({});if(active)await start({streamer_id:'channel',user_id:'race',eventKey:'seed'});
  const method=active?'updateOne':'insertOne',original=collection[method].bind(collection);let arrived=0,release:any;
  const barrier=new Promise(r=>release=r);
  collection[method]=async(...args:any[])=>{if(++arrived===2)release();await barrier;return original(...args);};
  let results;
  try{results=await Promise.allSettled(['a',same?'a':'b'].map(eventKey=>start({streamer_id:'channel',user_id:'race',eventKey})));}finally{collection[method]=original;}
  const documents=(await collection.find({},{promoteValues:false}).toArray()).map((d:any)=>{const v=EJSON.serialize(d,{relaxed:false});v._id={$oid:"000000000000000000000000"};return v;});
  races.push({active,same,results:results.map((r:any)=>r.status==='fulfilled'?'ok':r.reason.code),documents});
 }
 await writeFile(process.argv[2],JSON.stringify({now,steps,faults,races},null,2)+'\n');console.log(`recorded ${steps.length} subscription steps (canonical typed BSON)`);
} finally {try{await mongoose.connection.dropDatabase();await mongoose.disconnect();await cache.quit();}finally{globalThis.Date=RealDate;}}
