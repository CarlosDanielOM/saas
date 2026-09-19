// Verifies the modules hub groups Triggers and Text to Speech under "Core tools"
// while keeping them out of "More modules". SAAS_BROWSER_TOOLS must contain Playwright.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const CORE_LABEL = 'Core tools';
const MORE_LABEL = 'More modules';
const CORE_MODULES = ['Chat Events', 'Chat Moderation', 'Clips', 'DimaFX', 'Triggers', 'Text to Speech'];
const MOVED_MODULES = ['Triggers', 'Text to Speech'];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
    const app = {
      name: 'Viewer',
      email: 'test@example.invalid',
      language: 'en',
      plan_tier: 'free',
      actived: true,
      chat_enabled: true,
      twitch_user_id: user.id,
      has_permissions: true,
      up_to_date_permissions: true,
      administrating: []
    };
    await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: user, appUser: app, permissions: {}
    })), { user, app });
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'free' };
      else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      else if (url.pathname.startsWith('/rewards/')) data = [];
      else if (url.pathname.startsWith('/eventsubs/')) data = [];
      return route.fulfill({ json: { error: false, status: 200, data } });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(`${base}/viewer/modules`);
    await page.locator('app-modules-page .lf[data-plan]').waitFor();

    const core = page.locator(`section.lf-section[aria-label="${CORE_LABEL}"]`);
    const more = page.locator(`section.lf-section[aria-label="${MORE_LABEL}"]`);
    await core.waitFor();
    await more.waitFor();

    for (const name of CORE_MODULES) {
      assert.equal(
        await core.getByRole('heading', { level: 3, name, exact: true }).count(),
        1,
        `${name} should be listed under Core tools at ${width}px`
      );
    }
    assert.equal(await core.locator('article.lf-mod').count(), CORE_MODULES.length, `Core tools has ${CORE_MODULES.length} modules at ${width}px`);

    for (const name of MOVED_MODULES) {
      assert.equal(
        await more.getByRole('heading', { level: 3, name, exact: true }).count(),
        0,
        `${name} should not be under More modules at ${width}px`
      );
    }

    assert.deepEqual(errors, [], `no browser runtime errors at ${width}px`);
    console.log(`PASS ${width}px: Core tools includes ${MOVED_MODULES.join(', ')}`);
    await context.close();
  }
} finally {
  await browser.close();
}
