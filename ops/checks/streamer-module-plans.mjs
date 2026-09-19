// SAAS_BROWSER_TOOLS must contain Playwright. All external traffic is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const width of [390, 1440]) {
    for (const [viewerTier, targetTier, own] of [
      ...['free', 'premium', 'pro'].flatMap(viewer => ['free', 'premium', 'pro'].map(target => [viewer, target, false])),
      ['free', 'free', true], ['premium', 'premium', true], ['pro', 'pro', true]
    ]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
      const channel = own ? 'viewer' : 'managed';
      const channelID = own ? user.id : '999992';
      const app = { name: 'Viewer', email: 'test@example.invalid', language: 'en', plan_tier: viewerTier,
        actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true,
        up_to_date_permissions: true, administrating: [{ channelID: '999992', channelName: 'managed' }] };
      await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
        version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
        twitchUser: user, appUser: app, permissions: {}
      })), { user, app });
      await context.routeWebSocket(/.*/, ws => ws.close());
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (url.hostname !== 'api.domdimabot.com') return route.abort();
        let data = {};
        if (url.pathname === '/auth/session') data = { twitch: user, app };
        else if (url.pathname.endsWith('/access')) data = { allowed: true, role: own ? 'owner' : 'admin', planTier: targetTier };
        else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
        else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
        else if (url.pathname.startsWith('/rewards/')) data = [];
        else if (url.pathname.startsWith('/eventsubs/')) data = [];
        else if (url.pathname === '/site/events') data = ['premium', 'pro'].map(tier => ({
          name: `${tier} fixture`, type: `channel.fixture.${tier}`, version: '1', plan_tier: tier,
          description: { EN: 'Fixture', ES: 'Fixture' }, config: []
        }));
        return route.fulfill({ json: { error: false, status: 200, data } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/${channel}/modules/clips`);
      const clips = page.locator('app-clips-page');
      await clips.locator('.lf[data-plan]').waitFor();
      assert.equal(await clips.locator('.lf').first().getAttribute('data-plan'), targetTier, `${viewerTier} viewing ${targetTier}`);
      const link = clips.locator('a[target="_blank"]').first();
      assert.match(await link.getAttribute('href'), new RegExp(`/clip/${channelID}\\?`), 'clip URL belongs to viewed streamer');
      assert.equal(await clips.locator('.lf-slide__actions .lf-btn--gold').count(), targetTier === 'free' ? 6 : 0, 'paid clips lock by streamer plan');
      const testRequest = page.waitForRequest(request => request.url().endsWith('/clip/test') && request.method() === 'POST');
      await clips.getByRole('button', { name: 'Test Clip', exact: true }).first().click();
      const clipPayload = (await testRequest).postDataJSON();
      assert.equal(clipPayload.channelID, channelID);
      assert.equal(clipPayload.streamer, channel, 'clip test targets viewed streamer');
      if (!own && targetTier === 'free') await page.screenshot({ path: `/tmp/streamer-plans-${width}.png`, fullPage: true });
      await page.goto(`${base}/${channel}/modules/redemptions`);
      await page.getByRole('button', { name: /create reward/i }).first().click();
      const modal = page.locator('app-create-reward-modal');
      await modal.locator('[formControlName="originalCost"]').waitFor();
      assert.equal(await modal.locator('.lf-premium--locked').count(), targetTier === 'free' ? 1 : 0);
      assert.equal(await modal.locator('[formControlName="originalCost"]').isDisabled(), targetTier === 'free');
      await page.goto(`${base}/${channel}/modules/chat-events`);
      await page.locator('app-event-card').first().waitFor();
      assert.equal(await page.locator('app-event-card .lf-btn--gold').count(), targetTier === 'free' ? 2 : targetTier === 'premium' ? 1 : 0, 'event access follows streamer tier');
      assert.deepEqual(errors, [], 'no browser runtime errors');
      console.log(`PASS ${width}px ${viewerTier} viewer / ${targetTier} ${own ? 'own' : 'managed'} channel`);
      await context.close();
    }
  }
} finally { await browser.close(); }
