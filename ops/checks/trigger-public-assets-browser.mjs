import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4201';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const user = { id: '991541', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true,
  chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const allAssets = Array.from({ length: 102 }, (_, index) => ({
  _id: `asset-${index}`, displayName: `Asset_${index}`, ownerChannelName: 'fixture',
  mediaType: 'audio', bytes: 100, scope: 'public', marketplaceStatus: 'published',
  playbackUrl: `https://fixture.invalid/media/${index}`
}));
let pageCalls = [];

try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    twitchUser: user, appUser: app, permissions: {}
  })), { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) {
      if (process.env.SAAS_PREVIEW_URL && url.pathname.startsWith('/fixture/')) {
        return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      }
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = [];
    let total;
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/') || url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname === `/triggers/library/${user.id}`) data = [];
    else if (url.pathname === '/triggers/assets/public') {
      const skip = Number(url.searchParams.get('skip') || 0);
      const limit = Number(url.searchParams.get('limit') || 24);
      const q = url.searchParams.get('q')?.toLowerCase() || '';
      const matches = allAssets.filter(asset => asset.displayName.toLowerCase().includes(q));
      pageCalls.push({ skip, limit, q });
      data = matches.slice(skip, skip + limit);
      total = matches.length;
    }
    return route.fulfill({ json: { error: false, status: 200, data, total, meta: { planTier: 'pro', quotaBytesUsed: 0, quotaBytesLimit: 1_000_000 } } });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/fixture/modules/triggers');
  await page.getByRole('button', { name: 'Browse Public Library' }).click();
  const dialog = page.getByRole('dialog', { name: 'Public Library' });
  await page.waitForFunction(() => document.querySelectorAll('app-public-library-modal .lf-asset-card').length === 102);
  assert.equal(await dialog.locator('.lf-asset-card').count(), 102);
  assert.deepEqual(pageCalls.slice(0, 2), [{ skip: 0, limit: 100, q: '' }, { skip: 100, limit: 100, q: '' }]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'desktop horizontal overflow');
  await dialog.getByRole('searchbox').fill('Asset_101');
  await dialog.locator('.lf-asset-card').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('app-public-library-modal .lf-asset-card').length === 1);
  assert.equal(await dialog.getByText('Asset 101', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS public asset browser: 102 assets across pages, search, mobile and desktop layout.');
  await context.close();
} finally {
  await browser.close();
}
