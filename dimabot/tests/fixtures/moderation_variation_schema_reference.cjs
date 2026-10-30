#!/usr/bin/env node
'use strict';
// Disconnected oracle: compile the actual source; never connect to MongoDB.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), vm=require('node:vm');
const assert=require('node:assert/strict'), {createRequire}=require('node:module');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const pin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_SCHEMA_NODE_SHA256,pin); assert.equal(digest(fs.readFileSync(process.execPath)),pin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const rootArg=process.env.DIMA_SCHEMA_SOURCE_ROOT; assert(rootArg && path.isAbsolute(rootArg));
const root=fs.realpathSync(rootArg); assert.equal(root,rootArg);
const [mode,dirArg,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode) && dirArg && !extra.length && path.isAbsolute(dirArg));
const dir=fs.realpathSync(dirArg); assert.equal(dir,dirArg); assert(fs.statSync(dir).isDirectory() && dir!==root && !dir.startsWith(root+path.sep));
const name='moderation-variation-schema-reference.json'; assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]);
if(mode==='--check') assert(fs.lstatSync(path.join(dir,name)).isFile());
const read=f=>fs.readFileSync(path.join(root,f)), req=createRequire(path.join(root,'package.json'));
const ts=req('typescript'), mongoose=req('mongoose'), bsonReq=createRequire(req.resolve('mongoose'));
const bson=bsonReq('bson'), bsonJs=bsonReq.resolve('bson'), bsonPackage=path.join(path.dirname(bsonJs),'..','package.json');
assert.equal(ts.version,'5.9.3'); assert.equal(mongoose.version,'8.24.2'); assert.equal(JSON.parse(fs.readFileSync(bsonPackage)).version,'6.10.4');
const instance=new mongoose.Mongoose();
const source=read('src/schemas/moderation_variation.schema.ts').toString('utf8');
const tree=ts.createSourceFile('moderation_variation.schema.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
assert.deepEqual(tree.parseDiagnostics,[]);
const imports=tree.statements.filter(ts.isImportDeclaration).map(s=>({module:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,bindings:s.importClause?.getText(tree)}));
assert.deepEqual(imports.map(x=>[x.module,x.typeOnly]),[['mongoose',false],['../utils/moderation/variations.js',true]]);
const decls=tree.statements.filter(ts.isInterfaceDeclaration), jobType=decls.find(d=>d.name.text==='VariationJob');
assert(jobType && jobType.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
const fields=Object.fromEntries(jobType.members.map(m=>{assert(ts.isPropertySignature(m)&&m.type&&!m.questionToken);return [m.name.getText(tree),m.type.getText(tree)];}));
assert.deepEqual(fields,{_id:'string',channelID:'string',terms:'string[]',state:"'reserved' | 'pending' | 'processing' | 'completed' | 'failed'",entries:'GeneratedVariation[]',error:'string',attempts:'number',createdAt:'Date',deadline:'Date',expiresAt:'Date',model:'string',version:'string',providerUsage:'Array<Record<string, unknown>>',creditsCharged:'number'});
const typeEvidence={imports,interface:jobType.getText(tree),fields};
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exportsObject={}; const requireSafe=name=>{assert.equal(name,'mongoose'); return {Schema:instance.Schema,model:instance.model.bind(instance)};};
new vm.Script(`(function(exports,require){${js}\n})`,{filename:'moderation_variation.schema.ts'}).runInThisContext()(exportsObject,requireSafe);
assert.deepEqual(Object.keys(exportsObject).sort(),['ModerationVariationCache','ModerationVariationJob']);
const models={cache:exportsObject.ModerationVariationCache,job:exportsObject.ModerationVariationJob};
assert.equal(models.cache.collection.name,'moderation_variation_caches'); assert.equal(models.job.collection.name,'moderation_variation_jobs');
function norm(value) {
 if(value instanceof Date) return {$date:value.getTime()};
 if(Array.isArray(value)) return value.map(norm);
 if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,norm(value[k])]));
 return value;
}
function errors(e) { return e ? Object.keys(e.errors).sort().map(path=>({path,kind:e.errors[path].name==='CastError'?'cast':e.errors[path].kind})) : []; }
function evaluate(model,input) {
 const document=new models[model](input), failure=document.validateSync();
 return failure ? {errors:errors(failure)} : {document:norm(document.toObject({minimize:true,depopulate:true,flattenMaps:true}))};
}
const samples=[{}, {_id:'a',channelID:42,unknown:'discard'}, {_id:null,channelID:null},
 {entry:{term:'é😀',spellings:['a'],pattern:{id:'i',source:'x',boundary:'anywhere',ignoreCase:true},version:'v',empty:{}}},
 {entry:[{}, {nested:{},value:1}],expiresAt:'2025-01-01T00:00:00.000Z'}, {entry:null,expiresAt:'bad'},
 {terms:'single',entries:'mixed',state:'unrestricted',attempts:'2',creditsCharged:'1.5'},
 {terms:[1,true,null],entries:[{}, {nested:{},value:1},null],providerUsage:[{tokens:10,empty:{}}]},
 {terms:[{}],attempts:'bad'}, {terms:null,entries:null,providerUsage:null,error:null,attempts:null},
 {providerUsage:7,creditsCharged:0}, {providerUsage:{nested:{},keep:true}}, {providerUsage:{}},
 {createdAt:0,deadline:'2025-02-03',expiresAt:1700000000000}, {createdAt:'bad'}, {model:{_id:''}}, {model:{_id:0}}, {model:{_id:false}}, {model:{_id:null}}, {model:{_id:'model-id'}}, {model:{_id:'0'}}];
const cases=[]; for(const model of Object.keys(models)) for(const input of samples) cases.push({model,input,expected:evaluate(model,input)});
const usageCases=[{}, {providerUsage:[]}, {providerUsage:[{model:'a',tokens:2},{model:'b',nested:{cost:1}}]}, {providerUsage:null}, {providerUsage:7}, {providerUsage:[{model:'a'},7]}].map(input=>({input,expected:evaluate('job',input)}));
const indexes=Object.fromEntries(Object.entries(models).map(([key,model])=>[key,model.schema.indexes()]));
const collections=Object.fromEntries(Object.entries(models).map(([key,model])=>[key,model.collection.name]));
// Inspect bytes through the actual Node BSON writer, including malformed UTF-16.
const boundary={text:'\ud800x\udc00',nested:{n:1,fraction:1.5,wide:2147483648},negativeZero:-0};
const encoded=bson.serialize(boundary), decoded=bson.deserialize(encoded,{promoteValues:false});
const wire={hex:encoded.toString('hex'),text:decoded.text,types:{n:decoded.nested.n._bsontype,fraction:decoded.nested.fraction._bsontype,wide:decoded.nested.wide._bsontype,negativeZero:decoded.negativeZero._bsontype}};
const files=['src/schemas/moderation_variation.schema.ts','src/schemas/moderation_variation.schema.rs','src/schemas/schema.rs','src/utils/bson_compat.rs','src/utils/mongoose_date.rs','src/utils/moderation/types.rs','src/utils/js_string.rs','tests/moderation_variation_schema.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,digest(read(f))]));
for(const [key,module] of [['typescript-js','typescript'],['typescript-package','typescript/package.json'],['mongoose-js','mongoose'],['mongoose-package','mongoose/package.json']]) hashes[key]=digest(fs.readFileSync(req.resolve(module)));
hashes['bson-js']=digest(fs.readFileSync(bsonJs)); hashes['bson-package']=digest(fs.readFileSync(bsonPackage)); hashes['oracle-script']=digest(fs.readFileSync(__filename));
const mongooseDir=path.dirname(req.resolve('mongoose/package.json'));
for(const file of ['lib/schema/array.js','lib/schema/string.js','lib/schema/number.js','lib/schema/date.js','lib/schema/mixed.js','lib/document.js','lib/helpers/clone.js','lib/helpers/minimize.js']) hashes[`mongoose/${file}`]=digest(fs.readFileSync(path.join(mongooseDir,file)));
const output=JSON.stringify({format:1,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version,bson:'6.10.4'},nodeExecutableSha256:pin,sourceSha256:hashes,collections,indexes,typeEvidence,cases,usageCases,wire},null,2)+'\n';
const target=path.join(dir,name); if(mode==='--write') fs.writeFileSync(target,output,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),output);
console.log(`${name} sha256=${digest(output)} cases=${cases.length}`);
