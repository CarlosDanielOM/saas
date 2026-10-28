// Arguments: <prepared-directory> <output-json>. The TypeScript compiler must
// never be loaded into this measured process; preparation runs separately.
const fs = require('node:fs');
const path = require('node:path');
const prepared = process.argv[2];
const output = process.argv[3];
if (!prepared || !output) throw new Error('prepared directory and output path required');
const compilerLoaded = () => Object.keys(require.cache).some(name => /(?:^|[\\/])typescript(?:[\\/]|$)/.test(name));
if (compilerLoaded()) throw new Error('TypeScript compiler loaded in benchmark process');
const fixture = JSON.parse(fs.readFileSync(path.join(prepared, 'fixtures.json'), 'utf8'));
const {normalizeTtsMessage} = require(path.resolve(prepared, 'normalize_tts_message.util.js'));
if (compilerLoaded()) throw new Error('TypeScript compiler loaded by measured module');
function run(workload, iterations) {
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    const text = normalizeTtsMessage(workload.input, workload.options).text;
    for (let j = 0; j < text.length; j++) checksum = (checksum + text.charCodeAt(j)) >>> 0;
  }
  return checksum;
}
const results = [];
for (const workload of fixture.workloads) {
  const text = normalizeTtsMessage(workload.input, workload.options).text;
  if (text.length !== workload.outputCodeUnits || run(workload, 1) !== workload.checksumPerOp) throw new Error(`fixture mismatch: ${workload.name}`);
  run(workload, workload.warmupIterations);
  const expectedChecksum = Math.imul(workload.checksumPerOp, workload.iterations) >>> 0;
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const started = process.hrtime.bigint();
    const checksum = run(workload, workload.iterations);
    const elapsedNs = Number(process.hrtime.bigint() - started);
    if (checksum !== expectedChecksum) throw new Error(`checksum mismatch: ${workload.name}`);
    samples.push({elapsedNs, checksum});
  }
  const elapsed = samples.map(sample => sample.elapsedNs).sort((a, b) => a - b);
  results.push({name: workload.name, iterations: workload.iterations, warmupIterations: workload.warmupIterations, outputCodeUnits: workload.outputCodeUnits, checksumPerOp: workload.checksumPerOp, samples, medianNsPerOp: elapsed[3] / workload.iterations});
}
fs.writeFileSync(output, `${JSON.stringify({version: 1, runtime: 'node', compilerLoaded: compilerLoaded(), measurement: 'normalization plus UTF-16 checksum; excludes JSON serialization', sourceHashes: fixture.sourceHashes, workloads: results}, null, 2)}\n`);
