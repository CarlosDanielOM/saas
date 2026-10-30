'use strict';
// Two modes: prepare reference workloads; sample one category per fresh process.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {api,units,snapshot,sha,root}=require('./moderation_blacklist_reference.cjs');
const suites={
  short:[{name:'short-hit',terms:['badword','café'],text:'hello BADWORD!'}, {name:'short-miss',terms:['badword','café'],text:'ordinary message'}],
  long:[{name:'long-miss',terms:['badword','free money'],text:'ordinary message '.repeat(512)}],
  many:[{name:'many-late',terms:[...Array.from({length:96},(_,i)=>`term${i}`),'a target'],text:'ordinary a target message'}, {name:'many-miss',terms:Array.from({length:96},(_,i)=>`term${i}`),text:'ordinary message'}],
  unicode:[{name:'fold',terms:['café','σ','a b'],text:'😀 CAFÉ \u0345 a\t b'}, {name:'malformed',terms:['\ud800','𐐀'],text:'x\ud800 !𐐀!'}]
};
const [mode,arg,...extra]=process.argv.slice(2); assert.equal(extra.length,0);
if(mode==='--write'||mode==='--check') {
  assert(arg&&path.isAbsolute(arg)); const dir=fs.realpathSync(arg),workspace=fs.realpathSync(path.join(root,'..'));
  assert(dir!==workspace&&!dir.startsWith(workspace+path.sep)); assert.deepEqual(fs.readdirSync(dir),mode==='--write'?[]:['moderation-blacklist-benchmark.json']);
  const output=JSON.stringify({format:1,suites:Object.fromEntries(Object.entries(suites).map(([name,cs])=>[name,cs.map(snapshot)]))},null,2)+'\n';
  if(mode==='--write') fs.writeFileSync(path.join(dir,'moderation-blacklist-benchmark.json'),output,{flag:'wx'}); else assert.equal(fs.readFileSync(path.join(dir,'moderation-blacklist-benchmark.json'),'utf8'),output); console.log(JSON.stringify({sha256:sha(output)}));
} else if(mode==='--sample') {
  const file=process.env.DIMA_BLACKLIST_BENCHMARK_FIXTURE; assert(file&&path.isAbsolute(file));
  const bytes=fs.readFileSync(file), inputSha256=sha(bytes), fixture=JSON.parse(bytes);
  const expectedSha=process.env.DIMA_BLACKLIST_BENCHMARK_SHA256; assert(/^[0-9a-f]{64}$/.test(expectedSha||'')); assert.equal(inputSha256,expectedSha); assert(Object.hasOwn(suites,arg));
  const expected=suites[arg].map(snapshot); assert.deepEqual(fixture.suites[arg],expected);
  const pool=suites[arg].map(c=>({input:{text:c.text},pattern:api.compileBlacklistPattern(c.terms),rule:{terms:c.terms}}));
  // Every fresh actor process warms the same prepared pool before measuring. Retain every output.
  const iterations=Number(process.env.DIMA_BLACKLIST_BENCH_ITERATIONS); assert(Number.isSafeInteger(iterations)&&iterations>0&&iterations<=100000);
  for(let warmup=0;warmup<3;warmup++) {
    const retained=new Array(iterations*pool.length); let index=0;
    for(let i=0;i<iterations;i++) for(const c of pool) retained[index++]=api.evaluateBlacklistRule(c.rule,c.input,c.pattern);
    assert.equal(retained.length,iterations*pool.length);
  }
  assert.equal(typeof global.gc,'function','sample requires Node --expose-gc');
  global.gc(); // Release warmup results outside the timer, as Rust drops them.
  const results=new Array(iterations*pool.length); let index=0; const start=process.hrtime.bigint();
  for(let i=0;i<iterations;i++) for(const c of pool) results[index++]=api.evaluateBlacklistRule(c.rule,c.input,c.pattern);
  const elapsed=process.hrtime.bigint()-start;
  const projected=results.map(x=>({triggered:x.triggered,matchedText:units(x.matchedText)}));
  for(let i=0;i<projected.length;i++) assert.deepEqual(projected[i],expected[i%expected.length].evaluation);
  let checksum=2166136261; for(const x of projected) { for(const n of [x.triggered?1:0,...(x.matchedText ?? []),65536]) checksum=Math.imul(checksum^n,16777619)>>>0; }
  console.log(JSON.stringify({checksum,actor:'node',suite:arg,iterations,operations:projected.length,warmups:3,warmupCleanup:"full-gc-before-timer",nanoseconds:elapsed.toString(),inputSha256,executableSha256:sha(fs.readFileSync(process.execPath)),resultsSha256:sha(JSON.stringify(projected))}));
} else throw new Error('expected --write ABSOLUTE_DIR or --sample SUITE');
