// Fixture-only resolver for the two retired pure TTS modules.
const fs = require('node:fs');
const path = require('node:path');
const allowed = new Set([
  'src/utils/tts/expressive_tts_tags.util.ts',
  'src/utils/tts/kokoro_voices.util.ts',
]);
function resolveTtsSource(root, logicalPath) {
  if (!allowed.has(logicalPath)) throw new Error(`unsupported TTS source: ${logicalPath}`);
  const live = path.join(root, logicalPath);
  const archived = path.join(root, '../archives/dimabot-typescript/2026-10-28', logicalPath);
  const candidates = [live, archived].filter(p => fs.existsSync(p));
  if (candidates.length !== 1) throw new Error(`expected exactly one live/archive source for ${logicalPath}`);
  if (!fs.statSync(candidates[0]).isFile()) throw new Error(`TTS source is not a regular file: ${logicalPath}`);
  return candidates[0];
}
module.exports = {resolveTtsSource};
