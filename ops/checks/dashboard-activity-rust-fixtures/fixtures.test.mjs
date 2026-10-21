// Host-safe fixture validation: loopback sockets only, no databases or Rust build.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {connect} from 'node:tls';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {coverageSessionMs,coverageSnapshotOffsets} from './insight-coverage.mjs';
import {providerProxy} from './providers.mjs';
const directory=fileURLToPath(new URL('.',import.meta.url));
async function tunnel(proxy,host,path,options={}){
 const address=new URL(proxy.env.HTTPS_PROXY),ca=options.ca??await readFile(`${directory}/provider-root-cert.pem`);
 return new Promise((resolve,reject)=>{
  const req=request({host:address.hostname,port:address.port,method:'CONNECT',path:`${host}:443`});req.on('error',reject);
  req.on('connect',(_res,socket,head)=>{
   if(head.length)socket.unshift(head);
   const secure=connect({socket,servername:options.servername||host,ca,ALPNProtocols:['http/1.1']},()=>{
    try{assert.equal(secure.authorized,true);}catch(error){reject(error);secure.destroy();return;}
    const body=options.body||'';
    secure.write(`${options.method||'GET'} ${path} HTTP/1.1\r\nHost: ${host}\r\nClient-Id: dashboard-fixture-client\r\nAuthorization: Bearer dashboard-fixture-app-token\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
   });
   let result='';secure.on('data',chunk=>{result+=chunk;});secure.on('error',reject);secure.on('end',()=>resolve(result));
  });req.end();
 });
}
test('fixture CONNECT terminates verified TLS for real Twitch hosts; OAuth and empty Helix remain distinct',async()=>{
 const proxy=await providerProxy(directory);
 assert.equal(proxy.env.SSL_CERT_FILE,`${directory}/provider-root-cert.pem`);
 try{
  const oauth=await tunnel(proxy,'id.twitch.tv','/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:'dashboard-fixture-client',client_secret:'dashboard-fixture-secret',grant_type:'client_credentials'}).toString()});
  assert.match(oauth,/200 OK/);assert.match(oauth,/dashboard-fixture-app-token/);
  proxy.modes.set('99102001',{data:[]});const helix=await tunnel(proxy,'api.twitch.tv','/helix/chat/emotes?broadcaster_id=99102001');
  assert.match(helix,/200 OK/);assert.match(helix,/"data":\[\]/);proxy.check();assert.deepEqual(proxy.connections,['id.twitch.tv:443','api.twitch.tv:443']);
  assert.deepEqual(proxy.requests,[{provider:'oauth',method:'POST',validCredentials:true},{provider:'helix',channel:'99102001',authenticated:true}]);
  assert.doesNotMatch(JSON.stringify(proxy.requests),/dashboard-fixture-secret|dashboard-fixture-app-token/);
 }finally{await proxy.close();}
});
test('signed non-CA server leaf chains to separate test root, has serverAuth and exact Twitch SANs',async()=>{
 const {X509Certificate,createPrivateKey}=await import('node:crypto');
 const cert=new X509Certificate(await readFile(`${directory}/provider-cert.pem`)),root=new X509Certificate(await readFile(`${directory}/provider-root-cert.pem`));
 assert.equal(root.ca,true);assert.equal(root.subject,root.issuer);assert.equal(root.verify(root.publicKey),true);
 assert.notEqual(root.fingerprint256,cert.fingerprint256);assert.notEqual(cert.subject,cert.issuer);
 assert.equal(cert.checkIssued(root),true);assert.equal(cert.verify(root.publicKey),true);
 assert.equal(cert.checkPrivateKey(createPrivateKey(await readFile(`${directory}/provider-key.pem`))),true);
 assert.deepEqual(cert.keyUsage,['1.3.6.1.5.5.7.3.1'],'leaf EKU is only TLS serverAuth');
 assert.equal(cert.subjectAltName,'DNS:api.twitch.tv, DNS:id.twitch.tv');assert.equal(root.subjectAltName,undefined);
 for(const row of [root,cert])assert(Date.parse(row.validFrom)<=Date.now()&&Date.now()<Date.parse(row.validTo));
 assert.equal(cert.ca,false,'TLS server leaf must not be a CA (webpki rejects CA end entities)');
 assert.equal(cert.checkHost('api.twitch.tv'),'api.twitch.tv');assert.equal(cert.checkHost('id.twitch.tv'),'id.twitch.tv');assert.equal(cert.checkHost('other.invalid'),undefined);
});
test('bootstrap allows only one real native child',async()=>{
 const boot=await readFile(`${directory}/cron-boot.mjs`,'utf8');assert.match(boot,/const native = worker === 'dashboard-activity'/);assert.match(boot,/Unexpected supervisor child/);assert.match(boot,/Native worker inherited unexpected environment/);
});

test('CONNECT still rejects untrusted root and incorrect hostname with TLS verification enabled',async()=>{
 for(const [options,code]of [[{ca:[]},'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],[{servername:'untrusted.invalid'},'ERR_TLS_CERT_ALTNAME_INVALID']]){
  const proxy=await providerProxy(directory);
  try{await assert.rejects(tunnel(proxy,'api.twitch.tv','/helix/chat/emotes?broadcaster_id=99102001',options),error=>error.code===code);assert.equal(proxy.requests.length,0);}
  finally{await proxy.close();}
 }
});

test('heartbeat assertion rejects initial lease survival and requires observed owner-guarded renewals',async()=>{
 const {assertHeartbeatRenewal}=await import('./lifecycle-assertions.mjs');
 const abandoned={owner:'old-owner',leaseUntil:new Date(60000)},collection='stream_activity_states';
 const renewal=(at,owner='old-owner')=>({body:{update:collection,updates:[{q:{_id:'dashboard-daily-v1',owner},u:{$set:{leaseUntil:new Date(at)}}}]}});
 const retained={owner:'old-owner',leaseUntil:new Date(90000)},parsed=[renewal(70000),renewal(80000),renewal(90000)];
 assert.equal(assertHeartbeatRenewal({abandoned,retained,parsed,collection}),3);
 for(const at of [60000,74999])assert.throws(()=>assertHeartbeatRenewal({abandoned,retained:{...retained,leaseUntil:new Date(at)},parsed,collection}),/advance at least15s/);
 assert.throws(()=>assertHeartbeatRenewal({abandoned,retained,parsed:[renewal(90000)],collection}),/at least two/);
 assert.throws(()=>assertHeartbeatRenewal({abandoned,retained,parsed:[renewal(80000,'replacement'),renewal(90000,'replacement')],collection}),/at least two/);
 assert.throws(()=>assertHeartbeatRenewal({abandoned,retained,parsed:[renewal(75000),renewal(80000)],collection}),/match an observed/);
 assert.throws(()=>assertHeartbeatRenewal({abandoned,retained:{...retained,owner:'replacement'},parsed,collection}));
});

test('wire matching holds owned native bulkWrite and pre-write owner guard without admitting foreign namespaces',async()=>{
 const {ownedBulkWrite,collectionWrites,checkpointOwnerGuard}=await import('./lifecycle-assertions.mjs');
 const database='dashboard_activity_fixture_unit',collection='dashboard_activity_dailies';
 const body={bulkWrite:1,nsInfo:[{ns:`${database}.${collection}`}],ops:[{update:0,filter:{_id:'daily-id'},updateMods:{$inc:{count:1}}}],$db:'admin'};
 assert.equal(ownedBulkWrite(body,database),true);assert.equal(collectionWrites(body,collection,database),true);
 assert.equal(collectionWrites({...body,ops:[{update:1}]},collection,database),false);
 assert.equal(ownedBulkWrite({...body,nsInfo:[...body.nsInfo,{ns:'production.private'}]},database),false);
 assert.equal(ownedBulkWrite({...body,nsInfo:[{ns:`${database}-other.${collection}`}]},database),false);
 assert.equal(ownedBulkWrite({...body,nsInfo:[]},database),false);
 const guard={find:'stream_activity_states',filter:{_id:'dashboard-daily-v1',owner:'claim-owner'},projection:{_id:1}};
 assert.equal(checkpointOwnerGuard(guard,guard.find),true);
 assert.equal(checkpointOwnerGuard({...guard,filter:{_id:'dashboard-daily-v1'}},guard.find),false);
 assert.equal(checkpointOwnerGuard({...guard,filter:{_id:'dashboard-daily-v1',leaseUntil:{$lte:new Date()}}},guard.find),false);
});

// Load only the real source's pure declarations: no schemas, Mongo connection,
// provider modules or scheduled worker are imported or executed by these tests.
async function pureInsightSource() {
 const calendar=await readFile(new URL('../../../dimabot/src/utils/dashboard_activity.ts',import.meta.url),'utf8');
 const insights=await readFile(new URL('../../../dimabot/src/utils/dashboard_insights.ts',import.meta.url),'utf8');
 const extract=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,'pure source boundaries must remain explicit');return source.slice(a,b);};
 const ts=extract(calendar,'export const dashboardDayStart','export async function queueDashboardActivity')+'\n'+extract(insights,'const HOUR =','export async function queueDashboardInsights');
 const js=stripTypeScriptTypes(ts,{mode:'strip'});assert.doesNotMatch(js,/\bimport\s/);
 return import('data:text/javascript,'+encodeURIComponent(js));
}
test('real pure TS source reproduces old floating boundary and validates exact80%/1ms-below construction',async()=>{
 const source=await pureInsightSource(),hour=3600000,day=86400000,now=new Date('2026-10-21T12:00:00Z');
 const build=(duration,offsets)=>{
  const sessions=[],snapshots=[];
  for(let i=0;i<3;i++){
   const at=new Date(Date.UTC(2026,9,1)+i*7*day),s={_id:`pure-${i}`,started_at:at,ended_at:new Date(+at+duration),status:'offline',follows:4};sessions.push(s);
   for(const offset of offsets)snapshots.push({session_id:s._id,captured_at:new Date(+at+offset),viewers:20,game_name:'Only game'});
  }
  const intervals=source.insightIntervals(sessions,snapshots);
  for(const s of sessions)source.assignInsightFollow(intervals,new Date(+s.started_at+offsets[0]));
  const totalHours=sessions.reduce((sum,s)=>sum+(+s.ended_at-+s.started_at)/hour,0),sampledHours=intervals.reduce((sum,row)=>sum+(row.to-row.from)/hour,0);
  return {intervals,totalHours,sampledHours,ratio:sampledHours/totalHours,report:source.calculateInsights(sessions,intervals,[],30,false,now)};
 };
 const old=build(hour,Array.from({length:10},(_,i)=>12*60000+i*5*60000));
 assert.equal(old.sampledHours,2.4);assert.equal(old.ratio,.7999999999999999);assert.equal(old.report.weekdays.find(row=>row.streams).eligible,false);assert.equal(old.report.weekdays.find(row=>row.streams).coverage,.8);
 const exact=build(coverageSessionMs,coverageSnapshotOffsets()),below=build(coverageSessionMs,coverageSnapshotOffsets(1));
 assert.equal(exact.totalHours,3.75);assert.equal(exact.sampledHours,3);assert.equal(exact.ratio,.8);assert.equal(exact.intervals.length,24);assert(exact.intervals.every(row=>row.to-row.from===450000));
 assert.equal(below.intervals.reduce((sum,row)=>sum+row.to-row.from,0),3*hour-3,'one millisecond less observed per session');assert(below.ratio<.8);
 for(const [result,eligible]of [[exact,true],[below,false]]){
  const weekday=result.report.weekdays.find(row=>row.streams);assert.equal(weekday.streams,3);assert.equal(weekday.eligible,eligible);assert.equal(weekday.coverage,.8);assert(weekday.follows>0);
  assert.equal(result.report.games.length,1);assert.equal(result.report.games[0].eligible,true);assert.equal(result.report.games[0].follows,3);assert.equal(result.report.bestDay,null);assert.equal(result.report.bestGrowthGame,null);
 }
});
