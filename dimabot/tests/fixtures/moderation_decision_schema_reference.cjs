'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
// Actual complete source, disconnected pinned Mongoose; only its clock default is replaced.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_SCHEMA_NODE_SHA256,pin); assert.equal(sha(fs.readFileSync(process.execPath)),pin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const root=fs.realpathSync(process.env.DIMA_SCHEMA_SOURCE_ROOT); assert.equal(root,process.env.DIMA_SCHEMA_SOURCE_ROOT);
const [mode,dir,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode)&&path.isAbsolute(dir)&&!extra.length); assert.equal(fs.realpathSync(dir),dir); assert(dir!==root && !dir.startsWith(root+path.sep));
const name='moderation-decision-schema-reference.json'; assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]);
const read=f=>fs.readFileSync(leaf.sourcePath(root, f)),req=createRequire(path.join(root,'package.json'));
const ts=req('typescript'),mongoose=req('mongoose'),bsonReq=createRequire(req.resolve('mongoose')); const bsonJs=bsonReq.resolve('bson'),bsonPackage=path.join(path.dirname(bsonJs),'..','package.json'); assert.equal(ts.version,'5.9.3'); assert.equal(mongoose.version,'8.24.2'); assert.equal(JSON.parse(fs.readFileSync(bsonPackage)).version,'6.10.4');
const file='src/schemas/moderation_decision.schema.ts',source=read(file).toString('utf8');
function ast(f){const t=ts.createSourceFile(f,read(f).toString('utf8'),ts.ScriptTarget.ES2022,true); assert.deepEqual(t.parseDiagnostics,[]); return t;}
const sf=ast(file),channel=ast('src/schemas/channel_moderation_settings.schema.ts'),advanced=ast('src/utils/moderation/advanced.ts'),variations=ast('src/utils/moderation/variations.ts'),expression=ast('src/utils/permissions/expression.ts'),roles=ast('src/utils/permissions/roles.ts');
const imports=sf.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]);
assert.deepEqual(imports,[['mongoose',false],['./channel_moderation_settings.schema.js',true],['../utils/moderation/advanced.js',true]]);
function declarations(tree,names){return names.map(n=>{const v=tree.statements.find(s=>(ts.isInterfaceDeclaration(s)||ts.isTypeAliasDeclaration(s))&&s.name.text===n);assert(v,n);return v.getText(tree);}).join('\n');}
const roleConst=roles.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(roles)==='ROLE_TAGS')); assert(roleConst);
const overlays={
 'src/schemas/channel_moderation_settings.schema.ts':`import type { ModerationPattern, SemanticPolicy } from '../utils/moderation/advanced.js'; import type { ModerationVariations } from '../utils/moderation/variations.js'; import type { PermissionExpression } from '../utils/permissions/expression.js';\n${declarations(channel,['ModerationRuleType','ModerationAction','CapsThresholdMode','IModerationOffenseStep','IModerationRule'])}`,
 'src/utils/moderation/advanced.ts':`import type { SpamCategory } from './spam_categories.js';\n${declarations(advanced,['ModerationMatch','ModerationPattern','SemanticPolicy'])}`,
 'src/utils/moderation/variations.ts':`import type { ModerationPattern } from './advanced.js';\n${declarations(variations,['VariationMode','GeneratedVariation','VariationOverride','ModerationVariations'])}`,
 'src/utils/permissions/expression.ts':`import type { RoleTag } from './roles.js';\n${declarations(expression,['PermissionExpression'])}`,
 'src/utils/permissions/roles.ts':`${roleConst.getText(roles)}\n${declarations(roles,['RoleTag'])}`,
};
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']};
const host=leaf.overlaySource(ts.createCompilerHost(options),ts,root,['src/utils/moderation/spam_categories.ts']),origRead=host.readFile.bind(host),origGet=host.getSourceFile.bind(host),overlay=f=>overlays[path.relative(root,path.resolve(f)).split(path.sep).join('/')];
host.readFile=f=>overlay(f)??origRead(f);host.getSourceFile=(f,v,...rest)=>overlay(f)===undefined?origGet(f,v,...rest):ts.createSourceFile(f,overlay(f),v,true,ts.ScriptKind.TS);
assert.deepEqual(ts.getPreEmitDiagnostics(ts.createProgram([path.join(root,file)],options,host)).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
const instance=new mongoose.Mongoose();instance.set('autoCreate',false);instance.set('autoIndex',false);const api={};
new vm.Script(`(function(exports,require){${compiled.outputText}\n})`,{filename:file}).runInThisContext()(api,id=>{assert.equal(id,'mongoose');return {Schema:instance.Schema,model:instance.model.bind(instance)};});
assert.deepEqual(Object.keys(api),['ModerationDecision']);const model=api.ModerationDecision;assert.equal(model.collection.name,'moderation_decisions');
const now=1700000000000; assert.equal(model.schema.path('createdAt').defaultValue,Date.now); model.schema.path('createdAt').default(()=>now);
function norm(v){if(v instanceof Date)return {$date:v.getTime()};if(Array.isArray(v))return v.map(norm);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,norm(v[k])]));return v;}
function evaluate(input){const d=new model(input),e=d.validateSync();return e?{errors:Object.keys(e.errors).sort().map(path=>({path,kind:e.errors[path].name==='CastError'?'cast':e.errors[path].kind}))}:{document:norm(d.toObject({minimize:true,depopulate:true,flattenMaps:true}))};}
const base={channelID:'c',expiresAt:1800000000000};
const inputs=[{},base,{...base,_id:'x',unknown:1}, {...base,channelID:''},{...base,expiresAt:'bad'}, {...base,reviewSource:'bad'}, {...base,reviewSource:null}, {...base,mode:'other',state:'other',verdict:'other'}, {...base,channelID:42,inputTokens:'2',cost:'1.5',latencyMs:true}, {...base,inputTokens:'bad'}, {...base,matches:'x',context:{a:1}}, {...base,matches:[{}, {empty:{},keep:1},null],context:[{nested:{}}]}, {...base,rule:{},scores:{},charge:{},consequence:{},feedback:{}}, {...base,rule:{a:{},b:1},scores:null,charge:null,consequence:null,feedback:null}, {...base,createdAt:0,deadline:'2025-01-01'}, {...base,createdAt:'bad'}, {...base,matches:null,context:null}, {...base,providerRequestID:{_id:'x'}}];
const files=[file,'src/schemas/channel_moderation_settings.schema.ts','src/utils/moderation/advanced.ts','src/utils/moderation/variations.ts','src/utils/moderation/spam_categories.ts','src/utils/permissions/expression.ts','src/utils/permissions/roles.ts','src/schemas/moderation_decision.schema.rs','src/schemas/schema.rs','src/utils/bson_compat.rs','src/utils/mongoose_date.rs','tests/moderation_decision_schema.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,sha(read(f))]));hashes['oracle-script']=sha(fs.readFileSync(__filename)); hashes['bson-js']=sha(fs.readFileSync(bsonJs)); hashes['bson-package']=sha(fs.readFileSync(bsonPackage)); for(const m of ['typescript','typescript/package.json','mongoose','mongoose/package.json'])hashes[m]=sha(fs.readFileSync(req.resolve(m)));
const output=JSON.stringify({versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version,bson:'6.10.4'},nodeExecutableSha256:pin,sourceProvenance:leaf.provenance(root,["src/utils/moderation/spam_categories.ts"]),sourceSha256:hashes,imports,compiledSha256:sha(compiled.outputText),model:model.modelName,collection:model.collection.name,indexes:model.schema.indexes(),now,cases:inputs.map(input=>({input,expected:evaluate(input)}))},null,2)+'\n';
const target=path.join(dir,name);if(mode==='--write')fs.writeFileSync(target,output,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),output);console.log(`${name} sha256=${sha(output)} cases=${inputs.length}`);
