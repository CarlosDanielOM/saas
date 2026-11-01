/**
 * Recreate the bilingual screenshots embedded in the alert and module guides.
 *
 * Run against the local capture gateway with:
 *   SAAS_SITE_URL=http://127.0.0.1:4205 node ops/docs-visuals/alerts.mjs
 *
 * The gateway serves the real Angular site and injects browser-core.js plus
 * alerts.fixture.js before app bootstrap. This script does not start a server.
 * Browser APIs and WebSockets are isolated by the gateway and the route guards
 * below. Interactions mirror the exact-page browser checks listed in README.md.
 */
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const sharp = createRequire(path.resolve(here, '../../dimadocs/package.json'))('sharp');
const base = (process.env.SAAS_SITE_URL || 'http://127.0.0.1:4205').replace(/\/$/, '');
assert.equal(new URL(base).hostname, '127.0.0.1', 'Capture gateway must be loopback-only');
const out = path.resolve(process.env.SAAS_SCREENSHOT_DIR || path.join(here, '../../dimadocs/public/guides/alerts'));
const pages = [
  { id: 'tts', route: '/modules/tts', marker: { en: 'Text to Speech', es: 'Texto a voz' } },
  { id: 'triggers', route: '/modules/triggers', marker: { en: 'Triggers', es: 'Triggers' } },
  { id: 'media-library', route: '/modules/library', marker: { en: 'Media Library', es: 'Biblioteca multimedia' } },
  { id: 'overlay-studio', route: '/modules/overlays', marker: { en: 'Main overlay', es: 'Main overlay' }, crop: { left: 0, top: 226, width: 1280, height: 674 }, scroll: 560 },
  { id: 'dimafx', route: '/modules/dimafx', marker: { en: 'DimaFX', es: 'DimaFX' } },
  { id: 'redemptions', route: '/modules/redemptions', marker: { en: 'Redemptions', es: 'Canjes' } },
  { id: 'roulette', route: '/modules/roulette', marker: { en: 'Roulette', es: 'Ruleta' } }
];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

async function open(language, route, { width = 1280, height = 900, theme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const allowed = new Set([new URL(base).origin, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
  await context.route('**/*', r => allowed.has(new URL(r.request().url()).origin) ? r.continue() : r.abort());
  await context.routeWebSocket(/.*/, ws => ws.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/demostreamer${route}?capture=alerts&lang=${language}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.docsCapture?.lang && Array.isArray(window.docsCapture.unhandled));
  await page.locator('main h1').first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const state = await page.evaluate(() => ({
    lang: window.docsCapture.lang,
    theme: window.docsCapture.theme,
    errors: window.docsCapture.errors,
    unhandled: window.docsCapture.unhandled,
    channel: window.docsCapture.user?.display_name
  }));
  assert.equal(state.lang, language);
  assert.equal(state.theme, theme);
  assert.equal(state.channel, 'DemoStreamer');
  assert.deepEqual(state.errors, [], `${route}: fixture errors`);
  assert.deepEqual(state.unhandled, [], `${route}: unhandled API requests`);
  assert.deepEqual(errors, [], `${route}: page errors`);
  return { context, page };
}

async function capture(page, id, language, options = {}) {
  await page.evaluate(y => window.scrollTo(0, y), options.scroll || 0);
  await page.waitForTimeout(120);
  const target = path.join(out, `${id}-${language}.png`);
  if (!options.crop) {
    await page.screenshot({ path: target, animations: 'disabled' });
    return;
  }
  const full = `${target}.full.png`;
  await page.screenshot({ path: full, animations: 'disabled' });
  await sharp(full).extract(options.crop).png({ compressionLevel: 9 }).toFile(target);
  await rm(full);
}

await mkdir(out, { recursive: true });
try {
  for (const language of ['en', 'es']) {
    for (const feature of pages) {
      const { context, page } = await open(language, feature.route);
      const text = await page.locator('main').innerText();
      assert.ok(text.includes(feature.marker[language]), `${feature.id}/${language}: expected real feature screen`);
      assert.ok(!text.includes('Checking...'), `${feature.id}/${language}: wait for settled screen`);
      await capture(page, feature.id, language, feature);
      if (feature.id === 'redemptions') {
        const newReward = page.getByRole('button', { name: language === 'en' ? 'New reward' : 'Nueva recompensa' });
        await newReward.click();
        await page.getByRole('heading', { name: language === 'en' ? 'New reward' : 'Nueva recompensa' }).waitFor();
        await capture(page, 'rewards', language);
      }
      await context.close();
      console.log(`Captured ${feature.id}/${language}.`);
    }
  }

  for (const route of ['/modules/redemptions', '/modules/dimafx']) {
    const { context, page } = await open('es', route, { width: 390, height: 844, theme: 'light' });
    const state = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, errors: window.docsCapture.errors, unhandled: window.docsCapture.unhandled }));
    assert.equal(state.overflow, false, `${route}: mobile overflow at 390px`);
    assert.deepEqual(state.errors, [], `${route}: mobile fixture errors`);
    assert.deepEqual(state.unhandled, [], `${route}: mobile unhandled API requests`);
    await context.close();
  }
} finally {
  await browser.close();
}
