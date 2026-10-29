// Prepared pricing and scalar checksum only; setup, validation and I/O excluded.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {load,fields}=require('./tts_usage_oracle.cjs');
const [mode,dir,...extra]=process.argv.slice(2); if(!['--write','--check'].includes(mode)||!dir||extra.length) throw Error('usage: --write DIR | --check DIR');
const {calculate,metadata}=load({commonJsRealm:true});
const {calculate:oracleCalculate}=load();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const measure='prepared pool pricing plus four scalar scaled fields, wrapping u32';
const iterations=262144, warmupPasses=100, samples=7;
function checksum(r) {
 const a=r.characters*100000, b=r.creditsConsumed*100000, c=r.polarshCost*100000, d=r.costUsd*100000;
 if (![a,b,c,d].every(n=>Number.isFinite(n)&&n>=0&&n<4294967296)) throw Error('checksum field out of range');
 return (((a>>>0)+(b>>>0)+(c>>>0)+(d>>>0))>>>0);
}
// Timed checksum uses the same scalar conversions; bounds are checked before timing.
function consumeField(r) { return ((r.characters*100000>>>0)+(r.creditsConsumed*100000>>>0)+(r.polarshCost*100000>>>0)+(r.costUsd*100000>>>0))>>>0; }
const definitions=[['piper',['piper']],['fish',['fish']],['kokoro',['kokoro']],['unknown',['other']],['inherited',['constructor','__proto__']],['mixed',['piper','fish','kokoro','other','constructor','__proto__']]];
const workloads=definitions.map(([name,providers])=>{
 const pool=Array.from({length:32},(_,i)=>{const provider=providers[i%providers.length], characters=17+i*13+(i%3); const r=calculate(provider,characters); return {provider,characters,fields:fields(r),wire:JSON.stringify(r),checksum:checksum(r)};});
 let total=0; for(let i=0;i<iterations;i++) total=(total+pool[i%pool.length].checksum)>>>0;
 return {name,iterations,pool,resultChecksum:total};
});
const fixture={schema:2,warmupPasses,samples,measurement:measure,metadata,benchmarkSha256:sha(fs.readFileSync(__filename)),workloads};
const generated=JSON.stringify(fixture,null,2)+'\n', input=path.join(dir,'tts-usage-benchmark-input.json'), node=path.join(dir,'tts-usage-node-benchmark.json'), rust=path.join(dir,'tts-usage-rust-benchmark.json');
function validate(report,implementation,hash) {
 if(report.implementation!==implementation||report.inputSha256!==hash||report.warmupPasses!==warmupPasses||report.measurement!==measure||report.runs?.length!==workloads.length) throw Error('report header mismatch');
 workloads.forEach((w,i)=>{const r=report.runs[i];
  if(r.name!==w.name||r.iterations!==w.iterations||r.resultChecksum!==w.resultChecksum||r.samples?.length!==samples) throw Error('report workload mismatch');
  for(const s of r.samples) if(!Number.isSafeInteger(s.elapsedNs)||s.elapsedNs<=0||s.checksum!==w.resultChecksum) throw Error('sample mismatch');
  if(r.medianUsPerOp!==r.samples.map(s=>s.elapsedNs).sort((a,b)=>a-b)[3]/w.iterations/1000) throw Error('median mismatch');
 });
}
if(mode==='--write') {
 if(!fs.statSync(dir).isDirectory()||[input,node,rust].some(fs.existsSync)) throw Error('existing parent-owned empty destination required');
 fs.writeFileSync(input,generated,{flag:'wx'}); const hash=sha(Buffer.from(generated));
 const runs=workloads.map(w=>{
  for(const item of w.pool) { const r=calculate(item.provider,item.characters), oracle=oracleCalculate(item.provider,item.characters); if(JSON.stringify(fields(r))!==JSON.stringify(item.fields)||JSON.stringify(r)!==item.wire||checksum(r)!==item.checksum||JSON.stringify(fields(oracle))!==JSON.stringify(item.fields)||JSON.stringify(oracle)!==item.wire) throw Error('output or execution realm mismatch'); }
  function consume(){let sum=0;for(let i=0;i<w.iterations;i++){const item=w.pool[i%w.pool.length];sum=(sum+consumeField(calculate(item.provider,item.characters)))>>>0;}return sum;}
  for(let i=0;i<warmupPasses;i++) if(consume()!==w.resultChecksum) throw Error('warmup mismatch');
  const results=[]; for(let i=0;i<samples;i++){const start=process.hrtime.bigint(), sum=consume(), elapsedNs=Number(process.hrtime.bigint()-start);results.push({elapsedNs,checksum:sum});}
  return {name:w.name,iterations:w.iterations,resultChecksum:w.resultChecksum,samples:results,medianUsPerOp:results.map(s=>s.elapsedNs).sort((a,b)=>a-b)[3]/w.iterations/1000};
 }); const report={implementation:'actual-typescript',inputSha256:hash,warmupPasses,measurement:measure,runs}; validate(report,'actual-typescript',hash); fs.writeFileSync(node,JSON.stringify(report,null,2)+'\n',{flag:'wx'}); console.log(hash);
} else { const bytes=fs.readFileSync(input); if(bytes.toString()!==generated) throw Error('fixture/provenance mismatch'); const hash=sha(bytes); for(const [file,impl] of [[node,'actual-typescript'],[rust,'native-rust']]) validate(JSON.parse(fs.readFileSync(file,'utf8')),impl,hash); console.log(hash); }
