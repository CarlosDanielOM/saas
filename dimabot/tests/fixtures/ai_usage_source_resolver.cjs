'use strict';
// Test-only resolution of exactly the two frozen AI-usage source IDs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = Object.freeze({
  'src/utils/ai_usage_event.ts': '87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60',
  'src/utils/ai_usage_event.test.ts': 'd882a40637225a6454c5d6dde78741fc4f15732a37f48fc2027bc85f5a8e2619',
});
const archiveRelative = 'archives/dimabot-typescript/2026-10-28';
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function resolveSource(root, logical, expected = pins[logical]) {
  if (!Object.hasOwn(pins, logical) || expected !== pins[logical]) throw Error('source ID or baseline is not allowlisted');
  const live = path.join(root, logical);
  const archive = path.join(root, '..', archiveRelative, logical);
  const liveStat = stat(live), archiveStat = stat(archive);
  if (!!liveStat === !!archiveStat) throw Error('source missing or ambiguous');
  const selected = liveStat ? live : archive;
  if (!(liveStat || archiveStat).isFile()) throw Error('source must be a regular file');
  const manifestFile = path.join(root, '..', archiveRelative, 'manifest.json');
  const manifestStat = stat(manifestFile);
  if (archiveStat || manifestStat) {
    if (!manifestStat?.isFile()) throw Error('archive manifest must be a regular file');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!Array.isArray(manifest.files)) throw Error('invalid archive manifest');
    const entries = manifest.files.filter(entry => entry.source === logical);
    if (entries.length > 1 || (entries.length === 1 && entries[0].sha256 !== expected) || (archiveStat && entries.length !== 1)) throw Error('archive manifest path or hash mismatch');
    if (entries.length === 1 && liveStat) throw Error('retired source must not be shadowed');
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(selected)).digest('hex');
  if (actual !== expected) throw Error('source hash mismatch');
  return {logical, path: selected, sha256: expected, provenance: liveStat ? 'live' : `${archiveRelative}/${logical}`};
}
function sourcePath(root, relative) {
  return Object.hasOwn(pins, relative) ? resolveSource(root, relative).path : path.join(root, relative);
}
module.exports = {pins, resolveSource, sourcePath};
