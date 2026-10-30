'use strict';
// Actual source only. Parent runs --write DIR and --check DIR in the pinned snapshot.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  'src/utils/ai_usage_event.ts':'87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'typescript':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node':'569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108',
};
const hashes = Object.fromEntries(Object.keys(pins).map(p => [p, sha(p === 'node' ? fs.readFileSync(process.execPath) : p.startsWith('typescript') ? fs.readFileSync(require.resolve(p)) : read(p))]));
for (const [p, hash] of Object.entries(pins)) assert.equal(hashes[p], hash, p);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const sourcePath = path.join(root, 'src/utils/ai_usage_event.ts');
const source = read('src/utils/ai_usage_event.ts').toString();
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
const exported = n => !!n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const declaration = name => {
  const found = ast.statements.filter(n => n.name?.text === name || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
  assert.equal(found.length, 1, name); return found[0];
};
const input = declaration('AiUsageContextInput');
assert(ts.isInterfaceDeclaration(input) && exported(input));
const members = input.members.map(m => [m.name.getText(ast), !!m.questionToken, m.type.getText(ast)]);
assert.deepEqual(members, [['entryId',true,'string'],['requestId',true,'string'],['parentRequestId',true,'string'],['entryKind',true,'AiUsageEntryKind'],['category',true,'AiUsageCategory'],['operation',true,'string'],['source',true,'string'],['provider',true,'string'],['model',true,'string'],['channelID',true,'string'],['quantity',true,'number'],['unit',true,'AiUsageUnit'],['resourceType',true,'AiUsageResourceType'],['resourceId',true,'string']]);
const typeNames = ['AiUsageEntryKind','AiUsageCategory','AiUsageUnit','AiUsageResourceType','AiUsageContext','PolarUsageMetadataShape'];
const typeEvidence = typeNames.map(name => {
  const n = declaration(name);
  assert(exported(n) && (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)), name);
  return {name,kind:ts.SyntaxKind[n.kind],declaration:n.getText(ast),sha256:sha(n.getText(ast))};
});
const runtimeExports = ['createAiUsageContext','toPolarUsageMetadata','enrichPolarUsageMetadata'];
const evidence = [input, ...runtimeExports.map(declaration)].map(n => ({name:n.name.text, kind:ts.SyntaxKind[n.kind], exported:exported(n), declaration:n.getText(ast), sha256:sha(n.getText(ast))}));
for (const name of runtimeExports) assert(ts.isFunctionDeclaration(declaration(name)) && exported(declaration(name)));
assert.deepEqual(runtimeExports.map(name => declaration(name).parameters.map(p => [p.name.getText(ast), p.type.getText(ast)])), [[['reason','string'],['input','AiUsageContextInput']],[['context','AiUsageContext']],[['accountingMetadata','T'],['context','AiUsageContext']]]);
assert.deepEqual(runtimeExports.map(name => declaration(name).type.getText(ast)), ['AiUsageContext','PolarUsageMetadataShape','T & PolarUsageMetadataShape']);
const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const virtual = path.join(root, '__ai_usage_lossless_node.d.ts');
const host = ts.createCompilerHost(options), readFile = host.readFile.bind(host), exists = host.fileExists.bind(host);
host.readFile = f => f === virtual ? "declare module 'node:crypto' { export function randomUUID(): string; }" : readFile(f);
host.fileExists = f => f === virtual || exists(f);
const program = ts.createProgram([sourcePath, virtual], options, host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')), []);
const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.deepEqual(compiled.diagnostics, []);
let uuidCalls = 0;
const moduleContext = {exports:{}, require(name) { assert.equal(name,'node:crypto'); return {randomUUID() { uuidCalls++; return '00000000-0000-4000-8000-000000000001'; }}; }};
vm.runInNewContext(compiled.outputText,moduleContext);
const api = moduleContext.exports;
const cases = [];
function add(id, reason, raw, accounting = '{}', quantityTag = null) {
  const value = JSON.parse(raw);
  if (quantityTag !== null) value.quantity = ({nan:NaN,positiveInfinity:Infinity,negativeInfinity:-Infinity})[quantityTag];
  const before = uuidCalls;
  const context = api.createAiUsageContext(reason,value);
  assert.equal(uuidCalls-before, String(value.entryId || '').trim() ? 0 : 1, `UUID fallback ${id}`);
  const metadata = api.toPolarUsageMetadata(context);
  const enriched = api.enrichPolarUsageMetadata(JSON.parse(accounting), context);
  cases.push({id,reason,raw,accounting,quantityTag,uuidCalls:uuidCalls-before,contextWire:JSON.stringify(context),metadataWire:JSON.stringify(metadata),enrichedWire:JSON.stringify(enriched)});
}
for (const reason of ['tts_fish','tts_kokoro','tts_piper','messages','harness_tools','harness_end','planner','coding_agent','stream_summary','weekly_summary','monthly_summary','vod_clip_recommendation','Free benefits','unknown','','  ','\ud800','😀','\udfff']) add('reason-'+cases.length,reason,'{}');
const fields = ['entryId','requestId','parentRequestId','operation','source','provider','model','channelID','resourceId'];
for (const field of fields) for (const value of ['', ' \t\ufeff\u2028 ', '\ufeff 😀\ud800\udfff\ud800 \u2029', '\u0085', 'abc', null, false, 0]) add(field+'-'+cases.length,'unknown',JSON.stringify({[field]:value}));
for (const field of ['entryKind','category','unit','resourceType']) for (const value of [null,'',false,0,'\ud800',field==='entryKind'?'adjustment':field==='category'?'tts':field==='unit'?'tokens':'speech']) add(field+'-'+cases.length,'messages',JSON.stringify({[field]:value}));
for (const raw of ['{}','{"quantity":0}','{"quantity":-0}','{"quantity":-1}','{"quantity":5e-324}','{"quantity":1.7976931348623157e308}','{"quantity":9007199254740991}','{"quantity":9007199254740992}','{"quantity":null}','{"quantity":"3"}']) add('quantity-'+cases.length,'messages',raw);
for (const tag of ['nan','positiveInfinity','negativeInfinity']) add('tag-'+tag,'messages','{}','{}',tag);
add('all-fields','planner',JSON.stringify({entryId:' id ',requestId:' req ',parentRequestId:' parent ',entryKind:'adjustment',category:'memory',operation:' op ',source:' src ',provider:' p ',model:' m ',channelID:' c ',quantity:-0.25,unit:'minutes',resourceType:'speech',resourceId:' r '}),'{"9":"number-key","z":1,"entry_id":"old","category":"old","request_id":"old","x":{"\\ud800":"\\udfff"},"entry_id":"new","2":"index"}');
add('duplicates','messages','{"entryId":"first","entryId":" last ","model":"first","model":" last "}','{"z":1,"operation":"old","z":2,"entry_id":"old","operation":"new"}');
const metadataCases = [];
for (const [id,raw,accounting] of [
  ['null-quantity','{"schemaVersion":1,"pricingVersion":"p","entryId":"id","requestId":"r","entryKind":"usage","category":"other","operation":"o","source":"s","provider":"p","parentRequestId":"","model":null,"channelID":false,"quantity":null,"unit":"","resourceType":null,"resourceId":""}','{"quantity":12,"model":"old","entry_id":"prior"}'],
  ['truthy-options','{"schemaVersion":1,"pricingVersion":"p","entryId":"id","requestId":"r","entryKind":"usage","category":"other","operation":"o","source":"s","provider":"p","parentRequestId":"\\ud800","model":"\\udfff","channelID":"😀","quantity":0,"unit":"tokens","resourceType":"speech","resourceId":"\\ud800"}','{"9":1,"entry_id":"old","operation":"old","2":1,"entry_id":"new"}'],
]) {
  const context=JSON.parse(raw), account=JSON.parse(accounting);
  metadataCases.push({id,raw,accounting,metadataWire:JSON.stringify(api.toPolarUsageMetadata(context)),enrichedWire:JSON.stringify(api.enrichPolarUsageMetadata(account,context))});
}
const nativeFiles=['src/utils/ai_usage_lossless.rs','src/utils/ai_usage.rs','src/utils/js_string.rs','src/utils/lossless_json.rs','src/utils/json_number.rs','src/utils/tts/settings.rs','tests/ai_usage_lossless.rs','tests/fixtures/ai_usage_lossless_reference.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
const nativeHashes=Object.fromEntries(nativeFiles.map(p=>[p,sha(read(p))]));
const output=JSON.stringify({metadata:{format:1,node:process.version,v8:process.versions.v8,typescript:ts.version,hashes,nativeHashes,evidence,typeEvidence,members,compiledSha256:sha(compiled.outputText),caseCount:cases.length,metadataCaseCount:metadataCases.length},cases,metadataCases},null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && !extra.length,'usage: --write DIR | --check DIR');
const real=fs.realpathSync(dir), repo=fs.realpathSync(root);
assert(real!==repo && !real.startsWith(repo+path.sep),'external directory required');
const name='ai_usage_lossless_reference.json', file=path.join(real,name);
if(mode==='--write'){assert.deepEqual(fs.readdirSync(real),[]);fs.writeFileSync(file,output,{flag:'wx'});}
else {assert.deepEqual(fs.readdirSync(real),[name]);assert.equal(fs.readFileSync(file,'utf8'),output,'exact fixture drift');}
