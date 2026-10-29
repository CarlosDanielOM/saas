'use strict';
// AUTHOR ONLY. Execute actual source declarations plus installed Mongoose
// middleware offline. Only collection calls and the separately proven lock
// boundary are substituted. Never use this host double as runtime completion.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),ts=require('typescript');
const [mode,directory,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode)&&directory&&!extra.length);
const root=fs.realpathSync(path.resolve(__dirname,'../..'));
const repo=fs.realpathSync(path.join(root,'..')),output=fs.realpathSync(directory);
assert(fs.statSync(output).isDirectory());
assert(output!==repo&&!output.startsWith(repo+path.sep),'external directory only');
if(mode==='--write') assert.deepEqual(fs.readdirSync(output),[],'exclusive empty output directory');
assert.equal(process.version,'v24.22.1');assert.equal(process.versions.v8,'13.6.233.17-node.58');
assert.equal(ts.version,'5.9.3');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const pins={
 'src/utils/ai_usage_ledger.ts':'3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5',
 'src/utils/ai_usage_lock.ts':'c66763fc7ddc9ab1ab51f3d895c4ab20ef8b37ae62e59d799e960da972eda510',
 'src/utils/ai_usage_lock.rs':'a8b2e6daf36a94dc7dd2eb44e9141c66f41e1ec6b10f35ab1d90178440dc87da',
 'src/utils/ai_usage_classification.ts':'00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36',
 'src/utils/ai_usage_receipts.ts':'d92832339b0306249c054816e2105c3fc601a7c27994b6dc7f1b8bec7e607a87',
 'src/utils/ai_usage_event.ts':'87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60',
 'src/schemas/ai_usage_dashboard.schema.ts':'0a284872d00400c766cb61995353dec43214d8564c31abb6e0c9e83e716f36c6',
 'src/schemas/ai_usage_ledger_state.schema.ts':'ede6fc369c432d97bee0db835871c0773c1000023ac2c34ff044510c5c60121c',
 'src/schemas/ai_usage_receipt.schema.ts':'87f132f55c47cf082f37dabadc0d42f790e8324d1925f6990a3794f46d845b92',
 'src/schemas/ai_usage_daily.schema.ts':'80b5debff08e77578275a5267df1a1499138441d1bb5d55875f1eb2092318585',
 'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
 'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
 'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
 'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
 'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
 'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
};
for(const [file,digest] of Object.entries(pins)) assert.equal(sha(read(file)),digest,file);
const violations=[];
const forbidden=()=>{violations.push('network');throw Error('offline oracle forbids network');};
require('node:net').Socket.prototype.connect=forbidden;
for(const k of ['connect','createConnection'])require('node:net')[k]=forbidden;
require('node:tls').connect=forbidden;
for(const n of ['node:http','node:https'])for(const k of ['request','get'])require(n)[k]=forbidden;
for(const n of ['node:dns','node:dns/promises'])for(const k of Object.keys(require(n)))if(/^(lookup|resolve|reverse)/.test(k))require(n)[k]=forbidden;
globalThis.fetch=forbidden;
const pkg=require('mongoose');assert.equal(pkg.version,'8.24.2');
const mongoose=new pkg.Mongoose();
mongoose.set('autoCreate',false);mongoose.set('autoIndex',false);mongoose.set('bufferCommands',false);
for(const owner of [pkg,mongoose]){owner.connect=forbidden;owner.createConnection=forbidden;owner.Connection.prototype.openUri=forbidden;}
mongoose.mongo.MongoClient.connect=forbidden;mongoose.mongo.MongoClient.prototype.connect=forbidden;
const BSON=mongoose.mongo.BSON;
// BSON.serialize alone defaults to ignoring undefined, unlike the actual
// MongoDB driver's default. Capture collection commands with the installed
// driver's policy; keep raw synthetic aggregate responses separate below.
const mongooseRequire=createRequire(require.resolve('mongoose'));
const driverEntry=mongooseRequire.resolve('mongodb');
const {resolveBSONOptions}=mongooseRequire(path.join(path.dirname(driverEntry),'bson.js'));
const driverBsonOptions=resolveBSONOptions({});
assert.equal(driverBsonOptions.ignoreUndefined,false);
const declarations=[],imports=[],trees=new Map();
function tree(file){
 if(!trees.has(file)){
  const source=read(file),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
  assert.deepEqual(ast.parseDiagnostics,[]);trees.set(file,{source,ast});
  imports.push(...ast.statements.filter(ts.isImportDeclaration).map(n=>({file,text:n.getText(ast),module:n.moduleSpecifier.text,typeOnly:!!n.importClause?.isTypeOnly})));
 }
 return trees.get(file);
}
function select(file,name,kind,exported){
 const {source,ast}=tree(file);
 const nodes=ast.statements.filter(n=>n.name?.text===name||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
 assert.equal(nodes.length,1,`${file}:${name}`);const n=nodes[0];
 // FirstStatement aliases VariableStatement. Reverse enum display is lossy.
 assert.equal(n.kind,ts.SyntaxKind[kind]);
 assert.equal(!!n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),exported);
 const text=n.getText(ast)+'\n';
 declarations.push({file,name,kind,exported,text,sha256:sha(text),
  startByte:Buffer.byteLength(source.slice(0,n.getStart(ast))),endByte:Buffer.byteLength(source.slice(0,n.end)),
  parameters:ts.isFunctionDeclaration(n)?n.parameters.map(p=>({name:p.name.getText(ast),type:p.type.getText(ast),optional:!!p.questionToken})):[],returnType:n.type?.getText(ast)??null});
 return text;
}
const ledger='src/utils/ai_usage_ledger.ts',classification='src/utils/ai_usage_classification.ts';
const schemas=Object.fromEntries(['dashboard','ledger_state','receipt','daily'].map(n=>[n,`src/schemas/ai_usage_${n}.schema.ts`]));
const types=[...['AiUsageEntryKind','AiUsageCategory','AiUsageUnit','AiUsageResourceType'].map(n=>select('src/utils/ai_usage_event.ts',n,'TypeAliasDeclaration',true)),
 select(schemas.receipt,'AiUsageRetentionTier','TypeAliasDeclaration',true),
 select('src/utils/ai_usage_receipts.ts','AiUsageReceiptCategory','TypeAliasDeclaration',true),
 select('src/utils/ai_usage_receipts.ts','AiUsageTransaction','InterfaceDeclaration',true),
 select(ledger,'QueuedAiUsageReceipt','InterfaceDeclaration',true)];
const extracted=[...types,
 select(classification,'ADJUSTMENT_TYPES','VariableStatement',true),select(classification,'classifyAdjustment','FunctionDeclaration',true),
 select(ledger,'RETENTION_DAYS','VariableStatement',false),select(ledger,'VALID_CATEGORIES','VariableStatement',false),
 ...['validTier','expiryFor','safeCategory'].map(n=>select(ledger,n,'FunctionDeclaration',false)),
 select(ledger,'getAiUsageRetentionDays','FunctionDeclaration',true),select(ledger,'receiptDocument','FunctionDeclaration',false),
 select(ledger,'persistAiUsageReceipt','FunctionDeclaration',true),select(ledger,'rebuildUtcDailyAggregates','FunctionDeclaration',false)].join('\n');
const lockSource=select('src/utils/ai_usage_lock.ts','withAiUsageLock','FunctionDeclaration',true);
const lockProofDirectory=fs.realpathSync(process.env.DIMA_AI_LOCK_REFERENCE_DIR);
assert(lockProofDirectory!==repo&&!lockProofDirectory.startsWith(repo+path.sep));
const lockProofFiles=Object.fromEntries(['ai_usage_lock_reference.json','ai_usage_lock_extracted.ts','ai_usage_lock_typecheck.ts','ai_usage_lock_compiled.cjs'].map(file=>[file,sha(fs.readFileSync(path.join(lockProofDirectory,file)))]));
const lockProof=JSON.parse(fs.readFileSync(path.join(lockProofDirectory,'ai_usage_lock_reference.json'),'utf8'));
assert.equal(lockProof.metadata.total,291);assert.equal(lockProof.cases.length,291);
assert.equal(lockProof.metadata.hashes.source,pins['src/utils/ai_usage_lock.ts']);
assert.equal(lockProof.metadata.hashes.node,sha(fs.readFileSync(process.execPath)));
assert.equal(lockProof.metadata.hashes.oracle,sha(read('tests/fixtures/ai_usage_lock_reference.cjs')));
assert.equal(lockProof.metadata.typeDiagnostics.length,0);
for(const[file,digest]of Object.entries(lockProof.metadata.nativeHashes))assert.equal(sha(read(file)),digest,`lock proof drift ${file}`);
const lockTree=tree('src/utils/ai_usage_lock.ts');
const lockNode=lockTree.ast.statements.find(n=>n.name?.text==='withAiUsageLock');
const lockSignature=lockTree.source.slice(lockNode.getStart(lockTree.ast),lockNode.body.getStart(lockTree.ast)).replace(/^export async /,'declare ')+';\n';
const typecheck=`declare const Dashboards: typeof import('./src/schemas/ai_usage_dashboard.schema.js').default;
declare const AiUsageReceiptSchema: typeof import('./src/schemas/ai_usage_receipt.schema.js').default;
declare const AiUsageDailySchema: typeof import('./src/schemas/ai_usage_daily.schema.js').default;
`+lockSignature+extracted;
const virtual=path.join(root,'__ai_usage_ledger_persistence_oracle__.ts');
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host=ts.createCompilerHost(options),oldRead=host.readFile.bind(host),oldExists=host.fileExists.bind(host);
host.readFile=f=>f===virtual?typecheck:oldRead(f);host.fileExists=f=>f===virtual||oldExists(f);
// Keep the complete real generic signature; the separate lock oracle owns its
// application Redis import. No handwritten callback type replaces its contract.
const typeDiagnostics=ts.getPreEmitDiagnostics(ts.createProgram([virtual],options,host)).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'));
assert.deepEqual(typeDiagnostics,[]);
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS};
const compiled=ts.transpileModule(extracted+'\nexport { receiptDocument, rebuildUtcDailyAggregates };\n',{compilerOptions,reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
const models={},observedImports=[];
for(const [key,file]of Object.entries(schemas)){
 tree(file);const mod={exports:{}};
 const code=ts.transpileModule(read(file),{compilerOptions,reportDiagnostics:true});assert.deepEqual(code.diagnostics,[]);
 vm.runInNewContext(code.outputText,{module:mod,exports:mod.exports,require:n=>{observedImports.push({file,name:n});assert.equal(n,'mongoose');return{Schema:mongoose.Schema,model:mongoose.model.bind(mongoose)};}},{filename:file});
 models[key]=mod.exports.default;
}
assert.equal(models.daily.collection.name,'ai_usage_dailies');
const NativeDate=Date;let appNow=0,appReads=[],middlewareNow=0,middlewareReads=[],lockCalls=[];
class FixtureDate extends NativeDate{
 constructor(...args){if(args.length)super(...args);else{super(appNow);appReads.push(appNow);}}
 static now(){appReads.push(appNow);return appNow;}
 static [Symbol.hasInstance](value){return value instanceof NativeDate;}
}
// Mongoose clone() branches on constructor.name. Preserve the native Date
// contract: an arbitrarily named subclass is otherwise cloned via valueOf()
// into a number, corrupting this oracle's insertMany BSON expectations.
Object.defineProperty(FixtureDate,'name',{value:'Date'});
assert.equal(FixtureDate.name,'Date','fixture Date must preserve Mongoose clone semantics');
mongoose.now=()=>{middlewareReads.push(middlewareNow);return new NativeDate(middlewareNow);};
const mod={exports:{}};
vm.runInNewContext(compiled.outputText,{module:mod,exports:mod.exports,Date:FixtureDate,
 Dashboards:models.dashboard,AiUsageReceiptSchema:models.receipt,AiUsageDailySchema:models.daily,
 withAiUsageLock:async(channel,customer,run)=>{lockCalls.push([channel,customer]);return run();}},{filename:ledger});
const source=mod.exports;
const wire=value=>BSON.serialize(value,driverBsonOptions).toString('hex');
const groupWire=value=>BSON.serialize(value).toString('hex');
const unwire=hex=>BSON.deserialize(Buffer.from(hex,'hex'));
function encode(value){
 if(value===undefined)return{$undefined:true};
 if(typeof value==='number'){const bytes=Buffer.alloc(8);bytes.writeDoubleBE(value);return{$f64:bytes.toString('hex')};}
 if(typeof value==='string')return{$utf16:Array.from({length:value.length},(_,i)=>value.charCodeAt(i))};
 if(value instanceof NativeDate)return{$date:Number.isNaN(value.getTime())?null:String(value.getTime())};
 if(value?._bsontype)return{$bsonWire:wire({value})};
 if(Array.isArray(value))return{$array:value.map(encode)};
 if(value&&typeof value==='object')return{$object:Object.keys(value).map(k=>[k,encode(value[k])])};
 return value;
}
const NOW=1793275200000,DAY=86400000;
const base=()=>({channelID:'channel',customerId:'customer',id:'receipt',requestId:null,occurredAt:new NativeDate(NOW).toISOString(),entryKind:'usage',category:'tts',operation:'synthesis',source:null,adjustmentType:null,provider:'piper',model:null,quantity:1,unit:'characters',credits:2,resourceType:'speech',resourceId:null,itemized:true});
const group=(patch={})=>({_id:{date:'2026-10-29',category:'tts'},spent:2,granted:0,debited:0,count:1,expiresAt:new NativeDate(NOW+30*DAY),...patch});
const records=[];
async function scenario(id,op,input,configuration={}){
 appNow=configuration.now??NOW;middlewareNow=configuration.middlewareNow??NOW+11;appReads=[];middlewareReads=[];lockCalls=[];
 const calls=[],groupsHex=(configuration.groups??[]).map(groupWire),events=[];
 const fail=kind=>{if(configuration.fail===kind)throw Object.assign(new Error('fixture database failure'),{name:'MongoServerError',code:12345});};
 models.dashboard.collection.updateMany=async(filter,update,options)=>{calls.push({kind:'dashboard.updateMany',filterHex:wire(filter),updateHex:wire(update),optionsHex:wire(options)});fail('dashboard.updateMany');return{acknowledged:true,modifiedCount:1};};
 models.receipt.collection.updateOne=async(filter,update,options)=>{calls.push({kind:'receipt.updateOne',filterHex:wire(filter),updateHex:wire(update),optionsHex:wire(options)});fail('receipt.updateOne');return{acknowledged:true,upsertedCount:configuration.duplicate?0:1};};
 models.receipt.collection.aggregate=(pipeline,options)=>{calls.push({kind:'receipt.aggregate',pipelineHex:wire({pipeline}),optionsHex:wire(options??{})});return{toArray:async()=>{fail('receipt.aggregate');return groupsHex.map(unwire);}};};
 models.daily.collection.deleteMany=async(filter,options)=>{calls.push({kind:'daily.deleteMany',filterHex:wire(filter),optionsHex:wire(options)});fail('daily.deleteMany');return{acknowledged:true,deletedCount:1};};
 models.daily.collection.insertMany=async(documents,options)=>{
  for(const document of documents)for(const field of ['dayStart','expiresAt','created_at','updated_at'])
   if(document[field]!==undefined&&!(document[field] instanceof NativeDate)){
    violations.push(`actual schema Date lost at ${field}`);
    assert.fail(`actual schema Date lost at ${field}`);
   }
  // Ignore entropy only; every other field and its insertion order is exact.
  const stripped=documents.map(document=>{const copy={...document};delete copy._id;return copy;});
  calls.push({kind:'daily.insertMany',documentsHex:stripped.map(wire),optionsHex:wire(options)});fail('daily.insertMany');return{acknowledged:true,insertedCount:documents.length,insertedIds:{}};
 };
 let result,error=null;
 try{if(op==='persist')result=await source.persistAiUsageReceipt(input.receipt,input.tier);
 else result=await source.rebuildUtcDailyAggregates(input.channelID,input.customerId,input.tier,input.from,input.to);}
 catch(e){error={name:e.name,path:e.path??null,code:e.code??null,message:e.message};}
 events.push(error?'rejected':'resolved');
 records.push({id,op,input:encode(input),now:encode(appNow),middlewareNow:encode(middlewareNow),duplicate:!!configuration.duplicate,fail:configuration.fail??null,groupsHex,calls,appReads:appReads.map(encode),middlewareReads:middlewareReads.map(encode),lockCalls:encode(lockCalls),events,result:error?null:encode(result),error});
 assert.equal(mongoose.connection.readyState,0);
}
async function generate(){
 for(const tier of ['free','premium','pro','PRO',' premium ',null,true,0,{},[],['pro'],'\ud800'])for(const duplicate of [false,true])
  await scenario(`tier-${records.length}`,'persist',{receipt:base(),tier},{duplicate,groups:[group()]});
 for(const kind of ['dashboard.updateMany','receipt.updateOne','receipt.aggregate','daily.deleteMany','daily.insertMany'])
  await scenario(`failure-${kind}`,'persist',{receipt:base(),tier:'free'},{fail:kind,groups:[group()]});
 for(const offset of [-30*DAY-1,-30*DAY,-30*DAY+1,0,DAY])
  await scenario(`expiry-${offset}`,'persist',{receipt:{...base(),occurredAt:new NativeDate(NOW+offset).toISOString()},tier:'free'});
 for(const field of ['requestId','source','adjustmentType','model','quantity','unit','resourceType','resourceId','provider','operation','entryKind','credits','itemized','id'])
  for(const value of [undefined,null,'']){
   // Keep the declared plain scalar boundary for these three fields.
   if(['quantity','credits','itemized'].includes(field)&&value==='')continue;
   const receipt=base();if(value===undefined)delete receipt[field];else receipt[field]=value;
   await scenario(`nullable-${field}-${records.length}`,'persist',{receipt,tier:'free'});
  }
 for(const credits of [-Infinity,Infinity,NaN,-0,0,0.5,-2.5])for(const quantity of [NaN,Infinity,-Infinity,-0,null])
  await scenario(`numbers-${records.length}`,'persist',{receipt:{...base(),credits,quantity},tier:'free'});
 for(const channelID of ['',' channel ','\ud800','\udc00','😀','a\0b'])
  await scenario(`identity-${records.length}`,'persist',{receipt:{...base(),channelID,customerId:channelID},tier:'premium'});
 for(const occurredAt of ['bad','2026-10-29T01:00:00+05:00','2026-10-29','+010000-01-01T12:00:00.000Z','-000001-01-01T12:00:00.000Z','+275760-09-13T00:00:00.000Z'])
  await scenario(`occurred-${records.length}`,'persist',{receipt:{...base(),occurredAt},tier:'pro'},{now:-8640000000000000});
 for(const middlewareNow of [NaN,-8640000000000001,8640000000000001,0])
  await scenario(`middleware-${records.length}`,'persist',{receipt:base(),tier:'free'},{middlewareNow,groups:[group()]});
 const numeric=[0,-0,2.5,NaN,Infinity,-Infinity,new BSON.Double(3),BSON.Long.fromString('9007199254740992'),BSON.Long.fromString('9007199254740993'),BSON.Long.fromString('-9007199254740993'),BSON.Decimal128.fromString('0'),BSON.Decimal128.fromString('2.5'),BSON.Decimal128.fromString('NaN'),BSON.Decimal128.fromString('Infinity')];
 const rebuild=(patch={})=>({channelID:'channel',customerId:'customer',tier:'free',from:new NativeDate(NOW),to:new NativeDate(NOW),...patch});
 for(const number of numeric)for(const field of ['spent','granted','debited','count'])
  await scenario(`aggregate-numeric-${records.length}`,'rebuild',rebuild(),{groups:[group({[field]:number}),group({[field]:number})]});
 for(const expiresAt of [undefined,null,'2026-12-01',0,new NativeDate(NaN),new NativeDate(-1),new NativeDate(NOW+60*DAY),BSON.Long.fromString('9007199254740993'),BSON.Decimal128.fromString('2'),[],['2026-12-01'],{}, {toString:null}])
  await scenario(`aggregate-expiry-${records.length}`,'rebuild',rebuild(),{groups:[group({expiresAt}),group({expiresAt:new NativeDate(NOW+31*DAY)})]});
 await scenario('group-order-overwrite','rebuild',rebuild(),{groups:[group({_id:{date:'2026-10-29',category:'legacy-a'},spent:7}),group({_id:{date:'2026-10-28',category:'tts'},spent:5}),group({_id:{date:'2026-10-29',category:'legacy-b'},spent:11})]});
 await scenario('unordered-mixed-validation','rebuild',rebuild(),{groups:[group({_id:{date:null,category:'tts'}}),group(),group({_id:{date:'invalid',category:'tts'}})]});
 await scenario('unordered-all-invalid','rebuild',rebuild(),{groups:[group({_id:{date:null,category:'tts'}}),group({spent:NaN})]});
 await scenario('empty-categories-minimized','rebuild',rebuild(),{groups:[group({count:0})]});
 for(const from of [new NativeDate(NaN),new NativeDate(-1),new NativeDate('+010000-01-01'),new NativeDate('-000001-01-01')])
  await scenario(`rebuild-boundary-${records.length}`,'rebuild',rebuild({from,to:from}));
 for(const fail of ['receipt.aggregate','daily.deleteMany','daily.insertMany'])await scenario(`rebuild-failure-${fail}`,'rebuild',rebuild(),{fail,groups:[group()]});
 assert(records.length>180);assert.equal(new Set(records.map(r=>r.id)).size,records.length);assert.deepEqual(violations,[]);
}
function metadata(){
 const native=['Cargo.toml','Cargo.lock','rust-toolchain.toml','src/lib.rs','src/utils/mod.rs','src/schemas/mod.rs','src/schemas/schema.rs',...Object.values(schemas).map(f=>f.replace(/\.ts$/,'.rs')),
  'src/utils/ai_usage_ledger_persistence.rs','src/utils/ai_usage_aggregate_policy.rs','src/utils/ai_usage_producer.rs','src/utils/ai_usage_receipt_parser.rs','src/utils/ai_usage_ledger_reads.rs','src/utils/ai_usage_lock.rs','src/utils/ai_usage.rs','src/utils/bson_compat.rs','src/utils/credit_policy.rs','src/utils/mongoose_date.rs','src/utils/js_date/mod.rs','src/utils/js_date/parser.rs','src/utils/js_date/local_time.rs','src/utils/js_string.rs','src/utils/json_number.rs','src/utils/js_compat.rs','src/utils/lossless_json.rs','src/utils/tts/settings.rs','tests/ai_usage_ledger_persistence.rs','tests/fixtures/ai_usage_ledger_persistence_reference.cjs',
  'tests/fixtures/ai_usage_lock_reference.cjs','tests/ai_usage_lock.rs'];
 const hashes=Object.fromEntries([...new Set([...Object.keys(pins),...native])].map(f=>[f,sha(fs.readFileSync(path.join(root,f)))]));
 const dependencies=Object.fromEntries(Object.keys(require.cache).filter(f=>f.includes('/node_modules/')).sort().map(f=>[path.relative(root,f),sha(fs.readFileSync(f))]));
 const mr=createRequire(require.resolve('mongoose')),br=createRequire(mr.resolve('mongodb')),lock=JSON.parse(read('package-lock.json')),packages={};
 for(const [name,resolver]of [['typescript',require],['mongoose',require],['mongodb',mr],['bson',br]]){
  const entry=resolver.resolve(name);let folder=path.dirname(entry);while(!fs.existsSync(path.join(folder,'package.json'))){const parent=path.dirname(folder);assert.notEqual(parent,folder);folder=parent;}
  const packageFile=path.join(folder,'package.json'),packageData=JSON.parse(fs.readFileSync(packageFile,'utf8')),relative=path.relative(root,folder).replaceAll(path.sep,'/');
  assert.equal(packageData.name,name);assert.equal(lock.packages[relative]?.version,packageData.version);
  packages[name]={version:packageData.version,entry:path.relative(root,entry),entrySha256:sha(fs.readFileSync(entry)),package:path.relative(root,packageFile),packageSha256:sha(fs.readFileSync(packageFile))};
 }
 assert.equal(packages.bson.version,'6.10.4');
 return{format:1,driverBsonOptions,driverUndefinedProbeHex:wire({value:undefined}),node:process.version,v8:process.versions.v8,typescript:ts.version,mongoose:mongoose.version,nodeSha256:sha(fs.readFileSync(process.execPath)),hashes,dependencies,packages,imports,declarations,observedImports,typeDiagnostics,lockSource,lockSourceSha256:sha(lockSource),lockProofFiles,lockProofCases:291,lockBoundary:'Bound separate actual-source lock corpus; this oracle substitutes its callback boundary only. Its native execution remains mandatory.',caseCount:records.length,extractedSha256:sha(extracted),typecheckSha256:sha(typecheck),compiledSha256:sha(compiled.outputText)};
}
(async()=>{
 await generate();const outputs=[['ai_usage_ledger_persistence_reference.json',JSON.stringify({metadata:metadata(),records},null,2)+'\n'],['ai_usage_ledger_persistence_extracted.ts',extracted],['ai_usage_ledger_persistence_typecheck.ts',typecheck],['ai_usage_ledger_persistence_compiled.cjs',compiled.outputText]];
 if(mode==='--check')assert.deepEqual(fs.readdirSync(output).sort(),outputs.map(([n])=>n).sort(),'exclusive exact fixture set');
 for(const [name,body]of outputs){const target=path.join(output,name);assert(body.length);if(mode==='--write')fs.writeFileSync(target,body,{flag:'wx'});else assert.deepEqual(fs.readFileSync(target),Buffer.from(body));}
})().catch(e=>{console.error(e);process.exitCode=1;});
