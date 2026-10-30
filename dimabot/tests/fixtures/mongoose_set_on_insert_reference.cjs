'use strict';
// Actual complete source, disconnected pinned Mongoose; only its clock default is replaced.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_SCHEMA_NODE_SHA256,pin); assert.equal(sha(fs.readFileSync(process.execPath)),pin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const root=fs.realpathSync(process.env.DIMA_SCHEMA_SOURCE_ROOT); assert.equal(root,process.env.DIMA_SCHEMA_SOURCE_ROOT);
const [mode,dir,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode)&&path.isAbsolute(dir)&&!extra.length); assert.equal(fs.realpathSync(dir),dir); assert(dir!==root && !dir.startsWith(root+path.sep));
const name='mongoose-set-on-insert-reference.json'; assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]);
const read=f=>fs.readFileSync(path.join(root,f)),req=createRequire(path.join(root,'package.json'));
const ts=req('typescript'),mongoose=req('mongoose'),bsonReq=createRequire(req.resolve('mongoose')); const bsonJs=bsonReq.resolve('bson'),bsonPackage=path.join(path.dirname(bsonJs),'..','package.json'); assert.equal(ts.version,'5.9.3'); assert.equal(mongoose.version,'8.24.2'); assert.equal(JSON.parse(fs.readFileSync(bsonPackage)).version,'6.10.4');
const file='src/schemas/moderation_decision.schema.ts',source=read(file).toString('utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
const instance=new mongoose.Mongoose(); instance.set('autoCreate',false);instance.set('autoIndex',false);const api={};
new vm.Script(`(function(exports,require){${compiled.outputText}\n})`,{filename:file}).runInThisContext()(api,id=>{assert.equal(id,'mongoose');return {Schema:instance.Schema,model:instance.model.bind(instance)};});
const model=api.ModerationDecision, now=1700000000000;
assert.equal(model.schema.path('createdAt').defaultValue,Date.now);model.schema.path('createdAt').default(()=>now);
const defaults=req('mongoose/lib/helpers/setDefaultsOnInsert');
function norm(v){if(v instanceof Date)return {$date:v.getTime()};if(Array.isArray(v))return v.map(norm);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,norm(v[k])]));return v;}
function evaluate(filter,input){try {const q=model.findOneAndUpdate(filter,{$setOnInsert:input},{upsert:true,setDefaultsOnInsert:true});const update=q._castUpdate(q.getUpdate());const result=defaults(filter,model.schema,update,{upsert:true,setDefaultsOnInsert:true});return {document:norm(result?.$setOnInsert||{})};}catch(e){assert.equal(e.name,'CastError');return {error:{path:e.path,kind:'cast'}};}}
const cases=[
 [{},{}], [{_id:'id'}, {channelID:42,unknown:3}], [{state:'existing',createdAt:100},{}],
 [{},{channelID:'',reviewSource:'invalid',expiresAt:null}], [{},{rule:{},scores:{},charge:{},matches:[{}, {nested:{}}]}],
 [{},{matches:'x',context:{a:1},inputTokens:'2',cost:'1.5',latencyMs:true}],
 [{},{reviewSource:null,matches:null,context:null,createdAt:0,deadline:'2025-01-01'}],
 [{},{inputTokens:'bad'}], [{},{expiresAt:'bad'}], [{},{providerRequestID:{_id:'x'}}],
 [{},{_id:'x',channelID:'c',userID:'u',username:'n',messageID:'m',messageText:'t',ruleID:'r',rule:{type:'x'},settingsVersion:2,matches:[],context:[],mode:'semantic',reviewSource:'rule',state:'pending',verdict:'uncertain',status:'pending',model:'m',provider:'p',decisionPolicyVersion:'v',scores:null,providerRequestID:'q',inputTokens:3,cost:0.1,latencyMs:4,charge:{status:'none'},consequence:{status:'none'},feedback:null,deadline:1800000000000,createdAt:1700000000000,expiresAt:1900000000000}]
].map(([filter,input])=>({filter,input,expected:evaluate(filter,input)}));
const files=[file,'src/schemas/moderation_decision.schema.rs','src/schemas/schema.rs','src/utils/bson_compat.rs','src/utils/mongoose_date.rs','tests/mongoose_set_on_insert.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,sha(read(f))]));hashes['oracle-script']=sha(fs.readFileSync(__filename));hashes['query.js']=sha(fs.readFileSync(req.resolve('mongoose/lib/query')));hashes['setDefaultsOnInsert.js']=sha(fs.readFileSync(req.resolve('mongoose/lib/helpers/setDefaultsOnInsert')));hashes['castUpdate.js']=sha(fs.readFileSync(req.resolve('mongoose/lib/helpers/query/castUpdate')));hashes['schemaType.js']=sha(fs.readFileSync(req.resolve('mongoose/lib/schemaType')));hashes['bson-js']=sha(fs.readFileSync(bsonJs));hashes['bson-package']=sha(fs.readFileSync(bsonPackage));for(const m of ['typescript','typescript/package.json','mongoose','mongoose/package.json'])hashes[m]=sha(fs.readFileSync(req.resolve(m)));
const metadata=Object.fromEntries(Object.entries(model.schema.paths).map(([k,v])=>[k,{instance:v.instance,hasDefault:v.defaultValue!==undefined}]));
const output=JSON.stringify({versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version,bson:'6.10.4'},nodeExecutableSha256:pin,sourceSha256:hashes,compiledSha256:sha(compiled.outputText),metadata,now,cases},null,2)+'\n';
const target=path.join(dir,name);if(mode==='--write')fs.writeFileSync(target,output,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),output);console.log(`${name} sha256=${sha(output)} cases=${cases.length}`);
