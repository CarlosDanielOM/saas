import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL || 'https://domdimabot.com';
const portalUrl = 'https://polar.sh/fixture/portal?customer_session_token=fixture';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const twitch = { id: '999991', login: 'fixture', display_name: 'Fixture' };
    const app = {
      name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'premium',
      plan_tier_until: '2027-01-01T00:00:00Z', actived: true, chat_enabled: true,
      twitch_user_id: twitch.id, has_permissions: true, up_to_date_permissions: true, administrating: [],
    };
    await context.addInitScript(({ twitch, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {},
    })), { twitch, app });
    const checkoutBodies = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.origin === 'https://polar.sh') {
        assert.equal(url.href, portalUrl);
        return route.fulfill({ contentType: 'text/html', body: '<title>Plan change fixture</title><h1>Change your existing plan</h1>' });
      }
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch, app };
      else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: 'premium' };
      else if (url.pathname === '/billing/context') data = {
        planTier: 'premium', hasActiveSubscription: true, hasAnySubscriptionHistory: true,
        inactivityMonths: 0, isWinbackEligible: false, scenario: 'upgrade', isReferralEligible: false,
        activeSubscriptionId: 'existing-premium-subscription',
      };
      else if (url.pathname === '/billing/checkout') {
        checkoutBodies.push(route.request().postDataJSON());
        data = { flow: 'customer_portal', checkoutUrl: portalUrl, checkoutId: null,
          portalSessionId: 'fixture-session', scenario: 'upgrade', allowDiscountCodes: false,
          appliedDiscount: { id: null, code: null, reason: null } };
      }
      return route.fulfill({ status: url.pathname === '/billing/checkout' ? 201 : 200,
        json: { error: false, data } });
    });
    const page = await context.newPage();
    await page.goto(`${base}/fixture/profile`);
    await page.locator('app-profile-page').getByRole('button', { name: 'Upgrade to Pro', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Upgrade to Pro', exact: true }).click();
    await page.getByRole('heading', { name: 'Change your existing plan' }).waitFor();
    assert.equal(checkoutBodies.length, 1);
    assert.equal(checkoutBodies[0].targetPlan, 'pro');
    assert.ok(checkoutBodies[0].returnUrl.endsWith('/fixture/profile'));
    assert.equal(new URL(page.url()).hostname, 'polar.sh');
    console.log(`PASS ${width}px profile upgrade follows customer portal response with no checkout ID`);
    await context.close();
  }
} finally {
  await browser.close();
}
