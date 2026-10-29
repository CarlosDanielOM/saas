// Run in the owner's isolated container from dimabot/:
// node tests/fixtures/expressive_tts_benchmark.mjs --write DIR
// node tests/fixtures/expressive_tts_benchmark.mjs --check DIR
// --check verifies deterministic input bytes, provenance and existing result
// checksums, never timing values. No provider or application services are used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const [mode, dir, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dir || extra.length) throw Error('usage: --write|--check DIR');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const sourcePath = 'src/utils/tts/expressive_tts_tags.util.ts';
const source = await fs.readFile(path.join(root, sourcePath), 'utf8');
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
const api = {};
new vm.Script(`(function(exports){${js}\n})`, {filename:sourcePath}).runInThisContext()(api);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const paths = [sourcePath, 'package.json', 'package-lock.json', 'node_modules/typescript/package.json', 'tests/fixtures/expressive_tts_benchmark.mjs'];
const hashes = Object.fromEntries(await Promise.all(paths.map(async p => [p, hash(await fs.readFile(path.join(root,p)))])));
hashes['typescript-entry'] = hash(await fs.readFile(require.resolve('typescript')));
hashes['node-executable'] = hash(await fs.readFile(process.execPath));
const units = s => Array.from({length:s.length}, (_, i) => s.charCodeAt(i));
const sum = a => a.reduce((n, u) => (n + u) >>> 0, 0);
const enabled = {happy:true, angry:true, whisper:true, laugh:false, cry:false, pause:true, 'long-pause':false, 'audience laughing':true};
const definitions = [
  {name:'filter-ascii-plain', op:'filter', provider:'fish', enabled, text:'Hello chat, this is a normal message.'},
  {name:'filter-mixed-aliases', op:'filter', provider:'fish', enabled, text:'<Anger>LOUD</Anger> [whispering] hush [laughing] [crying loudly] [break] [long-break] [crowd laughing] [unknown]'},
  {name:'filter-piper', op:'filter', provider:'piper', enabled, text:'Hello [happy] there <whisper>friend</whisper> [laughing]!'},
  {name:'filter-unicode-lone', op:'filter', provider:'fish', enabled, text:'😀 café \ud800 [HAPPY] \udc00 [\ud800] <whispering>終</whispering>'},
  {name:'filter-large', op:'filter', provider:'fish', enabled, text:('hello [happy] café [laughing] <anger>hi</anger> 😀 '.repeat(96)), iterations:1000},
  {name:'reinforce-plain', op:'reinforce', text:'Hello chat, this is a normal message.'},
  {name:'reinforce-groups', op:'reinforce', text:'[happy] [happy] [sad] [pause]\n[pause] [laugh] [unknown] [whisper]'},
  {name:'reinforce-unicode-lone', op:'reinforce', text:'😀 \ud800[happy]\udc00 [happy] [happy] café [pause]'},
  {name:'reinforce-large', op:'reinforce', text:('[happy] hello [happy] [happy] café [pause] 😀 '.repeat(96)), iterations:1000},
];
const call = w => w.op === 'filter' ? api.filterExpressiveTtsTags(w.text, w.options) : api.reinforceFishTtsTags(w.text);
const prepared = definitions.map(({text, enabled: settings, iterations = 10000, ...w}) => ({...w, text, options:w.op === 'filter' ? {provider:w.provider, enabledTags:settings} : undefined, iterations}));
const workloads = prepared.map(w => {
  const expectedUnits = units(call(w));
  return {name:w.name, op:w.op, provider:w.provider ?? null, enabled:w.options?.enabledTags ?? null, inputUnits:units(w.text), expectedUnits, expectedUnitsChecksum:sum(expectedUnits), iterations:w.iterations};
});
const inputBytes = JSON.stringify({schema:1, warmups:100, samples:7, workloads}, null, 2) + '\n';
const inputHash = hash(inputBytes);
const inputPath = path.join(dir, 'expressive-benchmark-inputs.json');
const nodePath = path.join(dir, 'expressive-node-benchmark.json');
const validateReport = (report, implementation) => {
  assert.equal(report.implementation, implementation);
  assert.equal(report.inputSha256, inputHash);
  assert.equal(report.warmups, 100);
  assert.equal(report.runs.length, workloads.length);
  for (const [i, w] of workloads.entries()) {
    const r = report.runs[i];
    assert.equal(r.name, w.name); assert.equal(r.iterations, w.iterations);
    assert.equal(r.expectedUnitsChecksum, w.expectedUnitsChecksum);
    assert.equal(r.resultChecksum, Math.imul(w.expectedUnitsChecksum, w.iterations) >>> 0);
    assert.equal(r.samples.length, 7);
    for (const s of r.samples) assert.equal(s.checksum, r.resultChecksum);
  }
};
if (mode === '--check') {
  assert.equal(await fs.readFile(inputPath, 'utf8'), inputBytes, 'prepared input mismatch');
  const report = JSON.parse(await fs.readFile(nodePath, 'utf8'));
  assert.deepEqual(report.provenance.hashes, hashes);
  assert.equal(report.provenance.node, process.version); assert.equal(report.provenance.typescript, ts.version);
  validateReport(report, 'actual-typescript');
  try { validateReport(JSON.parse(await fs.readFile(path.join(dir, 'expressive-rust-benchmark.json'), 'utf8')), 'native-rust'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  console.log(JSON.stringify({mode:'checked', inputSha256:inputHash, workloads:workloads.length}));
} else {
  await fs.mkdir(dir, {recursive:true});
  await fs.writeFile(inputPath, inputBytes);
  const runs = [];
  for (const [index, w] of prepared.entries()) {
    assert.deepEqual(units(call(w)), workloads[index].expectedUnits);
    let warmupChecksum = 0;
    for (let i=0; i<100; i++) {
      const output = call(w);
      for (let j=0; j<output.length; j++) warmupChecksum = (warmupChecksum + output.charCodeAt(j)) >>> 0;
    }
    assert.equal(warmupChecksum, Math.imul(workloads[index].expectedUnitsChecksum, 100) >>> 0);
    const samples = [];
    for (let sample=0; sample<7; sample++) {
      let checksum = 0;
      const start = process.hrtime.bigint();
      for (let i=0; i<w.iterations; i++) {
        const output = call(w);
        for (let j=0; j<output.length; j++) checksum = (checksum + output.charCodeAt(j)) >>> 0;
      }
      const elapsed = Number(process.hrtime.bigint() - start);
      samples.push({elapsedNs:elapsed, checksum});
    }
    const medianNsPerOp = samples.map(s => s.elapsedNs / w.iterations).sort((a,b) => a-b)[3];
    runs.push({name:w.name, iterations:w.iterations, expectedUnitsChecksum:workloads[index].expectedUnitsChecksum, resultChecksum:samples[0].checksum, samples, medianNsPerOp, medianUsPerOp:medianNsPerOp / 1000});
  }
  const report = {implementation:'actual-typescript', scope:'prepared filter or reinforce + wrapping sum of every UTF-16 output unit', inputSha256:inputHash, warmups:100, provenance:{hashes,node:process.version, v8:process.versions.v8, typescript:ts.version}, runs};
  validateReport(report, 'actual-typescript');
  await fs.writeFile(nodePath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({mode:'written', inputSha256:inputHash, workloads:workloads.length}));
}
