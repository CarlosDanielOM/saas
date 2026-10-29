'use strict';
// Parent-only execution: pinned, offline, disposable, capped toolchain. Public
// modes are exactly --write DIR (exclusive) and --check DIR (byte-exact).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');
const ts = require('typescript');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dir && !extra.length, 'usage: --write DIR | --check DIR');
assert(fs.statSync(dir).isDirectory(), 'existing parent-owned fixture directory required');
const zones = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Apia'];
const root = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bits = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); };

// Install before importing Mongoose or evaluating ANY application declaration.
// No actual socket, DNS lookup, HTTP request or Mongoose connection is allowed.
const violations = [];
const forbiddenIO = () => { violations.push('network/persistence IO'); throw Error('oracle attempted forbidden network/persistence IO'); };
require('node:net').Socket.prototype.connect = forbiddenIO;
require('node:net').connect = forbiddenIO;
require('node:net').createConnection = forbiddenIO;
require('node:tls').connect = forbiddenIO;
for (const module of ['node:http', 'node:https']) {
  require(module).request = forbiddenIO;
  require(module).get = forbiddenIO;
}
for (const module of ['node:dns', 'node:dns/promises']) {
  const dns = require(module);
  for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key) && typeof dns[key] === 'function') dns[key] = forbiddenIO;
}
globalThis.fetch = forbiddenIO;
const mongoosePackage = require('mongoose');
const mongoose = new mongoosePackage.Mongoose();
// Inhibit model initialization work; field casting still uses the unmodified
// source schema definition and installed Mongoose implementation.
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
mongoose.set('bufferCommands', false);
for (const owner of [mongoosePackage, mongoose]) {
  owner.connect = forbiddenIO;
  owner.createConnection = forbiddenIO;
  owner.Connection.prototype.openUri = forbiddenIO;
}
mongoose.mongo.MongoClient.prototype.connect = forbiddenIO;
mongoose.mongo.MongoClient.connect = forbiddenIO;
const BSON = mongoose.mongo.BSON;
assert.equal(typeof BSON.serialize, 'function');
assert.equal(typeof BSON.deserialize, 'function');

const evidence = [];
const parsedFiles = new Map();
const exported = node => !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
function ast(file) {
  if (!parsedFiles.has(file)) parsedFiles.set(file, ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return parsedFiles.get(file);
}
function declaration(file, name, isExported) {
  const a = ast(file);
  const matches = a.statements.filter(n => n.name?.text === name ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(a) === name));
  assert.equal(matches.length, 1, `unique actual declaration ${file}:${name}`);
  const n = matches[0];
  assert.equal(exported(n), isExported, `export contract ${name}`);
  const text = n.getText(a);
  evidence.push({file, name, kind:ts.SyntaxKind[n.kind], exported:exported(n), text, sha256:sha(text)});
  return n;
}
const ledger = 'src/utils/ai_usage_ledger.ts';
const selectedNames = [
  ['RETENTION_DAYS', false], ['VALID_CATEGORIES', false], ['validTier', false],
  ['expiryFor', false], ['safeCategory', false], ['nullableString', false], ['finiteNumber', false],
  ['getAiUsageRetentionDays', true], ['buildQueuedAiUsageReceipt', true],
  ['parseQueuedAiUsageReceipt', true], ['receiptDocument', false], ['QueuedAiUsageReceipt', true],
];
const selected = selectedNames.map(([name, exp]) => declaration(ledger, name, exp).getText(ast(ledger)));
const parserNode = ast(ledger).statements.find(n => n.name?.text === 'parseQueuedAiUsageReceipt');
assert(ts.isFunctionDeclaration(parserNode));
assert.deepEqual(parserNode.parameters.map(p => [p.name.getText(ast(ledger)), p.type.getText(ast(ledger)), !!p.questionToken]), [['raw','string',false]]);
assert.equal(parserNode.type.getText(ast(ledger)), 'QueuedAiUsageReceipt | null');
const documentNode = ast(ledger).statements.find(n => n.name?.text === 'receiptDocument');
assert.deepEqual(documentNode.parameters.map(p => [p.name.getText(ast(ledger)), p.type.getText(ast(ledger))]), [['receipt','QueuedAiUsageReceipt'],['planTier','AiUsageRetentionTier']]);
assert.equal(documentNode.type, undefined, 'private inferred return type');
const imports = ast(ledger).statements.filter(ts.isImportDeclaration).map(n => n.getText(ast(ledger)));
const extracted = imports.concat(selected, 'export { receiptDocument };').join('\n');
const typeSpecs = {
  'src/utils/ai_usage_event.ts':['AiUsageContext','AiUsageContextInput','AiUsageEntryKind','AiUsageCategory','AiUsageUnit','AiUsageResourceType'],
  'src/utils/ai_usage_receipts.ts':['AiUsageTransaction','AiUsageReceiptCategory'],
  'src/schemas/ai_usage_receipt.schema.ts':['AiUsageRetentionTier','IAiUsageReceipt'],
};
for (const [file, names] of Object.entries(typeSpecs)) for (const name of names) {
  const n = declaration(file, name, true);
  assert(ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n));
}
for (const [file, names] of Object.entries({
  'src/utils/ai_usage_classification.ts':[['ADJUSTMENT_TYPES',true],['classifyAdjustment',true]],
  'src/utils/ai_usage_event.ts':[['AI_USAGE_SCHEMA_VERSION',true],['AI_USAGE_PRICING_VERSION',true],['classifyLegacyReason',false],['optionalFinite',false],['optionalText',false],['createAiUsageContext',true]],
})) for (const [name, exp] of names) declaration(file, name, exp);
const schemaFile = 'src/schemas/ai_usage_receipt.schema.ts';
declaration(schemaFile, 'aiUsageReceiptSchema', false);
declaration(schemaFile, 'AiUsageReceiptSchema', false);
assert.deepEqual(ast(schemaFile).statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text), ['mongoose']);
const observedImports = [];
function forbiddenImport(name) {
  const fail = () => { violations.push(`application import ${name}`); throw Error(`unused application import touched: ${name}`); };
  return new Proxy(fail, {get:fail, apply:fail, construct:fail});
}
function evaluate(file, source) {
  const module = {exports:{}};
  const requireSource = name => {
    observedImports.push({file, name});
    if (file === schemaFile && name === 'mongoose') return {Schema:mongoose.Schema,model:mongoose.model.bind(mongoose)};
    if (name === './ai_usage_classification.js') return classification;
    if (file === 'src/utils/ai_usage_event.ts' && name === 'node:crypto') return {randomUUID:forbiddenIO};
    return forbiddenImport(name);
  };
  const result = ts.transpileModule(source, {fileName:file, reportDiagnostics:true,
    compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, esModuleInterop:false}});
  assert(!result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error), 'transpile diagnostics');
  vm.runInNewContext(result.outputText, {module, exports:module.exports, require:requireSource, Date}, {filename:file, timeout:10000});
  return module.exports;
}
const classification = evaluate('src/utils/ai_usage_classification.ts', read('src/utils/ai_usage_classification.ts'));
const event = evaluate('src/utils/ai_usage_event.ts', read('src/utils/ai_usage_event.ts'));
const source = evaluate(ledger, extracted);
const Model = evaluate(schemaFile, read(schemaFile)).default;
assert(Model.schema instanceof mongoose.Schema, 'installed actual Mongoose schema');
assert.equal(mongoose.connection.readyState, 0);

// Expectations below come exclusively from real TS/Mongoose/BSON execution.
// describeBson records BSON types and UTF-8 bytes after actual serialize/read.
function describeBson(value) {
  if (value === null) return {type:'null'};
  if (value instanceof Date) return {type:'date', millis:String(value.getTime())};
  if (typeof value === 'string') return {type:'string', utf8:Buffer.from(value,'utf8').toString('hex'), value};
  if (typeof value === 'boolean') return {type:'bool', value};
  if (value?._bsontype === 'Int32') return {type:'int32', value:value.value};
  if (value?._bsontype === 'Double') return {type:'double', bits:bits(value.value)};
  if (value?._bsontype === 'Long') return {type:'int64', value:value.toString()};
  throw Error(`unexpected BSON type ${typeof value} ${value?._bsontype}`);
}
function documentResult(receipt, tier) {
  const document = source.receiptDocument(receipt, tier);
  const invalidExpiry = Number.isNaN(document.expiresAt.getTime());
  const rawFields = Object.keys(document).map(key => {
    const v = document[key];
    const date = v instanceof Date;
    return {key, type:date?'date':v===null?'null':typeof v,
      ...(date?{millis:Number.isNaN(v.getTime())?null:String(v.getTime())}:
        typeof v==='number'?{bits:bits(v)}:typeof v==='string'?{units:Array.from({length:v.length},(_,i)=>v.charCodeAt(i))}:{value:v})};
  });
  try {
    // _castUpdate is the installed Mongoose query path, without exec(),
    // connections, generated timestamps/defaults/_id/version or middleware.
    // This is precisely the receiptDocument projection of $setOnInsert.
    const query = Model.updateOne({}, {}, {upsert:true});
    // Model.updateOne decorates its own update with __v. Supply the source
    // projection directly to the real caster so middleware fields remain out
    // of this receiptDocument-only comparison, without rewriting cast results.
    const cast = query._castUpdate({$setOnInsert:document}).$setOnInsert;
    assert.deepEqual(Object.keys(cast), Object.keys(document), 'cast projection keys/order');
    const bytes = BSON.serialize(cast);
    const decoded = BSON.deserialize(bytes, {promoteValues:false});
    const fields = Object.keys(decoded).map(key => ({key, ...describeBson(decoded[key])}));
    assert.equal(mongoose.connection.readyState, 0);
    return {tier, rawFields, error:null, hex:bytes.toString('hex'), fields};
  } catch (error) {
    // A valid occurredAt at the positive TimeClip edge has invalid expiresAt.
    // Preserve this real schema casting failure instead of emitting invalid BSON.
    assert(invalidExpiry, `unexpected schema failure: ${error.stack}`);
    return {tier, rawFields, error:{name:error.name,path:error.path ?? null}, hex:null, fields:null};
  }
}

const cases = [];
const base = {channelID:'channel', customerId:'customer', id:'entry', occurredAt:'2026-10-29T12:34:56.789Z', credits:1.25};
const addRaw = (id, raw, producer=null) => cases.push({id, raw, producer});
const add = (id, patch={}, missing=[]) => {
  const value = {...base, ...patch};
  for (const key of missing) delete value[key];
  addRaw(id, JSON.stringify(value));
};
for (const key of ['channelID','customerId','id','occurredAt','credits','requestId','entryKind','category','operation','source','adjustmentType','reason','provider','model','quantity','unit','resourceType','resourceId','itemized']) {
  add(`${key}:missing`, {}, [key]);
  for (const value of [null,false,true,0,-1,'','  ','x','\ud800','\udc00',[],[null],['activation'],{}, {toString:null}, {valueOf:3}]) add(`${key}:value:${cases.length}`, {[key]:value});
}
for (const entryKind of ['usage','adjustment','ADJUSTMENT',null,[],{}])
  for (const adjustmentType of [...classification.ADJUSTMENT_TYPES,'REFUND',null,[],['refund'],{toString:0}])
    add(`explicit:${cases.length}`, {entryKind, adjustmentType, credits:-0.25, source:'polar_meter_credit', operation:'monthly_reset'});
for (const entryKind of ['usage','adjustment'])
  for (const credits of [0,-1])
    for (const source of ['polar_meter_credit','free_credit_reset','free_credit_reset_worker','admin_credit_grant','credit_pack_purchase','activation','unknown',['activation'],['polar_meter_credit'],{toString:null},' activation ','activation\ud800'])
      for (const operation of ['monthly_reset','purchase_pack','refund','correction','grant',['refund'],{toString:null}])
        add(`policy:${cases.length}`, {entryKind,credits,source,operation,reason:'Free benefits'});
for (const category of ['tts','ai_chat','ai_agent','memory','clip_recommendation','credit_adjustment','other','uncategorized','TTS',' tts ',['tts']]) add(`category:${cases.length}`,{category});
for (const unit of ['characters','tokens','minutes','TOKENS',' tokens ',null,['tokens']]) add(`unit:${cases.length}`,{unit});
for (const resourceType of ['speech','voice_preview','llm_generation','vod_analysis','speech ',['speech']]) add(`resource:${cases.length}`,{resourceType});
for (const itemized of [true,false,1,'true',[true],{},null]) add(`itemized:${cases.length}`,{itemized});
const numericTokens = ['0','-0','1.25','-1.25','5e-324','-5e-324','1.7976931348623157e308','1e309','-1e309','2147483647','2147483648','-2147483648','-2147483649','9007199254740991','9007199254740992','9007199254740993','1e21','1e-7','1e-6','0.49999999999999994','0.5000000000000001','2.2250738585072014e-308'];
for (const key of ['credits','quantity','channelID','id']) for (const token of numericTokens) {
  addRaw(`binary64:${key}:${token}`, JSON.stringify({...base,[key]:null}).replace(`"${key}":null`,`"${key}":${token}`));
}
for (const key of ['credits','quantity']) for (const value of ['-0','NaN','Infinity','+Infinity','-Infinity','inf','infinity',' 0x20000000000001 ','0x20000000000003','0b101','0o777','-0x1','+0b1','1e309','\ufeff\u20281.25\u3000','\u00851','0x'+'f'.repeat(260),[null],[],['-0'],[[['1']]],['1','2'],[{}],[{toString:null}],{toString:null},{valueOf:null},{}]) add(`numeric-coercion:${cases.length}`,{[key]:value});
const spaces = ['\t','\n','\v','\f','\r',' ','\u00a0','\u1680', ...Array.from({length:11},(_,i)=>String.fromCharCode(0x2000+i)), '\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff','\u0085','\u180e','\u200b'];
for (const key of ['requestId','operation','source','provider','model','resourceId']) {
  for (const ws of spaces) add(`trim:${key}:${cases.length}`,{[key]:ws+' edge '+ws});
  for (const value of ['a'.repeat(127)+'😀tail','a'.repeat(126)+'😀tail','a'.repeat(128)+'😀','\ud800'+'a'.repeat(128),'a'.repeat(127)+'\udc00tail','\ud800\ud800\udc00','\udc00\ud800','\ufeff\ud800 \u3000','a\u0000b','"\\\n\u2028\u2029','😀'.repeat(66),'\u0085 x \u0085']) add(`utf16:${key}:${cases.length}`,{[key]:value});
}
const dates = [
  '1970-01-01','0000-01-01','-000001-01-01T00:00:00Z','+010000-01-01T00:00:00Z',
  '+275760-09-13T00:00:00.000Z','+275760-09-13T00:00:00.001Z',
  '-271821-04-20T00:00:00.000Z','-271821-04-19T23:59:59.999Z',
  '2026-02-30','2026-13-01','2026-10-29T24:00:00Z','2026-10-29T24:00:00.001Z',
  '2026-10-29T12:34:56.123456+05:30','2026-10-29T12:34:56.123-02:30',
  '2026-10-29T12:34:56','2026-10-29','2026-03-08T02:30:00','2026-11-01T01:30:00',
  '2026-03-29T02:30:00','2026-10-25T02:30:00','2026-10-04T02:15:00',
  '2026-04-05T01:45:00','2011-12-30T12:00:00','1890-01-01T12:00:00',
  'October 29, 2026 12:34:56','Thu, 29 Oct 2026 12:34:56 GMT','01/02/03','0','49','50',
  '2026-10-29\u0000ignored','2026-10-29\ud800','2026-10-29 (comment)',
  '\ufeff2026-10-29\u00a0','2026-10-29T12:34Z','2026-10-29T12:34:60Z',
  '2026-10-29T12:34:56+2400','not-a-date','',null,false,true,0,1,2026,
  ['2026-10-29'],[['2026-10-29']],[null],{}, {toString:null},
];
for (const occurredAt of dates) add(`date:${cases.length}`,{occurredAt});
for (const raw of ['', '{', 'null', 'true', 'false', '42', '"x"', '[]','[1,2]', '{}','{"credits":NaN}','{"credits":+1}','{"credits":01}','{"credits":Infinity}', '{"x":"\\uZZZZ"}', '{"x":"\n"}', JSON.stringify(base)+'false', '\ufeff'+JSON.stringify(base)]) addRaw(`invalid:${cases.length}`,raw);
addRaw('duplicates-integer-own-proto', '{"10":10,"2":2,"01":1,"channelID":"old","channelID":"new\\ud800","customerId":"u","id":"e","occurredAt":"1970-01-01","credits":1,"credits":-0,"__proto__":{"toString":null},"constructor":null,"4294967295":3,"0":0}');
add('own-toString-explicit-short-circuit',{entryKind:'adjustment',adjustmentType:'other',source:{toString:null},operation:{toString:null}});
add('usage-own-toString-unused',{entryKind:'usage',source:{toString:null},operation:{toString:null}});
add('quantity-coercion-throw',{quantity:[[{toString:null}]]});
add('id-coercion-throw',{id:[{toString:null}]});
add('id-array-null-empty',{id:[null,[],['a','b']]});
add('unknown-deep-within-shared-limit',{ignored:Array.from({length:1},()=>({nested:'ignored'}))});
// Mandatory integration guards, retained from the original author. The owned
// service reader keeps its 128-level cap; only the opt-in borrowed path changes.
for (const depth of [129,256]) {
  const nested = '['.repeat(depth)+'"x"'+']'.repeat(depth);
  addRaw(`deep-unknown:${depth}`,JSON.stringify({...base,ignored:null}).replace('"ignored":null',`"ignored":${nested}`));
  addRaw(`deep-coercion:${depth}`,JSON.stringify({...base,id:null}).replace('"id":null',`"id":${nested}`));
  for (const [key, leaf] of [['credits','"-0"'],['quantity','"0x20000000000003"'],['occurredAt','"1970-01-01"'],['channelID','[]'],['id','[null,[],["\\ud800","x"]]'],['quantity','{"toString":null}']]) {
    const token = '['.repeat(depth)+leaf+']'.repeat(depth);
    addRaw(`deep-field:${depth}:${key}:${cases.length}`,JSON.stringify({...base,[key]:null}).replace(`"${key}":null`,`"${key}":${token}`));
  }
  const wrap = leaf => '['.repeat(depth)+JSON.stringify(leaf)+']'.repeat(depth);
  addRaw(`deep-classifier:${depth}`,JSON.stringify({...base,entryKind:'adjustment',source:null,operation:null}).replace('"source":null',`"source":${wrap('activation')}`).replace('"operation":null',`"operation":${wrap('refund')}`));
  addRaw(`deep-strict-fields:${depth}`,JSON.stringify({...base,category:null,unit:null,resourceType:null,requestId:null,itemized:null}).replace('"category":null',`"category":${nested}`).replace('"unit":null',`"unit":${nested}`).replace('"resourceType":null',`"resourceType":${nested}`).replace('"requestId":null',`"requestId":${nested}`).replace('"itemized":null',`"itemized":${nested}`));
}
const deepIgnored = '['.repeat(4096)+'{"escaped":"\\ud800","n":1e9999}'+']'.repeat(4096);
addRaw('deep-unknown:4096',JSON.stringify({...base,ignored:null}).replace('"ignored":null',`"ignored":${deepIgnored}`));
const deepObject = '{"ignored":'.repeat(4096)+'null'+'}'.repeat(4096);
addRaw('deep-unknown-object:4096',JSON.stringify({...base,ignored:null}).replace('"ignored":null',`"ignored":${deepObject}`));
for (const depth of [129,256,4096]) {
  for (const token of ['01','1.','1e+','+1','NaN','[1,]','[1 2]','{"x":}','{"x":1,}','{"x" 1}','"\\uZZZZ"','"\\q"','"raw\ncontrol"']) {
    const invalid = '['.repeat(depth)+token+']'.repeat(depth);
    addRaw(`deep-invalid:${depth}:${cases.length}`,JSON.stringify({...base,ignored:null}).replace('"ignored":null',`"ignored":${invalid}`));
  }
}

// Shared-view expectations are native JSON.parse/Boolean/String/Number results,
// never a hand-written coercion model. Results are shallow observations so the
// fixture writer itself never stringifies a deeply nested parsed value.
const viewCases = [];
const viewRaw = (id, raw, keys=[]) => viewCases.push({id,raw,keys});
for (const raw of ['null','false','true','-0','1e309','-1e309','5e-324','""','"\\ud800"','"😀"','[]','[null,[]]','[null,[],["a","b"]]','[[null,[]],[[],null],[],[null,["x",null]]]','[["\\ud800",null],["😀","\\udc00"]]','[{},null,[false,true,-0,1e309]]','{}','{"valueOf":null}','{"toString":null}','{"toString":1,"toString":null}','[{"toString":null}]','{"__proto__":{"toString":null}}']) viewRaw(`plain:${viewCases.length}`,raw);
viewRaw('duplicate-utf16-keys','{"id":"old","\\u0069d":"last\\ud800","\\ud800":1,"\\ud800":2,"nil":null,"to\\u0053tring":0,"toString":null}',['id','\ud800','nil','missing','toString']);
viewRaw('numeric-fields','{"nil":null,"empty":[],"zero":[[[" -0 "]]],"hex":["\\ufeff0x20000000000003\\u3000"],"bad":"\\ud800","object":{}}',['nil','missing','empty','zero','hex','bad','object']);
for (const depth of [129,256]) for (const leaf of ['"x"','[null,[],["\\ud800","x"]]','{"toString":null}','[]','" -0 "']) viewRaw(`deep-join:${depth}:${viewCases.length}`,'['.repeat(depth)+leaf+']'.repeat(depth));
viewRaw('ignored:4096',`{"unknown":${deepIgnored},"wanted":"ok","after":-0}`,['wanted','after','missing']);
viewRaw('ignored-object:4096',`{"unknown":${deepObject},"wanted":"ok"}`,['wanted']);
viewRaw('deep-own-toString:4096',`{"toString":${deepIgnored},"id":${deepObject},"id":"last"}`,['id']);
for (const depth of [0,129,256,4096]) {
  for (const token of ['01','1e+','[1,]','[,1]','{"x":}','{"x":1,}','"\\q"','"\\u12XZ"','"raw\ncontrol"']) viewRaw(`invalid:${depth}:${viewCases.length}`,'['.repeat(depth)+token+']'.repeat(depth));
  const valid = '['.repeat(depth)+'null'+']'.repeat(depth);
  for (const raw of [valid+'false','\ufeff'+valid,valid+'\v',valid+']','['+valid]) viewRaw(`whole-input:${depth}:${viewCases.length}`,raw);
}
const units = value => Array.from({length:value.length},(_,i)=>value.charCodeAt(i));
function attempt(action, describe) {
  try { return {value:describe(action()),error:null}; }
  catch (error) { return {value:null,error:{name:error.name,message:error.message}}; }
}
function observe(value) {
  return {kind:value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value,
    truthy:Boolean(value),string:attempt(()=>String(value),units),number:attempt(()=>Number(value),bits),
    scalar:typeof value==='string'?{units:units(value)}:typeof value==='number'?{bits:bits(value)}:typeof value==='boolean'?{value}:null};
}
function observeView(c) {
  let value;
  try { value = JSON.parse(c.raw); }
  catch (error) { return {...c,valid:false,parseError:error.name}; }
  return {...c,valid:true,root:observe(value),properties:c.keys.map(key=>({key,observation:observe(Object.hasOwn(value,key)?value[key]:undefined)}))};
}
// Deliberately separate engine resource exhaustion from ordinary TypeError and
// deterministic coercion. This probe records the pinned source boundary; native
// semantics at this depth are NOT asserted equal to V8's stack-size accident.
const boundaryRaw = '['.repeat(16384)+'"x"'+']'.repeat(16384);
function resourceBoundary() {
  const value = JSON.parse(boundaryRaw);
  return {depth:16384,raw:boundaryRaw,string:attempt(()=>String(value),units),number:attempt(()=>Number(value),bits),
    receiptAccepted:source.parseQueuedAiUsageReceipt(JSON.stringify({...base,id:null}).replace('"id":null',`"id":${boundaryRaw}`))!==null,
    policy:'V8 resource observation only; no native coercion parity assertion at this depth'};
}
// Producers are real source functions, with explicit date/IDs and no UUID or
// clock sampling. Keep recipe + exact generated wire so native replay also
// verifies that the public producer emits these same inputs when enabled.
for (const reason of ['tts_fish','tts_kokoro','tts_piper','messages','harness_tools','harness_end','planner','coding_agent','stream_summary','weekly_summary','monthly_summary','vod_clip_recommendation','Free benefits','',' Odd '])
  for (const credits of [0,-0,1.25,-1.25]) {
    const input = {entryId:`generated-${cases.length}`,requestId:' req ',model:' model ',quantity:0,unit:'characters',resourceType:'speech',resourceId:' resource '};
    const context = event.createAiUsageContext(reason,input);
    const receipt = source.buildQueuedAiUsageReceipt({channelID:'channel',customerId:'customer',context,occurredAt:new Date(0),credits});
    addRaw(`producer:${reason}:${bits(credits)}`,JSON.stringify(receipt),{kind:'event',reason,input,creditsBits:bits(credits)});
  }
for (const value of ['\ud800','\udc00','😀','a'.repeat(127)+'😀tail']) {
  const context = {entryId:'id'+value,requestId:value,entryKind:'adjustment',category:'tts',operation:'refund',source:'source'+value,provider:value,model:value,quantity:NaN,unit:'minutes',resourceType:'voice_preview',resourceId:value};
  const receipt = source.buildQueuedAiUsageReceipt({channelID:'c'+value,customerId:'u'+value,context,occurredAt:new Date(0),credits:-0.25});
  addRaw(`producer:utf16:${cases.length}`,JSON.stringify(receipt),{kind:'lossless',contextWire:JSON.stringify(context),quantityBits:bits(NaN),creditsBits:bits(-0.25),channelID:'c'+value,customerId:'u'+value});
}
assert(cases.length >= 250);
assert.equal(new Set(cases.map(c=>c.id)).size,cases.length,'unique IDs');
const sourceFiles = [
  ledger,'src/utils/ai_usage_classification.ts','src/utils/ai_usage_event.ts','src/utils/ai_usage_receipts.ts',schemaFile,
  'src/utils/ai_usage.rs','src/utils/ai_usage_producer.rs','src/utils/ai_credit_projection.rs',
  'src/utils/ai_usage_receipts/values.rs','src/utils/ai_usage_receipts/queue.rs','src/utils/ai_usage_receipts.rs',
  'src/utils/js_date/mod.rs','src/utils/js_date/parser.rs','src/utils/js_date/local_time.rs',
  'src/utils/credit_policy.rs','src/utils/tts/usage.rs','src/utils/tts/settings.rs',
  'src/utils/js_string.rs','src/utils/lossless_json.rs','src/utils/js_compat.rs','src/utils/json_number.rs','src/utils/bson_compat.rs',
  'src/utils/ai_usage_receipt_parser.rs','tests/ai_usage_receipt_parser.rs',
  'src/utils/lossless_json_view.rs','tests/lossless_json_view.rs',
  'src/utils/mod.rs','Cargo.toml','Cargo.lock','package.json','package-lock.json',
  'tests/fixtures/ai_usage_receipt_parser_reference.cjs',
];
function provenance() {
  const hashes = Object.fromEntries(sourceFiles.map(file=>[file,sha(fs.readFileSync(path.join(root,file)))]));
  const dependencies = {};
  // Hash exact installed code, packages, lock and reader, rather than claiming
  // package versions alone identify a Mongoose/BSON implementation.
  for (const file of Object.keys(require.cache).filter(f=>f.includes('/node_modules/')).sort()) dependencies[path.relative(root,file)] = sha(fs.readFileSync(file));
  const mongooseRequire = createRequire(require.resolve('mongoose'));
  const mongodbFile = mongooseRequire.resolve('mongodb');
  const mongoRequire = createRequire(mongodbFile);
  const packages = {};
  const lock = JSON.parse(read('package-lock.json'));
  for (const [name, resolver] of [['typescript',require],['mongoose',require],['mongodb',mongooseRequire],['bson',mongoRequire]]) {
    // BSON restricts package.json exports; resolve it by walking from entry.
    let folder = path.dirname(resolver.resolve(name));
    while (!fs.existsSync(path.join(folder,'package.json'))) {
      const parent = path.dirname(folder); assert.notEqual(parent,folder); folder=parent;
    }
    const file = path.join(folder,'package.json');
    const pkg = JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(pkg.name,name);
    const relative = path.relative(root,folder).replaceAll(path.sep,'/');
    assert.equal(lock.packages[relative]?.version,pkg.version,`installed/lock ${name}`);
    packages[name] = {version:pkg.version, packagePath:path.relative(root,file), packageSha256:sha(fs.readFileSync(file)), entryPath:path.relative(root,resolver.resolve(name)), entrySha256:sha(fs.readFileSync(resolver.resolve(name)))};
  }
  assert.equal(packages.mongoose.version,'8.24.2');
  assert.equal(packages.bson.version,'6.10.4');
  return {format:2,node:process.version,v8:process.versions.v8,typescript:ts.version,
    icu:process.versions.icu,tzdata:process.versions.tz,
    nodeSha256:sha(fs.readFileSync(process.execPath)),hashes,packages,dependencies,
    extractedSha256:sha(extracted),ast:{imports,declarations:evidence},observedImports,
    contract:'JSON plain own properties; lossless UTF16 + binary64; BSON projection excludes persistence middleware',
    caseCount:cases.length,viewCaseCount:viewCases.length,zones};
}
const childZone = process.env.DIMA_AI_RECEIPT_ORACLE_CHILD;
if (childZone !== undefined) {
  assert(zones.includes(childZone));
  assert.equal(process.env.TZ, childZone);
  const records = cases.map(c => {
    const receipt = source.parseQueuedAiUsageReceipt(c.raw);
    return {...c, output:receipt===null?null:{wire:JSON.stringify(receipt), keys:Object.keys(receipt),
      creditsBits:bits(receipt.credits),quantityBits:receipt.quantity===null?null:bits(receipt.quantity),
      stringUnits:Object.fromEntries(Object.entries(receipt).filter(([,v])=>typeof v==='string').map(([k,v])=>[k,Array.from({length:v.length},(_,i)=>v.charCodeAt(i))])),
      documents:['free','premium','pro'].map(tier=>documentResult(receipt,tier))}};
  });
  for (const id of ['deep-unknown:129','deep-unknown:256','deep-coercion:129','deep-coercion:256','deep-unknown:4096','deep-unknown-object:4096']) {
    assert.notEqual(records.find(record=>record.id===id)?.output,null,`source accepts mandatory ${id}`);
    assert(records.some(record=>record.id===id),`mandatory case exists: ${id}`);
  }
  const views = viewCases.map(observeView);
  const boundary = resourceBoundary();
  assert.equal(mongoose.connection.readyState,0);
  assert.deepEqual(violations,[], 'caught source errors must not mask forbidden side effects');
  process.stdout.write(JSON.stringify({zone:childZone,metadata:provenance(),records,
    views,resourceBoundary:boundary}));
} else {
  const results = zones.map(zone=> {
    const child = spawnSync(process.execPath,[__filename,mode,dir],{
      env:{...process.env,TZ:zone,DIMA_AI_RECEIPT_ORACLE_CHILD:zone},encoding:'utf8',maxBuffer:256*1024*1024,timeout:180000,
    });
    assert.equal(child.status,0,`${zone}: ${child.error?.stack ?? child.stderr}`);
    const result = JSON.parse(child.stdout);
    assert.equal(result.zone,zone);
    assert.equal(result.records.length,cases.length);
    assert.equal(result.views.length,viewCases.length);
    return result;
  });
  for (const result of results) assert.deepEqual(result.metadata,results[0].metadata,'same source/dependencies/reader across fresh TZ processes');
  const output = {metadata:results[0].metadata,results:results.map(({zone,records,views,resourceBoundary})=>({zone,records,views,resourceBoundary}))};
  const bytes = JSON.stringify(output,null,2)+'\n';
  const file = path.join(dir,'ai_usage_receipt_parser_reference.json');
  if (mode === '--write') fs.writeFileSync(file,bytes,{flag:'wx'});
  else assert.equal(fs.readFileSync(file,'utf8'),bytes,'exact source/provenance/corpus/result check');
  process.stdout.write(JSON.stringify({file,sha256:sha(bytes),caseCount:cases.length,zones:zones.length})+'\n');
}
