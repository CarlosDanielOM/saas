'use strict';
// Engine oracle only. Run in the parent's pinned isolated snapshot; no services.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');

assert.equal(process.version, 'v24.22.1', 'pinned Node reference required');
assert.equal(process.versions.v8, '13.6.233.17-node.58', 'pinned V8 reference required');
assert.equal(ts.version, '5.9.3', 'pinned TypeScript reference required');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && !extra.length,
  'usage: --write PRECREATED_TASK_DIR | --check PRECREATED_TASK_DIR');
const dir = path.resolve(directory);
assert(fs.statSync(dir).isDirectory(), 'precreated task-owned directory required');
const destination = path.join(dir, 'json-number-reference.json');
const root = path.resolve(__dirname, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// There is no handwritten decimal algorithm or copied native formatter here.
// TypeScript transpiles the complete reference, which calls the actual engine
// built-ins for every raw binary64 input. No application module is loaded.
const engineSource = [
  'export function stringNumber(value: number): string { return String(value); }',
  'export function jsonNumber(value: number): string { return JSON.stringify(value); }',
  '',
].join('\n');
const compilerOptions = {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022};
const compiled = ts.transpileModule(engineSource, {compilerOptions, reportDiagnostics: true});
assert.equal(compiled.diagnostics.length, 0, 'reference transpilation diagnostics');
const engine = {};
new Function('exports', compiled.outputText)(engine);
assert.deepEqual(Object.keys(engine), ['stringNumber', 'jsonNumber']);

const SIGN = 0x8000000000000000n;
const MASK = 0xffffffffffffffffn;
const FRACTION = 0x000fffffffffffffn;
const EXPONENT = 0x7ff0000000000000n;
const MAX_FINITE = 0x7fefffffffffffffn;
const bytes = Buffer.alloc(8);
function bits(value) { bytes.writeDoubleBE(value); return bytes.readBigUInt64BE(); }
function number(raw) { bytes.writeBigUInt64BE(raw); return bytes.readDoubleBE(); }
const hex = raw => raw.toString(16).padStart(16, '0');
const inputs = new Map();
function add(raw, group) {
  assert(raw >= 0n && raw <= MASK);
  const input = hex(raw);
  if (!inputs.has(input)) inputs.set(input, new Set());
  inputs.get(input).add(group);
}
function neighbors(magnitude, group, radius = 2) {
  const center = bits(magnitude);
  assert(center <= MAX_FINITE && magnitude >= 0, 'finite unsigned center required');
  for (let delta = -radius; delta <= radius; delta++) {
    const raw = center + BigInt(delta);
    if (raw < 0n || raw > MAX_FINITE) continue;
    add(raw, group);
    add(raw | SIGN, group);
  }
}

// Preserve raw signs and payloads even when String/JSON intentionally erase
// them. Quiet NaNs avoid incidental signaling-NaN canonicalization concerns.
for (const raw of [0n, SIGN, 1n, SIGN | 1n, FRACTION, SIGN | FRACTION,
  0x0010000000000000n, 0x8010000000000000n, MAX_FINITE, SIGN | MAX_FINITE,
  EXPONENT, SIGN | EXPONENT, 0x7ff8000000000000n, 0xfff8000000000000n,
  0x7ff8000000000042n, 0xfff8000000000042n]) add(raw, 'special');

for (const magnitude of [1e-6, 1e21]) neighbors(magnitude, 'notation-boundary', 4);
for (const magnitude of [0, 1, 2, 17, 3.25, 2.75, 123.456, 0.01, 0.001,
  0.000001, 1200, 62500, 777, 9007199254740991]) neighbors(magnitude, 'ordinary-scalar');

// Known shortest-decimal and integer-rounding stress cases. Input decimal
// literals select binary64 values; expected text still comes only from V8.
const challenging = [
  '0.1', '0.10000000000000002', '0.3', '0.30000000000000004',
  '0.84551240822557006', '1.0000000000000001', '1.0000000000000002',
  '1.2345678', '1.23456789012345', '1.234567890123456',
  '1.2345678901234567', '1.2345678901234568',
  '9007199254740991', '9007199254740992', '9007199254740993',
  '9007199254740994', '1000000000000000128', '1000000000000000300',
  '295147905179352830000', '999999999999999900000',
  '1.2345678901234568e20', '1e23', '1.0000000000000003e-6',
  '2.2250738585072014e-308', '2.2250738585072012e-308',
  '2.225073858507201e-308', '1.7976931348623157e308',
  '5e-324', '4.9406564584124654e-324',
];
for (const decimal of challenging) neighbors(Number(decimal), 'shortest-stress');

// Every finite nonzero decimal power representable by this parser, and every
// binary power, with adjacent patterns for both signs and all exponent sizes.
for (let exponent = -323; exponent <= 308; exponent++) {
  neighbors(Number(`1e${exponent}`), 'decimal-power');
}
for (let exponent = -1074; exponent <= 1023; exponent++) {
  neighbors(2 ** exponent, 'binary-power', 1);
}

// Fixed xorshift64 seed: reproducible coverage across signs, exponents and
// significands. A second stream projection targets ordinary fixed-point
// magnitudes without decimal scaling or rounding in the reference generator.
let state = 0x9e3779b97f4a7c15n;
for (let i = 0; i < 8192; i++) {
  state ^= (state << 13n) & MASK;
  state ^= state >> 7n;
  state ^= (state << 17n) & MASK;
  state &= MASK;
  let raw = state;
  if ((raw & EXPONENT) === EXPONENT) raw ^= 0x0010000000000000n;
  add(raw, 'seeded-finite');
  // Biased exponents 1004..1091 mean |n| in [2^-19, 2^69), wholly inside the
  // fixed-point interval. Fraction bits and signs still come from the seed.
  const ordinary = (state & (SIGN | FRACTION)) | (BigInt(1004 + i % 88) << 52n);
  add(ordinary, 'seeded-ordinary');
}

const cases = [...inputs].map(([input, labels]) => {
  const value = number(BigInt(`0x${input}`));
  return {input, groups: [...labels], string: engine.stringNumber(value), json: engine.jsonNumber(value)};
});
const groupCounts = {};
for (const item of cases) for (const group of item.groups) {
  groupCounts[group] = (groupCounts[group] || 0) + 1;
}
assert(cases.length > 30000, 'nonempty broad binary64 corpus required');
assert.equal(groupCounts['seeded-finite'], 8192);
assert.equal(groupCounts['seeded-ordinary'], 8192);

// The native reader compares these full bytes to its compile-time snapshot;
// --check independently recomputes every digest and expected engine wire.
const files = [
  'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json',
  'src/lib.rs', 'src/utils/mod.rs', 'src/utils/js_compat.rs', 'src/utils/js_string.rs',
  'src/utils/json_number.rs', 'src/utils/lossless_json.rs',
  'tests/json_number_parity.rs', 'tests/fixtures/json_number_reference.cjs',
];
const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const hashes = Object.fromEntries(files.map(file => [file, sha(sources[file])]));
const nativeHashes = Object.fromEntries(files.filter(file => file.endsWith('.rs')).map(file => [file, hashes[file]]));
const tsPackagePath = require.resolve('typescript/package.json');
const tsCompilerPath = require.resolve('typescript');
const tsPackageSource = fs.readFileSync(tsPackagePath, 'utf8');
assert.equal(JSON.parse(tsPackageSource).version, ts.version);
const metadata = {
  schema: 1,
  oracle: 'actual String(binary64) and JSON.stringify(binary64)',
  node: {version: process.version, v8: process.versions.v8,
    executable: fs.realpathSync(process.execPath), sha256: sha(fs.readFileSync(process.execPath))},
  typescript: {version: ts.version, packagePath: tsPackagePath,
    packageSource: tsPackageSource, packageSha256: sha(tsPackageSource),
    compilerPath: tsCompilerPath, compilerSha256: sha(fs.readFileSync(tsCompilerPath))},
  reference: {source: engineSource, sourceSha256: sha(engineSource),
    emitted: compiled.outputText, emittedSha256: sha(compiled.outputText), diagnostics: []},
  hashes, nativeHashes,
  count: cases.length, groupCounts,
  generator: {seed: '9e3779b97f4a7c15', algorithm: 'xorshift64-13-7-17',
    randomCount: 8192, decimalExponents: [-323, 308], binaryExponents: [-1074, 1023]},
};
const output = JSON.stringify({metadata, sources, cases}, null, 2) + '\n';
if (mode === '--write') {
  // Parent creates the task-owned directory; this file is exclusively created.
  fs.writeFileSync(destination, output, {flag: 'wx'});
} else {
  const actual = fs.readFileSync(destination, 'utf8');
  assert(actual.length > 0, 'empty oracle fixture');
  assert.equal(actual, output, 'stale fixture, provenance, generator or engine wire');
}
