'use strict';
// Actual TypeScript source oracle. The advanced loader validates the private Node
// 24 RE2 SDK and loads the real advanced implementation and its dependencies.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const lib=require('./moderation_advanced_source.cjs');
const sourceLoader=require('./moderation_variations_source.cjs');
assert.equal(process.env.DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256,'94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb');
assert.equal(process.env.DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256,'e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664');
assert.equal(process.env.DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256,'4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c');
assert.equal(lib.re2Runtime.kind,'node24-fixture');
const readerPin=process.env.DIMA_VARIATIONS_READER_SHA256;
assert(/^[0-9a-f]{64}$/.test(readerPin||''),'DIMA_VARIATIONS_READER_SHA256 must be independently supplied');
assert.equal(lib.sha(fs.readFileSync(__filename)),readerPin,'reader');
const pins={
 'src/utils/moderation/variations.ts':'f7a21881289f63a50de733df232570c00f851333d5762ef39e1258915287580e',
 'src/utils/ai/openrouter/app_attribution.util.ts':'0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c',
 'tests/fixtures/moderation_advanced_source.cjs':'1205ade8280a3cfebb806e336570ab650a92e178db306f33aa760315fafbee50',
};
for(const [file,hash] of Object.entries(pins))assert.equal(lib.sha(sourceLoader.readSource(file)),hash,file);
const local=Module.createRequire(path.join(lib.root,'package.json')),ts=local('typescript');
const files=['src/utils/moderation/normalize.ts','src/utils/ai/openrouter/app_attribution.util.ts','src/utils/moderation/variations.ts'];
const imports=[[],[],[['node:crypto',false],['../ai/openrouter/app_attribution.util.js',false],['re2',false],['./normalize.js',false],['./advanced.js',false]]];
const outputs={},compiled={},evidence={};
for(const [i,file] of files.entries()){
 const source=sourceLoader.readSource(file).toString('utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
 assert.deepEqual(ast.parseDiagnostics,[]);
 assert.deepEqual(ast.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]),imports[i]);
 evidence[file]={imports:imports[i],exports:ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast).split('\n')[0]}))};
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});
 assert.deepEqual(result.diagnostics,[]);outputs[file]=result.outputText;compiled[file]=lib.sha(result.outputText);
}
const typeNames=evidence[files[2]].exports.filter(x=>x.kind==='TypeAliasDeclaration'||x.kind==='InterfaceDeclaration').map(x=>x.text.match(/export (?:type|interface) (\w+)/)[1]);
assert.deepEqual(typeNames,['VariationMode','GeneratedVariation','VariationOverride','ModerationVariations']);
function realm(){
 const mods={},advanced=lib.realm();
 for(const file of files){
  const mod=new Module(path.join(lib.root,file),module);mod.filename=path.join(lib.root,file);
  mod.require=id=>{
   if(id==='node:crypto')return require('node:crypto');
   if(id==='re2')return lib.RE2;
   if(id==='./normalize.js')return mods[files[0]];
   if(id==='../ai/openrouter/app_attribution.util.js')return mods[files[1]];
   if(id==='./advanced.js')return advanced.api;
   throw new Error(`unexpected import ${id} in ${file}`);
  };
  mod._compile(outputs[file],mod.filename);mods[file]=mod.exports;
 }
 const api=mods[files[2]];
 assert.deepEqual(Object.keys(api).sort(),['VARIATION_MODEL','VARIATION_VERSION','buildVariation','compileRuleVariations','generateMuseVariations','museVariationRequest','rulePatterns','validateVariations','variationAllowSpaces','variationKey','variationMode','variationOverrides','variationTerm','variationTerms','withVariationSpacing'].sort());
 return api;
}
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
function enc(v){
 if(v===undefined)return {kind:'undefined'};if(v===null)return {kind:'null'};
 if(typeof v==='string')return {kind:'string',utf16:units(v)};
 if(typeof v==='number')return {kind:'number',bits:bits(v)};
 if(typeof v==='boolean')return {kind:'boolean',value:v};
 if(Array.isArray(v))return {kind:'array',items:Array.from({length:v.length},(_,i)=>i in v?enc(v[i]):{kind:'hole'})};
 if(typeof v==='object')return {kind:'object',entries:Object.keys(v).map(k=>[units(k),enc(v[k])])};
 throw new Error(`out of fixture boundary: ${typeof v}`);
}
function wire(v){const s=JSON.stringify(v);return s===undefined?null:units(s);}
function result(fn){try{const value=fn();return {ok:true,value:enc(value),wire:wire(value)};}catch(e){return {ok:false,name:units(e.name),message:units(e.message)};}}
async function asyncResult(fn){try{const value=await fn();return {ok:true,value:enc(value),wire:wire(value)};}catch(e){return {ok:false,name:units(e.name),message:units(e.message)};}}
const api=realm(),cases=[];
function call(name,id,...args){cases.push({kind:'call',id,export:name,args:enc(args),result:result(()=>api[name](...args))});}
for(const value of [undefined,null,true,false,0,NaN,Infinity,'true',{},[]])call('variationAllowSpaces','allow-'+cases.length,value);
for(const value of [undefined,null,0,false,'common',[],{}, {mode:'off'},{mode:'common'},{mode:'broad'},{mode:'bad'}])call('variationMode','mode-'+cases.length,value);
for(const value of ['', '  CAFÉ\t Test ', 'e\u0301', 'ΟΣ ΟΣΑ', 'İ', '\ud800', '\udc00', '😀', null, 1]){
 call('variationTerm','term-'+cases.length,value);call('variationKey','key-'+cases.length,'channel',value);
}
for(const value of [undefined,null,{},[],[' A ','a','e\u0301','é'],[''],[1],['x'.repeat(100)],['x'.repeat(101)],Array(200).fill('x'),Array(201).fill('x'),['😀'.repeat(50)],['😀'.repeat(51)]])call('variationTerms','terms-'+cases.length,value);
for(const value of [undefined,null,{},[],[null],[{}],[{term:'bad',source:'('}],[{term:'cat',source:''}],[{term:'cat',source:'a*'}],[{term:'cat',source:'(?=x)'}],[{term:'cat',source:'(a)\\1'}],[{term:'cat',source:'a'.repeat(16000)}],[{term:'cat',source:'a'.repeat(16001)}],[{term:' cat ',source:'cat'},{term:'CAT',source:'dog'}],[{term:'cat',source:'cat'}],Array(201).fill({term:'cat',source:'x'})])for(const mode of ['off','common'])call('variationOverrides','overrides-'+cases.length,value,['cat'],mode);
for(const [term,suggestions] of [['cat',[]],['cat',['ct','cut','cats','cating','cated']],['cat',['dog']],['ab',['ac']],['ab',['AB']],['café',['cafe']],['😀a',['😀b']],['😃ab',['😃ac']],['a.b',['a.b']],['foo  bar',['foo bar']],['\ud800ab',[]],['x'.repeat(100),[]],['x'.repeat(101),[]],['',[]],['cat',null],['cat',Array(9).fill('cat')],['cat',[1]],['cat',['']],['cat',['x'.repeat(101)]]])call('buildVariation','build-'+cases.length,term,suggestions);
const entries=['cat','ab','café','a.b','foo bar','rinn','\ud800ab'].map(x=>api.buildVariation(x));
for(const entry of entries)for(const mode of ['off','common','broad'])for(const allow of [false,true])call('withVariationSpacing','spacing-'+cases.length,entry,allow,mode);
for(const rule of [{},{variations:{mode:'off',entries}},{variations:{mode:'common',entries:entries.slice(0,2)}},{patterns:[{id:'p',source:'dog',boundary:'anywhere',ignoreCase:false}],variations:{mode:'broad',allowSpaces:true,entries:entries.slice(0,2),overrides:[{term:'cat',source:'c.t'}]}},{variations:{mode:'broad',entries:[]}}]){
 call('compileRuleVariations','compile-'+cases.length,rule);call('rulePatterns','patterns-'+cases.length,rule);
}
for(const size of [1999,2000,16000,16001])call('withVariationSpacing','source-limit-'+size,{term:'abc',spellings:['a'.repeat(size)],pattern:{id:'x',source:'x',boundary:'whole_word',ignoreCase:true},version:'x'},true,'common');
for(const mode of ['off','common','broad'])for(const allow of [false,true]){call('validateVariations','validate-'+cases.length,entries.slice(0,2),allow,mode);call('validateVariations','validate-empty-'+cases.length,[],allow,mode);}
call('museVariationRequest','request-empty',[]);call('museVariationRequest','request-terms',['cat','é','\ud800']);
function cacheEvidence(){
 const a=realm(),entry=a.buildVariation('cat'),first=a.withVariationSpacing(entry,true,'common'),again=a.withVariationSpacing({...entry},true,'common');
 const direct=a.withVariationSpacing(first,true,'common');
 for(let i=0;i<999;i++)a.withVariationSpacing({...entry,extra:i},true,'common');
 const before=a.withVariationSpacing({...entry},true,'common');
 a.withVariationSpacing({...entry,extra:'overflow'},true,'common');
 const after=a.withVariationSpacing({...entry},true,'common');
 return enc({sameValueCache:first===again,alreadyCompiledIdentity:first===direct,hitBeforeEviction:first===before,evictedAfterOverflow:first!==after});
}
async function transport(){
 const observations=[],savedFetch=global.fetch,savedKey=process.env.OPENROUTER_API_KEY;
 try{
  for(const [id,config] of [
   ['no-channel',{channel:' ',key:'key'}],['no-key',{channel:'chan',key:undefined}],
   ['success',{body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({entries:[{term:'cat',spellings:['ct']}]})}}],model:'mock-model',usage:{prompt_tokens:3,completion_tokens:4,cost:0.25}}}],
   ['default-model-usage',{body:{choices:[{finish_reason:'stop',message:{content:'{"entries":[{"term":"cat","spellings":[]}]}'}}]}}],
   ['http-error',{ok:false}],['fetch-error',{reject:'transport_failure'}],['cancel',{abort:true}],['json-error',{jsonReject:true}],
   ['nonstop',{body:{choices:[{finish_reason:'length',message:{content:'{}'}}]}}],['missing-content',{body:{choices:[{finish_reason:'stop',message:{}}]}}],
   ['malformed',{body:{choices:[{finish_reason:'stop',message:{content:'{'}}]}}],['missing-entries',{body:{choices:[{finish_reason:'stop',message:{content:'{}'}}]}}],
   ['duplicate',{terms:['cat','dog'],body:{choices:[{finish_reason:'stop',message:{content:'{"entries":[{"term":"cat","spellings":[]},{"term":"cat","spellings":[]}]}'}}]}}],
   ['missing-term',{body:{choices:[{finish_reason:'stop',message:{content:'{"entries":[{"term":"dog","spellings":[]}]}'}}]}}],
   ['invalid-spelling',{body:{choices:[{finish_reason:'stop',message:{content:'{"entries":[{"term":"cat","spellings":["dog"]}]}'}}]}}],
  ]){
   const captures=[],controller=new AbortController(),terms=config.terms||['cat'];
   if(config.abort)controller.abort();
   if(config.key===undefined && id==='no-key')delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=config.key||'fixture-key';
   global.fetch=async(url,options)=>{captures.push({url,method:options.method,headers:options.headers,body:options.body,signalIsSupplied:options.signal===controller.signal,aborted:options.signal.aborted});
    if(config.abort){const e=new Error('aborted');e.name='AbortError';throw e;}
    if(config.reject)throw new Error(config.reject);
    return {ok:config.ok!==false,json:async()=>{if(config.jsonReject)throw new Error('invalid_json_transport');return config.body;}};
   };
   const out=await asyncResult(()=>api.generateMuseVariations(terms,controller.signal,config.channel===undefined?'chan':config.channel));
   observations.push({id,terms:enc(terms),result:out,requests:enc(captures)});
  }
 }finally{global.fetch=savedFetch;if(savedKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=savedKey;}
 return observations;
}
(async()=>{
 const reference={metadata:{format:1,sourceProvenance:sourceLoader.sourceProvenance,attribution:sourceLoader.attribution,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,re2:'1.27.0'},nodeSha:lib.nodeSha,pins:{...lib.pins,...pins},readerSha256:lib.sha(fs.readFileSync(__filename)),re2Runtime:lib.re2Runtime,compiled:{...lib.compiled,...compiled},evidence:{...lib.evidence,...evidence},runtimeExports:Object.keys(api).sort(),typeExports:typeNames,caseCount:cases.length,boundary:'Own enumerable JSON-like values with tagged UTF-16, undefined, array holes and IEEE-754 bits; no accessors, proxies, symbols, functions, BigInt or cycles. Only HTTP, API key and abort are test seams; no provider calls.'},constants:enc({VARIATION_VERSION:api.VARIATION_VERSION,VARIATION_MODEL:api.VARIATION_MODEL}),cases,cache:cacheEvidence(),transport:await transport()};
 const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&extra.length===0,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
 const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(lib.root,'..'));assert(real!==workspace&&!real.startsWith(workspace+path.sep),'output must be outside workspace');
 const file=path.join(real,'moderation-variations-reference.json');assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(file)]);
 const output=JSON.stringify(reference,null,2)+'\n';if(mode==='--write')fs.writeFileSync(file,output,{flag:'wx'});else assert.equal(fs.readFileSync(file,'utf8'),output);
 console.log(JSON.stringify({mode,sha256:lib.sha(output),cases:cases.length,transport:reference.transport.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
