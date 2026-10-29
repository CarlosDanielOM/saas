const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = '/source/dimabot';
const base = '/artifacts/tts-lossless-normalization';
const reference = JSON.parse(fs.readFileSync(`${base}/reference/tts_lossless_cases.json`, 'utf8'));
const prepared = JSON.parse(fs.readFileSync(`${base}/benchmark/tts-lossless-benchmark-inputs.json`, 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(reference.provenance, prepared.provenance);
assert.deepEqual(reference.metadata, prepared.metadata);
for (const [name, hash] of Object.entries(reference.provenance.hashes)) {
  const source = path.resolve(root, reference.provenance.sourcePaths[name]);
  assert.equal(sha(fs.readFileSync(source)), hash, `source hash: ${name}`);
}
assert.equal(prepared.benchmarkSha256, sha(fs.readFileSync(`${root}/tests/fixtures/tts_lossless_benchmark.cjs`)));
const counts = Object.fromEntries(['normalize','pet','extract','spoken'].map(op => [op, reference.cases.filter(c => c.op === op).length]));
assert(Object.values(counts).every(count => count > 0));
const fallback = reference.cases.filter(c => c.setting === 'actual-credit-fallback');
assert.equal(fallback.length, 6);
const report = {
  sourceHashesVerified: Object.keys(reference.provenance.hashes).length,
  sourceCases: reference.cases.length,
  operationCounts: counts,
  actualSourceFallbackProviderCases: fallback.map(c => ({status:c.status,tier:c.tier,provider:c.provider})),
  benchmarkWorkloads: prepared.workloads.length,
  benchmarkInputSha256: sha(fs.readFileSync(`${base}/benchmark/tts-lossless-benchmark-inputs.json`)),
  scope: 'actual source; ordinary JSON data and declared typed providers; all compared text fields use UTF-16 units',
};
fs.writeFileSync(`${base}/source-provenance-and-counts.json`, JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report)+'\n');
