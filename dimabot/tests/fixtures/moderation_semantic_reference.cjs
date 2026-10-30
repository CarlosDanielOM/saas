'use strict';
// Expected values come only from complete transpiled application exports.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const lib=require('./moderation_semantic_source.cjs');lib.independent('DIMA_SEMANTIC_READER_SHA256',__filename);
const {encode,decode,capture,captureAsync}=lib;
const fixture=lib.realm(),api=fixture.api,ALL=[...fixture.categories.SPAM_CATEGORIES],SPAM=fixture.spam.SPAM_RULE_ID;
const ids=new Set();function unique(id){assert(!ids.has(id),`duplicate fixture ID ${id}`);ids.add(id);return id;}
function adjacent(x,up){if(Number.isNaN(x))return x;if(x===0)return up?Number.MIN_VALUE:-Number.MIN_VALUE;const b=Buffer.alloc(8);b.writeDoubleBE(x);let bits=b.readBigUInt64BE();bits+=(x>0)===up?1n:-1n;b.writeBigUInt64BE(bits);return b.readDoubleBE();}
function valid(score=.9){return {answers:{violation:{type:'noul',noul:score}},usage:{cost:.001,input_tokens:10},model:'provider-model',provider:'fixture-provider',id:'request-id'};}
function spamRaw(categories,score=.9,unsafe=.95){const r=valid(score);r.answers=Object.fromEntries([...categories.map(c=>[c,{type:'noul',noul:score}]),['unsafe',{type:'noul',noul:unsafe}]]);return r;}
function decision(spam=false,categories=ALL){return {rule:{id:spam?SPAM:'custom-rule',semantic:{policy:'No unwanted behavior; quoted speech is allowed.',examples:[],...(spam?{categories}:{}),thresholdPercent:85}},messageText:'target😀\ud800',username:'author\udc00',context:[{message:'share channel',isBroadcaster:true,extra:'preserve'}],matches:[{start:0,end:6,text:'target'}],channelID:'channel-fixture',deadline:new Date(lib.FIXED_MS+2000),ignored:{extra:true}};}
function matrix(){
 const cases=[];const add=(name,id,args,boundary='declared')=>cases.push({id:unique(id),export:name,boundary,args:encode(args),result:capture(()=>api[name](...args))});
 const prices=[NaN,Infinity,-Infinity,-0,0,Number.MIN_VALUE,-Number.MIN_VALUE,1,-1,1.5,Number.MAX_SAFE_INTEGER,2**53,Number.MAX_VALUE,-Number.MAX_VALUE];
 // Neighbors around both Math.round's 1e-8 USD-cent boundary and credit ceil.
 for(const n of [0,1,2,10,1000,1000000])for(const x of [(n+.5)/420,(n+.5)*1e6/(.042*100*1e8),n*1e6/(.042*100*1000)])prices.push(adjacent(x,false),x,adjacent(x,true));
 prices.forEach((v,i)=>add('semanticPrice',`price-${i}`,[v]));
 for(const [i,tier] of [undefined,null,false,true,0,1,'','free','premium','pro','Premium','PREMIUM',' premium ',[],{},['premium']].entries())for(const credit of [false,true])add('moderationModelForAccount',`model-${i}-${credit}`,[tier,credit]);
 for(const [i,status] of ['timeout','invalid_context','unavailable','rate_limited','custom😀\ud800',''].entries())for(const [j,model] of [undefined,'','custom\udc00'].entries())add('fallbackResult',`fallback-${i}-${j}`,[status,model]);
 const thresholds=[undefined,0,-0,15,85,100,adjacent(85,false),adjacent(85,true),-1,101,NaN,Infinity,-Infinity,null,'85',false];
 const scores=[-0,0,Number.MIN_VALUE,.15,adjacent(.15,false),adjacent(.15,true),.5,.85,adjacent(.85,false),adjacent(.85,true),1,-1,adjacent(1,true),NaN,Infinity,null,'0.9',undefined];
 thresholds.forEach((threshold,i)=>scores.forEach((score,j)=>add('parseSemanticResponse',`semantic-threshold-${i}-${j}`,[{...valid(),answers:{violation:{type:'noul',noul:score}}},threshold],typeof threshold==='number'||threshold===undefined?'declared':'unknown-threshold-type')));
 for(const [i,raw] of [undefined,null,false,true,0,1,'',[],{}, {answers:null},{answers:[]},{answers:{violation:null}},{answers:{violation:[]}},...['bool','NOUL',null,1,undefined].map(type=>({...valid(),answers:{violation:{type,noul:.9}}}))].entries())for(const threshold of [undefined,NaN])add('parseSemanticResponse',`semantic-raw-${i}-${String(threshold)}`,[raw,threshold]);
 const tokens=[-0,0,1,1.5,-1,Number.MAX_SAFE_INTEGER,2**53,adjacent(2**53,false),adjacent(2**53,true),NaN,Infinity,null,'1',undefined];
 const costs=[-0,0,Number.MIN_VALUE,-1,NaN,Infinity,-Infinity,null,'0',undefined];
 tokens.forEach((input_tokens,i)=>costs.forEach((cost,j)=>add('parseSemanticResponse',`semantic-usage-${i}-${j}`,[{...valid(),usage:{input_tokens,cost}}])));
 for(const [i,value] of [undefined,null,0,[],{},'', '😀'.repeat(110), 'x'.repeat(149)+'😀suffix','x'.repeat(99)+'😀suffix','x'.repeat(199)+'😀suffix','\ud800','\udc00'].entries())for(const field of ['model','provider','id'])add('parseSemanticResponse',`semantic-text-${field}-${i}`,[{...valid(),[field]:value}]);
 for(let mask=0;mask<1<<ALL.length;mask++){
  const cats=ALL.filter((_,i)=>mask&(1<<i));
  for(const [j,[score,unsafe]] of [[.9,.95],[.9,.05],[.5,.5],[.85,.85],[0,1],[1,0],[.1,.95]].entries())add('parseSpamResponse',`spam-subset-${mask}-${j}`,[spamRaw(cats,score,unsafe),cats]);
  for(const invited of [false,true]){const d=decision(true,cats);d.rule.semantic.broadcasterInvitation=invited;add('semanticRequest',`request-subset-${mask}-${invited}`,[d]);}
 }
 for(const [i,cats] of [['spam','spam'],['insults','spam','insults'],[]].entries())thresholds.forEach((t,j)=>add('parseSpamResponse',`spam-duplicate-threshold-${i}-${j}`,[spamRaw(cats),cats,t],typeof t==='number'||t===undefined?'declared':'unknown-threshold-type'));
 for(const [i,value] of scores.entries())for(const field of ['spam','unsafe']){const r=spamRaw(['spam']);r.answers[field].noul=value;add('parseSpamResponse',`spam-score-${field}-${i}`,[r,['spam']]);}
 for(const [i,raw] of [undefined,null,false,0,[],{},valid(),{...spamRaw(ALL),usage:null}].entries())for(const t of [NaN,undefined])add('parseSpamResponse',`spam-invalid-order-${i}-${String(t)}`,[raw,ALL,t]);
 for(const category of ALL)for(const kind of ['missing','null','wrong-type']){const r=spamRaw(ALL);if(kind==='missing')delete r.answers[category];else r.answers[category]=kind==='null'?null:{type:'boolean',noul:.9};add('parseSpamResponse',`spam-answer-${category}-${kind}`,[r,ALL]);}
 // Unknown category strings are source evidence outside the declared SpamCategory enum.
 add('parseSpamResponse','unknown-category-parse',[spamRaw(['unknown']),['unknown']],'unknown-category-enum');add('semanticRequest','unknown-category-request',[decision(true,['unknown'])],'unknown-category-enum');
 for(const spam of [false,true])for(const [i,examples] of [[],[{message:'example😀',label:'violation'},{message:'quote\ud800',label:'allow'}],[{input:'one',output:'two'}]].entries())for(const [j,model] of [undefined,null,'','chosen-model'].entries()){const d=decision(spam);d.rule.semantic.examples=examples;add('semanticRequest',`request-examples-${spam}-${i}-${j}`,[d,model],i===2?'unknown-example-type':'declared');}
 for(const spam of [false,true])for(const field of ['context','matches'])for(const kind of ['absent','undefined','null','empty']){const d=decision(spam);if(kind==='absent')delete d[field];else d[field]=kind==='undefined'?undefined:kind==='null'?null:[];add('semanticRequest',`request-${spam}-${field}-${kind}`,[d],kind==='empty'?'declared':'unknown-decision-shape');}
 for(const [i,mutate] of [d=>delete d.rule.semantic,d=>d.rule.semantic=null,d=>delete d.rule.semantic.examples,d=>d.rule.semantic.examples=null,d=>delete d.rule,d=>d.rule=null].entries()){const d=decision();mutate(d);add('semanticRequest',`request-malformed-${i}`,[d],'unknown-decision-shape');}
 const explicitNull=decision(true);explicitNull.context=[null,{message:'last'}];add('semanticRequest','request-context-null-item',[explicitNull],'unknown-context-element-type');
 const sparse=decision(true);sparse.context=new Array(3);sparse.context[2]={message:'last'};add('semanticRequest','request-context-holes',[sparse],'sparse-context');
 return cases;
}
async function evaluations(kind='cjs'){
 const records=[];
 async function run(id,d,config={},model){
  if(kind==='cjs')unique(id);const calls=[],timeouts=[],clock=[];let now=lib.FIXED_MS;
  const hooks={env:Object.hasOwn(config,'key')?(config.key===undefined?{}:{OPENROUTER_API_KEY:config.key}):{OPENROUTER_API_KEY:'fixture-key'},now(){clock.push(now);return now;},AbortSignal:{timeout(value){timeouts.push(encode(value));return AbortSignal.timeout(value);}},fetch:async(...args)=>{
   const [url,options]=args;calls.push({url:encode(url),argc:args.length,options:encode({...options,signal:undefined}),signal:{constructor:options.signal.constructor.name,aborted:options.signal.aborted,hasReason:options.signal.reason!==undefined}});
   if(config.advanceFetch!==undefined)now+=config.advanceFetch;
   if(config.throw){if(config.throw.plain)throw config.throw.value;const e=new Error(config.throw.message||'transport error');e.name=config.throw.name||'Error';throw e;}
   return {ok:(config.status??200)>=200&&(config.status??200)<300,status:config.status??200,json:async()=>{if(config.advanceJSON!==undefined)now+=config.advanceJSON;return JSON.parse(config.wireBody??JSON.stringify(valid()));}};
  }};
  const result=await captureAsync(()=>lib.realm({kind,hooks}).api.evaluateSemanticDecision(d,model));
  records.push({id,decision:encode(d),model:encode(model),config:encode(config),result,calls,timeouts,clock:encode(clock)});
 }
 await run('eval-success',decision());await run('eval-spam-missing-answers',decision(true));await run('eval-spam',decision(true),{wireBody:JSON.stringify(spamRaw(ALL))});await run('eval-spam-empty-categories',decision(true,[]),{wireBody:JSON.stringify(spamRaw([]))});
 for(const idValue of [undefined,null,'','request-id'])await run(`eval-provider-id-${String(idValue)}`,decision(),{wireBody:JSON.stringify({...valid(),id:idValue})},'explicit-model');
 for(const status of [429,400,401,500,204])await run(`eval-status-${status}`,decision(),{status,wireBody:status===204?'':undefined});
 for(const [i,wireBody] of ['', '{', 'null','[]','{}',JSON.stringify({...valid(),usage:{cost:0,input_tokens:2**53}})].entries())await run(`eval-json-${i}`,decision(),{wireBody});
 for(const [i,throwConfig] of [{name:'Error'},{name:'TimeoutError'},{plain:true,value:{name:'TimeoutError'}},{plain:true,value:'failure'}].entries())await run(`eval-throw-${i}`,decision(),{throw:throwConfig});
 await run('eval-error-after-deadline',decision(),{throw:{name:'Error'},advanceFetch:2000});
 await run('eval-error-wallclock-backwards',decision(),{throw:{name:'Error'},advanceFetch:-1000});
 await run('eval-error-forward-beforedeadline',decision(),{throw:{name:'Error'},advanceFetch:500});
 await run('eval-timeouterror-wallclock-backwards',decision(),{throw:{name:'TimeoutError'},advanceFetch:-1000});
 await run('eval-status-after-deadline',decision(),{status:503,advanceFetch:2001});
 await run('eval-json-after-deadline',decision(),{wireBody:'{',advanceJSON:2001});
 await run('eval-success-after-deadline',decision(),{advanceJSON:2001});
 for(const [i,channelID] of [undefined,null,'','  ',' channel ',1,{},'\ud800'].entries()){const d=decision();d.channelID=channelID;await run(`eval-channel-${i}`,d);}
 for(const [i,key] of [undefined,'',null,'0'].entries())await run(`eval-key-${i}`,decision(),{key});
 for(const [i,remaining] of [-1,0,1,2000,NaN,Infinity,.5,4294967296].entries()){const d=decision();d.deadline=new Date(lib.FIXED_MS+remaining);await run(`eval-deadline-${i}`,d);}
 // Date clips fractional milliseconds; use an ordinary getTime boundary proof
 // separately below for genuine fractional AbortSignal inputs.
 for(const [i,mutate] of [d=>delete d.rule.semantic,d=>d.rule.semantic=null,d=>delete d.rule,d=>d.deadline=null,d=>delete d.deadline,d=>d.context=null].entries()){const d=decision(i===5);mutate(d);await run(`eval-construction-${i}`,d,{key:undefined});}
 const bad=decision();bad.rule.semantic.examples=null;bad.deadline=new Date(lib.FIXED_MS-1);bad.channelID='';await run('eval-request-precedes-all-preflight',bad,{key:undefined});
 const expired=decision();expired.deadline=new Date(lib.FIXED_MS);expired.channelID='';await run('eval-deadline-precedes-channel-key',expired,{key:undefined});
 const invalidContext=decision();invalidContext.channelID='';await run('eval-channel-precedes-key',invalidContext,{key:undefined});
 for(const [i,threshold] of [null,0,100,-1,101,NaN].entries()){const d=decision();d.rule.semantic.thresholdPercent=threshold;await run(`eval-threshold-${i}`,d);}
 return records;
}
(async()=>{
 const cases=matrix(),vm=lib.realm({kind:'vm'});for(const c of cases)assert.deepEqual(capture(()=>vm.api[c.export](...decode(c.args))),c.result,c.id);
 const evaluate=await evaluations();assert.deepEqual(await evaluations('vm'),evaluate,'CJS/VM async export replay');
 // Real Node validates timeout before fetch. No permissive signal mock can hide it.
 const abortContract=[NaN,Infinity,-Infinity,-1,.5,4294967296].map((value,i)=>({id:unique(`abort-range-${i}`),input:encode(value),result:capture(()=>AbortSignal.timeout(value))}));
 for(const record of abortContract)assert.equal(record.result.ok,false);
 const abortNormal=[1,2000,2147483647,2147483648,4294967295].map((value,i)=>({id:unique(`abort-normal-${i}`),input:encode(value),result:capture(()=>{const signal=AbortSignal.timeout(value);return {constructor:signal.constructor.name,aborted:signal.aborted};})}));
 const abortOverflow=await new Promise((resolve,reject)=>{const signal=AbortSignal.timeout(2147483648);const guard=setTimeout(()=>reject(Error('real Node overflow signal did not abort')),1000);signal.addEventListener('abort',()=>{clearTimeout(guard);resolve({aborted:signal.aborted,reasonName:signal.reason.name,reasonCode:signal.reason.code});},{once:true});});
 assert.equal(abortOverflow.reasonName,'TimeoutError');
 const reference={metadata:{format:1,sourceProvenance:lib.sourceProvenance,nodeSha256:lib.nodeSha,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:'5.9.3',mongoose:'8.24.2'},pins:lib.pins,compiled:lib.compiled,evidence:lib.evidence,loaderSha256:lib.sha(fs.readFileSync(require.resolve('./moderation_semantic_source.cjs'))),readerSha256:lib.sha(fs.readFileSync(__filename)),nativeReplay:Object.fromEntries(['src/utils/moderation/semantic.rs','tests/moderation_semantic_source.rs','tests/support/moderation_semantic.rs','tests/support/sha256.rs'].map(file=>[file,lib.sha(lib.read(file))])),spamLoaderSha256:lib.sha(fs.readFileSync(require.resolve('./moderation_spam_source.cjs'))),sdk:lib.sdk(),mongooseFiles:lib.mongooseFiles,re2Runtime:lib.re2Runtime,runtimeExports:lib.runtimeExports,typeExports:lib.typeExports,privateTypes:lib.privateTypes,caseCount:cases.length,evaluateCount:evaluate.length,fixedClockMilliseconds:lib.FIXED_MS,boundary:'Own enumerable JSON-like values plus tagged undefined, holes, Dates, binary64 and UTF-16; no getters/proxies/cycles/symbols/functions/BigInt. SpamCategory is exactly five declared literals. Unknown enum/example/decision/threshold types are explicitly labeled source-only boundary records; they are not valid typed inputs. Clock, process.env key and fetch are test boundaries. AbortSignal wrapper calls actual Node timeout validation. Schemas retain real Date. HTTP responses are actual JSON.parse of configured wire bytes. Request construction happens outside source transport try/catch.'},constants:encode({SEMANTIC_USD_PER_MILLION_INPUT_TOKENS:api.SEMANTIC_USD_PER_MILLION_INPUT_TOKENS,SEMANTIC_PRICING_VERSION:api.SEMANTIC_PRICING_VERSION,FREE_MODERATION_MODEL:api.FREE_MODERATION_MODEL,OPENROUTER_APP_HEADERS:fixture.attribution.OPENROUTER_APP_HEADERS,SPAM_RULE_ID:SPAM}),cases,evaluate,abortContract,abortNormal,abortOverflow};
 const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&extra.length===0);const real=lib.external(dir),name='moderation-semantic-reference.json';assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[name]);const bytes=JSON.stringify(reference,null,2)+'\n';if(mode==='--write')fs.writeFileSync(path.join(real,name),bytes,{flag:'wx'});else assert.equal(fs.readFileSync(path.join(real,name),'utf8'),bytes);console.log(JSON.stringify({mode,sha256:lib.sha(bytes),cases:cases.length,evaluate:evaluate.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
