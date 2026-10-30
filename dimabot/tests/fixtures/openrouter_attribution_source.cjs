'use strict';
// Fixture-only source resolution for the retired OpenRouter app-attribution
// helper. Exactly one logical module is allowlisted; the application never uses
// this reader. The logical TypeScript ID keeps its original meaning.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logical = 'src/utils/ai/openrouter/app_attribution.util.ts';
const pins = Object.freeze({
  [logical]: '0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c',
});
const archiveRelative = 'archives/dimabot-typescript/2026-10-28';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function regular(label, state) {
  // lstat is used everywhere so a symlink is never followed or accepted.
  if (state.isSymbolicLink()) throw Error(`${label} must not be a symbolic link`);
  if (!state.isFile()) throw Error(`${label} must be a regular file`);
}
function resolveSource(root, requested = logical, expected = pins[requested]) {
  if (!Object.hasOwn(pins, requested) || expected !== pins[requested]) throw Error('source ID or baseline is not allowlisted');
  const live = path.join(root, requested);
  const archiveRoot = path.join(root, '..', archiveRelative);
  const archived = path.join(archiveRoot, requested);
  const liveStat = stat(live), archiveStat = stat(archived);
  if (!!liveStat === !!archiveStat) throw Error('source missing or ambiguous');
  const selected = liveStat ? live : archived;
  regular('source', liveStat || archiveStat);
  const manifestFile = path.join(archiveRoot, 'manifest.json'), manifestStat = stat(manifestFile);
  if (!manifestStat) throw Error('archive manifest is missing');
  regular('archive manifest', manifestStat);
  const manifestBytes = fs.readFileSync(manifestFile);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) { throw Error('invalid archive manifest JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.files)) throw Error('invalid archive manifest');
  const entries = manifest.files.filter(entry => entry && typeof entry === 'object' && entry.source === requested);
  if (entries.length > 1) throw Error('duplicate archive manifest entry');
  if (entries.length === 1 && entries[0].sha256 !== expected) throw Error('archive manifest hash mismatch');
  if (archiveStat && entries.length !== 1) throw Error('missing archive manifest entry');
  if (liveStat && entries.length !== 0) throw Error('retired source must not be shadowed');
  const bytes = fs.readFileSync(selected);
  if (sha(bytes) !== expected) throw Error('source hash mismatch');
  return {
    logical: requested,
    path: selected,
    virtualPath: path.join(root, requested),
    bytes,
    sha256: expected,
    provenance: liveStat ? `dimabot/${requested}` : `${archiveRelative}/${requested}`,
    manifestPath: manifestFile,
    manifestSha256: sha(manifestBytes),
    archiveEntries: manifest.files.length,
  };
}
function sourcePath(root, requested = logical) { return resolveSource(root, requested).path; }
function read(root, requested = logical) { return resolveSource(root, requested).bytes; }
module.exports = { logical, pins, archiveRelative, resolveSource, sourcePath, read, sha };
