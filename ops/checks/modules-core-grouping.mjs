// Verifies the modules hub lists the core modules (incl. Triggers and Text to Speech) under
// "Essentials" and keeps them out of the goal sections below it. SAAS_BROWSER_TOOLS must contain Playwright.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const CORE_LABEL = 'Essentials';
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

    const core = page.getByRole('region', { name: CORE_LABEL, exact: true });
    await core.waitFor();
    // Goal sections (Stream, Chat, Safety, Insights) hold every non-core module.
    const goalSections = page.locator('section.lf-section[aria-labelledby^="modules-goal-"]');
    await goalSections.first().waitFor();
    const moduleNames = (scope) => scope.locator('.lf-mod__name').evaluateAll((els) =>
      els.map((el) => [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()));

    const coreNames = await moduleNames(core);
    assert.deepEqual([...coreNames].sort(), [...CORE_MODULES].sort(), `Essentials lists exactly the core modules at ${width}px`);

    const goalNames = await moduleNames(goalSections);
    for (const name of CORE_MODULES) {
      assert.equal(goalNames.includes(name), false, `${name} should not be repeated in a goal section at ${width}px`);
    }
    assert.ok(goalNames.length > 0, `goal sections list the remaining modules at ${width}px`);

    assert.deepEqual(errors, [], `no browser runtime errors at ${width}px`);
    console.log(`PASS ${width}px: Essentials includes ${MOVED_MODULES.join(', ')} and the other core modules, none repeated below`);
    await context.close();
  }
} finally {
  await browser.close();
}
