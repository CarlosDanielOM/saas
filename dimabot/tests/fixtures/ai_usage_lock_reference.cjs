'use strict';
// Source oracle only: evaluate the entire actual exported declaration. Redis
// methods record calls and return explicit fixture replies; no Redis/Lua model,
// real network, application imports or TypeScript control-flow reconstruction.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourcePath = path.join(root, 'src/utils/ai_usage_lock.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const pins = {
  source: 'c66763fc7ddc9ab1ab51f3d895c4ab20ef8b37ae62e59d799e960da972eda510',
  redisBootstrap: '0d08dd4cdb931633473227fb59f043251b7be59a09a034ef6f392e0f64aebe9c',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6'
};
const hashes = {
  source: sha(source),
  redisBootstrap: sha(fs.readFileSync(path.join(root, 'src/utils/databases/dragonfly.database.ts'))),
  package: sha(fs.readFileSync(path.join(root, 'package.json'))),
  lock: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  typescript: sha(fs.readFileSync(require.resolve('typescript'))),
  typescriptPackage: sha(fs.readFileSync(require.resolve('typescript/package.json'))),
  node: sha(fs.readFileSync(process.execPath)),
  oracle: sha(fs.readFileSync(__filename))
};
const nativeFiles = ['Cargo.toml','Cargo.lock','src/lib.rs','src/utils/mod.rs',
  'src/utils/ai_usage_lock.rs','src/utils/js_string.rs','src/utils/json_number.rs',
  'src/utils/js_compat.rs','src/utils/databases/dragonfly.database.rs',
  'tests/ai_usage_lock.rs','tests/ai_credit_projection_support/mod.rs'];
const nativeHashes = Object.fromEntries(nativeFiles.map(file => [file,sha(fs.readFileSync(path.join(root,file)))]));
for (const [name, pin] of Object.entries(pins)) assert.equal(hashes[name], pin, name);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');

const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
const exportedDeclarations = ast.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
assert.equal(exportedDeclarations.length, 1, 'complete export inventory changed');
const declaration = exportedDeclarations[0];
assert(ts.isFunctionDeclaration(declaration));
assert.equal(declaration.name.text, 'withAiUsageLock');
const imports = ast.statements.filter(ts.isImportDeclaration).map(s => ({text:s.getText(ast), module:s.moduleSpecifier.text,
  names:s.importClause.namedBindings.elements.map(e => e.name.text)}));
assert.deepEqual(imports.map(i => [i.module, i.names]), [
  ['node:crypto', ['createHash', 'randomUUID']],
  ['./databases/dragonfly.database.js', ['getDragonflyClient']]
]);
const extraction = declaration.getText(ast) + '\n';
// Signature stubs only; the source function body above is never rewritten.
const stubs = `
interface FixtureCache {
 set(key: string, owner: string, options: {NX: boolean, EX: number}): Promise<string|null>;
 eval(lua: string, options: {keys: string[], arguments: string[]}): Promise<unknown>;
}
declare function getDragonflyClient(caller: string): Promise<FixtureCache>;
declare function createHash(name: string): {update(value: string): {digest(encoding: string): string}};
declare function randomUUID(): string;
interface FixtureTimer {unref(): void}
declare function setInterval(callback: () => void, ms: number): FixtureTimer;
declare function clearInterval(timer: FixtureTimer): void;
declare function setTimeout(callback: (...args: any[]) => void, ms: number): FixtureTimer;
`;
const virtualFile = path.join(root, '__ai_usage_lock_oracle__.ts');
const typecheckSource = stubs + extraction;
const options = {target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, strict:true,
  noEmit:true, skipLibCheck:true, types:[], lib:['lib.es2022.d.ts']};
const host = ts.createCompilerHost(options);
const oldRead = host.readFile.bind(host), oldExists = host.fileExists.bind(host);
host.readFile = file => file === virtualFile ? typecheckSource : oldRead(file);
host.fileExists = file => file === virtualFile || oldExists(file);
const program = ts.createProgram([virtualFile], options, host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
const checker = program.getTypeChecker();
const checked = program.getSourceFile(virtualFile).statements.find(s => s.name?.text === 'withAiUsageLock');
const signature = checker.signatureToString(checker.getSignatureFromDeclaration(checked), undefined, ts.TypeFormatFlags.NoTruncation);
assert.equal(signature, '<T>(channelID: string, customerId: string, run: () => Promise<T>): Promise<T>');
const transpiled = ts.transpileModule(extraction, {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.deepEqual(transpiled.diagnostics, []);

function encode(value) {
  if (value === undefined) return {$undefined:true};
  if (value instanceof Error) return {$error:{name:value.name,message:value.message}};
  if (typeof value === 'number') {
    const b = Buffer.alloc(8); b.writeDoubleBE(value); return {$f64:b.toString('hex')};
  }
  if (typeof value === 'string') return {$utf16:Array.from({length:value.length},(_,i)=>value.charCodeAt(i))};
  if (Array.isArray(value)) return {$array:value.map(encode)};
  if (value && typeof value === 'object') return {$object:Object.keys(value).map(k=>[encode(k),encode(value[k])])};
  return value;
}
const owners = new Set();
const cases = [];
async function scenario(id, config) {
  let time = 0, timerId = 0, owner, result, error, settled = false, rejected = false;
  let complete, rejectRun;
  const calls = [], timers = [], scheduled = new Map(), held = new Map();
  const state = {set:0,renew:0};
  const mark = (method, args) => calls.push({at:time,method,args:encode(args)});
  const schedule = (callback, delay, period) => {
    const timer = {id:++timerId,unref(){timers.push({at:time,kind:'unref',id:this.id});}};
    scheduled.set(timer.id, {timer,callback,due:time+delay,period});
    timers.push({at:time,kind:period?'interval':'timeout',id:timer.id,ms:delay});
    return timer;
  };
  const clear = timer => {timers.push({at:time,kind:'clear',id:timer.id});scheduled.delete(timer.id);};
  const reply = (kind, spec, fallback) => {
    if (!spec) return Promise.resolve(fallback);
    if (spec.error) return Promise.reject(spec.nonError ? spec.value : new Error(spec.error));
    if (spec.hold) return new Promise((resolve,reject)=>held.set(kind,{resolve,reject}));
    return Promise.resolve(spec.value);
  };
  const cache = {
    set: async (key, actualOwner, options) => {
      assert.match(actualOwner,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (owner === undefined) {owner=actualOwner;assert(!owners.has(owner),'UUID reused');owners.add(owner);}
      assert.equal(actualOwner,owner,'one UUID per acquisition loop');
      mark('set',[key,'$owner',options]);
      return reply('set',config.set?.[state.set++], 'OK');
    },
    eval: async (lua, options) => {
      assert.equal(options.arguments[0],owner);
      const kind = lua.includes("'EXPIRE'") ? 'renew' : 'release';
      mark(kind,[lua,{keys:options.keys,arguments:['$owner']}]);
      return reply(kind,kind==='renew'?config.renew?.[state.renew++]:config.release,1);
    }
  };
  class Clock extends Date {static now(){return time;}}
  const context = vm.createContext({module:{exports:{}},Error,Date:Clock,
    createHash:crypto.createHash,randomUUID:crypto.randomUUID,
    getDragonflyClient:async caller => {
      mark('acquire',[caller]);
      if (config.acquireError) throw new Error('fixture acquisition failure');
      return cache;
    },
    setTimeout:(callback,ms)=>schedule(callback,ms,0),
    setInterval:(callback,ms)=>schedule(callback,ms,ms),
    clearInterval:clear
  });
  context.exports = context.module.exports;
  vm.runInContext(transpiled.outputText,context,{filename:'actual-ai-usage-lock.cjs'});
  const value = config.value;
  const run = () => {
    mark('run',[]);
    if (config.syncError) throw config.nonError ? config.errorValue : new Error('fixture callback failure');
    if (config.pending) return new Promise((resolve,reject)=>{complete=resolve;rejectRun=reject;});
    if (config.callbackError) return Promise.reject(config.nonError ? config.errorValue : new Error('fixture callback failure'));
    return Promise.resolve(value);
  };
  context.module.exports.withAiUsageLock(config.channel,config.customer,run).then(
    v=>{result=v;settled=true;},e=>{error=e;rejected=true;settled=true;}
  );
  const pump = async () => {for(let i=0;i<24;i++) await Promise.resolve();};
  const advance = async delta => {
    const end=time+delta;
    let steps=0;
    while (true) {
      const next=[...scheduled.values()].filter(t=>t.due<=end).sort((a,b)=>a.due-b.due||a.timer.id-b.timer.id)[0];
      if (!next) break;
      assert(++steps<10000,'timer runaway');
      time=next.due;
      if (next.period) next.due+=next.period; else scheduled.delete(next.timer.id);
      next.callback();
      await pump();
    }
    time=end;await pump();
  };
  await pump();
  for (const phase of config.phases || []) {
    if (phase.advance !== undefined) await advance(phase.advance);
    if (phase.complete) {assert(complete);complete(value);await pump();}
    if (phase.reject) {assert(rejectRun);rejectRun(config.nonError?config.errorValue:new Error('fixture callback failure'));await pump();}
    if (phase.resolve) {assert(held.has(phase.resolve));held.get(phase.resolve).resolve(phase.value);held.delete(phase.resolve);await pump();}
    if (phase.rejectHeld) {assert(held.has(phase.rejectHeld));held.get(phase.rejectHeld).reject(new Error(phase.error));held.delete(phase.rejectHeld);await pump();}
    if (phase.settled !== undefined) assert.equal(settled,phase.settled,id);
  }
  assert(settled,`${id}: fixture must settle source result`);
  assert.equal(scheduled.size,0,`${id}: every interval/timeout cleared`);
  const expected = {status:rejected?'rejected':'fulfilled',result:encode(result),error:encode(error),identity:rejected?null:Object.is(result,value),calls,timers};
  cases.push({id,kind:config.kind||'protocol',input:encode(config),expected});
  // Resolve held source promises after recording completion. Their .then/.catch
  // handlers are already installed by the actual source; no detached timer lives.
  for (const pending of held.values()) pending.resolve(1);
  await pump();
}
async function generate() {
  const strings=['','a','a|b','a:b',' ["a","b"] ','"\\\b\t\n\f\r\0\x01\x1f','é','e\u0301','😀','\u2028\u2029','\ud800','\udc00','\ud800\ud800','\udc00\ud800','\ud800x\udc00'];
  for (const channel of strings) for (const customer of strings)
    await scenario(`key-${cases.length}`,{kind:'key',channel,customer,value:'value'});
  const values=[undefined,null,true,false,0,-0,Number.MIN_VALUE,Number.MAX_VALUE,NaN,Infinity,-Infinity,'','😀\ud800',
    [],[1,null,'\udc00'],{nested:{value:'😀\ud800'},extra:true}];
  for (const value of values) await scenario(`return-${cases.length}`,{kind:'return',channel:'r',customer:'c',value});
  for (const errorValue of [undefined,null,'plain throw','\ud800',42,{code:'custom'}]) for (const syncError of [false,true])
    await scenario(`callback-${cases.length}`,{kind:'callback',channel:'r',customer:'c',callbackError:!syncError,syncError,nonError:true,errorValue});
  await scenario('callback-error',{channel:'r',customer:'c',callbackError:true});
  await scenario('acquire-error',{channel:'r',customer:'c',acquireError:true});
  await scenario('set-error',{channel:'r',customer:'c',set:[{error:'fixture SET failure'}]});
  await scenario('contended',{kind:'contention',channel:'r',customer:'c',value:5,set:[{value:null},{value:'ok'},{value:'OK'}],phases:[{advance:100}]});
  await scenario('busy-deadline',{kind:'deadline',channel:'r',customer:'c',set:Array.from({length:201},()=>({value:null})),phases:[{advance:10000}]});
  for (const acquired of [true,false]) await scenario(`held-set-${acquired}`,{kind:'held-set',channel:'r',customer:'c',value:5,set:[{hold:true}],
    phases:[{advance:10001,settled:false},{resolve:'set',value:acquired?'OK':null}]});
  for (const release of [{value:0},{value:null},{value:'ignored'},{error:'fixture release failure'}])
    for (const callbackError of [false,true]) await scenario(`release-${cases.length}`,{kind:'release',channel:'r',customer:'c',value:7,release,callbackError});
  const replies=[1,'1',' 1 ','\ufeff0x1',true,[1],[[1]],0,2,null,'',[],[1,1],'bad',NaN,Infinity];
  for (const value of replies) await scenario(`renew-${cases.length}`,{kind:'renew',channel:'r',customer:'c',value:7,pending:true,
    renew:[{value}],phases:[{advance:30000},{complete:true}]});
  for (const callbackError of [false,true]) for (const releaseError of [false,true])
    await scenario(`renew-error-${cases.length}`,{kind:'renew-error',channel:'r',customer:'c',pending:true,value:7,
      renew:[{error:'fixture renewal failure'}],release:releaseError?{error:'fixture release failure'}:undefined,
      phases:[{advance:30000},callbackError?{reject:true}:{complete:true}]});
  await scenario('sticky-lost',{kind:'sticky',channel:'r',customer:'c',value:7,pending:true,renew:[{value:0},{value:1}],
    phases:[{advance:60000},{complete:true}]});
  await scenario('pending-renewal-at-completion',{kind:'held-renew',channel:'r',customer:'c',value:7,pending:true,renew:[{hold:true}],
    phases:[{advance:30000,settled:false},{complete:true,settled:true}]});
  await scenario('held-release-precedence',{kind:'held-release',channel:'r',customer:'c',callbackError:true,release:{hold:true},
    phases:[{advance:30000,settled:false},{rejectHeld:'release',error:'fixture release failure',settled:true}]});
  const counts={};for(const row of cases)counts[row.kind]=(counts[row.kind]||0)+1;
  assert.equal(counts.key,225);assert(cases.length>290);
  return {metadata:{schema:1,node:process.version,v8:process.versions.v8,typescript:ts.version,hashes,pins,nativeHashes,
    extractionSha256:sha(extraction),typecheckSha256:sha(typecheckSource),compiledSha256:sha(transpiled.outputText),
    exports:[{name:declaration.name.text,signature,text:extraction,sha256:sha(extraction),
      parameters:declaration.parameters.map(p=>({name:p.name.getText(ast),type:p.type.getText(ast)})),
      typeParameters:declaration.typeParameters.map(p=>p.getText(ast)),returnType:declaration.type.getText(ast),async:true,
      startByte:Buffer.byteLength(source.slice(0,declaration.getStart(ast))),endByte:Buffer.byteLength(source.slice(0,declaration.getEnd()))}],
    imports,typeDiagnostics:[],counts,total:cases.length,uuid:'real node:crypto.randomUUID; recorded owners normalized after v4/uniqueness checks',
    dependencyProvenance:[{source:'node:crypto',native:'sha2::Sha256 + uuid::Uuid::new_v4',kind:'native replacement'},
      {source:'getDragonflyClient',native:'utils::redis::get_redis_client',kind:'existing native adapter; TS telemetry/logging excluded'},
      {source:'JSON.stringify([string,string])',native:'JsString::write_json_string',kind:'existing lossless UTF-16 encoder'},
      {source:'Number(renewalReply)',native:'json_number::to_number',kind:'existing ECMAScript Number core'},
      {source:'run: () => Promise<T>',native:'FnOnce() -> Future<Output=Result<T,E>>',kind:'caller-supplied behavior, not a service dependency'}]},cases};
}
(async()=>{
  const [mode,dir,...extra]=process.argv.slice(2);
  assert(['--write','--check'].includes(mode)&&dir&&extra.length===0,'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(),'parent creates the owned oracle output directory');
  const result=await generate();
  const files=[['ai_usage_lock_reference.json',JSON.stringify(result,null,2)+'\n'],
    ['ai_usage_lock_extracted.ts',extraction],['ai_usage_lock_typecheck.ts',typecheckSource],['ai_usage_lock_compiled.cjs',transpiled.outputText]];
  for(const [name,body] of files) {
    const output=path.join(fs.realpathSync(dir),name);
    if(mode==='--write'){assert(!fs.existsSync(output),`refuse overwrite ${name}`);fs.writeFileSync(output,body,{flag:'wx'});}
    else {const actual=fs.readFileSync(output,'utf8');assert(actual.length>0,`empty ${name}`);assert.equal(actual,body,`source/oracle drift ${name}`);}
  }
  process.stdout.write(`${mode} ${result.cases.length} source cases\n`);
})().catch(error=>{console.error(error);process.exitCode=1;});
