// Actual frozen TS functions, isolated stores and loopback HTTP. No outside requests.
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {writeFile} from 'node:fs/promises';import {createServer} from 'node:http';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`),mongoose=require('mongoose'),{MongoClient}=require('mongodb'),{EJSON}=require('bson');
const child=process.env.DIMA_TICK_CHILD,database=process.env.DIMA_TICK_DB||`dima_test_stream_${crypto.randomUUID().replaceAll('-','')}`,prefix=database+':';
if(!/^dima_test_stream_[a-f0-9]{32}$/.test(database))throw Error('unsafe scratch name');if(!child)console.log('tick scratch database',database);
process.env.SECRET_KEY='tick-test-only';process.env.CLIENT_ID='tick-client';process.env.OBSERVABILITY_DISABLED='true';process.env.DRAGONFLY_HOST='127.0.0.1';process.env.DRAGONFLY_PORT='6379/6';
let n=0;crypto.randomUUID=(()=>{const x=(++n).toString(16).padStart(2,'0');return `${x.repeat(4)}-${x.repeat(2)}-4${x.slice(1)}${x}-${((n&63)|128).toString(16)}${x}-${x.repeat(6)}`;})as any;syncBuiltinESMExports();
const RealDate=Date;let now=1794355200000;
class FixedDate extends RealDate{constructor(...a:any[]){super(...(a.length?a:[now])as[any]);}static now(){return now;}static [Symbol.hasInstance](v:any){return v instanceof RealDate;}}
Object.defineProperty(FixedDate,'name',{value:'Date'});
const {getDragonflyClient}=await import(`${root}/src/utils/databases/dragonfly.database.ts`),cache=await getDragonflyClient('tick-recorder'),send=cache.sendCommand.bind(cache);
cache.get=(k:string)=>send(['GET',prefix+k]);cache.exists=(...ks:any[])=>send(['EXISTS',...ks.flat().map(k=>prefix+k)]);cache.sMembers=(k:string)=>send(['SMEMBERS',prefix+k]);
cache.eval=(s:string,o:any)=>send(['EVAL',s,String(o.keys.length),...o.keys.map((k:string)=>prefix+k),...o.arguments]);cache.set=async()=> 'OK';cache.expire=async()=>1;
let replies:any[]=[],requests:any[]=[],held:any[]=[];let barrier=false;
const server=createServer((req,res)=>{const url=new URL(req.url!,'http://local');requests.push({method:req.method,target:url.pathname+url.search});const reply=replies.shift();if(!reply){res.writeHead(598);res.end('{}');return;}const respond=()=>{if(reply.timeout)return;res.writeHead(reply.status||200,{'content-type':'application/json'});res.end(typeof reply.body==='string'?reply.body:JSON.stringify(reply.body));};if(barrier){held.push(respond);if(held.length===2){for(const f of held.splice(0))f();}}else respond();});
const originalFetch=globalThis.fetch;
function ejson(v:any){globalThis.Date=RealDate;try{return EJSON.serialize(v,{relaxed:false});}finally{globalThis.Date=FixedDate as any;}}
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex').slice(0,24);
async function main(){try{
 if(!child)await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=child?process.env.DIMA_TICK_HTTP:`http://127.0.0.1:${(server.address()as any).port}`;
 globalThis.fetch=((input:any,init:any)=>{const url=new URL(String(input));if(url.hostname!=='api.twitch.tv')throw Error('outbound forbidden');return originalFetch(base+url.pathname+url.search,{...init,...(process.env.DIMA_TICK_TIMEOUT==='1'||replies[0]?.timeout?{signal:AbortSignal.timeout(60)}:{})});})as any;
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 const {StreamSessionSchema:S}=await import(`${root}/src/schemas/stream_session.schema.ts`),{StreamViewerSnapshotSchema:V}=await import(`${root}/src/schemas/stream_viewer_snapshot.schema.ts`),{CronJobIntentSchema:I}=await import(`${root}/src/schemas/cron_job_intent.schema.ts`);
 const models=[S,V,I];await Promise.all(models.map(m=>m.init()));globalThis.Date=FixedDate as any;
 if(child){n=0;const a=await import(`${root}/src/utils/stream_analytics.ts`);await a.collectLiveViewerSnapshots();return;}
 let trace:string[]=[],stopAfter=0,stopped:any;
 for(const model of models)for(const method of ['insertOne','updateOne','findOneAndUpdate','deleteMany']){const original=model.collection[method].bind(model.collection);model.collection[method]=async(...args:any[])=>{const result=await original(...args);trace.push(`${model.collection.name}:${method}`);if(stopAfter&&trace.length===stopAfter){stopAfter=0;stopped();await new Promise(()=>{});}return result;};}
 const live=(id='1',extra:any={})=>({_id:new mongoose.Types.ObjectId(hash(`session:${id}`)),channelID:id,channel:`channel-${id}`,stream_id:`stream-${id}`,started_at:new RealDate(now-3600000),status:'live',messages:7,commands:2,...extra});
 const stream=(id='1')=>({id:`stream-${id}`,user_id:id,user_login:`channel-${id}`,user_name:'👋éשם',title:'عنوان👋',game_name:'ゲーム',viewer_count:13,started_at:new RealDate(now-3600000).toISOString()});
 const success=(ids:string[])=>({body:{data:ids.map(stream)}});
 const board=(id='1')=>({channelID:id,channel:`channel-${id}`,streamId:`stream-${id}`,title:'',gameName:'',viewers:13,profileImageUrl:'',startedAt:new RealDate(now-3600000).toISOString(),fetchedAt:new RealDate(now).toISOString(),botPlatforms:[],planTier:'free'});
 async function snapshot(){const maps=new Map<string,string>();for(const d of await S.collection.find({}).toArray())maps.set(String(d._id),hash(`${d.channelID}:${d.stream_id}`));const replace=(v:any):any=>typeof v==='string'?[...maps].reduce((s,[old,id])=>s.replaceAll(old,id),v):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
  const docs:any={};for(const m of models){let rows=await m.collection.find({},{promoteValues:false}).toArray();const ord=new Map<string,number>();docs[m.collection.name]=rows.map((d:any)=>{if(m===I)d._id=new mongoose.Types.ObjectId('000000000000000000000000');if(m===V){const key=`${maps.get(String(d.session_id))}:${d.captured_at.getTime()}`,index=ord.get(key)||0;ord.set(key,index+1);d._id=new mongoose.Types.ObjectId(hash(`${key}:${index}`));}return replace(ejson(d));}).sort((a:any,b:any)=>JSON.stringify(a._id).localeCompare(JSON.stringify(b._id)));}
  const state=[];for(const key of(await cache.keys(prefix+'*')).sort()){const type=await cache.type(key),ttl=await cache.ttl(key);const value=type==='set'?(await send(['SMEMBERS',key])).sort():type==='list'?(await cache.lRange(key,0,-1)).map((v:string)=>replace(JSON.parse(v))):await send(['GET',key]);state.push({key:key.slice(prefix.length),type,ttl,value:type==='string'&&key.endsWith('site:analytics:live:channels')?JSON.parse(value):value});}return{documents:docs,cache:state};
 }
 let serial=0;
 async function reset(seed:any[],b:any[]=[],ids:string[]=[]){for(const m of models)await m.collection.deleteMany({});const keys=await cache.keys(prefix+'*');if(keys.length)await cache.del(keys);n=0;now=1794355200000;replies=[];requests=[];barrier=false;held=[];trace=[];stopAfter=0;
  for(const s of seed){await S.create(s);if(s._missingCounters)await S.collection.updateOne({_id:s._id},{$unset:{sample_count:1,sample_total_viewers:1,consecutive_offline_checks:1}});}
  await send(['SET',prefix+'app:twitch:token','mock-token','EX','3600']);if(b.length)await send(['SET',prefix+'site:analytics:live:channels',JSON.stringify(b),'EX','600']);if(ids.length)await send(['SADD',prefix+'streamers:by:id',...ids]);
  trace=[];return {a:await import(`${root}/src/utils/stream_analytics.ts?tick-case=${++serial}`),seed:await snapshot()};
 }
 const cases:any[]=[];
 async function scenario(name:string,seed:any[],b:any[],ids:string[],responses:any[],ops:string[]){const initial=await reset(seed,b,ids);if(name==='retention'){for(const [i,age]of [[1,91],[2,89]])await V.create({_id:new mongoose.Types.ObjectId(hash(`old:${i}`)),channelID:'1',session_id:seed[0]._id,stream_id:'stream-1',captured_at:new RealDate(now-age*86400000),viewers:2});initial.seed=await snapshot();trace=[];}const steps=[];replies=structuredClone(responses);for(const kind of ops){trace=[];const before=requests.length;const randomBefore=n;await initial.a[kind==='startup'?'reconcileLiveSessionsOnStartup':'collectLiveViewerSnapshots']();steps.push({kind,tickID:`${name}:${steps.length}`,randomBefore,trace:[...trace],requests:requests.slice(before),...await snapshot()});}if(replies.length)throw Error(`unused responses ${name}`);cases.push({name,seed:initial.seed.documents,order:seed.map(s=>s.channelID),board:b,ids,responses,steps});}
 await scenario('empty',[],[],[],[],['tick']);
 await scenario('one',[live()],[],[],[success(['1'])],['tick']);
 await scenario('retention',[live()],[],[],[success(['1'])],['tick']);
 await scenario('stream-id-changed',[live()],[],[],[{body:{data:[{...stream(),id:'new-stream',started_at:new RealDate(now-1800000).toISOString()}]}}],['tick']);
 await scenario('legacy-sample',[live('1',{_missingCounters:true})],[],[],[success(['1'])],['tick']);
 await scenario('legacy-offline',[live('1',{_missingCounters:true})],[],[],[{body:{data:[]}},{body:{data:[]}}],['tick','tick']);
 await scenario('one-twice',[live()],[],[],[success(['1']),success(['1'])],['tick','tick']);
 const ids=Array.from({length:101},(_,i)=>String(i+1));await scenario('two-batches',ids.map(id=>live(id)),[],[],[success(ids.slice(0,100)),success(ids.slice(100))],['tick']);
 const pagedIds=Array.from({length:21},(_,i)=>String(i+1));await scenario('paginated-response',pagedIds.map(id=>live(id,{consecutive_offline_checks:1})),[],[],[{body:{data:pagedIds.slice(0,20).map(stream),pagination:{cursor:'page-two'}}}],['tick']);
 await scenario('gone',[live()],[],[],[{body:{data:[]}},{body:{data:[]}}],['tick','tick']);
 for(const [name,responses]of [['401-then-200',[{status:401,body:{}},success(['1'])]],['401-twice',[{status:401,body:{}},{status:401,body:{}}]],['500-twice',[{status:500,body:{}},{status:500,body:{}}]],['timeout-twice',[{timeout:true},{timeout:true}]],['malformed-twice',[{body:'{'},{body:'{'}]],['wrong-shape-twice',[{body:{data:{}}},{body:{data:{}}}]]]as any[])await scenario(name,[live()],[],[],responses,['tick','tick']);
 await scenario('partial-malformed',ids.map(id=>live(id)),[],[],[success(ids.slice(0,100)),{body:'{'}],['tick']);
 await scenario('401-then-200-batches',ids.map(id=>live(id,{consecutive_offline_checks:1})),[],[],[{status:401,body:{}},success(['101'])],['tick']);
 await scenario('partial-failed-batch',ids.map(id=>live(id,{consecutive_offline_checks:1})),[],[],[{status:500,body:{}},success(['101'])],['tick']);
 await scenario('board-recovers',[],[board()],[],[success(['1'])],['tick']);
 await scenario('board-supersedes',[live()], [{...board(),streamId:'new-stream',startedAt:new RealDate(now-1800000).toISOString()}],[],[{body:{data:[{...stream(),id:'new-stream',started_at:new RealDate(now-1800000).toISOString()}]}}],['tick']);
 await scenario('board-phantom',[],[board()],[],[{body:{data:[]}},{body:{data:[]}}],['tick','tick']);
 await scenario('database-only',[live()],[],[],[success(['1'])],['tick']);
 await scenario('board-missing-stream-id',[],[{...board(),streamId:''}],[],[],['tick']);
 await scenario('startup-twice',[],[board()],['1'],[success(['1']),success(['1']),success(['1']),success(['1'])],['startup','startup']);
 await scenario('startup-empty-directory',[],[board()],[],[],['startup']);
 await scenario('startup-failed',[live()],[],['1'],[{status:500,body:{}}],['startup']);
 // Normal and replay traces from the real implementation. Pending invocations never resume.
 const faults=[];
 for(const [name,seed,response]of [['sample',[live()],success(['1'])],['close',[live('1',{consecutive_offline_checks:1})],{body:{data:[]}}],['board',[],success(['1'])],['supersede',[live()],{body:{data:[{...stream(),id:'new-stream',started_at:new RealDate(now-1800000).toISOString()}]}}]]as any[]){
  const b=name==='board'?[board()]:name==='supersede'?[{...board(),streamId:'new-stream',startedAt:new RealDate(now-1800000).toISOString()}]:[];let clean=await reset(seed,b);replies=[response];trace=[];await clean.a.collectLiveViewerSnapshots();const once=await snapshot(),writes=trace.length;
  for(let cut=1;cut<=writes;cut++){const initial=await reset(seed,b);replies=[response,response];trace=[];stopAfter=cut;const ready=new Promise<void>(r=>{stopped=r;});void initial.a.collectLiveViewerSnapshots();await Promise.race([ready,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('write not observed')),60000);t.unref();})]);const partial=await snapshot();await initial.a.collectLiveViewerSnapshots();faults.push({name,cut,seed:initial.seed.documents,board:b,response,once,partial,...await snapshot()});}
 }
 const initial=await reset([live()]);replies=[success(['1']),success(['1'])];barrier=true;
 const baseURL=`http://127.0.0.1:${(server.address()as any).port}`;
 const children=Array.from({length:2},()=>new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,['--import',`${root}/node_modules/tsx/dist/loader.mjs`,process.argv[1]],{env:{...process.env,DIMA_TICK_CHILD:'1',DIMA_TICK_DB:database,DIMA_TICK_HTTP:baseURL},stdio:['ignore','ignore','inherit']});p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(Error(`child ${c}`)));}));await Promise.all(children);
 const race={seed:initial.seed.documents,responses:[success(['1']),success(['1'])],requests:[...requests],...await snapshot()};
 await writeFile(process.argv[2],JSON.stringify({now:1794355200000,cases,faults,race},null,2)+'\n');console.log(`recorded ${cases.length} tick cases, ${faults.length} write cuts and two-process overlap`);
 }finally{globalThis.Date=RealDate;globalThis.fetch=originalFetch;server.closeAllConnections();server.close();await mongoose.disconnect();if(!child){const cleanup=new MongoClient(process.env.DIMA_TEST_MONGO_URI,{serverSelectionTimeoutMS:5000});try{await cleanup.connect();await cleanup.db(database).dropDatabase();}finally{await cleanup.close();}const keys=await cache.keys(prefix+'*');if(keys.length)await cache.del(keys);}await cache.quit();}}
await main();
