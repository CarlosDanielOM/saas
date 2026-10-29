'use strict';
// Run only in an isolated, capped parent-owned environment with TZ=UTC at startup.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {load, sha, root} = require('./ai_usage_receipt_parser_source.cjs');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
assert.equal(process.env.TZ, 'UTC');
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && !extra.length, 'usage: --write NEWDIR | --check DIR');
const base = {channelID:'channel',customerId:'customer',id:'entry',occurredAt:'2026-10-29T12:34:56.789Z',credits:1.25};
const raw = p => JSON.stringify({...base,...p});
const pools = [
  ['ascii', Array.from({length:32},(_,i)=>raw({id:`entry-${i}`,credits:i/4,operation:i%2?'usage':'chat',category:i%3?'tts':'memory'})), 32000],
  ['unicode', Array.from({length:32},(_,i)=>raw({id:`用户😀${i}`,model:i%2?'\ud800':'\udc00',source:'  café雪  ',resourceId:'a'.repeat(127)+'😀'})), 16000],
  ['coercion-duplicates', Array.from({length:32},(_,i)=>raw({id:[null,`id${i}`],credits:i%2?'0x10':[-1],quantity:[['2']],entryKind:'adjustment',source:['activation']}).replace('"channelID":"channel"','"channelID":"old","channelID":"channel"')), 16000],
  ['rejected', Array.from({length:32},(_,i)=>[null,'{','[]','{"credits":NaN}',raw({id:''}),raw({occurredAt:'bad'}),raw({credits:'NaN'}),raw({id:{toString:null}})][i%8] ?? 'null'), 16000],
  ['deep-ignored', Array.from({length:32},(_,i)=>raw({id:`deep-${i}`,ignored:null}).replace('"ignored":null','"ignored":'+'['.repeat(i%2?129:256)+'"x"'+']'.repeat(i%2?129:256))), 2048],
  ['deep-coerced', Array.from({length:32},(_,i)=>raw({id:null,credits:1}).replace('"id":null','"id":'+'['.repeat(i%2?129:256)+JSON.stringify(`id${i}`)+']'.repeat(i%2?129:256))), 2048],
];
const nativeFiles = [
  'Cargo.toml','Cargo.lock','rust-toolchain.toml','src/lib.rs','src/utils/mod.rs',
  'src/utils/ai_usage_receipt_parser.rs','src/utils/ai_usage.rs','src/utils/bson_compat.rs',
  'src/utils/credit_policy.rs','src/utils/js_compat.rs','src/utils/js_string.rs',
  'src/utils/json_number.rs','src/utils/lossless_json.rs','src/utils/lossless_json_view.rs',
  'src/utils/js_date/mod.rs','src/utils/js_date/parser.rs','src/utils/js_date/local_time.rs',
  'src/utils/tts/mod.rs','src/utils/tts/settings.rs','src/utils/tts/usage.rs','src/utils/tts/tag_types.rs','src/utils/tts_defaults.rs',
  'tests/ai_usage_receipt_parser_benchmark.rs',
];
const pinnedFiles = [['node',process.execPath], ['typescript',require.resolve('typescript')], ['typescriptPackage',require.resolve('typescript/package.json')]].map(([name,file])=>({name,file,sha256:sha(fs.readFileSync(file))}));
const scope = 'prepared input parse, ordered JSON wire encoding, wrapping UTF-8 byte checksum';
const fast = load(false), isolated = load(true);
assert.deepEqual(fast.provenance, isolated.provenance);
const fixture = {version:1, runtime:{node:process.version,v8:process.versions.v8,typescript:ts.version,tz:process.env.TZ}, provenance:fast.provenance,
  harness:['tests/fixtures/ai_usage_receipt_parser_source.cjs','tests/fixtures/ai_usage_receipt_parser_benchmark.cjs','package-lock.json'].map(file=>({file,sha256:sha(fs.readFileSync(path.join(root,file)))})),
  nativeFiles:nativeFiles.map(file=>({file,sha256:sha(fs.readFileSync(path.join(root,file)))})), pinnedFiles, scope,
  pools:pools.map(([name, inputs, operations])=>({name,operations,warmupOperations:name.startsWith('deep-')?2048:32000,records:inputs.map(input=>{ const wire=JSON.stringify(fast.parse(input)); assert.equal(wire,JSON.stringify(isolated.parse(input)), `realm mismatch ${name}`); return {input,wire}; })}))};
for (const p of fixture.pools) { assert.equal(p.records.length,32); assert.equal(p.warmupOperations,p.name.startsWith('deep-')?2048:32000); assert.equal(p.warmupOperations%32,0); }
const encoded = JSON.stringify(fixture)+'\n';
function checksum(records, operations, parse) {
  let sum=0;
  for (let i=0;i<operations;i++) {
    const wire=JSON.stringify(parse(records[i%records.length].input));
    for (const byte of Buffer.from(wire,'utf8')) sum=(sum+byte)>>>0;
  }
  return sum;
}
function expectedChecksum(records, operations) {
  let sum=0;
  for (let i=0;i<operations;i++) for (const byte of Buffer.from(records[i%records.length].wire,'utf8')) sum=(sum+byte)>>>0;
  return sum;
}
function reportValid(report, language) {
  assert.equal(report.language,language); assert.equal(report.scope,scope); assert.equal(report.sampleUnit,'nanoseconds per full trial');
  if (language==='node') assert.deepEqual(report.runtime,fixture.runtime);
  else { assert.equal(report.runtime.toolchain, '1.99.1'); assert(report.runtime.rustc.startsWith('rustc 1.99.1 ')); assert.equal(report.runtime.profile,'release'); assert(report.runtime.arch && report.runtime.os); }

  assert.equal(report.version,1); assert.equal(report.fixtureSha256,sha(encoded)); assert.equal(report.pools.length,fixture.pools.length);
  for (let i=0;i<fixture.pools.length;i++) {
    const p=fixture.pools[i], r=report.pools[i]; assert.equal(r.name,p.name); assert.equal(r.operations,p.operations); assert.equal(r.warmupOperations,p.warmupOperations); assert.equal(r.trials.length,7); assert.equal(p.records.length,32); assert.equal(p.warmupOperations%32,0); assert.equal(p.warmupOperations, p.name.startsWith('deep-') ? 2048 : 32000);
    const expected=expectedChecksum(p.records,p.operations);
    for (const trial of r.trials) { assert.equal(trial.checksum,expected); assert(Number.isFinite(trial.ns) && trial.ns>0); }
    const sorted=r.trials.map(t=>t.ns).sort((a,b)=>a-b); assert.deepEqual([r.min,r.median,r.max],[sorted[0],sorted[3],sorted[6]]);
  }
}
if (mode==='--write') {
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'inputs.json'),encoded,{flag:'wx'});
  const report={version:1,language:'node',runtime:fixture.runtime,scope,sampleUnit:'nanoseconds per full trial',fixtureSha256:sha(encoded),pools:fixture.pools.map(p=>{
    assert.equal(checksum(p.records,p.warmupOperations,fast.parse),expectedChecksum(p.records,p.warmupOperations));
    const trials=Array.from({length:7},()=>{const start=process.hrtime.bigint(); const value=checksum(p.records,p.operations,fast.parse); return {ns:Number(process.hrtime.bigint()-start),checksum:value};});
    const sorted=trials.map(t=>t.ns).sort((a,b)=>a-b); return {name:p.name,operations:p.operations,warmupOperations:p.warmupOperations,trials,min:sorted[0],median:sorted[3],max:sorted[6]};
  })};
  reportValid(report,'node'); fs.writeFileSync(path.join(dir,'node-report.json'),JSON.stringify(report)+'\n',{flag:'wx'});
} else {
  assert.equal(fs.readFileSync(path.join(dir,'inputs.json'),'utf8'),encoded,'stale inputs/provenance');
  for (const [file,language] of [['node-report.json','node'],['native-report.json','rust']]) reportValid(JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')),language);
}
