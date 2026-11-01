/**
 * Recreate the localized screenshots embedded in the growth guides.
 *
 * Run with SAAS_SITE_URL=http://127.0.0.1:4206 node ops/docs-visuals/growth.mjs
 * against the loopback capture gateway. The gateway injects browser-core.js
 * and growth.fixture.js before the app boots; browser-core aborts external
 * requests and closes WebSockets, while the feature fixture returns only
 * browser-local data. No app server is started by this script.
 *
 * Fixture contracts follow these exact behavior checks:
 * ai-personality-browser.mjs, memories-browser.mjs,
 * stream-summaries-browser.mjs, clip-recommendations-browser.mjs,
 * follow-defense-browser.mjs, semantic-moderation-browser.mjs,
 * clips-carousel-live.mjs, analytics-access-browser.mjs, and
 * login-referral-redesign-browser.mjs / referral_ledger_site.py.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = (process.env.SAAS_SITE_URL || 'http://127.0.0.1:4206').replace(/\/$/, '');
assert.equal(new URL(base).hostname, '127.0.0.1', 'Capture gateway must be loopback-only');
const output = resolve(process.env.SAAS_SCREENSHOT_DIR || 'dimadocs/public/guides/growth');
const features = [
  { id: 'ai-personality', route: '/modules/ai-personality', selector: 'app-ai-personality-page' },
  { id: 'memories', route: '/modules/memories', selector: 'app-memories-page' },
  { id: 'stream-summaries', route: '/modules/stream-summaries', selector: 'app-stream-summaries-page' },
  { id: 'clip-recommendations', route: '/modules/clip-recommendations', selector: 'app-clip-recommendations-page' },
  { id: 'clips', route: '/modules/clips', selector: 'app-clips-page' },
  { id: 'follow-defense', route: '/modules/follow-defense', selector: 'app-follow-defense-page' },
  { id: 'moderation', route: '/modules/moderation', selector: 'app-moderation-page' },
  { id: 'analytics', route: '/modules/analytics', selector: 'app-analytics-hub-page' },
  { id: 'referrals', route: '/modules/referrals', selector: 'app-referrals-page' }
];
const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

async function open(page, feature, language, theme, width, height) {
  await page.setViewportSize({ width, height });
  const url = `${base}/demostreamer${feature.route}?capture=growth&lang=${language}&theme=${theme}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator(feature.selector).waitFor({ state: 'visible', timeout: 20000 });
  await page.locator(`${feature.selector} h1`).first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const text = await page.locator(feature.selector).innerText();
  assert.ok(text.trim().length > 40, `${feature.id}/${language} should show the real feature screen`);
  const state = await page.evaluate(() => ({
    lang: window.docsCapture?.lang,
    theme: window.docsCapture?.theme,
    channel: window.docsCapture?.user?.display_name,
    errors: window.docsCapture?.errors || [],
    unhandled: window.docsCapture?.unhandled || [],
    overflow: document.documentElement.scrollWidth > window.innerWidth
  }));
  assert.equal(state.lang, language, `${feature.id}: gateway locale`);
  assert.equal(state.theme, theme, `${feature.id}: gateway theme`);
  assert.equal(state.channel, 'DemoStreamer', `${feature.id}: sample account`);
  assert.deepEqual(state.errors, [], `${feature.id}: fixture errors`);
  assert.deepEqual(state.unhandled, [], `${feature.id}: every API route should be fixture-backed`);
  return { text, state };
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.routeWebSocket(/./, (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === new URL(base).origin || origin === 'https://fonts.googleapis.com' || origin === 'https://fonts.gstatic.com') {
      return route.continue();
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));

  for (const feature of features) {
    for (const language of ['en', 'es']) {
      const { state } = await open(page, feature, language, 'dark', 1280, 900);
      assert.equal(state.overflow, false, `${feature.id}/${language} desktop overflow`);
      const path = resolve(output, `${feature.id}-${language}.png`);
      await mkdir(dirname(path), { recursive: true });
      await page.screenshot({ path, type: 'png', fullPage: false, animations: 'disabled' });
      console.log(`Captured ${path}`);
    }

    // Check each flow in the light theme and a phone viewport without keeping
    // extra screenshots in the docs bundle.
    for (const [theme, width, height] of [['light', 1280, 900], ['dark', 390, 844]]) {
      const { state } = await open(page, feature, 'en', theme, width, height);
      assert.equal(state.overflow, false, `${feature.id}/${theme}/${width} overflow`);
    }
  }

  assert.deepEqual(errors, [], 'No uncaught browser errors during capture');
  console.log(`Captured ${features.length * 2} dark screenshots; checked light and mobile views for all ${features.length} flows.`);
  await context.close();
} finally {
  await browser.close();
}
