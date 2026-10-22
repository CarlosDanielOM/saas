// Admin System analytics → Servers: host gauges, memory/disk breakdown, every SaaS container grouped,
// sorting, drill-down charts (incl. touch/hover tooltip), URL state, overview warnings, empty state,
// axe + no horizontal overflow at 320/390/1280 in dark and light. All APIs are mocked.
// Set SAAS_SCREENSHOT_DIR to keep screenshots.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const now = Date.now(), iso = (ms = 0) => new Date(now - ms).toISOString();
const GB = 1073741824, MB = 1048576;

const CONTAINERS = [
  ['dima-server', 'dimabot', 4.6, 250 * MB, null], ['dima-bot', 'dimabot', 0.6, 178 * MB, null], ['dima-cron', 'dimabot', 18.7, 2.6 * GB, null],
  ['mongodb', 'databases', 12.6, 1.0 * GB, 5 * GB], ['dragonfly', 'databases', 5, 77 * MB, 4 * GB], ['postgres', 'databases', 3.6, 239 * MB, 4 * GB], ['qdrant', 'databases', 0.6, 1.2 * GB, 6 * GB],
  ['piper-tts', 'dimabot', 0, 1.0 * GB, null], ['lfm2.5-embeddings', 'dimabot', 14.8, 2.3 * GB, 3 * GB],
  ['dimabot-site', 'dimasite', 0, 15 * MB, null], ['dima-admin', 'admin', 0, 14 * MB, null], ['dimadocs', 'dimadocs', 0, 16 * MB, null], ['dimafx', 'dimafx', 0, 14 * MB, null], ['dimafx-server', 'dimafx', 0, 32 * MB, null], ['NPM', 'network', 0.9, 246 * MB, null],
  ['dimadb', 'dimadb', 0, 35 * MB, null], ['dima-analytics', 'dima-analytics', 0.7, 81 * MB, 512 * MB],
];
function snapshot(problem) {
  const containers = CONTAINERS.map(([name, project, cpu, mem, limit]) => {
    const down = problem && name === 'piper-tts';
    return { name, project, service: name, image: name === 'mongodb' ? 'mongo:8.2.6' : name === 'dima-cron' ? 'sha256:' + '72df59845ea8'.padEnd(64, 'f') : `saas-ops/${name}:release`, state: down ? 'exited' : 'running',
      health: problem && name === 'qdrant' ? 'unhealthy' : ['mongodb', 'dragonfly', 'postgres', 'qdrant', 'dima-analytics', 'NPM'].includes(name) ? 'healthy' : null,
      failingStreak: problem && name === 'qdrant' ? 4 : 0, startedAt: iso(name === 'dima-bot' ? 7200000 : 3 * 86400000), finishedAt: down ? iso(600000) : null,
      oomKilled: down, exitCode: down ? 137 : 0, restartCount: problem && name === 'dima-bot' ? 2 : 0, restartPolicy: 'unless-stopped',
      cpuPct: down ? null : cpu, cpuLimit: limit ? 1 : null, memBytes: down ? null : mem, memLimit: limit, pids: down ? null : 20, pidsLimit: limit ? 128 : null,
      netRx: 1e9, netTx: 2e9, netRxBps: down ? null : 24000, netTxBps: down ? null : 40000, blkRead: 1e8, blkWrite: 2e8, blkReadBps: down ? null : 0, blkWriteBps: down ? null : 180000,
      imageBytes: 1.6e9, writableBytes: 4096, volumeBytes: name === 'piper-tts' ? 126 * MB : null };
  });
  return { at: iso(4000), sampleMs: 15000,
    host: { cpus: 16, uptimeSec: 3609241, cpuPct: 26, iowaitPct: 0.1, stealPct: 0, load1: 2.72, load5: 1.63, load15: 1.38, running: 14, procs: 2231,
      memTotal: 30.6 * GB, memAvailable: 14.3 * GB, memUsed: 16.3 * GB, memFree: 1.8 * GB, memCache: 16 * GB, memShared: 3.2 * GB, swapTotal: 0, swapUsed: 0,
      diskTotal: 300 * GB, diskFree: problem ? 21 * GB : 119 * GB, diskUsed: problem ? 279 * GB : 169 * GB, inodesTotal: 19793280, inodesUsed: 5204353,
      diskReadBps: 12304, diskWriteBps: 1061916, netRxBps: 23928, netTxBps: 40343, netRx: 2.2e11, netTx: 8.2e10, pressure: { cpu: 2.32, memory: 0, io: 0.04 } },
    docker: { reachable: true, version: '29.8.0', df: { at: iso(240000), imagesCount: 424, imagesBytes: 25.7 * GB, imagesUnusedBytes: 6.4 * GB, buildCacheBytes: 25.3 * GB, buildCacheReclaimable: 18.3 * GB, volumesCount: 3, volumesBytes: 801 * MB, containersBytes: 138 * MB } },
    containers, errors: [] };
}
function series(problem, minutes, container) {
  const out = [];
  const pts = (n, step, f) => Array.from({ length: n }, (_, i) => { const at = Math.floor((now - (n - 1 - i) * step) / step) * step; const v = f(i); return [at, v, v * 1.4]; });
  const span = minutes * 60000, hostStep = Math.max(30000, span / 120), listStep = Math.max(60000, span / 60);
  const hostN = Math.round(span / hostStep), listN = Math.round(span / listStep);
  for (const [name, f] of [['cpu_pct', i => 20 + 10 * Math.sin(i / 7)], ['mem_used_bytes', i => 16 * GB + i * MB], ['disk_used_bytes', i => 169 * GB + i * 10 * MB], ['load1', () => 2],
    ['net_rx_bps', i => 20000 + 5000 * Math.sin(i / 5)], ['net_tx_bps', i => 40000 + 8000 * Math.cos(i / 6)], ['disk_read_bps', () => 1e4], ['disk_write_bps', () => 1e6], ['swap_used_bytes', () => 0], ['iowait_pct', () => 0.1]])
    out.push({ service: 'host', name, detail: false, points: pts(hostN, hostStep, f) });
  for (const [cname, , cpu, mem] of CONTAINERS) {
    const down = problem && cname === 'piper-tts';
    out.push({ service: 'container:' + cname, name: 'running', detail: false, points: pts(listN, listStep, i => (down && i > listN - 3 ? 0 : 1)) });
    out.push({ service: 'container:' + cname, name: 'cpu_pct', detail: false, points: pts(listN, listStep, i => cpu * (1 + 0.3 * Math.sin(i / 4))) });
    out.push({ service: 'container:' + cname, name: 'mem_bytes', detail: false, points: pts(listN, listStep, () => mem) });
    out.push({ service: 'container:' + cname, name: 'restart_count', detail: false, points: pts(listN, listStep, i => (problem && cname === 'dima-bot' ? (i > listN / 2 ? 2 : 0) : 0)).map(([at, v]) => [at, v, v]) });
  }
  if (container) {
    const c = CONTAINERS.find(([n]) => n === container);
    for (const [name, f] of [['cpu_pct', i => c[2] * (1 + 0.5 * Math.sin(i / 6)) + (i === 50 ? 40 : 0)], ['mem_bytes', i => c[3] * (0.9 + 0.001 * i)], ['net_rx_bps', i => 20000 + 4000 * Math.sin(i / 5)], ['net_tx_bps', i => 30000 + 4000 * Math.cos(i / 5)],
      ['blk_read_bps', () => 0], ['blk_write_bps', i => 150000 + 50000 * Math.sin(i / 3)], ['restart_count', () => 0]])
      out.push({ service: 'container:' + container, name, detail: true, points: pts(hostN, Math.max(60000, hostStep), f) });
  }
  return { slotSeconds: { host: hostStep / 1000, list: listStep / 1000, detail: Math.max(60000, hostStep) / 1000 }, series: out };
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
async function until(fn, label, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 80)); } throw new Error(`Timed out: ${label}`); }
async function axe(page, label) {
  await page.addScriptTag({ path: `${tools}/node_modules/axe-core/axe.min.js` });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-observability-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target).slice(0, 4) })), [], `axe ${label}`);
}
async function shot(page, name) { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); }
async function scrollShots(page, name) {
  if (!shots) return;
  const height = await page.evaluate(() => document.documentElement.scrollHeight), vh = page.viewportSize().height;
  for (let y = 0, i = 0; y < height && i < 8; y += vh - 120, i++) { await page.evaluate(top => window.scrollTo(0, top), y); await page.waitForTimeout(120); await page.screenshot({ path: `${shots}/${name}-${i}.png` }); }
  await page.evaluate(() => window.scrollTo(0, 0));
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [width, scheme] of [[1280, 'dark'], [390, 'dark'], [320, 'dark'], [1280, 'light'], [390, 'light']]) {
    const tag = `${width}-${scheme}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, hasTouch: width < 600 });
    const state = { problem: false, infra: true, calls: [] };
    await context.addInitScript(([theme]) => {
      if (sessionStorage.getItem('fixture-initialized')) return; sessionStorage.setItem('fixture-initialized', '1');
      localStorage.setItem('dima-admin.mode.v1', theme); localStorage.setItem('dima-admin.accent.v1', 'violet');
      localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'tester', display_name: 'Tester' }, appUser: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] }, permissions: {} }));
    }, [scheme]);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      assert.equal(request.method(), 'GET', 'servers view never mutates');
      let json = { error: false, status: 200, data: {} };
      if (url.pathname.includes('/observability/api/')) {
        const name = url.pathname.split('/api/')[1];
        state.calls.push({ name, params: Object.fromEntries(url.searchParams) });
        const minutes = Number(url.searchParams.get('minutes') || 60);
        const include = url.searchParams.get('include'), container = url.searchParams.get('container');
        json = name === 'session' ? { grant: { role: 'owner', channels: [], services: [] }, channelNames: {} }
          : name === 'overview' ? { channelNames: {}, generatedAt: iso(), lastAt: iso(5000), minutes, http: { count: 100, average: 20, p50: 5, p95: 25, p99: 50, errors: 0, max: 100 }, chat: { count: 50, average: 20, p50: 25, p95: 50, p99: 100, errors: 0, max: 100 }, groups: [], timeline: [] }
          : name === 'resources' ? { samples: [{ at: iso(), service: 'postgres', name: 'collector_up', value: 1 }, { at: iso(), service: 'postgres', name: 'server_bytes', value: 6.5 * GB }], limited: false,
            ...(state.infra && include ? { infrastructure: { receivedAt: iso(3000), snapshot: snapshot(state.problem), container: include === 'infra' ? container : null, ...(include === 'infra' ? series(state.problem, minutes, container) : { series: [] }) } } : {}) }
          : {};
      } else if (url.pathname === '/auth/session') json = { error: false, status: 200, data: { twitch: { id: '533538623', login: 'tester', display_name: 'Tester' }, app: { name: 'Tester', language: 'en', actived: true, twitch_user_id: '533538623', administrating: [] } } };
      return route.fulfill({ status: 200, json });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));

    // Healthy server: the answer first, then gauges, breakdowns and containers.
    await page.goto(base + '/observability?tab=resources&minutes=1440');
    await page.getByText('The server is healthy', { exact: true }).waitFor();
    assert.match(await page.locator('.srv-status').innerText(), /17 of 17 containers running · CPU 26% · memory 53% · disk 56%/);
    const first = state.calls.find(c => c.name === 'resources');
    assert.equal(first.params.include, 'infra'); assert.equal(first.params.minutes, '1440');
    assert.equal(await page.locator('.srv-gauge').count(), 4);
    assert.match(await page.locator('.srv-gauges').innerText(), /CPU[\s\S]*26%[\s\S]*of 16 cores[\s\S]*Memory[\s\S]*53%[\s\S]*Disk[\s\S]*56%[\s\S]*Network/);
    const mem = await page.locator('#srv-mem-title').locator('..').innerText();
    for (const part of ['Bot & API', 'Databases', 'AI helpers', 'Websites & extension', 'Internal tools', 'System & other', 'Available']) assert(mem.includes(part), `memory legend ${part}`);
    const disk = await page.locator('#srv-disk-title').locator('..').innerText();
    assert.match(disk, /Build cache[\s\S]*could be freed/); assert.match(disk, /24\.7 GiB is old build cache and images/);
    // Each group keeps its own palette colour in the bar, legend and list headers (not a fallback grey).
    const colours = await page.evaluate(() => [...document.querySelectorAll('#srv-mem-title ~ .srv-stack > span')].map(el => getComputedStyle(el).backgroundColor));
    assert.equal(new Set(colours).size, colours.length, `distinct memory colours ${colours}`);
    const swatch = await page.locator('.srv-group .srv-swatch').first().evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(swatch, colours[0], 'group header matches its memory segment');
    const groups = await page.locator('.srv-group').allInnerTexts();
    assert.deepEqual(groups.map(g => g.split(/\n|\d/)[0].trim()), ['Bot & API', 'Databases', 'AI helpers', 'Websites & extension', 'Internal tools']);
    assert.equal(await page.locator('.srv-row').count(), 17);
    assert.match(await page.locator('.srv-row', { hasText: 'API server' }).innerText(), /dima-server[\s\S]*Up 3 days/);
    assert.match(await page.locator('.srv-row', { hasText: 'dima-analytics' }).innerText(), /of 512/);
    // Host details stay tucked away until asked for.
    assert.equal(await page.locator('.srv-more').evaluate(d => d.open), false);
    await page.locator('.srv-more > summary').click();
    await until(async () => /Time stalled[\s\S]*Docker version[\s\S]*29\.8\.0/.test(await page.locator('.srv-more').innerText()), 'host facts');
    await page.locator('.srv-more > summary').click();
    // Sort by memory: biggest first; back to roles.
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await until(async () => (await page.locator('.srv-group').count()) === 0, 'memory sort is a flat list');
    assert.match(await page.locator('.srv-row').first().innerText(), /Workers/);
    assert.match(await page.locator('.srv-row').nth(1).innerText(), /Embeddings/);
    await page.getByRole('button', { name: 'By role', exact: true }).click();
    await until(async () => (await page.locator('.srv-group').count()) === 5, 'group sort');
    await scrollShots(page, `servers-${tag}`);

    // Drill into MongoDB: one request with its name, charts + facts, URL keeps it.
    const before = state.calls.length;
    const row = page.locator('.srv-row', { hasText: 'MongoDB' });
    await row.click();
    await until(async () => (await row.getAttribute('aria-expanded')) === 'true', 'expanded');
    await until(() => state.calls.slice(before).some(c => c.name === 'resources' && c.params.container === 'mongodb' && c.params.include === 'infra'), 'detail request');
    await until(async () => (await page.locator('.srv-detail app-obs-chart .ch__line').count()) >= 6, 'detail charts drawn');
    assert.equal(await page.locator('.srv-detail app-obs-chart').count(), 4);
    assert.match(page.url(), /container=mongodb/);
    const facts = await page.locator('.srv-facts').innerText();
    for (const f of ['mongo:8.2.6', 'Memory limit', '5.00 GiB', 'Restart policy', 'unless-stopped', 'Health check', 'healthy']) assert(facts.includes(f), `fact ${f}`);
    assert.equal(await page.locator('.srv-detail .ch__limit').count(), 2, 'CPU and memory charts show their limit lines');
    // Tooltip on hover/touch over the CPU chart, including the spike's peak.
    const plot = page.locator('.srv-detail .ch__plot').first();
    await plot.scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
    const box = await plot.boundingBox();
    if (width < 600) await plot.tap({ position: { x: box.width * 0.5, y: box.height / 2 } });
    else await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 4 });
    await until(async () => (await page.locator('.srv-detail .ch__tip').count()) === 1, 'tooltip');
    assert.match(await page.locator('.srv-detail .ch__tip').innerText(), /\d\d:\d\d[\s\S]*%/);
    assert.match(await plot.getAttribute('aria-label'), /CPU \(% of one core\)\. CPU: average .*%, peak .*%/);
    await shot(page, `servers-${tag}-detail`);
    await axe(page, `servers ${tag}`);
    assert(await overflow(page), `no horizontal overflow ${tag}`);
    // Range change keeps the selection and refetches its history.
    await page.locator('.srv-row', { hasText: 'dima-cron' }).click();
    await until(async () => /sha256:72df59845ea8\n/.test(await page.locator('.srv-facts').innerText().catch(() => '')), 'digest shortened');
    await page.locator('.srv-row', { hasText: 'MongoDB' }).click();
    await until(async () => (await row.getAttribute('aria-expanded')) === 'true', 're-expanded');
    const beforeRange = state.calls.length;
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await until(() => state.calls.slice(beforeRange).some(c => c.name === 'resources' && c.params.minutes === '10080' && c.params.container === 'mongodb'), 'range refetch');
    await row.click();
    await until(async () => (await page.locator('.srv-detail').count()) === 0, 'collapsed');
    await until(() => !/container=/.test(page.url()), 'container leaves the URL');

    // Problems: answer names them, rows carry the tone, overview lists them with a shortcut.
    state.problem = true;
    await page.getByRole('button', { name: 'Last 24 hours' }).click();
    await page.getByText(/Piper voices is not running/).first().waitFor();
    const status = await page.locator(".srv-status").innerText();
    assert.match(status, /^4 things on the server need a look/);
    for (const expected of [/Piper voices is not running[\s\S]*stopped after running out of memory/, /Qdrant is unhealthy/, /Disk is 93% full/, /Chat bot restarted 2 times in the last 24 hours/])
      assert.match(status, expected);
    assert.equal(await page.locator('.srv-row', { hasText: 'Piper voices' }).locator('.srv-dot').getAttribute('data-tone'), 'live');
    assert.match(await page.locator('.srv-row', { hasText: 'Piper voices' }).innerText(), /Stopped \d+ min ago · out of memory/);
    assert.equal(await page.locator('.srv-gauge--bad').count(), 1, 'disk gauge turns red');
    await axe(page, `servers problems ${tag}`);
    await shot(page, `servers-${tag}-problems`);
    await page.locator('.srv-issues li', { hasText: 'Qdrant is unhealthy' }).getByRole('button', { name: 'Show' }).click();
    await until(async () => (await page.locator('.srv-row', { hasText: 'Qdrant' }).getAttribute('aria-expanded')) === 'true', 'issue opens container');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('.obs-attention__row', { hasText: 'Disk is 93% full' }).waitFor();
    const overviewCall = state.calls.filter(c => c.name === 'resources').at(-1);
    assert.equal(overviewCall.params.include, 'snapshot', 'overview asks for the light snapshot only');
    await page.locator('.obs-attention__row', { hasText: 'Piper voices is not running' }).click();
    await until(async () => (await page.locator('.srv-row', { hasText: 'Piper voices' }).getAttribute('aria-expanded')) === 'true', 'overview shortcut opens container');

    // Sidecar not deployed / not reporting: honest empty state, database tiles still render.
    state.infra = false; state.problem = false;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText("Server stats aren't available yet").waitFor();
    await page.getByText('Inside the databases').waitFor();
    assert.equal(await page.locator('.srv-row').count(), 0);
    assert(await overflow(page), `no overflow empty ${tag}`);
    assert.deepEqual(errors, [], `page errors ${tag}`);
    console.log(`Servers ${tag}: OK`);
    await context.close();
  }
} finally { await browser.close(); }
console.log('Servers tab: host, memory/disk breakdown, containers, drill-down, problems and empty state verified');
