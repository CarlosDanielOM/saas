import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE ||
  '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const artifacts = '/tmp/free-credit-display';
await mkdir(artifacts, { recursive: true });
const now = Date.now();
const day = 86400000;
const initial = {
  planTier: 'free',
  credits: { version: 3, used: 0, limit: 25000, balance: 25000, meterId: 'm',
    updatedAt: new Date(now).toISOString(), available: true },
  billingPeriod: { source: 'free_monthly', startsAt: new Date(now - 2 * day).toISOString(),
    endsAt: new Date(now + 29 * day).toISOString(), from: '2026-10-12', to: '2026-11-11',
    totalDayCount: 31, elapsedDayCount: 3 },
  ledger: { status: 'ready', coverageStart: '2026-10-12' },
  pacing: { status: 'no_usage', averageDailyCredits: 0, projectedPeriodCredits: 0,
    remainingPeriodDays: 29, forecastRateBasis: 'current_cycle', estimatedDaysUntilExhaustion: null },
  analytics: { itemizationStartedAt: '2026-09-01T00:00:00Z',
    totalSpentCredits: 10727, averageDailySpentCredits: 3575.67,
    grantedCredits: 25000, adjustmentDebitedCredits: 0, netConsumedCredits: -14273,
    transactionCount: 128, daily: [{ date: '2026-10-12', credits: 10727, transactionCount: 128 }],
    categories: [{ category: 'tts', credits: 10415, transactionCount: 124, percentage: 97.1 },
      { category: 'ai_chat', credits: 218, transactionCount: 3, percentage: 2.03 },
      { category: 'memory', credits: 94, transactionCount: 1, percentage: 0.87 }], adjustments: [] },
};
let fixture = structuredClone(initial);
let failCycle = false;
const requests = [];
const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    requests.push({ path: url.pathname, method: req.method(), query: url.search });
    assert.equal(req.method(), 'GET', 'display must never mutate a remote service');
    const send = (data, status = 200) => route.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.endsWith('/ai-usage/summary')) {
      if (url.searchParams.has('from')) {
        const custom = structuredClone(fixture);
        custom.billingPeriod.source = 'custom';
        Object.assign(custom.analytics, { totalSpentCredits: 83, grantedCredits: 0, transactionCount: 1 });
        return send({ error: false, data: custom });
      }
      return failCycle ? send({ error: true, message: 'Fixture cycle unavailable' }, 503)
        : send({ error: false, data: fixture });
    }
    if (url.pathname.endsWith('/ai-usage/transactions'))
      return send({ error: false, data: { items: [], nextCursor: null } });
    if (url.pathname === '/admin-site/users') return send({ data: { rows: [{
      channelID: '1050106737', channel: 'free-fixture', plan_tier: fixture.planTier,
    }] } });
    if (url.pathname === '/users') return send({ data: {} });
    return route.abort();
  });
  await context.addInitScript(() => {
    localStorage.setItem('dima-admin.mode.v1', 'dark');
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2,
      token: 'disposable-ui-fixture', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Fixture' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const metrics = page.locator('.usage-metrics');
  const balance = metrics.locator('article').nth(0);
  const projected = metrics.locator('article').nth(2);
  const forecast = page.locator('.us-forecast');
  const open = async () => {
    await page.goto(`${base}/channels/1050106737/usage`);
    await metrics.waitFor();
  };
  await open();
  assert.match(await balance.textContent(), /14\.3K/, 'Free credits left must reflect 25,000 minus 10,727');
  assert.match(await balance.textContent(), /10,727 used of 25,000/);
  assert.equal(await balance.getByRole('progressbar').getAttribute('aria-valuenow'), '43');
  assert.doesNotMatch(await forecast.textContent(), /No AI usage lately/);
  assert.notEqual((await projected.locator('strong').textContent()).trim(), '0');
  assert.deepEqual(fixture, initial, 'display projection does not mutate the API snapshot');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.setAttribute('data-theme', theme);
    }, theme);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${theme} ${width} must not overflow`);
      await page.screenshot({ path: `${artifacts}/${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.locator('.us-range summary').click();
  await page.locator('.usage-range input').nth(0).fill('2026-10-12');
  await page.locator('.usage-range input').nth(1).fill('2026-10-13');
  await page.getByRole('button', { name: 'Show these dates' }).click();
  await page.getByText('Spent in range', { exact: true }).waitFor();
  assert.match(await metrics.locator('article').nth(1).textContent(), /83/);
  assert.match(await balance.textContent(), /14\.3K/, 'a custom range cannot replace the current balance');
  assert.match(await balance.textContent(), /10,727 used/);
  failCycle = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture cycle unavailable' }).waitFor();
  failCycle = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await metrics.waitFor();
  assert.match(await balance.textContent(), /14\.3K/);
  await page.getByRole('button', { name: 'Back to current period' }).click();
  await page.getByText('Spent this period', { exact: true }).waitFor();
  fixture.analytics.grantedCredits = 35000;
  fixture.analytics.netConsumedCredits = -24273;
  await open();
  assert.match(await balance.textContent(), /24\.3K/);
  assert.match(await balance.textContent(), /10,727 used of 35,000/);
  fixture.analytics.adjustmentDebitedCredits = 1000;
  await open();
  assert.match(await balance.textContent(), /23\.3K/, 'debit adjustments reduce the estimate');
  fixture = structuredClone(initial);
  fixture.ledger.status = 'pending';
  await open();
  assert.doesNotMatch(await balance.textContent(), /25K|0 used/);
  assert.match(await forecast.textContent(), /sync/i);
  fixture = structuredClone(initial);
  fixture.credits.available = false;
  await open();
  assert.match(await forecast.textContent(), /No credit account yet/);
  fixture = structuredClone(initial);
  fixture.analytics.totalSpentCredits = 26000;
  await open();
  assert.equal((await balance.locator('strong').textContent()).trim(), '0');
  assert.match(await forecast.textContent(), /allowance.*used/i);
  assert.doesNotMatch(await forecast.textContent(), /paused/, 'a visual estimate cannot claim billing enforcement');
  fixture = structuredClone(initial);
  fixture.analytics.totalSpentCredits = 0;
  await open();
  assert.match(await balance.textContent(), /25K/);
  assert.match(await forecast.textContent(), /No AI usage lately/);
  fixture = structuredClone(initial);
  Object.assign(fixture.pacing, { forecastRateBasis: 'retention_history', averageDailyCredits: 200,
    projectedPeriodCredits: 5800 });
  await open();
  assert.match(await forecast.textContent(), /200 credits a day/);
  for (const [tier, limit, used, left] of [['premium', 200000, 43945, '156.1K'], ['pro', 800000, 176862, '623.1K']]) {
    fixture = structuredClone(initial);
    fixture.planTier = tier;
    fixture.billingPeriod.source = 'subscription';
    Object.assign(fixture.credits, { used, limit, balance: limit - used });
    Object.assign(fixture.pacing, { status: 'within_pace', averageDailyCredits: 1000, projectedPeriodCredits: 31000 });
    await open();
    assert.match(await balance.textContent(), new RegExp(left.replace('.', '\\.')));
    assert.doesNotMatch(await balance.textContent(), /Estimated/);
    assert.equal((await projected.locator('strong').textContent()).trim(), '31K');
  }
  assert.ok(requests.some(r => r.path.endsWith('/ai-usage/summary') && r.query.includes('from=')));
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(`PASS: Free estimate, forecast, grants/debits, custom dates, failed cycle retry, pending/no account/zero/exhausted/history, unchanged Premium/Pro; dark/light 320/390/1280. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
