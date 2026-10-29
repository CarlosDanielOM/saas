// Independent reference: all expected bits come directly from Node's Math.round.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') {
  throw Error('wrong reference toolchain');
}
const [mode, dir, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dir || extra.length) {
  throw Error('usage: --write DIR | --check DIR');
}
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bits = number => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(number);
  return buffer.readBigUInt64BE();
};
const number = raw => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(raw);
  return buffer.readDoubleBE();
};
const hex = raw => raw.toString(16).padStart(16, '0');
const inputs = new Set();
const add = raw => inputs.add(hex(raw));
// Explicit special values and signed subnormals, avoiding signaling NaNs.
for (const raw of [0n, 0x8000000000000000n, 1n, 0x8000000000000001n,
  0x000fffffffffffffn, 0x800fffffffffffffn, 0x7ff0000000000000n,
  0xfff0000000000000n, 0x7ff8000000000000n]) add(raw);
// Each center and its adjacent bit patterns, for both signs. These include
// half ties, 2^52/2^53 boundaries, very large finite values and max finite.
for (const center of [0.5, 1.5, 2.5, 15.5, 100.5, 2 ** 52, 2 ** 53, 1e308, Number.MAX_VALUE]) {
  for (const sign of [1, -1]) {
    const raw = bits(center * sign);
    for (const delta of [-1n, 0n, 1n]) add(raw + delta);
  }
}
// Fixed-seed xorshift spans signs, exponents and significands. Replace the
// all-ones exponent to keep these generated inputs finite.
const mask = 0xffffffffffffffffn;
let state = 0x9e3779b97f4a7c15n;
for (let i = 0; i < 4096; i++) {
  state ^= (state << 13n) & mask;
  state ^= state >> 7n;
  state ^= (state << 17n) & mask;
  state &= mask;
  let raw = state;
  if ((raw & 0x7ff0000000000000n) === 0x7ff0000000000000n) raw ^= 0x0010000000000000n;
  add(raw);
}
const cases = [...inputs].map(input => ({
  input,
  output: hex(bits(Math.round(number(BigInt(`0x${input}`))))),
}));
const metadata = {
  schema: 1,
  node: process.version,
  v8: process.versions.v8,
  hashes: {script: sha(__filename), nodeBinary: sha(process.execPath)},
  count: cases.length,
};
const output = JSON.stringify({metadata, cases}, null, 2) + '\n';
const file = path.join(dir, 'js-round-reference.json');
if (mode === '--write') {
  if (!fs.statSync(dir).isDirectory()) throw Error('parent-owned directory required');
  fs.writeFileSync(file, output, {flag: 'wx'});
} else if (fs.readFileSync(file, 'utf8') !== output) {
  throw Error('reference mismatch');
}
