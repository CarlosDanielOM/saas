'use strict';
// Actual-source loader shared by the oracle and benchmark. No app entrypoint.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module'),vm=require('node:vm');
const base=require('./moderation_advanced_source.cjs');
assert.equal(base.re2Runtime.kind,'node24-fixture');
for(const [name,value] of Object.entries({DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256:'94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb',DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256:'e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664',DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256:'4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c'}))assert.equal(process.env[name],value,name);
const pins={
 'src/utils/moderation/spam.ts':'eaa35698ebd7f7e2351e522ca4ece5a3d96b58a96acc41b162b6f22eb2adaaa8',
 'src/schemas/moderation_chatter.schema.ts':'71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e',
 'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'src/utils/moderation/spam_categories.ts':'29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088',
 'src/schemas/moderation_decision.schema.ts':'749f450beb060ccba72447cc765f4e372b8d6fcbfa20d7c74ecd21a7d09b4466',
 'src/utils/permissions/index.ts':'14364559e21b5a801a9229015fc03583bfb5bf9310d8de9477b483398404f6cd',
 'src/utils/permissions/expression.ts':'34a3d2900bbad64bde838504e16a73f361bf7d317ef4089dcbf58fe0b1e79ab2',
 'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
 'node_modules/mongoose/index.js':'59e21822580047abc5468d740b720d1383fa3569aa2da3ac70325265fbb0e25b',
 'node_modules/mongoose/lib/mongoose.js':'141800e92c653c91489ab109a31e9b914dbb788ca4b20696d6a5781f12c5abb3',
 'tests/fixtures/moderation_advanced_source.cjs':'5263edb4c997171c2e172e9d4c47093126a0d6146ff37ad432dac100865b52c2',
};
for(const [file,hash] of Object.entries(pins))assert.equal(base.sha(base.read(file)),hash,file);
function independent(name,file){const pin=process.env[name];assert(/^[0-9a-f]{64}$/.test(pin||''),`${name} must be supplied independently`);assert.equal(base.sha(fs.readFileSync(file)),pin,name);return pin;}
independent('DIMA_SPAM_LOADER_SHA256',__filename);
const local=Module.createRequire(path.join(base.root,'package.json')),ts=local('typescript'),mongoose=local('mongoose');
assert.equal(mongoose.version,'8.24.2');assert.equal(ts.version,'5.9.3');
assert.equal(fs.realpathSync(local.resolve('mongoose')),fs.realpathSync(path.join(base.root,'node_modules/mongoose/index.js')));
// Pin every regular Mongoose package file, including files not loaded by this run.
const mongooseFiles={};
function walkSdk(relative=''){for(const entry of fs.readdirSync(path.join(base.root,'node_modules/mongoose',relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const name=relative?`${relative}/${entry.name}`:entry.name;assert(!entry.isSymbolicLink());if(entry.isDirectory())walkSdk(name);else {assert(entry.isFile());mongooseFiles[name]=base.sha(fs.readFileSync(path.join(base.root,'node_modules/mongoose',name)));}}}
walkSdk();const orderedMongoose=Object.fromEntries(Object.entries(mongooseFiles).sort(([a],[b])=>a<b?-1:a>b?1:0));
assert.equal(Object.keys(orderedMongoose).length,707);assert.equal(base.sha(JSON.stringify(orderedMongoose)),'63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722');
const files=['src/utils/moderation/spam_categories.ts','src/schemas/channel_moderation_settings.schema.ts','src/schemas/moderation_chatter.schema.ts','src/utils/moderation/spam.ts'];
const imports=[[],[['../utils/moderation/spam_categories.js',false],['../utils/moderation/variations.js',true],['crypto',false],['mongoose',false],['../utils/permissions/expression.js',true],['../utils/moderation/advanced.js',true]],[['mongoose',false]],[['./spam_categories.js',false],['node:crypto',false],['../../schemas/moderation_chatter.schema.js',false],['../../schemas/channel_moderation_settings.schema.js',false],['../permissions/index.js',true],['../../schemas/moderation_decision.schema.js',true],['../databases/dragonfly.database.js',false],['./advanced.js',false]]];
const outputs={},compiled={},evidence={};
for(const [i,file] of files.entries()){
 const source=base.read(file).toString('utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);assert.deepEqual(ast.parseDiagnostics,[]);
 const actual=ast.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]);assert.deepEqual(actual,imports[i],file);
 evidence[file]={imports:ast.statements.filter(ts.isImportDeclaration).map(s=>({module:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,bindings:s.importClause?.getText(ast)})),exports:ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast)}))};
 const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});assert.deepEqual(out.diagnostics,[]);outputs[file]=out.outputText;compiled[file]=base.sha(out.outputText);
}
// Type-only imports are audited without executing their application modules.
for(const file of ['src/schemas/moderation_decision.schema.ts','src/utils/permissions/index.ts','src/utils/permissions/expression.ts']){const ast=ts.createSourceFile(file,base.read(file).toString('utf8'),ts.ScriptTarget.ES2022,true);assert.deepEqual(ast.parseDiagnostics,[]);evidence[file]={typeOnlyAudit:true,imports:ast.statements.filter(ts.isImportDeclaration).map(s=>({module:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,bindings:s.importClause?.getText(ast)})),exports:ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)||ts.isExportDeclaration(s)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast)}))};}
const exportsExpected=['SPAM_RULE_ID','SPAM_CHANNEL_REVIEWS_PER_MINUTE','SPAM_GLOBAL_REVIEWS_PER_MINUTE','spamRule','broadcasterInvitedPromotion','spamRuleForContext','spamProtectionSettings','defaultSpamModerationSettings','spamReviewSource','isSpamDecision','semanticPolicyActive','chatterMarkerID','claimFirstObservedMessage','claimSpamReviewBudget'].sort();
const FIXED_MS=1700000000123;
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[FIXED_MS]));}static now(){return FIXED_MS;}}
function realm({kind='cjs',hooks={}}={}){
 assert(['cjs','vm'].includes(kind));const instance=new mongoose.Mongoose();instance.set('bufferCommands',false);assert.equal(instance.connection.readyState,0);
 const mods={},draws=[];const sourceCrypto={...require('node:crypto'),randomUUID(){const id=`00000000-0000-4000-8000-${String(draws.length).padStart(12,'0')}`;draws.push(id);return id;}};
 for(const file of files){
  const mod=new Module(path.join(base.root,file),module);mod.filename=path.join(base.root,file);
  mod.require=id=>{
   if(id==='crypto'||id==='node:crypto')return sourceCrypto;
   if(id==='fixture:clock')return FixedDate;
   if(id==='mongoose')return {Schema:mongoose.Schema,model:instance.model.bind(instance)};
   if(id==='./spam_categories.js'||id==='../utils/moderation/spam_categories.js')return mods[files[0]];
   if(id==='../../schemas/channel_moderation_settings.schema.js')return mods[files[1]];
   if(id==='../../schemas/moderation_chatter.schema.js')return {ModerationChatter:hooks.model||mods[files[2]].ModerationChatter};
   if(id==='../databases/dragonfly.database.js')return {getDragonflyClient:hooks.acquire||(async()=>{throw Error('storage seam required');})};
   if(id==='./advanced.js')return advanced.api;
   throw Error(`unexpected runtime import ${id} in ${file}`);
  };
  // Inject the clock only into application operations. Schema declarations
  // retain the real Date constructor that Mongoose recognizes as a field type.
  const code=(file==='src/utils/moderation/spam.ts' ? "const Date=require('fixture:clock');\n" : '')+outputs[file];
  if(kind==='cjs')mod._compile(code,mod.filename);else {const wrapper=vm.runInNewContext(Module.wrap(code),{Buffer,console},{filename:mod.filename});wrapper.call(mod.exports,mod.exports,mod.require,mod,mod.filename,path.dirname(mod.filename));}
  mods[file]=mod.exports;
 }
 const api=mods[files[3]];assert.deepEqual(Object.keys(api).sort(),exportsExpected);assert.equal(draws.length,4);assert.equal(instance.connection.readyState,0);
 return {api,instance,settings:mods[files[1]],chatter:mods[files[2]],draws};
}
const advanced=base.realm();
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
function encode(v){
 if(v===undefined)return {kind:'undefined'};if(v===null)return {kind:'null'};
 if(typeof v==='string')return {kind:'string',utf16:units(v)};
 if(typeof v==='number'){const b=Buffer.alloc(8);b.writeDoubleBE(v);return {kind:'number',bits:b.toString('hex')};}
 if(typeof v==='boolean')return {kind:'boolean',value:v};
 if(Object.prototype.toString.call(v)==='[object Date]')return {kind:'date',milliseconds:encode(v.getTime())};
 if(Array.isArray(v))return {kind:'array',items:Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)?encode(v[i]):{kind:'hole'})};
 if(typeof v==='object')return {kind:'object',entries:Object.keys(v).map(k=>[units(k),encode(v[k])])};
 throw Error(`outside ordinary fixture boundary: ${typeof v}`);
}
function decode(v){switch(v.kind){case 'undefined':case 'hole':return undefined;case 'null':return null;case 'string':return String.fromCharCode(...v.utf16);case 'number':return Buffer.from(v.bits,'hex').readDoubleBE();case 'boolean':return v.value;case 'date':return new FixedDate(decode(v.milliseconds));case 'array':{const a=new Array(v.items.length);v.items.forEach((x,i)=>{if(x.kind!=='hole')a[i]=decode(x);});return a;}case 'object':return Object.fromEntries(v.entries.map(([k,x])=>[String.fromCharCode(...k),decode(x)]));default:throw Error('invalid tag');}}
function capture(fn){try{return {ok:true,value:encode(fn())};}catch(e){return {ok:false,name:units(e?.name||'Error'),message:units(e?.message||String(e))};}}
async function captureAsync(fn){try{return {ok:true,value:encode(await fn())};}catch(e){return {ok:false,name:units(e?.name||'Error'),message:units(e?.message||String(e))};}}
function external(dir){assert(dir&&path.isAbsolute(dir));const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(base.root,'..'));assert(!real.startsWith(workspace+path.sep)&&real!==workspace);return real;}
function sdk(){return Object.fromEntries(Object.keys(require.cache).filter(p=>p.startsWith(path.join(base.root,'node_modules')+path.sep)&&!p.includes('/re2/build/')).sort().map(p=>[path.relative(base.root,p),base.sha(fs.readFileSync(p))]));}
module.exports={...base,realm,pins:{...base.pins,...pins},compiled:{...base.compiled,...compiled},evidence:{...base.evidence,...evidence},exportsExpected,FIXED_MS,encode,decode,capture,captureAsync,external,independent,sdk,mongooseFiles:orderedMongoose};
