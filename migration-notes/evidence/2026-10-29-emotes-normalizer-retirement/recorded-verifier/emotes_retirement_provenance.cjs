const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const base = '/artifacts/emotes-normalizer-retirement';
const root = '/source/dimabot';
const read = name => JSON.parse(fs.readFileSync(name,'utf8'));
const normalize = value => JSON.parse(JSON.stringify(value).replaceAll('/artifacts/emotes-normalizer-retirement','/artifacts/owned-fixture').replaceAll('/artifacts/tts-utility-retirement','/artifacts/owned-fixture'));
const pairs = [
  ['tts-utilities/tts_utilities_cases.json','/source/dimabot/tests/fixtures/tts_utilities_cases.json',['sources','cases']],
  ['lossless/tts_lossless_cases.json','/artifacts/tts-lossless-normalization/reference/tts_lossless_cases.json',['metadata','cases']],
  ['expressive/expressive-tts-reference.json','/artifacts/tts-utility-retirement/expressive/expressive-tts-reference.json',['metadata','cases']],
  ['credit/tts-credit-fallback-reference.json','/artifacts/tts-utility-retirement/credit/tts-credit-fallback-reference.json',['cases']],
  ['settings/channel-tts-settings-reference.json','/artifacts/tts-utility-retirement/settings/channel-tts-settings-reference.json',['metadata','defaultAfterMutation','cases','schemaCases']],
  ['fish/fish-tts-reference.json','/artifacts/tts-utility-retirement/fish/fish-tts-reference.json',['cases','publicPathCases']],
  ['piper-kokoro/piper-kokoro-reference.json','/artifacts/tts-utility-retirement/piper-kokoro/piper-kokoro-reference.json',['cases','publicPathCases']],
  ['runtime/tts_runtime_dynamic_reference.json','/artifacts/tts-utility-retirement/runtime/tts_runtime_dynamic_reference.json',['cases']],
  ['normalization-prepared/fixtures.json','/artifacts/tts-utility-retirement/normalization-prepared/fixtures.json',['workloads']],
  ['benchmark-tooling-smoke/tts-lossless-benchmark-inputs.json','/artifacts/tts-lossless-normalization/final-benchmark/tts-lossless-benchmark-inputs.json',['workloads']],
];
for (const [fresh,old,keys] of pairs) {
  const a=read(`${base}/${fresh}`),b=read(old);
  for (const key of keys) assert.deepEqual(normalize(a[key]),normalize(b[key]),`${fresh}:${key}`);
}
const emotes=read(`${base}/emotes/twitch_emotes_cases.json`);
assert.equal(emotes.provenance.node,'v24.22.1');
const locations={channel:'src/utils/twitch_emotes.ts',names:'src/utils/tts/emote_names.util.ts',oracle:'tests/fixtures/twitch_emotes_reference.cjs',package:'package.json',lock:'package-lock.json',typescript:'node_modules/typescript/lib/typescript.js',typescriptPackage:'node_modules/typescript/package.json',node:process.execPath};
for (const [key,hash] of Object.entries(emotes.provenance.hashes)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root,locations[key]))).digest('hex'),hash,key);
const lossless=read(`${base}/lossless/tts_lossless_cases.json`);
const benchmark=read(`${base}/benchmark-tooling-smoke/tts-lossless-benchmark-inputs.json`);
assert.deepEqual(lossless.provenance,benchmark.provenance);
for (const [key,hash] of Object.entries(lossless.provenance.hashes)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root,lossless.provenance.sourcePaths[key]))).digest('hex'),hash,key);
const summary={schema:1,semanticFixtureComparisons:pairs.length,losslessSourceCases:lossless.cases.length,emoteSourceCases:emotes.cases.length,emoteSourceHashesVerified:Object.keys(emotes.provenance.hashes).length,losslessSourceHashesVerified:Object.keys(lossless.provenance.hashes).length,benchmark:'Node tooling smoke only; prior paired measurements retained without reinterpretation',archiveCount:21};
fs.writeFileSync(`${base}/source-provenance-and-semantic-parity.json`,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
