#!/usr/bin/env node
'use strict';

// Author-only until executed by the lead in the isolated pinned Node runtime.
// Extract facts from pinned C++ tables, then check them against the actual SDK.
// Never uses ECMAScript property/folding behavior as the engine oracle.
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && !extra.length,
  'usage: --write|--check ABSOLUTE_EMPTY_EXTERNAL_DIRECTORY');
assert(path.isAbsolute(directory), 'absolute output directory required');
const dir = fs.realpathSync(directory);
assert.equal(directory, dir, 'canonical output directory required');
assert(fs.statSync(dir).isDirectory(), 'output must be a directory');
const rootArg = process.env.DIMA_ADVANCED_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg), 'absolute source snapshot required');
const root = fs.realpathSync(rootArg);
assert.equal(rootArg, root, 'canonical source snapshot required');
assert(dir !== root && !dir.startsWith(root + path.sep), 'external output directory required');
const artifactNames = ['re2-unicode-reference.json', 're2_unicode_data.rs'];
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [...artifactNames].sort());
if (mode === '--check') for (const name of artifactNames) {
  assert(fs.lstatSync(path.join(dir, name)).isFile(), 'regular artifact files required');
}
assert(process.env.DIMA_ADVANCED_RE2_FIXTURE_ROOT, 'explicit Node24 SDK source-build fixture required');
// The shared loader checks the actual Node executable and all version pins,
// full installed/fixture source sets and every manifest hash (1,762 SDK files),
// source-build provenance, compiler image, addon binary hash, and TypeScript.
const loaderPath = 'tests/fixtures/moderation_advanced_source.cjs';
assert.deepEqual(fs.readFileSync(path.join(root, 'tests/fixtures/re2_unicode_prepare.cjs')),
  fs.readFileSync(__filename), 'executing generator differs from snapshot');
const sdk = require(path.join(root, loaderPath));
assert.equal(sdk.root, root);
const { RE2 } = sdk;
assert.equal(sdk.re2Runtime.kind, 'node24-fixture');
assert.equal(sdk.re2Runtime.sourceFileCount, 1762);
assert.equal(sdk.re2Runtime.loadedBinarySha256, '94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb');
assert.equal(sdk.re2Runtime.sourceManifestSha256, 'e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664');
assert.equal(sdk.re2Runtime.buildProvenanceSha256, '4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c');
const sourcePins = {
  'lib/unicode_properties.h': '3c4a4a9242a84178a2fb0fa42c406ba9781894b09814e21825c4c5e6dccdb212',
  'lib/pattern.cc': 'ed747fc232e06031ff23cc1941d605a92ee9b851b3a15e20755e6000b789d462',
  'vendor/re2/re2/unicode_groups.cc': 'e00735cd8ba1f87ea5c0c78c07de7836e9ad02cc84f4ef8cf90e2b0edfd99e68',
  'vendor/re2/re2/unicode_groups.h': '42fd7852174d43570684f904c5ecd6f086bf81acd89d2d7ab97b15358380b9c5',
  'vendor/re2/re2/unicode_casefold.cc': 'e2fcd199b8cee45ac053c26e55a810756c530060e90c2ab267513adb4bfdb707',
  'vendor/re2/re2/unicode_casefold.h': 'd256539dd13c70d6947261fa4cd763b80068ef51e9cf3cf53439ad7601ec6a09',
  'vendor/re2/re2/parse.cc': '11c28b05ed5563dce8a539f0074f94637e82f7fa12137924a175eeb3bd0ab9d1',
  'LICENSE': 'be313c76b0c1c0d771c4c00251efe1083386b80736b35f52b3926ad1eb1b145c',
  'vendor/re2/LICENSE': '6040cda75d90b1738292a631d89934c411ef7ffd543c4d6a1b7edfc8edf29449',
};
const source = {};
for (const [name, expected] of Object.entries(sourcePins)) {
  const bytes = sdk.read('node_modules/re2/' + name);
  assert.equal(sha(bytes), expected, name);
  source[name] = bytes.toString('utf8');
}
const readPaths = [loaderPath, 'tests/fixtures/re2_unicode_prepare.cjs',
  'tests/re2_unicode.rs', 'tests/support/sha256.rs', 'src/utils/re2_unicode.rs',
  'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
  'tests/fixtures/re2-source-licenses/node-re2-BSD-3-Clause.txt',
  'tests/fixtures/re2-source-licenses/RE2-BSD-3-Clause.txt',
  'tests/fixtures/re2-source-licenses/Unicode-LICENSE.txt'];
const hashes = Object.fromEntries(readPaths.map(name => [name, sha(sdk.read(name))]));
assert.equal(hashes[readPaths[8]], sourcePins.LICENSE);
assert.equal(hashes[readPaths[9]], sourcePins['vendor/re2/LICENSE']);
assert.equal(hashes[readPaths[10]], 'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96');
const once = (text, expression, label) => {
  const all = [...text.matchAll(expression)];
  assert.equal(all.length, 1, `exactly one ${label} required`);
  return all[0][1];
};
const scalar = cp => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff
  && !(cp >= 0xd800 && cp <= 0xdfff);
function validateRanges(ranges, label) {
  let prev = -1;
  for (const [lo, hi] of ranges) {
    assert(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi <= 0x10ffff && lo <= hi,
      `invalid raw code point range ${label}`);
    assert(lo > prev, `overlapping or unsorted ranges ${label}`); prev = hi;
  }
  return ranges;
}
function rangeArrays(text, expression, numeric, label) {
  const arrays = new Map();
  for (const m of text.matchAll(expression)) {
    assert(!arrays.has(m[1]), `duplicate ${label} table`);
    const row = /\{\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*\},/g;
    const ranges = [...m[2].matchAll(row)].map(r => [Number(r[1]), Number(r[2])]);
    assert.equal(m[2].replace(row, '').trim(), '', `unparsed ${label} ${m[1]}`);
    if (numeric === 16) assert(ranges.every(([, hi]) => hi <= 0xffff));
    arrays.set(m[1], validateRanges(ranges, m[1]));
  }
  assert(arrays.size > 0, `missing ${label} arrays`); return arrays;
}
const nativeText = source['vendor/re2/re2/unicode_groups.cc'];
const native16 = rangeArrays(nativeText, /static const URange16 (\w+)\[\] = \{([\s\S]*?)\n\};/g, 16, 'native16');
const native32 = rangeArrays(nativeText, /static const URange32 (\w+)\[\] = \{([\s\S]*?)\n\};/g, 32, 'native32');
const wrapperText = source['lib/unicode_properties.h'];
const wrapper = rangeArrays(wrapperText, /static const UnicodeRange (\w+)\[\] = \{([\s\S]*?)\n\};/g, 32, 'wrapper');
const nativeBody = once(nativeText, /const UGroup unicode_groups\[\] = \{([\s\S]*?)\n\};/g, 'native group list');
const nativeRow = /\{\s*"([^"]+)"\s*,\s*\+1\s*,\s*(\w+)\s*,\s*(\d+)\s*,\s*(\w+)\s*,\s*(\d+)\s*\},/g;
const builtin = [...nativeBody.matchAll(nativeRow)].map(m => {
  const part = (arrays, name, count) => {
    if (name === '0') { assert.equal(Number(count), 0); return []; }
    assert(arrays.has(name), `missing native range table ${name}`);
    const ranges = arrays.get(name); assert.equal(ranges.length, Number(count)); return ranges;
  };
  return { name: m[1], ranges: validateRanges([...part(native16, m[2], m[3]), ...part(native32, m[4], m[5])], m[1]) };
});
assert.equal(nativeBody.replace(nativeRow, '').trim(), '', 'unparsed native group row');
assert.equal(builtin.length, 199);
assert.equal(once(nativeText, /const int num_unicode_groups = (\d+);/g, 'native count'), '199');
// parse.cc's special native Any is not one of the 199 generated groups.
assert(source['vendor/re2/re2/parse.cc'].includes('static UGroup anygroup = { "Any", +1, any16, 1, any32, 1 };'));
builtin.push({ name: 'Any', ranges: [[0, 65535], [65536, 0x10ffff]] });
function wrapperGroups(name, expectedCount) {
  const body = once(wrapperText, new RegExp(`static const UnicodePropertyTable ${name}\\[\\] = \\{([\\s\\S]*?)\\n\\};`, 'g'), name);
  const row = /\{"([^"]+)",\s*(\w+),\s*(\d+)\},/g;
  const entries = [...body.matchAll(row)].map(m => {
    const ranges = wrapper.get(m[2]); assert(ranges, `missing wrapper table ${m[2]}`);
    assert.equal(ranges.length, Number(m[3])); return { name: m[1], ranges };
  });
  assert.equal(body.replace(row, '').trim(), '', `unparsed ${name}`);
  assert.equal(entries.length, expectedCount); return entries;
}
const binary = wrapperGroups('kBinaryProperties', 98);
const scriptExtensions = wrapperGroups('kScriptExtensions', 342);
const aliasBody = once(source['lib/pattern.cc'], /unicodeClasses = \{([\s\S]*?)\n\};/g, 'category aliases');
const aliasRow = /\{"([^"]+)",\s*"([^"]+)"\},/g;
const categoryAliases = [...aliasBody.matchAll(aliasRow)].map(m => [m[1], m[2]]);
assert.equal(aliasBody.replace(aliasRow, '').trim(), '', 'unparsed aliases');
assert.equal(categoryAliases.length, 38);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
for (const entries of [builtin, binary, scriptExtensions]) {
  entries.sort((a, b) => order(a.name, b.name));
  assert.equal(new Set(entries.map(x => x.name)).size, entries.length, 'duplicate property name');
}
categoryAliases.sort((a, b) => order(a[0], b[0]));
assert.equal(new Set(categoryAliases.map(x => x[0])).size, 38);
const foldText = source['vendor/re2/re2/unicode_casefold.cc'];
const foldBody = once(foldText, /const CaseFold unicode_casefold\[\] = \{([\s\S]*?)\n\};/g, 'casefold');
const foldRow = /\{\s*(\d+),\s*(\d+),\s*(-?\d+|EvenOdd|OddEven|EvenOddSkip|OddEvenSkip)\s*\},/g;
const sentinels = { EvenOdd: 1, OddEven: -1, EvenOddSkip: 1073741824, OddEvenSkip: 1073741825 };
const foldRanges = [...foldBody.matchAll(foldRow)].map(m => [Number(m[1]), Number(m[2]), sentinels[m[3]] ?? Number(m[3])]);
assert.equal(foldBody.replace(foldRow, '').trim(), '', 'unparsed fold data');
assert.equal(foldRanges.length, 372);
assert.equal(once(foldText, /const int num_unicode_casefold = (\d+);/g, 'fold range count'), '372');
assert(foldText.includes('// 1427 groups, 2884 pairs, 372 ranges'));
validateRanges(foldRanges.map(([lo, hi]) => [lo, hi]), 'fold');
const sentinelHeader = source['vendor/re2/re2/unicode_casefold.h'];
assert(/EvenOdd = 1,\s+OddEven = -1,\s+EvenOddSkip = 1<<30,\s+OddEvenSkip,/.test(sentinelHeader));
function apply([lo, , delta], cp) {
  assert(Number.isInteger(delta) && delta >= -2147483648 && delta <= 2147483647);
  switch (delta) {
    case 1073741824: if ((cp - lo) % 2) return cp; // fall through
    case 1: return cp % 2 === 0 ? cp + 1 : cp - 1;
    case 1073741825: if ((cp - lo) % 2) return cp; // fall through
    case -1: return cp % 2 === 1 ? cp + 1 : cp - 1;
    default: return cp + delta;
  }
}
const foldPairs = [], foldMap = new Map();
for (const range of foldRanges) for (let cp = range[0]; cp <= range[1]; cp++) {
  const next = apply(range, cp); assert(scalar(cp) && scalar(next));
  if (next !== cp) { assert(!foldMap.has(cp)); foldMap.set(cp, next); foldPairs.push([cp, next]); }
}
assert.equal(foldPairs.length, 2884);
const visited = new Set(), foldCycles = [];
let foldSdkChecks = 0;
const literal = cp => `\\u{${cp.toString(16)}}`;
for (const [first] of foldPairs) {
  if (visited.has(first)) continue;
  const cycle = []; let cp = first;
  do {
    assert(!visited.has(cp), 'non-disjoint or open fold cycle');
    visited.add(cp); cycle.push(cp); cp = foldMap.get(cp); assert(cp !== undefined);
  } while (cp !== first);
  assert(cycle.length >= 2 && cycle.length <= 4, 'unexpected fold cycle size');
  // Every ordered pair in the cycle, including both directions and reflexivity.
  for (const from of cycle) {
    const expression = new RE2(`^${literal(from)}$`, 'iu');
    for (const to of cycle) { assert(expression.test(String.fromCodePoint(to)), `SDK fold ${from}/${to}`); foldSdkChecks++; }
  }
  foldCycles.push(cycle);
}
assert.equal(foldCycles.length, 1427); assert.equal(visited.size, 2884);
function contains(ranges, cp) {
  let lo = 0, hi = ranges.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid][1] < cp) lo = mid + 1; else hi = mid; }
  return lo < ranges.length && ranges[lo][0] <= cp;
}
let edgeSdkChecks = 0;
const propertyChecks = [];
// Script= explicitly takes the native branch, avoiding wrapper Any precedence.
for (const [namespace, entries, spellings] of [
  ['builtin', builtin, name => [`Script=${name}`, `sc=${name}`, name]],
  ['binary', binary, name => [name, `gc=${name}`, `General_Category=${name}`]],
  ['scriptExtensions', scriptExtensions, name => [`Script_Extensions=${name}`, `scx=${name}`]],
]) for (const { name, ranges } of entries) {
  const points = new Set([0, 0x10ffff]);
  for (const [lo, hi] of ranges) for (const cp of [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1]) if (scalar(cp)) points.add(cp);
  const ordered = [...points].sort((a, b) => a - b), checks = [];
  for (const spelling of spellings(name)) {
    const expression = new RE2(`^\\p{${spelling}}$`, 'u');
    const negative = new RE2(`^\\P{${spelling}}$`, 'u');
    for (const cp of ordered) {
      const expected = contains(ranges, cp), text = String.fromCodePoint(cp);
      assert.equal(expression.test(text), expected, `${namespace} ${spelling} U+${cp.toString(16)}`);
      assert.equal(negative.test(text), !expected, `negative ${namespace} ${spelling} U+${cp.toString(16)}`);
      edgeSdkChecks += 2;
    }
    checks.push(spelling);
  }
  propertyChecks.push({ namespace, name, spellings: checks, points: ordered });
}
const tables = { builtin, binary, scriptExtensions };
const maps = Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, new Map(rows.map(x => [x.name, x]))]));
const aliases = new Map(categoryAliases);
const strip = (name, prefixes) => prefixes.map(prefix => name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null).find(x => x !== null);
function resolve(name) {
  const scx = strip(name, ['Script_Extensions=', 'scx=']);
  if (scx && maps.scriptExtensions.has(scx)) return ['scriptExtensions', scx, false];
  name = strip(name, ['General_Category=', 'gc=']) ?? name;
  if (maps.binary.has(name)) return ['binary', name, false];
  name = aliases.get(name) ?? strip(name, ['Script=', 'sc=']) ?? name;
  const inverted = name.startsWith('^'); if (inverted) name = name.slice(1);
  return maps.builtin.has(name) ? ['builtin', name, inverted] : null;
}
const resolutionNames = new Set(['L', 'Lu', 'N', 'Cs', '^L', '^Letter', 'gc=^L', 'Script=^L',
  'Script=Letter', 'Script=Latn', 'sc=Latn', 'script=Latin', 'scx=Latn', 'Script_Extensions=Tolong_Siki',
  'Tolong_Siki', 'Script=Tolong_Siki', 'gc=', 'Script=', 'scx=', '', 'letter', 'Alphabetic', 'alphabetic']);
for (const [alias] of categoryAliases) for (const prefix of ['', 'gc=', 'General_Category=']) resolutionNames.add(prefix + alias);
for (const check of propertyChecks) for (const spelling of check.spellings) resolutionNames.add(spelling);
const resolutionChecks = [];
for (const name of [...resolutionNames].sort()) {
  const expected = resolve(name); let expression, negative;
  try { expression = new RE2(`^\\p{${name}}$`, 'u'); negative = new RE2(`^\\P{${name}}$`, 'u'); }
  catch (e) { assert.equal(expected, null, `unexpected SDK rejection ${name}: ${e.message}`); resolutionChecks.push({ name, expected }); continue; }
  assert(expected, `unexpected SDK acceptance ${name}`);
  const [namespace, resolvedName, inverted] = expected;
  const ranges = maps[namespace].get(resolvedName).ranges;
  for (const cp of [0, 0x41, 0x61, 0x30, 0x3b1, 0x11db0, 0x10ffff]) {
    const yes = contains(ranges, cp) !== inverted;
    assert.equal(expression.test(String.fromCodePoint(cp)), yes, `resolved ${name}`);
    assert.equal(negative.test(String.fromCodePoint(cp)), !yes, `resolved negative ${name}`);
  }
  resolutionChecks.push({ name, expected });
}
const exhaustive = process.env.DIMA_RE2_UNICODE_EXHAUSTIVE ?? '1';
assert(['0', '1'].includes(exhaustive));
let exhaustiveSdkChecks = 0;
if (exhaustive === '1') for (const name of ['L', 'N', 'Lu']) {
  const ranges = maps.builtin.get(name).ranges, expression = new RE2(`^\\p{${name}}$`, 'u');
  for (let cp = 0; cp <= 0x10ffff; cp++) if (scalar(cp)) {
    assert.equal(expression.test(String.fromCodePoint(cp)), contains(ranges, cp), `${name} U+${cp.toString(16)}`);
    exhaustiveSdkChecks++;
  }
}
// Regression guards that exposed the native/wrapper Unicode provenance split.
for (const cp of [0x11db0, 0xa7cb, 0x1c8a]) assert(!new RE2('^\\pL$', 'u').test(String.fromCodePoint(cp)));
assert(!new RE2('^\\u{264}$', 'iu').test(String.fromCodePoint(0xa7cb)));
const lines = ['// GENERATED by tests/fixtures/re2_unicode_prepare.cjs; DO NOT EDIT.',
  '// node-RE2 1.27.0 native + wrapper facts; see re2-source-licenses/.',
  '// Native Unicode version unspecified; wrapper header declares 17.0.0.'];
const emitted = new Map(); let nextId = 0;
function rangeId(ranges) {
  const key = JSON.stringify(ranges); if (emitted.has(key)) return emitted.get(key);
  const id = `R${nextId++}`; emitted.set(key, id);
  lines.push(`static ${id}: &[(u32, u32)] = &[`);
  for (const [lo, hi] of ranges) lines.push(`    (0x${lo.toString(16)}, 0x${hi.toString(16)}),`);
  lines.push('];'); return id;
}
for (const [key, entries] of Object.entries(tables)) {
  const rows = entries.map(({ name, ranges }) => [name, rangeId(ranges)]);
  const constant = { builtin: 'BUILTIN', binary: 'BINARY', scriptExtensions: 'SCRIPT_EXTENSIONS' }[key];
  lines.push(`pub(super) static ${constant}: &[(&str, &[(u32, u32)])] = &[`);
  for (const [name, id] of rows) lines.push(`    (${JSON.stringify(name)}, ${id}),`);
  lines.push('];');
}
lines.push('pub(super) static CATEGORY_ALIASES: &[(&str, &str)] = &[');
for (const [name, value] of categoryAliases) lines.push(`    (${JSON.stringify(name)}, ${JSON.stringify(value)}),`);
lines.push('];', 'pub(super) static CASE_FOLD: &[(u32, u32, i32)] = &[');
for (const [lo, hi, delta] of foldRanges) lines.push(`    (${lo}, ${hi}, ${delta}),`);
lines.push('];', '');
const rust = Buffer.from(lines.join('\n'));
const fixture = Buffer.from(JSON.stringify({ format: 1, sdkVersion: '1.27.0',
  nativeUnicodeVersion: null, wrapperUnicodeVersion: '17.0.0', nodeSha: sdk.nodeSha,
  versions: { node: process.versions.node, v8: process.versions.v8, icu: process.versions.icu,
    unicode: process.versions.unicode, modules: process.versions.modules },
  runtime: sdk.re2Runtime, sourcePins, hashes, generatedRustSha256: sha(rust),
  tables, categoryAliases, foldRanges, foldPairs, foldCycles, propertyChecks, resolutionChecks,
  checks: { nativeGeneratedNames: 199, nativeSpecialNames: 1, binaryNames: 98,
    scriptExtensionNames: 342, categoryAliases: 38, foldRanges: 372, foldPairs: 2884,
    foldCycles: 1427, foldSdkChecks, edgeSdkChecks, exhaustiveSdkChecks,
    exhaustiveCategories: exhaustive === '1', rawCodePointValues: 0x110000,
    engineComparableScalars: 0x110000 - 2048, surrogateEngineComparisons: 0 },
}, null, 2) + '\n');
const artifacts = { 're2-unicode-reference.json': fixture, 're2_unicode_data.rs': rust };
for (const [name, bytes] of Object.entries(artifacts)) {
  if (mode === '--write') fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
  else assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes, name);
}
process.stdout.write(JSON.stringify({ mode, artifacts: Object.fromEntries(Object.entries(artifacts)
  .map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])),
  foldSdkChecks, edgeSdkChecks, exhaustiveSdkChecks }) + '\n');
