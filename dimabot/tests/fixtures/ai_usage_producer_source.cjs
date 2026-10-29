'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const ts=require('typescript');
assert.equal(process.version,'v24.22.1','strict Node pin');
assert.equal(process.versions.v8,'13.6.233.17-node.58','strict V8 pin');
assert.equal(ts.version,'5.9.3','strict TS pin');
function loadSource(realm) {
  assert(['vm','commonjs'].includes(realm));
const root = path.resolve(__dirname, '../..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const ledgerFile = 'src/utils/ai_usage_ledger.ts';
const ledger = read(ledgerFile);
const ast = ts.createSourceFile(ledgerFile, ledger, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const exported = n => !!n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const wanted = ['AI_USAGE_RECEIPT_QUEUE_KEY', 'AI_USAGE_RECEIPT_PROCESSING_KEY', 'RETENTION_DAYS', 'VALID_CATEGORIES', 'validTier', 'safeCategory', 'finiteNumber', 'getAiUsageRetentionDays', 'buildQueuedAiUsageReceipt', 'enqueueAiUsageReceipt', 'QueuedAiUsageReceipt'];
const selected = [];
const evidence = [];
for (const name of wanted) {
  const matches = ast.statements.filter(n => n.name?.text === name ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
  assert.equal(matches.length, 1, `one actual declaration: ${name}`);
  const n = matches[0];
  const mustExport = !['RETENTION_DAYS','VALID_CATEGORIES','validTier','safeCategory','finiteNumber'].includes(name);
  assert.equal(exported(n), mustExport, `export contract: ${name}`);
  selected.push(n.getText(ast));
  evidence.push({name, kind:ts.SyntaxKind[n.kind], exported:exported(n), text:n.getText(ast), sha256:sha(n.getText(ast))});
}
const queued = ast.statements.find(n => n.name?.text === 'QueuedAiUsageReceipt');
assert(ts.isInterfaceDeclaration(queued));
assert.deepEqual(queued.heritageClauses.map(h => h.getText(ast)), ['extends AiUsageTransaction']);
assert.deepEqual(queued.members.map(m => m.name.getText(ast)), ['channelID','customerId']);
const typeNames = {
  'src/utils/ai_usage_event.ts':['AiUsageContext','AiUsageContextInput','AiUsageEntryKind','AiUsageCategory','AiUsageUnit','AiUsageResourceType'],
  'src/utils/ai_usage_receipts.ts':['AiUsageTransaction','AiUsageReceiptCategory'],
  'src/schemas/ai_usage_receipt.schema.ts':['AiUsageRetentionTier'],
};
const interfaceContracts = {
  AiUsageContext:[['schemaVersion',false,'typeof AI_USAGE_SCHEMA_VERSION'],['pricingVersion',false,'typeof AI_USAGE_PRICING_VERSION'],['entryId',false,'string'],['requestId',false,'string'],['parentRequestId',true,'string'],['entryKind',false,'AiUsageEntryKind'],['category',false,'AiUsageCategory'],['operation',false,'string'],['source',false,'string'],['provider',false,'string'],['model',true,'string'],['channelID',true,'string'],['quantity',true,'number'],['unit',true,'AiUsageUnit'],['resourceType',true,'AiUsageResourceType'],['resourceId',true,'string']],
  AiUsageContextInput:[['entryId',true,'string'],['requestId',true,'string'],['parentRequestId',true,'string'],['entryKind',true,'AiUsageEntryKind'],['category',true,'AiUsageCategory'],['operation',true,'string'],['source',true,'string'],['provider',true,'string'],['model',true,'string'],['channelID',true,'string'],['quantity',true,'number'],['unit',true,'AiUsageUnit'],['resourceType',true,'AiUsageResourceType'],['resourceId',true,'string']],
  AiUsageTransaction:[['id',false,'string'],['requestId',false,'string | null'],['occurredAt',false,'string'],['entryKind',false,'AiUsageEntryKind'],['category',false,'AiUsageReceiptCategory'],['operation',false,'string'],['source',true,'string | null'],['adjustmentType',true,'string | null'],['provider',false,'string'],['model',false,'string | null'],['quantity',false,'number | null'],['unit',false,'AiUsageUnit | null'],['credits',false,'number'],['resourceType',false,'AiUsageResourceType | null'],['resourceId',false,'string | null'],['itemized',false,'boolean']],
};
const types = [];
for (const [file,names] of Object.entries(typeNames)) {
  const a = ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  for (const name of names) {
    const n = a.statements.find(n => n.name?.text === name);
    assert(n && (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && exported(n), `exported type ${file}:${name}`);
    if (interfaceContracts[name]) assert.deepEqual(n.members.map(m=>[m.name.getText(a),!!m.questionToken,m.type.getText(a)]),interfaceContracts[name],`exact member contract ${name}`);
    types.push({file,name,kind:ts.SyntaxKind[n.kind],text:n.getText(a),sha256:sha(n.getText(a))});
  }
}
const sourceModules = [];
for (const [file,names] of Object.entries({
  'src/utils/ai_usage_classification.ts':['ADJUSTMENT_TYPES','classifyAdjustment'],
  'src/utils/ai_usage_event.ts':['AI_USAGE_SCHEMA_VERSION','AI_USAGE_PRICING_VERSION','classifyLegacyReason','optionalFinite','optionalText','createAiUsageContext'],
})) {
  const a=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const declarations=names.map(name=>{
    const found=a.statements.filter(n=>n.name?.text===name || ts.isVariableStatement(n) && n.declarationList.declarations.some(d=>d.name.getText(a)===name));
    assert.equal(found.length,1,`actual source dependency ${file}:${name}`);
    const n=found[0];
    const privateHelper=['classifyLegacyReason','optionalFinite','optionalText'].includes(name);
    assert.equal(exported(n),!privateHelper);
    return {name,kind:ts.SyntaxKind[n.kind],exported:exported(n),text:n.getText(a),sha256:sha(n.getText(a))};
  });
  sourceModules.push({file,declarations});
}
const buildDecl = ast.statements.find(n => n.name?.text === 'buildQueuedAiUsageReceipt');
assert.equal(buildDecl.parameters.length,1);
assert.deepEqual(buildDecl.parameters[0].type.members.map(m => [m.name.getText(ast),!!m.questionToken,m.type.getText(ast)]),[
  ['channelID',false,'string'],['customerId',false,'string'],['occurredAt',true,'Date'],['context',false,'AiUsageContext'],['credits',false,'number'],
]);
assert.equal(buildDecl.type.getText(ast),'QueuedAiUsageReceipt | null');
const enqueueDecl = ast.statements.find(n => n.name?.text === 'enqueueAiUsageReceipt');
assert.deepEqual(enqueueDecl.parameters.map(p => [p.name.getText(ast),p.type.getText(ast)]),[['cache','RedisClientType'],['receipt','QueuedAiUsageReceipt | null']]);
assert.equal(enqueueDecl.type.getText(ast),'Promise<void>');
const getterDecl = ast.statements.find(n => n.name?.text === 'getAiUsageRetentionDays');
assert.equal(getterDecl.parameters[0].type.getText(ast),'unknown');
assert.equal(getterDecl.type.getText(ast),'number');
// Extract the real import declarations, real selected declarations and ALL
// private dependencies of this slice. Any newly introduced dependency fails at
// evaluation rather than silently running an algorithm handwritten in the reader.
const imports = ast.statements.filter(ts.isImportDeclaration).map(n => n.getText(ast));
const extracted = imports.concat(selected).join('\n');
const observedImports = [];
function forbidden(name) {
  const fail = () => { throw Error(`unused runtime import executed: ${name}`); };
  return new Proxy(fail, {get:fail,apply:fail,construct:fail});
}
let clockCalls = 0;
const fixedNow = 1793232000123;
class FixtureDate extends Date {
  constructor(...args) { if (!args.length) { clockCalls++; super(fixedNow); } else super(...args); }
  static now() { clockCalls++; return fixedNow; }
}
const loaded = new Map();
function evaluate(file, source) {
  const module = {exports:{}};
  const requireSource = name => {
    observedImports.push(name);
    if (name === './ai_usage_classification.js') return load('src/utils/ai_usage_classification.ts');
    if (name === './ai_usage_event.js') return load('src/utils/ai_usage_event.ts');
    if (name === 'node:crypto') return {randomUUID: crypto.randomUUID};
    // Model/lock imports are allowed to be loaded but cannot be touched. This
    // proves the extracted request-time exports need no Mongoose runtime.
    return forbidden(name);
  };
  const js = ts.transpileModule(source,{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:false}}).outputText;
  if (realm === 'vm') vm.runInNewContext(js,{module,exports:module.exports,require:requireSource,Date:FixtureDate},{filename:file,timeout:10000});
  else new Function('module','exports','require','Date',js)(module,module.exports,requireSource,FixtureDate);
  return module.exports;
}
function load(file) { if (!loaded.has(file)) loaded.set(file,evaluate(file,read(file))); return loaded.get(file); }
const producer = evaluate(ledgerFile,extracted);
const classification = load('src/utils/ai_usage_classification.ts');
const event = load('src/utils/ai_usage_event.ts');
assert.equal(classification.ADJUSTMENT_TYPES.length,10,'all ten actual explicit adjustment types');
return {root,sha,ledgerFile,extracted,evidence,types,imports,sourceModules,observedImports,producer,classification,event,fixedNow,resetClock:()=>{clockCalls=0;},readClock:()=>clockCalls};
}
module.exports={loadSource};
