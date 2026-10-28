// Independent fresh Node process; all fixture and string preparation precedes timing.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

assert.equal(process.versions.node, '24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(process.versions.icu, '78.3');
assert.equal(process.versions.tz, '2026e');
const zone = process.env.TZ;
assert(['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Apia'].includes(zone));
const workload = process.env.JS_DATE_BENCH_WORKLOAD;
assert(['iso', 'legacy', 'invalid', 'mixed'].includes(workload));
const corpus = JSON.parse(readFileSync(new URL('js_date_cases.json', import.meta.url), 'utf8'));
assert.equal(corpus.cases.length, corpus.results[zone].length);
const inputs = corpus.cases.filter((item, i) => workload === 'mixed' ||
  (workload === 'invalid' ? corpus.results[zone][i] === null : item.group === workload))
  .map(item => String.fromCharCode(...item.units));
assert(inputs.length > 0);
function run(iterations) {
  let checksum = 0, valid = 0;
  for (let i = 0; i < iterations; i++) {
    const value = Date.parse(inputs[i % inputs.length]);
    if (!Number.isNaN(value)) { valid++; checksum = (checksum + (value >>> 0)) >>> 0; }
    checksum = (checksum + i) >>> 0;
  }
  return {checksum, valid, invalid:iterations - valid};
}
run(10_000);
const samplesNs = [];
let result;
for (let i = 0; i < 7; i++) {
  const start = process.hrtime.bigint();
  const outcome = run(100_000);
  samplesNs.push(Number(process.hrtime.bigint() - start));
  if (result) assert.deepEqual(result, outcome);
  result = outcome;
}
const output = JSON.stringify({runtime:process.versions, zone, workload, cases:inputs.length,
  iterations:100_000, warmup:10_000, samplesNs, ...result});
if (process.env.JS_DATE_BENCH_OUTPUT) writeFileSync(process.env.JS_DATE_BENCH_OUTPUT, output);
console.log(output);
