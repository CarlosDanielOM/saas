'use strict';
// Parent verification helper; copies only oracle-bound public package files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [fixture, destination] = process.argv.slice(2);
const root = '/source/dimabot';
const metadata = JSON.parse(fs.readFileSync(fixture, 'utf8')).metadata;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = new Map(Object.entries(metadata.dependencies));
for (const pkg of Object.values(metadata.packages)) {
  for (const [p, h] of [['packagePath','packageSha256'], ['entryPath','entrySha256']]) {
    if (files.has(pkg[p])) assert.equal(files.get(pkg[p]), pkg[h]);
    files.set(pkg[p], pkg[h]);
  }
}
fs.mkdirSync(destination);
for (const [relative, expected] of files) {
  assert(relative.startsWith('node_modules/') && !relative.split('/').includes('..'));
  const bytes = fs.readFileSync(path.join(root, relative));
  assert.equal(sha(bytes), expected, relative);
  const output = path.join(destination, 'root', relative);
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, bytes, {flag:'wx', mode:0o444});
}
const binary = fs.readFileSync(process.execPath);
assert.equal(sha(binary), metadata.nodeSha256);
fs.writeFileSync(path.join(destination, 'node'), binary, {flag:'wx', mode:0o444});
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
  files:Object.fromEntries(files), nodeSha256:metadata.nodeSha256,
  nodeBytes:binary.length, scope:'Public package and executable bytes for hash verification only; never executed by Rust tests.'
}, null, 2)+'\n', {flag:'wx'});
console.log(JSON.stringify({copiedPackageFiles:files.size,nodeBytes:binary.length}));
