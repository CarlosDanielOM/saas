// Exact-image dashboard migration check. See dashboard-activity-rust-fixtures/README.md.
// All mutation is constrained to helper-owned disposable Mongo/Redis dependencies.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,unlink,mkdir,rm,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {mongoHoldProxy} from '/tmp/saas-fixtures/mongo-proxy.mjs';
import {providerProxy} from '/tmp/saas-fixtures/providers.mjs';
import {coverageSessionMs,coverageSnapshotOffsets} from '/tmp/saas-fixtures/insight-coverage.mjs';
import {collectionWrites,checkpointOwnerGuard,assertHeartbeatRenewal} from '/tmp/saas-fixtures/lifecycle-assertions.mjs';
const require=createRequire('/app/package.json'),{MongoClient,BSON,ObjectId}=require('mongodb'),{createClient}=require('redis');
const mongoose=require('mongoose');mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
const uri=new URL(process.env.MONGO_URI||''),pattern=/^dashboard_activity_fixture_[a-zA-Z0-9_]+$/;
assert.equal(uri.hostname,'mongo');assert.equal(uri.port,'27017');assert.match(uri.pathname.slice(1),pattern);
assert.equal(process.env.DRAGONFLY_HOST,'redis');assert.equal(process.env.DRAGONFLY_PORT,'6379');
const client=new MongoClient(uri.href,{serverSelectionTimeoutMS:5000,timeoutMS:15000});
const redis=createClient({url:'redis://redis:6379',socket:{reconnectStrategy:false}});redis.on('error',()=>{});
const actual=client.db(uri.pathname.slice(1)),owned=new Set([actual.databaseName]),children=new Set(),stopped=new Set(),proxies=new Set(),files=new Set(),directories=new Set(),keys=new Set();
const binary='/usr/local/bin/dashboard_activity',protocol='dashboard_activity:',deadline=Date.now()+280000;
const DAY=86400000,HOUR=3600000,now=Date.now(),expiry=new Date(now+10*DAY),epoch=new Date(0);
const schemas=await Promise.all([
 import('/app/dist/schemas/stream_activity.schema.js'),import('/app/dist/schemas/dashboard_activity.schema.js'),import('/app/dist/schemas/dashboard_insights.schema.js'),
 import('/app/dist/schemas/stream_session.schema.js'),import('/app/dist/schemas/stream_viewer_snapshot.schema.js'),import('/app/dist/schemas/domain_event.schema.js')]);
const models={activity:schemas[0].StreamActivitySchema,state:schemas[0].StreamActivityStateSchema,daily:schemas[1].DashboardActivityDailySchema,
 summary:schemas[1].DashboardActivitySummarySchema,insights:schemas[2].DashboardInsightsSchema,sessions:schemas[3].StreamSessionSchema,snapshots:schemas[4].StreamViewerSnapshotSchema,events:schemas[5].DomainEventSchema};
const names=Object.fromEntries(Object.entries(models).map(([key,model])=>[key,model.collection.name]));
assert.equal(names.sessions,'streamsessions');assert.equal(names.snapshots,'streamviewersnapshots');
const coll=(db,key)=>db.collection(names[key]);
function database(label){const name=`dashboard_activity_fixture_${process.pid}_${label}`;assert.match(name,pattern);assert(Buffer.byteLength(name)<=63);owned.add(name);return client.db(name);}
const test=database('test'),referenceDb=database('reference');
const hash=(...values)=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const dayStart=at=>new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
const rangeStart=days=>new Date(+dayStart(new Date(now))-(days-1)*DAY);
const clone=value=>BSON.deserialize(BSON.serialize(value));
function nativeEnv(db,extra={}){assert(owned.has(db.databaseName));const selected=new URL(uri);selected.pathname=`/${db.databaseName}`;
 return {MONGO_URI:selected.href,DRAGONFLY_HOST:'redis',DRAGONFLY_PORT:'6379',PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',...extra};}
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),ms);})]);}finally{clearTimeout(timer);}}
async function waitFor(check,label,ms=15000){const end=Math.min(deadline,Date.now()+ms);do{const value=await check();if(value)return value;await delay(30);}while(Date.now()<end);throw new Error(`Timed out: ${label}`);}
function launch(command,args,env,extra={}){
 assert(Date.now()<deadline,'280-second suite deadline');const child=spawn(command,args,{cwd:'/app',env,stdio:['ignore','pipe','pipe'],...extra});children.add(child);child.output='';
 const capture=chunk=>{child.output=(child.output+chunk).slice(-64000);};child.stdout?.on('data',capture);child.stderr?.on('data',capture);
 child.completion=new Promise((resolve,reject)=>{let exitedAt;child.once('error',reject);child.once('exit',()=>{exitedAt=performance.now();});child.once('close',(code,signal)=>resolve({code,signal,output:child.output,exitedAt}));});child.completion.catch(()=>{});return child;
}
async function finished(child,ms=25000){const result=await bounded(child.completion,Math.min(ms,deadline-Date.now()),'fixture child');children.delete(child);return result;}
function frames(output){return output.split('\n').filter(line=>line.startsWith(protocol)).map(line=>{
 const row=JSON.parse(line.slice(protocol.length));assert.deepEqual(Object.keys(row).sort(),['durationMs','event','events','success']);assert.equal(row.event,'batch');
 assert.equal(typeof row.success,'boolean');assert(Number.isInteger(row.events)&&row.events>=0&&row.events<=502);assert(Number.isFinite(row.durationMs)&&row.durationMs>=0);
 if(!row.success)assert.equal(row.events,0,'failed pass never advertises completed work');return row;
});}
function observe(child){let pending='',failure;const rows=[];child.stdout.on('data',chunk=>{try{pending+=chunk;assert(pending.length<32768);const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.startsWith(protocol)){assert(rows.length<100,'bounded normal-mode fixture');rows.push({...frames(line)[0],at:performance.now()});}}catch(error){failure||=error;}});return {rows,check(){if(failure)throw failure;}};}
async function once(db=test,extra={},args=[]){const result=await finished(launch(binary,['--once','--telemetry-json',...args],nativeEnv(db,extra),{uid:65534,gid:65534}));privacy(result.output);return result;}
async function success(db=test,extra={},args=[]){const result=await once(db,extra,args);assert.equal(result.code,0,result.output);assert.equal(result.signal,null);const rows=frames(result.output);assert.equal(rows.length,1);assert.equal(rows[0].success,true,result.output);return rows[0];}
async function failOnce(db=test,extra={}){const result=await once(db,extra);assert.notEqual(result.code,0,result.output);assert.equal(result.signal,null);assert.deepEqual(frames(result.output).map(row=>[row.success,row.events]),[[false,0]]);return result;}
let sequence=0,groups=0;
const pass=label=>{groups++;console.log(`PASS ${groups}: ${label}`);};
async function reference(mode='tick',db=referenceDb){const path=`/tmp/dashboard-activity-fixture-${process.pid}-${++sequence}.json`;files.add(path);await writeFile(path,JSON.stringify({mode}));
 const result=await finished(launch(process.execPath,['/tmp/saas-fixtures/reference.mjs',path],{...process.env,...nativeEnv(db),NODE_OPTIONS:'',OBSERVABILITY_DISABLED:'true'}));
 assert.equal(result.code,0,result.output);const line=result.output.split('\n').find(line=>line.startsWith('DASHBOARD_REFERENCE:'));assert(line,result.output);return JSON.parse(line.slice('DASHBOARD_REFERENCE:'.length));}
async function indexes(db){for(const [key,model]of Object.entries(models))for(const[index,options]of model.schema.indexes()){
 // Expired fixture rows must survive long enough to prove query-side expiry filtering.
 if(options.expireAfterSeconds!==undefined)continue;await coll(db,key).createIndex(index,options);
}}
async function seed(db,fixture){for(const[key,rows]of Object.entries(fixture))if(rows.length)await coll(db,key).insertMany(clone({rows}).rows);}
async function both(fixture){await seed(test,fixture);await seed(referenceDb,fixture);}
async function reset(...dbs){for(const db of dbs.length?dbs:[test,referenceDb])for(const key of Object.keys(models))await coll(db,key).deleteMany({});}
const variableDates=new Set(['updatedAt','dirtyAt','nextRefreshAt','to']);
function compare(a,b,field=''){
 if(a instanceof Date||b instanceof Date){assert(a instanceof Date&&b instanceof Date,`BSON Date ${field}`);assert(Math.abs(+a-+b)<=(variableDates.has(field)?15000:0),`date parity ${field}`);return;}
 if(a?._bsontype||b?._bsontype){assert.deepEqual(BSON.EJSON.serialize(a,{relaxed:false}),BSON.EJSON.serialize(b,{relaxed:false}));return;}
 if(Array.isArray(a)||Array.isArray(b)){assert(Array.isArray(a)&&Array.isArray(b));assert.equal(a.length,b.length,field);for(let i=0;i<a.length;i++)compare(a[i],b[i],field);return;}
 if(a&&b&&typeof a==='object'&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),`full shape ${field}`);for(const key of Object.keys(a))compare(a[key],b[key],key);return;}
 assert.deepEqual(a,b,field);
}
async function parity(selected=['daily','state','summary','insights','activity']){
 for(const key of selected){const clean=rows=>rows.map(row=>{const out={...row};delete out.owner;return out;});
 const a=clean(await coll(test,key).find().sort({_id:1}).toArray()),b=clean(await coll(referenceDb,key).find().sort({_id:1}).toArray());compare(a,b,key);
 if(['daily','state'].includes(key)&&a.length){const fields=key==='daily'?['day','count','lastSeq','firstAt','expiresAt']:['seq','leaseUntil','updatedAt'];
 const types=db=>coll(db,key).aggregate([{$sort:{_id:1}},{$project:{_id:1,...Object.fromEntries(fields.map(field=>[field,{$type:`$${field}`}]))}}]).toArray();
 assert.deepEqual(await types(test),await types(referenceDb),`raw BSON schema types ${key} (Node Number encoding per value)`);
 }
 if(['summary','insights'].includes(key)&&a.length){
  // Mongoose casts Number paths to JS Number; Node BSON writes integral values
  // within Int32 as int, and fractions/larger Numbers as double. Mixed payloads
  // use the same per-value rules. Check nested array fields without coercion.
  const paths=new Map();
  function numericPaths(value,path=[]){
   if(typeof value==='number'){paths.set(JSON.stringify(path),path);return;}
   if(value&&typeof value==='object'&&!(value instanceof Date))for(const[k,v]of Object.entries(value))numericPaths(v,[...path,Array.isArray(value)?Number(k):k]);
  }
  for(const row of [...a,...b])numericPaths(row.payload,['payload']);
  const expression=path=>path.reduce((input,part)=>typeof part==='number'?{$arrayElemAt:[input,part]}:{$getField:{field:{$literal:part},input}},'$$ROOT');
  const project={_id:1,...Object.fromEntries([...paths.values()].map((path,i)=>[`n${i}`,{$type:expression(path)}]))};
  const storedTypes=db=>coll(db,key).aggregate([{$sort:{_id:1}},{$project:project}]).toArray();
  assert.deepEqual(await storedTypes(test),await storedTypes(referenceDb),`nested Mixed BSON numeric types ${key}: ${[...paths.keys()].join(',')}`);
 }
 }
}
function activity(label,extra={}){return {_id:label,channelID:'fixture-channel',session_id:new ObjectId('000000000000000000000001'),occurredAt:new Date(now-HOUR),kind:'message',emotes:[],processed:true,expiresAt:expiry,actor:'PRIVATE_ACTOR',actorLabel:'PRIVATE_NAME',text:'PRIVATE_CHAT',...extra};}
function summary(channel,extra={}){return {_id:channel,dirtyAt:new Date(now-1000),nextRefreshAt:epoch,leaseUntil:epoch,error:false,...extra};}
function insightSummary(channel,extra={}){return {_id:channel,nextRefreshAt:epoch,leaseUntil:epoch,error:false,expiresAt:expiry,...extra};}
function session(label,at,extra={}){return {_id:new ObjectId(),channelID:'fixture-channel',stream_id:label,started_at:new Date(at),ended_at:new Date(+at+HOUR),status:'offline',follows:4,...extra};}
function snapshot(s,at,extra={}){return {_id:new ObjectId(),channelID:s.channelID,session_id:s._id,captured_at:new Date(at),viewers:20,game_name:'Game',title:'PRIVATE_TITLE',...extra};}
function event(label,type,at,extra={}){return {_id:new ObjectId(),eventKey:label,sourceEventId:label,source:'twitch-eventsub',type:`channel.${type}.received`,topic:'channel',schemaVersion:1,channelID:'fixture-channel',occurredAt:new Date(at),expiresAt:expiry,payload:{PRIVATE_PERSON:'PRIVATE_CHAT'},...extra};}
function privacy(value){assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|actorLabel|sourceEventId|eventKey|session_id|access_token|client_secret|dashboard-fixture-secret|dashboard-fixture-app-token/);}
async function cache(channel,value,options={EX:86400}){const key=`twitch:${channel}:emote-catalog:v1`;keys.add(key);await redis.set(key,JSON.stringify(value),options);return key;}
async function readyCache(channel,emotes=[]){return cache(channel,{emotes,checkedAt:new Date(now).toISOString(),retryAt:Date.now()+HOUR});}
async function records(scope='main'){let value;try{value=await readFile('/tmp/saas-fixtures/dashboard-activity-spawns.jsonl','utf8');}catch(error){if(error.code==='ENOENT')return [];throw error;}return value.split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.scope===scope);}
async function currentNative(scope='main'){const rows=await records(scope),exited=new Set(rows.filter(row=>row.event==='exit').map(row=>row.pid));return rows.filter(row=>row.event==='spawn'&&row.native&&!exited.has(row.pid)).at(-1);}
async function pause(scope='main'){const row=await waitFor(()=>currentNative(scope),'live native');process.kill(row.pid,'SIGSTOP');stopped.add(row.pid);await waitFor(async()=>/^State:\s+T/m.test(await readFile(`/proc/${row.pid}/status`,'utf8')),'pause native');return row;}
async function proxy(db,predicate){const value=await mongoHoldProxy(db,predicate);proxies.add(value);return value;}
const writes=(body,key)=>collectionWrites(body,names[key],test.databaseName);
const residual=(before,after)=>after.at-before.at-after.durationMs;
function readyTransitions(rows,label){for(let i=1;i<rows.length;i++)assert(residual(rows[i-1],rows[i])<700,`${label} transition ${i}: residual ${residual(rows[i-1],rows[i])}ms`);}
async function stop(child,observation){child.kill('SIGTERM');const result=await finished(child);observation.check();assert.equal(result.code,0,result.output);assert.equal(result.signal,null);return result;}
let paused,providers;
try{
 await client.connect();await redis.connect();await indexes(test);await indexes(referenceDb);
 const sentinel=`dashboard-fixture:${process.pid}:unrelated`;keys.add(sentinel);await redis.set(sentinel,'preserve',{EX:600});
 const {WORKERS,resolveWorkerLaunch}=await import('/app/dist/workers/cron.index.js');
 const {NATIVE_WORKERS,nativeProgressParser}=await import('/app/dist/utils/observability/native_worker_metrics.js');
 const definition=WORKERS.find(row=>row.name==='dashboard-activity');assert.equal(definition.kind,'native');assert.equal(NATIVE_WORKERS['dashboard-activity'].command,binary);
 for(const runtime of ['node','tsx']){
  const launchSpec=resolveWorkerLaunch(definition,{runtime,once:false,dryRun:false,restartDelayMs:1000},{...process.env,DASHBOARD_ACTIVITY_RUNTIME:'typescript',FORBIDDEN_FIXTURE_SECRET:'PRIVATE_ENV'},0);
  assert.equal(launchSpec.command,binary);assert.deepEqual(launchSpec.args,['--telemetry-json']);assert.equal(launchSpec.options.uid,65534);assert.equal(launchSpec.options.env.FORBIDDEN_FIXTURE_SECRET,undefined);assert.equal(launchSpec.options.env.DASHBOARD_ACTIVITY_RUNTIME,undefined);
 }
 paused=await pause();const root=paused.supervisor,siblings=(await records()).filter(row=>row.event==='spawn'&&!row.native).map(row=>[row.worker,row.pid]);
 assert(siblings.some(([worker])=>worker==='raid-sessions'));assert(siblings.every(([worker])=>worker!=='dashboard-activity'));
 assert.equal((await readFile(`/proc/${paused.pid}/cmdline`,'utf8')).split('\0')[0],binary);assert.match(await readFile(`/proc/${paused.pid}/status`,'utf8'),/^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
 pass('real cron boot selects UID65534 native dashboard; all foreign children inert; node/tsx restricted native launch');

 const help=await finished(launch(binary,['--help'],{PATH:process.env.PATH},{uid:65534,gid:65534}));assert.equal(help.code,0);for(const flag of ['--once','--telemetry-json','--database','--env-file'])assert(help.output.includes(flag));
 assert.notEqual((await finished(launch(binary,['--fixture-invalid'],{}))).code,0);
 const cwd=`/tmp/dashboard-dotenv-${process.pid}`;directories.add(cwd);await mkdir(cwd);await chmod(cwd,0o755);await writeFile(`${cwd}/.env`,`MONGO_URI=${nativeEnv(test).MONGO_URI}\nDRAGONFLY_HOST=redis\nDRAGONFLY_PORT=6379\n`);
 assert.notEqual((await finished(launch(binary,['--once'],{PATH:process.env.PATH},{cwd,uid:65534,gid:65534}))).code,0,'no implicit dotenv');
 const envFile=`/tmp/dashboard-activity-fixture-${process.pid}-${++sequence}.env`;files.add(envFile);await writeFile(envFile,`MONGO_URI=${uri.href}\nDRAGONFLY_HOST=redis\nDRAGONFLY_PORT=6379\n`);await chmod(envFile,0o644);
 await coll(test,'activity').insertOne(activity('explicit-database'));
 const explicit=await finished(launch(binary,['--once','--telemetry-json','--env-file',envFile,'--database',test.databaseName],{PATH:process.env.PATH},{uid:65534,gid:65534}));assert.equal(explicit.code,0,explicit.output);assert.equal((await coll(test,'activity').findOne()).dashboardProcessed,true);await reset();
 pass('CLI flags, invalid argument, explicit database/env-file, no implicit dotenv');

 const utc=new Date(+dayStart(new Date(now))-DAY+DAY-1),unicodeKey='x'.repeat(99)+'😀',unicodeLabel='L'.repeat(99)+'😀';
 const rows=[activity('a-command',{kind:'command',key:unicodeKey,label:unicodeLabel,occurredAt:utc}),activity('b-command',{kind:'command',key:unicodeKey,label:unicodeLabel,occurredAt:new Date(+utc-1000),expiresAt:new Date(+expiry+DAY)}),
  activity('c-message',{occurredAt:new Date(+utc+1),emotes:[{key:'twitch:Case_A-1',label:'E'.repeat(63)+'😀',count:2},{key:'twitch:Case_A-1',label:'ignored later',count:3},{key:'twitch:zero',label:'zero',count:0},{key:'twitch:negative',count:-1},{key:'twitch:fraction',count:.5},{key:'twitch:string',count:'4'},{key:'twitch:boolean',count:true},{key:'twitch:null',count:null},{key:'twitch:missing'},{key:'twitch:unsafe',count:9007199254740992},{key:'twitch:nan',count:NaN},{key:'twitch:infinity',count:Infinity},{key:'other:25',count:4},{key:'twitch:bad:id',count:4},{key:'twitch:'+ 'x'.repeat(65),count:4}]}),
  ...['redemption','follow','sub','gift','bits','raid'].map(kind=>activity(`excluded-${kind}`,{kind})),activity('future',{occurredAt:new Date(now+DAY)}),activity('expired',{expiresAt:new Date(now-1000)}),activity('done',{dashboardProcessed:true})];
 await both({activity:rows});assert.equal((await success()).events,4);await reference();await parity();
 const daily=await coll(test,'daily').find().toArray();assert.equal(daily.length,4);assert(daily.some(row=>row._id===hash('fixture-channel',dayStart(utc).toISOString(),'command',unicodeKey.slice(0,100))));
 assert.equal(daily.find(row=>row.kind==='emote').count,5);assert.equal(daily.find(row=>row.kind==='command').count,2);assert.equal(+daily.find(row=>row.kind==='command').expiresAt,+expiry+DAY);privacy(daily);privacy((await coll(test,'summary').findOne()).payload);
 const checkpoint=await coll(test,'state').findOne({_id:'dashboard-daily-v1'});assert.equal(checkpoint.seq,1);assert.equal(checkpoint.active,undefined);assert.equal(+checkpoint.leaseUntil,0);
 await success();await reference();await parity();pass('daily SHA256 JSON/UTF16 keys, UTC split, min/max dates, kind/expiry/count validation, BSON numeric/Date parity against TS, privacy and replay idempotence');await reset();

 // Saved active membership survives a partial unordered write; lastSeq fences replay.
 const replayRows=[activity('replay-command',{kind:'command',key:'hello',label:'!hello'}),activity('replay-emote',{emotes:[{key:'twitch:25',label:'Kappa',count:3}]}),activity('saved-expired',{expiresAt:new Date(now-1)})];
 const active={_id:'dashboard-daily-v1',seq:9,leaseUntil:epoch,active:{seq:9,ids:replayRows.map(row=>row._id)}};
 const preapplied={_id:hash('fixture-channel',dayStart(replayRows[0].occurredAt).toISOString(),'command','hello'),channelID:'fixture-channel',day:dayStart(replayRows[0].occurredAt),kind:'command',key:'hello',label:'!hello',count:1,lastSeq:9,firstAt:replayRows[0].occurredAt,expiresAt:expiry};
 // Deliberately seed historical integral Double fields: a fence-skipped replay
 // must preserve their existing BSON types, even though fresh Node writes use Int32.
 await both({activity:replayRows,state:[active]});for(const db of [test,referenceDb])await coll(db,'daily').insertOne({...preapplied,count:new BSON.Double(1),lastSeq:new BSON.Double(9)});
 await success();await reference();await parity();assert.equal((await coll(test,'daily').findOne({_id:preapplied._id})).count,1);assert.equal(await coll(test,'activity').countDocuments({dashboardProcessed:true}),3);assert.equal((await coll(test,'daily').findOne({kind:'coverage'})).count,2);
 await success();await reference();await parity();pass('partial saved batch duplicate-key replay, immutable sequence, expired saved row acknowledged without aggregate, repeat idempotence');await reset();
 for(const activeValue of [{seq:12,ids:[]},{seq:12}]){
  await both({state:[{_id:'dashboard-daily-v1',seq:12,leaseUntil:epoch,active:activeValue}],activity:[activity('empty-active',{kind:'command',key:'new'})]});await success();await reference();await parity();assert.equal((await coll(test,'state').findOne()).seq,13);await reset();
 }
 await both({state:[{_id:'dashboard-daily-v1',seq:2,leaseUntil:epoch,active:{seq:2,ids:['absent','expired-only']}}],activity:[activity('expired-only',{expiresAt:new Date(now-1)})]});await success();await reference();await parity();assert.equal((await coll(test,'state').findOne()).active,undefined);assert.equal(await coll(test,'daily').countDocuments(),0);
 pass('empty/default active.ids starts new checkpoint; absent/expired saved membership clears without invented work');await reset();

 await seed(test,{activity:[activity('leased')],state:[{_id:'dashboard-daily-v1',seq:5,leaseUntil:new Date(now+DAY),owner:'foreign-owner'}],summary:[summary('leased-summary',{leaseUntil:new Date(now+DAY),owner:'foreign-owner'})],insights:[insightSummary('leased-insights',{leaseUntil:new Date(now+DAY),owner:'foreign-owner'})]});
 assert.equal((await success()).events,0);assert.equal(await coll(test,'daily').countDocuments(),0);assert.equal((await coll(test,'state').findOne()).owner,'foreign-owner');assert.equal((await coll(test,'activity').findOne()).dashboardProcessed,undefined);
 pass('projection/activity/insight leases exclude competing owner without mutation');await reset();

 // Hold the actual owner lookup after durable membership, before daily writes.
 // This proves in-flight takeover fencing, separately from a preexisting lease.
 await seed(test,{activity:[activity('takeover-command',{kind:'command',key:'takeover'})]});
 const takeoverProxy=await proxy(test,body=>checkpointOwnerGuard(body,names.state));
 const takeover=launch(binary,['--once','--telemetry-json'],nativeEnv(test,{MONGO_URI:takeoverProxy.uri}),{uid:65534,gid:65534});
 const heldGuard=await takeoverProxy.held(),originalOwner=heldGuard.body.filter.owner;
 const beforeTakeover=await coll(test,'state').findOne({_id:'dashboard-daily-v1'});assert.equal(beforeTakeover.owner,originalOwner);assert.deepEqual(beforeTakeover.active.ids,['takeover-command']);
 assert(!takeoverProxy.parsed.some(row=>writes(row.body,'daily')),'owner guard must precede first daily write');
 const replacementOwner='fixture-replacement-owner',replacementLease=new Date(Date.now()+DAY);
 assert.equal((await coll(test,'state').updateOne({_id:'dashboard-daily-v1',owner:originalOwner},{$set:{owner:replacementOwner,leaseUntil:replacementLease}})).matchedCount,1);
 takeoverProxy.release();const takeoverResult=await finished(takeover);takeoverProxy.check();privacy(takeoverResult.output);
 assert.notEqual(takeoverResult.code,0,takeoverResult.output);assert.equal(takeoverResult.signal,null);assert.deepEqual(frames(takeoverResult.output).map(row=>[row.success,row.events]),[[false,0]]);
 assert(!takeoverProxy.parsed.some(row=>writes(row.body,'daily')),'lost owner must issue no daily write');
 assert.equal(await coll(test,'daily').countDocuments(),0);assert.equal(await coll(test,'summary').countDocuments(),0);assert.equal((await coll(test,'activity').findOne()).dashboardProcessed,undefined);
 const replacementState=await coll(test,'state').findOne({_id:'dashboard-daily-v1'});assert.equal(replacementState.owner,replacementOwner);assert.equal(+replacementState.leaseUntil,+replacementLease);assert.deepEqual(replacementState.active,beforeTakeover.active);assert.equal(replacementState.seq,beforeTakeover.seq);
 assert.deepEqual(replacementState.updatedAt,beforeTakeover.updatedAt);await takeoverProxy.close();assert.equal((await success()).events,0,'replacement lease still excludes a new claimant');
 assert.equal((await coll(test,'state').updateOne({_id:'dashboard-daily-v1',owner:replacementOwner},{$set:{leaseUntil:epoch}})).matchedCount,1);
 assert.equal((await success()).events,2);await success();assert.equal((await coll(test,'daily').findOne({kind:'command'})).count,1);assert.equal((await coll(test,'daily').findOne({kind:'coverage'})).count,1);assert.equal((await coll(test,'activity').findOne()).dashboardProcessed,true);assert.equal((await coll(test,'state').findOne()).active,undefined);
 pass('in-flight owner takeover before first daily write fails with no write/ack; replacement owner/lease/fence survives, explicit fixture expiry recovers once');await reset();

 // Real validation failure proves codes other than E11000 remain fatal/durable.
 await seed(test,{activity:[activity('bad-write',{kind:'command',key:'fail'}),activity('bad-emote',{emotes:[{key:'twitch:25',label:'Kappa',count:3}]})]});await coll(test,'daily').insertOne({_id:'validator-placeholder'});
 await test.command({collMod:names.daily,validator:{kind:{$ne:'emote'}},validationLevel:'strict',validationAction:'error'});
 await failOnce();assert.equal((await coll(test,'daily').findOne({kind:'coverage'})).count,2);assert.equal((await coll(test,'daily').findOne({kind:'command'})).count,1);assert.equal((await coll(test,'activity').findOne()).dashboardProcessed,undefined);assert((await coll(test,'state').findOne()).active.ids.includes('bad-write'));assert.equal(+((await coll(test,'state').findOne()).leaseUntil),0);
 await test.command({collMod:names.daily,validator:{},validationLevel:'strict'});await success();await success();assert.equal((await coll(test,'daily').findOne({kind:'command'})).count,1);assert.equal((await coll(test,'daily').findOne({kind:'coverage'})).count,2);assert.equal((await coll(test,'daily').findOne({kind:'emote'})).count,3);
 pass('nonduplicate Mongo write error propagates with durable active membership and clean lease; repair replays once');await reset();

 // A held real aggregation creates a dirtyAt update after refresh captured now.
 await seed(test,{summary:[summary('dirty-race')]});const dirtyProxy=await proxy(test,body=>body.aggregate===names.daily);
 const dirty=launch(binary,['--once','--telemetry-json'],nativeEnv(test,{MONGO_URI:dirtyProxy.uri}),{uid:65534,gid:65534});await dirtyProxy.held();const dirtyAt=new Date(Date.now()+1000);
 await coll(test,'summary').updateOne({_id:'dirty-race'},{$set:{dirtyAt,nextRefreshAt:epoch}});dirtyProxy.release();assert.equal((await finished(dirty)).code,0);dirtyProxy.check();await dirtyProxy.close();
 assert.equal(+(await coll(test,'summary').findOne()).nextRefreshAt,0);assert.equal(+(await coll(test,'summary').findOne()).dirtyAt,+dirtyAt);assert.equal(+((await coll(test,'summary').findOne()).leaseUntil),0);
 pass('activity dirtyAt race publishes payload without postponing newly dirty work');await reset();

 const rankChannel='99102001';await readyCache(rankChannel,Array.from({length:60},(_,i)=>({id:`own_${i}`,name:`Owned${i}`})));
 const rankDay=dayStart(new Date(now)),oldDay=new Date(+rangeStart(7)-DAY);
 const rankRows=[...Array.from({length:60},(_,i)=>({_id:`owned-${i}`,channelID:rankChannel,day:rankDay,kind:'emote',key:`twitch:own_${i}`,label:`Owned${i}`,count:i+1,firstAt:new Date(now-HOUR),expiresAt:expiry})),
  ...Array.from({length:7},(_,i)=>({_id:`global-${i}`,channelID:rankChannel,day:rankDay,kind:'emote',key:`twitch:global_${i}`,label:`Owned${i}`,count:1000,firstAt:new Date(now-HOUR),expiresAt:expiry})),
  ...Array.from({length:7},(_,i)=>({_id:`command-${i}`,channelID:rankChannel,day:rankDay,kind:'command',key:`cmd_${i}`,label:`!cmd_${i}`,count:10,firstAt:new Date(now-HOUR),expiresAt:expiry})),
  {_id:'coverage',channelID:rankChannel,day:rankDay,kind:'coverage',key:'',label:'',count:5,firstAt:new Date(now-2*HOUR),expiresAt:expiry},
  {_id:'old',channelID:rankChannel,day:oldDay,kind:'emote',key:'twitch:own_0',label:'Owned0',count:5,firstAt:oldDay,expiresAt:expiry},
  {_id:'expired',channelID:rankChannel,day:rankDay,kind:'emote',key:'twitch:own_0',label:'Owned0',count:99999,firstAt:new Date(now),expiresAt:new Date(now-1)},
  {_id:'tenant',channelID:'other-tenant',day:rankDay,kind:'emote',key:'twitch:own_0',label:'Owned0',count:99999,firstAt:new Date(now),expiresAt:expiry},
  {_id:'outside',channelID:rankChannel,day:new Date(+rangeStart(30)-DAY),kind:'emote',key:'twitch:own_0',label:'Owned0',count:99999,firstAt:new Date(now),expiresAt:expiry}];
 await both({daily:rankRows,summary:[summary(rankChannel)],state:[{_id:'dashboard-daily-v1',seq:0,leaseUntil:new Date(now+DAY)}],activity:[activity('pending',{channelID:rankChannel,occurredAt:new Date(now-1000)})]});
 await success();await reference();await parity(['summary']);let rank=(await coll(test,'summary').findOne()).payload;
 assert.equal(rank['7'].streamerEmoteUses,1830);assert.equal(rank['30'].streamerEmoteUses,1835);assert.equal(rank['7'].emoteUses,8830);assert.equal(rank['7'].commandRuns,70);assert.equal(rank['7'].pending,true);
 assert.deepEqual(rank['7'].commands.map(row=>row.key),['cmd_0','cmd_1','cmd_2','cmd_3','cmd_4']);assert.equal(rank['7'].streamerEmotes[0].key,'twitch:own_59');assert(rank['7'].emotes.every(row=>row.key.startsWith('twitch:global_')));privacy(rank);
 pass('cached 7/30 ranges, independent owned/all top5, ID ownership vs same labels, exact totals, ties, pending, retention and tenant exclusion');await reset();

 // Each input tally is Int32, but Mongo $sum promotes MAX_INT32+1 to Int64.
 // The TS oracle reads that safe value as JS Number and persists it as Double;
 // native payload normalization must perform the same rewrite, not retain Int64.
 const maxInt32=2147483647,largeTotal=maxInt32+1;
 const tallies=[];
 for(const[kind,key]of [['command','large-command'],['emote','twitch:own_0']])for(const[i,count]of [maxInt32,1].entries())tallies.push({
  _id:`large-${kind}-${i}`,channelID:rankChannel,day:new Date(+rankDay-i*DAY),kind,key,label:key,count,firstAt:new Date(now-(i+1)*DAY),expiresAt:expiry
 });
 await both({daily:tallies,summary:[summary(rankChannel)]});
 const aggregateType=await coll(test,'daily').aggregate([{$match:{kind:'command'}},{$group:{_id:null,count:{$sum:'$count'}}},{$project:{_id:0,type:{$type:'$count'}}}]).next();assert.deepEqual(aggregateType,{type:'long'},'fixture must exercise a real aggregate Int64');
 await success();await reference('activity');await parity(['daily','summary']);
 for(const db of [test,referenceDb]){
  const payload=(await coll(db,'summary').findOne()).payload;
  for(const days of ['7','30']){assert.equal(payload[days].commandRuns,largeTotal);assert.equal(payload[days].commands[0].count,largeTotal);assert.equal(payload[days].emoteUses,largeTotal);assert.equal(payload[days].emotes[0].count,largeTotal);assert.equal(payload[days].streamerEmoteUses,largeTotal);assert.equal(payload[days].streamerEmotes[0].count,largeTotal);}
  const itemType=path=>({$type:{$getField:{field:'count',input:{$arrayElemAt:[path,0]}}}});
  const persisted=await coll(db,'summary').aggregate([{$project:{_id:0,commandRuns:{$type:'$payload.7.commandRuns'},commandCount:itemType('$payload.7.commands'),emoteUses:{$type:'$payload.7.emoteUses'},emoteCount:itemType('$payload.7.emotes'),streamerEmoteUses:{$type:'$payload.7.streamerEmoteUses'},streamerEmoteCount:itemType('$payload.7.streamerEmotes')}}]).next();
  assert.deepEqual(persisted,{commandRuns:'double',commandCount:'double',emoteUses:'double',emoteCount:'double',streamerEmoteUses:'double',streamerEmoteCount:'double'},'safe above-Int32 JS Number payload is BSON Double, matching oracle');
 }
 pass('Int32 source tallies sum to aggregate Int64; both7/30 native payloads rewrite totals and item counts to Node-compatible Double with exact TS $type parity');await reset();

 // Seed the shared key with future retryAt: these cases cannot call providers.
 for(const[label,age,status,emotes]of [['ready',0,'ready',[{id:'owner',name:'Owner'}]],['stale',2*HOUR,'stale',[{id:'owner',name:'Owner'}]],['expired',2*DAY,'unavailable',[{id:'owner',name:'Owner'}]],['empty',0,'ready',[]],['unavailable',null,'unavailable',[]]]){
  await cache(rankChannel,{emotes,checkedAt:age===null?null:new Date(now-age).toISOString(),retryAt:Date.now()+HOUR});await seed(test,{summary:[summary(rankChannel)]});await success();
  const p=(await coll(test,'summary').findOne()).payload['7'];assert.equal(p.emoteCatalog.status,status);assert.equal(p.streamerEmoteUses,status==='unavailable'?null:0);assert.deepEqual(p.streamerEmotes,status==='unavailable'?null:[]);await reset(test);
 }
 // Invalid channel IDs must short circuit before Redis/provider use.
 await seed(test,{summary:[summary('not-numeric')]});await success();assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'unavailable');await reset(test);
 pass('native shared Redis catalog ready/stale/24h expiry/empty/unavailable and invalid channel short circuit');

 providers=await providerProxy();proxies.add(providers);const providerEnv={...providers.env,CLIENT_ID:'dashboard-fixture-client',CLIENT_SECRET:'dashboard-fixture-secret'};
 keys.add('app:twitch:token');await redis.del('app:twitch:token');await redis.del(`twitch:${rankChannel}:emote-catalog:v1`);
 providers.modes.set(rankChannel,{data:[{id:'owner',name:'N'.repeat(63)+'😀'}]});await seed(test,{summary:[summary(rankChannel)]});
 const beforeOAuth=providers.requests.length;await success(test,providerEnv);providers.check();
 assert.deepEqual(providers.requests.slice(beforeOAuth).map(row=>row.provider),['oauth','helix']);assert.equal(await redis.get('app:twitch:token'),'dashboard-fixture-app-token');assert((await redis.ttl('app:twitch:token'))>3500);
 let catalog=JSON.parse(await redis.get(`twitch:${rankChannel}:emote-catalog:v1`));assert.equal(catalog.emotes[0].id,'owner');assert.equal(catalog.emotes[0].name.length,64);assert(Number.isFinite(Date.parse(catalog.checkedAt)));assert(catalog.retryAt>Date.now()+3500000);assert((await redis.ttl(`twitch:${rankChannel}:emote-catalog:v1`))>86000);
 assert(providers.connections.includes('id.twitch.tv:443'));assert(providers.connections.includes('api.twitch.tv:443'));privacy((await coll(test,'summary').findOne()).payload);await reset(test);
 const calls=providers.requests.length;await seed(test,{summary:[summary(rankChannel)]});await success(test,providerEnv);assert.equal(providers.requests.length,calls,'next process reuses shared catalog/token');await reset(test);
 pass('real reqwest HTTPS CONNECT + trusted TLS, OAuth cache miss CLIENT_ID/SECRET body, Helix auth, UTF16 name bound, shared Redis token/catalog TTL and cross-process reuse');

 for(const mode of ['invalid','oversize','json','fail']){
  await redis.del(`twitch:${rankChannel}:emote-catalog:v1`);providers.modes.set(rankChannel,mode);await seed(test,{summary:[summary(rankChannel)]});await success(test,providerEnv);providers.check();
  const p=(await coll(test,'summary').findOne()).payload['7'];assert.equal(p.emoteCatalog.status,'unavailable');catalog=JSON.parse(await redis.get(`twitch:${rankChannel}:emote-catalog:v1`));assert.equal(catalog.checkedAt,null);assert(catalog.retryAt>Date.now()+50000);await reset(test);
 }
 await cache(rankChannel,{emotes:[{id:'owner',name:'Old'}],checkedAt:new Date(now-2*HOUR).toISOString(),retryAt:0});providers.modes.set(rankChannel,'fail');await seed(test,{summary:[summary(rankChannel)]});await success(test,providerEnv);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'stale');await reset(test);
 await cache(rankChannel,{emotes:[{id:'owner',name:'Expired'}],checkedAt:new Date(now-2*DAY).toISOString(),retryAt:0});await seed(test,{summary:[summary(rankChannel)]});await success(test,providerEnv);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'unavailable');await reset(test);
 for(const raw of ['not-json',JSON.stringify({emotes:[{id:'bad:id',name:'Bad'}],checkedAt:new Date().toISOString(),retryAt:Date.now()+DAY})]){
  await redis.set(`twitch:${rankChannel}:emote-catalog:v1`,raw);providers.modes.set(rankChannel,{data:[]});await seed(test,{summary:[summary(rankChannel)]});await success(test,providerEnv);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'ready');assert.deepEqual(JSON.parse(await redis.get(`twitch:${rankChannel}:emote-catalog:v1`)).emotes,[]);await reset(test);
 }
 pass('native provider invalid/malformed/oversize/non2xx handling, bounded retry, stale last-good vs expired and corrupt cache repair');

 providers.modes.set(rankChannel,'hang');await redis.del(`twitch:${rankChannel}:emote-catalog:v1`);await seed(test,{summary:[summary(rankChannel)]});let started=Date.now();await success(test,providerEnv);let elapsed=Date.now()-started;assert(elapsed>=2700&&elapsed<6500,`Helix timeout ${elapsed}ms`);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'unavailable');await reset(test);
 providers.setOAuthMode('hang');await redis.del('app:twitch:token');await redis.del(`twitch:${rankChannel}:emote-catalog:v1`);await seed(test,{summary:[summary(rankChannel)]});started=Date.now();await success(test,providerEnv);elapsed=Date.now()-started;assert(elapsed>=2700&&elapsed<6500,`OAuth timeout ${elapsed}ms`);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'unavailable');await reset(test);providers.setOAuthMode('ready');providers.check();
 pass('separate stalled Helix3s and OAuth3s requests remain nonfatal with unavailable catalog');

 providers.modes.set(rankChannel,{data:[]});providers.setOAuthMode('fail');await redis.del('app:twitch:token');await redis.del(`twitch:${rankChannel}:emote-catalog:v1`);await seed(test,{summary:[summary(rankChannel)]});await success(test,providerEnv);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'unavailable');assert.equal(await redis.get('app:twitch:token'),null);await reset(test);providers.setOAuthMode('ready');
 const noSecret={...providerEnv};delete noSecret.CLIENT_SECRET;await redis.del(`twitch:${rankChannel}:emote-catalog:v1`);await seed(test,{summary:[summary(rankChannel)]});const missingCredentialCalls=providers.requests.length;await success(test,noSecret);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'unavailable');assert.equal(providers.requests.length,missingCredentialCalls);await reset(test);
 await cache(rankChannel,{emotes:[{id:'owner',name:'Expired key'}],checkedAt:new Date().toISOString(),retryAt:Date.now()+HOUR},{EX:1});await delay(1200);assert.equal(await redis.get(`twitch:${rankChannel}:emote-catalog:v1`),null);await seed(test,{summary:[summary(rankChannel)]});const expiredCalls=providers.requests.length;await success(test,providerEnv);providers.check();assert.deepEqual(providers.requests.slice(expiredCalls).map(row=>row.provider),['oauth','helix']);assert.equal((await coll(test,'summary').findOne()).payload['7'].emoteCatalog.status,'ready');await reset(test);
 pass('OAuth rejection/missing CLIENT_SECRET stay private and nonfatal; actual Redis expiry triggers authenticated provider refresh');

 // Source initializes Mongo only. Redis outage must not block independent projections/insights.
 await seed(test,{activity:[activity('redis-down',{channelID:rankChannel,kind:'command',key:'hello'})],insights:[insightSummary(rankChannel)]});
 const down=await success(test,{DRAGONFLY_HOST:'127.0.0.1',DRAGONFLY_PORT:'1'});assert.equal(down.events,3);const downSummary=await coll(test,'summary').findOne();assert.equal(downSummary.payload['7'].commandRuns,1);assert.equal(downSummary.payload['7'].emoteCatalog.status,'unavailable');assert.equal(downSummary.error,false);assert((await coll(test,'insights').findOne()).payload['30:include']);
 pass('unavailable Redis is optional: numeric-channel projection, all-emote/activity and insights refresh still complete');await reset();

 // Compare every field in all four reports to full preserved TypeScript aggregation.
 const sessions=[],snapshots=[],events=[];
 const gameNames=['a','A','á','ä','Z','z','Å','_'];
 for(let i=0;i<24;i++){
  const s=session(`unicode-${i}`,new Date(+rangeStart(30)+(i+1)*DAY+HOUR),{follows:4});sessions.push(s);
  for(let m=0;m<60;m+=5)snapshots.push(snapshot(s,new Date(+s.started_at+m*60000),{game_name:gameNames[Math.floor(i/3)],viewers:20}));
  for(const delta of [0,300000,3599999])events.push(event(`f-${i}-${delta}`,'follow',new Date(+s.started_at+delta)));
 }
 const boundary=session('boundary7',rangeStart(7));sessions.push(boundary);for(let m=0;m<60;m+=5)snapshots.push(snapshot(boundary,new Date(+boundary.started_at+m*60000),{game_name:'g'.repeat(127)+'😀'}));
 const edge30=session('edge30',rangeStart(30));sessions.push(edge30);snapshots.push(snapshot(edge30,edge30.started_at,{game_name:' edge '}));
 const gap=session('gaps',new Date(now-3*HOUR));sessions.push(gap);snapshots.push(snapshot(gap,new Date(+gap.started_at-1)),snapshot(gap,new Date(+gap.started_at+5*60000),{game_name:'  Trimmed  ',viewers:-1}),snapshot(gap,new Date(+gap.started_at+40*60000)),snapshot(gap,new Date(+gap.started_at+50*60000)),snapshot(gap,gap.ended_at));
 const overlap=session('overlap',gap.started_at);sessions.push(overlap);snapshots.push(snapshot(overlap,new Date(+overlap.started_at+50*60000),{game_name:'overlap'}));
 events.push(event('ambiguous','follow',new Date(+gap.started_at+51*60000)),event('end-follow','follow',gap.ended_at),event('raid-start','raid',sessions[0].started_at),event('raid-end','raid',sessions[1].ended_at),event('raid-expired','raid',sessions[2].started_at,{expiresAt:new Date(now-1)}),event('wrong-source','raid',sessions[3].started_at,{source:'other'}),event('follow-expired','follow',sessions[0].started_at,{expiresAt:new Date(now-1)}),event('follow-tenant','follow',sessions[0].started_at,{channelID:'other-tenant'}));
 sessions.push(session('live',new Date(now-5*HOUR),{status:'live',ended_at:null}),session('orphaned',new Date(now-5*HOUR),{status:'orphaned'}),session('other',new Date(now-5*HOUR),{channelID:'other-tenant'}),session('before30',new Date(+rangeStart(30)-1)),session('future',new Date(now+HOUR)),session('bad-end',new Date(now-HOUR),{ended_at:new Date(now-2*HOUR)}));
 await both({sessions,snapshots,events,insights:[insightSummary('fixture-channel')]});await success();await reference('insights');await parity(['insights']);
 let report=(await coll(test,'insights').findOne()).payload;assert.deepEqual(Object.keys(report).sort(),['30:exclude','30:include','7:exclude','7:include']);assert.equal(report['30:include'].limited,false);assert.equal(report['30:exclude'].excludedStreams,1);assert(report['30:include'].gameCount>5);assert.equal(report['30:include'].games.length,5);privacy(report);
 pass('all 7/30 include/exclude insights: ICU nonASCII/case ties, UTF16 game bound, UTC/range boundaries, completed/tenant/expiry/source filters, weighted games, gaps/overlap/end follows, raids and privacy');await reset();

 // Exactly two eligible weekdays/games; deterministic recommendation ties use JS ICU.
 const eligibleSessions=[],eligibleSnapshots=[],eligibleEvents=[];
 for(let i=0;i<6;i++){
  const s=session(`eligible-${i}`,new Date(+rangeStart(30)+(7*Math.floor(i/2)+(i%2))*DAY+2*HOUR),{follows:4});eligibleSessions.push(s);
  for(let m=0;m<60;m+=5)eligibleSnapshots.push(snapshot(s,new Date(+s.started_at+m*60000),{game_name:i%2?'A':'a'}));
  for(let j=0;j<4;j++)eligibleEvents.push(event(`eligible-${i}-${j}`,'follow',new Date(+s.started_at+j*60000)));
 }
 await both({sessions:eligibleSessions,snapshots:eligibleSnapshots,events:eligibleEvents,insights:[insightSummary('fixture-channel')]});await success();await reference('insights');await parity(['insights']);report=(await coll(test,'insights').findOne()).payload['30:include'];
 assert.equal(report.games.filter(row=>row.eligible).length,2);assert.equal(report.bestGrowthGame,'a');assert.equal(report.bestDay,Math.min(...eligibleSessions.map(row=>row.started_at.getUTCDay())));assert.equal(report.games[0].game,'a');
 pass('three-stream/two-hour/full-coverage eligibility; weekday and ICU lowercase/uppercase recommendation ties');await reset();
 // Use binary-exact hours:3*1h sampled /3*1.25h streamed ===.8.
 // Five-minute fractions can instead sum to2.4/3<.8 before display rounding.
 // Move each first snapshot1ms later for the strictly-below comparison; positive
 // follow counts also prove recommendations require a second eligible group.
 for(const firstSnapshotShiftMs of [0,1]){
  const guardedSessions=[],guardedSnapshots=[],guardedEvents=[];
  for(let i=0;i<3;i++){
   const at=new Date(+rangeStart(30)+(i*7+1)*DAY+HOUR);
   const s=session(`guard-${i}`,at,{ended_at:new Date(+at+coverageSessionMs)});guardedSessions.push(s);
   const offsets=coverageSnapshotOffsets(firstSnapshotShiftMs);
   for(const offset of offsets)guardedSnapshots.push(snapshot(s,new Date(+s.started_at+offset),{game_name:'Only game'}));
   guardedEvents.push(event(`guard-follow-${i}`,'follow',new Date(+s.started_at+offsets[0])));
  }
  await both({sessions:guardedSessions,snapshots:guardedSnapshots,events:guardedEvents,insights:[insightSummary('fixture-channel')]});await success();await reference('insights');await parity(['insights']);const guarded=(await coll(test,'insights').findOne()).payload['30:include'];
  assert.equal(guarded.weekdays.filter(row=>row.streams).length,1);const weekday=guarded.weekdays.find(row=>row.streams);
  assert.equal(weekday.streams,3);assert.equal(weekday.hours,3.75);assert.equal(weekday.coverage,.8,'both boundary cases round to same displayed coverage');assert.equal(weekday.eligible,firstSnapshotShiftMs===0);
  assert.equal(guarded.games.length,1);assert.equal(guarded.games[0].eligible,true);assert.equal(guarded.games[0].follows,3);assert(weekday.follows>0);assert.equal(guarded.bestDay,null);assert.equal(guarded.bestGrowthGame,null);await reset();
 }
 pass('single positive-growth comparator yields no recommendation; binary-exact80% coverage eligible and first snapshots1ms later ineligible despite same rounded coverage');

 // At-cap and cap+1 are independent for all four sources. Shared TS executes
 // the same bounded queries, including timestamp-only follow cursor batches.
 for(const[kind,cap]of [['sessions',500],['snapshots',20000],['raids',10000],['follows',100000]]){
  await reset();const s=session(`cap-${kind}`,new Date(now-10*60000),{ended_at:new Date(now-5*60000)});
  if(kind!=='sessions')await both({sessions:[s]});
  if(kind==='follows')await both({snapshots:[snapshot(s,s.started_at)]});
  for(let offset=0;offset<cap;offset+=2000){
   const batch=Array.from({length:Math.min(2000,cap-offset)},(_,j)=>{const i=offset+j;
    if(kind==='sessions')return session(`cap-${i}`,new Date(now-HOUR-i*1000),{ended_at:new Date(now-HOUR-i*1000+500)});
    if(kind==='snapshots')return snapshot(s,new Date(+s.started_at+i),{game_name:'Cap'});
    return event(`cap-${kind}-${i}`,kind==='raids'?'raid':'follow',new Date(+s.started_at+(i%10000)));
   });await both({[kind==='raids'||kind==='follows'?'events':kind]:batch});
  }
  await both({insights:[insightSummary('fixture-channel')]});await success();await reference('insights');await parity(['insights']);
  report=(await coll(test,'insights').findOne()).payload;for(const value of Object.values(report))assert.equal(value.limited,false,`${kind} exact cap is complete`);
  const extra=kind==='sessions'?session('over-session',new Date(now-2*HOUR),{ended_at:new Date(now-2*HOUR+500)}):kind==='snapshots'?snapshot(s,new Date(+s.started_at+cap),{game_name:'Cap'}):event(`over-${kind}`,kind==='raids'?'raid':'follow',s.started_at);
  await both({[kind==='raids'||kind==='follows'?'events':kind]:[extra]});
  for(const db of [test,referenceDb])await coll(db,'insights').updateOne({_id:'fixture-channel'},{$set:{nextRefreshAt:epoch}});
  await success();await reference('insights');await parity(['insights']);report=(await coll(test,'insights').findOne()).payload;
  for(const value of Object.values(report)){assert.equal(value.limited,true,`${kind} cap+1 flags partial`);assert.equal(value.bestDay,null);assert.equal(value.bestGrowthGame,null);assert(value.weekdays.every(row=>!row.eligible));assert(value.games.every(row=>row.follows===null&&row.followsPerHour===null&&!row.eligible));privacy(value);}
  pass(`insight ${kind}: exact${cap} complete / ${cap+1} truncated, four variants suppress recommendations/growth, full TS parity`);
 }
 await reset();

 // Assert each ready transition independently; a fast aggregate cannot conceal
 // an unconditional one-second wait after a partial or summary-only pass.
 assert.throws(()=>readyTransitions([{at:0,durationMs:0},{at:1050,durationMs:50}],'sensitivity'),/residual 1000ms/);
 const scheduling=database('scheduling');await indexes(scheduling);
 await seed(scheduling,{activity:Array.from({length:1501},(_,i)=>activity(`backlog-${String(i).padStart(4,'0')}`)),insights:Array.from({length:3},(_,i)=>insightSummary(`insight-${i}`))});
 const continuous=launch(binary,['--telemetry-json'],nativeEnv(scheduling),{uid:65534,gid:65534}),observed=observe(continuous);
 await waitFor(()=>{observed.check();return observed.rows.length>=4;},'four ready bounded projection ticks');await stop(continuous,observed);
 assert.deepEqual(observed.rows.slice(0,4).map(row=>[row.success,row.events]),[[true,502],[true,502],[true,502],[true,2]]);readyTransitions(observed.rows.slice(0,4),'projection+both-summary backlog');
 assert.equal(await coll(scheduling,'activity').countDocuments({dashboardProcessed:true}),1501);assert.equal((await coll(scheduling,'daily').findOne({kind:'coverage'})).count,1501);assert.equal((await coll(scheduling,'state').findOne()).seq,4);
 pass('normal-mode 500+500+500+1 projection backlog, both summary queues fair each pass, max502 telemetry, every ready transition immediate');await reset(scheduling);
 for(const queues of [['summary'],['insights'],['summary','insights']]){
  const fixture={};for(const key of queues)fixture[key]=Array.from({length:4},(_,i)=>(key==='summary'?summary:insightSummary)(`summary-only-${key}-${i}`));await seed(scheduling,fixture);
  const child=launch(binary,['--telemetry-json'],nativeEnv(scheduling),{uid:65534,gid:65534}),observation=observe(child);
  await waitFor(()=>{observation.check();return observation.rows.length>=4;},'summary-only ready ticks');await stop(child,observation);
  assert.deepEqual(observation.rows.slice(0,4).map(row=>row.events),Array(4).fill(queues.length));readyTransitions(observation.rows.slice(0,4),queues.join('+'));
  for(const key of queues)assert.equal(await coll(scheduling,key).countDocuments({payload:{$exists:true}}),4);await reset(scheduling);
 }
 pass('activity-only, insight-only and combined summary backlog drains immediately with one of each per bounded tick');
 await seed(scheduling,{activity:[activity('expired-saved',{expiresAt:new Date(now-1)}),activity('ready-behind-empty')],state:[{_id:'dashboard-daily-v1',seq:1,leaseUntil:epoch,active:{seq:1,ids:['expired-saved']}}]});
 const empty=launch(binary,['--telemetry-json'],nativeEnv(scheduling),{uid:65534,gid:65534}),emptyObservation=observe(empty);
 await waitFor(()=>{emptyObservation.check();return emptyObservation.rows.length>=2;},'ready work behind zero-event saved batch');await stop(empty,emptyObservation);
 assert.deepEqual(emptyObservation.rows.slice(0,2).map(row=>row.events),[0,2]);readyTransitions(emptyObservation.rows.slice(0,2),'empty saved batch');assert.equal(await coll(scheduling,'activity').countDocuments({dashboardProcessed:true}),2);
 pass('zero retained rows in saved checkpoint still discovers ready projection backlog immediately');await reset(scheduling);
 for(const mode of ['idle','future','leased']){
  if(mode==='future')await seed(scheduling,{activity:[activity('future-only',{occurredAt:new Date(now+DAY)})],summary:[summary('future-summary',{nextRefreshAt:new Date(now+DAY)})],insights:[insightSummary('future-insight',{nextRefreshAt:new Date(now+DAY)})]});
  if(mode==='leased')await seed(scheduling,{activity:[activity('leased-only')],state:[{_id:'dashboard-daily-v1',seq:0,owner:'foreign',leaseUntil:new Date(now+DAY)}],summary:[summary('lease-summary',{leaseUntil:new Date(now+DAY)})],insights:[insightSummary('lease-insight',{leaseUntil:new Date(now+DAY)})]});
  const child=launch(binary,['--telemetry-json'],nativeEnv(scheduling),{uid:65534,gid:65534}),observation=observe(child);
  await waitFor(()=>{observation.check();return observation.rows.length>=2;},`${mode} one-second polling`);const signaledAt=performance.now();await stop(child,observation);
  assert.deepEqual(observation.rows.slice(0,2).map(row=>row.events),[0,0]);assert(residual(observation.rows[0],observation.rows[1])>=800,`${mode} must wait one second`);assert(performance.now()-signaledAt<800,`${mode} signal interrupts wait`);await reset(scheduling);
 }
 pass('normal idle/future/leased queues wait one second; SIGTERM interrupts sleep promptly');

 await seed(scheduling,{activity:Array.from({length:501},(_,i)=>activity(`error-backlog-${i}`))});
 // Projection completes full500, then summary publication fails: full count alone
 // must not bypass the retry pause and prior progress must remain durable.
 await scheduling.command({collMod:names.summary,validator:{payload:{$exists:false}},validationLevel:'strict',validationAction:'error'});
 const errors=launch(binary,['--telemetry-json'],nativeEnv(scheduling),{uid:65534,gid:65534}),errorObservation=observe(errors);
 await waitFor(()=>{errorObservation.check();return errorObservation.rows.length>=2;},'failed ticks pace despite prior full500');await stop(errors,errorObservation);
 assert(errorObservation.rows.slice(0,2).every(row=>!row.success&&row.events===0));assert(residual(errorObservation.rows[0],errorObservation.rows[1])>=800);assert.equal(await coll(scheduling,'activity').countDocuments({dashboardProcessed:true}),501);
 await scheduling.command({collMod:names.summary,validator:{},validationLevel:'strict'});await success(scheduling);assert.equal((await coll(scheduling,'daily').findOne({kind:'coverage'})).count,501);
 pass('normal errors after full500 retain progress, emit failed0, wait one second and recover without double counting');await reset(scheduling);

 // Active SIGTERM drains exactly the current pass and never starts ready501st row.
 await seed(test,{activity:Array.from({length:501},(_,i)=>activity(`signal-${i}`))});const signalProxy=await proxy(test,body=>writes(body,'daily'));
 const signaled=launch(binary,['--telemetry-json'],nativeEnv(test,{MONGO_URI:signalProxy.uri}),{uid:65534,gid:65534});await signalProxy.held();signaled.kill('SIGTERM');await delay(150);assert.equal(signaled.exitCode,null);
 signalProxy.release();const signalResult=await finished(signaled);signalProxy.check();await signalProxy.close();assert.equal(signalResult.code,0,signalResult.output);assert.equal(frames(signalResult.output).length,1);assert.equal(frames(signalResult.output)[0].events,501);assert.equal(await coll(test,'activity').countDocuments({dashboardProcessed:true}),500);assert.equal((await coll(test,'state').findOne()).active,undefined);assert.equal(+(await coll(test,'state').findOne()).leaseUntil,0);
 pass('SIGTERM drains current500 projection plus summary, releases fence and leaves ready501st untouched');await reset();

 // Hold a real daily write after saved active membership. An OS watchdog must
 // terminate even when Mongo never resolves; the 60s lease remains protective.
 await seed(test,{activity:[activity('watchdog-command',{kind:'command',key:'recover'})]});const watchdogProxy=await proxy(test,body=>writes(body,'daily'));
 started=Date.now();const watchdog=launch(binary,['--once','--telemetry-json'],nativeEnv(test,{MONGO_URI:watchdogProxy.uri}),{uid:65534,gid:65534});await watchdogProxy.held();
 const abandoned=await coll(test,'state').findOne();assert(abandoned.active.ids.includes('watchdog-command'));assert(+abandoned.leaseUntil>Date.now());
 const activeTypes=await coll(test,'state').aggregate([{$match:{_id:'dashboard-daily-v1'}},{$project:{_id:0,seq:{$type:'$seq'},activeSeq:{$type:'$active.seq'},lease:{$type:'$leaseUntil'}}}]).next();assert.deepEqual(activeTypes,{seq:'int',activeSeq:'int',lease:'date'});
 const watchdogResult=await finished(watchdog,47000);elapsed=Date.now()-started;assert(elapsed>=38000&&elapsed<=47000);assert.notEqual(watchdogResult.code,0);assert.equal(watchdogResult.signal,null);assert.equal(frames(watchdogResult.output).length,0);
 assert.match(watchdogResult.output,/Dashboard activity active work exceeded 40-second watchdog; durable work retained for recovery/);assert.equal(await coll(test,'daily').countDocuments(),0);assert.equal((await coll(test,'activity').findOne()).dashboardProcessed,undefined);
 const retained=await coll(test,'state').findOne();assert.equal(retained.owner,abandoned.owner);assert.equal(retained.active.seq,abandoned.active.seq);assert(+retained.leaseUntil>Date.now(),'heartbeat lease protects watchdog abandonment');
 const heartbeatCommands=assertHeartbeatRenewal({abandoned,retained,parsed:watchdogProxy.parsed,collection:names.state});
 watchdogProxy.checkConfirmedWatchdogExit(watchdogResult,elapsed);await watchdogProxy.close();assert.equal((await success()).events,0,'replacement respects unexpired lease');
 await coll(test,'state').updateOne({_id:'dashboard-daily-v1',owner:retained.owner},{$set:{leaseUntil:epoch}});await success();await success();assert.equal((await coll(test,'daily').findOne({kind:'command'})).count,1);
 pass(`hard40s watchdog (${elapsed}ms) observes ${heartbeatCommands} heartbeat renewals and lease advance>=15s; fence/raw work recover exactly once`);await reset();

 // Test parser rejection separately from native-output privacy, including a
 // valid-looking private/oversized frame that must yield no observations.
 const emitted=[],parse=nativeProgressParser((...args)=>emitted.push(args),'dashboard-activity');
 parse(protocol+JSON.stringify({event:'batch',events:1,durationMs:2,success:true})+'\n');assert(emitted.length>0);const validCount=emitted.length;
 for(const row of [{event:'batch',events:503,durationMs:1,success:true},{event:'batch',events:1,durationMs:1,success:false},{event:'batch',events:1,durationMs:1,success:true,channelID:'PRIVATE_CHANNEL'},{event:'health',events:0,durationMs:1,success:true}])parse(protocol+JSON.stringify(row)+'\n');
 parse(protocol+'x'.repeat(20000)+'\n');assert.equal(emitted.length,validCount);privacy(emitted);
 pass('batch parser rejects oversize/private/health/failed-nonzero frames; accepted metadata has no private fields');

 // Fault only actual dashboard launch; never rename image binaries or execute
 // foreign workers. Both node and tsx supervisors must retry native only.
 for(const[fault,runtime]of [['missing','node'],['exit','tsx']]){
  const scope=`fault-${fault}`,db=database(`fault_${fault}`),selected=new URL(uri);selected.pathname=`/${db.databaseName}`;
  const child=launch(process.execPath,['/app/dist/workers/cron.index.js'],{...process.env,MONGO_URI:selected.href,CRON_WORKER_RUNTIME:runtime,DASHBOARD_ACTIVITY_FIXTURE_SCOPE:scope,DASHBOARD_ACTIVITY_FIXTURE_FAULT:fault});
  await waitFor(async()=>{const rows=await records(scope);return rows.filter(row=>row.event==='spawn'&&row.native).length>=2;},`${fault} native child restart`);
  const rows=await records(scope),foreign=rows.filter(row=>row.event==='spawn'&&!row.native);assert.equal(new Set(foreign.map(row=>row.worker)).size,foreign.length,'foreign siblings never restart');
  assert(rows.filter(row=>row.event==='spawn'&&row.native).every(row=>row.command===binary&&row.requestedCommand===binary));
  if(fault==='missing')assert(rows.some(row=>row.event==='error'&&row.code==='ENOENT'));else assert(rows.some(row=>row.event==='exit'&&row.code===17));
  child.kill('SIGTERM');assert.equal((await finished(child)).code,0);
 }
 pass('actual node ENOENT and tsx nonzero dashboard launch retry native only, all foreign siblings remain inert/stable');

 const killed=paused;stopped.delete(killed.pid);process.kill(killed.pid,'SIGKILL');paused=undefined;
 const replacement=await waitFor(async()=>{const row=await currentNative();return row&&row.pid!==killed.pid?row:null;},'main native child replacement');assert.equal(replacement.supervisor,root);
 assert.deepEqual((await records()).filter(row=>row.event==='spawn'&&!row.native).map(row=>[row.worker,row.pid]),siblings);
 await seed(actual,{activity:[activity('supervisor-recovered',{kind:'command',key:'live-check'})]});
 await waitFor(async()=>await coll(actual,'activity').countDocuments({dashboardProcessed:true})===1,'replacement real projection');
 await waitFor(async()=>(await records()).some(row=>row.event==='batch'&&row.pid===replacement.pid&&row.frame.success&&row.frame.events===2),'replacement bounded success frame');
 pass('actual supervisor SIGKILL replaces only dashboard child; replacement projects real metadata without TypeScript fallback');

 const idle=database('tsx'),idleUri=new URL(uri);idleUri.pathname=`/${idle.databaseName}`;
 const tsx=launch(process.execPath,['/app/dist/workers/cron.index.js'],{...process.env,MONGO_URI:idleUri.href,CRON_WORKER_RUNTIME:'tsx',DASHBOARD_ACTIVITY_RUNTIME:'typescript',DASHBOARD_ACTIVITY_FIXTURE_SCOPE:'tsx'});
 const tsxNative=await waitFor(()=>currentNative('tsx'),'actual tsx native child');await waitFor(async()=>(await records('tsx')).some(row=>row.event==='batch'&&row.frame.success),'tsx native success');tsx.kill('SIGTERM');const tsxResult=await finished(tsx);assert.equal(tsxResult.code,0,tsxResult.output);
 await waitFor(async()=>(await records('tsx')).some(row=>row.event==='exit'&&row.pid===tsxNative.pid&&row.code===0&&row.signal===null),'tsx child graceful SIGTERM');await delay(1100);assert.equal((await records('tsx')).filter(row=>row.event==='spawn'&&row.native).length,1);
 for(const scope of ['main','tsx'])for(const row of (await records(scope)).filter(row=>row.event==='batch'))frames(protocol+JSON.stringify(row.frame));
 assert.equal(await redis.get(sentinel),'preserve');pass('actual tsx ignores stale runtime selector, native idle SIGTERM exits without restart; unrelated Redis survives');

 // Validate actual supervisor telemetry envelopes with staged exact analytics source.
 const store=await readFile('/tmp/saas-fixtures/analytics-store.mjs','utf8');assert(store.startsWith("import pg from 'pg';\n"));
 const {validateBatch}=await import('data:text/javascript,'+encodeURIComponent(store.replace("import pg from 'pg';",'const pg = {};')));
 await waitFor(async()=>{
  const values=await redis.lRange('observability:v1:inbox',0,-1);let sawRuntime=false,sawBatch=false,sawRestart=false;
  for(const raw of values){const envelope=JSON.parse(raw);validateBatch(envelope);const metrics=envelope.metrics.filter(row=>row.name?.startsWith('dashboard_activity_rust.'));
   privacy(metrics);if(metrics.length)assert.equal(envelope.service,'cron');for(const metric of metrics){assert.equal(metric.channel,'');assert(['rss_bytes','cpu_cores','batch_events','project_batch','errors','restarts'].includes(metric.name.slice('dashboard_activity_rust.'.length)));}
   sawRuntime ||= metrics.some(row=>row.name.endsWith('.rss_bytes')&&row.kind==='runtime'&&row.max>0);sawBatch ||= metrics.some(row=>row.name.endsWith('.batch_events')&&row.sum>0);sawRestart ||= metrics.some(row=>row.name.endsWith('.restarts')&&row.sum>0);
  }return sawRuntime&&sawBatch&&sawRestart;
 },'analytics-valid real native runtime/batch/restart envelopes',35000);
 pass('actual supervisor runtime/batch/restart metrics pass staged analytics validator and contain no private identifiers');
 console.log(JSON.stringify({check:'dashboard-activity-rust',groups,elapsedMs:Date.now()-(deadline-280000),scope:'exact candidate, disposable Mongo/Redis, native TLS provider mock'}));
}finally{
 for(const pid of stopped){try{process.kill(pid,'SIGCONT');}catch{}}
 for(const child of children){try{child.kill('SIGTERM');}catch{}}
 await Promise.allSettled([...children].map(async child=>{try{await bounded(child.completion,4000,'cleanup graceful child');}catch{try{child.kill('SIGKILL');}catch{}await bounded(child.completion.catch(()=>{}),2000,'cleanup killed child').catch(()=>{});}}));
 await Promise.allSettled([...proxies].map(value=>value.close()));
 await Promise.allSettled([...files].map(path=>unlink(path)));
 await Promise.allSettled([...directories].map(path=>{assert.match(path,/^\/tmp\/dashboard-dotenv-[0-9]+$/);return rm(path,{recursive:true,force:true});}));
 try{if(redis.isOpen&&keys.size)await redis.del([...keys]);for(const name of owned){assert.match(name,pattern);await client.db(name).dropDatabase();}}
 finally{await bounded(client.close(),5000,'Mongo close').catch(()=>{});if(redis.isOpen)redis.destroy();await mongoose.disconnect();}
}
