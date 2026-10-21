// Isolated preview/candidate only. API requests are mocked; no real credentials or writes.
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
const summary = { count: 0, average: null, p50: null, p95: null, p99: null, errors: 0, max: 0 };
const iso = (age = 0) => new Date(Date.now() - age).toISOString();

function fixture(state, query) {
  const at = iso(), previous = iso(10000), stale = iso(180000);
  const g = (kind, name, value, extra = {}) => ({ service: 'cron', kind, name: `stream_activity_rust.${name}`, channel: '', count: 1,
    average: value, p50: value, p95: value, p99: value, errors: 0, max: value, lastAt: at, lastValue: value, ...extra });
  const rows = [g('runtime', 'rss_bytes', 24e6), g('runtime', 'cpu_cores', .05),
    g('queue_run', 'project_batch', 100, { count: 2, errors: 1 }),
    { ...g('runtime', 'rss_bytes', 48e6), service: 'api', name: 'index.rss_bytes' },
    { ...g('worker', 'health_query', 1), name: 'raid_analytics_rust.health_query' },
    { ...g('worker', 'backlog_channels', 0), name: 'raid_analytics_rust.backlog_channels' },
    { ...g('worker', 'health_query', 1), name: 'follow_defense_baseline_rust.health_query' },
    { ...g('worker', 'backlog_channels', 6), name: 'follow_defense_baseline_rust.backlog_channels' }];
  const scenario = state.scenario;
  if (scenario !== 'legacy') {
    rows.push(g('worker', 'health_query', scenario === 'failed' || scenario === 'failed-no-success' ? 0 : scenario === 'mixed' ? .5 : 1,
      scenario === 'stale' ? { lastAt: stale } : {}));
    if (scenario !== 'partial') rows.push(g('worker', 'pending_work', ['empty', 'restart'].includes(scenario) ? 0 : scenario === 'pending-mixed' ? .5 : 1,
      ['failed', 'stale', 'gauges-stale'].includes(scenario) ? { lastAt: stale } : scenario === 'mismatched' ? { lastAt: previous } : { count: 3 }));
    rows.push(g('worker', 'oldest_pending_age_ms', 120000,
      ['failed', 'stale', 'gauges-stale'].includes(scenario) ? { lastAt: stale } : {}));
    if (!['partial', 'missing-checkpoint'].includes(scenario)) rows.push(g('worker', 'checkpoint_seq', ['empty', 'restart'].includes(scenario) ? 0 : 123,
      ['failed', 'stale', 'gauges-stale'].includes(scenario) ? { lastAt: stale } : scenario === 'mismatched' ? { lastAt: previous } : {}));
    if (scenario !== 'partial') rows.push(g('worker', 'active_batch_events', ['empty', 'restart'].includes(scenario) ? 0 : 8,
      ['stale', 'gauges-stale'].includes(scenario) ? { lastAt: stale } : {}));
    if (!['empty', 'failed-no-success'].includes(scenario)) rows.push(g('worker', 'last_success_age_ms', 45000,
      ['stale', 'restart'].includes(scenario) ? { lastAt: stale } : {}));
    if (['failed', 'failed-no-success'].includes(scenario)) rows.push(g('worker', 'health_errors', 1, { errors: 1 }));
  }
  if (scenario === 'health-only') {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === 'runtime' && rows[i].name.startsWith('stream_activity_rust.')) rows.splice(i, 1);
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
    const state = { scenario: 'pending', overviewCalls: 0, apiCalls: 0 };
    await context.addInitScript(() => {
      localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'stream-test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: { id: '533538623', login: 'tester', display_name: 'Tester' },
        appUser: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] }, permissions: {} }));
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const analytics = url.pathname.includes('/observability/api/');
      const auth = url.pathname === '/auth/session';
      if (url.origin === origin && !analytics && !auth) return route.continue();
      if (!['api.domdimabot.com', 'localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
      state.apiCalls++;
      assert.equal(request.method(), 'GET', `unexpected mutation ${request.method()} ${url.pathname}`);
      let json = { error: false, status: 200, data: {} };
      if (analytics) {
        assert.equal(request.headers().authorization, 'Bearer stream-test-only');
        const name = url.pathname.split('/api/')[1];
        if (name === 'session') json = { grant: { role: 'owner', channels: [], services: [] }, channelNames: {} };
        else if (name === 'overview') { state.overviewCalls++; json = fixture(state, url.searchParams); }
        else if (name === 'resources') json = { samples: [], limited: false };
        else throw new Error(`Unexpected analytics route ${name}`);
      } else if (auth) json = { error: false, status: 200, data: { twitch: { id: '533538623', login: 'tester', display_name: 'Tester' }, app: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] } } };
      return route.fulfill({ status: 200, json });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(base + '/observability?tab=resources');
    const health = page.locator('.obs-stream-health');
    const fact = label => health.locator('dl > div').filter({ has: page.locator('dt', { hasText: label, exact: true }) }).locator('dd > span').first();
    const change = async (scenario, status) => {
      state.scenario = scenario;
      const count = state.overviewCalls;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await waitFor(async () => state.overviewCalls > count && !(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled()), `refresh ${scenario}`);
      await waitFor(async () => (await health.innerText()).includes(status), `${scenario} status`);
    };
    const checkFact = async (label, value) => {
      // Responses can arrive before the zoneless render, and adjacent scenarios may share a status.
      await waitFor(async () => (await fact(label).innerText()) === value, `${state.scenario}: ${label} = ${value}`);
      assert.equal(await fact(label).innerText(), value, `${state.scenario}: ${label}`);
    };
    await health.waitFor();
    assert.match(await page.locator('.obs-raid-health:not(.obs-baseline-health) > summary').innerText(), /No channels are due for refresh/);
    assert.match(await page.locator('.obs-baseline-health').innerText(), /Channels are waiting for refresh/);
    const isOpen = () => health.evaluate(element => element.open);
    const toggle = health.locator('summary');
    const firstFact = health.locator('dl > div').first();
    const audit = async (theme, disclosure) => {
      await page.addScriptTag({ path: process.env.AXE_PATH || `${tools}/node_modules/axe-core/axe.min.js` });
      const axe = await page.evaluate(() => window.axe.run(document.querySelector('app-observability-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `accessibility ${width}/${theme}/${disclosure}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow ${width}/${theme}/${disclosure}`);
      if (screenshots) await page.screenshot({ path: `${screenshots}/stream-health-${width}-${theme}-${disclosure}.png`, fullPage: true });
    };
    assert(await page.locator('.obs-worker-health').evaluateAll(elements => elements.length >= 2 && elements.every(element => !element.open)), 'every worker defaults closed');
    assert.equal(await firstFact.isVisible(), false, 'health facts hidden by default');
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
      await change('pending', 'Activity waiting');
      if (await isOpen()) await toggle.click();
      assert.equal(await isOpen(), false, 'details start this theme closed');
      assert.equal(await firstFact.isVisible(), false, 'closed health hides facts');
      assert(await toggle.getByText('Health details', { exact: true }).isVisible(), 'clear details affordance');
      assert((await toggle.boundingBox()).height >= 44, '44px summary target');
      const collapsedHeight = (await health.boundingBox()).height;
      await audit(theme, 'collapsed');
      const beforeToggleRequests = state.apiCalls;
      await toggle.focus();
      await page.keyboard.press('Enter');
      await waitFor(isOpen, 'Enter expands health');
      assert(await toggle.evaluate(element => document.activeElement === element && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'), 'keyboard focus stays visible on the summary');
      assert.equal(await firstFact.isVisible(), true, 'expanded health exposes facts');
      if (width < 600) assert((await health.boundingBox()).height > collapsedHeight + 120, 'collapsed mobile row removes the tall metadata body');
      assert(await health.evaluate(element => [...document.querySelectorAll('.obs-worker-health')].filter(other => other !== element).every(other => !other.open)), 'opening one worker leaves all others closed');
      const peerHealth = page.locator('.obs-baseline-health');
      await peerHealth.locator('summary').click();
      assert.equal(await isOpen(), true, 'opening another worker preserves this worker');
      await toggle.focus();
      await page.keyboard.press('Space');
      await waitFor(async () => !(await isOpen()), 'Space collapses health');
      assert.equal(await peerHealth.evaluate(element => element.open), true, 'closing one worker preserves its expanded peer');
      await peerHealth.locator('summary').click();
      assert.equal(state.apiCalls, beforeToggleRequests, 'disclosure toggles send no API requests');
      await toggle.focus();
      await page.keyboard.press('Space');
      await waitFor(isOpen, 'Space expands health');
      await change('pending', 'Activity waiting');
      assert.equal(await isOpen(), true, 'expanded state survives mocked Refresh');
      if (theme === 'dark') {
        const beforePoll = state.overviewCalls;
        await page.clock.fastForward(15000);
        await waitFor(async () => state.overviewCalls > beforePoll && !(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled()), '15-second background refresh');
        assert.equal(await isOpen(), true, 'expanded state survives automatic polling');
      }
      await toggle.click();
      await change('pending', 'Activity waiting');
      assert.equal(await isOpen(), false, 'closed state survives mocked Refresh');
      assert.equal(await firstFact.isVisible(), false, 'closed facts stay hidden after Refresh');
      if (theme === 'dark') {
        const beforePoll = state.overviewCalls;
        await page.clock.fastForward(15000);
        await waitFor(async () => state.overviewCalls > beforePoll && !(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled()), 'closed 15-second background refresh');
        assert.equal(await isOpen(), false, 'closed state survives automatic polling');
      }
      await toggle.click();

      await checkFact('Pending activity', 'Yes');
      await checkFact('Oldest pending', '2.0 min');
      await checkFact('Checkpoint sequence', '123');
      await checkFact('Active batch events', '8');
      await checkFact('Last successful projection', '45 s ago at sample');
      assert.match(await health.innerText(), /not an event count/);
      await audit(theme, 'expanded');

      await change('empty', 'No activity pending');
      await checkFact('Pending activity', 'None pending');
      await checkFact('Oldest pending', 'None pending');
      await checkFact('Checkpoint sequence', '0');
      await checkFact('Active batch events', '0');
      await checkFact('Last successful projection', 'Unknown');
      await change('failed', 'activity check failed');
      await toggle.click();
      assert.equal(await isOpen(), false, 'warning details can remain closed');
      assert.equal(await firstFact.isVisible(), false, 'warning facts are hidden until requested');
      assert(await toggle.locator('.obs-warn').isVisible(), 'warning remains visible while closed');
      assert.match(await toggle.innerText(), /failed/);
      await toggle.click();
      for (const label of ['Pending activity', 'Oldest pending', 'Checkpoint sequence', 'Active batch events']) await checkFact(label, 'Unknown');
      await checkFact('Last successful projection', '45 s ago at sample');
      assert.match(await health.innerText(), /Previous sample/);
      await change('failed-no-success', 'activity check failed');
      for (const label of ['Pending activity', 'Oldest pending', 'Checkpoint sequence', 'Active batch events', 'Last successful projection']) await checkFact(label, 'Unknown');
      await change('mixed', 'mixed query results');
      for (const label of ['Pending activity', 'Oldest pending', 'Checkpoint sequence', 'Active batch events', 'Last successful projection']) await checkFact(label, 'Unknown');
      await change('stale', 'activity check is stale');
      await toggle.click();
      assert.equal(await isOpen(), false, 'warning details can remain closed');
      assert.equal(await firstFact.isVisible(), false, 'warning facts are hidden until requested');
      assert(await toggle.locator('.obs-warn').isVisible(), 'warning remains visible while closed');
      assert.match(await toggle.innerText(), /stale/);
      await toggle.click();
      for (const label of ['Pending activity', 'Oldest pending', 'Checkpoint sequence', 'Active batch events', 'Last successful projection']) await checkFact(label, 'Unknown');
      await change('gauges-stale', 'pending activity is unknown');
      await checkFact('Pending activity', 'Unknown');
      await checkFact('Checkpoint sequence', 'Unknown');
      await checkFact('Last successful projection', '45 s ago at sample');
      await change('mismatched', 'pending activity is unknown');
      await checkFact('Pending activity', 'Unknown');
      await checkFact('Checkpoint sequence', 'Unknown');
      await checkFact('Active batch events', '8');
      await change('pending-mixed', 'pending activity is unknown');
      await checkFact('Pending activity', 'Unknown');
      await change('partial', 'pending activity is unknown');
      await checkFact('Oldest pending', '2.0 min');
      await checkFact('Checkpoint sequence', 'Unknown');
      await checkFact('Active batch events', 'Unknown');
      await change('missing-checkpoint', 'Activity waiting');
      await checkFact('Checkpoint sequence', 'Unknown');
      await checkFact('Active batch events', '8');
      await change('restart', 'No activity pending');
      await checkFact('Last successful projection', 'Unknown');
      await checkFact('Checkpoint sequence', '0');
      await change('legacy', 'Health unknown');
      await checkFact('Pending activity', 'Unknown');
      await change('health-only', 'Activity waiting');
      assert.equal(await health.count(), 1, 'health appears without RSS samples');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `state overflow ${width}/${theme}`);
    }
    await change('failed', 'activity check failed');
    await page.getByRole('button', { name: 'Queues', exact: true }).click();
    const queue = page.locator('.obs-queue').filter({ hasText: 'Stream activity rust' });
    await queue.waitFor();
    assert.equal(await queue.locator('.obs-queue__jobs').innerText(), '2 jobs', 'health probes cannot multiply job totals');
    assert.equal(await queue.locator('.obs-queue__top .lf-chip').innerText(), '1 failed', 'health errors cannot multiply failed jobs');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByText('1 background job failed', { exact: true }).waitFor();
    assert.equal(await page.locator('.lf-metric').filter({ hasText: 'Failures' }).locator('.lf-metric__value').innerText(), '1', 'health errors excluded from operation failures');
    assert.equal(await page.locator('.obs-sink').filter({ hasText: 'health_' }).count(), 0, 'health checks are not time sinks');
    await page.goto(base + '/observability?tab=resources&service=api');
    await page.getByRole('heading', { name: 'Our processes', exact: true }).waitFor();
    assert.equal(await page.locator('.obs-stream-health').count(), 0, 'API service filter hides stream health');
    assert.equal(await page.locator('.obs-raid-health').count(), 0, 'API service filter hides refresh health');
    await page.goto(base + '/observability?tab=resources&service=cron');
    await health.waitFor();
    assert.match(await health.innerText(), /activity check failed/, 'cron service filter includes stream health');
    assert.deepEqual(errors, [], 'no browser errors');
    await context.close();
  }
  console.log('Stream health: pending/empty/failed/mixed/stale/partial/mismatched/restart/health-only states, zero versus unknown gauges, existence flag, independent freshness, job totals, service filters, 320/390/1280 dark/light, default-closed independent native disclosures, keyboard toggles, manual/automatic refresh persistence, visible closed warnings, accessibility and overflow passed.');
} finally { await browser.close(); }
