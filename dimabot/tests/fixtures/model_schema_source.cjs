'use strict';
// Fixture-only frozen source resolution. Never used by the application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = Object.freeze({
  'src/schemas/temporary_moderator.schema.ts': '1eeab71be86ccb0df0ff7c8404cce8580d27fd280853293175433e72155ef146',
  'src/schemas/vip.schema.ts': 'b68e2689c7cd4598b2719a2305d7e42ec504e15868808c26b7e8615806e78f85',
  'src/schemas/title_config.schema.ts': '5a2886025ab6ca4bd75c54f623ec732a13c392185945a967e372360e4ccb9a97',
  'src/schemas/trigger_file.schema.ts': '4ce0751c6232be1088ef05707dee271efea1157e93821c431c01bfb3a0545bd4',
  'src/schemas/eventsub.schema.ts': '9d641eb036d2dba0907ab5b70bfb58265bbd7174915ddfd8f87b676319d75bf3',
  'src/schemas/site_analytics.schema.ts': '6a187e768b8a246143a9ea04b8000583b60090639b0a904fc265bed22b6090d3',
  'src/schemas/follow_attack_log.schema.ts': '418077f7dae3dbfbea4e800eb1444920de2c202828dbe97b87c3e074cea0b032',
  'src/schemas/follow_defense_action.schema.ts': '0b56200c8aa2ad0c29668c82da87354517774c2e523e448868daf4c7fafc9cf4',
  'src/schemas/follow_hate_raid_source.schema.ts': '8b2321fcf3eed917304bd3d2e03bf975b5351a3a37494cbe1e8ad54947c1215e',
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
  const live = path.join(root, logical), archive = path.join(root, '..', archiveRelative, logical);
  const liveStat = stat(live), archiveStat = stat(archive);
  if (!!liveStat === !!archiveStat) throw Error('source missing or ambiguous');
  const selected = liveStat ? live : archive;
  if (!(liveStat || archiveStat).isFile()) throw Error('source must be a regular file');
  const manifestFile = path.join(root, '..', archiveRelative, 'manifest.json'), manifestStat = stat(manifestFile);
  if (archiveStat || manifestStat) {
    if (!manifestStat?.isFile()) throw Error('archive manifest must be a regular file');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!Array.isArray(manifest.files)) throw Error('invalid archive manifest');
    const entries = manifest.files.filter(entry => entry.source === logical);
    if (entries.length > 1 || (entries.length === 1 && entries[0].sha256 !== expected) || (archiveStat && entries.length !== 1)) throw Error('archive manifest path or hash mismatch');
    if (entries.length === 1 && liveStat) throw Error('retired source must not be shadowed');
  }
  const bytes = fs.readFileSync(selected);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('source hash mismatch');
  return {logical, path: selected, virtualPath: path.join(root, logical), bytes, sha256: expected, provenance: liveStat ? 'live' : `${archiveRelative}/${logical}`};
}
function overlaySource(host, ts, source) {
  const readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host), getSourceFile = host.getSourceFile.bind(host);
  const isVirtual = file => path.resolve(file) === source.virtualPath;
  host.readFile = file => isVirtual(file) ? source.bytes.toString('utf8') : readFile(file);
  host.fileExists = file => isVirtual(file) || fileExists(file);
  host.getSourceFile = (file, languageVersion, ...rest) => isVirtual(file)
    ? ts.createSourceFile(file, source.bytes.toString('utf8'), languageVersion, true, ts.ScriptKind.TS)
    : getSourceFile(file, languageVersion, ...rest);
  return host;
}
module.exports = {pins, resolveSource, overlaySource};
