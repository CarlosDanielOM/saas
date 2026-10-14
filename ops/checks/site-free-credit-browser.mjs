import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire('/tmp/saas-cooldown-browser/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const artifacts = '/tmp/site-free-credit-display';
await mkdir(artifacts, { recursive: true });
const now = Date.now();
const day = 86400000;
const raw = { version: 3, used: 0, limit: 25000, balance: 25000, meterId: 'm',
  updatedAt: new Date(now).toISOString(), available: true, status: 'available' };
const display = { estimated: true, credits: { ...raw, used: 10727, balance: 14273 },
  pacing: { status: 'over_pace', averageDailyCredits: 5363.5, projectedPeriodCredits: 166269,
    projectedQuotaUsedPercent: 665.08, projectedOverageCredits: 141269, remainingPeriodDays: 29,
    dailyCreditsToLastPeriod: 492.17, expectedToExhaustWithinPeriod: true,
    estimatedDaysUntilExhaustion: 2.7, estimatedExhaustionAt: new Date(now + 2.7 * day).toISOString(),
    quotaUsedPercent: 42.91, forecastBasis: 'current_free_credit_period' } };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const smoke = process.argv.includes('--smoke');
try {
  const cases = smoke ? [['free', 'en']] : [['free', 'en'], ['free', 'es'], ['premium', 'en'], ['pro', 'en']];
  for (const [tier, language] of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer', profile_image_url: '' };
    const app = { name: 'Test Streamer', email: 'test@example.invalid', language, plan_tier: tier,
      actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true,
      up_to_date_permissions: true, administrating: [] };
    const credits = tier === 'free' ? { ...raw, display: structuredClone(display) }
      : { ...raw, used: tier === 'premium' ? 43945 : 176862,
        limit: tier === 'premium' ? 200000 : 800000, balance: tier === 'premium' ? 156055 : 623138 };
    const summary = { planTier: tier,
      capabilities: { balance: true, pacing: true, dailySpend: false, categoryBreakdown: false, transactions: false },
      credits: tier === 'free' ? structuredClone(raw) : credits,
      creditDisplay: tier === 'free' ? structuredClone(display) : undefined,
      billingPeriod: { source: tier === 'free' ? 'free_monthly' : 'subscription',
        startsAt: new Date(now - 2 * day).toISOString(), endsAt: new Date(now + 29 * day).toISOString(),
        from: new Date(now - 2 * day).toISOString().slice(0, 10), to: new Date(now + 29 * day).toISOString().slice(0, 10),
        totalDayCount: 31, elapsedDayCount: 3, endExclusive: true },
      pacing: { ...display.pacing, status: tier === 'free' ? 'no_usage' : 'within_pace',
        averageDailyCredits: tier === 'free' ? 0 : 1000, projectedPeriodCredits: tier === 'free' ? 0 : 31000,
        expectedToExhaustWithinPeriod: false, estimatedDaysUntilExhaustion: null }, analytics: null };
    const requests = [];
    const errors = [];
    await context.addInitScript(({ twitch, app, language }) => {
      localStorage.setItem('theme', 'dark');
      localStorage.setItem('userLanguage', language);
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'test-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: twitch, appUser: app, permissions: {} }));
    }, { twitch, app, language });
    await context.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (!['api.domdimabot.com', 'localhost'].includes(url.hostname)) return route.abort();
      requests.push({ method: req.method(), path: url.pathname });
      assert.equal(req.method(), 'GET', 'this check must never mutate a remote service');
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch, app };
      else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier,
        channelID: twitch.id, channelName: 'Test Streamer' };
      else if (url.pathname === '/users') data = { id: twitch.id, username: 'test', profile_image_url: '' };
      else if (url.pathname.endsWith('/bootstrap')) data = { role: 'owner',
        channel: { id: twitch.id, name: 'test', chatEnabled: true }, isLive: false,
        liveStream: null, liveSession: null, totalFollowers: 0, totalSubs: 0, trend: [], streamHistory: [],
        monthlyGoals: { followersGoal: 0, followersCurrent: 0, subsGoal: 0, subsCurrent: 0 },
        kpis: { activeViewers: 0, averageViewers: 0, monthlyAverageViewers: 0,
          averageHoursPerStream: 0, totalBits: 0, totalStreams: 0, totalDonations: 0,
          activeFollows: 0, activeSubs: 0, monthlyGoalSubs: 0, subsProgressPct: 0 } };
      else if (url.pathname.endsWith('/live-status')) data = { isLive: false, stream: null, liveSession: null };
      else if (url.pathname === '/billing/ai-credits') data = credits;
      else if (url.pathname === '/billing/ai-usage/summary') data = summary;
      else if (url.pathname === '/billing/credit-packs') data = { planTier: tier,
        hasActivePaidSubscription: tier !== 'free', rechargeExpiryDays: null, offers: [{
          id: '45c32959-3fa2-41a6-855c-bbeafcf9ce3c', kind: 'credits', size: 'sample',
          credits: 40000, priceAmount: 100, priceCurrency: 'usd', name: 'Sample credits',
          rollover: true, eligible: true, eligibilityReason: null }] };
      else if (url.pathname.startsWith('/clip-recommendations/')) {
        if (url.pathname.endsWith('/config')) data = { planTier: tier,
          autoAnalyzeEnabled: false, canAutoAnalyze: tier === 'pro',
          pricing: { baseCredits: 2750, baseMinutes: 60, extraCreditsPerMinute: 50 } };
        else if (url.pathname.endsWith('/vods')) data = { days: 7, vods: [{ id: 'fixture-vod',
          title: 'Fixture stream', duration: '6h40m', durationMinutes: 400,
          createdAt: new Date(now).toISOString(), url: '', thumbnailUrl: '' }] };
        else data = { items: [], total: 0 };
      }
      return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const checkLayout = async (selector, name) => {
      if (smoke) return;
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          document.documentElement.setAttribute('data-theme', theme);
        }, theme);
        for (const width of [320, 390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${name}/${tier}/${language}/${theme}/${width} overflow`);
          if (width === 390) {
            const axe = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
            assert.deepEqual(axe.violations.map(v => v.id), [], `${name} ${theme} credit display accessibility: ${JSON.stringify(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })))}`);
          }
          if (tier === 'free') await page.screenshot({ path: `${artifacts}/${name}-${language}-${theme}-${width}.png`, fullPage: true });
        }
      }
    };
    const expectedUsed = tier === 'free' ? /10[.,]7/i : tier === 'premium' ? /43\.9K/i : /176\.9K/i;
    await page.goto(`${base}/test/dashboard`);
    const dashboard = page.locator('app-dashboard .lf-ai');
    await dashboard.locator('.lf-value').waitFor();
    await page.waitForFunction(() => document.querySelector('app-dashboard .lf-ai .lf-bar span')?.getAttribute('style')?.includes('width'));
    assert.match(await dashboard.textContent(), expectedUsed, 'dashboard must use display spending rather than raw zero usage');
    if (tier === 'free') assert.match(await dashboard.textContent(), language === 'en' ? /estimated/ : /estimados/);
    await checkLayout('app-dashboard .lf-ai', 'dashboard');
    await page.goto(`${base}/test/usage`);
    const usage = page.locator('app-usage-page');
    await usage.locator('.lf-meter').waitFor();
    const hero = usage.locator('.lf-hero');
    const expectedLeft = tier === 'free' ? (language === 'en' ? /14\.3K/ : /14,3/) : tier === 'premium' ? /156\.1K/ : /623\.1K/;
    assert.match(await hero.textContent(), expectedLeft);
    assert.match(await hero.textContent(), expectedUsed);
    assert.doesNotMatch(await hero.textContent(), /No AI usage yet|Aún no hay uso de IA/);
    if (tier === 'free') assert.equal(await hero.locator('.lf-meter__fill').evaluate(el => el.style.width), '43%');
    await checkLayout('app-usage-page .lf-hero', 'usage');
    await page.goto(`${base}/test/credits`);
    const store = page.locator('app-credit-packs-page .lf-balance');
    await store.waitFor();
    assert.match(await store.textContent(), expectedLeft);
    if (tier === 'free') assert.match(await store.textContent(), language === 'en' ? /Estimated/ : /estimados/);
    if (tier === 'free') await page.locator('app-credit-packs-page .lf-pack__facts')
      .getByText(language === 'en' ? '≈ 7 days at your pace' : '≈ 7 días a tu ritmo').waitFor();
    await checkLayout('app-credit-packs-page .lf-balance', 'store');
    await page.goto(`${base}/test/modules/clip-recommendations`);
    const clip = page.locator('app-clip-recommendations-page');
    const chip = clip.locator('.lf-head a.lf-chip--link');
    await chip.waitFor();
    assert.match(await chip.textContent(), tier === 'free' ? /14[.,]273/ : tier === 'premium' ? /156[.,]055/ : /623[.,]138/);
    await checkLayout('app-clip-recommendations-page .lf-head', 'clips');
    if (tier === 'free') {
      await clip.locator('.lf-vod button').click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      // This VOD costs 19,750: greater than the estimate but less than the unchanged raw 25K.
      assert.equal(await dialog.locator('button.lf-btn--primary').count(), 1,
        'the separate visual estimate must not change clip affordability controls');
      assert.match(await dialog.textContent(), /14[.,]273/);
      await page.keyboard.press('Escape');
      credits.display = { estimated: true, credits: null };
      summary.creditDisplay = { estimated: true, credits: null, pacing: null };
      await page.goto(`${base}/test/usage`);
      await usage.getByText(language === 'en' ? 'Credit history is syncing.' : 'Se está sincronizando el historial de créditos.').waitFor();
      assert.equal(await usage.locator('.lf-meter').count(), 0, 'pending history must not show a full balance');
      delete credits.display;
      delete summary.creditDisplay;
      await page.goto(`${base}/test/dashboard`);
      await dashboard.getByText(language === 'en' ? 'Credit history is syncing.' : 'Se está sincronizando el historial de créditos.').waitFor();
      assert.equal(await dashboard.locator('.lf-bar').count(), 0, 'old API data must not reintroduce zero spending');
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.ok(requests.every(r => r.method === 'GET'));
    await context.close();
  }
  console.log(smoke
    ? 'PASS: live public bundle shows Free estimates on dashboard/usage/store/clips, preserves clip affordability, and handles pending/old API data'
    : `PASS: public dashboard/usage/store/clips use Free estimates; unchanged clip affordability and paid balances; pending/old API fallback, EN/ES, dark/light 320/390/1280 and credit-region axe. Screenshots: ${artifacts}`);
} finally { await browser.close(); }
