// Read-only real-session dashboard answers, with private text irreversibly hashed.
import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {writeFile} from 'node:fs/promises';
const root=process.env.DIMABOT_DIR!;const require=createRequire(`${root}/package.json`);const mongoose=require('mongoose');
const RealDate=Date,now=1794355200000;
class FixedDate extends RealDate{constructor(...args:any[]){super(...(args.length?args:[now]) as [any]);}static now(){return now;}}
export function redact(v:any):any {if(Array.isArray(v))return v.map(redact);if(v&&typeof v==='object'&&!(v instanceof RealDate))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,['label','key'].includes(k)&&typeof x==='string'?createHash('sha256').update(x).digest('hex'):redact(x)]));return v;}
try{
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:'domdimabot',autoCreate:false,autoIndex:false});
const {getStreamActivity}=await import(`${root}/src/utils/stream_activity.ts`);globalThis.Date=FixedDate as any;
const sessions=await mongoose.connection.db.collection('streamsessions').find({}).sort({started_at:-1}).limit(12).toArray();
if(!sessions.length)throw new Error('real sessions required');
const cases=[];for(const s of sessions){for(const tier of ['free','premium','pro'])cases.push({channel:s.channelID,session:String(s._id),tier,expected:redact(await getStreamActivity(s.channelID,s._id,tier))});}
await writeFile(process.argv[2],JSON.stringify({now,cases},null,2)+'\n');console.log(`recorded ${sessions.length} real sessions, ${cases.length} reads (private text hashed)`);
}finally{globalThis.Date=RealDate;await mongoose.disconnect();}
