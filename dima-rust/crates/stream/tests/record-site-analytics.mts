// Real frozen reference, scratch stores, fixed UTC clock; generated fixtures are never edited.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
const counters:any[]=[];
async function state(){const result=[];for(const k of (await cache.keys(prefix+'site:analytics:*')).sort()){const type=await cache.type(k);const value=type==='hash'?await cache.hGetAll(k.slice(prefix.length)):await send(['GET',k]);result.push({key:k.slice(prefix.length),type,value,ttl:await cache.ttl(k)});}return result;}
try {
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 site=await import(`${root}/src/utils/siteanalytics.ts`);globalThis.Date=FixedDate as any;
 for(const filter of [null,'','unknown','registered','live','active','total_messages']) counters.push({op:'get',filter,result:await site.getSiteAnalytics(filter),state:await state()});
 for(const [op,filter,value] of [['inc','registered',2],['inc','live_users',3],['dec','active',5],['inc','unknown',7],['dec','',2],['inc','total_messages',12],['dec','total_messages',20]] as const){await (op==='inc'?site.incrementSiteAnalytics:site.decrementSiteAnalytics)(filter,value);counters.push({op,filter,value,result:null,state:await state()});}
 const operations=Array.from({length:40},(_,i)=>({op:i%3===0?'dec':'inc',filter:['registered','live','active','total_commands'][i%4],value:2}));
 await Promise.all(operations.map(x=>(x.op==='inc'?site.incrementSiteAnalytics:site.decrementSiteAnalytics)(x.filter,x.value)));
 counters.push({op:'concurrent',operations,result:null,state:await state()});
 for(const filter of [null,'','unknown','registered','registered_users','live','active','total_messages',' absent ']) counters.push({op:'get',filter,result:await site.getSiteAnalytics(filter),state:await state()});
 await writeFile(process.argv[2],JSON.stringify({now,counters},null,2)+'\n');console.log(`recorded ${counters.length} counter cases`);
} finally {
 globalThis.Date=RealDate;
 if(mongoose.connection.db?.databaseName===database)await mongoose.connection.dropDatabase();await mongoose.disconnect();
 const keys=await cache.keys(prefix+'*');if(keys.length)await cache.del(keys);await cache.quit();
}
