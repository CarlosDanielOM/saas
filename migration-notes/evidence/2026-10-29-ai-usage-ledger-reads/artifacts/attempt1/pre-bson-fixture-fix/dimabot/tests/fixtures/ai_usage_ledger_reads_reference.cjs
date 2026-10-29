'use strict';
// Parent-only, offline actual-source oracle. The installed source schema and
// Mongoose execute complete extracted function declarations. The only model
// boundary replacement is collection.findOne: it records cast filters/options
// and returns explicit BSON replies. It does NOT implement Mongo matching.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const ts = require('typescript');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && !extra.length,
  'usage: --write EXTERNAL_DIRECTORY | --check EXTERNAL_DIRECTORY');
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const output = fs.realpathSync(directory);
assert(fs.statSync(output).isDirectory(), 'parent-owned directory must exist');
assert(output !== root && !output.startsWith(root + path.sep), 'fixtures must be external to crate');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pins = {
  'src/utils/ai_usage_ledger.ts':'3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5',
  'src/schemas/ai_usage_ledger_state.schema.ts':'ede6fc369c432d97bee0db835871c0773c1000023ac2c34ff044510c5c60121c',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
  'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
};
for (const [file, pin] of Object.entries(pins)) assert.equal(sha(read(file)), pin, `pinned ${file}`);

// Refuse networking before importing any application declaration or Mongoose.
const violations = [];
const forbidden = () => { violations.push('network/persistence'); throw Error('oracle forbids network/persistence'); };
require('node:net').Socket.prototype.connect = forbidden;
for (const key of ['connect','createConnection']) require('node:net')[key] = forbidden;
require('node:tls').connect = forbidden;
for (const name of ['node:http','node:https']) {
  require(name).get = forbidden;
  require(name).request = forbidden;
}
for (const name of ['node:dns','node:dns/promises']) {
  const dns = require(name);
  for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key) && typeof dns[key] === 'function') dns[key] = forbidden;
}
globalThis.fetch = forbidden;
const mongoosePackage = require('mongoose');
assert.equal(mongoosePackage.version, '8.24.2');
const mongoose = new mongoosePackage.Mongoose();
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
mongoose.set('bufferCommands', false);
for (const owner of [mongoosePackage, mongoose]) {
  owner.connect = forbidden;
  owner.createConnection = forbidden;
  owner.Connection.prototype.openUri = forbidden;
}
mongoose.mongo.MongoClient.prototype.connect = forbidden;
mongoose.mongo.MongoClient.connect = forbidden;
const BSON = mongoose.mongo.BSON;
const ledgerFile = 'src/utils/ai_usage_ledger.ts';
const schemaFile = 'src/schemas/ai_usage_ledger_state.schema.ts';
const ledger = read(ledgerFile), schema = read(schemaFile);
const ast = ts.createSourceFile(ledgerFile, ledger, ts.ScriptTarget.ES2022, true);
const schemaAst = ts.createSourceFile(schemaFile, schema, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
assert.deepEqual(schemaAst.parseDiagnostics, []);
const exported = n => !!n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const declarations = [];
function select(file, source, tree, name, kind) {
  const candidates = tree.statements.filter(n => n.name?.text === name ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === name));
  assert.equal(candidates.length, 1, `unique source declaration ${name}`);
  const node = candidates[0];
  if (kind === 'VariableStatement') assert(ts.isVariableStatement(node));
  else assert.equal(ts.SyntaxKind[node.kind], kind);
  assert(exported(node), `exported ${name}`);
  const text = node.getText(tree) + '\n';
  const start = node.getStart(tree), end = node.end;
  const parameters = ts.isFunctionDeclaration(node) ? node.parameters.map(p => ({
    name:p.name.getText(tree), type:p.type.getText(tree), optional:!!p.questionToken,
  })) : [];
  declarations.push({file,name,kind,text,sha256:sha(text),
    startByte:Buffer.byteLength(source.slice(0,start)),endByte:Buffer.byteLength(source.slice(0,end)),
    parameters,returnType:node.type?.getText(tree) ?? null});
  return text;
}
const names = ['hasAiUsageLedgerCoverage','getAiUsageLedgerStatus','getAiUsageLedgerState'];
const selected = [select(ledgerFile,ledger,ast,'AI_USAGE_REPORT_VERSION','VariableStatement'),
  select(ledgerFile,ledger,ast,'AiUsageLedgerStatus','InterfaceDeclaration'),
  ...names.map(name => select(ledgerFile,ledger,ast,name,'FunctionDeclaration'))];
const stateInterface = select(schemaFile,schema,schemaAst,'IAiUsageLedgerState','InterfaceDeclaration');
const imports = ast.statements.filter(ts.isImportDeclaration).map(n => ({
  text:n.getText(ast), module:n.moduleSpecifier.text, typeOnly:!!n.importClause?.isTypeOnly,
}));
const runtimeModelImport = imports.filter(i => i.module === '../schemas/ai_usage_ledger_state.schema.js');
assert.equal(runtimeModelImport.length, 1);
assert.equal(runtimeModelImport[0].typeOnly, false);
assert.deepEqual(schemaAst.statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text), ['mongoose']);
const extracted = selected.join('\n');
const stubs = stateInterface + `
declare const AiUsageLedgerStateSchema: {
 exists(filter: unknown): Promise<unknown>;
 findOne(filter: unknown): {
  select(projection: string): {
   lean(): {exec(): Promise<IAiUsageLedgerState | null>}
  }
 }
};
`;
const typecheck = stubs + extracted;
const virtualFile = path.join(root,'__ai_usage_ledger_reads_oracle__.ts');
const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,
  noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host = ts.createCompilerHost(options);
const oldRead = host.readFile.bind(host), oldExists = host.fileExists.bind(host);
host.readFile = f => f === virtualFile ? typecheck : oldRead(f);
host.fileExists = f => f === virtualFile || oldExists(f);
const program = ts.createProgram([virtualFile],options,host);
const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText,'\n'));
assert.deepEqual(diagnostics, []);
const compiled = ts.transpileModule(extracted,{reportDiagnostics:true,
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
assert.deepEqual(compiled.diagnostics, []);
const observedImports = [];
function evaluate(file, source, isSchema=false) {
  const module = {exports:{}};
  const compiledSource = isSchema ? ts.transpileModule(source,{reportDiagnostics:true,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}) : compiled;
  assert.deepEqual(compiledSource.diagnostics, []);
  const requireSource = name => {
    observedImports.push({file,name});
    if (isSchema && name === 'mongoose') return {Schema:mongoose.Schema,model:mongoose.model.bind(mongoose)};
    violations.push(`unexpected source import ${name}`);
    throw Error(`oracle refuses source import ${name}`);
  };
  vm.runInNewContext(compiledSource.outputText,{module,exports:module.exports,require:requireSource,
    Date,AiUsageLedgerStateSchema:isSchema?undefined:Model},{filename:file,timeout:10000});
  return module.exports;
}
const Model = evaluate(schemaFile,schema,true).default;
assert(Model.schema instanceof mongoose.Schema);
assert.equal(Model.collection.name, 'ai_usage_ledger_states');
const source = evaluate(ledgerFile,extracted);
assert.equal(source.AI_USAGE_REPORT_VERSION, 3);

const bits = number => { const b=Buffer.alloc(8); b.writeDoubleBE(number); return b.toString('hex'); };
function encode(value) {
  if (value === undefined) return {$undefined:true};
  if (value instanceof Date) return {$date:Number.isNaN(value.getTime())?null:String(value.getTime())};
  if (typeof value === 'number') return {$f64:bits(value)};
  if (typeof value === 'string') return {$utf16:Array.from({length:value.length},(_,i)=>value.charCodeAt(i))};
  if (value?._bsontype) return {$bson:BSON.EJSON.serialize(value,{relaxed:false})};
  if (Array.isArray(value)) return {$array:value.map(encode)};
  if (value && typeof value === 'object') return {$object:Object.keys(value).map(k=>[k,encode(value[k])])};
  return value;
}
function bsonBytes(document) { return BSON.serialize(document); }
const records = [];
const baseState = () => ({_id:new BSON.ObjectId('000000000000000000000001'),
  coverageStart:new Date(0),backfilledAt:new Date(123),reportVersion:3,ignored:'projection-noise'});
async function scenario(id, op, input, reply, configuration={}) {
  const calls = [];
  // Reply bytes are stored before Node BSON promotion; Rust reads the same BSON.
  const bytes = reply === null ? null : bsonBytes(reply);
  Model.collection.findOne = async (filter, options) => {
    calls.push({filterHex:bsonBytes(filter).toString('hex'),
      projectionHex:bsonBytes(options.projection ?? {}).toString('hex'),
      optionsKeys:Object.keys(options).sort()});
    if (configuration.driverError) throw Object.assign(new Error('owned fixture read failed'),{name:'MongoServerError',code:12345});
    return bytes === null ? null : BSON.deserialize(bytes);
  };
  let value, error = null;
  try { value = await source[op](input); }
  catch (e) { error={name:e.name,path:e.path??null,message:e.message,code:e.code??null}; }
  assert.equal(mongoose.connection.readyState, 0);
  records.push({id,op,input:encode(input),replyHex:bytes?.toString('hex')??null,
    driverError:!!configuration.driverError,calls,
    result:error?null:encode(value),error});
}
async function generate() {
  const identity={channelID:'channel',customerId:'customer'};
  for (const [id, patch, remove] of [
    ['absent',null,[]],['ready',{},[]],['old-version',{reportVersion:2},[]],
    ['missing-version',{},['reportVersion']],['missing-coverage',{},['coverageStart']],
    ['null-coverage',{coverageStart:null},[]],['string-coverage',{coverageStart:'1970-01-01'},[]],
    ['number-coverage',{coverageStart:0},[]],['object-coverage',{coverageStart:{getTime:null}},[]],
    ['missing-sync',{},['backfilledAt']],['null-sync',{backfilledAt:null},[]],
    ['string-sync',{backfilledAt:''},[]],['number-sync',{backfilledAt:0},[]],
  ]) {
    const state=patch===null?null:{...baseState(),...patch};
    if(state) for(const key of remove) delete state[key];
    await scenario(id+':state',names[2],identity,state);
    await scenario(id+':status',names[1],{...identity,startsAt:new Date(0)},state);
  }
  const versions=[null,false,true,0,-0,NaN,-Infinity,Infinity,2,2.9999999999999996,3,3.0000000000000004,
    '', ' ', '3',' 0x3 ','\ufeff3\u3000','\u00853','Infinity','NaN',
    [],[null],[3],['3'],[[['3']]],['3','4'],{}, {valueOf:3},{toString:null},[{toString:null}],
    new BSON.Int32(3),new BSON.Double(-0),new BSON.Long(0,0),
    BSON.Long.fromString('9007199254740992'),BSON.Long.fromString('9007199254740993'),
    BSON.Long.fromString('-9007199254740992'),BSON.Long.fromString('-9007199254740993'),
    BSON.Decimal128.fromString('0'),BSON.Decimal128.fromString('3'),BSON.Decimal128.fromString('NaN'),
    BSON.Decimal128.fromString('3.0000000000000001'),BSON.Decimal128.fromString('Infinity'),
    new Date(0),new Date(3),new BSON.ObjectId('000000000000000000000003'),
    new BSON.Binary(Buffer.from('3')),new BSON.Binary(Buffer.from([0xff])),
    new BSON.UUID('00000000-0000-0000-0000-000000000003'),
    new BSON.Timestamp({t:0,i:0}),new BSON.Timestamp({t:0,i:3}),new BSON.MinKey(),new BSON.MaxKey(),
    new BSON.Code('3'),new BSON.BSONSymbol('3')];
  for(let i=0;i<versions.length;i++) {
    const state={...baseState(),reportVersion:versions[i]};
    await scenario(`version-${i}:state`,names[2],identity,state);
    await scenario(`version-${i}:status`,names[1],{...identity,startsAt:new Date(0)},state);
  }
  // Actual JS String/Number coercion of BSON wrappers nested in arrays and
  // ordinary objects, including a later method-shadowing TypeError.
  for(const version of [[BSON.Decimal128.fromString('3')],[new Date(3)],{x:new BSON.Long(1,10000000)},
    [new Date(3),{toString:null}],[new BSON.Binary(Buffer.from('3'))],
    [BSON.Long.fromString('9007199254740993')],[[BSON.Decimal128.fromString('3')]]]) {
    const state={...baseState(),reportVersion:version};
    await scenario(`nested-${records.length}:state`,names[2],identity,state);
    await scenario(`nested-${records.length}:status`,names[1],{...identity,startsAt:new Date(0)},state);
  }
  await scenario('dbref-numeric-coercion',names[1],{...identity,startsAt:new Date(0)},
    {...baseState(),reportVersion:{$ref:'ledger',$id:new BSON.ObjectId('000000000000000000000003'),toString:null}});
  for(const starts of [-1,0,1,NaN,-8640000000000000,8640000000000000,-62167219200000,253402300800000]) {
    await scenario(`starts-${starts}:status`,names[1],{...identity,startsAt:new Date(starts)},baseState());
    await scenario(`starts-${starts}:absent-status`,names[1],{...identity,startsAt:new Date(starts)},null);
  }
  // BSON Date supports a wider range than JS Date. Deserialize actual wire
  // dates at/beyond TimeClip rather than serializing an invalid JS Date (0).
  for(const field of ['coverageStart','backfilledAt'])
  for(const millis of ['-8640000000000001','-8640000000000000','8640000000000000','8640000000000001','9223372036854775807']) {
    const bytes=bsonBytes(baseState());
    const marker=Buffer.from(field+'\0');
    const position=bytes.indexOf(marker)+marker.length;
    assert(position>=marker.length);
    bytes.writeBigInt64LE(BigInt(millis),position);
    const raw=BSON.deserialize(bytes,{promoteValues:false});
    // Keep those raw wire bytes: a new JS Date cannot reserialize the original
    // invalid timestamp. Override only the reply returned by this scenario.
    for(const op of [names[2],names[1]]) {
      const id=`wire-date-${field}-${millis}:${op}`;
      const calls=[];
      Model.collection.findOne=async(filter,options)=>{
        calls.push({filterHex:bsonBytes(filter).toString('hex'),projectionHex:bsonBytes(options.projection??{}).toString('hex'),optionsKeys:Object.keys(options).sort()});
        return BSON.deserialize(bytes);
      };
      const input={...identity,...(op===names[1]?{startsAt:new Date(0)}:{})};
      let result=null,error=null;
      try{result=encode(await source[op](input));}catch(e){error={name:e.name,path:e.path??null,message:e.message,code:e.code??null};}
      records.push({id,op,input:encode(input),replyHex:bytes.toString('hex'),driverError:false,calls,result,error});
    }
    assert(raw[field] instanceof Date);
  }
  for(const state of [null,{...baseState(),backfilledAt:{toString:null},reportVersion:{toString:null}},
    {...baseState(),coverageStart:new Date(1),reportVersion:{toString:null}},
    {...baseState(),coverageStart:new Date(-1),reportVersion:{toString:null}}]) {
    await scenario(`ordering-${records.length}`,names[1],{...identity,startsAt:new Date(NaN)},state);
  }
  for(const channelID of ['',' a ','\ud800','\udc00','a\ud800b','😀','a\0b','__proto__']) {
    const input={channelID,customerId:channelID,startsAt:new Date(0)};
    await scenario(`identity-${records.length}:status`,names[1],input,baseState());
    await scenario(`identity-${records.length}:coverage`,names[0],input,{_id:new BSON.ObjectId('000000000000000000000001')});
  }
  for(const startsAt of [new Date(-8640000000000000),new Date(0),new Date(8640000000000000),new Date(NaN)]) {
    for(const reply of [null,{_id:new BSON.ObjectId('000000000000000000000001')}])
      await scenario(`exists-${records.length}`,names[0],{...identity,startsAt},reply);
  }
  for(const op of names) await scenario(`driver-error:${op}`,op,{...identity,startsAt:new Date(0)},null,{driverError:true});
  assert.equal(violations.length,0);
  assert.equal(mongoose.connection.readyState,0);
  assert(records.length > 150);
  assert.equal(new Set(records.map(r=>r.id)).size, records.length);
  return records;
}

function provenance() {
  const nativeFiles=['Cargo.toml','Cargo.lock','rust-toolchain.toml','src/lib.rs','src/utils/mod.rs',
    'src/schemas/mod.rs','src/schemas/schema.rs','src/schemas/ai_usage_ledger_state.schema.rs',
    'src/utils/ai_usage_ledger_reads.rs','src/utils/bson_compat.rs','src/utils/credit_policy.rs',
    'src/utils/js_string.rs','src/utils/json_number.rs','src/utils/lossless_json.rs',
    'src/utils/js_compat.rs','src/utils/tts/settings.rs','src/utils/tts/usage.rs',
    'tests/ai_usage_ledger_reads.rs','tests/fixtures/ai_usage_ledger_reads_reference.cjs'];
  const files=[...new Set([...Object.keys(pins),...nativeFiles])];
  const hashes=Object.fromEntries(files.map(file=>[file,sha(fs.readFileSync(path.join(root,file)))]));
  const dependencies=Object.fromEntries(Object.keys(require.cache).filter(f=>f.includes('/node_modules/')).sort()
    .map(file=>[path.relative(root,file),sha(fs.readFileSync(file))]));
  const mongooseRequire=createRequire(require.resolve('mongoose'));
  const mongoRequire=createRequire(mongooseRequire.resolve('mongodb'));
  const lock=JSON.parse(read('package-lock.json')), packages={};
  for(const [name,resolver] of [['typescript',require],['mongoose',require],['mongodb',mongooseRequire],['bson',mongoRequire]]) {
    const entry=resolver.resolve(name);
    let folder=path.dirname(entry);
    while(!fs.existsSync(path.join(folder,'package.json'))) {
      const parent=path.dirname(folder);assert.notEqual(parent,folder);folder=parent;
    }
    const packageFile=path.join(folder,'package.json'), pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
    const relative=path.relative(root,folder).replaceAll(path.sep,'/');
    assert.equal(pkg.name,name); assert.equal(lock.packages[relative]?.version,pkg.version);
    packages[name]={version:pkg.version,entry:path.relative(root,entry),entrySha256:sha(fs.readFileSync(entry)),
      package:path.relative(root,packageFile),packageSha256:sha(fs.readFileSync(packageFile))};
  }
  assert.equal(packages.bson.version,'6.10.4');
  return {format:1,node:process.version,v8:process.versions.v8,typescript:ts.version,mongoose:mongoose.version,
    nodeSha256:sha(fs.readFileSync(process.execPath)),hashes,packages,dependencies,imports,declarations,
    observedImports,typeDiagnostics:diagnostics,extractedSha256:sha(extracted),typecheckSha256:sha(typecheck),
    compiledSha256:sha(compiled.outputText),caseCount:records.length,
    limitation:'collection reply fixture; Mongo matching and pooling require the ignored disposable-native test'};
}
(async()=>{
  await generate();
  const result={metadata:provenance(),records};
  const files=[['ai_usage_ledger_reads_reference.json',JSON.stringify(result,null,2)+'\n'],
    ['ai_usage_ledger_reads_extracted.ts',extracted],['ai_usage_ledger_reads_typecheck.ts',typecheck],
    ['ai_usage_ledger_reads_compiled.cjs',compiled.outputText]];
  // Preflight all four paths before any write. Exclusive opens also close the
  // race between existence inspection and creation; --check never writes.
  for(const [name,body] of files) {
    assert(body.length>0);
    const target=path.join(output,name);
    if(mode==='--write') assert(!fs.existsSync(target),`refuse overwrite ${name}`);
    else assert(fs.statSync(target).isFile() && fs.statSync(target).size>0,`missing/empty ${name}`);
  }
  for(const [name,body] of files) {
    const target=path.join(output,name);
    if(mode==='--write') fs.writeFileSync(target,body,{flag:'wx'});
    else assert.equal(fs.readFileSync(target,'utf8'),body,`source/native/toolchain/corpus drift: ${name}`);
  }
  process.stdout.write(`${mode}: ${records.length} actual-source read scenarios\n`);
})().catch(error=>{console.error(error);process.exitCode=1;});
