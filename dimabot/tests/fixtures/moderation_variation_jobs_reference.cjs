'use strict';
// Actual-source oracle. All I/O is scripted; never sends a real request.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const lib=require('./moderation_variations_source.cjs');
assert.equal(lib.sha(lib.read('tests/fixtures/moderation_variations_source.cjs')),'8f90d3498fd103c85e6269f6dc0f6712598ddeda676d74bb185a613e24e2861f');
assert.equal(process.env.DIMA_VARIATIONS_BENCH_LOADER_SHA256,'8f90d3498fd103c85e6269f6dc0f6712598ddeda676d74bb185a613e24e2861f');
const pin=process.env.DIMA_VARIATION_JOBS_READER_SHA256;
assert(/^[0-9a-f]{64}$/.test(pin||''));assert.equal(lib.sha(fs.readFileSync(__filename)),pin,'reader');
const file='src/utils/moderation/variation_jobs.ts';
assert.equal(lib.sha(lib.read(file)),'6a4122f95723a3288e6989afa44bd922fa601f914fce00686c508a857df2228d');
const ts=Module.createRequire(path.join(lib.root,'package.json'))('typescript');
assert.equal(ts.version,'5.9.3');assert.equal(process.versions.node,'24.22.1');assert.equal(process.versions.v8,'13.6.233.17-node.58');
assert.equal(lib.nodeSha,'569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
const source=lib.read(file).toString('utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
assert.deepEqual(ast.parseDiagnostics,[]);
const imports=ast.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]);
assert.deepEqual(imports,[['node:crypto',false],['../../schemas/users.schema.js',false],['../../schemas/moderation_variation.schema.js',false],['../../schemas/channel_moderation_settings.schema.js',true],['../databases/dragonfly.database.js',false],['./advanced.js',false],['./variations.js',false]]);
const declarations=ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast).split('\n')[0]}));
assert.deepEqual(declarations.map(x=>x.text.match(/export (?:async )?(?:function|class) (\w+)/)?.[1]),['VariationError','savedVariations','resolveVariations','variationJobView','requestVariationJob','processNextVariationJob']);
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
function enc(v){
 if(v===undefined)return {kind:'undefined'};if(v===null)return {kind:'null'};
 if(typeof v==='string')return {kind:'string',utf16:units(v)};
 if(typeof v==='number'){const b=Buffer.alloc(8);b.writeDoubleBE(v);return {kind:'number',bits:b.toString('hex')};}
 if(typeof v==='boolean')return {kind:'boolean',value:v};
 if(v instanceof Date)return {kind:'date',milliseconds:enc(v.getTime())};
 if(v instanceof Map)return {kind:'map',entries:[...v].map(([k,x])=>[enc(k),enc(x)])};
 if(Array.isArray(v))return {kind:'array',items:Array.from({length:v.length},(_,i)=>i in v?enc(v[i]):{kind:'hole'})};
 if(typeof v==='object')return {kind:'object',entries:Object.keys(v).map(k=>[units(k),enc(v[k])])};
 throw Error('unsupported value: '+typeof v);
}
const RealDate=Date,realTimeout=AbortSignal.timeout,realFetch=global.fetch,realKey=process.env.OPENROUTER_API_KEY;
const epoch=Date.parse('2026-01-02T00:00:00.000Z');
let now=epoch;
class ClockDate extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
global.Date=ClockDate;
const variations=lib.realm(); // The actual variations module, including real helpers and RE2.
const entry=term=>variations.buildVariation(term);
const E=entry('cat'),D=entry('dog'),old={...E,version:'old'};
const job=(state='pending',extra={})=>({_id:'fixture-job',channelID:'chan',terms:['cat'],state,entries:[],error:'',createdAt:new Date(epoch-1000),deadline:new Date(epoch+120000),...extra});
const steps=(...xs)=>xs.map(([method,value])=>({method,value}));
const cases=[];
function add(name,operation,args,script,options={}){cases.push({name,operation,args,script,options});}
add('saved-prior-cache-order','savedVariations',['chan',['cat','dog'],[{variations:{mode:'broad',entries:[E,old,D]}},{variations:{mode:'common',entries:[E]}}]],steps(['Cache.find',[{entry:{...E,marker:'cache'}}]]));
add('saved-cache-missing-version','savedVariations',['chan',['cat'],[]],steps(['Cache.find',[{entry:{...E,version:undefined}}]]));
add('saved-malformed-cache','savedVariations',['chan',['cat'],[]],steps(['Cache.find',[{}]]));
add('resolve-off','resolveVariations',['chan',['cat'],'off',[],true],[]);
add('resolve-common','resolveVariations',['chan',['cat'],'common',[],true],[]);
add('resolve-broad','resolveVariations',['chan',[' CAT '],'broad',[{variations:{mode:'broad',entries:[E]}}],true],steps(['Cache.find',[]]));
add('resolve-missing','resolveVariations',['chan',['cat'],'broad',[],false],steps(['Cache.find',[]]));
add('resolve-invalid-stored','resolveVariations',['chan',['cat'],'broad',[],true],steps(['Cache.find',[{entry:{term:'cat'}}]]));
for(const state of ['reserved','pending','processing','completed','failed'])add('view-'+state,'variationJobView',[job(state,{entries:[E],error:'example'})],[]);
add('request-all-cached','requestVariationJob',['chan',['cat'],[]],steps(['Cache.find',[{entry:E}]]));
for(const state of ['reserved','pending','processing','completed'])add('request-existing-'+state,'requestVariationJob',['chan',['cat'],[]],steps(['Cache.find',[]],['Jobs.findById',job(state)]));
add('request-retry-race','requestVariationJob',['chan',['cat'],[]],steps(['Cache.find',[]],['Jobs.findById',job('failed')],['Jobs.findOneAndUpdate',null],['Jobs.findById',job('completed',{entries:[E]})]));
add('request-duplicate','requestVariationJob',['chan',['cat'],[]],steps(['Cache.find',[]],['Jobs.findById',null],['Jobs.create',{throw:{message:'duplicate',code:11000}}],['Jobs.findById',job('pending')]));
add('request-create-error','requestVariationJob',['chan',['cat'],[]],steps(['Cache.find',[]],['Jobs.findById',null],['Jobs.create',{throw:{message:'database',code:7}}]));
add('request-grant-seed-utf16','requestVariationJob',['chan',['😀','\ue000','cat'],[{variations:{mode:'broad',entries:[E]}}]],steps(['Cache.find',[]],['Jobs.findById',null],['Jobs.create',{}],['Redis.eval',1],['Jobs.updateOne',{}],['Jobs.findById',job('pending',{entries:[E]})]));
add('request-retry-denied','requestVariationJob',['chan',['cat'],[]],steps(['Cache.find',[]],['Jobs.findById',job('failed')],['Jobs.findOneAndUpdate',job('reserved')],['Redis.eval',0],['Jobs.updateOne',{}]));
add('process-empty','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',null]));
add('process-plan','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{plan_tier:'free'}],['Jobs.updateOne',{}]));
add('process-cache-only','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job('processing',{entries:[E]})],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Jobs.updateOne',{}]));
const words=Array.from({length:21},(_,i)=>'word'+i);
add('process-two-batches','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job('processing',{terms:words})],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Fetch',{}],['Jobs.updateOne',{}],...words.slice(0,20).map(()=>['Cache.updateOne',{}]),['Fetch',{}],['Jobs.updateOne',{}],['Cache.updateOne',{}],['Jobs.updateOne',{}]));
add('process-timeout-before','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job('processing',{deadline:new Date(epoch)})],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Jobs.updateOne',{}]));
add('process-timeout-after','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job('processing',{deadline:new Date(epoch+1000)})],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Fetch',{advance:1000}],['Jobs.updateOne',{}],['Jobs.updateOne',{}]));
add('process-provider-unavailable','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Fetch',{httpError:true}],['Jobs.updateOne',{}]));
add('process-invalid-provider','processNextVariationJob',[],steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Fetch',{invalid:true}],['Jobs.updateOne',{}]));
for(const [name,script] of [
 ['owner-query',steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{throw:{message:'bad query'}}],['Jobs.updateOne',{}])],
 ['cache-query',steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{plan_tier:'premium'}],['Cache.find',{throw:{message:'bad cache'}}],['Jobs.updateOne',{}])],
 ['usage-push',steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Fetch',{}],['Jobs.updateOne',{throw:{message:'bad push'}}],['Jobs.updateOne',{}])],
 ['cache-write',steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job()],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Fetch',{}],['Jobs.updateOne',{}],['Cache.updateOne',{throw:{message:'bad write'}}],['Jobs.updateOne',{}])],
 ['complete-write',steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',job('processing',{entries:[E]})],['Users.findOne',{plan_tier:'premium'}],['Cache.find',[]],['Jobs.updateOne',{throw:{message:'bad complete'}}],['Jobs.updateOne',{}])],
 ['maintenance',steps(['Jobs.updateMany',{throw:{message:'maintenance'}}])],
 ['claim',steps(['Jobs.updateMany',{}],['Jobs.findOneAndUpdate',{throw:{message:'claim'}}])],
])add('process-failure-'+name,'processNextVariationJob',[],script);
assert.equal(cases.length,38);
async function run(c){
 let cursor=0;const calls=[];now=epoch;
 function take(method,args){calls.push({method,args:enc(args)});const step=c.script[cursor++];assert(step,`${c.name}: unexpected ${method}`);assert.equal(step.method,method,c.name);const v=step.value;if(v&&v.throw){const e=new Error(v.throw.message);if(v.throw.code!==undefined)e.code=v.throw.code;throw e;}return v;}
 const query=(model,method)=>(...args)=>{const value=take(model+'.'+method,args);return {select:(...selectArgs)=>{calls.push({method:model+'.select',args:enc(selectArgs)});return {lean:async()=>{calls.push({method:model+'.lean',args:enc([])});return value;}};},lean:async()=>{calls.push({method:model+'.lean',args:enc([])});return value;}};};
 const model=name=>({find:query(name,'find'),findById:query(name,'findById'),findOne:query(name,'findOne'),findOneAndUpdate:query(name,'findOneAndUpdate'),create:async(...a)=>take(name+'.create',a),updateOne:async(...a)=>take(name+'.updateOne',a),updateMany:async(...a)=>take(name+'.updateMany',a)});
 const cache=model('Cache'),jobs=model('Jobs'),users=model('Users');
 AbortSignal.timeout=ms=>{calls.push({method:'AbortSignal.timeout',args:enc([ms])});return new AbortController().signal;};
 global.fetch=async(url,options)=>{const config=take('Fetch',[url,{method:options.method,headers:options.headers,body:options.body,aborted:options.signal.aborted}]);now+=config.advance||0;const terms=JSON.parse(JSON.parse(options.body).messages[1].content).terms;return {ok:!config.httpError,json:async()=>({model:'fixture-model',usage:{prompt_tokens:3,completion_tokens:4,cost:0.25},choices:[{finish_reason:'stop',message:{content:config.invalid?'{}':JSON.stringify({entries:terms.map(term=>({term,spellings:[]}))})}}]})};};
 process.env.OPENROUTER_API_KEY='fixture-key';
 const mod=new Module(path.join(lib.root,file),module);mod.filename=path.join(lib.root,file);
 mod.require=id=>{if(id==='node:crypto')return require(id);if(id==='../../schemas/users.schema.js')return users;if(id==='../../schemas/moderation_variation.schema.js')return {ModerationVariationCache:cache,ModerationVariationJob:jobs};if(id==='../databases/dragonfly.database.js')return {getDragonflyClient:async(...a)=>{calls.push({method:'getDragonflyClient',args:enc(a)});return {eval:async(...x)=>take('Redis.eval',x)};}};if(id==='./advanced.js')return requireAdvanced();if(id==='./variations.js')return variations;throw Error('unexpected import '+id);};
 function requireAdvanced(){return require('./moderation_advanced_source.cjs').realm().api;}
 mod._compile(compiled.outputText,mod.filename);const api=mod.exports;assert.deepEqual(Object.keys(api).sort(),['VariationError','savedVariations','resolveVariations','variationJobView','requestVariationJob','processNextVariationJob'].sort());
 let outcome;try{outcome={ok:true,value:enc(await api[c.operation](...c.args))};}catch(e){outcome={ok:false,name:enc(e.name),message:enc(e.message),status:enc(e.status)};}
 assert.equal(cursor,c.script.length,`${c.name}: unconsumed mock responses`);
 return {name:c.name,operation:c.operation,args:enc(c.args),script:enc(c.script),outcome,calls};
}
(async()=>{try{
 const observed=[];for(const c of cases)observed.push(await run(c));
 const reference={schema:1,provenance:{sourceProvenance:lib.sourceProvenance,sourceSha256:lib.sha(source),readerSha256:pin,loaderSha256:lib.sha(lib.read('tests/fixtures/moderation_variations_source.cjs')),node:process.versions.node,v8:process.versions.v8,nodeSha256:lib.nodeSha,typescript:ts.version,re2Runtime:lib.re2Runtime,pins:{...lib.pins,...lib.variationPins},compiled:{...lib.compiled,...lib.variationCompiled,[file]:lib.sha(compiled.outputText)},evidence:{...lib.evidence,...lib.variationEvidence,[file]:{imports,declarations}},runtimeExports:['VariationError','savedVariations','resolveVariations','variationJobView','requestVariationJob','processNextVariationJob'],typeExports:[],caseCount:observed.length},cases:observed};
 const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&!extra.length,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(lib.root,'..'));assert(real!==workspace&&!real.startsWith(workspace+path.sep),'output must be outside workspace');const outputFile=path.join(real,'moderation-variation-jobs-reference.json');assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(outputFile)]);const output=JSON.stringify(reference,null,2)+'\n';if(mode==='--write')fs.writeFileSync(outputFile,output,{flag:'wx'});else assert.equal(fs.readFileSync(outputFile,'utf8'),output);console.log(JSON.stringify({mode,sha256:lib.sha(output),cases:observed.length}));
 }finally{global.Date=RealDate;AbortSignal.timeout=realTimeout;global.fetch=realFetch;if(realKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=realKey;}})().catch(e=>{console.error(e);process.exitCode=1;});
