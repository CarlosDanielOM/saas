'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {pins, resolveSource} = require('./schema_source_resolver.cjs');
const originalRoot = path.resolve(__dirname, '../..');
assert.equal(Object.keys(pins).length, 18);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-source-resolver-'));
try {
  for (const logical of Object.keys(pins)) {
    const original = resolveSource(originalRoot, logical), root = path.join(temp, 'dimabot');
    const live = path.join(root, logical), archiveRoot = path.join(temp, 'archives/dimabot-typescript/2026-10-28');
    const archived = path.join(archiveRoot, logical), manifest = path.join(archiveRoot, 'manifest.json');
    fs.mkdirSync(path.dirname(live), {recursive:true}); fs.mkdirSync(path.dirname(archived), {recursive:true});
    const entry = {source:logical, sha256:pins[logical]}, bytes = fs.readFileSync(original.path);
    const writeManifest = entries => fs.writeFileSync(manifest, JSON.stringify({files:entries}));
    assert.throws(() => resolveSource(root, logical));
    assert.throws(() => resolveSource(root, '../anything')); assert.throws(() => resolveSource(root, logical, 'wrong'));
    fs.symlinkSync(original.path, live); assert.throws(() => resolveSource(root, logical)); fs.unlinkSync(live);
    fs.writeFileSync(live, bytes); assert.equal(resolveSource(root, logical).provenance, 'live');
    fs.writeFileSync(archived, bytes); assert.throws(() => resolveSource(root, logical)); fs.unlinkSync(live);
    assert.throws(() => resolveSource(root, logical)); writeManifest([entry]); assert.equal(resolveSource(root, logical).path, archived);
    writeManifest([entry,entry]); assert.throws(() => resolveSource(root, logical));
    writeManifest([{...entry,sha256:'bad'}]); assert.throws(() => resolveSource(root, logical));
    writeManifest([{...entry,source:'other'}]); assert.throws(() => resolveSource(root, logical));
    writeManifest([entry]); fs.writeFileSync(archived, 'tampered'); assert.throws(() => resolveSource(root, logical));
    fs.unlinkSync(archived); fs.writeFileSync(live, bytes); assert.throws(() => resolveSource(root, logical)); fs.unlinkSync(live);
    fs.symlinkSync(original.path, archived); assert.throws(() => resolveSource(root, logical)); fs.unlinkSync(archived);
    fs.unlinkSync(manifest);
  }
} finally { fs.rmSync(temp, {recursive:true,force:true}); }
