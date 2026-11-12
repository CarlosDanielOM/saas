// Reads frozen TypeScript. Only synthetic mode writes, in its owned random scratch DB.
import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';import {writeFile} from 'node:fs/promises';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`),mongoose=require('mongoose'),{EJSON}=require('bson');
process.env.SECRET_KEY='dashboard-test-only-key';
const real=process.argv[2]==='--real',output=process.argv[real?3:2],RealDate=Date,now=real?1794355200000:+new RealDate('2026-11-01T12:00:00Z');
class FixedDate extends RealDate{constructor(...args:any[]){super(...(args.length?args:[now])as [any]);}static now(){return now;}}
Object.defineProperty(FixedDate,'name',{value:'Date'});
const database=real?'domdimabot':`dima_test_stream_${randomUUID().replaceAll('-','')}`;
console.log(`recording database ${database}`);
try{
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database,autoCreate:!real,autoIndex:!real});
 const {getDashboardAnalytics:dashboard,getLiveSessionMetrics:live}=await import(`${root}/src/utils/stream_analytics.ts`);
 globalThis.Date=FixedDate as any;
 const cases:any[]=[];const seeds:any[]=[];
 async function reads(channel:string,phase:string){
  if(!real)for(const collection of ['streamsessions','streamviewersnapshots'])seeds.push({phase,collection,documents:EJSON.serialize(await mongoose.connection.db.collection(collection).find({},{promoteValues:false}).toArray(),{relaxed:false})});
  for(const days of real?[undefined,30,1,90]:[undefined,30,1,0,-1,2,31,0.5,1.5,12.75,NaN,Infinity,-Infinity,1e100]){
   const tag=days===undefined?'default':String(days);let expected:any=null,error=false;
   try{expected=await dashboard(channel,days);}catch{error=true;}
   cases.push({phase,channel,days:tag,expected,error});
  }
  for(const viewers of real?[undefined]:[undefined,null,0,-1,12.25])cases.push({phase,channel,viewers:viewers===undefined?'default':viewers,live:await live(channel,viewers===undefined?undefined:{currentViewers:viewers})});
 }
 if(real){
  const channels=await mongoose.connection.db.collection('streamsessions').aggregate([{$group:{_id:'$channelID',latest:{$max:'$started_at'}}},{$sort:{latest:-1}},{$limit:12}]).toArray();
  if(!channels.length)throw new Error('real channels required');
  for(const c of channels)await reads(c._id,'real');
 }else{
  const {StreamSessionSchema:S}=await import(`${root}/src/schemas/stream_session.schema.ts`);
  const {StreamViewerSnapshotSchema:V}=await import(`${root}/src/schemas/stream_viewer_snapshot.schema.ts`);
  await Promise.all([S.init(),V.init()]);await reads('channel','empty');
  let id=1;
  async function session(overrides:any){const row={_id:new mongoose.Types.ObjectId((id++).toString(16).padStart(24,'0')),channelID:'channel',stream_id:`s${id}`,status:'offline',started_at:new RealDate('2026-11-01T00:10:00Z'),ended_at:new RealDate('2026-11-01T01:17:00Z'),average_viewers:0,...overrides};await new S(row).save();}
  await session({});await reads('channel','one');
  await session({started_at:new RealDate('2026-10-31T23:40:00Z'),ended_at:new RealDate('2026-11-01T01:00:00Z'),average_viewers:2.5,donations:1.005,bits:2.5,follows:1.5,subs:2.5});
  await session({started_at:new RealDate('2026-11-01T00:30:00Z'),ended_at:null,status:'orphaned',average_viewers:0.5,duration_minutes:0,donations:2.675});
  await session({started_at:new RealDate('2026-10-01T23:59:00Z'),ended_at:new RealDate('2026-10-02T01:01:00Z'),average_viewers:1.25,duration_minutes:62.123});
  await reads('channel','boundaries');
  await S.updateOne({status:'orphaned',ended_at:null},{$set:{ended_at:new RealDate(now)}});
  await session({status:'live',started_at:new RealDate('2026-11-01T10:00:30Z'),ended_at:null,average_viewers:3.5,peak_viewers:20,subs:1001,messages:12,commands:3});
  const liveSession=await S.findOne({status:'live'}).lean();
  await new V({channelID:'channel',session_id:liveSession._id,stream_id:liveSession.stream_id,captured_at:new RealDate(now-1000),viewers:12.5}).save();
  await new V({channelID:'channel',session_id:liveSession._id,stream_id:liveSession.stream_id,captured_at:new RealDate(now-2000),viewers:90}).save();
  await reads('channel','live');

 }
 await writeFile(output,JSON.stringify({now,seeds,cases},null,2)+'\n');console.log(`recorded ${cases.length} dashboard/live reads (${real?'real, read-only':'synthetic'})`);
}finally{try{if(!real)await mongoose.connection.dropDatabase();await mongoose.disconnect();}finally{globalThis.Date=RealDate;}}
