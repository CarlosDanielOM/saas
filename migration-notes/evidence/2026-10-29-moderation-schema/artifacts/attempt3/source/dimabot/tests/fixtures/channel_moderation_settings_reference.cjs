'use strict';
// Actual unchanged TypeScript module, real pinned Mongoose, no database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),assert=require('node:assert/strict');
const root=fs.realpathSync(process.env.DIMA_MODERATION_SCHEMA_SOURCE_ROOT || path.join(__dirname,'../..'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');const read=f=>fs.readFileSync(path.join(root,f));
const pins={
 'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'src/utils/moderation/spam_categories.ts':'29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088',
 'src/utils/moderation/variations.ts':'f7a21881289f63a50de733df232570c00f851333d5762ef39e1258915287580e',
 'src/utils/moderation/advanced.ts':'e88c52a8662a1531bdca981129e91f9cfe3b84c2543f11d38584652aede8a4d7',
 'src/utils/permissions/expression.ts':'34a3d2900bbad64bde838504e16a73f361bf7d317ef4089dcbf58fe0b1e79ab2',
 'src/utils/permissions/roles.ts':'9469ce3029c6aedce85cc7a6ad3c180adf097051ef6d5c1aa0cac68b7396df20',
 'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
 'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
 'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
 'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
 'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
 'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
 'node_modules/mongoose/index.js':'59e21822580047abc5468d740b720d1383fa3569aa2da3ac70325265fbb0e25b',
};
for(const [file,digest] of Object.entries(pins))assert.equal(sha(read(file)),digest,file);
const nodePin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_MODERATION_SCHEMA_NODE_SHA256,nodePin);assert.equal(sha(fs.readFileSync(process.execPath)),nodePin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local=Module.createRequire(path.join(root,'package.json')),ts=local('typescript'),mongoose=local('mongoose');assert.equal(ts.version,'5.9.3');assert.equal(mongoose.version,'8.24.2');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
assert.equal(fs.realpathSync(local.resolve('mongoose')),fs.realpathSync(path.join(root,'node_modules/mongoose/index.js')));
const schemaFile='src/schemas/channel_moderation_settings.schema.ts',spamFile='src/utils/moderation/spam_categories.ts';
const source=read(schemaFile).toString('utf8'),spam=read(spamFile).toString('utf8');
function ast(file){const a=ts.createSourceFile(file,read(file).toString('utf8'),ts.ScriptTarget.ES2022,true);assert.deepEqual(a.parseDiagnostics,[]);return a;}
const sf=ast(schemaFile),spamAst=ast(spamFile),advanced=ast('src/utils/moderation/advanced.ts'),variations=ast('src/utils/moderation/variations.ts'),expression=ast('src/utils/permissions/expression.ts'),roles=ast('src/utils/permissions/roles.ts');
const imports=sf.statements.filter(ts.isImportDeclaration).map(s=>({path:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,text:s.getText(sf)}));
assert.deepEqual(imports.map(i=>[i.path,i.typeOnly]),[['../utils/moderation/spam_categories.js',false],['../utils/moderation/variations.js',true],['crypto',false],['mongoose',false],['../utils/permissions/expression.js',true],['../utils/moderation/advanced.js',true]]);
function declarations(tree,names){return names.map(name=>{const item=tree.statements.find(s=>(ts.isTypeAliasDeclaration(s)||ts.isInterfaceDeclaration(s))&&s.name.text===name);assert(item,`missing type ${name}`);return item.getText(tree);}).join('\n');}
const roleConst=roles.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(roles)==='ROLE_TAGS'));assert(roleConst);
// Type-only dependencies are declarations extracted directly from actual ASTs;
// their unrelated runtime imports are not loaded or stubbed into the module.
const overlays={
 'src/utils/moderation/advanced.ts':`import type { SpamCategory } from './spam_categories.js';\n${declarations(advanced,['ModerationPattern','SemanticPolicy'])}`,
 'src/utils/moderation/variations.ts':`import type { ModerationPattern } from './advanced.js';\n${declarations(variations,['VariationMode','GeneratedVariation','VariationOverride','ModerationVariations'])}`,
 'src/utils/permissions/expression.ts':`import type { RoleTag } from './roles.js';\n${declarations(expression,['PermissionExpression'])}`,
 'src/utils/permissions/roles.ts':`${roleConst.getText(roles)}\n${declarations(roles,['RoleTag'])}`,
};
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']};
const host=ts.createCompilerHost(options),origRead=host.readFile.bind(host),origGet=host.getSourceFile.bind(host);
const overlayFor=file=>overlays[path.relative(root,path.resolve(file)).split(path.sep).join('/')];
host.readFile=file=>overlayFor(file)??origRead(file);
host.getSourceFile=(file,version,...rest)=>{const text=overlayFor(file);return text===undefined?origGet(file,version,...rest):ts.createSourceFile(file,text,version,true,ts.ScriptKind.TS);};
const program=ts.createProgram([path.join(root,schemaFile)],options,host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const instance=new mongoose.Mongoose();instance.set('autoCreate',false);instance.set('autoIndex',false);
const localMongoose={Schema:instance.Schema,model:instance.model.bind(instance)};
const compiled={};
function load(name,text,required){const out=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});assert.deepEqual(out.diagnostics,[]);compiled[name]=sha(out.outputText);const m=new Module(path.join(root,name),module);m.filename=path.join(root,name);m.require=id=>{assert(Object.hasOwn(required,id),`unexpected runtime import ${id}`);return required[id];};m._compile(out.outputText,m.filename);return m.exports;}
const spamApi=load(spamFile,spam,{});
const api=load(schemaFile,source,{'../utils/moderation/spam_categories.js':spamApi,'crypto':crypto,'mongoose':localMongoose});
const expectedExports=['MODERATION_OFFENSE_DEFAULTS','MODERATION_RULE_DEFAULTS','MODERATION_SETTINGS_DEFAULTS','MAX_TIMEOUT_SECONDS','MIN_OFFENSE_WINDOW_SECONDS','MAX_OFFENSE_WINDOW_SECONDS','MAX_RULES_PER_CHANNEL','MAX_BLACKLIST_TERMS','MAX_ALLOWLIST_DOMAINS','buildDefaultModerationRules','ChannelModerationSettingsSchema'];
assert.deepEqual(Object.keys(api).sort(),expectedExports.sort());
const model=api.ChannelModerationSettingsSchema;
const rules=api.buildDefaultModerationRules(),other=api.buildDefaultModerationRules();assert.equal(rules.length,4);
const all=[...rules,...other];assert.equal(new Set(all.map(r=>r.id)).size,8);assert(all.every(r=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.id)));
const builder=JSON.parse(JSON.stringify(rules.map((r,i)=>({...r,id:`<UUID:${i}>`}))));
const aliases={withinFirst:rules.every(r=>r.firstOffense===rules[0].firstOffense),withinSecond:rules.every(r=>r.secondOffense===rules[0].secondOffense),withinThird:rules.every(r=>r.thirdOffense===rules[0].thirdOffense),withinAllowlist:rules.every(r=>r.allowlistDomains===rules[0].allowlistDomains),withinTerms:rules.every(r=>r.terms===rules[0].terms),betweenCallsFirst:rules[0].firstOffense===other[0].firstOffense,betweenCallsAllowlist:rules[0].allowlistDomains===other[0].allowlistDomains};
rules[0].allowlistDomains.push('MUTATION');rules[0].firstOffense.timeoutSeconds=123;aliases.mutationObserved=rules[3].allowlistDomains[0]==='MUTATION'&&rules[3].firstOffense.timeoutSeconds===123;aliases.freshUnaffected=other[0].allowlistDomains.length===0&&other[0].firstOffense.timeoutSeconds===60;
const defaults={offense:api.MODERATION_OFFENSE_DEFAULTS,rule:api.MODERATION_RULE_DEFAULTS,settings:api.MODERATION_SETTINGS_DEFAULTS,limits:Object.fromEntries(expectedExports.filter(x=>x.startsWith('MAX_')||x.startsWith('MIN_')).map(x=>[x,api[x]])),builder,aliases};
const inputs=[{}, {channelID:'x'}, {channelID:''},{channelID:null},{channelID:42},
 {channelID:'x',spamProtection:null,rules:null},{channelID:'x',spamProtection:{},rules:[{id:'a',type:'caps'}]},
 {channelID:'x',rules:[{id:'a',type:'links',firstOffense:{},secondOffense:{},thirdOffense:{},patterns:[{}],semantic:{},variations:{},exemptExpression:{}}]},
 {channelID:'x',rules:[{id:'',type:'bad',reason:'x'.repeat(501),exemptUserLevel:0,minCapsCount:501,maxCapsPercentage:0,minMessageLength:0,maxEmoteCount:101}]},
 {channelID:'x',spamProtection:{categories:['invalid'],exemptTags:['bad'],thresholdPercent:79}},
 {channelID:'x',spamProtection:{categories:'spam',exemptTags:'vip',thresholdPercent:'100'},rules:{id:1,type:'caps',enabled:'false',terms:'abc',allowlistDomains:5}},
 {channelID:'x',rules:[{id:'a',type:'blacklist',patterns:[{id:1,source:'a',boundary:'strange',ignoreCase:'yes',unknown:1}],semantic:{thresholdPercent:101,policy:'x'.repeat(2001),examples:[{message:1,label:'other'}],onUncertain:'deny'}}]},
 {channelID:'x',offenseWindowSeconds:59},{channelID:'x',offenseWindowSeconds:86401},{channelID:'x',spamProtection:{enabled:'invalid'}},
 {channelID:'x',rules:[{id:'a',type:'caps',firstOffense:null,secondOffense:{action:'bad',timeoutSeconds:0},thirdOffense:{timeoutSeconds:1209601},exemptExpression:{or:[{role:'vip'},42]},variations:{mode:'broad',strange:'\ud800'}}]},
 {channelID:'x',rules:[{id:'a',type:'caps',reason:'😀'.repeat(250)}]},{channelID:'x',rules:[{id:'a',type:'caps',reason:'😀'.repeat(251)}]},
];
inputs.push({channelID:'x',rules:[{id:'a',type:'caps',exemptExpression:{nested:{}},variations:{nested:{}}}]},
 {channelID:'x',rules:[{id:'a',type:'caps',exemptExpression:{keep:null,drop:{nested:{}},array:[{}, {drop:{},keep:1}]},variations:{entries:[{}, {empty:{}}]}}]});
for(const field of ['minCapsCount','minMessageLength','maxCapsPercentage','maxEmoteCount'])for(const value of [null,'',0,1,100,500,501,'12','invalid']) inputs.push({channelID:'x',rules:[{id:'a',type:'caps',[field]:value}]});
// BSON string encoding replaces unpaired UTF-16 units. Keep the original
// input JSON as a quoted string and separately project the persisted boundary.
function bsonStringBoundary(v){
 if(typeof v==='string')return Buffer.from(v,'utf8').toString('utf8');
 if(Array.isArray(v))return v.map(bsonStringBoundary);
 if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[Buffer.from(k,'utf8').toString('utf8'),bsonStringBoundary(x)]));
 return v;
}
function snapshot(input){const doc=new model({...input,_id:'507f1f77bcf86cd799439011'});const error=doc.validateSync();const errors=error?Object.entries(error.errors).map(([key,e])=>({path:key,kind:e.kind||e.name})).sort((a,b)=>a.path.localeCompare(b.path)):[];const plain=JSON.parse(JSON.stringify(doc.toObject()));return {input:bsonStringBoundary(input),rawInputJson:JSON.stringify(input),document:bsonStringBoundary(plain),errors};}
const cases=inputs.map(snapshot);
const a=new model({channelID:'a'}),b=new model({channelID:'b'});a.spamProtection.categories.push('insults');const independence={otherCategories:[...b.spamProtection.categories],differentInstances:a.spamProtection!==b.spamProtection};
const nativeFiles=['src/schemas/channel_moderation_settings.schema.rs','src/schemas/schema.rs','src/utils/moderation/spam_categories.rs','src/utils/moderation/caps.rs','tests/channel_moderation_settings_schema.rs','tests/channel_moderation_settings_store.rs','tests/fixtures/channel_moderation_settings_reference.cjs','Cargo.toml','Cargo.lock'];
const hashes=Object.fromEntries(nativeFiles.map(f=>[f,sha(read(f))]));hashes['src/utils/permissions/roles.ts']=sha(read('src/utils/permissions/roles.ts'));
const metadata={format:1,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version},nodeSha:nodePin,pins,hashes,compiled,imports,model:model.modelName,collection:model.collection.name,timestamps:model.schema.options.timestamps,indexes:model.schema.indexes(),cases:cases.length};
const output=JSON.stringify({metadata,defaults,independence,cases},null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&!extra.length);
const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(root,'..'));assert(real!==workspace&&!real.startsWith(workspace+path.sep));
const file=path.join(real,'channel-moderation-settings-reference.json');assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(file)]);
if(mode==='--write')fs.writeFileSync(file,output,{flag:'wx'});else assert.equal(fs.readFileSync(file,'utf8'),output);
console.log(JSON.stringify({mode,sha256:sha(output),cases:cases.length}));
