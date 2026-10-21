/**
 * Current billing credits must agree with channel detail, regardless of receipt
 * totals, pending imports or selected activity dates. All remote traffic is
 * intercepted; this check cannot grant credits or call production services.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE ||
  process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const artifacts = process.env.SAAS_UI_ARTIFACTS || '/tmp/free-credit-display';
await mkdir(artifacts, { recursive: true });
const initial = {
  planTier: 'free',
  credits: { version: 3, used: 10284, limit: 25000, balance: 14716, meterId: 'm',
    updatedAt: '2026-10-21T11:57:00Z', available: true },
  billingPeriod: { source: 'free_monthly', startsAt: '2026-09-22T10:00:00Z',
    endsAt: '2026-10-22T10:00:00Z', from: '2026-09-22', to: '2026-10-22',
    totalDayCount: 30, elapsedDayCount: 30 },
  ledger: { status: 'ready', coverageStart: '2026-09-22' },
  pacing: { status: 'within_pace', averageDailyCredits: 4509, projectedPeriodCredits: 14432,
    remainingPeriodDays: 0.92, forecastRateBasis: 'retention_history',
    expectedToExhaustWithinPeriod: false, estimatedDaysUntilExhaustion: null },
  analytics: { itemizationStartedAt: '2026-09-01T00:00:00Z',
    totalSpentCredits: 135284, averageDailySpentCredits: 4509,
    grantedCredits: 125000, adjustmentDebitedCredits: 0, netConsumedCredits: 10284,
    transactionCount: 1375, daily: [{ date: '2026-10-21', credits: 10284, transactionCount: 128 }],
    categories: [{ category: 'tts', credits: 135284, transactionCount: 1375, percentage: 100 }],
    adjustments: [] },
};
let fixture = structuredClone(initial);
let failCycle = false;
const requests = [];
const errors = [];
const apiOrigins = new Set(['https://api.domdimabot.com', 'http://localhost:3000']);
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.SAAS_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (!apiOrigins.has(url.origin)) return route.abort();
    requests.push({ path: url.pathname, method: req.method(), query: url.search });
    if (req.method() !== 'GET') {
      errors.push(`Unexpected mutation ${req.method()} ${url.pathname}`);
      return route.abort();
    }
    const send = (data, status = 200) => route.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.endsWith('/ai-usage/summary')) {
      if (url.searchParams.has('from')) {
        const custom = structuredClone(fixture);
        custom.billingPeriod.source = 'custom';
        custom.billingPeriod.from = url.searchParams.get('from');
        custom.billingPeriod.to = url.searchParams.get('to');
        // Even an older response must not replace the freshly fetched current snapshot.
        Object.assign(custom.credits, { balance: 1, used: custom.credits.limit - 1 });
        custom.pacing = null;
        Object.assign(custom.analytics, { totalSpentCredits: 83, grantedCredits: 0, transactionCount: 1 });
        return send({ error: false, data: custom });
      }
      return failCycle ? send({ error: true, message: 'Fixture cycle unavailable' }, 503)
        : send({ error: false, data: fixture });
    }
    if (url.pathname.endsWith('/ai-usage/transactions'))
      return send({ error: false, data: { items: [], nextCursor: null } });
    if (url.pathname.endsWith('/ai-credits')) return send({ error: false, data: fixture.credits });
    if (url.pathname === '/admin-site/users') return send({ data: { rows: [{
      channelID: '1050106737', channel: 'free-fixture', plan_tier: fixture.planTier,
      actived: true, has_permissions: true, up_to_date_permissions: true, chat_enabled: true,
    }] } });
    if (url.pathname.startsWith('/triggers/files/')) return send({ data: { files: [] } });
    if (url.pathname.endsWith('/commands') || url.pathname.endsWith('/eventsubs'))
      return send({ data: { rows: [], pagination: { total: 0, page: 1, limit: 1, totalPages: 1 } } });
    for (const resource of ['rewards', 'triggers', 'timers', 'files', 'memories']) {
      if (url.pathname.startsWith(`/${resource}/`)) return send({ data: { [resource]: [] } });
    }
    if (url.pathname === '/users') return send({ data: {} });
    errors.push(`Unmocked API request ${url.pathname}`);
    return route.abort();
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2,
      token: 'disposable-ui-fixture', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Fixture' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
    window.EventSource = class { close() {} };
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
  await page.goto(`${base}/channels/1050106737`);
  await page.locator('.credit-usage__progress').waitFor();
  assert.match(await page.locator('.credit-usage__label').textContent(), /14\.7K/);
  await open();
  assert.match(await balance.textContent(), /14\.7K/, 'usage must show the same 14,716 credits as channel detail, even with 135,284 recorded spend and 125,000 grants');
  assert.match(await balance.textContent(), /10,284 used of 25,000/);
  assert.equal(await balance.getByRole('progressbar').getAttribute('aria-valuenow'), '41');
  assert.match(await metrics.locator('article').nth(1).textContent(), /135\.3K/);
  assert.match(await forecast.textContent(), /On track for this period/);
  assert.match(await forecast.textContent(), /4,509 credits a day/);
  assert.equal((await projected.locator('strong').textContent()).trim(), '14.4K', 'forecast comes from API pacing');
  assert.doesNotMatch(await balance.textContent(), /Estimated/);
  assert.deepEqual(fixture, initial, 'the display must not mutate the API snapshot');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => localStorage.setItem('dima-admin.mode.v1', theme), theme);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await open();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark');
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${theme} ${width} must not overflow`);
      if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: axePath });
      const accessibility = await page.evaluate(() => window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      }));
      assert.deepEqual(accessibility.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
        [], `${theme} ${width} accessibility`);
      await page.screenshot({ path: `${artifacts}/${theme}-${width}.png`, fullPage: true });
    }
  }
  // Activity dates change receipts, while balance and forecast stay current.
  async function customRange() {
    await page.locator('.us-range summary').click();
    await page.locator('.usage-range input').nth(0).fill('2026-10-12');
    await page.locator('.usage-range input').nth(1).fill('2026-10-13');
    await page.getByRole('button', { name: 'Show these dates' }).click();
    await page.getByText('Spent in range', { exact: true }).waitFor();
    assert.match(await metrics.locator('article').nth(1).textContent(), /83/);
  }
  await customRange();
  assert.match(await balance.textContent(), /14\.7K/, 'custom activity dates preserve current credits');
  assert.equal((await projected.locator('strong').textContent()).trim(), '14.4K');
  failCycle = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture cycle unavailable' }).waitFor();
  failCycle = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await metrics.waitFor();
  assert.match(await balance.textContent(), /14\.7K/);
  await page.getByRole('button', { name: 'Back to current period' }).click();
  await page.getByText('Spent this period', { exact: true }).waitFor();
  fixture.analytics.grantedCredits = 999999;
  fixture.analytics.adjustmentDebitedCredits = 500000;
  await open();
  assert.match(await balance.textContent(), /14\.7K/, 'receipt grants and debits never recalculate spendable credits');
  fixture = structuredClone(initial);
  fixture.ledger.status = 'pending';
  await open();
  assert.match(await balance.textContent(), /14\.7K/, 'pending receipt import does not hide the current balance');
  assert.match(await forecast.textContent(), /On track for this period/);
  await page.locator('.usage-sync').waitFor();
  fixture = structuredClone(initial);
  fixture.credits.available = false;
  fixture.pacing = null;
  await open();
  assert.match(await forecast.textContent(), /No credit account yet/);
  assert.equal((await balance.locator('strong').textContent()).trim(), '—');
  fixture = structuredClone(initial);
  Object.assign(fixture.credits, { used: 25000, balance: 0 });
  Object.assign(fixture.pacing, { status: 'exhausted', estimatedDaysUntilExhaustion: 0 });
  await open();
  assert.equal((await balance.locator('strong').textContent()).trim(), '0');
  assert.match(await forecast.textContent(), /Out of credits/);
  // A missing forecast cannot hide actual exhaustion.
  fixture.pacing = null;
  await open();
  assert.match(await forecast.textContent(), /Out of credits/);
  fixture = structuredClone(initial);
  fixture.pacing = null;
  await open();
  assert.match(await balance.textContent(), /14\.7K/);
  assert.match(await forecast.textContent(), /Not enough history/);
  assert.equal((await projected.locator('strong').textContent()).trim(), '—');
  fixture = structuredClone(initial);
  Object.assign(fixture.pacing, { status: 'over_pace', expectedToExhaustWithinPeriod: true,
    estimatedDaysUntilExhaustion: 0.5, averageDailyCredits: 29432 });
  await open();
  assert.match(await forecast.textContent(), /On pace to run out/);
  assert.doesNotMatch(await forecast.textContent(), /Out of credits|fully used/);
  fixture = structuredClone(initial);
  Object.assign(fixture.credits, { used: 0, balance: 25000 });
  Object.assign(fixture.pacing, { status: 'no_usage', averageDailyCredits: 0, projectedPeriodCredits: 0 });
  await open();
  assert.match(await balance.textContent(), /25K/);
  assert.match(await forecast.textContent(), /No AI usage lately/, 'receipt history cannot override current billing pacing');
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
    await customRange();
    assert.match(await balance.textContent(), new RegExp(left.replace('.', '\\.')), `${tier} custom range keeps current snapshot`);
    assert.equal((await projected.locator('strong').textContent()).trim(), '31K');
  }
  assert.ok(requests.some(r => r.path.endsWith('/ai-usage/summary') && r.query.includes('from=')));
  assert.ok(requests.every(r => r.method === 'GET'), 'only mocked read-only requests');
  assert.deepEqual(errors, [], 'no browser runtime errors or unexpected API calls');
  console.log(`PASS: matching channel/usage current credits; receipt mismatch, pending ledger, grants/debits, custom dates for all tiers, failed cycle retry, unavailable/zero/exhausted/no pacing/no usage/over pace, API forecasts; axe + no overflow dark/light 320/390/1280. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
