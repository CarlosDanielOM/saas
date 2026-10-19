// Disposable provider mocks only. Changed webhook, projection and routes run unchanged.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
const directory='/tmp/saas-fixtures',originalFetch=globalThis.fetch;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const read=(name,fallback)=>fs.existsSync(`${directory}/${name}.json`)?JSON.parse(fs.readFileSync(`${directory}/${name}.json`,'utf8')):fallback;
const write=(name,value)=>fs.writeFileSync(`${directory}/${name}.json`,JSON.stringify(value));
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.hostname==='127.0.0.1')return originalFetch(input,options);
 if(url.hostname==='qdrant.test')return json({version:'1.18.0',status:'ok',time:0,result:url.pathname.endsWith('/exists')?{exists:true}:{collections:[]}});
 if(url.hostname==='api.twitch.tv') {
  if(url.pathname==='/helix/authorization/users') return json({data:[{user_id:url.searchParams.get('user_id'),scopes:read('scopes',['channel:read:polls','channel:read:predictions'])}]});
  if(url.pathname==='/helix/eventsub/subscriptions'){
   let remote=read('remote',[]);
   if(options.method==='DELETE'){remote=remote.filter(item=>item.id!==url.searchParams.get('id'));write('remote',remote);return new Response(null,{status:204});}
   if(options.method==='POST'){
    const body=JSON.parse(options.body);fs.appendFileSync(`${directory}/calls.jsonl`,JSON.stringify({type:body.type,authorization:new Headers(options.headers).get('authorization')})+'\n');
    if(read('failure',false))return json({error:'mock_failure'},500);
    if(remote.some(item=>item.type===body.type&&item.status==='enabled'))return json({error:'Conflict'},409);
    const subscription={...body,id:crypto.randomUUID(),status:read('pending',false)?'webhook_callback_verification_pending':'enabled',cost:0,created_at:new Date().toISOString()};
    remote.push(subscription);write('remote',remote);return json({data:[subscription]},202);
   }
   return json({data:remote,pagination:{},total:remote.length});
  }
  if(url.pathname==='/helix/polls'||url.pathname==='/helix/predictions')return json({data:read(url.pathname.endsWith('/polls')?'poll-recovery':'prediction-recovery',[])});
  if(url.pathname==='/helix/chat/messages')throw new Error('Overlay widgets must not send chat');
  return json({data:[],pagination:{},total:0});
 }
 throw new Error(`External request blocked in overlay interaction test: ${url.origin}${url.pathname}`);
};
const modules=new Map(),add=(path,source)=>modules.set(`file:///app/dist/${path}.js`,source);
// Boot fixtures replace unrelated provider integrations, preserving intended runtime entrypoints.
add('utils/databases/qdrant.database','export const getQdrantConnection=async()=>({});');

add('utils/opentelemetry_posthog','export default()=>({start:()=>{}});');
if(process.env.SAAS_INTERACTION_TARGET==='api')add('utils/qdrant/start_up.qdrant','export const QdrantStartUp=async()=>{};');
globalThis.__interactionSpawn=(...args)=>String(args[1][0]).endsWith('/domain_events.worker.js')?spawn(...args):null;
registerHooks({
 resolve(specifier,context,nextResolve){
  if(specifier==='node:child_process'&&context.parentURL?.endsWith('/workers/cron.index.js')){
   const source=`import {EventEmitter} from 'node:events';export const spawn=(...args)=>{const actual=globalThis.__interactionSpawn(...args);if(actual)return actual;const child=new EventEmitter();child.pid=0;child.kill=()=>true;return child;};`;
   return {url:`data:text/javascript,${encodeURIComponent(source)}`,shortCircuit:true};
  }
  const resolved=nextResolve(specifier,context),source=modules.get(resolved.url);
  return source?{url:`data:text/javascript,${encodeURIComponent(source)}`,shortCircuit:true}:resolved;
 },
 load(url,context,nextLoad){
  const result=nextLoad(url,context);
  if(url.endsWith('/domain_events/domain_event_consumers.js')) {
   // Run the real new consumer under the real domain supervisor, keeping unrelated consumers out of this test.
   return {...result,source:String(result.source).replace(/\];(?=\s*(?:\/\/#|$))/,"] .filter(definition => definition.consumer === 'overlay-interactions-v1');")};
  }
  return result;
 }
});
