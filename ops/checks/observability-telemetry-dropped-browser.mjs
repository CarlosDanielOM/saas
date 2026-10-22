// Self-contained admin preview/candidate check. All APIs are mocked, including
// the development localhost API; only loopback preview assets reach the network.
// SAAS_PREVIEW_URL=http://127.0.0.1:<port> node ops/checks/observability-telemetry-dropped-browser.mjs
// scripts/saas-ops verify admin-<run-id> --check ops/checks/observability-telemetry-dropped-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback preview');
assert(!process.env.SAAS_TARGET || process.env.SAAS_TARGET === 'admin');
const browserTools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = createRequire(`${browserTools}/package.json`)('playwright');
const screenshots = process.env.SAAS_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const summary = { count: 0, average: null, p50: null, p95: null, p99: null, errors: 0, max: 0 };
const iso = (age = 0) => new Date(Date.now() - age).toISOString();

function overview(state, query) {
  const minutes = Number(query.get('minutes'));
  const at = iso();
  const metric = (service, proc, suffix, value, extra = {}) => ({
    ...summary, service, kind: 'runtime', name: `${proc}.${suffix}`, channel: '',
    count: 1, average: value, max: value, lastValue: value, lastAt: at, ...extra,
  });
  let groups = [
    metric('api', 'index', 'rss_bytes', 64000000),
    metric('bot', 'index', 'rss_bytes', 32000000),
    metric('bot', 'index', 'telemetry_dropped', state.bot),
    metric('cron', 'cron_index_rust', 'rss_bytes', 16000000),
    metric('cron', 'cron_index_rust', 'telemetry_dropped', 0),
  ];
  // The endpoint scopes samples to the requested window. Narrowing past the
  // latest drop sample removes that metric rather than inventing a zero/delta.
  if (!state.wideOnly || minutes > 15) groups.push(metric('api', 'index', 'telemetry_dropped', state.value, {
    count: state.count, average: state.average, max: state.max, lastAt: state.wideOnly ? iso(20 * 60000) : at,
  }));
  if (query.get('service')) groups = groups.filter(row => row.service === query.get('service'));
  return { generatedAt: at, lastAt: at, minutes, http: summary, chat: summary, groups, timeline: [], channelNames: {} };
}

async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.SAAS_CHROMIUM_PATH || undefined });
try {
  for (const width of [320, 390, 1280]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, serviceWorkers: 'block' });
    const state = { value: 7, count: 90, average: 7, max: 7, bot: 0, wideOnly: false, collectorDrops: 0, calls: [], unexpected: [] };
    await context.addInitScript(theme => {
      localStorage.setItem('dima-admin.mode.v1', theme);
      localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'telemetry-fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: { id: '533538623', login: 'tester', display_name: 'Tester' },
        appUser: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] } }));
    }, theme);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith('/observability/api/')) {
        const name = url.pathname.slice('/observability/api/'.length);
        state.calls.push({ name, query: Object.fromEntries(url.searchParams) });
        assert.equal(request.method(), 'GET', 'analytics check never mutates');
        assert.equal(request.headers().authorization, 'Bearer telemetry-fixture-only');
        if (name === 'session') return route.fulfill({ json: { grant: { role: 'owner', channels: [], services: [] }, channelNames: {} } });
        if (name === 'overview') return route.fulfill({ json: overview(state, url.searchParams) });
        if (name === 'resources') return route.fulfill({ json: { limited: false, samples: [
          { at: iso(30000), service: 'analytics', name: 'buffer_dropped_batches', value: 0 },
          { at: iso(), service: 'analytics', name: 'buffer_dropped_batches', value: state.collectorDrops },
        ] } });
        state.unexpected.push(request.url());
        return route.abort();
      }
      if (url.origin === origin) return route.continue();
      // No API, font, avatar, or third-party request can reach a live service.
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    page.setDefaultTimeout(10000);
    const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true });
    const api = page.locator('.obs-proc').filter({ has: page.getByText('API server', { exact: true }) });
    const bot = page.locator('.obs-proc').filter({ has: page.getByText('Chat bot', { exact: true }) });
    const count = () => state.calls.filter(call => call.name === 'overview').length;
    const settled = before => until(async () => count() > before && await refreshButton.isEnabled(), 'overview response rendered');
    const refresh = async values => {
      Object.assign(state, values);
      const before = count();
      await refreshButton.click();
      await settled(before);
    };
    const expectReading = async value => {
      await until(async () => (await api.locator('.obs-op__meta > span').innerText()) === `Drop counter: ${value}`, `drop counter ${value}`);
      assert.equal(await api.locator('.obs-op__meta .obs-warn').count(), value > 0 ? 1 : 0, 'only nonzero counters warn');
    };
    const range = async (label, minutes) => {
      const before = count();
      await page.getByRole('button', { name: label, exact: true }).click();
      await settled(before);
      assert.equal(state.calls.filter(call => call.name === 'overview').at(-1).query.minutes, String(minutes));
    };

    await page.goto(`${base}/observability?tab=resources&minutes=15`);
    await page.getByRole('heading', { name: 'Our processes', exact: true }).waitFor();
    await until(() => refreshButton.isEnabled(), 'initial refresh finished');
    await expectReading(7); // Old UI reports 630 (90 repeated lifetime samples).
    assert.match(await bot.innerText(), /Drop counter: 0/);
    await page.getByText(/The time filter selects the latest available reading/).waitFor();
    await page.getByText(/cannot show exactly how many records were lost during that period/).waitFor();
    await refresh({});
    await expectReading(7); // Same overview polled again.
    state.count = 91;
    const beforePoll = count();
    await page.clock.fastForward(15001); // Exercise the real automatic refresh.
    await settled(beforePoll);
    await expectReading(7);
    await refresh({ value: 12, count: 92, average: 7.054, max: 12 });
    await expectReading(12); // A real increase, not sum/average/max over history.
    await refresh({ value: 0, count: 93, average: 7, max: 12 });
    await expectReading(0); // Restart while the selected range still includes the old instance.
    await refresh({ value: 3, count: 94, average: 6.95, max: 12 });
    await expectReading(3);
    await refresh({ value: 50, count: 96, average: 8, max: 100 });
    await expectReading(50); // Latest bucket can average overlapping old/new processes.
    await refresh({ value: 3, count: 8000, average: 80, max: 900 });
    await range('Last 24 hours', 1440);
    await expectReading(3);
    await range('Last 30 days', 43200);
    await expectReading(3); // Coarse range still uses API's latest available bucket reading.
    await page.reload();
    await page.getByRole('heading', { name: 'Our processes', exact: true }).waitFor();
    await expectReading(3); // No client history is required for the result.
    state.wideOnly = true;
    await range('Last 15 minutes', 15);
    await until(async () => !/Drop counter:/.test(await api.innerText()), 'missing drop series stays unknown');
    await range('Last 24 hours', 1440);
    await expectReading(3);

    await page.addScriptTag({ path: `${browserTools}/node_modules/axe-core/axe.min.js` });
    const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('app-observability-page'), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    })).violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })));
    assert.deepEqual(violations, [], `accessibility ${width}/${theme}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow ${width}/${theme}`);
    if (screenshots) await page.screenshot({ path: `${screenshots}/telemetry-dropped-${width}-${theme}.png`, fullPage: true });

    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const warning = page.locator('.obs-attention__row').filter({ hasText: 'Some telemetry was dropped' });
    await warning.waitFor();
    assert.match(await warning.innerText(), /losses since startup[\s\S]*resets on restart[\s\S]*losses within this time range are unknown/);
    await refresh({ value: 0, bot: 0 });
    await until(async () => await warning.count() === 0, 'old range max does not retain a restart warning');
    await refresh({ collectorDrops: 4 });
    await warning.waitFor();
    assert.match(await warning.innerText(), /collector lost buffered batches/, 'collector warning remains independent');

    state.bot = 19;
    await page.goto(`${base}/observability?tab=resources&minutes=15&service=bot`);
    await until(async () => (await bot.innerText()).includes('Drop counter: 19'), 'service-scoped reading');
    assert.equal(await api.count(), 0, 'different services never merge their same-named index counters');
    assert.equal(state.calls.filter(call => call.name === 'overview').at(-1).query.service, 'bot');
    assert.deepEqual(state.unexpected, [], 'no unmocked analytics endpoints');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    await context.close();
  }
  console.log('Telemetry dropped: repeated samples/manual and automatic polls, real increases, restart resets, overlapping-instance bucket averages, range changes/reload/missing samples, service scope, independent collector warning, axe and overflow at 320/390/1280 dark/light passed.');
} finally {
  await browser.close();
}
