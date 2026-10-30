'use strict';
// Run only in a frozen, isolated snapshot with the pinned Node binary:
// node tests/fixtures/lossless_json_document_reference.cjs --write|--check ABSOLUTE_EXTERNAL_DIR
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') {
  throw new Error(`unexpected Node/V8: ${process.version} / ${process.versions.v8}`);
}
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const checkout = path.dirname(root);
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dir && path.isAbsolute(dir) && !extra.length,
  'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
assert(fs.lstatSync(dir).isDirectory(), 'existing non-symlink directory required');
assert.equal(fs.realpathSync(dir), dir, 'directory must be canonical without symlinks');
assert(dir !== checkout && !dir.startsWith(checkout + path.sep), 'directory must be outside checkout');
const filename = 'lossless-json-document-reference.json';
const target = path.join(dir, filename);
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [filename]);
if (mode === '--check') {
  assert(fs.lstatSync(target).isFile(), 'fixture must be a regular non-symlink file');
  assert.equal(fs.realpathSync(target), target, 'fixture must be canonical');
}
assert(path.isAbsolute(process.execPath) && fs.lstatSync(process.execPath).isFile(), 'Node must be a regular file');
assert.equal(fs.realpathSync(process.execPath), process.execPath, 'Node path must be canonical');
assert(process.execPath !== checkout && !process.execPath.startsWith(checkout + path.sep), 'Node must be outside checkout');
const files = [
  'src/utils/lossless_json_document.rs', 'src/utils/lossless_json_view.rs',
  'src/utils/lossless_json.rs', 'src/utils/js_string.rs', 'src/utils/json_number.rs', 'src/utils/mod.rs',
  'tests/lossless_json_document.rs', 'tests/support/sha256.rs',
  'tests/fixtures/lossless_json_document_reference.cjs',
  'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nodeSha256 = sha(fs.readFileSync(process.execPath));
assert.equal(nodeSha256, '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108', 'pinned Node binary');
const cases = [];
function add(label, raw, depth = 0, expectedNativeCanonical = null) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    cases.push({label, depth, raw, stage: 'parse', error: error.name,
      canonical: null, expectedNativeCanonical: null});
    return;
  }
  try {
    const canonical = JSON.stringify(parsed);
    cases.push({label, depth, raw, stage: 'complete', error: null,
      canonical, expectedNativeCanonical: null});
  } catch (error) {
    if (!(error instanceof RangeError) || expectedNativeCanonical === null) throw error;
    // This records successful parsing but no whole-source V8 stringify result.
    // The caller constructs a separate expected wire from a shallow V8 result
    // and known delimiters for these specific repeated deep structures.
    cases.push({label, depth, raw, stage: 'stringify', error: error.name,
      canonical: null, expectedNativeCanonical});
  }
}
for (const [label, raw] of [
  ['empty', 'null'], ['boolean', 'true'], ['negative-zero', '-0'],
  ['overflow', '[1e999,-1e999]'], ['underflow', '[-1e-9999,1e-9999]'],
  ['rounding', '[9007199254740993,1.234567890123456789,5e-324]'],
  ['exponents', '[1e21,1e20,1e-6,1e-7]'],
  ['indices', '{"4294967295":0,"2":1,"0":2,"4294967294":3,"01":4,"10":5}'],
  ['duplicates', '{"b":1,"2":2,"a":3,"\\u0032":4,"b":5}'],
  ['lone-surrogates', '{"\\ud800":"\\udc00","\\ud800":"\\ud83d\\ude00"}'],
  ['strings', '["\\u0061\\/\\n","😀","\\u0000","\\u2028"]'],
  ['prototype', '{"__proto__":1,"constructor":2,"__proto__":3}'],
  ['arrays', '[[],{},null,[1,[2]],{"x":[]} ]'],
  ['spaces', ' \t\n { "x" : 1 } \r'],
  ['empty-objects', '{"x":{},"y":[]}'],
  ['invalid-empty', ''], ['invalid-trailing', 'null true'],
  ['invalid-comma', '[1,]'], ['invalid-number', '01'],
  ['invalid-escape', '"\\u12xz"'], ['invalid-bom', '\ufeffnull'],
  ['invalid-key', '{"a":}'],
]) add(label, raw);
// Independent shallow source canonicalization plus the known structure of
// these inputs provides an expected Rust wire if V8 exhausts its stack.
const arrayLeaf = JSON.stringify(JSON.parse('{"x":-0,"x":1e999}'));
const objectLeaf = JSON.stringify(JSON.parse('0'));
for (const depth of [129, 256, 4096]) {
  add(`deep-${depth}`, '['.repeat(depth) + '{"x":-0,"x":1e999}' + ']'.repeat(depth), depth,
    '['.repeat(depth) + arrayLeaf + ']'.repeat(depth));
  add(`deep-objects-${depth}`, '{"x":'.repeat(depth) + '0' + '}'.repeat(depth), depth,
    '{"x":'.repeat(depth) + objectLeaf + '}'.repeat(depth));
  add(`deep-invalid-${depth}`, '['.repeat(depth) + '[1,]' + ']'.repeat(depth), depth);
}
const valid = cases.filter(c => c.stage === 'complete').length;
const invalid = cases.filter(c => c.stage === 'parse').length;
const resourceLimited = cases.filter(c => c.stage === 'stringify').length;
const output = {
  node: process.version, v8: process.versions.v8,
  nodeSha256,
  hashes: Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(root, file)))])),
  count: cases.length, valid, invalid, resourceLimited, cases,
};
const bytes = JSON.stringify(output) + '\n';
if (mode === '--write') fs.writeFileSync(target, bytes, {flag: 'wx'});
else assert.equal(fs.readFileSync(target, 'utf8'), bytes, 'deterministic fixture recheck');
console.log(`sha256=${sha(bytes)} count=${cases.length} valid=${valid} invalid=${invalid} resourceLimited=${resourceLimited}`);
