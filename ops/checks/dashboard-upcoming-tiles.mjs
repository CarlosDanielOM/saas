/** Behavior check: dashboard average toggle + premium/pro tiles. */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

// 1. The dashboard route resolves to the CSR shell (not the prerendered landing).
const page = await fetch(`${base}/cdom201/dashboard`);
assert.equal(page.status, 200, 'dashboard route must resolve');
const shell = await page.text();
assert.match(shell, /<app-root/i, 'CSR shell must be served for /:streamer/dashboard');

// 2. i18n bundles expose the upcoming-tile and average-mode keys in both languages.
for (const lang of ['en', 'es']) {
  const res = await fetch(`${base}/assets/i18n/${lang}.json`);
  assert.equal(res.status, 200, `${lang}.json must be served`);
  const dict = await res.json();
  const kpis = dict.dashboard?.kpis ?? {};
  for (const key of [
    'averageModeLabel',
    'averageModeDay',
    'averageModeStream',
    'averageModeDayShort',
    'averageModeStreamShort'
  ]) {
    assert.ok(kpis[key], `${lang}: dashboard.kpis.${key} missing`);
  }
  const averages = kpis.averages ?? {};
  for (const key of [
    'hoursPerDay',
    'hoursPerStream',
    'bitsPerDay',
    'bitsPerStream',
    'donationsPerDay',
    'donationsPerStream',
    'followsPerDay',
    'followsPerStream',
    'subsPerDay',
    'subsPerStream'
  ]) {
    assert.ok(averages[key], `${lang}: dashboard.kpis.averages.${key} missing`);
  }
  const upcoming = dict.dashboard?.upcoming ?? {};
  for (const key of ['premium', 'pro', 'title', 'comingSoon', 'locked', 'requires']) {
    assert.ok(upcoming[key], `${lang}: dashboard.upcoming.${key} missing`);
  }
}

// 3. The built dashboard chunk must ship the tile markup, average toggle and logic.
//    Prefer the main chunk, then scan the lazy chunks it references.
const mainMatch = shell.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the CSR shell');
const mainJs = await (await fetch(`${base}/${mainMatch[1].replace(/^\//, '')}`)).text();

const hasTiles = (body) =>
  body.includes('lf-upcoming') &&
  body.includes('lf-upcoming--locked') &&
  body.includes('lf-mini-range') &&
  body.includes('app-average-toggle') &&
  body.includes('dashboard.kpis.averages.') &&
  body.includes('dashboard.upcoming.title') &&
  body.includes('dashboard.upcoming.requires') &&
  body.includes('dashboard.upcoming.comingSoon') &&
  body.includes('dashboard.upcoming.locked');

let found = hasTiles(mainJs);
if (!found) {
  const chunkNames = [...new Set([...mainJs.matchAll(/chunk-[A-Z0-9]+\.js/g)].map((m) => m[0]))];
  const concurrency = 8;
  for (let i = 0; i < chunkNames.length && !found; i += concurrency) {
    const batch = chunkNames.slice(i, i + concurrency);
    const bodies = await Promise.all(
      batch.map(async (name) => {
        const res = await fetch(`${base}/${name}`);
        return res.status === 200 ? res.text() : '';
      })
    );
    found = bodies.some(hasTiles);
  }
}
assert.ok(found, 'no served chunk contains the dashboard upcoming-tile markup/logic');

console.log('dashboard upcoming-tile bundle checks passed');
