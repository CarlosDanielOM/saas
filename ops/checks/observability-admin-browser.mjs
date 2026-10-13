// Admin System analytics: health answer, every tab, chart interaction, trace dialog,
// access grants (mutations mocked and counted), scoped viewer, failure + session guard.
// All APIs are mocked; set SAAS_SCREENSHOT_DIR to keep screenshots.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const now = Date.now(), iso = (ms = 0) => new Date(now - ms).toISOString(), date = iso();

const BOUNDS_NULL = null;
const g = (service, kind, name, channel, count, average, p95, extra = {}) => ({ service, kind, name, channel, count, average, p50: p95 === null ? null : Math.max(1, Math.round(p95 / 2)), p95, p99: p95 === null ? null : p95 * 2, errors: 0, max: (p95 ?? 400000) * 1.5, lastAt: date, lastValue: average, ...extra });
const runtime = (service, proc, rss, lag) => [['rss_bytes', rss], ['heap_bytes', rss * 0.6], ['cpu_cores', 0.04], ['event_loop_p99_ms', lag], ['telemetry_dropped', 0]].map(([m, v]) => g(service, 'runtime', `${proc}.${m}`, '', 20, v, null, { lastValue: v }));
function groups(healthy) {
  const fail = n => healthy ? {} : { errors: n };
  return [
    g('bot', 'http', 'POST /eventsub', '', 1444, 2, 10),
    g('api', 'http', 'GET /auth/access/:channelID', '123', 23, 325, 500),
    g('api', 'http', 'GET /config/site/analytics/stream', '', 4, 35778, BOUNDS_NULL),
    g('api', 'http', 'POST /speech/:channelID', '', 266, 5, 10, fail(2)),
    g('api', 'http', 'POST /auth/exchange-code', '', 6, 503, healthy ? 1000 : 5000),
    g('bot', 'http_client', 'external POST', '', 1201, 130, 250, fail(4)),
    g('api', 'http_client', 'twitch GET', '123', 578, 179, 250),
    g('cron', 'http_client', 'openrouter POST', '', 15, 900, 2500),
    g('cron', 'database', 'mongo.find', '', 226356, 1, 5),
    g('bot', 'database', 'mongo.update', '123', 2900, 1, 5),
    g('api', 'cache', 'get', '', 42558, 0.3, 1),
    g('api', 'cache_lookup', 'get', '', 42558, 0, 1),
    g('bot', 'chat', 'message', '123', 1341, 23, 50),
    ...[['receive_to_route', 13], ['identity', 1], ['moderation', 10], ['keywords', 0.4], ['delivery', 3]].map(([n, a]) => g('bot', 'chat_stage', n, '123', 1341, a, 25)),
    g('bot', 'command', 's', '123', 264, 10, 25),
    g('bot', 'command', 'clip', '789', 1, 7006, 10000),
    g('bot', 'command_body', 's', '123', 260, 7, 10),
    g('bot', 'event', 'channel.chat.message', '123', 1343, 0, 1),
    g('bot', 'event', 'channel.bits.use', '123', 28, 0, 1),
    g('bot', 'event', 'channel.follow', '789', 6, 0, 1),
    g('bot', 'event', 'stream.online', '789', 2, 0, 1),
    g('bot', 'lifecycle', 'stream.started', '789', 1, 0, 1, { lastAt: iso(1800000) }),
    g('bot', 'lifecycle', 'stream.ended', '123', 1, 0, 1, { lastAt: iso(600000) }),
    g('api', 'queue_wait', 'tts', '123', 266, 1595, 5000),
    g('cron', 'queue_wait', 'stream-operations-v1', '789', 12, healthy ? 200 : 240916, healthy ? 500 : BOUNDS_NULL),
    g('cron', 'queue_wait', 'polar-credits-v1', '', 152, 32, 100),
    g('api', 'queue_run', 'tts.fish', '123', 244, 1416, 2500),
    g('api', 'queue_run', 'tts.piper', '123', 22, 339, 500),
    g('cron', 'queue_run', 'polar-credits-v1', '', 152, 4, 10, fail(11)),
    g('cron', 'queue_run', 'stream-operations-v1', '789', 12, 263, 1000),
    g('api', 'queue_total', 'tts.ready', '123', 266, 3300, 10000),
    g('queues', 'queue', 'tts.waiting', '', 10, 2, null, { lastValue: 2 }),
    g('queues', 'queue', 'tts.oldest_wait_ms', '', 10, 5024, null, { lastValue: 5024 }),
    ...runtime('api', 'index', 231238345, 21),
    ...runtime('bot', 'index', 199848688, 25),
    ...runtime('cron', 'domain_events.worker', 97711177, healthy ? 30 : 320),
  ];
}
const summaryOf = (healthy, kind) => kind === 'http'
  ? { count: 1749, average: 30, p50: 5, p95: 25, p99: 500, errors: healthy ? 0 : 2, max: 75991 }
  : { count: 1341, average: 23, p50: 25, p95: 50, p99: 100, errors: 0, max: 1163 };
const timeline = Array.from({ length: 60 }, (_, i) => ({ at: Math.floor((now - (59 - i) * 60000) / 60000) * 60000, httpRps: 0.4 + Math.sin(i / 6) * 0.2 + (i === 40 ? 1.2 : 0), chatRps: 0.25 + Math.cos(i / 8) * 0.1 })).filter((_, i) => i < 20 || i > 24);
const channelNames = { '123': 'pixelpilot', '456': null, '789': 'nightowl_tv' };
const overview = healthy => ({ channelNames, generatedAt: date, lastAt: iso(5000), truncated: false, minutes: 60, http: summaryOf(healthy, 'http'), chat: summaryOf(healthy, 'chat'), groups: groups(healthy), timeline });
function samples(healthy) {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const at = iso(i * 30000), grow = (20 - i) * 1e6;
    const add = (service, name, value) => rows.push({ at, service, name, value });
    add('dragonfly', 'collector_up', 1); add('dragonfly', 'used_memory', 1.2e9 + grow); add('dragonfly', 'maxmemory', 4e9); add('dragonfly', 'instantaneous_ops_per_sec', 420); add('dragonfly', 'connected_clients', 31); add('dragonfly', 'keyspace_hits', 9e5); add('dragonfly', 'keyspace_misses', 1e5); add('dragonfly', 'evicted_keys', 0); add('dragonfly', 'expired_keys', 120000);
    add('mongodb', 'collector_up', 1); add('mongodb', 'cache_bytes', 7e8); add('mongodb', 'cache_limit_bytes', 1.5e9); add('mongodb', 'dataSize', 2.2e9); add('mongodb', 'indexSize', 4e8); add('mongodb', 'storageSize', 1.1e9); add('mongodb', 'resident_bytes', 1.4e9 + grow); add('mongodb', 'connections', 48);
    add('qdrant', 'collector_up', healthy ? 1 : 0); add('qdrant', 'memory_resident_bytes', 6e8); add('qdrant', 'collections_total', 3); add('qdrant', 'collections_vector_total', 120000);
    add('postgres', 'collector_up', 1); add('postgres', 'database_bytes', 5e7 + grow); add('postgres', 'connections', 6);
    add('analytics', 'buffer_batches', 0); add('analytics', 'buffer_dropped_batches', 0); add('analytics', 'queue_keys_observed', 14); add('analytics', 'rss_bytes', 9e7);
  }
  return rows;
}
const span = (id, name, kind, outcome, duration, offset = 0, parent = null, channel = '123') => ({ at: new Date(now - 60000 + offset).toISOString(), trace_id: 'a'.repeat(32), span_id: id.repeat(16).slice(0, 16), parent_id: parent, service: 'bot', channel, kind, name, outcome, duration, partial: false });
const spans = [span('b', '!hello', 'command', 'ok', 25), { ...span('c', 'POST /speech/:channelID', 'http', 'error', 1800), trace_id: 'c'.repeat(32), service: 'api' }, { ...span('d', 'tts.fish', 'queue_run', 'ok', 2400), trace_id: 'd'.repeat(32), service: 'api' }];
const traceDetail = { spans: [span('b', '!hello', 'command', 'ok', 25), span('e', 'mongo.find', 'database', 'ok', 4, 3, 'b'.repeat(16)), span('f', 'external POST', 'http_client', 'ok', 15, 8, 'b'.repeat(16))], partial: false, channelNames };
const logs = [{ at: iso(120000), service: 'cron', channel: '', level: 'error', name: 'processDomainEventDelivery', trace_id: 'a'.repeat(32), fields: { consumer: 'polar-credits-v1', code: 'TIMEOUT' } }, { at: iso(300000), service: 'bot', channel: '123', level: 'warn', name: 'sendTwitchChatMessage.heldForModeration', trace_id: null, fields: {} }];
const grantsList = [{ user_id: '456001', role: 'viewer', channels: ['123'], services: [], expires_at: new Date(now + 5 * 86400000).toISOString() }, { user_id: '789', role: 'investigator', channels: [], services: ['api'], expires_at: iso(86400000) }];

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
async function until(fn, label, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 80)); } throw new Error(`Timed out: ${label}`); }
async function axe(page, label) {
  await page.addScriptTag({ path: `${tools}/node_modules/axe-core/axe.min.js` });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-observability-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target).slice(0, 4) })), [], `axe ${label}`);
}
async function shot(page, name) { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); }
const tabNames = ['Overview', 'Calls', 'Chat & events', 'Queues', 'Servers', 'Traces', 'Logs', 'Access'];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark', hasTouch: width < 600 });
    const state = { role: 'owner', channels: [], failure: false, healthy: false, mutations: [], resourceCalls: 0 };
    await context.addInitScript(() => { if (sessionStorage.getItem('fixture-initialized')) return; sessionStorage.setItem('fixture-initialized', '1'); localStorage.setItem('language', 'en'); localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'tester', display_name: 'Tester' }, appUser: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] }, permissions: {} })); });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let json = { error: false, status: 200, data: {} };
      if (url.pathname.includes('/observability/api/')) {
        assert.equal(request.headers().authorization, 'Bearer test-only');
        const name = url.pathname.split('/api/')[1];
        if (state.failure) return route.fulfill({ status: 503, json: { message: 'unavailable' } });
        if (request.method() !== 'GET') { state.mutations.push({ method: request.method(), name, body: request.postDataJSON?.() ?? null }); return route.fulfill({ status: 200, json: { saved: true } }); }
        if (name === 'resources') state.resourceCalls++;
        json = name === 'session' ? { grant: { role: state.role, channels: state.channels, services: [] }, channelNames: state.channels.length ? { '123': 'pixelpilot' } : {} }
          : name === 'overview' ? overview(state.healthy)
          : name === 'resources' ? { samples: samples(state.healthy), limited: false }
          : name === 'traces' ? { spans, channelNames }
          : name.startsWith('traces/') ? traceDetail
          : name === 'logs' ? { logs, channelNames }
          : { grants: grantsList, channelNames: { ...channelNames, '456001': 'modfriend' } };
      } else if (url.pathname === '/users') {
        const login = url.searchParams.get('username');
        if (login === 'pixelpilot') json = { error: false, status: 200, data: { id: '123', username: 'pixelpilot', display_name: 'PixelPilot' } };
        else if (login === 'nobody_here') return route.fulfill({ status: 404, json: { error: true, status: 404, message: 'User not found' } });
      } else if (url.pathname === '/auth/session') json = { error: false, status: 200, data: { twitch: { id: '533538623', login: 'tester', display_name: 'Tester' }, app: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] } } };
      return route.fulfill({ status: 200, json });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const tab = name => page.getByRole('button', { name, exact: true });
    const openTab = async name => { await tab(name).click(); await until(async () => (await tab(name).getAttribute('aria-pressed')) === 'true', `tab ${name}`); await page.waitForTimeout(120); };

    // Navigation from the shell and the health answer.
    await page.goto(base + '/settings');
    await page.getByRole('link', { name: 'Analytics', exact: true }).filter({ visible: true }).click();
    await page.waitForURL(/\/observability$/);
    await page.getByRole('heading', { name: 'System analytics', exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await page.getByRole('heading', { name: /things need a look/ }).waitFor();
    const attention = await page.locator('.obs-attention__row').allInnerTexts();
    for (const expected of [/2 API requests failed/, /4 calls to outside services failed/, /11 background jobs failed/, /POST \/auth\/exchange-code is slow/, /Stream operations jobs waited up to 5\.0 min\+/, /Domain events worker is stalling/, /Qdrant isn't reporting/])
      assert(attention.some(text => expected.test(text)), `attention ${expected} in ${attention.join(' | ')}`);
    assert(!attention.some(text => /analytics\/stream/.test(text)), 'live stream connections are not flagged as slow');
    await page.getByText('1,749', { exact: true }).waitFor();
    assert.match(await page.locator('.streamer-row').first().innerText(), /pixelpilot[\s\S]*Channel ID: 123/);
    assert.equal(await page.locator('select[name=channel] option[value="456"]').innerText(), 'Unknown channel (456)');

    // Chart reads values with a pointer and with the keyboard.
    const plot = page.locator('.obs-plot');
    await plot.scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
    const box = await plot.boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 4 });
    await page.locator('.obs-tip').waitFor();
    assert.match(await page.locator('.obs-tip').innerText(), /\/s\s+API[\s\S]*\/s\s+chat/);
    await page.mouse.move(0, 0);
    await plot.focus(); await page.keyboard.press('End');
    await page.locator('.obs-tip').waitFor();
    await page.keyboard.press('Escape');
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
      await axe(page, `${width} ${theme} overview`);
      assert(await overflow(page), `overflow ${width} ${theme} overview`);
      await shot(page, `obs-${width}-${theme}-overview`);
    }
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();

    // Attention row deep-links into Calls, sorted by failures.
    await page.locator('.obs-attention__row').filter({ hasText: 'API requests failed' }).click();
    await page.waitForURL(/tab=endpoints.*kind=http.*sort=failing|tab=endpoints.*sort=failing/);
    assert.equal(await tab('Calls').getAttribute('aria-pressed'), 'true');
    await until(async () => /POST \/speech/.test(await page.locator('.obs-op').first().innerText()), 'failing call first');
    assert.match(await page.locator('.obs-op').first().innerText(), /Failed\s*2|2$/m);
    await page.getByRole('button', { name: /^All \d+/ }).click();
    await page.getByRole('button', { name: 'Slowest', exact: true }).click();
    await until(async () => /exchange-code|openrouter|twitch|access/.test(await page.locator('.obs-op').first().innerText()), 'slowest first');
    assert(!/analytics\/stream/.test(await page.locator('.obs-op').first().innerText()), 'stream connection not ranked slowest');
    await page.getByRole('searchbox').fill('mongo');
    await until(async () => (await page.locator('.obs-op').count()) === 2, 'search filters calls');
    await page.getByRole('searchbox').fill('');

    // Streamer filter from the overview, then clear it from the chip.
    await openTab('Overview');
    await page.locator('.streamer-row').filter({ hasText: 'pixelpilot' }).click();
    await page.waitForURL(/channel=123/);
    await page.getByRole('button', { name: 'Stop filtering by pixelpilot' }).click();
    await until(async () => !/channel=123/.test(page.url()), 'channel filter cleared');
    await page.getByRole('button', { name: 'Last 24 hours' }).click();
    await page.waitForURL(/minutes=1440/);

    // Chat pipeline, queues, servers.
    await openTab('Chat & events');
    await page.getByText('The bot handles a chat message in 23 ms on average').waitFor();
    assert.equal(await page.locator('.obs-step').count(), 5);
    await page.getByText('Subs, gifts & announcements').or(page.getByText('Bits', { exact: true })).first().waitFor();
    await openTab('Queues');
    const tts = page.locator('.obs-queue').filter({ hasText: 'Text to speech' });
    assert.match(await tts.innerText(), /Waiting now\s*2[\s\S]*oldest 5\.0 s/);
    assert.match(await tts.innerText(), /Run · fish/);
    assert.match(await page.locator('.obs-queue').filter({ hasText: 'Polar credits' }).innerText(), /11 failed/);
    assert.match(await page.locator('.obs-queue').filter({ hasText: 'Stream operations' }).innerText(), /Slow to start/);
    await openTab('Servers');
    assert.match(await page.locator('.obs-dep').filter({ hasText: 'Qdrant' }).innerText(), /Not reporting/);
    assert.match(await page.locator('.obs-dep').filter({ hasText: 'Dragonfly' }).innerText(), /of 3\.73 GiB/);
    assert.match(await page.locator('.obs-proc').first().innerText(), /Domain events worker/);
    assert.equal(await page.locator('.obs-dep svg path').count() >= 4, true, 'sparklines drawn');

    // Traces: filter, dialog, Escape.
    await openTab('Traces');
    await page.getByRole('button', { name: 'Failed', exact: true }).click();
    await until(async () => (await page.locator('.trace-row').count()) === 1, 'failed traces only');
    await page.getByRole('button', { name: /^All/ }).first().click();
    await page.locator('.trace-row').filter({ hasText: '!hello' }).click();
    await page.getByRole('heading', { name: 'Request timeline', exact: true }).waitFor();
    assert.match(await page.locator('.trace-detail').innerText(), /pixelpilot \(123\)/);
    assert.equal(await page.locator('.obs-span').count(), 3);
    await page.waitForTimeout(400);
    await axe(page, `${width} trace dialog`);
    await shot(page, `obs-${width}-dark-trace`);
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('dialog.obs-trace').count()) === 0, 'trace dialog closed');

    // Logs: level filter and related trace.
    await openTab('Logs');
    await page.getByRole('button', { name: /^Warnings/ }).click();
    await until(async () => (await page.locator('.log-row').count()) === 1, 'warnings only');
    await page.getByRole('button', { name: /^Errors/ }).click();
    await page.getByRole('button', { name: 'Open related trace' }).click();
    await page.getByRole('heading', { name: 'Request timeline', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    for (const name of tabNames) {
      await openTab(name);
      assert(await overflow(page), `overflow ${width} ${name}`);
      if (['Calls', 'Chat & events', 'Queues', 'Servers', 'Traces', 'Logs', 'Access'].includes(name)) await axe(page, `${width} dark ${name}`);
      await shot(page, `obs-${width}-dark-${name.replace(/\W+/g, '-').toLowerCase()}`);
    }

    // Access: validation, lookup, confirmed grant, revoke. Nothing is sent before Confirm.
    await page.getByRole('button', { name: 'Review access grant', exact: true }).click();
    await page.getByText('Find the Twitch account first, or enter its numeric user ID.').waitFor();
    assert.equal(state.mutations.length, 0);
    await page.getByLabel('Twitch name', { exact: true }).fill('nobody_here');
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByText(/No Twitch account called "nobody_here"/).waitFor();
    await page.getByLabel('Twitch name', { exact: true }).fill('pixelpilot');
    await page.getByLabel('Twitch name', { exact: true }).press('Enter');
    await page.getByText('Twitch user ID: 123').waitFor();
    await page.locator('label.lf-choice').filter({ hasText: 'Investigator' }).click();
    await page.getByRole('radio', { name: 'Only some' }).click();
    await page.getByRole('group', { name: 'Allowed channels' }).getByRole('button', { name: 'nightowl_tv' }).click();
    await page.getByRole('radio', { name: '1 week' }).click();
    await page.getByRole('button', { name: 'Review access grant', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Give analytics access?' });
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /PixelPilot \(123\) will be able to see charts, numbers, logs and request traces for nightowl_tv \(789\) only/);
    assert.match(await confirm.innerText(), /Investigators can read sanitized logs/);
    await page.waitForTimeout(400);
    if (width === 390) { await axe(page, '390 grant confirm'); await shot(page, 'obs-390-dark-grant-confirm'); }
    assert.equal(state.mutations.length, 0, 'no grant before confirm');
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Access updated.' }).waitFor();
    assert.equal(state.mutations.length, 1);
    const put = state.mutations[0];
    assert.equal(put.method, 'PUT'); assert.equal(put.name, 'grants/123');
    assert.deepEqual({ role: put.body.role, channels: put.body.channels, services: put.body.services }, { role: 'investigator', channels: ['789'], services: [] });
    assert(Math.abs(Date.parse(put.body.expiresAt) - (now + 7 * 86400000)) < 120000, 'expires in a week');
    await page.getByRole('button', { name: 'Revoke access for modfriend' }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke analytics access?' });
    await revoke.getByText('modfriend (456001) loses access to analytics right away.').waitFor();
    await revoke.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Access revoked.' }).waitFor();
    assert.deepEqual(state.mutations.slice(1).map(m => `${m.method} ${m.name}`), ['DELETE grants/456001']);
    await page.getByRole('button', { name: 'Edit access for nightowl_tv' }).click();
    await page.getByText('Twitch user ID: 789').waitFor();
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await axe(page, `${width} light access`); assert(await overflow(page), `overflow ${width} light access`);
    await shot(page, `obs-${width}-light-access`);
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();

    // Failure keeps the page and offers Retry.
    state.failure = true; await openTab('Overview');
    await page.getByRole('alert').filter({ hasText: "Analytics isn't answering right now" }).waitFor();
    state.failure = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await until(async () => (await page.getByRole('alert').filter({ hasText: "Analytics isn't answering" }).count()) === 0, 'retry clears alert');

    // A healthy system says so plainly.
    if (width === 390) {
      state.healthy = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('heading', { name: 'Everything looks healthy', exact: true }).waitFor();
      assert.equal(await page.locator('.obs-attention__row').count(), 0);
      await shot(page, 'obs-390-dark-healthy');
      state.healthy = false;
    }

    // Channel-scoped viewer: no access, servers, traces or logs; no resource queries.
    state.role = 'viewer'; state.channels = ['123']; state.resourceCalls = 0;
    await page.goto(base + '/observability');
    await tab('Calls').waitFor();
    for (const hidden of ['Access', 'Servers', 'Traces', 'Logs']) assert.equal(await tab(hidden).count(), 0, `viewer sees ${hidden}`);
    await page.getByText('Limited to pixelpilot').waitFor();
    await page.locator('.obs-health').waitFor();
    assert.equal(state.resourceCalls, 0, 'scoped viewer never asks for server resources');
    assert.equal(state.mutations.length, 2);
    assert.deepEqual(errors, []);

    await page.evaluate(() => localStorage.removeItem('dima-admin.session.v1'));
    await page.goto(base + '/observability');
    await page.waitForURL(/\/login/);
    await context.close();
  }
  console.log('Admin analytics: health answer, attention deep links, chart pointer/keyboard, calls/chat/queues/servers/traces/logs, grant + revoke confirmations, scoped viewer, failure retry, healthy state, axe + overflow at 1280/390/320 dark/light passed');
} finally { await browser.close(); }
