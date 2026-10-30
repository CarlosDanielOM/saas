'use strict';
const {sourcePath: fixturePath, resolveSource} = require('./ai_usage_source_resolver.cjs');
// AUTHOR ONLY until the parent runs this in the capped isolated environment.
// Actual AST-selected TS bodies and actual installed Mongoose schema/query
// casting run offline. Only collection cursor replies are replaced. This is
// not a substitute for the ignored native private-Mongo matching tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const ts = require('typescript');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write','--check'].includes(mode) && directory && !extra.length,
  'usage: --write EXTERNAL_DIRECTORY | --check EXTERNAL_DIRECTORY');
const root = fs.realpathSync(path.resolve(__dirname,'../..'));
const output = fs.realpathSync(directory);
assert(fs.statSync(output).isDirectory());
assert(output !== root && !output.startsWith(root + path.sep), 'external fixtures only');
assert.equal(process.version,'v24.22.1');
assert.equal(process.versions.v8,'13.6.233.17-node.58');
assert.equal(ts.version,'5.9.3');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(fixturePath(root,file),'utf8');
const pins = {
  'src/utils/ai_usage_ledger.ts':'3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5',
  'src/utils/ai_usage_classification.ts':'00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36',
  'src/utils/ai_usage_receipts.ts':'d92832339b0306249c054816e2105c3fc601a7c27994b6dc7f1b8bec7e607a87',
  'src/utils/ai_usage_event.ts':'87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60',
  'src/schemas/ai_usage_daily.schema.ts':'80b5debff08e77578275a5267df1a1499138441d1bb5d55875f1eb2092318585',
  'src/schemas/ai_usage_receipt.schema.ts':'87f132f55c47cf082f37dabadc0d42f790e8324d1925f6990a3794f46d845b92',
  'src/schemas/ai_usage_ledger_state.schema.ts':'ede6fc369c432d97bee0db835871c0773c1000023ac2c34ff044510c5c60121c',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
  'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
};
for (const [file,digest] of Object.entries(pins)) assert.equal(sha(read(file)),digest,`pinned ${file}`);
const violations = [];
const forbidden = () => { violations.push('network/persistence'); throw Error('oracle forbids network/persistence'); };
require('node:net').Socket.prototype.connect = forbidden;
for (const key of ['connect','createConnection']) require('node:net')[key] = forbidden;
require('node:tls').connect = forbidden;
for (const name of ['node:http','node:https']) {
  require(name).get = forbidden; require(name).request = forbidden;
}
for (const name of ['node:dns','node:dns/promises']) {
  const dns = require(name);
  for (const key of Object.keys(dns))
    if (/^(lookup|resolve|reverse)/.test(key) && typeof dns[key] === 'function') dns[key] = forbidden;
}
globalThis.fetch = forbidden;
const mongoosePackage = require('mongoose');
assert.equal(mongoosePackage.version,'8.24.2');
const mongoose = new mongoosePackage.Mongoose();
mongoose.set('autoCreate',false); mongoose.set('autoIndex',false); mongoose.set('bufferCommands',false);
for (const owner of [mongoosePackage,mongoose]) {
  owner.connect = forbidden; owner.createConnection = forbidden; owner.Connection.prototype.openUri = forbidden;
}
mongoose.mongo.MongoClient.prototype.connect = forbidden;
mongoose.mongo.MongoClient.connect = forbidden;
const BSON = mongoose.mongo.BSON;
const declarations = [], imports = [], trees = new Map();
function tree(file) {
  if (!trees.has(file)) {
    const source=read(file), ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
    assert.deepEqual(ast.parseDiagnostics,[]);
    trees.set(file,{source,ast});
    imports.push(...ast.statements.filter(ts.isImportDeclaration).map(node=>({file,
      module:node.moduleSpecifier.text,text:node.getText(ast),typeOnly:!!node.importClause?.isTypeOnly,
      bindings:node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements.map(e=>({name:e.name.text,typeOnly:!!e.isTypeOnly})) : []})));
  }
  return trees.get(file);
}
function select(file,name,kind,exported) {
  const {source,ast}=tree(file);
  const candidates=ast.statements.filter(n=>n.name?.text===name || ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
  assert.equal(candidates.length,1,`unique declaration ${file}:${name}`);
  const node=candidates[0];
  assert.equal(node.kind,ts.SyntaxKind[kind]);
  assert.equal(!!node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),exported);
  const text=node.getText(ast)+'\n';
  declarations.push({file,name,kind,exported,text,sha256:sha(text),
    startByte:Buffer.byteLength(source.slice(0,node.getStart(ast))),endByte:Buffer.byteLength(source.slice(0,node.end)),
    parameters:ts.isFunctionDeclaration(node)?node.parameters.map(p=>({name:p.name.getText(ast),
      type:p.type.getText(ast),optional:!!p.questionToken})):[],returnType:node.type?.getText(ast)??null});
  return text;
}
const ledger='src/utils/ai_usage_ledger.ts', receipts='src/utils/ai_usage_receipts.ts';
const classification='src/utils/ai_usage_classification.ts';
const schemas={state:'src/schemas/ai_usage_ledger_state.schema.ts',
  daily:'src/schemas/ai_usage_daily.schema.ts',receipts:'src/schemas/ai_usage_receipt.schema.ts'};
const types = [
  ...['AiUsageEntryKind','AiUsageCategory','AiUsageUnit','AiUsageResourceType']
    .map(n=>select('src/utils/ai_usage_event.ts',n,'TypeAliasDeclaration',true)),
  select(schemas.receipts,'AiUsageRetentionTier','TypeAliasDeclaration',true),
  select(receipts,'AiUsageReceiptCategory','TypeAliasDeclaration',true),
  ...['AiUsageWindow','AiUsageTransaction'].map(n=>select(receipts,n,'InterfaceDeclaration',true)),
  select(ledger,'AiUsagePacingHistory','InterfaceDeclaration',true),
  ...Object.entries(schemas).map(([key,file])=>select(file,
    {state:'IAiUsageLedgerState',daily:'IAiUsageDaily',receipts:'IAiUsageReceipt'}[key],'InterfaceDeclaration',true)),
];
const extracted = [
  ...types,
  select(classification,'ADJUSTMENT_TYPES','VariableStatement',true),
  select(classification,'classifyAdjustment','FunctionDeclaration',true),
  select(ledger,'RETENTION_DAYS','VariableStatement',false),
  select(ledger,'VALID_CATEGORIES','VariableStatement',false),
  select(ledger,'validTier','FunctionDeclaration',false),
  select(ledger,'safeCategory','FunctionDeclaration',false),
  select(ledger,'getAiUsageRetentionDays','FunctionDeclaration',true),
  select(ledger,'getAiUsageLedgerState','FunctionDeclaration',true),
  select(ledger,'loadAiUsagePacingHistory','FunctionDeclaration',true),
  select(ledger,'loadAiUsageLedgerTransactions','FunctionDeclaration',true),
].join('\n');
assert(imports.some(i=>i.file===ledger && i.module==='./ai_usage_receipts.js' && i.typeOnly));
assert(imports.some(i=>i.file===ledger && i.module==='./ai_usage_classification.js' && !i.typeOnly));
for (const file of Object.values(schemas)) {
  const runtime=imports.filter(i=>i.file===file && !i.typeOnly);
  assert.deepEqual(runtime.map(i=>i.module),['mongoose']);
}
const stubs = `
declare const AiUsageLedgerStateSchema: {findOne(filter:unknown): {select(fields:string): {lean(): {exec(): Promise<IAiUsageLedgerState | null>}}}};
declare const AiUsageDailySchema: {aggregate<T>(pipeline:unknown[]): {exec(): Promise<T[]>}};
declare const AiUsageReceiptSchema: {find(filter:unknown): {sort(sort:unknown): {lean(): {exec(): Promise<IAiUsageReceipt[]>}}}};
`;
const typecheck=stubs+extracted;
const virtualFile=path.join(root,'__ai_usage_ledger_queries_oracle__.ts');
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,
  noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host=ts.createCompilerHost(options), originalRead=host.readFile.bind(host), originalExists=host.fileExists.bind(host);
host.readFile=f=>f===virtualFile?typecheck:originalRead(f);
host.fileExists=f=>f===virtualFile || originalExists(f);
const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram([virtualFile],options,host))
  .map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'));
assert.deepEqual(diagnostics,[]);
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS};
const compiled=ts.transpileModule(extracted,{reportDiagnostics:true,compilerOptions});
assert.deepEqual(compiled.diagnostics,[]);
const observedImports=[], models={};
for (const [key,file] of Object.entries(schemas)) {
  const module={exports:{}};
  const javascript=ts.transpileModule(read(file),{reportDiagnostics:true,compilerOptions});
  assert.deepEqual(javascript.diagnostics,[]);
  vm.runInNewContext(javascript.outputText,{module,exports:module.exports,require:name=>{
    observedImports.push({file,name}); assert.equal(name,'mongoose');
    return {Schema:mongoose.Schema,model:mongoose.model.bind(mongoose)};
  }},{filename:file,timeout:10000});
  models[key]=module.exports.default;
}
assert.equal(models.state.collection.name,'ai_usage_ledger_states');
assert.equal(models.daily.collection.name,'ai_usage_dailies');
assert.equal(models.receipts.collection.name,'ai_usage_receipts');
const NativeDate=Date;
let fixedClock=Date.parse('2026-10-29T12:34:56.789Z'),clockReads=0;
class FixtureDate extends NativeDate {
  constructor(...args) { if(args.length===0) { clockReads++; super(fixedClock); } else super(...args); }
  static now() { clockReads++; return fixedClock; }
  static [Symbol.hasInstance](value) { return value instanceof NativeDate; }
}
// Mongoose cloning must observe the native constructor name.
Object.defineProperty(FixtureDate,'name',{value:'Date'});
assert.equal(FixtureDate.name,'Date');
const moduleSource={exports:{}};
vm.runInNewContext(compiled.outputText,{module:moduleSource,exports:moduleSource.exports,
  require:name=>{violations.push(`unexpected import ${name}`);throw Error(name);},Date:FixtureDate,
  AiUsageLedgerStateSchema:models.state,AiUsageDailySchema:models.daily,AiUsageReceiptSchema:models.receipts},
  {filename:ledger,timeout:10000});
const source=moduleSource.exports;
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
function encode(value) {
  if(value===undefined) return {$undefined:true};
  if(value instanceof NativeDate) return {$date:Number.isNaN(value.getTime())?null:String(value.getTime())};
  if(typeof value==='number') return {$f64:bits(value)};
  if(typeof value==='string') return {$utf16:Array.from({length:value.length},(_,i)=>value.charCodeAt(i))};
  if(value?._bsontype) return {$bsonWire:BSON.serialize({value}).toString('hex')};
  if(Array.isArray(value)) return {$array:value.map(encode)};
  if(value && typeof value==='object') return {$object:Object.keys(value).map(k=>[k,encode(value[k])])};
  return value;
}
const wire=value=>BSON.serialize(value).toString('hex');
const decode=hex=>BSON.deserialize(Buffer.from(hex,'hex'));
const records=[];
const identity={channelID:'channel',customerId:'customer'};
const clock=Date.parse('2026-10-29T12:00:00.000Z');
const baseState=()=>({coverageStart:new Date('2020-01-01'),backfilledAt:new Date(123),reportVersion:0});
const baseTransaction=()=>({entryId:'receipt',requestId:null,occurredAt:new Date(clock-1000),
  entryKind:'usage',category:'tts',operation:'synthesis',source:null,adjustmentType:null,
  provider:'piper',model:null,quantity:1,unit:'characters',credits:2,resourceType:'speech',resourceId:null,itemized:true});
const window=()=>({from:'2026-10-01',to:'2026-10-29',timeZone:'UTC',
  startTimestamp:new Date('2026-10-01'),endTimestampExclusive:new Date('2026-10-30'),days:['2026-10-01']});
async function scenario(id,op,input,configuration={}) {
  fixedClock=configuration.clock??clock;clockReads=0;
  const calls=[];
  const stateHex=configuration.stateHex??(configuration.state===null?null:wire(configuration.state??baseState()));
  const replyHex=configuration.replyHex??(configuration.rows??[]).map(wire);
  const fail=kind=>{
    if(configuration.fail===kind) throw Object.assign(new Error('owned fixture read failed'),{name:'MongoServerError',code:12345});
  };
  models.state.collection.findOne=async(filter,options)=>{
    calls.push({kind:'state.findOne',filterHex:wire(filter),projectionHex:wire(options.projection??{}),
      optionsKeys:Object.keys(options).sort()});
    fail('state.findOne');return stateHex===null?null:decode(stateHex);
  };
  models.daily.collection.aggregate=(pipeline,options)=>{
    calls.push({kind:'daily.aggregate',pipelineHex:wire({pipeline}),optionsKeys:Object.keys(options??{}).sort()});
    return {toArray:async()=>{fail('daily.aggregate');return replyHex.map(decode);}};
  };
  models.receipts.collection.find=(filter,options)=>{
    calls.push({kind:'receipts.find',filterHex:wire(filter),sortHex:wire(options.sort??{}),
      optionsKeys:Object.keys(options).sort()});
    return {toArray:async()=>{fail('receipts.find');return replyHex.map(decode);}};
  };
  let value,error=null;
  try { value=await source[op](input); }
  catch(e) { error={name:e.name,path:e.path??null,message:e.message,code:e.code??null}; }
  records.push({id,op,input:encode(input),clock:String(fixedClock),clockReads,stateHex,replyHex,
    fail:configuration.fail??null,calls,result:error?null:encode(value),error});
  assert.equal(mongoose.connection.readyState,0);
}
const history='loadAiUsagePacingHistory',transactions='loadAiUsageLedgerTransactions';
async function generate() {
  const pacing=(patch={})=>({...identity,planTier:'free',now:new Date(clock),...patch});
  await scenario('pacing-empty',history,pacing());
  await scenario('pacing-clock-default',history,{...identity,planTier:'free'});
  for(const planTier of ['free','premium','pro','PRO',null,0,{},['pro'],'\ud800'])
    await scenario(`tier-${records.length}`,history,pacing({planTier}),{rows:[{totalSpentCredits:60}]});
  for(const accountCreatedAt of [undefined,null,new Date(NaN),new Date(clock-2.5*86400000),
    new Date(clock),new Date(clock+86400000),new Date(clock-29.5*86400000),new Date(clock-30*86400000)])
    await scenario(`account-${records.length}`,history,pacing({accountCreatedAt}),{rows:[{totalSpentCredits:10}]});
  for(const now of [new Date(NaN),new Date(-8640000000000000),new Date(8640000000000000),
    new Date(-1),new Date(0),new Date(-62167219200000),new Date(253402300800000)]) {
    for(const state of [null,baseState(),{coverageStart:new Date(-8640000000000000)},{}])
      await scenario(`date-state-${records.length}`,history,pacing({now}),{state});
  }
  for(const coverageStart of [null,undefined,'2020-01-01',0,[],{},new Date(clock),new Date(clock+1)])
    await scenario(`coverage-${records.length}`,history,pacing(),{state:{...baseState(),coverageStart}});
  // Raw BSON Date outside JS TimeClip survives on wire; reserializing a native
  // invalid Date would instead encode 0, so patch the actual reply bytes.
  for(const millis of ['-8640000000000001','8640000000000001','9223372036854775807']) {
    const bytes=Buffer.from(wire(baseState()),'hex'),marker=Buffer.from('coverageStart\0');
    bytes.writeBigInt64LE(BigInt(millis),bytes.indexOf(marker)+marker.length);
    await scenario(`invalid-coverage-${millis}`,history,pacing(),{stateHex:bytes.toString('hex')});
  }
  const totals=[undefined,null,false,true,0,-0,NaN,-Infinity,Infinity,-2,0.5,2.5,
    '', ' ', ' 0x10 ','\ufeff3\u3000','\u00853','NaN',[],[null],[3],['3'],[[['3']]],['3','4'],
    {},{valueOf:3},{toString:null},[{toString:null}],
    new BSON.Int32(3),new BSON.Double(-0),BSON.Long.fromString('0'),
    BSON.Long.fromString('9007199254740992'),BSON.Long.fromString('9007199254740993'),
    BSON.Long.fromString('-9007199254740993'),BSON.Decimal128.fromString('0'),
    BSON.Decimal128.fromString('3.0000000000000001'),BSON.Decimal128.fromString('NaN'),
    BSON.Decimal128.fromString('Infinity'),new Date(3),new BSON.ObjectId('000000000000000000000003'),
    new BSON.Binary(Buffer.from('3')),new BSON.Binary(Buffer.from([255])),
    new BSON.UUID('00000000-0000-0000-0000-000000000003'),new BSON.Timestamp({t:0,i:3}),
    new BSON.MinKey(),new BSON.MaxKey(),new BSON.Code('3'),new BSON.Code('3',{scope:1}),
    /3/gi,new BSON.BSONSymbol('3'),
    [new BSON.Binary(Buffer.from('3'))],[new Date(3),{toString:null}],
    {$ref:'ledger',$id:new BSON.ObjectId('000000000000000000000003'),toString:null}];
  for(const total of totals)
    await scenario(`total-${records.length}`,history,pacing(),{rows:[{totalSpentCredits:total},{totalSpentCredits:999}]});
  for(const fail of ['state.findOne','daily.aggregate'])
    await scenario(`pacing-error-${fail}`,history,pacing(),{fail});
  await scenario('state-error-before-invalid-iso',history,pacing({now:new Date(NaN)}),{fail:'state.findOne'});
  await scenario('transaction-empty',transactions,{...identity,window:window()});
  await scenario('transaction-normal',transactions,{...identity,window:window()},{rows:[baseTransaction()]});
  for(const key of Object.keys(baseTransaction())) {
    const removed=baseTransaction();delete removed[key];
    await scenario(`missing-${key}`,transactions,{...identity,window:window()},{rows:[removed]});
    await scenario(`null-${key}`,transactions,{...identity,window:window()},{rows:[{...baseTransaction(),[key]:null}]});
  }
  for(const category of ['tts','ai_chat','ai_agent','memory','clip_recommendation','credit_adjustment',
    'other','uncategorized','TTS','',null,1,{},['tts'],new BSON.BSONSymbol('tts')])
    await scenario(`category-${records.length}`,transactions,{...identity,window:window()},
      {rows:[{...baseTransaction(),category}]});
  const sources=[undefined,null,false,0,-0,NaN,'',[],{},'polar_meter_credit','free_credit_reset',
    'free_credit_reset_worker','admin_credit_grant','credit_pack_purchase','activation','\ud800',
    ['admin_credit_grant'],[[new BSON.Binary(Buffer.from('admin_credit_grant'))]],
    {toString:null},new BSON.Binary(Buffer.from('admin_credit_grant')),
    BSON.Decimal128.fromString('0'),BSON.Long.fromString('0'),new BSON.BSONSymbol('admin_credit_grant')];
  for(const source of sources)
    for(const entryKind of ['usage','adjustment'])
      await scenario(`source-${records.length}`,transactions,{...identity,window:window()},
        {rows:[{...baseTransaction(),entryKind,source}]});
  for(const operation of ['monthly_reset','purchase_pack','refund','correction','',null,[],{},
    ['refund'],{toString:null},new BSON.Binary(Buffer.from('refund'))])
    await scenario(`operation-${records.length}`,transactions,{...identity,window:window()},
      {rows:[{...baseTransaction(),entryKind:'adjustment',operation}]});
  for(const adjustmentType of [...source.ADJUSTMENT_TYPES,'bogus',' ',true,1,{},[],0,-0,NaN,null,'',
    BSON.Decimal128.fromString('0'),BSON.Long.fromString('0')])
    await scenario(`explicit-${records.length}`,transactions,{...identity,window:window()},
      {rows:[{...baseTransaction(),entryKind:'adjustment',source:{toString:null},operation:{toString:null},adjustmentType}]});
  await scenario('reason-classification',transactions,{...identity,window:window()},
    {rows:[{...baseTransaction(),entryKind:'adjustment',reason:'Free benefits'}]});
  for(const occurredAt of [undefined,null,'2020-01-01',0,[],{},new Date(-62167219200000),new Date(253402300800000)])
    await scenario(`transaction-date-${records.length}`,transactions,{...identity,window:window()},
      {rows:[{...baseTransaction(),occurredAt,source:{toString:null},entryKind:'adjustment'}]});
  for(const millis of ['-8640000000000001','8640000000000001','9223372036854775807']) {
    const bytes=Buffer.from(wire(baseTransaction()),'hex'),marker=Buffer.from('occurredAt\0');
    bytes.writeBigInt64LE(BigInt(millis),bytes.indexOf(marker)+marker.length);
    await scenario(`invalid-occurred-${millis}`,transactions,{...identity,window:window()},{replyHex:[bytes.toString('hex')]});
  }
  for(const start of [new Date(0),new Date(NaN)])
    for(const end of [new Date(1),new Date(NaN)])
      for(const sample of [clock,NaN])
        await scenario(`cast-${records.length}`,transactions,{...identity,
          window:{...window(),startTimestamp:start,endTimestampExclusive:end}},{clock:sample});
  // Raw copied properties must preserve BSON wrapper class/promotions and own
  // insertion order, independently from values used in classification.
  for(const value of totals.filter(v=>v!==undefined))
    await scenario(`raw-output-${records.length}`,transactions,{...identity,window:window()},
      {rows:[{...baseTransaction(),provider:value,credits:value,resourceId:value}]});
  // Deprecated BSON DBPointer decodes into Node DBRef, then rewrites as a
  // document wrapper. Use literal wire rather than a modern DBRef serializer.
  const pointer=(name,namespace)=>{
    const key=Buffer.from(name+'\0'),ns=Buffer.from(namespace+'\0');
    const bytes=Buffer.alloc(4+1+key.length+4+ns.length+12+1);let position=4;
    bytes.writeInt32LE(bytes.length,0);bytes[position++]=12;key.copy(bytes,position);position+=key.length;
    bytes.writeInt32LE(ns.length,position);position+=4;ns.copy(bytes,position);position+=ns.length;
    Buffer.from('000000000000000000000003','hex').copy(bytes,position);
    return bytes;
  };
  for(const namespace of ['ledger','owned.ledger']) {
    await scenario(`dbpointer-total-${namespace}`,history,pacing(),
      {replyHex:[pointer('totalSpentCredits',namespace).toString('hex')]});
    const original=Buffer.from(wire(baseTransaction()),'hex');
    const replacement=pointer('provider',namespace);
    // Replace the original provider string element (type+key+length+text+NUL).
    const marker=Buffer.from('provider\0'),keyAt=original.indexOf(marker),start=keyAt-1;
    const dataAt=keyAt+marker.length,end=dataAt+4+original.readInt32LE(dataAt);
    const patched=Buffer.concat([original.subarray(0,start),replacement.subarray(4,-1),original.subarray(end)]);
    patched.writeInt32LE(patched.length,0);
    await scenario(`dbpointer-output-${namespace}`,transactions,{...identity,window:window()},
      {replyHex:[patched.toString('hex')]});
  }
  for(const channelID of [' channel ', '', '\ud800', 'a\udc00b', '😀', 'A\0B']) {
    await scenario(`identity-history-${records.length}`,history,{...pacing(),channelID,customerId:channelID});
    await scenario(`identity-transactions-${records.length}`,transactions,{channelID,customerId:channelID,window:window()});
  }
  await scenario('transaction-driver-error',transactions,{...identity,window:window()},
    {fail:'receipts.find',rows:[{...baseTransaction(),occurredAt:null}]});
  await scenario('mapping-first-row-error',transactions,{...identity,window:window()},
    {rows:[{...baseTransaction(),occurredAt:null},{...baseTransaction(),entryKind:'adjustment',source:{toString:null}}]});
  assert(records.length>300);assert.equal(new Set(records.map(r=>r.id)).size,records.length);
  assert.equal(violations.length,0);assert.equal(mongoose.connection.readyState,0);
}
function provenance() {
  const native=['Cargo.toml','Cargo.lock','rust-toolchain.toml','src/lib.rs','src/utils/mod.rs',
    'src/schemas/mod.rs','src/schemas/schema.rs',...Object.values(schemas).map(f=>f.replace(/\.ts$/,'.rs')),
    'src/utils/ai_usage_ledger_queries.rs','src/utils/ai_usage_ledger_reads.rs','src/utils/ai_usage_receipt_parser.rs',
    'src/utils/ai_usage.rs','src/utils/bson_compat.rs','src/utils/credit_policy.rs','src/utils/js_string.rs',
    'src/utils/json_number.rs','src/utils/lossless_json.rs','src/utils/lossless_json_view.rs','src/utils/lossless_json_document.rs',
    'src/utils/js_compat.rs','src/utils/tts/settings.rs','src/utils/tts/usage.rs',
    'tests/ai_usage_ledger_queries.rs','tests/fixtures/ai_usage_ledger_queries_reference.cjs'];
  const hashes=Object.fromEntries([...new Set([...Object.keys(pins),...native])]
    .map(file=>[file,sha(fs.readFileSync(fixturePath(root,file)))]));
  const dependencies=Object.fromEntries(Object.keys(require.cache).filter(f=>f.includes('/node_modules/')).sort()
    .map(file=>[path.relative(root,file),sha(fs.readFileSync(file))]));
  const mongooseRequire=createRequire(require.resolve('mongoose'));
  const mongoRequire=createRequire(mongooseRequire.resolve('mongodb'));
  const lock=JSON.parse(read('package-lock.json')),packages={};
  for(const [name,resolver] of [['typescript',require],['mongoose',require],['mongodb',mongooseRequire],['bson',mongoRequire]]) {
    const entry=resolver.resolve(name);let folder=path.dirname(entry);
    while(!fs.existsSync(path.join(folder,'package.json'))) {
      const parent=path.dirname(folder);assert.notEqual(parent,folder);folder=parent;
    }
    const packageFile=path.join(folder,'package.json'),pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
    const relative=path.relative(root,folder).replaceAll(path.sep,'/');
    assert.equal(pkg.name,name);assert.equal(lock.packages[relative]?.version,pkg.version);
    packages[name]={version:pkg.version,entry:path.relative(root,entry),entrySha256:sha(fs.readFileSync(entry)),
      package:path.relative(root,packageFile),packageSha256:sha(fs.readFileSync(packageFile))};
  }
  assert.equal(packages.bson.version,'6.10.4');
  return {format:1,node:process.version,v8:process.versions.v8,typescript:ts.version,mongoose:mongoose.version,
    nodeSha256:sha(fs.readFileSync(process.execPath)),hashes,packages,dependencies,imports,declarations,observedImports,
    typeDiagnostics:diagnostics,extractedSha256:sha(extracted),typecheckSha256:sha(typecheck),
    compiledSha256:sha(compiled.outputText),caseCount:records.length,
    schemaPaths:Object.fromEntries(Object.entries(models).map(([key,model])=>[key,
      Object.fromEntries(Object.entries(model.schema.paths).map(([name,type])=>[name,type.instance]))])),
    limitation:'offline collection reply fixtures; actual Mongo matching, sorting, aggregate behavior and pooling use the ignored private-Mongo suite'};
}
(async()=>{
  await generate();
  const result={metadata:provenance(),records};
  const files=[['ai_usage_ledger_queries_reference.json',JSON.stringify(result,null,2)+'\n'],
    ['ai_usage_ledger_queries_extracted.ts',extracted],['ai_usage_ledger_queries_typecheck.ts',typecheck],
    ['ai_usage_ledger_queries_compiled.cjs',compiled.outputText]];
  for(const [name,body] of files) {
    assert(body.length>0);const target=path.join(output,name);
    if(mode==='--write') assert(!fs.existsSync(target),`refuse overwrite ${name}`);
    else assert(fs.statSync(target).isFile() && fs.statSync(target).size>0,`missing/empty ${name}`);
  }
  for(const [name,body] of files) {
    const target=path.join(output,name);
    if(mode==='--write') fs.writeFileSync(target,body,{flag:'wx'});
    else assert.equal(fs.readFileSync(target,'utf8'),body,`source/native/toolchain/corpus drift ${name}`);
  }
  process.stdout.write(`${mode}: ${records.length} actual-source ledger query scenarios\n`);
})().catch(error=>{console.error(error);process.exitCode=1;});
