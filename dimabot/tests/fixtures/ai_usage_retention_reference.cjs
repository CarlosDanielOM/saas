'use strict';
// Offline oracle: execute the selected real TS declarations and real schemas;
// substitute only the Mongo collection methods, after Mongoose middleware.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const vm = require('node:vm'), assert = require('node:assert/strict');
const ts = require('typescript');
const [mode, dir, ...rest] = process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && !rest.length);
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const output = fs.realpathSync(dir);
assert(fs.statSync(output).isDirectory());
const repo = fs.realpathSync(path.join(root,'..'));
assert(output !== repo && !output.startsWith(repo + path.sep));
if (mode === '--write') assert.deepEqual(fs.readdirSync(output), [], 'write directory must be empty');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = f => fs.readFileSync(path.join(root,f),'utf8');
const pins = {
  'src/utils/ai_usage_ledger.ts':'3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5',
  'src/schemas/ai_usage_dashboard.schema.ts':'0a284872d00400c766cb61995353dec43214d8564c31abb6e0c9e83e716f36c6',
  'src/schemas/ai_usage_ledger_state.schema.ts':'ede6fc369c432d97bee0db835871c0773c1000023ac2c34ff044510c5c60121c',
  'src/schemas/ai_usage_receipt.schema.ts':'87f132f55c47cf082f37dabadc0d42f790e8324d1925f6990a3794f46d845b92',
  'src/schemas/ai_usage_daily.schema.ts':'80b5debff08e77578275a5267df1a1499138441d1bb5d55875f1eb2092318585',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
  'node_modules/bson/package.json':'ded0e42e4e1cd876a11c9f799e0692f83ee73ebc9fb7796a5bca05039b4b3e23',
  'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  'Cargo.lock':'787333fa269752a606040d7393767040ef749ce1e01c2512386bf305bcd7a2c3'
};
for (const [file, hash] of Object.entries(pins)) assert.equal(sha(read(file)), hash, file);
assert.equal(JSON.parse(read('node_modules/bson/package.json')).version,'6.10.4');
const forbidden = () => { throw Error('network forbidden'); };
require('node:net').Socket.prototype.connect = forbidden;
for (const k of ['connect','createConnection']) require('node:net')[k] = forbidden;
require('node:tls').connect = forbidden;
for (const n of ['node:http','node:https']) for (const k of ['request','get']) require(n)[k] = forbidden;
for (const n of ['node:dns','node:dns/promises']) for (const k of Object.keys(require(n))) if (/^(lookup|resolve|reverse)/.test(k)) require(n)[k] = forbidden;
globalThis.fetch = forbidden;
const pkg = require('mongoose'); assert.equal(pkg.version,'8.24.2');
const mongoose = new pkg.Mongoose();
mongoose.set('autoCreate', false); mongoose.set('autoIndex', false); mongoose.set('bufferCommands', false);
for (const owner of [pkg,mongoose]) { owner.connect = forbidden; owner.createConnection = forbidden; owner.Connection.prototype.openUri = forbidden; }
mongoose.mongo.MongoClient.prototype.connect = forbidden;
mongoose.mongo.MongoClient.connect = forbidden;
const BSON = mongoose.mongo.BSON;
const schemaNames = ['dashboard','ledger_state','receipt','daily'];
const files = schemaNames.map(n=>`src/schemas/ai_usage_${n}.schema.ts`);
const models = files.map(file => {
  const source=read(file), mod={exports:{}};
  const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(out,{module:mod,exports:mod.exports,require:n=>{assert.equal(n,'mongoose');return {Schema:mongoose.Schema,model:mongoose.model.bind(mongoose)}},Date},{filename:file});
  return mod.exports.default;
});
const file='src/utils/ai_usage_ledger.ts', source=read(file), ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
assert.deepEqual(ast.parseDiagnostics,[]);
const names=['RETENTION_DAYS','validTier','getAiUsageRetentionDays','adjustAiUsageRetention'];
const declarations=names.map(name=>{
  const nodes=ast.statements.filter(n=>n.name?.text===name || ts.isVariableStatement(n) && n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
  assert.equal(nodes.length,1); const n=nodes[0], text=n.getText(ast);
  return {name,text,sha256:sha(text),start:n.getStart(ast),end:n.end,
    parameters:ts.isFunctionDeclaration(n)?n.parameters.map(p=>({name:p.name.getText(ast),type:p.type?.getText(ast)})):[],
    returnType:n.type?.getText(ast)??null};
});
const imports=ast.statements.filter(ts.isImportDeclaration).map(n=>({text:n.getText(ast),module:n.moduleSpecifier.text,typeOnly:!!n.importClause?.isTypeOnly}));
const receiptSource=read('src/schemas/ai_usage_receipt.schema.ts');
const receiptAst=ts.createSourceFile(files[2],receiptSource,ts.ScriptTarget.ES2022,true);
assert.deepEqual(receiptAst.parseDiagnostics,[]);
const typeNodes=receiptAst.statements.filter(n=>ts.isTypeAliasDeclaration(n) && n.name.text==='AiUsageRetentionTier');
assert.equal(typeNodes.length,1);
const sourceType=typeNodes[0].getText(receiptAst);
const schemaImports=Object.fromEntries(files.map(f=>{const t=ts.createSourceFile(f,read(f),ts.ScriptTarget.ES2022,true);return [f,t.statements.filter(ts.isImportDeclaration).map(n=>n.getText(t))]}));
const extracted=declarations.map(x=>x.text).join('\n');
const types=sourceType+`\ndeclare const Dashboards: { deleteMany(x: unknown): Promise<unknown> };\ndeclare const AiUsageLedgerStateSchema: { updateMany(x: unknown, y: unknown): Promise<unknown> };\ndeclare const AiUsageReceiptSchema: { updateMany(x: unknown, y: unknown): Promise<unknown>; deleteMany(x: unknown): Promise<unknown> };\ndeclare const AiUsageDailySchema: typeof AiUsageReceiptSchema;\n`;
const typecheck=types+extracted, virtual=path.join(root,'__ai_usage_retention_oracle__.ts');
const opts={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host=ts.createCompilerHost(opts), oldRead=host.readFile.bind(host), oldExists=host.fileExists.bind(host);
host.readFile=f=>f===virtual?typecheck:oldRead(f); host.fileExists=f=>f===virtual||oldExists(f);
const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram([virtual],opts,host)).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'));
assert.deepEqual(diagnostics,[]);
const compiled=ts.transpileModule(extracted,{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
assert.deepEqual(compiled.diagnostics,[]); const transpiled=compiled.outputText;
const mod={exports:{}};
let ticks=[], observations=[];
class FixtureDate extends Date { constructor(...args) { if(args.length) super(...args); else {const ms=ticks.shift(); assert.notEqual(ms,undefined,'clock exhausted'); observations.push(ms); super(ms);} } static now() { const ms=ticks.shift(); assert.notEqual(ms,undefined,'clock exhausted'); observations.push(ms); return ms; } }
// Mongoose cloning must observe the native constructor name.
Object.defineProperty(FixtureDate,'name',{value:'Date'});
assert.equal(FixtureDate.name,'Date');
vm.runInNewContext(transpiled,{module:mod,exports:mod.exports,Date:FixtureDate,Dashboards:models[0],AiUsageLedgerStateSchema:models[1],AiUsageReceiptSchema:models[2],AiUsageDailySchema:models[3]},{filename:file});
const wire = v => BSON.serialize({value:v}).toString('hex');
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r}); return {promise,resolve}; }
async function scenario(id,ids,tier,config={}) {
  const calls=[], events=[], middlewareClock=[]; observations=[]; ticks=[config.now??1700000000000];
  // Mongoose uses its own clock hook, distinct from source Date.
  let middleware=0; const middlewareTicks=config.middleware??[1700000000010,1700000000011,1700000000012];
  mongoose.now=()=>{ const ms=middlewareTicks[middleware++]; assert.notEqual(ms,undefined); middlewareClock.push(ms); return new Date(ms); };
  const gates=Array.from({length:6},deferred), entered=Array.from({length:6},deferred);
  for(let i=0;i<models.length;i++) for(const method of ['deleteMany','updateMany']) {
    models[i].collection[method]=async (...args)=>{
      const index=calls.length; calls.push({collection:models[i].collection.name,method,args:args.map(wire)}); events.push(`enter:${index}`); entered[index].resolve();
      if(config.gated) await gates[index].promise;
      events.push(`finish:${index}`);
      if(index===config.fail) throw Object.assign(new Error('fixture failure'),{code:12345});
      return {acknowledged:true,deletedCount:0,modifiedCount:0};
    };
  }
  let error=null;
  let settled=false;
  const pending=mod.exports.adjustAiUsageRetention(ids,tier).catch(e=>{ error={name:e.name,message:e.message,code:e.code??null,path:e.path??null}; }).then(()=>{settled=true;events.push('settled');});
  if(config.gated) {
    for(let i=0;i<4;i++) {
      await entered[i].promise; assert.equal(calls.length,i+1); gates[i].resolve();
      if(config.fail===i) break;
    }
    if(config.fail===undefined || config.fail>=4) {
      await Promise.all([entered[4].promise,entered[5].promise]);
      assert.equal(settled,false); events.push('both-entered');
      if(config.fail===4 || config.fail===5) {
        gates[config.fail].resolve(); await pending;
        assert.equal(settled,true); events.push('sibling-still-blocked');
        gates[config.fail===4?5:4].resolve();
      } else { gates[4].resolve(); gates[5].resolve(); }
    }
  }
  await pending;
  await new Promise(resolve=>setImmediate(resolve));
  return {id,ids:ids.map(s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i))),tier:wire(tier),calls,clock:observations,middlewareClock,events,error};
}
(async()=>{
  const cases=[];
  for(const tier of ['free','premium','pro','Premium',' premium ','\ud800',null,true,false,0,1,-1,NaN,Infinity,{},[],['pro'],{tier:'pro'}]) cases.push(await scenario(`tier-${cases.length}`,['a','a','\ud800','a\0b','😀','\udc00'],tier));
  cases.push(await scenario('empty',[],'pro'));
  for(let i=0;i<6;i++) cases.push(await scenario(`failure-${i}`,['channel'],'premium',{fail:i,gated:true}));
  cases.push(await scenario('concurrent-success',['channel'],'pro',{gated:true}));
  for(const now of [-8640000000000001,-8640000000000000,-8639997408000000,8640000000000000,8640000000000001])
    cases.push(await scenario(`now-${now}`,['channel'],'free',{now}));
  for(const [id,middleware] of [['invalid-state',[8640000000000001]],['invalid-receipt',[0,8640000000000001,0]],['invalid-daily',[0,0,8640000000000001]]])
    cases.push(await scenario(id,['channel'],'free',{middleware}));
  const pinFiles=[file,...files,'src/schemas/schema.rs','src/schemas/ai_usage_dashboard.schema.rs','src/schemas/ai_usage_ledger_state.schema.rs','src/schemas/ai_usage_receipt.schema.rs','src/schemas/ai_usage_daily.schema.rs','src/utils/ai_usage_receipt_parser.rs','src/utils/ai_usage_producer.rs','src/utils/ai_usage_retention.rs','tests/ai_usage_retention.rs','tests/fixtures/ai_usage_retention_reference.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
  const hashes=Object.fromEntries(pinFiles.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))]));
  const dependencies=Object.fromEntries(Object.keys(require.cache).filter(f=>f.includes('/node_modules/')).sort().map(f=>[path.relative(root,f),sha(fs.readFileSync(f))]));
  const result={node:process.version,v8:process.versions.v8,nodePath:process.execPath,nodeHash:sha(fs.readFileSync(process.execPath)),typescript:ts.version,mongoose:mongoose.version,bson:'6.10.4',pins,hashes,dependencies,imports,schemaImports,sourceType,sourceTypeHash:sha(sourceType),declarations,extracted,typecheck,compiled:transpiled,extractedHash:sha(extracted),typecheckHash:sha(typecheck),compiledHash:sha(transpiled),diagnostics,cases};
  const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');
  const target=path.join(output,'ai_usage_retention_reference.json');
  if(mode==='--write') fs.writeFileSync(target,bytes,{flag:'wx'}); else assert.deepEqual(fs.readFileSync(target),bytes);
})().catch(e=>{console.error(e);process.exitCode=1});
