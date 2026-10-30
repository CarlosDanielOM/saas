'use strict';
// Isolated task-owned directory only. --prepare creates inputs without timing;
// --run measures Node; --check validates both reports without timing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const NODE_SHA = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(sha(fs.readFileSync(process.execPath)), NODE_SHA);
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const checkout = path.dirname(root);
const [mode, dir, ...rest] = process.argv.slice(2);
assert(['--prepare', '--run', '--check'].includes(mode) && dir && path.isAbsolute(dir) && !rest.length);
assert(fs.lstatSync(dir).isDirectory());
assert.equal(fs.realpathSync(dir), dir);
assert(dir !== checkout && !dir.startsWith(checkout + path.sep));
const names = {input: 'lossless-json-document-benchmark-input.json', provenance: 'lossless-json-document-benchmark-provenance.json', node: 'lossless-json-document-benchmark-node.json', rust: 'lossless-json-document-benchmark-rust.json'};
const file = key => path.join(dir, names[key]);
function read(key) {
  const target = file(key);
  assert(fs.lstatSync(target).isFile());
  assert.equal(fs.realpathSync(target), target);
  return fs.readFileSync(target);
}
function write(key, bytes) { fs.writeFileSync(file(key), bytes, {flag: 'wx'}); }
const files = [
  'src/utils/lossless_json_document.rs', 'src/utils/lossless_json_view.rs',
  'src/utils/lossless_json.rs', 'src/utils/js_string.rs', 'src/utils/js_compat.rs',
  'src/utils/json_number.rs', 'src/utils/mod.rs', 'tests/lossless_json_document.rs',
  'tests/fixtures/lossless_json_document_reference.cjs', 'tests/support/sha256.rs',
  'tests/lossless_json_document_benchmark.rs', 'tests/fixtures/lossless_json_document_benchmark.cjs',
  'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
];
function sourceHashes() { return Object.fromEntries(files.map(f => [f, sha(fs.readFileSync(path.join(root, f)))])); }
function operation(raw) {
  const root = JSON.parse(raw);
  const value = Object.hasOwn(root, 'error') ? root.error : undefined;
  return value ? JSON.stringify(value) : 'null';
}
function rawCase(name, i) {
  if (name === 'small-strings') {
    if (i % 8 === 0) return `{"missing":${i}}`;
    if (i % 8 === 1) return `{"id":${i},"error":false}`;
    if (i % 8 === 2) return `{"id":${i},"error":0}`;
    if (i % 8 === 3) return `{"id":${i},"error":""}`;
    return `{"error":"failure-${i}"}`;
  }
  if (name === 'wide-object') {
    const fields = Array.from({length: 32}, (_, n) => `"field${n}":${n + i}`).join(',');
    return `{"error":{"10":1,"2":2,"name":"first",${fields},"2":${i},"name":"last-${i}"}}`;
  }
  if (name === 'large-ignored') return `{"payload":"${'x'.repeat(8192)}","error":"failure-${i}"}`;
  if (name === 'deep-selected') return `{"error":${'['.repeat(256)}{"item":${i}}${']'.repeat(256)}}`;
  if (name === 'escaped-strings') return `{"error":"case-${i}\\n\\t\\u0000\\ud800X\\udc00X\\ud800\\u001f\\\\\\\""}`;
  throw new Error(`unknown workload ${name}`);
}
const definitions = [['small-strings', 500], ['wide-object', 500], ['large-ignored', 100], ['deep-selected', 500], ['escaped-strings', 500]];
const warmupPasses = 20;
function makeInput() {
  return {format: 1, operation: 'JSON.parse, own error lookup, truthiness, JSON.stringify or null', warmupPasses, trials: 7,
    workloads: definitions.map(([name, passes]) => ({name, passes, caseCount: 32,
      pool: Array.from({length: 32}, (_, i) => { const raw = rawCase(name, i); const expected = operation(raw);
        assert(typeof expected === 'string' && /^[\x00-\x7f]*$/.test(expected));
        return {raw, expected}; })}))};
}
const inputBytes = Buffer.from(JSON.stringify(makeInput()) + '\n');
const inputSha = sha(inputBytes);
const provenanceBytes = Buffer.from(JSON.stringify({format: 1, node: process.version, v8: process.versions.v8, nodeSha256: NODE_SHA, inputSha256: inputSha, hashes: sourceHashes()}) + '\n');
const provenanceSha = sha(provenanceBytes);
function pin(name, expected) { assert.equal(process.env[name], expected, `${name} independent pin required`); }
function validateInputs() {
  pin('DIMA_JSON_DOCUMENT_BENCH_INPUT_SHA256', inputSha);
  pin('DIMA_JSON_DOCUMENT_BENCH_PROVENANCE_SHA256', provenanceSha);
  assert.deepEqual(read('input'), inputBytes);
  assert.deepEqual(read('provenance'), provenanceBytes);
  assert.deepEqual(sourceHashes(), JSON.parse(provenanceBytes).hashes);
}
function expectedSum(w, passes) { return (w.pool.reduce((sum, row) => sum + row.expected.length, 0) * passes) >>> 0; }
function run(w, passes) {
  let sum = 0;
  for (let pass = 0; pass < passes; pass++) for (const row of w.pool) sum = (sum + operation(row.raw).length) >>> 0;
  return sum;
}
function validateReport(report, runtime) {
  const input = makeInput();
  assert.equal(report.format, 1); assert.equal(report.runtime, runtime);
  assert.equal(report.inputSha256, inputSha); assert.equal(report.provenanceSha256, provenanceSha);
  assert.equal(report.workloads.length, input.workloads.length);
  report.workloads.forEach((r, i) => {
    const w = input.workloads[i]; const operations = w.passes * w.caseCount;
    assert.equal(r.name, w.name); assert.equal(r.passes, w.passes); assert.equal(r.caseCount, 32);
    assert.equal(r.operations, operations); assert.equal(r.warmupPasses, warmupPasses);
    assert.equal(r.checksum, expectedSum(w, w.passes)); assert.equal(r.ascii, true);
    assert.equal(r.samples.length, 7);
    for (const sample of r.samples) {
      assert(Number.isSafeInteger(sample.elapsedNs) && sample.elapsedNs > 0);
      assert.equal(sample.checksum, r.checksum);
      assert.equal(sample.nsPerOp, sample.elapsedNs / operations);
    }
    const median = [...r.samples].sort((a, b) => a.elapsedNs - b.elapsedNs)[3];
    assert.equal(r.medianNsPerOp, median.nsPerOp);
  });
}
if (mode === '--prepare') {
  assert.deepEqual(fs.readdirSync(dir), []);
  write('input', inputBytes); write('provenance', provenanceBytes);
  console.log(JSON.stringify({inputSha256: inputSha, provenanceSha256: provenanceSha}));
} else if (mode === '--run') {
  validateInputs();
  assert(!fs.existsSync(file('node')), 'refusing overwrite');
  const input = makeInput();
  for (const w of input.workloads) for (const row of w.pool) assert.equal(operation(row.raw), row.expected);
  const workloads = input.workloads.map(w => {
    assert.equal(run(w, warmupPasses), expectedSum(w, warmupPasses));
    const operations = w.passes * w.caseCount, samples = [];
    for (let trial = 0; trial < 7; trial++) {
      const start = process.hrtime.bigint(); const checksum = run(w, w.passes);
      const elapsedNs = Number(process.hrtime.bigint() - start);
      assert.equal(checksum, expectedSum(w, w.passes));
      samples.push({elapsedNs, nsPerOp: elapsedNs / operations, checksum});
    }
    return {name: w.name, passes: w.passes, caseCount: w.caseCount, operations, warmupPasses, ascii: true,
      checksum: expectedSum(w, w.passes), samples, medianNsPerOp: [...samples].sort((a,b) => a.elapsedNs - b.elapsedNs)[3].nsPerOp};
  });
  validateInputs();
  const report = {format: 1, runtime: 'node', inputSha256: inputSha, provenanceSha256: provenanceSha, workloads};
  validateReport(report, 'node');
  const bytes = Buffer.from(JSON.stringify(report) + '\n'); write('node', bytes);
  console.log(JSON.stringify({nodeReportSha256: sha(bytes), inputSha256: inputSha, provenanceSha256: provenanceSha}));
} else {
  validateInputs();
  const node = read('node'), rust = read('rust');
  pin('DIMA_JSON_DOCUMENT_BENCH_NODE_SHA256', sha(node));
  pin('DIMA_JSON_DOCUMENT_BENCH_RUST_SHA256', sha(rust));
  validateReport(JSON.parse(node), 'node'); validateReport(JSON.parse(rust), 'rust-release');
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.values(names).sort());
  console.log(JSON.stringify({inputSha256: inputSha, provenanceSha256: provenanceSha, nodeReportSha256: sha(node), rustReportSha256: sha(rust), checked: true}));
}
