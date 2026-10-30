'use strict';
// Offline source oracle: actual captured billing declarations; I/O boundaries are
// scripted replies, not an emulation of the fence Lua or Mongo/Polar services.
// Print a deterministic JSON corpus; run twice and compare byte-for-byte.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const sourcePath = path.resolve(root, '../migration-notes/evidence/2026-10-29-billing-recovery-source/external-source-api-ee0635765a02/dimabot/src/utils/billing.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const fencePath = path.resolve(root, '../migration-notes/evidence/2026-10-30-ai-credit-reader-source/external-source-55bd0bb/dimabot/src/utils/plan_cache_fence.ts');
const fenceSource = fs.readFileSync(fencePath, 'utf8');
const sha = input => crypto.createHash('sha256').update(input).digest('hex');
assert.equal(sha(source), '2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f');
assert.equal(sha(fenceSource), '2639f0021342fba252e7c9ef331dc42cdb9cc4eb19b5e063eda7d167ac7787ee');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const names = ['AI_CREDITS_METER_ID', 'AI_CREDIT_LIMITS', 'AI_CREDITS_CACHE_TTL_SECONDS', 'AI_CREDITS_CACHE_SCHEMA_VERSION', 'toFiniteNumber', 'getAiCreditLimitForPlan', 'buildAiCreditsDataFromMeter', 'aiCreditReadDependencies', 'unavailableAiCredits', 'getAiCredits'];
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.equal(ast.parseDiagnostics.length, 0);
const declarations = new Map();
for (const stmt of ast.statements) {
  const found = ts.isVariableStatement(stmt) ? stmt.declarationList.declarations.map(d => d.name.getText(ast)) : stmt.name ? [stmt.name.text] : [];
  for (const n of found.filter(n => names.includes(n))) { assert(!declarations.has(n)); declarations.set(n, stmt); }
}
assert.equal(declarations.size, names.length);
const extraction = names.map(n => declarations.get(n).getText(ast)).join('\n');
const compiled = ts.transpileModule(extraction, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}, reportDiagnostics:true});
assert.equal(compiled.diagnostics.length, 0);
const now = 1767323045000;
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const fenceCompiled = ts.transpileModule(fenceSource, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal(fenceCompiled.diagnostics.length,0);
const fenceContext = {exports:{}};
vm.runInNewContext(fenceCompiled.outputText, fenceContext, {filename:'captured-plan-cache-fence.js',timeout:1000});
const context = {exports:{}, Date:FixedDate, console:{error(){}},
  getDragonflyClient: () => { throw Error('injected cache required'); },
  polarRequest: () => { throw Error('injected state required'); },
  ...fenceContext.exports};
vm.runInNewContext(compiled.outputText, context, {filename:'captured-billing.js',timeout:1000});
const get = context.exports.getAiCredits;
const meter = {meter_id:'5103e79b-fd74-4ba8-a287-f95574f9addf',consumed_units:42};
const cases = [
 {name:'cache-equal',cache:JSON.stringify({version:3,used:2,limit:25000,balance:0,available:true,status:'exhausted',__polar_plan_version:'v'}),eval:[1]},
 {name:'cache-unavailable-verified',cache:JSON.stringify({version:3,used:2,limit:25000,available:false,status:'unavailable'}),eval:[1],verified:true},
 {name:'cache-old-fence-missing-owner',cache:JSON.stringify({version:3,used:2,limit:25000,available:true}),eval:[0],fence:'2',current:null},
 {name:'new-meter',state:{active_meters:[meter]},eval:[1],verified:true},
 {name:'missing-meter-verified',state:{active_meters:[]},eval:[1],verified:true},
 {name:'free-limit',tier:'free',state:{active_meters:[meter]},eval:[1]},
 {name:'no-customer',customer:'',tier:'pro'},
 {name:'fenced-stale',fence:'9999999999999:latest',current:{plan_tier:'premium',polar_sh_customer_id:'customer',polar_plan_event_at:new Date(1),polar_plan_event_key:'old'}},
 {name:'fenced-utf16-order',fence:'0000000000001:\ue000',current:{plan_tier:'pro',polar_sh_customer_id:'customer',polar_plan_event_at:new Date(1),polar_plan_event_key:'😀'}},
 {name:'provider-failure',failure:true},
 {name:'provider-failure-canonical',failure:true,canonical:1},
 {name:'provider-failure-legacy',failure:true,legacy:1},
 {name:'provider-failure-fenced',fence:'0000000000001:current',current:{plan_tier:'free',polar_sh_customer_id:'customer',polar_plan_event_at:new Date(1),polar_plan_event_key:'current'},failure:true},
];
async function run(input) {
  const calls=[]; let evalIndex=0;
  const cache={get:async key=>{calls.push(['get',key]); return key.endsWith(':plan-version') ? input.fence || null : input.cache || null;},
    exists:async key=>{calls.push(['exists',key]); return key.startsWith('twitch:') ? input.canonical || 0 : input.legacy || 0;},
    eval:async (script,options)=>{calls.push(['eval',script,options]); return (input.eval || [])[evalIndex++] ?? 1;}};
  const deps={getCache:async label=>{calls.push(['acquire',label]);return cache;},
    getCurrentPlan:async (...args)=>{calls.push(['mongo',...args]);return input.current || null;},
    getState:async (...args)=>{calls.push(['state',...args]);if(input.failure) throw Error('fixture failure');return input.state || {};}};
  const result=await get({plan_tier:input.tier || 'premium',polar_sh_customer_id:input.customer ?? 'customer'}, 'fixture', {requireVerified:!!input.verified}, deps);
  return JSON.parse(JSON.stringify({name:input.name,input,result,wire:JSON.stringify(result),calls}));
}
(async()=>{
 const records=[]; for(const input of cases) { const a=await run(input),b=await run(input); assert.deepEqual(a,b); records.push(a); }
 const hashes={source:sha(source),fenceSource:sha(fenceSource),fenceCompiled:sha(fenceCompiled.outputText), package:sha(fs.readFileSync(path.join(root,'package.json'))), lock:sha(fs.readFileSync(path.join(root,'package-lock.json'))), typescript:sha(fs.readFileSync(require.resolve('typescript'))), typescriptPackage:sha(fs.readFileSync(require.resolve('typescript/package.json'))), node:sha(fs.readFileSync(process.execPath)), oracle:sha(fs.readFileSync(__filename)), extracted:sha(extraction), compiled:sha(compiled.outputText)};
 assert.equal(hashes.node,'569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
 assert.equal(hashes.package,'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef');
 assert.equal(hashes.lock,'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7');
 assert.equal(hashes.typescript,'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
 assert.equal(hashes.typescriptPackage,'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6');
 process.stdout.write(JSON.stringify({node:process.version,v8:process.versions.v8,typescript:ts.version,hashes,records})+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
