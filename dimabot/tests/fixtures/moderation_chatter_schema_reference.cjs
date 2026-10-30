'use strict';
// Focused oracle for the complete actual moderation_chatter schema module.
// It compiles the live TypeScript source with pinned TypeScript, executes it in
// a restricted CommonJS boundary against a disconnected pinned Mongoose
// instance, and records real Mongoose cast/validation/document behavior.
// Nothing here connects to MongoDB or any production service.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const assert=require('node:assert/strict'),{createRequire}=require('node:module');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const nodeSha256='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_SCHEMA_NODE_SHA256,nodeSha256);
assert.equal(digest(fs.readFileSync(process.execPath)),nodeSha256);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const rootArg=process.env.DIMA_SCHEMA_SOURCE_ROOT;
assert(rootArg&&path.isAbsolute(rootArg),'DIMA_SCHEMA_SOURCE_ROOT must be absolute');
const root=fs.realpathSync(rootArg);
assert.equal(root,rootArg);
const [mode,dirArg,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode)&&dirArg&&!extra.length&&path.isAbsolute(dirArg));
const dir=fs.realpathSync(dirArg);
assert.equal(dir,dirArg);
const workspace=path.dirname(root);
assert(fs.statSync(dir).isDirectory());
assert(dir!==root&&!dir.startsWith(root+path.sep));
assert(dir!==workspace&&!dir.startsWith(workspace+path.sep));
const name='moderation-chatter-schema-reference.json';
// Exactly one exclusive output file; --write requires an empty canonical dir.
assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]);
if(mode==='--check')assert(fs.lstatSync(path.join(dir,name)).isFile());
const read=f=>fs.readFileSync(path.join(root,f));
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript'),mongoose=req('mongoose');
const bsonReq=createRequire(req.resolve('mongoose'));
const bson=bsonReq('bson'),bsonJs=bsonReq.resolve('bson');
const bsonPackage=path.join(path.dirname(bsonJs),'..','package.json');
assert.equal(ts.version,'5.9.3');
assert.equal(mongoose.version,'8.24.2');
const bsonVersion=JSON.parse(fs.readFileSync(bsonPackage,'utf8')).version;
assert.equal(bsonVersion,'6.10.4');
assert.equal(fs.realpathSync(req.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
assert.equal(fs.realpathSync(req.resolve('mongoose')),fs.realpathSync(path.join(root,'node_modules/mongoose/index.js')));

// Live source is resolved strictly: exactly one regular file at the live path.
const file='src/schemas/moderation_chatter.schema.ts';
const sourceSha256Pin='71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e';
const live=path.join(root,file);
const liveStat=fs.lstatSync(live);
assert(liveStat.isFile(),'live schema source must be a regular file');
const archived=path.join(root,'..','archives/dimabot-typescript/2026-10-28',file);
let archivedStat=null;
try{archivedStat=fs.lstatSync(archived);}catch(error){if(error.code!=='ENOENT')throw error;}
assert.equal(archivedStat,null,'live source must not be shadowed by an archive copy');
const sourceBytes=read(file);
assert.equal(digest(sourceBytes),sourceSha256Pin);
const source=sourceBytes.toString('utf8');

// Source/type/import/export metadata from the actual TypeScript AST.
const tree=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
assert.deepEqual(tree.parseDiagnostics,[]);
const imports=tree.statements.filter(ts.isImportDeclaration).map(s=>({module:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,bindings:s.importClause?.getText(tree)}));
assert.deepEqual(imports,[{module:'mongoose',typeOnly:false,bindings:'{ Schema, model }'}]);
for(const statement of tree.statements){
  assert(!ts.isInterfaceDeclaration(statement)&&!ts.isTypeAliasDeclaration(statement),'no separate type declarations expected');
}
const exported=tree.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
assert.equal(exported.length,1);
assert(ts.isVariableStatement(exported[0]));
const declarations=exported[0].declarationList.declarations;
assert.equal(declarations.length,1);
assert.equal(declarations[0].name.getText(tree),'ModerationChatter');
const initializer=declarations[0].initializer;
assert(ts.isCallExpression(initializer)&&initializer.expression.getText(tree)==='model');
assert.deepEqual(initializer.arguments.map(argument=>argument.getText(tree)),["'moderation_chatter'",'schema']);
const normalized=text=>text.replace(/\s+/g,' ').trim();
const schemaDeclaration=tree.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(tree)==='schema'));
assert(schemaDeclaration&&!schemaDeclaration.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
const schemaInit=schemaDeclaration.declarationList.declarations[0].initializer;
assert(ts.isNewExpression(schemaInit)&&schemaInit.expression.getText(tree)==='Schema');
assert.deepEqual(schemaInit.arguments.map(argument=>normalized(argument.getText(tree))),[
  '{ _id: { type: String, required: true }, firstSeenAt: { type: Date, required: true } }',
  '{ versionKey: false }',
]);

// Full type check of the complete module against the pinned Mongoose types.
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']};
const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram([live],compilerOptions));
assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);

// Compile and execute the full module in a restricted boundary. Only the
// `mongoose` import is provided, from a disconnected instance.
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
assert.deepEqual(compiled.diagnostics,[]);
const instance=new mongoose.Mongoose();
instance.set('autoCreate',false);
instance.set('autoIndex',false);
assert.equal(instance.connection.readyState,0);
const api={},requiredImports=[];
new vm.Script(`(function(exports,require){${compiled.outputText}\n})`,{filename:file}).runInThisContext()(api,id=>{
  requiredImports.push(id);
  assert.equal(id,'mongoose');
  return {Schema:instance.Schema,model:instance.model.bind(instance)};
});
assert.deepEqual(requiredImports,['mongoose']);
assert.deepEqual(Object.keys(api),['ModerationChatter']);
assert.equal(instance.connection.readyState,0);
const model=api.ModerationChatter;

const modelMetadata={
  modelName:model.modelName,
  collection:model.collection.name,
  connectionReadyState:instance.connection.readyState,
  versionKey:model.schema.options.versionKey,
  indexes:model.schema.indexes(),
  paths:Object.keys(model.schema.paths),
  fields:Object.keys(model.schema.paths).map(property=>({
    path:property,
    instance:model.schema.path(property).instance,
    required:model.schema.path(property).isRequired,
    hasDefault:model.schema.path(property).defaultValue!==undefined,
  })),
  collectionOption:model.schema.options.collection===undefined?null:model.schema.options.collection,
};

const fixedNow=1700000000000;
function norm(value){
  if(value instanceof Date)return {$date:value.getTime()};
  if(Array.isArray(value))return value.map(norm);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,norm(value[key])]));
  return value;
}
function errors(failure){
  return failure?Object.keys(failure.errors).sort().map(property=>({
    path:property,
    kind:failure.errors[property].name==='CastError'||failure.errors[property].kind==='CastError'?'cast':failure.errors[property].kind,
  })):[];
}
function evaluate(input){
  const document=new model(input),failure=document.validateSync();
  return failure?{errors:errors(failure)}:{document:norm(document.toObject({minimize:true,depopulate:true,flattenMaps:true}))};
}
// Focused model contract cases: required/missing/null, String casts, Date
// casts and JS Date extremes, unknown fields, defaults, version key, indexes.
const samples=[
  ['empty',{}],
  ['missing-first-seen',{_id:'marker'}],
  ['missing-id',{firstSeenAt:0}],
  ['null-both',{_id:null,firstSeenAt:null}],
  ['null-first-seen',{_id:'marker',firstSeenAt:null}],
  ['empty-id',{_id:'',firstSeenAt:0}],
  ['valid-epoch',{_id:'marker',firstSeenAt:0}],
  ['valid-now',{_id:'marker',firstSeenAt:fixedNow}],
  ['valid-iso',{_id:'marker',firstSeenAt:'2025-01-01T00:00:00.000Z'}],
  ['valid-max-date',{_id:'marker',firstSeenAt:8640000000000000}],
  ['valid-min-date',{_id:'marker',firstSeenAt:-8640000000000000}],
  ['fractional-ms',{_id:'marker',firstSeenAt:1.9}],
  ['negative-fractional-ms',{_id:'marker',firstSeenAt:-1.9}],
  ['empty-string-date',{_id:'marker',firstSeenAt:''}],
  ['invalid-string-date',{_id:'marker',firstSeenAt:'not-a-date'}],
  ['beyond-max-date',{_id:'marker',firstSeenAt:8640000000000001}],
  ['beyond-min-date',{_id:'marker',firstSeenAt:-8640000000000001}],
  ['id-number',{_id:42,firstSeenAt:0}],
  ['id-fraction',{_id:42.5,firstSeenAt:0}],
  ['id-true',{_id:true,firstSeenAt:0}],
  ['id-false',{_id:false,firstSeenAt:0}],
  ['id-zero',{_id:0,firstSeenAt:0}],
  ['id-wide-number',{_id:1e21,firstSeenAt:0}],
  ['unknown-fields',{_id:'marker',firstSeenAt:0,unknown:'discard',nested:{value:1},__v:9}],
  ['unknown-only',{_id:'marker',firstSeenAt:0,other:{}}],
];
const cases=samples.map(([id,input])=>({id,input,expected:evaluate(input)}));
assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);

// Explicit typed BSON boundary through the actual Node BSON writer.
const wireDocument={_id:'\ud800x\udc00',firstSeenAt:new Date(1735689600123)};
const wireBytes=bson.serialize(wireDocument),wireDecoded=bson.deserialize(wireBytes);
const wire={
  hex:wireBytes.toString('hex'),
  decodedId:wireDecoded._id,
  firstSeenAtMs:wireDecoded.firstSeenAt.getTime(),
  maxDateMs:8640000000000000,
  minDateMs:-8640000000000000,
};

const files=[
  file,
  'src/schemas/moderation_chatter.schema.rs',
  'src/schemas/schema.rs',
  'src/utils/bson_compat.rs',
  'src/utils/mongoose_date.rs',
  'src/utils/js_date/mod.rs',
  'src/utils/js_date/parser.rs',
  'src/utils/json_number.rs',
  'src/utils/js_string.rs',
  'src/utils/moderation/spam.rs',
  'tests/moderation_chatter_schema.rs',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'package.json',
  'package-lock.json',
];
const sourceSha256=Object.fromEntries(files.map(f=>[f,digest(f===file?sourceBytes:read(f))]));
sourceSha256['oracle-script']=digest(fs.readFileSync(__filename));
for(const [key,module] of [['typescript-js','typescript'],['typescript-package','typescript/package.json'],['mongoose-js','mongoose'],['mongoose-package','mongoose/package.json']])sourceSha256[key]=digest(fs.readFileSync(req.resolve(module)));
const mongooseRoot=path.dirname(req.resolve('mongoose/package.json'));
for(const relative of ['index.js','lib/mongoose.js','lib/schema/string.js','lib/schema/date.js','lib/document.js','lib/helpers/clone.js']){
  sourceSha256[`mongoose/${relative}`]=digest(fs.readFileSync(path.join(mongooseRoot,relative)));
}
sourceSha256['bson-js']=digest(fs.readFileSync(bsonJs));
sourceSha256['bson-package']=digest(fs.readFileSync(bsonPackage));

const reference={
  format:1,
  metadata:{
    format:1,
    nodeExecutableSha256:nodeSha256,
    versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version,bson:bsonVersion},
    source:{logical:file,virtualPath:live,provenance:'live',sha256:sourceSha256Pin},
    boundary:'Complete actual live TypeScript module compiled with pinned TypeScript and executed in a restricted CommonJS boundary with only the disconnected pinned Mongoose import. Ordinary JSON-like inputs; no accessors, symbols, proxies, functions, BigInt or cycles. Only Mongoose validation and document construction are exercised; no connection, index creation, query, or write occurs.',
    caseCount:cases.length,
  },
  sourceMetadata:{
    imports,
    export:{kind:'VariableStatement',symbol:'ModerationChatter',initializer:'model',modelName:'moderation_chatter'},
    runtimeKeys:Object.keys(api),
    typeDeclarations:[],
    typecheckDiagnostics:diagnostics.length,
    compiledSha256:digest(compiled.outputText),
  },
  modelMetadata,
  constants:{modelName:'moderation_chatter',collection:'moderation_chatters',versionKey:false,indexCount:0,stringID:true},
  cases,
  wire,
  sourceSha256,
};
const output=JSON.stringify(reference,null,2)+'\n';
const target=path.join(dir,name);
if(mode==='--write')fs.writeFileSync(target,output,{flag:'wx'});
else assert.equal(fs.readFileSync(target,'utf8'),output);
console.log(JSON.stringify({mode,name,sha256:digest(output),cases:cases.length,modelMetadata}));
