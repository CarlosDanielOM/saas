// Real frozen reference, scratch stores, fixed UTC clock; generated fixtures are never edited.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
const root = process.env.DIMABOT_DIR;
if(!root || !process.env.DIMA_TEST_MONGO_URI || !process.argv[2] || process.env.TZ!=='UTC') throw Error('DIMABOT_DIR, test-env, TZ=UTC and output required');
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;
const database=`dima_test_stream_${randomUUID().replaceAll('-','')}`;
const prefix=database+':';
process.env.SECRET_KEY='site-test-only';process.env.CLIENT_ID='site-client';
process.env.DRAGONFLY_HOST='127.0.0.1';process.env.DRAGONFLY_PORT='6379/6';
const {getDragonflyClient}=await import(`${root}/src/utils/databases/dragonfly.database.ts`);
const cache=await getDragonflyClient('site-recording');
const send=cache.sendCommand.bind(cache);
// Redirect every reference key, including diagnostics, without changing the frozen modules.
cache.get=(k:string)=>send(['GET',prefix+k]);
cache.hGet=(k:string,f:string)=>send(['HGET',prefix+k,f]);
cache.hGetAll=async(k:string)=>{const a=await send(['HGETALL',prefix+k]);return Object.fromEntries(Array.from({length:a.length/2},(_,i)=>[a[2*i],a[2*i+1]]));};
cache.hSet=(k:string,...args:any[])=>send(['HSET',prefix+k,...(typeof args[0]==='object'?Object.entries(args[0]).flat():args).map(String)]);
cache.hIncrBy=(k:string,f:string,n:number)=>send(['HINCRBY',prefix+k,f,String(n)]);
cache.exists=(k:string)=>send(['EXISTS',prefix+k]);
cache.set=(k:string,v:any,o:any)=>send(['SET',prefix+k,String(v),...(o?.EX?['EX',String(o.EX)]:[])]);
cache.expire=(k:string,n:number)=>send(['EXPIRE',prefix+k,String(n)]);
cache.mGet=(keys:string[])=>send(['MGET',...keys.map(k=>prefix+k)]);
const RealDate=Date;let now=1794355200000;
class FixedDate extends RealDate {constructor(...a:any[]){super(...(a.length?a:[now]) as [any]);}static now(){return now;}}
Object.defineProperty(FixedDate,'name',{value:'Date'});
let site:any;
const counters:any[]=[]; const boards:any[]=[];
let replies:any[]=[]; const requests:any[]=[];
const server=createServer((req,res)=>{
 const url=new URL(req.url!,'http://local');
 requests.push({method:req.method,target:url.pathname+url.search,clientId:req.headers['client-id'],contentType:req.headers['content-type'],authorization:req.headers.authorization});
 const reply=replies.shift();if(!reply){res.writeHead(598);res.end('{}');return;}
 const respond=()=>{res.writeHead(reply.status||200,{'content-type':'application/json'});res.end(typeof reply.body==='string'?reply.body:JSON.stringify(reply.body));};
 if(reply.timeout||reply.delay)setTimeout(respond,reply.delay||200);else respond();
});
const originalFetch=globalThis.fetch;
const originalInterval=globalThis.setInterval;
const seedUsers=(n:number)=>Array.from({length:n},(_,i)=>({_id:new mongoose.Types.ObjectId((i+1).toString(16).padStart(24,'0')),name:`user-${i}`,accounts:[{type:'twitch',id:String(i+1),name:`channel-${i+1}`,chat_enabled:i%2===0,actived:i%3===0},...(i===0?[{type:'kick',id:'k1',chat_enabled:true,actived:true}]:[])],plan_tier:i%3===0?'pro':i%3===1?'premium':'free'}));
const stream=(id:string)=>({id:`stream-${id}`,user_id:id,user_login:`login-${id}`,user_name:`שם👋é-${id}`,title:`عنوان ${id}`,game_name:'ゲーム',viewer_count:Number(id)||9,started_at:'2026-11-10T23:00:00Z'});
const user=(id:string)=>({id,profile_image_url:`https://images.invalid/${id}.png`});
const oldBoard=[{channelID:'old',channel:'old',streamId:'old-stream',title:'previous',gameName:'',viewers:9,profileImageUrl:'',startedAt:'',fetchedAt:new RealDate(now).toISOString(),botPlatforms:[],planTier:'free'}];
async function clearSite(){const keys=await cache.keys(prefix+'site:analytics:*');if(keys.length)await cache.del(keys);}
async function docs(){const result:any={};for(const name of ['users','commands','site_analytics']){
 const all=await mongoose.connection.db.collection(name).find({},{promoteValues:false}).sort({_id:1}).toArray();result[name]=all.map((d:any)=>{const v=EJSON.serialize(d,{relaxed:false});if(name==='site_analytics')v._id={$oid:'generated'};return v;});}return result;}
async function boardCase(name:string,n:number,responses:any[],ops:any[],seed:any=oldBoard){
 await clearSite();await mongoose.connection.db.collection('users').deleteMany({});const users=seedUsers(n);if(users.length)await mongoose.connection.db.collection('users').insertMany(users);
 if(seed!==null){await cache.set('site:analytics:live:channels',JSON.stringify(seed),{EX:60});await cache.hSet('site:analytics:channels',{live_users:'1',live:'1',total_live_viewers:'9'});}
 await cache.set('app:twitch:token','mock-token',{EX:3600});
 replies=structuredClone(responses);requests.length=0;const steps=[];
 for(const op of ops){if(op.advance)now+=op.advance;const before=requests.length;let result;
 try{result=op.kind==='refresh'?await site.refreshLiveChannelsBoard():op.kind==='board'?await site.getLiveChannelsBoard(op.options):op.kind==='map'?Object.fromEntries(await site.getLiveChannelsByChannelIdMap()):await site.getCachedLiveStatus(op.channel);}catch(e){result={threw:true};}
 steps.push({op,result,requests:requests.slice(before),state:await state(),allCacheKeys:await state(true)});}
 if(replies.length)throw Error(`unused replies in ${name}`);
 boards.push({name,n,responses,seed,now,steps,documents:await docs()});
}
async function state(all=false){const result=[];for(const k of (await cache.keys(prefix+(all?'*':'site:analytics:*'))).sort()){const type=await cache.type(k);const value=type==='hash'?await cache.hGetAll(k.slice(prefix.length)):await send(['GET',k]);result.push({key:k.slice(prefix.length),type,value,ttl:await cache.ttl(k)});}return result;}
try {
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 globalThis.fetch=((input:any,init:any)=>{const url=new URL(String(input));if(url.hostname!=='api.twitch.tv')throw Error(`outbound forbidden ${url.hostname}`);const address=server.address() as any;const timeout=replies[0]?.timeout;return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`,{...init,...(timeout?{signal:AbortSignal.timeout(50)}:{})});}) as any;
 site=await import(`${root}/src/utils/siteanalytics.ts`);globalThis.Date=FixedDate as any;
 for(const filter of [null,'','unknown','registered','live','active','total_messages']) counters.push({op:'get',filter,result:await site.getSiteAnalytics(filter),state:await state()});
 for(const [op,filter,value] of [['inc','registered',2],['inc','live_users',3],['dec','active',5],['inc','unknown',7],['dec','',2],['inc','total_messages',12],['dec','total_messages',20]] as const){await (op==='inc'?site.incrementSiteAnalytics:site.decrementSiteAnalytics)(filter,value);counters.push({op,filter,value,result:null,state:await state()});}
 const operations=Array.from({length:40},(_,i)=>({op:i%3===0?'dec':'inc',filter:['registered','live','active','total_commands'][i%4],value:2}));
 await Promise.all(operations.map(x=>(x.op==='inc'?site.incrementSiteAnalytics:site.decrementSiteAnalytics)(x.filter,x.value)));
 counters.push({op:'concurrent',operations,result:null,state:await state()});
 for(const filter of [null,'','unknown','registered','registered_users','live','active','total_messages',' absent ']) counters.push({op:'get',filter,result:await site.getSiteAnalytics(filter),state:await state()});
 const counterNow=now;
 const success=(data:any[])=>({body:{data,pagination:{cursor:'ignored-cursor'}}});
 await boardCase('empty',0,[],[{kind:'refresh'},{kind:'board'}],null);
 await boardCase('one-batch',2,[success([stream('1'),stream('2')]),success([user('1'),user('2')])],[{kind:'refresh'},{kind:'board'},{kind:'map'},{kind:'status',channel:' 1 '},{kind:'status',channel:2},{kind:'status',channel:''}]);
 const many=Array.from({length:205},(_,i)=>String(i+1));
 await boardCase('three-batches',205,[...Array.from({length:3},(_,i)=>success(many.slice(i*100,(i+1)*100).map(stream))),...Array.from({length:3},(_,i)=>success(many.slice(i*100,(i+1)*100).map(user)))],[{kind:'refresh'},{kind:'board'}]);
 await boardCase('offline-and-profile-cache',2,[success([stream('1'),stream('2')]),success([user('1'),user('2')]),success([stream('1')])],[{kind:'refresh'},{kind:'refresh'},{kind:'status',channel:'2'}]);
 await boardCase('freshness',0,[],[{kind:'board'},{kind:'board',options:{requireFresh:true}},{kind:'board',advance:60001},{kind:'board',options:{requireFresh:true}},{kind:'board',options:{requireFresh:true,maxAgeMs:120000}},{kind:'board',options:{requireFresh:true,maxAgeMs:0}},{kind:'status',channel:'old'}]);
 await boardCase('normalization',0,[],[{kind:'board'},{kind:'map'}],[null,{}, {channelID:42,viewers:'12tail',botPlatforms:['TWITCH','Kick','invalid','twitch'],planTier:'pro',fetchedAt:new RealDate(now).toISOString()},{channelID:'👋éשם',channel:'',title:123,viewers:-3,planTier:'wrong',fetchedAt:'invalid'},{channelID:null,viewers:'1e3',fetchedAt:new RealDate(now).toISOString()}]);
 for(const [name,responses] of [
  ['401-once',[{status:401,body:{}},success([stream('1')]),success([user('1')])]],
  ['401-twice',[{status:401,body:{}},{status:401,body:{}},success([stream('1')]),success([user('1')])]],
  ['401-persistent',Array.from({length:4},()=>({status:401,body:{message:'unauthorized'}}))],
  ['5xx',[{status:503,body:{}}]],['timeout',[{timeout:true,body:{data:[]}}]],['malformed',[{body:'{broken'}]],['missing-data',[{body:{pagination:{cursor:'ignored'}}}]],
  ['profile-5xx',[success([stream('1')]),{status:500,body:{}}]],['profile-malformed',[success([stream('1')]),{body:'invalid'}]]
 ] as any)await boardCase(name,1,responses,[{kind:'refresh'},{kind:'board'}]);
 await boardCase('partial-batch-failure',101,[success([stream('1')]),{status:500,body:{}},success([user('1')])],[{kind:'refresh'},{kind:'board'}]);
 await clearSite();await mongoose.connection.db.collection('users').deleteMany({});await mongoose.connection.db.collection('users').insertMany(seedUsers(101));
 replies=[{...success([stream('1')]),delay:200},success([stream('1')]),success([stream('101')]),success([user('1'),user('101')]),{status:500,body:{}}];
 requests.length=0;const first=site.refreshLiveChannelsBoard();while(requests.length===0)await new Promise(r=>setTimeout(r,1));const second=site.refreshLiveChannelsBoard();
 const racingResults=await Promise.all([first,second]);const race={now,responses:[{...success([stream('1')]),delay:200},success([stream('1')]),success([stream('101')]),success([user('1'),user('101')]),{status:500,body:{}}],results:racingResults,state:await state(),requests:[...requests],documents:await docs()};
 await clearSite();await mongoose.connection.db.collection('users').deleteMany({});await mongoose.connection.db.collection('users').insertMany(seedUsers(2));
 await mongoose.connection.db.collection('commands').insertMany(Array.from({length:3},(_,i)=>({_id:new mongoose.Types.ObjectId((i+1000).toString(16).padStart(24,'0')),cmd:`cmd-${i}`,channelID:'1'})));
 await cache.hSet('site:analytics:channels',{registered:'12',live:'7',active:'3',total_messages:'123tail',total_commands:'9'});
 const snapshotInitial=await docs();const snapshots:any[]=[];const intervals:number[]=[];
 globalThis.setInterval=((_callback:any,ms:number)=>{intervals.push(ms);return{unref(){}};}) as any;
 async function snapshotOp(op:any){if(op.advance)now+=op.advance;const before=requests.length;let result:any;
 if(op.kind==='snapshot')result=await site.getSiteAnalyticsSnapshot();
 else if(op.kind==='refresh-snapshot')result=await site.refreshSiteAnalyticsSnapshot();
 else if(op.kind==='persist'){await site.persistSiteAnalyticsSnapshot();result=null;}
 else if(op.kind==='concurrent-persist'){await Promise.all(Array.from({length:8},()=>site.persistSiteAnalyticsSnapshot()));result=null;}
 else if(op.kind==='clear'){await clearSite();result=null;}
 else {result=await site.startSiteAnalytics();await new Promise(r=>setTimeout(r,50));}
 snapshots.push({op,now,result,state:await state(),documents:await docs(),requests:requests.slice(before),allCacheKeys:await state(true)});
 }
 await snapshotOp({kind:'snapshot'});
 await snapshotOp({kind:'refresh-snapshot'});
 await snapshotOp({kind:'concurrent-persist'});
 await snapshotOp({kind:'persist'});
 await snapshotOp({kind:'persist',advance:1000});
 await snapshotOp({kind:'concurrent-persist'});
 replies=[success([stream('1'),stream('2')]),success([user('1'),user('2')]),success([stream('1'),stream('2')])];
 await snapshotOp({kind:'start'});
 await snapshotOp({kind:'snapshot'});
 await snapshotOp({kind:'clear'});
 await snapshotOp({kind:'start'});
 await snapshotOp({kind:'snapshot'});
 if(replies.length)throw Error('unused startup replies');
 await writeFile(process.argv[2],JSON.stringify({now:counterNow,counters,boards,race,snapshotInitial,snapshots,intervals},null,2)+'\n');console.log(`recorded ${counters.length} counter cases, ${boards.length} boards, ${snapshots.length} snapshot steps and a publication race`);
} finally {
 globalThis.Date=RealDate;globalThis.fetch=originalFetch;globalThis.setInterval=originalInterval;server.closeAllConnections();server.close();
 try{if(mongoose.connection.db?.databaseName===database)await mongoose.connection.db.dropDatabase();}finally{
 await mongoose.disconnect();const keys=await cache.keys(prefix+'*');if(keys.length)await cache.del(keys);await cache.quit();}
}

// The imported reference owns process-level handles. All owned clients/server are closed above.
process.exit(0);
