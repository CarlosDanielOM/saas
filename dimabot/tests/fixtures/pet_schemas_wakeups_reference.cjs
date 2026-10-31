'use strict';
// Actual TypeScript schemas and wakeup implementation, disconnected Mongoose and fake Redis.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=fs.realpathSync(process.env.DIMA_SCHEMA_SOURCE_ROOT); assert.equal(root,process.env.DIMA_SCHEMA_SOURCE_ROOT);
const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&path.isAbsolute(dir)&&!extra.length);assert.equal(fs.realpathSync(dir),dir);assert(dir!==root&&!dir.startsWith(root+path.sep));
const name='pet-schemas-wakeups-reference.json';assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]);
const req=createRequire(path.join(root,'package.json')),ts=req('typescript'),mongoose=req('mongoose');assert.equal(ts.version,'5.9.3');assert.equal(mongoose.version,'8.24.2');assert.equal(sha(fs.readFileSync(process.execPath)),'569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
const instance=new mongoose.Mongoose();instance.set('autoCreate',false);instance.set('autoIndex',false);
function load(file,pin,modules){const source=fs.readFileSync(path.join(root,file));assert.equal(sha(source),pin);const out=ts.transpileModule(source.toString(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(out.diagnostics,[]);const exports={};new vm.Script(`(function(exports,require){${out.outputText}\n})`,{filename:file}).runInThisContext()(exports,id=>{assert(Object.hasOwn(modules,id),id);return modules[id]});return exports;}
const m={Schema:instance.Schema,model:instance.model.bind(instance),Types:instance.Types};
const runtime=load('src/schemas/pet_runtime.schema.ts','64b14ec7a0173bf6fc77d41b3bf302c834e44552ce534ded62dc964699cf2fc3',{mongoose:m});
const settings=load('src/schemas/pet_settings.schema.ts','e6555ffc1d1972783fa4e2d3e645b5ac71cef8ec8593c0bfb4f593210e311693',{mongoose:m});
const models={request:runtime.PetRequest,runtime:runtime.PetRuntime,settings:settings.PetSettingsSchema};
const base={userId:'507f1f77bcf86cd799439011',revision:'1',updatedAt:0,settings:{enabled:true,name:'Pet',tts:{enabled:true,provider:'piper',language:'en',voice:'v'},personality:{source:'custom'},behavior:{respondToChat:true,respondToEvents:false,cooldownSeconds:0,maxReplyLength:30}}};
const clone=x=>JSON.parse(JSON.stringify(x));
const cases=[
 ['request','defaults',{_id:'r',ownerId:42,admitted:'true',status:'queued'}],
 ['request','nested-cast',{_id:'r',ownerId:'u',origin:{kind:1,id:2,occurredAt:3,extra:1},actor:{userId:4},audio:{path:2,mimeType:'anything',durationMs:'42',extra:1},startBefore:0,unknown:1}],
 ['request','null',{_id:'r',ownerId:'u',origin:null,audio:null,admitted:null,status:null}],
 ['request','required',{_id:'r'}], ['request','enum',{_id:'r',ownerId:'u',status:'bogus'}], ['request','number-cast-error',{_id:'r',ownerId:'u',audio:{durationMs:'bad'}}], ['request','lane-enum',{_id:'r',ownerId:'u',lane:'bad'}],
 ['runtime','defaults',{_id:'u'}], ['runtime','nested',{_id:'u',generation:'2',lease:{leaseId:42,expiresAt:0},ttsReservation:{speechId:12,expiresAt:1000},overlayToken:{iv:7,content:'x',extra:3}}], ['runtime','null',{_id:'u',lease:null,notBefore:null,overlayToken:null,generation:null}], ['runtime','date-cast-error',{_id:'u',lease:{expiresAt:'not a date'}}],
 ['settings','defaults',base], ['settings','nested-casts',(()=>{const x=clone(base);x.settings.sources={independent:'false',readTts:'true'};x.settings.rules=[1,true];x.settings.behavior.queueSize='3';x.settings.appearance={kind:'vts',idleAssetId:42};return x})()],
 ['settings','null-settings',{...base,settings:null}], ['settings','null-optional',(()=>{const x=clone(base);x.settings.appearance=null;x.settings.ttsAudio=null;x.settings.rules=null;return x})()],
 ['settings','required',(()=>{const x=clone(base);delete x.settings.tts.voice;return x})()], ['settings','enum',(()=>{const x=clone(base);x.settings.tts.provider='invalid';return x})()], ['settings','range',(()=>{const x=clone(base);x.settings.behavior.queueSize=11;return x})()], ['settings','utf16-length',(()=>{const x=clone(base);x.settings.name='😀'.repeat(21);return x})()], ['settings','objectid-error',{...base,userId:'bad'}], ['settings','boolean-error',(()=>{const x=clone(base);x.settings.enabled='invalid';return x})()]
];
function normalize(v){if(v instanceof Date)return {$date:v.getTime()};if(v instanceof instance.Types.ObjectId)return {$oid:v.toHexString()};if(Array.isArray(v))return v.map(normalize);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)]));return v;}
const rows=cases.map(([model,label,input])=>{const value=new models[model](input),error=value.validateSync();let output;if(error)output={valid:false};else {const obj=value.toObject({minimize:true,versionKey:false});if(model==='settings')delete obj._id;output={valid:true,document:normalize(obj)};}return {model,label,input,expected:output};});
const indexes=Object.fromEntries(Object.entries(models).map(([key,model])=>[key,model.schema.indexes().map(([keys,options])=>({keys,unique:!!options.unique,ttl:options.expireAfterSeconds??null,partial:options.partialFilterExpression??null}))]));
const turn=()=>new Promise(resolve=>setImmediate(resolve));const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Fake extends EventEmitter {constructor(){super();this.connects=0;this.publications=[];this.subscriptions=[];this.destroys=0;this.connecting=async()=>{};this.publishing=async()=>{};this.subscribing=async()=>{};}connect(){this.connects++;return this.connecting()}publish(c,m){this.publications.push([c,m]);return this.publishing()}subscribe(c,fn){this.subscriptions.push(c);this.hint=fn;return this.subscribing()}destroy(){this.destroys++}unref(){}}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
async function wakeupCases(){
 const previous=process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
 const api=load('src/utils/domain_event_wakeups.ts','cf0a46fdcf4588ce0e9fbff60f4fbcbd8b90124dddd12ef647848f4b5b0d4fb4',{redis:{createClient:()=>{throw Error('unexpected default client')}}});
 assert.equal(sha(fs.readFileSync(path.join(root,'src/utils/domain_event_wakeups.test.ts'))),'a0ae76c7c3007520c5d0002c7d59b0f6909eb465f5f5a39404d8de1155fea6c8');
 try {
  const gate=deferred(),sent=deferred(),clients=[];const p=new api.DomainEventWakeups({timeoutMs:1000,retryMs:100,idleMs:40,createClient:()=>{const c=new Fake();c.connecting=()=>gate.promise;c.publishing=()=>sent.promise;clients.push(c);return c}});
  for(let i=0;i<1000;i++)p.publish();const cold=clients.length;await turn();const connecting=clients.length;for(let i=0;i<1000;i++)p.publish();gate.resolve();await turn();for(let i=0;i<1000;i++)p.publish();await turn();const inFlight=clients[0].publications.length;sent.resolve();await turn();await turn();const coalesced=clients[0].publications.length;await delay(80);const idleDestroyed=clients[0].destroys;p.stop();
  const stuck=[],hang=deferred();const q=new api.DomainEventWakeups({timeoutMs:30,retryMs:90,createClient:()=>{const c=new Fake();c.connecting=()=>hang.promise;stuck.push(c);return c}});q.publish();await turn();await delay(50);for(let i=0;i<100;i++)q.publish();await turn();const cooldownClients=stuck.length,timeoutDestroyed=stuck[0].destroys;hang.resolve();await turn();const latePublications=stuck[0].publications.length;q.stop();
  let wakes=0;const subs=[];const s=new api.DomainEventWakeups({onWake:()=>wakes++,timeoutMs:500,retryMs:30,createClient:()=>{const c=new Fake();subs.push(c);return c}});s.start();await turn();subs[0].emit('error',Error('lost'));await delay(55);await turn();subs[0].hint();subs[1].hint();const afterReconnect=wakes;s.stop();subs[1].hint();await delay(40);const afterStop=wakes;
  return {cold,connecting,inFlight,coalesced,idleDestroyed,cooldownClients,timeoutDestroyed,latePublications,subscriberClients:subs.length,afterReconnect,afterStop,channel:clients[0].publications[0]};
 } finally {if(previous===undefined)delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;else process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED=previous;}
}
(async()=>{const wakeups=await wakeupCases();const output=JSON.stringify({cases:rows,indexes,wakeups},null,2)+'\n',target=path.join(dir,name);if(mode==='--write')fs.writeFileSync(target,output,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),output);console.log(`${name} sha256=${sha(output)}`)})().catch(e=>{console.error(e);process.exitCode=1});
