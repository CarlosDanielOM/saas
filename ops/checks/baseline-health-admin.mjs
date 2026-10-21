// Isolated preview/candidate only. All API traffic is intercepted; no production writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const screenshots = process.env.SAAS_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.SAAS_CHROMIUM_PATH || undefined });
const iso = (age = 0) => new Date(Date.now() - age).toISOString();
const metric = (kind, name, value, extra = {}) => ({ service: 'cron', kind, name: `follow_defense_baseline_rust.${name}`, channel: '', count: 1,
  average: value, p50: value, p95: value, p99: value, errors: 0, max: value, lastAt: iso(), lastValue: value, ...extra });
const summary = { count: 0, average: null, p50: null, p95: null, p99: null, errors: 0, max: 0 };

function fixture(state, query) {
  const at = iso();
  const atAge = iso(180000);
  const g = (kind, name, value, extra = {}) => metric(kind, name, value, { lastAt: at, ...extra });
  const rows = [g('runtime', 'rss_bytes', 24e6), g('runtime', 'cpu_cores', .05),
    g('queue_run', 'project_batch', 100, { count: 2, errors: 1 }),
    g('queue_run', 'phase.claimMs', 10, { count: 2, errors: 1 }),
    g('queue_run', 'phase.ledgerMs', 50, { count: 2, errors: 1 }),
    g('queue_run', 'phase.streamsMs', 80, { count: 2, errors: 1 }),
    g('queue_run', 'phase.attacksMs', 70, { count: 2, errors: 1 }),
    g('queue_run', 'phase.queueMs', 8),
    g('queue_run', 'phase.rescheduleMs', 6),
    g('queue_run', 'phase.publishMs', 5),
    { ...g('runtime', 'rss_bytes', 30e6), name: 'raid_analytics_rust.rss_bytes' },
    { ...g('worker', 'health_query', 1), name: 'raid_analytics_rust.health_query' },
    { ...g('worker', 'backlog_channels', 0), name: 'raid_analytics_rust.backlog_channels' },
    { ...g('runtime', 'rss_bytes', 32e6), name: 'stream_activity_rust.rss_bytes' },
    { ...g('runtime', 'rss_bytes', 48e6), service: 'api', name: 'index.rss_bytes' }];
  if (state.scenario !== 'legacy') {
    rows.push(g('worker', 'health_query', state.scenario === 'failed' ? 0 : state.scenario === 'mixed' ? .5 : 1,
      state.scenario === 'stale' ? { lastAt: atAge } : {}));
    if (state.scenario !== 'partial') rows.push(g('worker', 'backlog_channels', state.scenario === 'empty' ? 0 : 6,
      ['failed', 'stale', 'backlog-stale'].includes(state.scenario) ? { lastAt: atAge } : state.scenario === 'mismatched' ? { lastAt: iso(10000) } : { count: 3 }));
    rows.push(g('worker', 'oldest_due_age_ms', 120000,
      ['failed', 'stale', 'empty'].includes(state.scenario) ? { lastAt: atAge } : {}));
    if (!['empty', 'partial'].includes(state.scenario)) rows.push(g('worker', 'last_success_age_ms', 45000,
      state.scenario === 'stale' ? { lastAt: atAge } : {}));
    if (state.scenario === 'failed') rows.push(g('worker', 'health_errors', 1, { errors: 1 }));
  }
  if (state.scenario === 'health-only') {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === 'runtime' && rows[i].name.startsWith('follow_defense_baseline_rust.')) rows.splice(i, 1);
  }
  const service = query.get('service');
  return { minutes: 60, generatedAt: at, lastAt: at, http: summary, chat: summary, timeline: [], groups: rows.filter(r => !service || r.service === service) };
}

async function waitFor(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
}

try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: 'dark', hasTouch: width < 600 });
    const state = { scenario: 'due', overviewCalls: 0, mutations: 0 };
    await context.addInitScript(() => {
      localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'baseline-test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: { id: '533538623', login: 'tester', display_name: 'Tester' },
        appUser: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] }, permissions: {} }));
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (!['api.domdimabot.com', 'localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
      assert.equal(request.method(), 'GET', `unexpected mutation ${request.method()} ${url.pathname}`);
      let json = { error: false, status: 200, data: {} };
      if (url.pathname.includes('/observability/api/')) {
        assert.equal(request.headers().authorization, 'Bearer baseline-test-only');
        const name = url.pathname.split('/api/')[1];
        if (name === 'session') json = { grant: { role: 'owner', channels: [], services: [] }, channelNames: {} };
        else if (name === 'overview') { state.overviewCalls++; json = fixture(state, url.searchParams); }
        else if (name === 'resources') json = { samples: [], limited: false };
        else throw new Error(`Unexpected analytics route ${name}`);
      } else if (url.pathname === '/auth/session') json = { error: false, status: 200, data: { twitch: { id: '533538623', login: 'tester', display_name: 'Tester' }, app: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] } } };
      return route.fulfill({ status: 200, json });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/observability?tab=resources');
    const health = page.locator('.obs-baseline-health');
    const fact = label => health.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd > span').first();
    const change = async scenario => {
      state.scenario = scenario;
      const count = state.overviewCalls;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await waitFor(async () => state.overviewCalls > count && !(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled()), `refresh ${scenario}`);
    };
    await health.waitFor();
    const raidHealth = page.locator('.obs-proc').filter({ hasText: 'Raid analytics rust worker' }).locator('.obs-raid-health');
    assert.match(await raidHealth.innerText(), /No channels are due for refresh/, 'raid health remains registered and unchanged');
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
      await change('due');
      await waitFor(async () => (await health.innerText()).includes('Channels are waiting for refresh'), 'due status');
      assert.equal(await fact('Pending channels').innerText(), '≈ 6');
      assert.equal(await fact('Oldest overdue').innerText(), '2.0 min');
      assert.equal(await fact('Last successful baseline').innerText(), '45 s ago at sample');
      assert.match(await page.locator('.obs-proc').filter({ hasText: 'Stream activity rust worker' }).locator('.obs-stream-health').innerText(), /Health unknown/, 'stream health is unknown without health samples');
      await page.addScriptTag({ path: process.env.AXE_PATH || `${tools}/node_modules/axe-core/axe.min.js` });
      const axe = await page.evaluate(() => window.axe.run(document.querySelector('app-observability-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `accessibility ${width}/${theme}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow ${width}/${theme}`);
      if (screenshots) await page.screenshot({ path: `${screenshots}/baseline-health-${width}-${theme}.png`, fullPage: true });

      await change('empty');
      await waitFor(async () => (await health.innerText()).includes('No channels are due for refresh'), 'empty status');
      assert.equal(await fact('Pending channels').innerText(), '≈ 0');
      assert.equal(await fact('Oldest overdue').innerText(), 'None pending');
      assert.equal(await fact('Last successful baseline').innerText(), 'Unknown');
      await change('failed');
      await waitFor(async () => (await health.innerText()).includes('Backlog check failed'), 'failed status');
      assert.equal(await fact('Pending channels').innerText(), 'Unknown');
      assert.equal(await fact('Oldest overdue').innerText(), 'Unknown');
      assert.equal(await fact('Last successful baseline').innerText(), '45 s ago at sample');
      assert.match(await health.innerText(), /Previous sample/);
      await change('mixed');
      await waitFor(async () => (await health.innerText()).includes('mixed query results'), 'mixed probes');
      assert.equal(await fact('Pending channels').innerText(), 'Unknown');
      assert.equal(await fact('Last successful baseline').innerText(), 'Unknown');
      await change('stale');
      await waitFor(async () => (await health.innerText()).includes('Baseline health is stale'), 'stale health despite fresh RSS');
      assert.equal(await fact('Pending channels').innerText(), 'Unknown');
      await change('backlog-stale');
      await waitFor(async () => (await health.innerText()).includes('Pending work is unknown'), 'backlog stale despite fresh check and RSS');
      assert.equal(await fact('Pending channels').innerText(), 'Unknown');
      assert.equal(await fact('Last successful baseline').innerText(), '45 s ago at sample');
      await change('mismatched');
      await waitFor(async () => (await health.innerText()).includes('Pending work is unknown'), 'backlog from a different bucket');
      assert.equal(await fact('Pending channels').innerText(), 'Unknown');
      await change('partial');
      await waitFor(async () => (await health.innerText()).includes('Pending work is unknown'), 'independent unknown backlog');
      assert.equal(await fact('Oldest overdue').innerText(), '2.0 min');
      await change('legacy');
      await waitFor(async () => (await health.innerText()).includes('Baseline health unknown'), 'legacy unknown');
      await change('health-only');
      await waitFor(async () => (await health.innerText()).includes('Channels are waiting for refresh'), 'health without resource samples');
      assert.equal(await health.count(), 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `state overflow ${width}/${theme}`);
    }
    await page.getByRole('button', { name: 'Queues', exact: true }).click();
    const queue = page.locator('.obs-queue').filter({ hasText: 'Follow defense baseline' });
    await queue.waitFor();
    assert.equal(await queue.locator('.obs-queue__jobs').innerText(), '2 jobs', 'phase calls cannot multiply jobs');
    assert.match(await queue.innerText(), /1 failed/);
    assert.equal(await queue.locator('.obs-queue__top .lf-chip').innerText(), '1 failed', 'phase failures cannot multiply failed jobs');
    await queue.getByText('Baseline phase timings', { exact: true }).click();
    assert.match(await queue.innerText(), /Read follow ledger[\s\S]*50 ms[\s\S]*2 measured attempts/);
    assert.match(await queue.innerText(), /Read streams[\s\S]*80 ms/);
    assert.match(await queue.innerText(), /Read attacks[\s\S]*70 ms/);
    assert.match(await queue.innerText(), /run concurrently/);
    assert.match(await queue.innerText(), /do not sum to the batch duration/);
    assert.equal(await queue.locator('.obs-phases dl > div').count(), 7, 'all known phase timings');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByText('1 background job failed', { exact: true }).waitFor();
    assert.equal(await page.locator('.lf-metric').filter({ hasText: 'Failures' }).locator('.lf-metric__value').innerText(), '1', 'phase failures excluded from overall failure total');
    assert.equal(await page.locator('.obs-sink').filter({ hasText: 'phase.' }).count(), 0, 'phase time cannot double count time sinks');
    // URL service filtering remains the existing server-side filter and hides baseline-only data.
    await page.goto(base + '/observability?tab=resources&service=api');
    await page.getByRole('heading', { name: 'Our processes', exact: true }).waitFor();
    assert.equal(await page.locator('.obs-raid-health').count(), 0);
    assert.deepEqual(errors, [], 'no browser errors');
    await context.close();
  }
  console.log('Baseline health: due/empty/failed/mixed/stale/partial/legacy/health-only states, independent and mismatched-bucket freshness, concurrent phase timings and failure totals, service filter, 320/390/1280 dark/light, accessibility and overflow passed.');
} finally { await browser.close(); }
