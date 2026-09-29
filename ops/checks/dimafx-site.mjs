/**
 * Behavior check: DimaFX queue/TTS/test-trigger features in the served dimasite bundle.
 *
 * Covers both i18n bundles (new dashboard strings in EN/ES with the {{param}}
 * placeholder convention) and the compiled dimafx page chunk (overlay status
 * endpoint, test trigger endpoint, TTS form fields).
 */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

for (const [language, testLabel, voiceDefault] of [
  ['en', 'Test on stream', 'Channel default (TTS settings)'],
  ['es', 'Probar en stream', 'Predeterminada del canal (ajustes TTS)'],
]) {
  const response = await fetch(`${base}/assets/i18n/${language}.json`);
  assert.equal(response.status, 200, `${language} i18n bundle`);
  const messages = await response.json();
  const dimafx = messages.modules?.dimafx;
  assert.ok(dimafx, `${language} dimafx namespace`);
  assert.equal(dimafx.testOnStream, testLabel, `${language} testOnStream`);
  assert.equal(dimafx.ttsVoiceDefault, voiceDefault, `${language} ttsVoiceDefault`);
  for (const key of ['overlayConnected', 'overlayDisconnected', 'ttsModeCustom', 'ttsModeFixed', 'ttsTextLabel', 'ttsLanguageLabel', 'ttsCustomHint']) {
    assert.ok(dimafx[key], `${language} missing modules.dimafx.${key}`);
  }
  assert.ok(dimafx.testQueuedDesc.includes('{{name}}') && dimafx.testQueuedDesc.includes('{{position}}'), `${language} testQueuedDesc placeholders`);
}

// Find the compiled dimafx page chunk through the CSR shell's main bundle.
const csr = await (await fetch(`${base}/index.csr.html`)).text();
const mainSrc = csr.match(/src="(main-[A-Z0-9]+\.js)"/i);
assert.ok(mainSrc, 'CSR shell references a hashed main bundle');
const main = await (await fetch(`${base}/${mainSrc[1]}`)).text();
const chunkNames = [...new Set([...main.matchAll(/chunk-[A-Z0-9]+\.js/gi)].map((m) => m[0]))];
assert.ok(chunkNames.length > 0, 'main bundle lists lazy chunks');

let dimafxChunk = null;
for (let i = 0; i < chunkNames.length; i += 12) {
  const batch = chunkNames.slice(i, i + 12);
  const bodies = await Promise.all(batch.map((name) => fetch(`${base}/${name}`).then((r) => (r.ok ? r.text() : ''))));
  for (const body of bodies) {
    if (body.includes('/overlay-status') && body.includes('/test')) {
      dimafxChunk = body;
      break;
    }
  }
  if (dimafxChunk) break;
}
assert.ok(dimafxChunk, 'dimafx page chunk found in the served bundle');
for (const marker of ['overlay-status', '/test', 'ttsMode', 'ttsVoice', 'ttsLanguage', 'Viewer writes the message'.length ? 'ttsModeCustom' : '']) {
  assert.ok(dimafxChunk.includes(marker), `dimafx chunk includes ${marker}`);
}

console.log('PASS DimaFX i18n strings (EN/ES) and compiled dashboard chunk (overlay status, test trigger, TTS form)');
