import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BOUNDS, validateBatch, summarize, percentile, scopeSql, makePool, migrate, ingest, overview } from '../src/store.mjs';
import { parseInfo, parseOpenMetrics } from '../src/collectors.mjs';
import { createApp } from '../src/index.mjs';
import { createClient } from 'redis';
function batch(channel='channel-a',count=100){return{version:1,id:randomUUID(),service:'bot',instance:'fixture',metrics:[{at:Math.floor(Date.now()/10000)*10000,kind:'chat',name:'message',channel,outcome:'ok',count,sum:count*10,max:10,histogram:BOUNDS.map((_,i)=>i===2?count:0)}],spans:[],logs:[]};}
test('rejects malformed, oversized and inconsistent batches',()=>{assert.doesNotThrow(()=>validateBatch(batch()));const bad=batch();bad.metrics[0].histogram[0]=1;assert.throws(()=>validateBatch(bad));bad.metrics[0].at=Date.now()-7200000;assert.throws(()=>validateBatch(bad));assert.throws(()=>validateBatch({...batch(),spans:Array(51).fill({})}));});
test('percentiles merge counts, not percentile values',()=>{const a=batch().metrics[0],b=batch('channel-a',1).metrics[0];b.histogram=BOUNDS.map((_,i)=>i===12?1:0);b.sum=30000;b.max=30000;const s=summarize([a,b]);assert.equal(s.count,101);assert.equal(s.p95,10);assert.equal(s.p99,10);assert.equal(percentile(BOUNDS.map(()=>0),.95),null);});
test('filters cannot widen an access grant',()=>{const args=[];const sql=scopeSql({channels:['allowed'],services:['bot']},args,{channel:'other',service:'api'});assert.deepEqual(args,[['allowed'],['bot'],'other','api']);assert.match(sql,/channel = ANY/);});
test('resource parsers allow only numeric resource fields',()=>{assert.equal(parseInfo('# Memory\r\nused_memory:123\r\n').used_memory,'123');assert.deepEqual(parseOpenMetrics('memory_active_bytes 42\nsecret_metric 99'),{memory_active_bytes:42});});
test('real PostgreSQL persistence, replay safety, API permissions and Redis ingestion',{skip:!process.env.ANALYTICS_TEST},async()=>{
 assert.match(process.env.DATABASE_URL,/observability_test/);
 const pool=makePool(process.env.DATABASE_URL),redis=createClient({url:process.env.REDIS_URL});redis.on('error',()=>{});await redis.connect();await migrate(pool);
 const app=createApp({pool,redis,config:{ownerId:'1'},health:{ingestedAt:null},validateToken:async()=>null});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const call=async(path,token='owner',method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 try{
  for(const[token,id]of[['owner','1'],['viewer','2'],['investigator','3'],['stranger','4'],['expired','5']])await redis.hSet('token:'+token,{id,login:token});
  assert.equal((await call('/api/overview','bad')).status,401);assert.equal((await call('/api/overview','stranger')).status,403);
  await redis.hSet('accounts:twitch:channel-a:data',{name:'pixelpilot',email:'private@example.invalid',access_token:'private-token'});await redis.hSet('accounts:twitch:channel-b:data',{name:'lunastreams'});
  const one=batch(),two=batch('channel-b',75);one.spans=[{at:Date.now(),traceId:'a'.repeat(32),spanId:'b'.repeat(16),parentId:null,channel:'channel-a',kind:'chat',name:'message',outcome:'ok',duration:10,partial:false}];two.spans=[{...one.spans[0],spanId:'c'.repeat(16),channel:'channel-b'}];one.logs=[{at:Date.now(),level:'error',name:'fixture',channel:'channel-a',traceId:'a'.repeat(32),fields:{code:'test'}}];
  assert.equal(await ingest(pool,one),true);assert.equal(await ingest(pool,one),false);await ingest(pool,two);
  assert.equal((await overview(pool,{channels:[],services:[]},{minutes:60})).chat.count,175);assert.equal((await overview(pool,{channels:[],services:[]},{minutes:10080})).chat.count,175);
  for(const[id,role]of[['2','viewer'],['3','investigator']])assert.equal((await call('/api/grants/'+id,'owner','PUT',{role,channels:['channel-a'],services:[],expiresAt:null})).status,200);
  assert.equal((await call('/api/grants/9','viewer','PUT',{role:'viewer',channels:[],services:[],expiresAt:null})).status,403);
  const named=await call('/api/overview','viewer');assert.equal(named.body.chat.count,100);assert.deepEqual(named.body.channelNames,{'channel-a':'pixelpilot'});assert(!JSON.stringify(named.body).includes('private-token'));assert(!JSON.stringify(named.body).includes('private@example'));assert.deepEqual((await call('/api/session','viewer')).body.channelNames,{'channel-a':'pixelpilot'});const deniedChannel=await call('/api/overview?channel=channel-b','viewer');assert.equal(deniedChannel.body.chat.count,0);assert.deepEqual(deniedChannel.body.channelNames,{'channel-a':'pixelpilot'});
  for(const path of ['/api/resources','/api/traces','/api/logs'])assert.equal((await call(path,'viewer')).status,403);
  const detail=await call('/api/traces/'+'a'.repeat(32),'investigator');assert.equal(detail.body.spans.length,1);assert.equal(detail.body.spans[0].channel,'channel-a');assert.equal(detail.body.partial,true);assert.deepEqual(detail.body.channelNames,{'channel-a':'pixelpilot'});
  assert.equal((await call('/api/logs','investigator')).body.logs.length,1);assert.equal((await call('/api/overview?minutes=9999999')).status,400);
  await pool.query("INSERT INTO analytics_grants(user_id,role,granted_by,expires_at) VALUES('5','viewer','1',now()-interval '1 second')");assert.equal((await call('/api/overview','expired')).status,403);
  await call('/api/grants/2','owner','DELETE');assert.equal((await call('/api/overview','viewer')).status,403);
  if(process.env.ANALYTICS_TEST_URL){const queued=batch('channel-c',25);await redis.lPush('observability:v1:inbox',JSON.stringify(queued));for(let i=0;i<50;i++){if((await pool.query('SELECT id FROM analytics_batches WHERE id=$1',[queued.id])).rowCount)break;await new Promise(r=>setTimeout(r,100));}assert.equal((await pool.query('SELECT id FROM analytics_batches WHERE id=$1',[queued.id])).rowCount,1);const r=await fetch(process.env.ANALYTICS_TEST_URL+'/api/overview',{headers:{Authorization:'Bearer owner'}});assert.equal(r.status,200);assert.equal((await r.json()).chat.count,200);}
 }finally{await new Promise(r=>server.close(r));await redis.quit();await pool.end();}
});
test('long ranges aggregate every bucket and keep the latest value fresh',{skip:!process.env.ANALYTICS_TEST},async()=>{
 assert.match(process.env.DATABASE_URL,/observability_test/);
 const pool=makePool(process.env.DATABASE_URL);await migrate(pool);
 const insert=(resolution,slots,unit,value)=>pool.query(`INSERT INTO analytics_metrics SELECT $1,date_trunc('${unit}',now())-s*interval '1 ${unit}','bulk','http','route-'||r,'',CASE WHEN r=0 THEN 'error' ELSE 'ok' END,2,2*$2,$2,$3::bigint[] FROM generate_series(0,$4) s CROSS JOIN generate_series(0,24) r ON CONFLICT DO NOTHING`,[resolution,value,BOUNDS.map((_,i)=>i===2?2:0),slots]);
 try{
  await insert(60,1438,'minute',10);await insert(3600,20,'hour',10);
  await pool.query(`INSERT INTO analytics_metrics VALUES(10,to_timestamp(floor(extract(epoch FROM now())/10)*10),'bulk','http','route-1','','ok',1,99,99,$1::bigint[])`,[BOUNDS.map((_,i)=>i===10?1:0)]);
  const day=await overview(pool,{channels:[],services:[]},{minutes:1440,service:'bulk'});
  assert.equal(day.resolution,60);assert.equal(day.http.count,2*1439*25);assert.equal(day.http.errors,2*1439);assert.equal(day.groups.length,25);assert.equal(day.truncated,undefined);
  assert.equal(day.timeline.reduce((sum,t)=>sum+t.http,0),2*1439*25);assert.equal(day.groups.find(g=>g.name==='route-0').count,2*1439);
  const fresh=day.groups.find(g=>g.name==='route-1');assert.equal(fresh.lastValue,99);assert(Date.now()-new Date(fresh.lastAt).getTime()<20000);assert.equal(day.groups.find(g=>g.name==='route-2').lastValue,10);
  const week=await overview(pool,{channels:[],services:[]},{minutes:10080,service:'bulk'});
  assert.equal(week.resolution,3600);assert.equal(week.http.count,2*21*25);assert.equal(week.groups.find(g=>g.name==='route-1').lastValue,99);
  const minuteGauge=new Date(week.groups.find(g=>g.name==='route-2').lastAt).getTime();assert(Date.now()-minuteGauge<70000);
  assert.equal((await overview(pool,{channels:['other'],services:[]},{minutes:1440,service:'bulk'})).http.count,0);
 }finally{await pool.query("DELETE FROM analytics_metrics WHERE service='bulk'");await pool.end();}
});
