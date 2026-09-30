// Run against the isolated development preview or saas-ops site candidate.
import assert from 'node:assert/strict';
const { chromium } = await import('playwright').catch(() => import('/tmp/saas-visual-check/node_modules/playwright/index.mjs'));
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL required');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const twitch = { id: '999983', login: 'fixture', display_name: 'Fixture', profile_image_url: '' };
const app = { name: 'fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: '999983', has_permissions: true, up_to_date_permissions: true, administrating: [] };
const overlayUrl = 'https://api.example.invalid/overlays/dimafx/999983?token=fixture-token';
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.routeWebSocket('**/*', () => {});
    let connected = false;
    await context.addInitScript(({ twitch, app }) => {
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-token', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: twitch, appUser: app, permissions: {} }));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedText = text; } }, configurable: true });
    }, { twitch, app });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch, app };
      else if (url.pathname.startsWith('/auth/access/') || url.pathname.endsWith('/access')) data = { allowed: true, planTier: 'pro' };
      else if (url.pathname.endsWith('/overlay-status')) data = { connected, overlayUrl };
      else if (url.pathname === '/extensions/dimafx/999983/items') data = [];
      else if (url.pathname.startsWith('/triggers/')) data = [];
      else if (url.pathname === '/users') data = { id: twitch.id, username: twitch.login };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: false, status: 200, data }) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/fixture/modules/dimafx`);
    await page.getByText('DimaFX overlay disconnected', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('DimaFX OBS browser source').inputValue(), overlayUrl);
    assert.equal(await page.getByRole('link', { name: 'Open overlay', exact: true }).getAttribute('href'), overlayUrl);
    await page.getByRole('button', { name: 'Copy OBS link', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedText), overlayUrl);
    connected = true;
    await page.getByText('DimaFX overlay connected', { exact: true }).waitFor({ timeout: 8000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow');
    await page.screenshot({ path: `/tmp/dimafx-dashboard-${viewport.width}.png`, fullPage: true });
    assert.equal(await page.locator('.lf-banner--error').count(), 0, 'dashboard has no error banner');
    assert.deepEqual(errors, [], `dashboard runtime errors: ${errors}`);
    await context.close();
  }
  console.log('PASS: DimaFX dashboard OBS link, clipboard, live connection status, desktop/mobile layout, no runtime errors');
} finally { await browser.close(); }
