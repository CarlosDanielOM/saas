'use strict';
// Test-only frozen source resolver; logical IDs retain their original meaning.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const pins = Object.freeze({
  "src/utils/moderation/normalize.ts": "07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab",
  "src/utils/moderation/rules/links.rule.ts": "802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0",
  "src/utils/moderation/spam_categories.ts": "29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088"
});
const archiveRoot = 'archives/dimabot-typescript/2026-10-28';
function stat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function resolveSource(root, logical, expected = pins[logical]) {
  if (!Object.hasOwn(pins, logical) || expected !== pins[logical]) throw Error('source ID or baseline is not allowlisted');
  const live = path.join(root, logical), archive = path.join(root, '..', archiveRoot, logical);
  const ls = stat(live), as = stat(archive);
  if (!!ls === !!as) throw Error('source missing or ambiguous');
  if (!(ls || as).isFile()) throw Error('source must be a regular file');
  const mf = path.join(root, '..', archiveRoot, 'manifest.json'), ms = stat(mf);
  if (as || ms) {
    if (!ms?.isFile()) throw Error('archive manifest must be a regular file');
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!Array.isArray(manifest.files)) throw Error('invalid archive manifest');
    const entries = manifest.files.filter(e => e.source === logical);
    if (entries.length > 1 || (entries.length === 1 && entries[0].sha256 !== expected) || (as && entries.length !== 1)) throw Error('archive manifest path or hash mismatch');
    if (entries.length && ls) throw Error('retired source must not be shadowed');
  }
  const selected = ls ? live : archive, bytes = fs.readFileSync(selected);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('source hash mismatch');
  return {logical, virtualPath: path.join(root, logical), path: selected, bytes, sha256: expected, provenance: ls ? `dimabot/${logical}` : `${archiveRoot}/${logical}`};
}
function sourcePath(root, logical) { return Object.hasOwn(pins, logical) ? resolveSource(root, logical).path : path.join(root, logical); }
function provenance(root, logicals) { return Object.fromEntries(logicals.filter(x => Object.hasOwn(pins,x)).map(x => [x, resolveSource(root,x).provenance])); }
function overlaySource(host, ts, root, logicals) {
  const sources = logicals.map(x => resolveSource(root,x));
  const get = f => sources.find(s => path.resolve(f) === path.resolve(s.virtualPath));
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host), getSource = host.getSourceFile.bind(host);
  host.readFile = f => get(f)?.bytes.toString('utf8') ?? read(f);
  host.fileExists = f => !!get(f) || exists(f);
  host.getSourceFile = (f,v,...rest) => { const s=get(f); return s ? ts.createSourceFile(f,s.bytes.toString('utf8'),v,true,ts.ScriptKind.TS) : getSource(f,v,...rest); };
  return host;
}
module.exports = {pins, resolveSource, sourcePath, provenance, overlaySource};
