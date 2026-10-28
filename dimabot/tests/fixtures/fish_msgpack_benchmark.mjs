// Run in a fresh private Node process after generating fish-sdk-protocol.json.
// Measures only the installed @msgpack/msgpack encoder and the agreed byte scan.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encode } from '@msgpack/msgpack';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || process.versions.icu !== '78.3' || process.versions.tz !== '2026e') throw new Error('unexpected Node/V8/ICU/tz runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root,'package.json'));
const fixtureDir = process.env.FISH_TTS_FIXTURE_DIR;
const output = process.env.FISH_MSGPACK_BENCH_OUTPUT;
if (!fixtureDir || !output) throw new Error('FISH_TTS_FIXTURE_DIR and FISH_MSGPACK_BENCH_OUTPUT are required');
const fixtureBytes = await fs.readFile(path.join(fixtureDir,'fish-sdk-protocol.json'));
const fixture = JSON.parse(fixtureBytes);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fromUnits = units => {
  let value = '';
  for (let i=0; i<units.length; i+=8192) value += String.fromCharCode(...units.slice(i,i+8192));
  return value;
};
const names = ['basic','emoji','unicode-reference','units-49-high','units-50-high','units-51-high','reference-50-high','reference-51-high','ascii-bytes-65536'];
const prepared = names.map(name => {
  const c = fixture.cases.find(x => x.name === name);
  if (!c) throw new Error(`missing workload ${name}`);
  const request = {text:fromUnits(c.textUnits),reference_id:fromUnits(c.referenceUnits),format:'mp3'};
  const actual = Buffer.from(encode(request));
  if (actual.toString('hex') !== c.request.body.hex) throw new Error(`SDK encoding differs for ${name}`);
  return {name,request,iterations:name === 'ascii-bytes-65536' ? 1000 : 10000,units:{text:c.textUnits.length,reference:c.referenceUnits.length}};
});
function sample(request, iterations) {
  let checksum = 0, bytes = 0;
  for (let i=0; i<iterations; i++) {
    const encoded = encode(request);
    bytes += encoded.length;
    for (let j=0; j<encoded.length; j++) checksum = (checksum + encoded[j]) >>> 0;
  }
  return {bytes,checksum};
}
const cases = [];
for (const item of prepared) {
  sample(item.request,100);
  const samplesNs = [];
  let expected;
  for (let i=0; i<7; i++) {
    const start = process.hrtime.bigint();
    const result = sample(item.request,item.iterations);
    samplesNs.push(Number(process.hrtime.bigint()-start));
    if (expected && (expected.bytes !== result.bytes || expected.checksum !== result.checksum)) throw new Error(`unstable checksum ${item.name}`);
    expected = result;
  }
  cases.push({name:item.name,units:item.units,iterations:item.iterations,...expected,samplesNs});
}
const packagePath = path.join(root,'node_modules/@msgpack/msgpack/package.json');
const metadata = {
  node:process.version,versions:process.versions,
  msgpackVersion:JSON.parse(await fs.readFile(packagePath,'utf8')).version,
  fixtureSha256:sha(fixtureBytes),harnessSha256:sha(await fs.readFile(fileURLToPath(import.meta.url))),
  warmupIterations:100,samples:7,checksum:'sum of every encoded byte over all iterations modulo 2^32',
};
await fs.writeFile(output,JSON.stringify({schema:1,metadata,cases},null,2)+'\n');
process.stdout.write(JSON.stringify({schema:1,cases:cases.length,harnessSha256:metadata.harnessSha256,fixtureSha256:metadata.fixtureSha256})+'\n');
