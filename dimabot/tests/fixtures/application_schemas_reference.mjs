#!/usr/bin/env node
// Actual schema modules and an independent disconnected Mongoose instance.
// No connection, database, environment, or application module is reachable.
// Run in an isolated Node test container, not on the production host:
// node tests/fixtures/application_schemas_reference.mjs [--check]
// node tests/fixtures/application_schemas_reference.mjs --benchmark /artifacts/application-schemas-ts.json
// The measured benchmark child loads compiled modules + Mongoose only; the
// TypeScript compiler remains exclusively in the unmeasured parent process.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url);
const mongoose=require('mongoose');
const fixedNow=1_900_000_000_000;
const rootId='507f1f77bcf86cd799439011';
const secondId='507f1f77bcf86cd799439012';
const files=['users','accounts','admin','app_config','channel_config','oauth_client','oauth_grant','oauth_refresh_token','oauth_session','credit_gift','credit_transaction'];
const outputUrl=new URL('application_schemas_cases.json',import.meta.url);
class FixtureDate extends Date {constructor(...args){super(...(args.length?args:[fixedNow]));}static now(){return fixedNow;}}
Object.defineProperty(FixtureDate,'name',{value:'Date'});
function loadModels(compiled){
  const instance=new mongoose.Mongoose();instance.now=()=>new Date(fixedNow);
  const models={};
  for(const [name,code]of Object.entries(compiled)){
    const exports={};
    const injected={Schema:instance.Schema,model:instance.model.bind(instance),Types:instance.Types};
    const localRequire=id=>{assert.equal(id,'mongoose');return injected;};
    new vm.Script(`(function(exports,require,Date){${code}\n})`,{filename:name+'.schema.ts'}).runInThisContext()(exports,localRequire,FixtureDate);
    models[name]=Object.values(exports).find(value=>typeof value==='function'&&value.schema);
    assert.ok(models[name],name);
  }
  return models;
}
function normalize(value,input){
  if(value instanceof Date)return {$date:value.getTime()};
  if(value?._bsontype==='ObjectId')return {$oid:input===undefined?'generated':value.toHexString()};
  if(Array.isArray(value))return value.map((child,index)=>normalize(child,input?.[index]));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key],input?.[key])]));
  return value;
}
function errors(error){return error?Object.keys(error.errors).sort().map(path=>({path,kind:error.errors[path].name==='CastError'?'cast':error.errors[path].kind})):[];}
function construct(model,input){const document=new model(input);const error=document.validateSync();return error?{errors:errors(error)}:{document:normalize(document.toObject({minimize:true,depopulate:true}),input)};}
function benchmark(compiled,workloads,path){
  const models=loadModels(compiled),runs=[];
  for(const workload of workloads){const model=models[workload.schema];const input=workload.input;
    for(const operation of ['constructValidate','constructValidateSerialize']){
      const fn=()=>{const document=new model(input);const error=document.validateSync();if(error)throw error;return operation==='constructValidateSerialize'?JSON.stringify(normalize(document.toObject({minimize:true,depopulate:true}),input)).length:Object.keys(document._doc).length;};
      for(let i=0;i<100;i++)fn();const samples=[];let sink=0;
      for(let sample=0;sample<7;sample++){const start=performance.now();for(let i=0;i<workload.iterations;i++)sink+=fn();samples.push((performance.now()-start)*1e6/workload.iterations);}
      const sorted=[...samples].sort((a,b)=>a-b);runs.push({workload:workload.name,operation,iterations:workload.iterations,samplesNsPerOp:samples,medianNsPerOp:sorted[3],sink});
    }
  }
  writeFileSync(path,JSON.stringify({implementation:'typescript-schema-mongoose-clean-worker',runtime:process.version,mongoose:mongoose.version,compilerLoaded:false,samples:7,runs},null,2)+'\n');
}
const args=process.argv.slice(2);
if(args[0]==='--benchmark-worker'){
  const payload=JSON.parse(readFileSync(args[1],'utf8'));benchmark(payload.compiled,payload.workloads,args[2]);process.exit(0);
}
const ts=require('typescript');
const sources={},compiled={};
for(const name of files){const text=readFileSync(new URL(`../../src/schemas/${name}.schema.ts`,import.meta.url),'utf8');sources[name]=createHash('sha256').update(text).digest('hex');compiled[name]=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;}
const models=loadModels(compiled);
const cases=[];
function add(schema,input,operation='construct'){cases.push({schema,operation,input,expected:construct(models[schema],input)});}
for(const schema of files){add(schema,{_id:rootId});add(schema,{_id:rootId,unknown:'discarded'});}
for(const input of [
  {accounts:[{id:'42',name:'cdom201',_id:secondId}]},
  {accounts:[{id:'42'}],name:42,email:true,token_balance:'12.5'},
  {accounts:null,language:null,plan_tier:null,token_balance:null},
  {accounts:[{type:'invalid',actived:'maybe'}],language:'fr',tts_default_provider:'other',plan_tier:'diamond'},
  {accounts:[{actived:'no',chat_enabled:'1',has_permissions:0,up_to_date_permissions:'yes',access_token_expires_at:'2000'}]},
  {polar_credit_snapshot:{occurredAt:'2030-01-01T00:00:00.000Z',eventKey:'e',meters:[{meter_id:'m',balance:4}]}},
  {polar_credit_snapshot:{}},
  {free_credit_reset:{periodStart:'2030-01-01T00:00:00Z',periodEnd:'2030-02-01',status:'pending',credits:5,externalId:'fixture',updatedAt:1900000000000}},
  {free_credit_reset:{status:'bad',credits:-1,externalId:''}},
  {applied_credit_transaction_ids:[secondId],referrerId:secondId,refreshed_at:'2030-01-01'},
  {referrerId:'invalid',token_balance:'NaN',plan_tier_until:'nonsense'},
])add('users',{_id:rootId,...input});
for(const input of [{user_token:{iv:'a',content:'b',extra:'discarded'},createdAt:'2030-01-01'},{user_token:null,user_type:null,user_id:123},{user_refresh_token:{},user_token:{}},{createdAt:'invalid'}])add('accounts',{_id:rootId,...input});
for(const input of [{role:'creator',actived:'false',permissions:'read'},{role:'bad',permissions:[1,true]},{role:null,updatedAt:'2030-01-01',createdAt:0}])add('admin',{_id:rootId,...input});
for(const input of [{name:'twitch',access_token:{iv:'x',content:'y'}},{access_token:null,refreshed_at:null}])add('app_config',{_id:rootId,...input});
for(const input of [{channel_id:secondId,channel:'cdom201',commands:['a',{value:3}],date:{day:3,month:10,year:2026}},{commands:'single',date:{}},{channel_id:'invalid',createdAt:'invalid'}])add('channel_config',{_id:rootId,...input});
const client={_id:rootId,client_id:'fixture',name:'fixture app',type:'public',redirect_uris:['http://127.0.0.1/callback'],allowed_scopes:['profile:read']};
add('oauth_client',client);add('oauth_client',{...client,redirect_uris:undefined,allowed_scopes:undefined});add('oauth_client',{...client,type:'private',enabled:'maybe',name:''});add('oauth_client',{...client,redirect_uris:null,allowed_scopes:null});
const grant={_id:rootId,user_id:secondId,client_id:'fixture',channel_id:'42',scopes:[]};add('oauth_grant',grant);add('oauth_grant',{...grant,user_id:'invalid',scopes:'profile:read'});
const refresh={_id:rootId,token_hash:'fixture-hash',session_id:secondId,expires_at:'2030-01-01'};add('oauth_refresh_token',refresh);add('oauth_refresh_token',{...refresh,used_at:0,expires_at:'invalid'});
const session={_id:rootId,grant_id:secondId,user_id:secondId,client_id:'fixture',channel_id:'42',device_name:'desktop',scopes:[],current_refresh_hash:'fixture-hash',last_used_at:'2030-01-01',idle_expires_at:'2030-01-02',expires_at:'2030-01-03'};
add('oauth_session',session);add('oauth_session',{...session,device_name:'🎮'.repeat(40)});add('oauth_session',{...session,device_name:'🎮'.repeat(41)});add('oauth_session',{...session,current_refresh_hash:''});
const gift={_id:'buyer-request',buyerId:rootId,recipientId:secondId,buyerLogin:'buyer',recipientLogin:'cdom201',recipientName:'Viewer',recipientChannelId:'42',productId:'p',fulfillmentProductId:'f',benefitId:'b',credits:100,priceAmount:500,priceCurrency:'usd',status:'awaiting_payment',noRefundsAcknowledgedAt:'2030-01-01',nextAttemptAt:'2030-01-01'};
add('credit_gift',gift);add('credit_gift',{...gift,status:'invalid',credits:'NaN'});add('credit_gift',{...gift,checkoutUrl:'https://fixture.invalid/pay',attempts:'2',announcementAttempts:null});
const transaction={_id:rootId,user:secondId,type:'manual_credit',amount:12.5};add('credit_transaction',transaction);add('credit_transaction',{...transaction,metadata:{subscriptionId:'sub',rewardTargetType:'bot',referredUserId:rootId},idempotencyKey:'key'});add('credit_transaction',{...transaction,type:'invalid',metadata:{rewardTargetType:'invalid'}});add('credit_transaction',{...transaction,metadata:null,balanceAfter:'5'});
// Save hooks/timestamps execute without calling any persistence method.
for(const [schema,input]of [['users',{_id:rootId}],['admin',{_id:rootId,updatedAt:0}],['app_config',{_id:rootId,refreshed_at:0}],['oauth_client',client],['credit_gift',gift],['credit_transaction',transaction]]){
  const document=new models[schema](input);await new Promise((resolve,reject)=>models[schema].schema.s.hooks.execPre('save',document,[],error=>error?reject(error):resolve()));
  // Version key is installed by save persistence, not pre-save middleware.
  document.__v=0;cases.push({schema,operation:'insert',input,expected:{document:normalize(document.toObject({minimize:true,depopulate:true}),input)}});
}
const definitions=Object.fromEntries(files.map(name=>{const model=models[name];const hidden=Object.entries(model.schema.paths).filter(([,path])=>path.options.select===false).map(([path])=>path).sort();return[name,{model:model.modelName,collection:model.collection.name,hidden,indexes:model.schema.indexes().map(([keys,options])=>({keys,unique:options.unique??false,sparse:options.sparse??false,ttl:options.expireAfterSeconds??null,partial:options.partialFilterExpression??null}))}];}));
const workloads=[1,24].map(count=>({name:count===1?'normal-user':'large-user',schema:'users',iterations:500,input:{_id:rootId,name:'fixture',email:'fixture@example.invalid',accounts:Array.from({length:count},(_,index)=>({_id:secondId,type:'twitch',id:String(index),name:'cdom201',email:'fixture@example.invalid',access_token:{iv:'fixture-iv',content:'fixture-content'},refresh_token:{iv:'fixture-iv',content:'fixture-content'},access_token_expires_at:2000000000}))}}));
const fixture={sources,fixedNow,definitions,cases,workloads};
if(args[0]==='--benchmark'){
  assert.equal(args.length,2);const directory=mkdtempSync(join(tmpdir(),'native-schema-benchmark-'));try{const payload=join(directory,'compiled.json');writeFileSync(payload,JSON.stringify({compiled,workloads}));const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--benchmark-worker',payload,args[1]],{stdio:'inherit'});assert.equal(child.status,0);}finally{rmSync(directory,{recursive:true,force:true});}
}else{assert.ok(args.length===0||args.length===1&&args[0]==='--check');const body=JSON.stringify(fixture,null,2)+'\n';if(args[0]==='--check')assert.equal(readFileSync(outputUrl,'utf8'),body);else writeFileSync(outputUrl,body);console.log(`Application schema oracle: ${files.length} schemas, ${cases.length} cases`);}
