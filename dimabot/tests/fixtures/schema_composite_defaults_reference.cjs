#!/usr/bin/env node
'use strict';
// Disconnected, pinned Mongoose constructor + validateSync oracle. No services.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), vm = require('node:vm');
const {createRequire} = require('node:module');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const pin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_SCHEMA_NODE_SHA256,pin);
assert.equal(digest(fs.readFileSync(process.execPath)),pin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const rootArg=process.env.DIMA_SCHEMA_SOURCE_ROOT; assert(rootArg && path.isAbsolute(rootArg));
const root=fs.realpathSync(rootArg); assert.equal(root,rootArg);
const [mode,dirArg,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode) && dirArg && !extra.length && path.isAbsolute(dirArg));
const dir=fs.realpathSync(dirArg); assert.equal(dir,dirArg); assert(fs.statSync(dir).isDirectory() && dir!==root && !dir.startsWith(root+path.sep));
const name='schema-composite-defaults-reference.json'; assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]);
if(mode==='--check') assert(fs.lstatSync(path.join(dir,name)).isFile());
const read=f=>fs.readFileSync(path.join(root,f));
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript'), mongoose=req('mongoose');
const mongooseRequire=createRequire(req.resolve('mongoose'));
const bsonJs=mongooseRequire.resolve('bson');
const bsonPackage=path.join(path.dirname(bsonJs),'..','package.json');
const bsonVersion=JSON.parse(fs.readFileSync(bsonPackage,'utf8')).version;
assert.equal(ts.version,'5.9.3'); assert.equal(req('mongoose/package.json').version,'8.24.2'); assert.equal(bsonVersion,'6.10.4');
const instance=new mongoose.Mongoose();
const {Schema}=instance;
const step=new Schema({action:{type:String,enum:['off','warn','delete','timeout','ban'],default:'warn'},timeoutSeconds:{type:Number,default:60,min:1,max:1209600}},{_id:false});
const synthetic=new Schema({
 first:{type:step,default:()=>({action:'warn',timeoutSeconds:60})},
 second:{type:step,default:()=>({action:'delete',timeoutSeconds:60})},
 third:{type:step,default:()=>({action:'timeout',timeoutSeconds:60})},
 categories:{type:[{type:String,enum:['spam','ads','self_promotion','profanity','insults']}],default:()=>['spam','ads','self_promotion']},
 exemptTags:{type:[{type:String,enum:['vip','mod','sub','founder','editor','admin']}],default:()=>['mod','editor','admin']},
 weights:{type:[{type:Number,min:1,max:10}],default:()=>[2,3]},
 codes:{type:[{type:String,enum:['ok','wide'],maxlength:2}],default:()=>[]},
 variations:{type:Schema.Types.Mixed,default:()=>({mode:'off',entries:[]})},
},{_id:false,versionKey:false});
const emptySub=new Schema({},{_id:false});
const emptySchema=new Schema({
 mixed:{type:Schema.Types.Mixed,default:()=>({})},
 single:{type:emptySub,default:()=>({})},
 children:{type:[emptySub],default:()=>[{}]},
 map:{type:Map,of:String,default:()=>({})},
},{_id:false,versionKey:false});
const elementDefaultSchema=new Schema({values:{type:[{type:String,enum:['ads','spam'],default:'ads'}],default:()=>[]}},{_id:false,versionKey:false});
const models={composite:instance.model('composite_fixture',synthetic), empty:instance.model('empty_fixture',emptySchema)};
const elementDefaultModel=instance.model('element_default_fixture',elementDefaultSchema);
function norm(value) {
 if(value instanceof Date) return {$date:value.getTime()};
 if(value && value._bsontype==='ObjectId') return {$oid:value.toHexString()};
 if(Array.isArray(value)) return value.map(norm);
 if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,norm(value[key])]));
 return value;
}
function errors(error) { return error ? Object.keys(error.errors).sort().map(path=>({path,kind:error.errors[path].name==='CastError'?'cast':error.errors[path].kind})) : []; }
function evaluate(model,input) {
 const document=new models[model](input);
 const failure=document.validateSync();
 return failure ? {errors:errors(failure)} : {document:norm(document.toObject({minimize:true,depopulate:true,flattenMaps:true}))};
}
const inputs=[{}, {first:null,second:null,third:null,categories:null,exemptTags:null,weights:null,variations:null},
 {first:{},second:{},third:{}},{first:{action:'ban'},second:{timeoutSeconds:'10'},third:{action:'off',timeoutSeconds:'2'}},
 {variations:{mode:'custom',entries:['a',{source:'x'}]}},{variations:{}},{variations:{mode:'off',entries:[]}},
 {categories:'spam'},{categories:'unknown'},{categories:[null,'spam',null]},{categories:[2,true]},{categories:[{_id:'ads'}]},
 {categories:['bad','ads','also-bad']},{categories:['bad',{},'also-bad']},{categories:[{},'bad',{}]},
 {weights:'3'},{weights:[null,0,11,'3']},{weights:['bad',3]},{weights:[0,'bad',11]},
 {codes:['bad','wide','ok',null]},
 {second:{action:'invalid',timeoutSeconds:0}},{second:{action:null,timeoutSeconds:null}},{second:{action:5}},{third:'bad'}];
const enums=['spam','ads','self_promotion','profanity','insults','bad','',null,0,1,true,false];
for(const a of enums) for(const b of ['spam','bad',null,1]) inputs.push({categories:[a,b]});
const cases=inputs.map(input=>({model:'composite',input,expected:evaluate('composite',input)}));
const emptyInputs=[{}, {mixed:{},single:{},children:[{}],map:{}}, {mixed:null,single:null,children:null,map:null}, {mixed:{nested:{}},single:{unknown:'discarded'},children:[{unknown:'discarded'},{}],map:{a:4}},{children:[]},{children:{}},
 {mixed:{nested:{deeper:{}}}}, {mixed:{drop:{},keep:{value:1,empty:{}},null:null}},
 {mixed:{array:[{}, {nested:{}}, {nested:{value:1,empty:{}}}, null, [], [{}], [{nested:{}}]]}},
 {mixed:[{}, {nested:{}}, null, [{nested:{}}]]}, {mixed:{array:[],null:null}},
 {mixed:{nested:{array:[{empty:{}}],null:null}}},
 {mixed:JSON.parse('{"constructor":1,"prototype":2,"__proto__":3,"keep":4}')},
 {mixed:{constructor:1,nested:{empty:{}},keep:1}},
 {mixed:{constructor:true,nested:{empty:{}}}}, {mixed:{constructor:'name',nested:{}}},
 {mixed:{constructor:0,nested:{},keep:1}}, {mixed:{constructor:false,nested:{},keep:1}},
 {mixed:{constructor:null,nested:{},keep:1}}, {mixed:{constructor:'',nested:{},keep:1}},
 {mixed:{constructor:{name:'Object'},nested:{},keep:1}},
 {mixed:{constructor:1,valueOf:0,nested:{},keep:1}},
 {mixed:{constructor:1,valueOf:null,nested:{},keep:1}},
 {mixed:{array:[{constructor:1,nested:{}},{constructor:0,nested:{}},
                {constructor:1,valueOf:false,nested:{}},{constructor:1,nested:[{empty:{}}]}]}},
 {mixed:{outer:{constructor:1,nested:{empty:{}}},other:{constructor:0,nested:{}}}}];
for(const input of emptyInputs) cases.push({model:'empty',input,expected:evaluate('empty',input)});
// Undefined and sparse slots cannot be represented by ordinary JSON input;
// record their actual Mongoose behavior separately without equating them to
// BSON null or inventing expected results.
const sparse=[]; sparse.length=1;
const elementDefaults=[['undefined',[undefined]],['null',[null]],['sparse',sparse],['empty',[]]].map(([label,values])=>{
 const doc=new elementDefaultModel({values}); const failure=doc.validateSync();
 return {label,errors:errors(failure),document:norm(doc.toObject({minimize:true,flattenMaps:true})),slots:doc.values.map(value=>value===undefined?'undefined':value===null?'null':typeof value)};
});
// Compile the actual source module, including its real pure constant dependency.
const spamSource=read('src/utils/moderation/spam_categories.ts');
const moderationSource=read('src/schemas/channel_moderation_settings.schema.ts');
function compile(source,filename,imports) {
 const text=source.toString('utf8');
 const sf=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS); assert.equal(sf.parseDiagnostics.length,0);
 const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={}; const require=name=>{assert(Object.hasOwn(imports,name),`disallowed import ${name}`);return imports[name];};
 new vm.Script(`(function(exports,require){${js}\n})`,{filename}).runInThisContext()(exports,require);
 return exports;
}
const spam=compile(spamSource,'spam_categories.ts',{});
assert.deepEqual(spam.DEFAULT_SPAM_CATEGORIES,['spam','ads','self_promotion']);
assert.deepEqual(spam.DEFAULT_SPAM_EXEMPT_TAGS,['mod','editor','admin']);
const actual=compile(moderationSource,'channel_moderation_settings.schema.ts',{
 '../utils/moderation/spam_categories.js':spam, 'crypto':crypto,
 'mongoose':{Schema:instance.Schema,model:instance.model.bind(instance)}
});
assert(actual.ChannelModerationSettingsSchema && typeof actual.buildDefaultModerationRules==='function');
const actualInputs=[{channelID:'c',rules:[{id:'r',type:'caps'}]},
 {channelID:'c',spamProtection:{categories:['bad'],exemptTags:['invalid']},rules:[{id:'r',type:'caps'}]},
 {channelID:'c',spamProtection:{categories:['spam',null],exemptTags:['mod']},rules:[{id:'r',type:'caps',secondOffense:{action:'ban'},variations:{mode:'custom',entries:['x']}}]},
 {channelID:'c',spamProtection:null,rules:[{id:'r',type:'caps',secondOffense:null,thirdOffense:{}}]}];
const actualCases=actualInputs.map(input=>{
 const doc=new actual.ChannelModerationSettingsSchema({...input,_id:'507f1f77bcf86cd799439011'});
 const failure=doc.validateSync(), object=doc.toObject({minimize:true,depopulate:true,flattenMaps:true});
 const rule=object.rules?.[0];
 const selected=norm({spamProtection:object.spamProtection,first:rule?.firstOffense,second:rule?.secondOffense,third:rule?.thirdOffense,variations:rule?.variations});
 return {input,selected,errors:errors(failure)};
});
// Mutation of one constructed document must not alter a later constructor.
const a=new models.composite(), b=new models.composite();
a.categories.push('insults'); a.variations.entries.push('local'); a.second.action='ban';
const cloneEvidence={mutated:norm(a.toObject({minimize:true,flattenMaps:true})),independent:norm(b.toObject({minimize:true,flattenMaps:true})),fresh:evaluate('composite',{}).document};
assert.deepEqual(cloneEvidence.independent,cloneEvidence.fresh);
const files=['src/schemas/schema.rs','src/schemas/channel_moderation_settings.schema.ts','src/utils/moderation/spam_categories.ts','src/utils/bson_compat.rs','src/utils/mongoose_date.rs','src/utils/json_number.rs','src/utils/js_compat.rs','tests/schema_composite_defaults.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,digest(read(f))]));
for(const [key,module] of [['typescript-js','typescript'],['typescript-package','typescript/package.json'],['mongoose-js','mongoose'],['mongoose-package','mongoose/package.json']]) hashes[key]=digest(fs.readFileSync(req.resolve(module)));
hashes['bson-js']=digest(fs.readFileSync(bsonJs)); hashes['bson-package']=digest(fs.readFileSync(bsonPackage));
const mongooseDir=path.dirname(req.resolve('mongoose/package.json'));
for (const file of ['lib/schema/array.js','lib/schema/string.js','lib/schemaType.js','lib/document.js','lib/helpers/document/applyDefaults.js','lib/helpers/minimize.js','lib/helpers/clone.js','lib/helpers/specialProperties.js','lib/helpers/getFunctionName.js','lib/helpers/isObject.js','lib/helpers/isPOJO.js']) hashes[`mongoose/${file}`]=digest(fs.readFileSync(path.join(mongooseDir,file)));
hashes['oracle-script']=digest(fs.readFileSync(__filename));
const output=JSON.stringify({format:1,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version,bson:bsonVersion},nodeExecutableSha256:pin,sourceSha256:hashes,cases,actualCases,elementDefaults,cloneEvidence},null,2)+'\n';
const target=path.join(dir,name); if(mode==='--write') fs.writeFileSync(target,output,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),output);
console.log(`${name} sha256=${digest(output)} cases=${cases.length} actualCases=${actualCases.length}`);
