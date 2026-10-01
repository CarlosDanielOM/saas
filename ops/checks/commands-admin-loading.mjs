// Browser regression for delayed admin permissions and synchronous command-cache reads.
// All API requests and WebSockets are isolated fixtures; no production mutations.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4218';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const failure of ['none', 'http', 'network']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const user = { id: '999991', login: 'test', display_name: 'Fixture admin' };
    const target = { id: '451357802', login: 'otherstreamer' };
    const app = { name: 'Test', email: 'test@example.invalid', language: 'en', plan_tier: 'free', actived: true,
      chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true,
      administrating: [{ channelID: target.id, channelName: target.login }] };
    await context.addInitScript(({ user, app }) => {
      localStorage.setItem('userLanguage', 'en');
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
        twitchUser: user, appUser: app, permissions: {} }));
    }, { user, app });
    const counts = { commands: 0, timers: 0, permissions: 0 };
    const errors = [];
    const commands = Array.from({ length: 61 }, (_, index) => ({ _id: 'normal-' + index,
      name: index === 0 ? 'Fixture command' : 'Fixture ' + index, cmd: index === 0 ? 'hormiga' : 'fixture' + index,
      func: 'custom', message: 'Normal', cooldown: 10, userLevel: 1, enabled: true, reserved: false }));
    await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      assert.equal(request.method(), 'GET', 'read-only regression fixtures');
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname === '/users') data = { id: target.id, username: target.login };
      else if (url.pathname.startsWith('/auth/access/')) {
        counts.permissions++;
        // Let the command response populate its cache before the shell saves
        // admin navigation permissions back into the session signal.
        await new Promise(resolve => setTimeout(resolve, 250));
        data = { allowed: true };
      } else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'admin', planTier: 'pro' };
      else if (url.pathname.startsWith('/commands/')) { counts.commands++; data = { commands }; }
      else if (url.pathname.startsWith('/timers/')) {
        counts.timers++;
        if (failure === 'network') return route.abort('failed');
        if (failure === 'http') return route.fulfill({ status: 403, json: { error: true, message: 'Fixture access denied' } });
        data = [{ name: 'hormiga', frequency: 15, message: 'Repeat', active: true }];
      } else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      await route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/' + target.login + '/commands?view=table');
    await page.locator('.lf-code').first().waitFor();
    await page.waitForTimeout(1200);
    console.log(`Observed ${failure} admin requests`, counts);
    assert.equal(counts.commands, 1, 'one command fetch per initial channel load');
    assert.equal(counts.timers, 1, 'permission updates and failed timers must not repeat initial loading');
    assert.equal(counts.permissions, 4, 'route, admin navigation and management permission checks stay bounded');
    const initial = { ...counts };
    // Permission/session refreshes must leave channel data loading alone.
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'dimasite.session.v1' })));
      await page.waitForTimeout(40);
    }
    assert.deepEqual(counts, initial, 'session refreshes do not refetch cached commands or timers');
    await page.locator('.lf-search input').fill('hormiga');
    await page.locator('.lf-view button').nth(1).click();
    await page.locator('.lf-cmd-grid').waitFor();
    await page.locator('.lf-actions button').first().click();
    const modal = page.locator('app-command-modal');
    await modal.getByRole('tab').nth(1).click();
    await modal.locator('#keyword-type-tab[aria-selected="true"]').waitFor();
    assert.equal(await modal.locator('[formControlName="cooldown"]').getAttribute('min'), '1',
      'admin editor uses the target streamer Pro tier rather than the admin Free tier');
    await modal.locator('.lf-modal__close').click();
    await page.waitForTimeout(300);
    assert.deepEqual(counts, initial, 'search, view, and modal changes do not fetch lists');
    // A deliberate reload remains supported and is not an automatic retry.
    await page.locator('.lf-actions button').nth(1).click();
    await page.waitForTimeout(300);
    assert.equal(counts.commands, 2);
    assert.equal(counts.timers, 1);
    assert.deepEqual(errors, []);
    console.log(`PASS admin ${failure}: bounded loading, delayed permissions, target tier, interactions and deliberate reload`);
    await context.close();
  }
} finally { await browser.close(); }
