'use strict';
// Run in the pinned Node 24.22.1 environment with the existing semantic
// loader's independent hash/environment pins. No database or network I/O.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const lib=require('./moderation_semantic_source.cjs'), advanced=require('./moderation_advanced_source.cjs');
lib.independent('DIMA_SEMANTIC_WORKER_READER_SHA256',__filename);
assert.equal(process.versions.node,'24.22.1');
const source='src/utils/moderation/semantic_worker.ts';
const expected='8c6161cace13a2be249b0a0005576ff522d45949eff6517426b26ebafbe62de1';
assert.equal(lib.sha(lib.read(source)),expected);
const ts=Module.createRequire(path.join(lib.root,'package.json'))('typescript');assert.equal(ts.version,'5.9.3');
const parsed=ts.createSourceFile(source,lib.read(source).toString(),ts.ScriptTarget.ES2022,true);assert.deepEqual(parsed.parseDiagnostics,[]);
const compiled=ts.transpileModule(lib.read(source).toString(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
const ids=new Set();
const base={_id:'decision-1',channelID:'channel-1',messageID:'message-1',username:'fixture',messageText:'target',ruleID:'custom',reviewSource:'rule',settingsVersion:1,rule:{id:'custom',semantic:{policy:'test',examples:[],thresholdPercent:85}},context:[],matches:[],state:'pending',deadline:new Date(lib.FIXED_MS+2000),createdAt:new Date(lib.FIXED_MS-1000)};
const valid={answers:{violation:{type:'noul',noul:.5}},usage:{cost:.01,input_tokens:1000000},id:'provider-id',model:'fixture-model',provider:'openrouter'};
async function run(id,conf={}){
 assert(!ids.has(id));ids.add(id);let now=lib.FIXED_MS;const calls=[];
 class Clock extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const decision=conf.empty?null:{...base,...conf.decision};
 const owner=Object.hasOwn(conf,'owner')?conf.owner:{plan_tier:'premium',polar_sh_customer_id:'customer-1'};
 const settings=Object.hasOwn(conf,'settings')?conf.settings:{settingsVersion:1,enabled:true,rules:[{id:'custom',enabled:true}]};
 const record=(name,...args)=>calls.push([name,...args]);
 const fail=name=>{if(conf.fail===name)throw Error(`fixture ${name}`);};
 const decisionModel={
  findOneAndUpdate(...a){record('claim',...a);return {lean:async()=>{fail('claim');return decision;}};},
  async updateOne(...a){record('updateOne',...a);fail('updateOne');return {modifiedCount:conf.late?0:1};},
  async updateMany(...a){record('updateMany',...a);fail('updateMany');return {modifiedCount:0};},
  find(...a){record('find',...a);return {sort(...a){record('sort',...a);return this;},limit(...a){record('limit',...a);return this;},async lean(){fail('find');return conf.charges||[];}};}
 };
 const users={findOne(...a){record('owner',...a);return {select(...a){record('select',...a);return this;},async lean(){fail('owner');return owner;}};}};
 const settingsModel={findOne(...a){record('settings',...a);return {async lean(){fail('settings');return settings;}};}};
 const actual=lib.realm({hooks:{now:()=>now,env:{OPENROUTER_API_KEY:'fixture-key'},fetch:async(...a)=>{record('fetch',a[0],{...a[1],signal:'AbortSignal'});fail('fetch');if(conf.advance)now+=conf.advance;return {ok:!conf.httpFailure,status:conf.httpFailure||200,json:async()=>conf.response||valid};}}});
 const mod=new Module(path.join(lib.root,source),module);mod.filename=path.join(lib.root,source);
 mod.require=name=>{
  switch(name){
   case 'fixture:runtime':return {Date:Clock,AbortSignal:{timeout(ms){record('signalTimeout',ms);return AbortSignal.timeout(ms);}}};
   case '../../schemas/users.schema.js':return users;
   case '../../schemas/moderation_decision.schema.js':return {ModerationDecision:decisionModel};
   case '../../schemas/channel_moderation_settings.schema.js':return {ChannelModerationSettingsSchema:settingsModel};
   case '../billing.js':return {isAiCreditsExhausted:async(...a)=>{record('exhausted',...a);fail('exhausted');return !!conf.exhausted;},getAiCredits:async(...a)=>{record('credits',a[0],a[1],{requireVerified:a[2].requireVerified,signal:a[2].signal.constructor.name});fail('credits');return conf.credits||{available:true,status:'available',balance:100};}};
   case '../polarsh.js':return {ingestPolarSHEvent:async(...a)=>{record('ingest',...a);fail('ingest');return {error:!!conf.chargeError};}};
   case './advanced.js':return advanced.realm().api;
   case './spam_categories.js':return actual.categories;
   case './semantic.js':return actual.api;
   case './spam.js':return actual.spam;
   default:throw Error(`unexpected import ${name}`);
  }
 };
 mod._compile("const {Date,AbortSignal}=require('fixture:runtime');\n"+compiled.outputText,mod.filename);
 const operation=conf.maintenance?'maintainSemanticDecisions':'processNextSemanticDecision';
 const outcome=await lib.captureAsync(()=>mod.exports[operation]());
 return {id,operation,config:lib.encode(conf),outcome,calls:lib.encode(calls)};
}
(async()=>{
 const spam={ruleID:'builtin-spam-protection',reviewSource:'first_message',rule:{id:'builtin-spam-protection',semantic:{policy:'test',examples:[],thresholdPercent:85}}};
 const charges=Array.from({length:10},(_,i)=>({...base,_id:`charge-${i}`,charge:{status:'pending',customerID:'customer-1',externalID:`moderation:charge-${i}`,billableCostUSD:.042},inputTokens:1000000,model:'fixture-model'}));
 const matrix=[['empty',{empty:true}],['policy-version',{settings:{settingsVersion:2}}],['plan-free',{owner:{plan_tier:'free'}}],['plan-pro',{owner:{plan_tier:'pro',polar_sh_customer_id:'customer-1'}}],['plan-no-customer',{owner:{plan_tier:'premium'}}],['plan-case-mismatch',{owner:{plan_tier:'Premium',polar_sh_customer_id:'customer-1'}}],['missing-owner',{owner:null}],['paid-uncertain',{}],['paid-exhausted',{exhausted:true}],['paid-credit-error',{fail:'credits'}],['paid-exhaustion-error',{fail:'exhausted'}],['paid-unavailable',{credits:{available:false,status:'unavailable',balance:0}}],['paid-no-balance',{credits:{available:true,status:'available',balance:0}}],['paid-negative-balance',{credits:{available:true,status:'available',balance:-1}}],['paid-exhausted-status',{credits:{available:false,status:'exhausted',balance:0}}],['spam-free',{decision:spam,owner:{plan_tier:'free'},settings:{settingsVersion:1}}],['spam-disabled',{decision:spam,settings:{settingsVersion:1,spamProtection:{enabled:false}}}],['spam-empty-categories',{decision:spam,settings:{settingsVersion:1,spamProtection:{categories:[]}}}],['spam-continuous-off',{decision:{...spam,reviewSource:'spam_continuous'},settings:{settingsVersion:1,spamProtection:{reviewAllMessages:false}}}],['spam-paid',{decision:spam,settings:{settingsVersion:1}}],['spam-paid-exhausted',{decision:spam,settings:{settingsVersion:1},exhausted:true}],['provider-429',{httpFailure:429}],['provider-500',{httpFailure:500}],['provider-invalid',{response:{answers:{},usage:{cost:0,input_tokens:1}}}],['provider-allow',{response:{...valid,answers:{violation:{type:'noul',noul:.05}}}}],['provider-violation',{response:{...valid,answers:{violation:{type:'noul',noul:.95}}}}],['provider-error',{fail:'fetch'}],['late',{late:true,advance:3000}],['owner-error',{fail:'owner'}],['settings-error',{fail:'settings'}],['result-update-error',{fail:'updateOne'}],['missing-rule',{decision:{rule:null}}],['claim-error',{fail:'claim'}],['maintenance-empty',{maintenance:true}],['maintenance-ten',{maintenance:true,charges}],['maintenance-charge-error',{maintenance:true,charges,chargeError:true}],['maintenance-blank-customer',{maintenance:true,charges:[{...charges[0],charge:{...charges[0].charge,customerID:''}}],chargeError:true}],['maintenance-ingest-throw',{maintenance:true,charges,fail:'ingest'}],['maintenance-update-fail',{maintenance:true,charges,fail:'updateOne'}],['maintenance-expire-fail',{maintenance:true,fail:'updateMany'}],['maintenance-query-fail',{maintenance:true,fail:'find'}]];
 const records=[];for(const [id,conf] of matrix)records.push(await run(id,conf));
 const out={metadata:{sourceProvenance:lib.sourceProvenance,source,sourceSha256:expected,compiledSha256:lib.sha(compiled.outputText),readerSha256:lib.sha(fs.readFileSync(__filename)),nodeSha256:lib.nodeSha,versions:{node:process.versions.node,typescript:ts.version},pins:lib.pins,recordCount:records.length,boundary:'Actual worker and semantic/spam exports; scripted Mongo, credit, provider fetch and cache accounting. No I/O.'},records};
 const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&extra.length===0);const target=path.join(lib.external(dir),'moderation-semantic-worker-reference.json'),bytes=JSON.stringify(out,null,2)+'\n';if(mode==='--write')fs.writeFileSync(target,bytes,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),bytes);console.log(JSON.stringify({mode,sha256:lib.sha(bytes),records:records.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
