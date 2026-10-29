const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveTtsSource} = require('./tts_source_resolver.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-resolver-'));
try {
  const root = path.join(base, 'dimabot');
  for (const logical of ['src/utils/tts/expressive_tts_tags.util.ts', 'src/utils/tts/kokoro_voices.util.ts', 'src/utils/tts/normalize_tts_message.util.ts']) {
    const live = path.join(root, logical);
    const archived = path.join(base, 'archives/dimabot-typescript/2026-10-28', logical);
    assert.throws(() => resolveTtsSource(root, logical));
    assert.throws(() => resolveTtsSource(root, '../outside'));
    fs.mkdirSync(path.dirname(live), {recursive:true});
    fs.writeFileSync(live, 'live');
    assert.equal(resolveTtsSource(root, logical), live);
    fs.mkdirSync(path.dirname(archived), {recursive:true});
    fs.writeFileSync(archived, 'archive');
    assert.throws(() => resolveTtsSource(root, logical));
    fs.unlinkSync(live);
    assert.equal(resolveTtsSource(root, logical), archived);
    fs.unlinkSync(archived);
    fs.mkdirSync(archived);
    assert.throws(() => resolveTtsSource(root, logical), /not a regular file/);
    fs.rmdirSync(archived);
    fs.symlinkSync('missing-target', archived);
    assert.throws(() => resolveTtsSource(root, logical), /not a regular file/);
    fs.unlinkSync(archived);
  }
  console.log(JSON.stringify({checks:21, scenarios:['missing','unsupported-traversal','live','ambiguous','archive','not-a-file','dangling-symlink']}));
} finally { fs.rmSync(base, {recursive:true, force:true}); }
