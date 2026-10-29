'use strict';
// Fixture-only source resolver; never used by the application at runtime.
const fs = require('node:fs');
const path = require('node:path');
const allowed = new Set([
  'src/utils/moderation/rules/caps.rule.ts',
  'src/utils/moderation/rules/emote_spam.rule.ts',
  'src/utils/moderation/seed_plan.ts',
]);
function resolveModerationSource(root, logicalPath) {
  if (!allowed.has(logicalPath)) throw new Error(`unsupported moderation source: ${logicalPath}`);
  const sourceRoot = fs.realpathSync(root);
  const virtualPath = path.join(sourceRoot, logicalPath);
  const archiveRelative = `archives/dimabot-typescript/2026-10-28/${logicalPath}`;
  const archivePath = path.join(sourceRoot, '..', archiveRelative);
  const candidates = [
    {file: virtualPath, relativePath: `dimabot/${logicalPath}`},
    {file: archivePath, relativePath: archiveRelative},
  ].filter(({file}) => {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (candidates.length !== 1) throw new Error(`expected exactly one live/archive source: ${logicalPath}`);
  const chosen = candidates[0];
  if (!fs.lstatSync(chosen.file).isFile()) throw new Error(`source is not a regular file: ${logicalPath}`);
  return {virtualPath, relativePath: chosen.relativePath, bytes: fs.readFileSync(chosen.file)};
}
// Expose original location and content to TypeScript so relative schema imports
// resolve as before even when the original source file is absent.
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
module.exports = {resolveModerationSource, overlaySource};
