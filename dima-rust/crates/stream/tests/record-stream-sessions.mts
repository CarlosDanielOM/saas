// Records the frozen implementation; owns and drops one scratch database.
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`);
const mongoose=require('mongoose'),{EJSON}=require('bson');
const now=1794355200000,RealDate=Date;
class FixedDate extends RealDate {constructor(...args:any[]){super(...(args.length?args:[now]) as [any]);}static now(){return now;}static [Symbol.hasInstance](value:any){return value instanceof RealDate;}}
Object.defineProperty(FixedDate,'name',{value:'Date'});
process.env.OBSERVABILITY_DISABLED='true';
process.env.SECRET_KEY='stream-sessions-test-only-key';
const {getDragonflyClient}=await import(`${root}/src/utils/databases/dragonfly.database.ts`);
const cache=await getDragonflyClient('logger');
// These recorder functions use Dragonfly only for diagnostic logging, mocked locally.
cache.set=async()=> 'OK';cache.expire=async()=>1;
const database=`dima_test_stream_${randomUUID().replaceAll('-','')}`;
function ejson(value:any){globalThis.Date=RealDate;try{return EJSON.serialize(value,{relaxed:false});}finally{globalThis.Date=FixedDate as any;}}
try {
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 const a=await import(`${root}/src/utils/stream_analytics.ts`);
 const {StreamSessionSchema:S}=await import(`${root}/src/schemas/stream_session.schema.ts`);
 const {StreamParticipantSchema:P}=await import(`${root}/src/schemas/stream_timeline.schema.ts`);
 const {StreamActivitySchema:A}=await import(`${root}/src/schemas/stream_activity.schema.ts`);
 const models=[S,P,A];await Promise.all(models.map(m=>m.init()));globalThis.Date=FixedDate as any;
 await S.create({_id:new mongoose.Types.ObjectId('0123456789abcdef01234567'),channelID:'live',stream_id:'live-stream',started_at:new RealDate(now-600000),status:'live',unknown_preserved:'seed'});
 await S.create({_id:new mongoose.Types.ObjectId('0123456789abcdef01234568'),channelID:'ended',stream_id:'ended-stream',started_at:new RealDate(now-600000),ended_at:new RealDate(now-1000),status:'offline'});
 // Unknown persisted fields must survive targeted updates.
 await S.collection.updateOne({channelID:'live'},{$set:{unknown_preserved:'seed'}});
 async function snapshot(){const out:any={};for(const m of models){out[m.collection.name]=(await m.collection.find({},{promoteValues:false}).sort({_id:1}).toArray()).map((d:any)=>{if(m===P)d._id=new mongoose.Types.ObjectId('000000000000000000000000');return ejson(d);}).sort((a:any,b:any)=>JSON.stringify(m===P?[a.user_id,a.bucket]:a._id).localeCompare(JSON.stringify(m===P?[b.user_id,b.bucket]:b._id)));}return out;}
 const seed=await snapshot(),steps:any[]=[];
 async function run(name:string,kind:string,input:any){let result=null;try{const mapped={...input};if(mapped.special){mapped.quantity=Number(mapped.special);delete mapped.special;}if(kind==='bits'){mapped.bits=mapped.quantity;delete mapped.quantity;}if(kind==='donation'){mapped.amount=mapped.quantity;delete mapped.quantity;}await a[`recordStream${kind[0].toUpperCase()+kind.slice(1)}Event`](mapped);}catch(e:any){result={prerequisite:e.prerequisite||String(e.message).replace(/^.*?(metric-session:)/,'$1')};}steps.push({name,kind,input,result,documents:await snapshot()});}
 for(const kind of ['bits','sub','follow','donation','command','message']){
  for(const channelID of ['live','ended','missing','\ufeff live\u00a0','']){
   await run(`${kind}-${channelID}`,kind,{channelID,quantity:2.5});
  }
  await run(`${kind}-unkeyed` ,kind,{channelID:'live',quantity:3});await run(`${kind}-unkeyed-repeat`,kind,{channelID:'live',quantity:3});
  for(const special of ['NaN','Infinity','-Infinity'])await run(`${kind}-${special}`,kind,{channelID:'live',special});
  for(const quantity of [undefined,0,-3,0.4,1.5,4503599627370497])await run(`${kind}-quantity-${quantity}`,kind,{channelID:'live',quantity});
  if(['bits','sub','follow'].includes(kind)){
   const input={channelID:'live',quantity:4.5,eventKey:`${kind}-key`};await run(`${kind}-key`,kind,input);await run(`${kind}-key-repeat`,kind,input);
   await run(`${kind}-missing-key`,kind,{...input,channelID:'missing',eventKey:`${kind}-missing`});
   await run(`${kind}-ended-key-after-end`,kind,{...input,channelID:'ended',eventKey:`${kind}-after-end`});
   await run(`${kind}-before-start`,kind,{...input,eventKey:`${kind}-early`,occurredAt:new RealDate(now-700000).toISOString()});
   await run(`${kind}-invalid-date`,kind,{...input,eventKey:`${kind}-invalid-date`,occurredAt:'invalid'});
   await run(`${kind}-ended-at-event`,kind,{...input,channelID:'ended',eventKey:`${kind}-ended`,occurredAt:new RealDate(now-1000).toISOString()});
  }
 }
 for(const [name,input] of [
  ['participant',{userID:'viewer👋éשם',receivedAt:now-10000}],
  ['participant-repeat',{userID:'viewer👋éשם',receivedAt:now-10000}],
  ['participant-bot',{userID:'698614112'}],
  ['participant-before-start',{userID:'early',receivedAt:now-700000}],
  ['capture',{userID:'viewer',actorLabel:'👋éשם',messageID:'msg',message:{fragments:[{type:'emote',text:'👋',emote:{id:'25'}},{type:'emote',text:'👋',emote:{id:'25'}}]}}],
  ['capture-repeat',{userID:'viewer',messageID:'msg',message:{fragments:[]}}],
  ['id-without-body',{userID:'viewer',messageID:'no-body'}],
  ['zero-time',{userID:'zero',receivedAt:0}],
 ] as any[])await run(name,'message',{channelID:'live',...input});
 await writeFile(process.argv[2],JSON.stringify({now,seed,steps},null,2)+'\n');console.log(`recorded ${steps.length} session recorder scenarios`);
} finally {
 globalThis.Date=RealDate;await mongoose.disconnect();await cache.quit();
 const {MongoClient}=require('mongodb');const cleanup=new MongoClient(process.env.DIMA_TEST_MONGO_URI,{serverSelectionTimeoutMS:5000});try{await cleanup.connect();await cleanup.db(database).dropDatabase();}finally{await cleanup.close();}
}
