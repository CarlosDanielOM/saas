/**
 * Behavior check: updated plan AI credit values in the served dimasite bundle.
 *
 * Covers the prerendered landing pricing table and both i18n bundles used by
 * the checkout/profile tier benefits.
 */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const landing = await fetch(`${base}/`);
assert.equal(landing.status, 200);
const html = await landing.text();

for (const value of ['25,000', '200,000', '800,000']) {
  assert.ok(html.includes(value), `landing pricing must include ${value}`);
}
for (const stale of ['125,000', '500,000']) {
  assert.ok(!html.includes(stale), `landing pricing must not include stale ${stale}`);
}

for (const [language, premium, pro] of [
  ['en', '200,000 AI credits / month', '800,000 AI credits / month'],
  ['es', '200,000 creditos de IA / mes', '800,000 creditos de IA / mes'],
]) {
  const response = await fetch(`${base}/assets/i18n/${language}.json`);
  assert.equal(response.status, 200, `${language} i18n bundle`);
  const messages = await response.json();
  const tiers = messages.upgradeModal?.tiers;
  assert.ok(tiers?.premium?.benefits?.includes(premium), `${language} premium benefit`);
  assert.ok(tiers?.pro?.benefits?.includes(pro), `${language} pro benefit`);
  assert.match(messages.profile.subscription.benefitCredits, /800,000/, `${language} profile benefit`);
}

console.log('PASS updated plan credit values in landing pricing and i18n bundles');
