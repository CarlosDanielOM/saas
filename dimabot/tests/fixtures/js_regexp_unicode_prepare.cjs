#!/usr/bin/env node
'use strict';

// Execute only with the pinned Node binary and an explicit read-only source
// snapshot. No application imports, npm packages, network, or production data.
// --write requires an existing empty external directory; --check compares the
// exact two artifacts without writing. All checks finish before artifact writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
if (process.env.DIMA_JS_REGEXP_NODE_SHA256 !== undefined) {
  assert.equal(process.env.DIMA_JS_REGEXP_NODE_SHA256, nodeSha, 'wrong requested Node pin');
}
assert.equal(sha256(fs.readFileSync(process.execPath)), nodeSha, 'wrong Node executable');
const versions = { node: '24.22.1', v8: '13.6.233.17-node.58', icu: '78.3', unicode: '17.0' };
for (const [key, value] of Object.entries(versions)) {
  assert.equal(process.versions[key], value, `wrong ${key} version`);
}

const rootArg = process.env.DIMA_JS_REGEXP_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg), 'absolute DIMA_JS_REGEXP_SOURCE_ROOT required');
const root = fs.realpathSync(rootArg);
assert.equal(rootArg, root, 'source root must be canonical');
assert(fs.statSync(root).isDirectory(), 'source root must be a directory');
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dirArg && extra.length === 0,
  'usage: --write|--check ABSOLUTE_EXTERNAL_DIRECTORY');
assert(path.isAbsolute(dirArg), 'output directory must be absolute');
const dir = fs.realpathSync(dirArg);
assert.equal(dirArg, dir, 'output directory must be canonical');
assert(fs.statSync(dir).isDirectory(), 'output must be a directory');
assert(dir !== root && !dir.startsWith(root + path.sep), 'output must be external to source root');
const names = ['js-regexp-unicode-reference.json', 'js_regexp_unicode_data.rs'];
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [...names].sort(),
  'output directory contents');
if (mode === '--check') {
  for (const name of names) {
    assert(fs.lstatSync(path.join(dir, name)).isFile(), 'artifact must be a regular file');
  }
}

const read = relative => {
  const resolved = fs.realpathSync(path.join(root, relative));
  assert(resolved.startsWith(root + path.sep), `input escaped source root: ${relative}`);
  assert(fs.statSync(resolved).isFile(), `input must be a file: ${relative}`);
  return fs.readFileSync(resolved);
};
const helperPath = 'src/utils/js_regexp_unicode.rs';
const generatorPath = 'tests/fixtures/js_regexp_unicode_prepare.cjs';
const categoriesPath = 'src/utils/moderation/caps_unicode_data.rs';
const foldingPath = 'tests/fixtures/unicode-17.0.0/CaseFolding.txt';
const licensePath = 'tests/fixtures/unicode-17.0.0/LICENSE.txt';
const sourcePaths = [helperPath, generatorPath, categoriesPath, foldingPath, licensePath,
  'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'];
const manifestPath = 'tests/fixtures/unicode-17.0.0/source-manifest.json';
if (fs.existsSync(path.join(root, manifestPath))) sourcePaths.push(manifestPath);
const inputs = Object.fromEntries(sourcePaths.map(relative => [relative, read(relative)]));
assert.deepEqual(inputs[generatorPath], fs.readFileSync(__filename),
  'executing generator differs from source snapshot');
assert.equal(sha256(inputs[foldingPath]),
  'ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183',
  'wrong Unicode CaseFolding.txt');
assert.equal(sha256(inputs[licensePath]),
  'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96',
  'wrong Unicode license');
const hashes = Object.fromEntries(sourcePaths.map(relative => [relative, sha256(inputs[relative])]));

const scalarCount = 0x110000; // Includes the 2,048 lone-surrogate code point values.
const isScalar = cp => Number.isInteger(cp) && cp >= 0 && cp < scalarCount
  && !(cp >= 0xd800 && cp <= 0xdfff);
const simpleFoldMappings = [];
for (const line of inputs[foldingPath].toString('utf8').split(/\r?\n/)) {
  const data = line.split('#', 1)[0].trim();
  if (!data) continue;
  const match = /^([0-9A-F]+);\s*([CFST]);\s*([0-9A-F]+(?:\s+[0-9A-F]+)*);$/.exec(data);
  assert(match, `malformed CaseFolding row: ${data}`);
  if (match[2] !== 'C' && match[2] !== 'S') continue;
  const targets = match[3].trim().split(/\s+/).map(value => parseInt(value, 16));
  assert.equal(targets.length, 1, 'simple fold must have exactly one target');
  const source = parseInt(match[1], 16), target = targets[0];
  assert(isScalar(source) && isScalar(target) && source !== target, 'invalid simple fold pair');
  simpleFoldMappings.push([source, target]);
}
simpleFoldMappings.sort(([a], [b]) => a - b);
assert.equal(simpleFoldMappings.length, 1512, 'Unicode simple folding pair count changed');
assert.equal(simpleFoldMappings.filter(([source]) => source <= 0x7f).length, 26,
  'ASCII simple folding pair count changed');
const fold = new Map();
for (const [source, target] of simpleFoldMappings) {
  assert(!fold.has(source), 'duplicate simple fold source');
  fold.set(source, target);
}
for (const [source, target] of simpleFoldMappings) {
  assert.equal(fold.get(target) ?? target, target, 'simple folding must be idempotent');
  if (source <= 0x7f) {
    assert(source >= 0x41 && source <= 0x5a && target === source + 0x20,
      'ASCII fast path differs from Unicode data');
  }
  // Hex escapes avoid interpreting source data as regex syntax. Anchors and a
  // one-code-point subject verify actual ECMAScript /iu equivalence both ways.
  const sourcePattern = new RegExp(`^\\u{${source.toString(16)}}$`, 'iu');
  const targetPattern = new RegExp(`^\\u{${target.toString(16)}}$`, 'iu');
  assert(sourcePattern.test(String.fromCodePoint(target)), `Node rejected fold U+${source.toString(16)}`);
  assert(targetPattern.test(String.fromCodePoint(source)), `Node rejected reverse fold U+${source.toString(16)}`);
}

function parseRanges(name) {
  const text = inputs[categoriesPath].toString('utf8');
  const pattern = new RegExp(`\\bstatic\\s+${name}:\\s*&\\[\\(u32,\\s*u32\\)\\]\\s*=\\s*&\\[([\\s\\S]*?)\\];`, 'g');
  const tables = [...text.matchAll(pattern)];
  assert.equal(tables.length, 1, `expected exactly one ${name} table`);
  const body = tables[0][1];
  const row = /\(\s*0x([0-9A-Fa-f]+),\s*0x([0-9A-Fa-f]+)\s*\),/g;
  const ranges = [...body.matchAll(row)].map(match => [parseInt(match[1], 16), parseInt(match[2], 16)]);
  assert.equal(body.replace(row, '').trim(), '', `unparsed ${name} data`);
  assert(ranges.length > 0, `empty ${name}`);
  let previous = -2;
  for (const [start, end] of ranges) {
    assert(isScalar(start) && isScalar(end) && start <= end, `invalid ${name} range`);
    assert(start > previous + 1, `unordered, overlapping, or non-maximal ${name} ranges`);
    assert(end < 0xd800 || start > 0xdfff, `surrogate in ${name}`);
    previous = end;
  }
  return ranges;
}
function contains(ranges, cp) {
  let lo = 0, hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid][1] < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo][0] <= cp;
}
function add(ranges, cp) {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === cp - 1) last[1] = cp;
  else ranges.push([cp, cp]);
}

const existingLetterRanges = parseRanges('LETTER_RANGES');
const existingUppercaseRanges = parseRanges('UPPERCASE_RANGES');
const letterRanges = [], uppercaseRanges = [], numberRanges = [];
const letter = /^\p{L}$/u, uppercase = /^\p{Lu}$/u, number = /^\p{N}$/u;
const boundary = /^[\p{L}\p{N}]$/iu;
let boundaryScalarCount = 0;
for (let cp = 0; cp < scalarCount; cp++) {
  const input = String.fromCodePoint(cp);
  const l = letter.test(input), lu = uppercase.test(input), n = number.test(input);
  if (l) add(letterRanges, cp);
  if (lu) add(uppercaseRanges, cp);
  if (n) add(numberRanges, cp);
  assert.equal(contains(existingLetterRanges, cp), l, `LETTER_RANGES differs at U+${cp.toString(16)}`);
  assert.equal(contains(existingUppercaseRanges, cp), lu, `UPPERCASE_RANGES differs at U+${cp.toString(16)}`);
  const canonical = fold.get(cp) ?? cp;
  const canonicalInput = String.fromCodePoint(canonical);
  assert.equal(boundary.test(input), letter.test(canonicalInput) || number.test(canonicalInput),
    `/iu L/N boundary differs at U+${cp.toString(16)}`);
  boundaryScalarCount++;
  if (cp >= 0xd800 && cp <= 0xdfff) {
    assert(!l && !lu && !n && !boundary.test(input), 'surrogates must not classify');
    assert.equal(canonical, cp, 'surrogates must not fold');
  }
}
assert.deepEqual(letterRanges, existingLetterRanges, 'letter ranges must be maximal');
assert.deepEqual(uppercaseRanges, existingUppercaseRanges, 'uppercase ranges must be maximal');
assert(!letter.test('\u0345') && letter.test('\u03b9') && boundary.test('\u0345'),
  'combining ypogegrammeni must become a letter only after simple folding');
assert.equal(fold.get(0x0345), 0x03b9);
assert.equal(boundaryScalarCount, scalarCount);

const rustTable = (name, rows) => `pub(crate) static ${name}: &[(u32, u32)] = &[\n`
  + rows.map(([a, b]) => `    (0x${a.toString(16).toUpperCase()}, 0x${b.toString(16).toUpperCase()}),\n`).join('')
  + '];\n';
let rust = '// Generated by tests/fixtures/js_regexp_unicode_prepare.cjs; do not edit.\n';
rust += '// Unicode 17.0.0 simple folding (C/S only) and Node raw general category N.\n';
rust += '// Node 24.22.1; V8 13.6.233.17-node.58; ICU 78.3; Unicode 17.0.\n';
rust += '// CaseFolding data: Copyright 2025 Unicode, Inc.\n';
rust += '// Unicode License V3: Copyright 1991-2026 Unicode, Inc.\n';
rust += '// Associated license: ../../tests/fixtures/unicode-17.0.0/LICENSE.txt\n';
rust += '// https://www.unicode.org/license.txt\n\n';
rust += rustTable('NUMBER_RANGES', numberRanges) + '\n';
rust += rustTable('SIMPLE_FOLD_MAPPINGS', simpleFoldMappings);
const result = {
  format: 1,
  nodeSha,
  versions,
  hashes,
  letterRanges,
  uppercaseRanges,
  numberRanges,
  simpleFoldMappings,
  checks: { scalarCount, pairCount: simpleFoldMappings.length, boundaryScalarCount },
  generatedRustSha256: sha256(rust),
};
const artifacts = {
  'js-regexp-unicode-reference.json': JSON.stringify(result, null, 2) + '\n',
  'js_regexp_unicode_data.rs': rust,
};
for (const name of names) {
  const output = path.join(dir, name);
  if (mode === '--write') fs.writeFileSync(output, artifacts[name], { flag: 'wx' });
  else assert.equal(fs.readFileSync(output, 'utf8'), artifacts[name], `${name} differs`);
  console.log(`${name} sha256=${sha256(artifacts[name])}`);
}
console.log(JSON.stringify(result.checks));
