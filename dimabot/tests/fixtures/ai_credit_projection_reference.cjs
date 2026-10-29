'use strict';
// Actual bounded declarations, evaluated with fixed Date and real Node crypto.
// No production imports, no reconstructed billing algorithms, no Redis emulator.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sourcePath = path.join(root, 'src/utils/billing.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  source: 'a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6'
};
const hashes = {
  source: sha(Buffer.from(source)), package: sha(fs.readFileSync(path.join(root, 'package.json'))),
  lock: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  typescript: sha(fs.readFileSync(require.resolve('typescript'))),
  typescriptPackage: sha(fs.readFileSync(require.resolve('typescript/package.json'))),
  oracle: sha(fs.readFileSync(__filename)), node: sha(fs.readFileSync(process.execPath))
};
for (const [key, hash] of Object.entries(pins)) assert.equal(hashes[key], hash, key);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const names = [
  'PlanTier','AI_CREDITS_METER_ID','AI_CREDIT_LIMITS','AI_CREDITS_CACHE_TTL_SECONDS',
  'AI_CREDITS_CACHE_SCHEMA_VERSION','AiCreditStatus','AiCreditsData','PolarAiCreditsMeterLike',
  'toFiniteNumber','getAiCreditLimitForPlan','buildAiCreditsDataFromMeter',
  'applyAiCreditUsageToSnapshot','APPLY_AI_CREDIT_USAGE_SCRIPT','recordAiCreditUsage',
  'syncAiCreditExhaustionStatus','isAiCreditsExhausted'
];
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.equal(ast.parseDiagnostics.length, 0);
const found = new Map();
for (const statement of ast.statements) {
  const declared = ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.map(d => d.name.getText(ast))
    : statement.name ? [statement.name.text] : [];
  for (const name of declared.filter(n => names.includes(n))) {
    assert(!found.has(name), `duplicate ${name}`);
    found.set(name, statement);
  }
}
assert.equal(found.size, names.length);
// Stubs are signatures only. All runtime function bodies come from billing.ts.
const stubs = `
interface FixtureCache {
 eval(lua: string, options: {keys: string[], arguments: string[]}): Promise<number>;
 exists(key: string): Promise<number>; get(key: string): Promise<string|null>;
 set(key: string, value: string): Promise<unknown>; del(key: string): Promise<number>;
}
declare function getDragonflyClient(context: string): Promise<FixtureCache>;
declare function createHash(name: string): { update(value: string): {digest(encoding: string): string} };
`;
const extraction = names.map(n => found.get(n).getText(ast)).join('\n');
const virtualFile = path.join(root, '__ai_projection_oracle__.ts');
const virtualSource = stubs + extraction;
const compilerOptions = {target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, strict:true, noEmit:true, skipLibCheck:true, types:[]};
const host = ts.createCompilerHost(compilerOptions);
const hostRead = host.readFile.bind(host), hostExists = host.fileExists.bind(host);
host.readFile = f => f === virtualFile ? virtualSource : hostRead(f);
host.fileExists = f => f === virtualFile || hostExists(f);
const program = ts.createProgram([virtualFile], compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
const checker = program.getTypeChecker();
const checked = program.getSourceFile(virtualFile);
const types = {};
for (const statement of checked.statements) {
  if (statement.name && names.includes(statement.name.text)) {
    types[statement.name.text] = ts.isFunctionDeclaration(statement)
      ? checker.signatureToString(checker.getSignatureFromDeclaration(statement), undefined, ts.TypeFormatFlags.NoTruncation)
      : checker.typeToString(checker.getTypeAtLocation(statement.name), undefined, ts.TypeFormatFlags.NoTruncation);
  }
}
const declarations = names.map(name => {
  const s = found.get(name), start = s.getStart(ast), end = s.getEnd();
  const parameter = p => ({name:p.name.getText(ast),type:p.type?.getText(ast)??null,
    optional:!!p.questionToken||!!p.initializer,initializer:p.initializer?.getText(ast)??null});
  const shape = ts.isFunctionDeclaration(s) ? {parameters:s.parameters.map(parameter),returnType:s.type?.getText(ast)??null,
    async:!!s.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)}
    : ts.isInterfaceDeclaration(s) ? {members:s.members.map(m=>({name:m.name.getText(ast),type:m.type.getText(ast),optional:!!m.questionToken}))}
    : ts.isTypeAliasDeclaration(s) ? {type:s.type.getText(ast)} : null;
  return {name, kind:ts.isVariableStatement(s)?'VariableStatement':ts.SyntaxKind[s.kind], exported:!!s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword),
    startByte:Buffer.byteLength(source.slice(0,start)), endByte:Buffer.byteLength(source.slice(0,end)),
    text:s.getText(ast), sha256:sha(s.getText(ast)), type:types[name] || null,shape};
});
const transpiled = ts.transpileModule(extraction + '\nexport {APPLY_AI_CREDIT_USAGE_SCRIPT};', {
  compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}, reportDiagnostics:true
});
assert.equal(transpiled.diagnostics.length, 0);
const fixedMillis = 1767323045000; // 2026-01-02T03:04:05.000Z
let dateReads = 0;
class FixedDate extends Date {
  constructor(...args) { if (args.length) super(...args); else { super(fixedMillis); dateReads++; } }
  static now() { return fixedMillis; }
}
let active;
const context = vm.createContext({exports:{}, module:{exports:{}}, Date:FixedDate, Error,
  createHash:crypto.createHash,
  getDragonflyClient:async label => {
    active.acquisitions.push(label);
    if (active.acquireError) throw new Error('fixture acquisition failure');
    return active.cache;
  },
  console:{error:(prefix,payload) => active.logs.push({prefix,payload:encode(payload)})}
});
// CommonJS generated exports use exports; preserve normal aliasing.
context.exports = context.module.exports;
vm.runInContext(transpiled.outputText, context, {filename:'actual-billing-projection.js'});
const api = context.module.exports;
const bits = n => { const b=Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); };
// Every number has a raw binary64 tag, including -0/NaN/Infinity. Object fields
// are tuples to retain optional presence, UTF-16 keys and spread insertion order.
function encode(v) {
  if (v === undefined) return {$undefined:true};
  if (typeof v === 'number') return {$f64:bits(v)};
  if (Array.isArray(v)) return {$array:v.map(encode)};
  if (v && typeof v === 'object') return {$object:Object.keys(v).map(k => [k,encode(v[k])])};
  return v;
}
function expected(value) {
  const rawFields = {};
  if (value && typeof value === 'object') for (const key of ['version','used','limit','balance'])
    if (typeof value[key] === 'number') rawFields[key] = bits(value[key]);
  return {value:encode(value), wire:JSON.stringify(value), rawFields};
}
const cases = [];
function pure(kind, input, call) {
  const before=dateReads, value=call();
  cases.push({id:`${kind}-${cases.length}`,kind,input:encode(input),expected:expected(value),dateReads:dateReads-before});
}
const tiers=['free','premium','pro',null,undefined];
for (const tier of tiers) pure('limit',{tier},()=>api.getAiCreditLimitForPlan(tier));
const numbers=[0,-0,Number.MIN_VALUE,-Number.MIN_VALUE,0.1,-0.1,0.5,-0.5,1.5,-1.5,
  25000,25001,2**52-0.5,2**52,2**53-1,2**53,Number.MAX_VALUE,-Number.MAX_VALUE,NaN,Infinity,-Infinity];
const strings=['',' ','\t\n','\ufeff\u2028','\u0085','0','-0',' 2.5 ','0x100','0o77','0b11',
  '0x20000000000001','0x1fffffffffffff','0x','-0x1','1e309','Infinity','-Infinity','NaN','garbage','5e-324','9007199254740993','\ud800'];
const atoms=[undefined,null,...numbers,...strings];
for (const tier of tiers) {
  for (const meter of [undefined,null,{}]) for (const at of [undefined,'', 'date\ud800😀'])
    pure('meter',{meter,tier,at},()=>api.buildAiCreditsDataFromMeter(meter,tier,at));
  for (const key of ['limit','credited_units','consumed_units','balance']) for (const atom of atoms) {
    const meter={[key]:atom};
    pure('meter',{meter,tier,at:undefined},()=>api.buildAiCreditsDataFromMeter(meter,tier));
  }
  for (const meter of [
    {credited_units:100,balance:40,consumed_units:-1}, {credited_units:100,balance:200},
    {credited_units:Number.MAX_VALUE,balance:-Number.MAX_VALUE},
    {limit:Number.MAX_VALUE,consumed_units:Number.MAX_VALUE,balance:Number.MAX_VALUE},
    {credited_units:100,balance:40,consumed_units:7.5}, {balance:0,consumed_units:25001},
    {balance:'40',consumed_units:'-1',credited_units:'100',limit:'0x100'},
    {balance:1000000,consumed_units:25}, {balance:-0,consumed_units:-0},
    {balance:-Number.MIN_VALUE,credited_units:Number.MIN_VALUE}
  ]) pure('meter',{meter,tier,at:'provided'},()=>api.buildAiCreditsDataFromMeter(meter,tier,'provided'));
}
const base={extra:'first',version:1,used:1,limit:25000,balance:2,meterId:'meter',updatedAt:'old',available:true,status:'available','2':'index',tail:{lone:'\ud800',n:null}};
const snapshots=[base,{...base,available:false}, {...base,used:-4,balance:-2},
  {...base,used:-0,balance:-0}, {...base,used:Number.MAX_VALUE,balance:Number.MAX_VALUE},
  {...base,used:NaN,balance:NaN},{...base,used:Infinity,balance:-Infinity},
  {tail:1,status:'exhausted',available:true,updatedAt:'x',meterId:'m',balance:0.5,limit:-0,used:2.5,version:NaN}];
for (const snapshot of snapshots) for (const credits of numbers) for (const at of [undefined,'','\ud800😀'])
  pure('apply',{snapshot,credits,at},()=>api.applyAiCreditUsageToSnapshot(snapshot,credits,at));

async function protocol(kind, input) {
  const calls=[], logs=[], acquisitions=[];
  const faults=input.faults || {};
  const cache={};
  for (const method of ['eval','exists','get','set','del']) cache[method]=async (...args)=>{
    // Commands are source calls. Replies are fixtures, never a copied Lua model.
    calls.push({method,args:encode(args)});
    const key=method==='eval'?'eval':args[0];
    if (faults[key]) {
      if (input.nonError) throw input.nonError;
      throw new Error('fixture command failure');
    }
    if (method==='eval') return input.evalResult ?? 0;
    if (method==='exists') return args[0].startsWith('twitch:') ? input.canonical : input.legacy;
    if (method==='get') return input.cached;
    if (method==='set') return 'OK';
    return 0;
  };
  active={cache,logs,acquisitions,acquireError:input.acquireError};
  const before=dateReads;
  let result, error;
  try {
    if (kind==='record') result=await api.recordAiCreditUsage(input.channel,input.credits,input.externalId,input.defaultCache?undefined:cache);
    else result=await api.isAiCreditsExhausted(input.channel,input.defaultCache?undefined:cache);
  } catch(e) {error=e instanceof Error?e.message:String(e);}
  cases.push({id:`${kind}-${cases.length}`,kind,input:encode(input),expected:{result:encode(result),error:error??null,calls,logs,acquisitions},dateReads:dateReads-before});
}
async function generate() {
  for (const channel of ['', ' chan ', '😀\ud800']) for (const credits of numbers) for (const externalId of [undefined,'','abc','😀','\ud800','\udc00'])
    await protocol('record',{channel,credits,externalId,defaultCache:false});
  for (const evalResult of [0,1,2]) await protocol('record',{channel:'r',credits:1.25,externalId:'abc',evalResult,defaultCache:true});
  for (const nonError of [undefined,'plain thrown string','\ud800'])
    await protocol('record',{channel:'\ud800',credits:1,externalId:'id',faults:{eval:true},nonError});
  for (const credits of [0,NaN,1]) await protocol('record',{channel:'r',credits,defaultCache:true,acquireError:true});
  await protocol('exhausted',{channel:'',defaultCache:true,acquireError:true});
  await protocol('exhausted',{channel:'x',defaultCache:true,acquireError:true});
  for (const canonical of [0,1,2]) for (const legacy of [0,1,2])
    await protocol('exhausted',{channel:'x',canonical,legacy,cached:null});
  const cachedValues=[undefined,null,'','{','null','[]','[1]','"exhausted"','true','false','0',
    '{}','{"status":"exhausted"}','{"status":"exhausted","available":false}',
    '{"available":true,"balance":0}','{"available":true,"balance":-0}',
    '{"available":true,"balance":-1}','{"available":true,"balance":1}',
    '{"available":true,"balance":"0"}','{"available":true,"balance":null}',
    '{"available":1,"balance":-1}','{"available":"true","balance":-1}',
    '{"available":true,"balance":-1e999}','{"available":true,"balance":1e999}',
    '{"status":true}','{"status":"available","available":true,"balance":-1}',
    '{"status":"exhausted","extra":"\\ud800"}'];
  for (const cached of cachedValues) await protocol('exhausted',{channel:'x',canonical:0,legacy:0,cached,defaultCache:true});
  for (const key of ['twitch:x:ai:exhaust','x:ai:exhaust','twitch:x:ai:credits'])
    await protocol('exhausted',{channel:'x',canonical:0,legacy:0,cached:'{}',faults:{[key]:true}});
  // SET faults must not also fault the preceding EXISTS on that same key.
  for (const existingFlag of [false,true]) for (const failingKey of ['twitch:x:ai:exhaust','x:ai:exhaust']) {
    const input={channel:'x',canonical:existingFlag?1:0,legacy:0,cached:'{"status":"exhausted"}',setFault:failingKey};
    // Wrap fixture before source call, targeting only SET.
    await protocolWithSetFault(input);
  }
  const counts={}; for (const c of cases) counts[c.kind]=(counts[c.kind]||0)+1;
  return {metadata:{schema:2,node:process.version,v8:process.versions.v8,typescript:ts.version,hashes,
    extractionSha256:sha(extraction),typecheckSourceSha256:sha(virtualSource),transpiledSha256:sha(transpiled.outputText),typeDiagnostics:[],declarations,
    fixedMillis,constants:{meterId:api.AI_CREDITS_METER_ID,limits:api.AI_CREDIT_LIMITS,cacheTtl:api.AI_CREDITS_CACHE_TTL_SECONDS,schemaVersion:api.AI_CREDITS_CACHE_SCHEMA_VERSION},
    lua:api.APPLY_AI_CREDIT_USAGE_SCRIPT,luaSha256:sha(api.APPLY_AI_CREDIT_USAGE_SCRIPT),counts,total:cases.length},cases};
}
async function protocolWithSetFault(input) {
  // Independent cache functions still only record/reply; source owns control flow.
  const calls=[],logs=[],acquisitions=[];
  const cache={exists:async key=>{calls.push({method:'exists',args:encode([key])});return key.startsWith('twitch:')?input.canonical:input.legacy;},
    get:async key=>{calls.push({method:'get',args:encode([key])});return input.cached;},
    set:async (...args)=>{calls.push({method:'set',args:encode(args)});if(args[0]===input.setFault)throw new Error('fixture command failure');return 'OK';}};
  active={cache,logs,acquisitions};
  let result,error;
  try {result=await api.isAiCreditsExhausted(input.channel,cache);} catch(e){error=e.message;}
  cases.push({id:`exhausted-${cases.length}`,kind:'exhausted',input:encode(input),expected:{result:encode(result),error:error??null,calls,logs,acquisitions},dateReads:0});
}
(async()=>{
  const [mode,dir,...extra]=process.argv.slice(2);
  assert(['--write','--check'].includes(mode) && dir && extra.length===0,'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(),'parent must create the owned output directory');
  const output=path.join(fs.realpathSync(dir),'ai_credit_projection_reference.json');
  const result=JSON.stringify(await generate(),null,2)+'\n';
  const artifacts=[
    [output,result],
    [path.join(dir,'ai_credit_projection_extracted.ts'),extraction],
    [path.join(dir,'ai_credit_projection_typecheck.ts'),virtualSource],
    [path.join(dir,'ai_credit_projection_compiled.cjs'),transpiled.outputText]
  ];
  if(mode==='--write') {
    for(const [file] of artifacts)assert(!fs.existsSync(file),`refuse overwrite ${file}`);
    for(const [file,body] of artifacts)fs.writeFileSync(file,body,{flag:'wx'});
  }else for(const [file,body] of artifacts){const actual=fs.readFileSync(file,'utf8');assert(actual.length>0);assert.equal(actual,body,'metadata/source/matrix drift');}
  process.stdout.write(`${mode} ${output}\n`);
})().catch(e=>{console.error(e);process.exitCode=1;});
