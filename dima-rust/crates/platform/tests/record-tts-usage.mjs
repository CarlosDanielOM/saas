// Only tts_usage.ts is evaluated. Redis is scratch DB 14; Polar and logger are local stubs.
// DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC node <this-file>
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';import {randomUUID,createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const root=process.env.DIMABOT_DIR,require=createRequire(path.join(root,'package.json')),ts=require('typescript');
const source=fs.readFileSync(path.join(root,'src/utils/tts_usage.ts'),'utf8');
const redis=require('redis').createClient({url:`redis://${process.env.DIMA_TEST_DRAGONFLY}/14`});redis.on('error',()=>{});await redis.connect();
let now=Date.parse('2026-11-11T12:34:56.789Z'),commands=[],ingestions=[],errors=[],fail=false;
const RealDate=Date;class FixedDate extends RealDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
const adapter={hIncrBy:async(key,field,value)=>{commands.push({command:'HINCRBY',field,value});return redis.hIncrBy(key,field,value);},expire:async(key,seconds)=>{commands.push({command:'EXPIRE',seconds});return redis.expire(key,seconds);}};
const exports={};vm.runInNewContext(ts.transpileModule(source.replace(/^import .*;\n/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date:FixedDate,getDragonflyClient:async()=>adapter,ingestPolarSHEvent:async(input)=>{ingestions.push(JSON.parse(JSON.stringify({...input,channelID:'CHANNEL'})));return {error:fail,message:fail?'fixture failure':'ok'};},error:async(e)=>errors.push(e)});
const classes=[['piper','local'],['kokoro','preset'],['fish','named-alias'],['fish','custom-reference-id'],['unknown','fallback']];
const calculations=[];for(const [provider,voiceClass] of classes)for(const characters of [0,0.1,0.5,1,1.5,14.99,15,49.9,50,51,1e6,10000000])calculations.push({provider,voiceClass,characters,result:exports.calculateTtsUsage(provider,characters)});
// Record actual caller counts, including the intentional desktop/pet vs queue distinction.
const counts=[];for(const text of ['', 'ASCII', 'é e\u0301 😀 مرحبا', '😀'.repeat(10000)])for(const provider of ['piper','kokoro','fish'])for(const caller of ['queue-preview','desktop-pet']){const characters=caller==='desktop-pet'||provider==='fish'?text.length:Array.from(text).length;counts.push({provider,caller,text,characters,result:exports.calculateTtsUsage(provider,characters)});}
const specs=[];for(const provider of ['piper','kokoro','fish'])for(const characters of [0,1,51,0.5,1e6])specs.push({provider,characters,customer:true});
specs.push({provider:'fish',characters:2,customer:false},{provider:'fish',characters:2,customer:true,fail:true},{provider:'fish',characters:2,customer:true,fail:true,durable:true},{provider:'fish',characters:2,customer:true,minimal:true},{provider:'piper',characters:51,customer:true,date:'2026-11-30T12:34:56Z'},{provider:'kokoro',characters:51,customer:true,date:'2026-12-31T12:34:56Z'});
const prefix=`dima_test_platform_${randomUUID().replaceAll('-','')}`,keys=[],tracking=[];
try{
 for(let i=0;i<specs.length;i++){
  const spec=specs[i],channelID=`${prefix}_${i}`,key=`${channelID}:tts:usage`;keys.push(key);now=Date.parse(spec.date||'2026-11-11T12:34:56.789Z');commands=[];ingestions=[];errors=[];fail=!!spec.fail;
  const options={channelID,streamer:spec.customer?{polar_sh_customer_id:'cus_fixture',plan_tier:'pro'}:{},provider:spec.provider,characters:spec.characters,text:'unused',requireDurableUsage:!!spec.durable,...(spec.minimal?{}:{usage:{entryId:'entry_fixture',requestId:'request_fixture',source:'voice_preview',resourceType:'voice_preview',resourceId:'speech_fixture'}})};
  let result=null,error=null;try{result=await exports.trackTtsUsage(options);}catch(e){error=e.message;}
  tracking.push({spec,now,result,error,cacheErrors:errors.length,commands:[...commands],ingestions:[...ingestions],hash:await redis.hGetAll(key),ttl:await redis.ttl(key)});
 }
 fs.writeFileSync(fileURLToPath(new URL('tts-usage-reference.json',import.meta.url)),JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),calculations,counts,tracking},null,2)+'\n');
}finally{if(keys.length)await redis.del(keys);await redis.quit();}
