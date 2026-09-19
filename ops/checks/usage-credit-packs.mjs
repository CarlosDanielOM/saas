import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217';
const definitions = [
  ['45c32959-3fa2-41a6-855c-bbeafcf9ce3c', 'credits', 'sample', 40_000, 100],
  ['2f446a84-69a9-42f6-96ed-6be2b31fdf0c', 'credits', 'starter', 250_000, 500],
  ['4315e89b-bf47-4ddd-a889-e6be6056853d', 'credits', 'medium', 550_000, 1_000],
  ['44d391d1-8952-408d-ad51-06200404d3ad', 'recharge', 'small', 110_000, 200],
  ['44a6baba-e057-4af7-82c4-ec8ddd528913', 'recharge', 'starter', 325_000, 500],
  ['ac85860a-dee1-4399-9c32-932229d112c1', 'recharge', 'medium', 699_984, 1_000]
];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [tier, overage, expected, catalogFails, inactive] of [
    ['free', 100000, definitions[1][0]],
    ['premium', 100000, definitions[3][0]],
    ['pro', 100000, definitions[3][0]],
    ['premium', 100000, definitions[1][0], false, true],
    ['free', 30000, definitions[0][0]],
    ['premium', 110001, definitions[1][0]],
    ['free', 0, null], ['premium', 900000, null],
    ['premium', 100000, null, true]
  ]) {
    const context = await browser.newContext();
    const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };
    const app = {
      name: 'Test Streamer', email: 'test@example.invalid', language: 'en', plan_tier: tier,
      actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true,
      up_to_date_permissions: true, administrating: []
    };
    await context.addInitScript(({ twitch, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch,
      appUser: app, permissions: {}
    })), { twitch, app });
    const offers = definitions.map(([id, kind, size, credits, priceAmount]) => ({
      id, kind, size, credits, priceAmount, priceCurrency: 'usd', name: `${size} ${kind}`,
      rollover: kind === 'credits', eligible: kind === 'credits' || tier !== 'free',
      eligibilityReason: kind === 'recharge' && tier === 'free' ? 'paid_plan_required' : null
    }));
    let purchases = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch, app };
      else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
      else if (url.pathname === '/billing/credit-packs') {
        if (catalogFails) return route.fulfill({ status: 503, json: { error: true } });
        data = { planTier: tier, hasActivePaidSubscription: tier !== 'free' && !inactive,
          rechargeExpiresAt: '2026-09-26T12:00:00.000Z', rechargeExpiryDays: 7, offers };
      } else if (url.pathname.endsWith('/checkout')) purchases++;
      else if (url.pathname === '/billing/ai-usage/summary') data = {
        planTier: tier, capabilities: { balance: true, pacing: true, dailySpend: false, categoryBreakdown: false, transactions: false },
        credits: { available: true, used: 50000, limit: 100000, balance: 50000, status: 'active' },
        billingPeriod: { source: tier === 'free' ? 'free_monthly' : 'subscription', startsAt: '2026-09-01', endsAt: '2026-10-01', from: '2026-09-01', to: '2026-09-30', totalDayCount: 30, elapsedDayCount: 15 },
        pacing: { status: overage > 0 ? 'over_pace' : 'within_pace', forecastBasis: 'current_billing_period', projectedPeriodCredits: 100000 + overage, projectedOverageCredits: overage, averageDailyCredits: 5000, dailyCreditsToLastPeriod: 3000, estimatedDaysUntilExhaustion: 10 }, analytics: null
      };
      return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/test/usage`);
    const usage = page.locator('app-usage-page');
    await usage.locator('.lf-balance__store').waitFor();
    const recommendation = usage.locator('.lf-recommendation');
    if (expected) {
      await recommendation.waitFor();
      assert.ok((await recommendation.locator('a').getAttribute('href')).includes(expected));
      if (overage === 100000) assert.ok((await recommendation.innerText()).includes(tier === 'free' || inactive ? '$5' : '$2'));
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), width === 390);

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
        if (overage === 100000) await page.screenshot({ path: `/tmp/usage-pack-${tier}-${width}.png`, fullPage: true });
      }
      const axe = await new AxeBuilder({ page }).include('.lf-recommendation').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(axe.violations.map(v => v.id), []);
      await recommendation.locator('a').click();
      const badge = page.locator('app-credit-packs-page .lf-pack-card').filter({ hasText: 'Recommended for your projected usage' });
      await badge.waitFor();
      assert.equal(await badge.count(), 1);
      assert.ok((await badge.innerText()).includes(tier !== 'free' && !inactive && overage === 100000 ? '$2' : overage === 30000 ? '$1' : '$5'));
      assert.equal(purchases, 0, 'recommendation navigation must not start checkout');
    } else {
      await page.waitForTimeout(300);
      assert.equal(await recommendation.count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS usage pack recommendations: free/premium/pro, thresholds, no overage, oversized shortfall, catalog failure, store selection, responsive layouts, accessibility');
} finally { await browser.close(); }
