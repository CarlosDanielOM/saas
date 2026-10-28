// Run only in a disposable, capped environment with networking disabled:
// node --experimental-vm-modules fish_catalog_benchmark.mjs FIXTURE_JSON OUTPUT_DIR
// Measures source normalizeFishVoice on prepared objects, JSON serialization,
// UTF-8 encoding, and a full-byte checksum; excludes parsing, I/O, and setup.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw new Error('unexpected Node/V8 runtime');
const [fixtureArg, outputArg, ...extra] = process.argv.slice(2);
if (!fixtureArg || !outputArg || extra.length) throw new Error('usage: fish_catalog_benchmark.mjs FIXTURE_JSON OUTPUT_DIR');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.resolve(outputArg);
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = {catalog:'src/server/services/tts/fish_voice_catalog.service.ts',fish:'src/server/services/tts/fish_tts.service.ts'};
const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key,p]) => [key,await fs.readFile(path.join(root,p),'utf8')])));
const sourceHashes = Object.fromEntries(Object.entries(files).map(([key,p]) => [p,sha(sources[key])]));
sourceHashes['tests/fixtures/fish_catalog_benchmark.mjs'] = sha(await fs.readFile(fileURLToPath(import.meta.url)));
for (const p of ['package.json','package-lock.json','node_modules/typescript/package.json']) sourceHashes[p] = sha(await fs.readFile(path.join(root,p)));
sourceHashes['node_modules/typescript/lib/typescript.js'] = sha(await fs.readFile(require.resolve('typescript')));
sourceHashes['node-executable'] = sha(await fs.readFile(process.execPath));
const fixtureBytes = await fs.readFile(path.resolve(fixtureArg));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
if (fixture.schema !== 1 || !Array.isArray(fixture.cases)) throw new Error('invalid source fixture');
for (const p of Object.values(files)) {
  if (fixture.provenance?.sourceHashes?.[p] !== sourceHashes[p]) throw new Error(`fixture source mismatch: ${p}`);
}
const compile = source => ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const synthetic = entries => new vm.SyntheticModule(Object.keys(entries),function () { for (const [key,value] of Object.entries(entries)) this.setExport(key,value); });
const forbidden = () => { throw new Error('forbidden benchmark dependency'); };
const imports = {
  'fs/promises':synthetic({default:{mkdir:forbidden,writeFile:forbidden}}), 'path':synthetic({default:{join:forbidden,dirname:forbidden}}),
  'fish-audio':synthetic({FishAudioClient:forbidden}),
  '../../../utils/ai/openrouter/app_attribution.util.js':synthetic({OPENROUTER_APP_HEADERS:{}}),
  '../../../utils/tts/expressive_tts_tags.util.js':synthetic({reinforceFishTtsTags:forbidden}),
  '../../../utils/tts/tts_deadline.util.js':synthetic({readAudioStream:forbidden}),
  './piper_tts.service.js':synthetic({PIPER_PUBLIC_SPEECH_DIR:'forbidden',buildPublicPath:forbidden}),
};
const oldFetch = globalThis.fetch;
globalThis.fetch = forbidden;
try {
  const fish = new vm.SourceTextModule(compile(sources.fish),{identifier:files.fish});
  await fish.link(spec => { if (!imports[spec]) throw new Error(`blocked import ${spec}`); return imports[spec]; });
  await fish.evaluate();
  const catalog = new vm.SourceTextModule(compile(sources.catalog),{identifier:files.catalog});
  await catalog.link(spec => { if (spec !== './fish_tts.service.js') throw new Error(`blocked import ${spec}`); return fish; });
  await catalog.evaluate();
  const normalize = catalog.namespace.normalizeFishVoice;
  const selected = ['normalize-valid','normalize-cuts','normalize-gender'].map(name => {
    const matches = fixture.cases.filter(item => item.name === name && item.operation === 'normalize');
    if (matches.length !== 1) throw new Error(`missing or duplicate fixture ${name}`);
    const source = matches[0];
    const outcome = JSON.parse(source.outcomeJson);
    if (!outcome.ok || outcome.value === null || typeof source.inputJson !== 'string') throw new Error(`invalid fixture ${name}`);
    return {name,inputJson:source.inputJson,iterations:10000,oracleExpected:JSON.stringify(outcome.value)};
  });
  const large = JSON.parse(selected[0].inputJson);
  large.tags = Array.from({length:1000},(_,i) => i % 2 ? 'bright' : 'calm');
  large.languages = Array.from({length:200},(_,i) => `language-${i}-😀`);
  large.description = 'long description 😀 '.repeat(1000);
  selected.push({name:'normalize-large',inputJson:JSON.stringify(large),iterations:1000});
  const prepared = selected.map(item => {
    const input = JSON.parse(item.inputJson);
    const output = normalize(input);
    if (output === null) throw new Error(`unsuccessful workload ${item.name}`);
    const expectedJson = JSON.stringify(output);
    if (item.oracleExpected !== undefined && expectedJson !== item.oracleExpected) throw new Error(`source fixture differs: ${item.name}`);
    const expectedBytes = Buffer.from(expectedJson,'utf8');
    return {name:item.name,input,inputJson:item.inputJson,expectedJson,expectedUtf8Hex:expectedBytes.toString('hex'),inputSha256:sha(Buffer.from(item.inputJson,'utf8')),iterations:item.iterations};
  });
  const inputDocument = {schema:1,workloads:prepared.map(({input,...item}) => item)};
  const inputBytes = Buffer.from(JSON.stringify(inputDocument,null,2)+'\n','utf8');
  const inputsSha256 = sha(inputBytes);
  const workloadResults = [];
  for (const workload of prepared) {
    // Warmups perform the same work but are not included in measured totals.
    let warmupChecksum = 0, warmupBytes = 0;
    for (let i=0;i<100;i++) {
      const bytes = Buffer.from(JSON.stringify(normalize(workload.input)),'utf8');
      warmupBytes += bytes.length;
      for (const byte of bytes) warmupChecksum = (warmupChecksum + byte) >>> 0;
    }
    const samples = [];
    for (let sample=0;sample<7;sample++) {
      let checksum = 0, byteCount = 0;
      const start = process.hrtime.bigint();
      for (let i=0;i<workload.iterations;i++) {
        const bytes = Buffer.from(JSON.stringify(normalize(workload.input)),'utf8');
        byteCount += bytes.length;
        for (const byte of bytes) checksum = (checksum + byte) >>> 0;
      }
      const elapsedNs = (process.hrtime.bigint() - start).toString();
      samples.push({elapsedNs,checksum,bytes:byteCount});
    }
    const expectedBytes = Buffer.from(workload.expectedUtf8Hex,'hex');
    let oneSum = 0;
    for (const byte of expectedBytes) oneSum = (oneSum + byte) >>> 0;
    const expectedSum = Math.imul(oneSum,workload.iterations) >>> 0;
    if (samples.some(sample => sample.checksum !== expectedSum || sample.bytes !== expectedBytes.length * workload.iterations)) throw new Error(`output changed during timing: ${workload.name}`);
    workloadResults.push({name:workload.name,iterations:workload.iterations,warmupChecksum,warmupBytes,samples});
  }
  const results = {schema:1,provenance:{node:process.version,versions:process.versions,sourceHashes,fixtureSha256:sha(fixtureBytes),scope:'prepared normalizer, JSON serialization, UTF-8 encoding, full-byte wrapping u32 sum'},inputsSha256,warmups:100,samples:7,workloads:workloadResults};
  await fs.mkdir(outputDir,{recursive:true});
  await fs.writeFile(path.join(outputDir,'fish-catalog-benchmark-inputs.json'),inputBytes);
  await fs.writeFile(path.join(outputDir,'fish-catalog-benchmark-node.json'),JSON.stringify(results,null,2)+'\n');
  process.stdout.write(JSON.stringify({schema:1,inputsSha256,workloads:workloadResults.length})+'\n');
} finally { globalThis.fetch = oldFetch; }
