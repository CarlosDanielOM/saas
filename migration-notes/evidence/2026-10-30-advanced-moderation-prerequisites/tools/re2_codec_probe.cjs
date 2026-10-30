'use strict';
// Run only in the pinned isolated Node image. No predicted codec is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const required = name => { const value = process.env[name]; assert(value, `${name} is required`); return value; };
const binary = required('DIMA_RE2_CODEC_PROBE_BINARY');
const expected = required('DIMA_RE2_CODEC_PROBE_SHA256');
assert.match(expected, /^[a-f0-9]{64}$/);
assert.equal(hashFile(binary), expected, 'probe binary SHA-256');
assert.equal(process.versions.node, '24.22.1');
assert.equal(process.versions.modules, '137');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(process.versions.icu, '78.3');
assert.equal(process.versions.unicode, '17.0');
assert.equal(hashFile(process.execPath), '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108', 'Node binary SHA-256');
const sdkRoot = required('DIMA_RE2_CODEC_RE2_ROOT');
const sdkFiles = {
  'package.json': '3bc12f3e008781cd558c278365bcc3373aaf6ff0aed18e645f3a8e53e6d5c0db',
  'lib/addon.cc': '947db392a87d64bd1200e522b664986a1b25e38c96d439c64c7fbd6f7b3d0bd6',
  'lib/wrapped_re2.h': 'e4b3f23eb963f07d765d8e7ea3ebc650be81e02b782aeceda0fd2c72435e2f28',
  'lib/new.cc': 'dcee6f77b7cd82af66f94a66bfb757a5266273fd954e68f97f6e3a5a423a8317',
};
for (const [file, expectedHash] of Object.entries(sdkFiles)) assert.equal(hashFile(path.join(sdkRoot, file)), expectedHash, file);
assert.equal(JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'))).version, '1.27.0');
const probe = require(path.resolve(binary));
const cppHash = hashFile(path.join(__dirname, 're2_codec_probe.cc'));
const jsHash = hashFile(__filename);
const sdkBinary = path.join(sdkRoot, 'build/Release/re2.node');
const sdkExpected = required('DIMA_RE2_CODEC_RE2_SHA256');
assert.equal(sdkExpected, '94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb');
assert.equal(hashFile(sdkBinary), sdkExpected, 'SDK binary SHA-256');
const RE2 = require(path.resolve(sdkRoot));
const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const input = a => String.fromCharCode(...a);
const pool = [0x41, 0, 0x80, 0x7ff, 0x800, 0xfffd, 0xe000, 0xd800, 0xdbff, 0xdc00, 0xdfff];
const cases = [[]];
for (let length = 1; length <= 3; length++) {
  const generate = prefix => {
    if (prefix.length === length) { cases.push(prefix); return; }
    for (const unit of pool) generate([...prefix, unit]);
  };
  generate([]);
}
cases.push([0xd800,0xdc00,0xd800,0xdc00], [0x41,0xd800,0xdc00,0x42],
  [0xd800,0x41,0xdc00,0x42], [0xd800,0xd800,0xdc00,0xdc00],
  [0xdc00,0xd800,0xdc00,0xd800], [0xd800,0,0xdc00,0xd800,0x41],
  [0x41,0xd800,0x42,0xdc00,0x43], [0xd800,0xdc00,0,0xd800,0xdc00]);
const patterns = ['.', '\ufffd', '\\C'];
function observation(pattern, s) {
  try {
    const result = new RE2(pattern, 'du').exec(s);
    if (result === null) return null;
    return { captures: Array.from(result, value => value === undefined ? null : units(value)),
      index: result.index, indices: result.indices ? Array.from(result.indices, value => value === undefined ? null : Array.from(value)) : null };
  } catch (error) { return { error: { name: error.name, message: error.message } }; }
}
const observations = cases.map(rawUnits => {
  const s = input(rawUnits);
  return { units: rawUnits, utf16Length: probe.utf16Length(s), utf8Length: probe.utf8Length(s),
    bufferFrom: Array.from(Buffer.from(s, 'utf8')), bufferNew: Array.from(probe.bufferNew(s)),
    writeDefault: Array.from(probe.writeDefault(s)), matches: patterns.map(pattern => observation(pattern, s)) };
});
const output = { format: 1, metadata: { node: { version: process.versions.node, abi: process.versions.modules,
  v8: process.versions.v8, icu: process.versions.icu, unicode: process.versions.unicode,
  binarySha256: hashFile(process.execPath) }, sdk: { version: '1.27.0', sourceSha256: sdkFiles, binarySha256: sdkExpected },
  probe: { cppSha256: cppHash, jsSha256: jsHash, binarySha256: expected },
  fixture: { pool, exhaustiveLengths: [0,1,2,3], additionalCases: 8, patterns, flags: 'du' } }, cases: observations };
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dir && extra.length === 0, 'usage: --write|--check EXISTING_DIRECTORY');
assert(fs.statSync(dir).isDirectory(), 'output directory must exist');
const names = fs.readdirSync(dir).sort();
const destination = path.join(dir, 're2-codec-observations.json');
const serialized = JSON.stringify(output, null, 2) + '\n';
if (mode === '--write') {
  assert.deepEqual(names, [], 'write directory must be empty');
  fs.writeFileSync(destination, serialized, { flag: 'wx' });
} else {
  assert.deepEqual(names, ['re2-codec-observations.json'], 'check directory must contain only the receipt');
  assert.equal(fs.readFileSync(destination, 'utf8'), serialized, 'receipt differs from live observations and pins');
}
console.log(JSON.stringify({ mode, cases: observations.length, sha256: sha(serialized) }));
