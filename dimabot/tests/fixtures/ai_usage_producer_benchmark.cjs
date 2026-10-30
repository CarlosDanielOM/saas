'use strict';
const {sourcePath: fixturePath, resolveSource} = require('./ai_usage_source_resolver.cjs');
// Prepared builder + wire encoding benchmark. No application services are loaded.
// --write and --prepare require an empty task-owned directory; checks never measure time.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {loadSource}=require('./ai_usage_producer_source.cjs');
const [mode,dir,...rest]=process.argv.slice(2);
assert(['--write','--check','--prepare','--check-input'].includes(mode) && dir && !rest.length,'usage: --write DIR | --check DIR | --prepare DIR | --check-input DIR');
assert(fs.statSync(dir).isDirectory());
const vm=loadSource('vm'), normal=loadSource('commonjs');
const {root,sha}=normal;
const files=['src/utils/ai_usage_ledger.ts','src/utils/ai_usage_classification.ts','src/utils/ai_usage_event.ts','src/utils/ai_usage_receipts.ts','src/schemas/ai_usage_receipt.schema.ts','src/utils/ai_usage_producer.rs','src/utils/ai_usage.rs','src/utils/credit_policy.rs','src/utils/js_string.rs','src/utils/lossless_json.rs','src/utils/json_number.rs','src/utils/js_compat.rs','src/utils/ai_usage_receipts/values.rs','src/utils/ai_usage_receipts/queue.rs','src/utils/ai_usage_receipts.rs','tests/fixtures/ai_usage_source_resolver.cjs','tests/fixtures/ai_usage_producer_source.cjs','tests/fixtures/ai_usage_producer_reference.cjs','tests/fixtures/ai_usage_producer_benchmark.cjs','tests/ai_usage_producer_benchmark.rs','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,sha(fs.readFileSync(fixturePath(root,f)))]));
hashes.node=sha(fs.readFileSync(process.execPath));
hashes.typescript=sha(fs.readFileSync(require.resolve('typescript')));
hashes.typescriptPackage=sha(fs.readFileSync(require.resolve('typescript/package.json')));
const base={schemaVersion:1,pricingVersion:'legacy-polar-math-v1',entryId:'entry',requestId:'request',entryKind:'usage',category:'tts',operation:'synthesize',source:'tts_queue',provider:'fish',model:'model',quantity:1.25,unit:'characters',resourceType:'speech',resourceId:'resource'};
const definitions=[['typed-ascii','typed',262144],['typed-unicode','typed',262144],['lossless-nullish','lossless',262144],['lossless-surrogate','lossless',262144],['lossless-large','lossless',32768]];
const checksum=bytes=>{let n=0; for(const b of bytes) n=(n+b)>>>0; return n;};
const workloads=definitions.map(([name,kind,iterations])=>{
  const pool=Array.from({length:32},(_,i)=>{
    const c={...base,entryId:`entry-${i}`,requestId:`request-${i}`,quantity:i+0.25};
    if(name==='typed-unicode') { c.model=`模型😀-${i}`; c.resourceId=`café-${i}`; }
    if(name==='lossless-nullish') { c.model=null; c.resourceId=null; delete c.unit; if(i%2) delete c.requestId; }
    if(name==='lossless-surrogate') { c.model=`\ud800${i}\udc00`; c.resourceId=`a\udfff-${i}`; }
    if(name==='lossless-large') { c.model=`${'metadata-é😀'.repeat(128)}-${i}`; c.resourceId=`${'resource'.repeat(128)}-${i}`; }
    const input={channelID:`channel-${i}`,customerId:`customer-${i}`,occurredAtMs:1700000000000+i*1000,contextJson:JSON.stringify(c),credits:i/8+0.125};
    function prepared(loader) { return {channelID:input.channelID,customerId:input.customerId,occurredAt:new Date(input.occurredAtMs),context:JSON.parse(input.contextJson),credits:input.credits}; }
    const a=JSON.stringify(vm.producer.buildQueuedAiUsageReceipt(prepared(vm)));
    const b=JSON.stringify(normal.producer.buildQueuedAiUsageReceipt(prepared(normal)));
    assert.equal(a,b,`realm output ${name}:${i}`); assert.notEqual(a,'null');
    return {...input,wire:a,checksum:checksum(Buffer.from(a,'utf8'))};
  });
  return {name,kind,iterations,warmup:32000,pool};
});
const input={format:1,label:'prepared receipt builder + JSON + UTF-8 byte sum',node:process.version,v8:process.versions.v8,typescript:require('typescript').version,hashes,extractedSha256:sha(normal.extracted),workloads};
const inputBytes=JSON.stringify(input,null,2)+'\n', inputSha256=sha(inputBytes);
const inputPath=path.join(dir,'ai-usage-producer-benchmark-input.json');
const nodePath=path.join(dir,'ai-usage-producer-node-benchmark.json');
const rustPath=path.join(dir,'ai-usage-producer-rust-benchmark.json');
function expected(w) { let sum=0; for(let i=0;i<w.iterations;i++) sum=(sum+w.pool[i%32].checksum)>>>0; return sum; }
function validate(report,runtime) {
  assert.equal(report.format,1); assert.equal(report.label,input.label); assert.equal(report.runtime,runtime); assert.equal(report.inputSha256,inputSha256);
  assert.equal(report.workloads.length,workloads.length);
  report.workloads.forEach((r,i)=>{ const w=workloads[i]; assert.equal(r.name,w.name); assert.equal(r.iterations,w.iterations); assert.equal(r.warmup,w.warmup); assert.equal(r.checksum,expected(w)); assert.equal(r.samples.length,7); assert.deepEqual(r.sampleChecksums,Array(7).fill(expected(w))); for(const n of r.samples) assert(Number.isSafeInteger(n)&&n>0); const sorted=[...r.samples].sort((a,b)=>a-b); assert.equal(r.medianNs,sorted[3]); });
}
if(mode==='--write' || mode==='--prepare') {
  assert.equal(fs.readdirSync(dir).length,0,'directory must be empty');
  fs.writeFileSync(inputPath,inputBytes,{flag:'wx'});
}
if(mode==='--write') {
  const results=workloads.map(w=>{
    const pool=w.pool.map(p=>({channelID:p.channelID,customerId:p.customerId,occurredAt:new Date(p.occurredAtMs),context:JSON.parse(p.contextJson),credits:p.credits}));
    function run(count) { let sum=0; for(let i=0;i<count;i++) { const receipt=normal.producer.buildQueuedAiUsageReceipt(pool[i%32]); const bytes=Buffer.from(JSON.stringify(receipt),'utf8'); for(const b of bytes) sum=(sum+b)>>>0; } return sum; }
    run(w.warmup);
    const samples=[],sampleChecksums=[]; let sum;
    for(let t=0;t<7;t++) { const start=process.hrtime.bigint(); sum=run(w.iterations); const elapsed=Number(process.hrtime.bigint()-start); assert(Number.isSafeInteger(elapsed)&&elapsed>0); assert.equal(sum,expected(w)); samples.push(elapsed); sampleChecksums.push(sum); }
    return {name:w.name,iterations:w.iterations,warmup:w.warmup,checksum:sum,samples,sampleChecksums,medianNs:[...samples].sort((a,b)=>a-b)[3]};
  });
  const report={format:1,label:input.label,runtime:'node-commonjs',inputSha256,workloads:results}; validate(report,'node-commonjs');
  fs.writeFileSync(nodePath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
} else if(mode==='--check-input') {
  assert.deepEqual(fs.readdirSync(dir),[path.basename(inputPath)]);
  assert.equal(fs.readFileSync(inputPath,'utf8'),inputBytes,'inputs/provenance differ');
} else if(mode==='--check') {
  assert.equal(fs.readFileSync(inputPath,'utf8'),inputBytes,'inputs/provenance differ');
  validate(JSON.parse(fs.readFileSync(nodePath,'utf8')),'node-commonjs');
  validate(JSON.parse(fs.readFileSync(rustPath,'utf8')),'rust-release');
}
process.stdout.write(JSON.stringify({inputSha256,mode})+'\n');
