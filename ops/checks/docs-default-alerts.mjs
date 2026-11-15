// Docs for the Dima default alerts (2026-11-15): Overlay Studio page in English and es-MX. saas-ops docs check.
//   scripts/saas-ops verify docs-<run> --check ops/checks/docs-default-alerts.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert.ok(base, 'SAAS_PREVIEW_URL');
const pages = {
  '': { heading: 'Default alerts', must: ['$(gift.count)', 'Dima library', "doesn't use your storage", 'Browse Asset Library', 'Gifted subs (any tier)', 'Sample subscription tier', 'Subscriptions'] },
  'es/': { heading: 'Alertas predeterminadas', must: ['$(gift.count)', 'biblioteca de Dima', 'no usa tu almacenamiento', 'Explorar biblioteca de recursos', 'Suscripciones regaladas (cualquier nivel)', 'Nivel de prueba', 'Suscripciones'] }
};
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
try {
  for (const [prefix, { heading, must }] of Object.entries(pages)) for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.route('**/docs-assistant/**', route => route.abort());
    const response = await page.goto(`${base}/${prefix}overlay-studio/`);
    assert.equal(response.status(), 200, prefix + ' overlay-studio page');
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    const text = (await page.locator('main').innerText()).replace(/[\u2018\u2019]/g, "'");
    for (const words of must) assert.ok(text.includes(words), `${prefix || 'en/'} missing: ${words}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${prefix} no sideways scroll at ${width}`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('docs default alerts check passed');
} finally { await browser.close(); }
