'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {pins, resolveSource} = require('./moderation_leaf_source_resolver.cjs');

test('frozen moderation sources require exact unique manifest and bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moderation-leaf-'));
  try {
    const root = path.join(tmp, 'dimabot'), archive = path.join(tmp, 'archives/dimabot-typescript/2026-10-28');
    fs.mkdirSync(root, {recursive:true}); fs.mkdirSync(archive, {recursive:true});
    const actualArchive = path.join(__dirname, '../../../archives/dimabot-typescript/2026-10-28');
    const manifest = path.join(archive, 'manifest.json');
    const entries = Object.entries(pins).map(([source,sha256]) => ({source,sha256}));
    for (const {source} of entries) {
      const dst = path.join(archive,source); fs.mkdirSync(path.dirname(dst),{recursive:true});
      fs.copyFileSync(path.join(actualArchive,source),dst);
    }
    const write = files => fs.writeFileSync(manifest,JSON.stringify({files}));
    write([]); for (const {source} of entries) assert.throws(() => resolveSource(root,source));
    write(entries); for (const {source,sha256} of entries) {
      const result=resolveSource(root,source); assert.equal(result.sha256,sha256);
      assert.equal(result.provenance,`archives/dimabot-typescript/2026-10-28/${source}`);
    }
    const first=entries[0], live=path.join(root,first.source), archived=path.join(archive,first.source);
    assert.throws(() => resolveSource(root,'src/unknown.ts'));
    assert.throws(() => resolveSource(root,first.source,'0'.repeat(64)));
    write([...entries,first]); assert.throws(() => resolveSource(root,first.source));
    write(entries.map(e => e === first ? {...e,sha256:'0'.repeat(64)} : e)); assert.throws(() => resolveSource(root,first.source));
    write(entries); fs.mkdirSync(path.dirname(live),{recursive:true}); fs.copyFileSync(archived,live);
    assert.throws(() => resolveSource(root,first.source));
    fs.unlinkSync(archived); assert.throws(() => resolveSource(root,first.source));
    fs.unlinkSync(live); fs.symlinkSync(path.join(actualArchive,first.source),archived); assert.throws(() => resolveSource(root,first.source));
    fs.unlinkSync(archived); fs.writeFileSync(archived,'tampered'); assert.throws(() => resolveSource(root,first.source));
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
