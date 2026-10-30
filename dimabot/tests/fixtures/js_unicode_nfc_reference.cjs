#!/usr/bin/env node
'use strict';
// Pinned Node's actual String.prototype.normalize is the independent oracle.
// Writes one artifact in a canonical external directory; --check regenerates it.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const pin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_JS_UNICODE_NODE_SHA256, pin);
assert.equal(sha(fs.readFileSync(process.execPath)), pin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode], ['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const rootArg = process.env.DIMA_JS_UNICODE_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg));
const root = fs.realpathSync(rootArg); assert.equal(root, rootArg);
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dirArg && path.isAbsolute(dirArg) && !extra.length);
const dir = fs.realpathSync(dirArg); assert.equal(dir,dirArg);
const workspace = fs.realpathSync(path.dirname(root));
assert(fs.statSync(dir).isDirectory() && dir !== workspace && !dir.startsWith(workspace + path.sep));
const name = 'js-unicode-nfc-reference.json';
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [name]);
if (mode === '--check') assert(fs.lstatSync(path.join(dir,name)).isFile());
const paths = ['src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/moderation/variations.rs','tests/js_unicode_nfc.rs','tests/support/sha256.rs','tests/fixtures/js_unicode_nfc_reference.cjs','Cargo.lock','rust-toolchain.toml'];
const hashes = Object.fromEntries(paths.map(p => [p,sha(fs.readFileSync(path.join(root,p)))]));
assert.equal(process.env.DIMA_JS_NFC_ORACLE_SHA256,hashes['tests/fixtures/js_unicode_nfc_reference.cjs']);
const units = s => Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const buf = Buffer.allocUnsafe(0x110000 * 32); let offset = 0, changed = 0;
for (let cp=0; cp<=0x10ffff; cp++) {
  const input = String.fromCodePoint(cp), output = input.normalize('NFC');
  if (input !== output) changed++;
  assert(offset + 8 + output.length*2 <= buf.length);
  buf.writeUInt32BE(cp,offset); offset+=4; buf.writeUInt32BE(output.length,offset); offset+=4;
  for (let i=0;i<output.length;i++) { buf.writeUInt16BE(output.charCodeAt(i),offset); offset+=2; }
}
const fragments = [
  [0x0041],[0x0045],[0x0301],[0x0327],[0x0315],[0x0345],[0x00c5],
  [0x1100],[0x1161],[0x11a8],[0xac00],[0x1ade],[0x1adf],[0xd800],[0xdc00],[0xd83d,0xde00],
];
const fixed = [
 [],[0x61,0x62,0x63],[0x0041,0x030a],[0x0065,0x0301],[0x0041,0x0315,0x0300],
 [0x00c5,0x0301],[0x212b],[0x0344],[0x1100,0x1161,0x11a8],[0xac00,0x11a8],
 [0xd800],[0xdc00],[0xd800,0x0041,0x0301,0xdc00],[0xd800,0xd800,0xdc00,0xdc00],
 [0x0041,0x0301,0x1ade,0x0327],[0x0041,0x0301,0x1adf,0x0327],
 [0x0041,0x0301,0x0378,0x0327],[0xd800,0x0301,0xdc00],[0x0301,0x0327],
 [0xd83d,0xde00,0x0041,0x030a],
];
for (const cp of [0x1ade,0x1adf,0x0378]) assert(!/\p{Assigned}/u.test(String.fromCodePoint(cp)));
const inputs = fixed.slice(); for (const a of fragments) for (const b of fragments) for (const c of fragments) inputs.push([...a,...b,...c]);
assert.equal(inputs.length,4116);
const cases = inputs.map(input => ({ input, output:units(String.fromCharCode(...input).normalize('NFC')) }));
const output = JSON.stringify({format:1, algorithm:'Node String.prototype.normalize NFC', versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode},nodeExecutableSha256:pin,sourceSha256:hashes,scalar:{count:0x110000,changed,encoding:'ascending u32be codepoint, u32be UTF-16 length, u16be output units',bytes:offset,sha256:sha(buf.subarray(0,offset))},fixedCount:fixed.length,fragmentCount:fragments.length,caseCount:cases.length,cases},null,2)+'\n';
const file = path.join(dir,name);
if (mode === '--write') fs.writeFileSync(file,output,{flag:'wx'}); else assert.equal(fs.readFileSync(file,'utf8'),output);
console.log(`${name} sha256=${sha(output)} scalarChanged=${changed} scalarSha256=${sha(buf.subarray(0,offset))} cases=${cases.length}`);
