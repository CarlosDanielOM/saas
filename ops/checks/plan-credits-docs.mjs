/**
 * Behavior check: updated plan AI credit table in the served dimadocs pages.
 */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

for (const path of ['/tts/', '/es/tts/']) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  const html = await response.text();
  for (const value of ['25,000', '200,000', '800,000']) {
    assert.ok(html.includes(value), `${path} must include ${value}`);
  }
  for (const stale of ['125,000', '500,000']) {
    assert.ok(!html.includes(stale), `${path} must not include stale ${stale}`);
  }
}

console.log('PASS updated plan credit table in English and Spanish TTS docs');
