// Native browser paint-order check against the production editor and OBS route.
// Every API, websocket and media request uses local disposable fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const upstream = process.env.SAAS_PREVIEW_URL;
assert(upstream, 'SAAS_PREVIEW_URL is required');
const mp4 = Buffer.from('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', 'base64');
const user = { id: '990195', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const publicId = 'e'.repeat(48);
const layer = (id, kind) => ({ id, kind, x: 10, y: 10, width: 500, height: 200, visible: true, locked: false });
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 500, height: 200, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 60, widgets: [{ ...layer('alert-text', 'text'), x: 0, y: 0, width: 500, height: 200, text: 'Luna', color: '#ffffff', fontSize: 36 }] }])) };
const snapshot = { width: 800, height: 450, waitFor: [], widgets: [layer('trigger-1', 'trigger'), { ...layer('alert-1', 'alert'), designId: 'starter', events: ['sub', 'bits'] }], designs: [design] };
let state = { schemaVersion: 1, revision: 0, scenes: [{ ...snapshot, id: 'main', name: 'Overlap fixture', publicId, revision: 0 }], designs: [design] };
const results = new Map();
let complete;
const finished = new Promise(resolve => { complete = resolve; });
function bootstrap(config) {
  const { user, app, snapshot, publicId } = config;
  localStorage.clear();
  localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  localStorage.setItem('dimasite.language', 'en');
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const target = new URL(String(url), location.href);
    if (target.origin !== location.origin) url = '/__api?path=' + encodeURIComponent(target.pathname);
    return open.call(this, method, url, ...args);
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, options) => {
    const target = new URL(typeof url === 'string' ? url : url.url || String(url), location.href);
    return originalFetch(target.origin === location.origin ? url : '/__api?path=' + encodeURIComponent(target.pathname), options);
  };
  const emit = (socket, data) => socket.dispatchEvent(new MessageEvent('message', { data }));
  window.WebSocket = class extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; bufferedAmount = 0; binaryType = 'arraybuffer';
    dispatchEvent(event) { this['on' + event.type]?.(event); return super.dispatchEvent(event); }
    constructor(url) { super(); const socket = String(url).includes('/socket.io/'); window.fixture.trace.push(['open', String(url)]); if (socket) window.fixture.socket = this; setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); if (socket) emit(this, '0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}'); }, 20); }
    send(data) { window.fixture.trace.push(['send', String(data)]); if (String(data).startsWith('40/overlay-studio/')) { const ns = '/overlay-studio/' + publicId; setTimeout(() => { emit(this, '40' + ns + ',{"sid":"fixture"}'); setTimeout(() => window.fixture.emit('overlay-state', { revision: 0, snapshot }), 20); }, 0); } }
    close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close')); }
  };
  const wait = async (fn, message) => { for (let n = 0; n < 240; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(message); };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(e => e.textContent.trim() === name);
  const click = async element => { assert(element, 'Missing button'); element.click(); await new Promise(r => setTimeout(r, 150)); };
  const top = (selector, expected) => {
    const node = document.querySelector(selector), rect = node.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + 40, rect.top + 70)?.closest(selector.startsWith('.widget') ? '.widget' : '.canvas > .placement');
    const actual = selector.startsWith('.widget') ? target?.dataset.kind : target?.dataset.event;
    assert(actual === expected, `Paint order: expected ${expected}, got ${actual}`);
  };
  window.fixture = {
    trace: [],
    emit(name, data) { emit(this.socket, `42/overlay-studio/${publicId},${JSON.stringify([name, data])}`); },
    async check(mode) {
      const passed = [];
      try {
        if (mode === 'runtime') {
          await wait(() => document.querySelector('.canvas'), 'Runtime snapshot missing');
          this.emit('overlay-event', { id: 'alert', kind: 'sub' });
          await wait(() => document.querySelector('[data-event="sub"]'), 'Runtime alert missing');
          this.emit('overlay-event', { id: 'video', kind: 'trigger' });
          await wait(() => document.querySelector('[data-event="trigger"] video')?.readyState >= 2, 'Runtime video missing');
          top('[data-event="trigger"]', 'sub'); passed.push('alert above later trigger video');
          const player = document.querySelector('video'); await player.play(); player.pause();
          const changed = structuredClone(snapshot); changed.widgets.reverse();
          await originalFetch('/__snapshot', { method: 'POST', body: JSON.stringify(changed) });
          this.emit('overlay-state', { revision: 1, snapshot: changed });
          this.emit('overlay-event', { id: 'video-reordered', kind: 'trigger' });
          this.emit('overlay-event', { id: 'alert-reordered', kind: 'sub' });
          await wait(() => document.querySelectorAll('.canvas > .placement').length === 4, 'Reordered events missing');
          assert([...document.querySelectorAll('[data-event="trigger"]')].at(-1).style.zIndex === '1', 'Reordered trigger index');
          top('[data-event="trigger"]', 'trigger'); passed.push('published order; active events keep frozen order');
          assert(document.body.style.background === 'transparent', 'OBS transparency'); passed.push('transparent OBS canvas');
        } else {
          await wait(() => document.querySelector('.stage'), 'Editor missing');
          if (mode === 'mobile') await click(button('Canvas', document.querySelector('.mobile-tabs')));
          document.querySelector('.stage').scrollIntoView({ block: 'center' });
          await click(button('Trigger alerts', document.querySelector('.event-tester__actions')));
          await wait(() => document.querySelector('.widget[data-kind="trigger"] video')?.readyState >= 2, 'Preview video missing');
          const video = document.querySelector('.widget video'); await video.play(); video.pause();
          await new Promise(r => setTimeout(r, 3300)); // Let preview-pulse finish: it can temporarily create a stacking context.
          top('.widget[data-kind="trigger"]', 'alert'); passed.push('video stays below alert after preview animation');
          const trigger = document.querySelector('.widget[data-kind="trigger"]'); trigger.click();
          await new Promise(r => setTimeout(r, 100));
          top('.widget[data-kind="trigger"]', 'alert'); passed.push('selection preserves paint order');
          if (mode !== 'mobile') {
            await click(button('Bring forward')); top('.widget[data-kind="trigger"]', 'trigger');
            await click(button('Send backward')); top('.widget[data-kind="trigger"]', 'alert');
            passed.push('reorder takes effect during native playback');
            await click(button('Save draft'));
            await wait(() => !!button('Saved'), 'Save missing');
            await click([...document.querySelectorAll('button')].find(e => e.textContent.includes('Publish live')));
            await wait(() => document.body.textContent.includes('Published. Connected browser sources are updating.'), 'Publish missing');
            passed.push('save and publish retain order');
          }
          assert(document.documentElement.scrollWidth <= innerWidth, 'Horizontal page overflow'); passed.push('responsive layout');
        }
        const report = { mode, passed, ok: true };
        await originalFetch('/__result', { method: 'POST', body: JSON.stringify(report) });
        return report;
      } catch (error) {
        const report = { mode, passed, ok: false, error: error.message, trace: this.trace, body: document.body.innerText.slice(-1600) };
        await originalFetch('/__result', { method: 'POST', body: JSON.stringify(report) });
        return report;
      }
    }
  };
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    const body = async () => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); };
    const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/__result') {
      const report = await body(); console.log(JSON.stringify(report)); results.set(report.mode, report); json({});
      if (!report.ok || ['editor', 'mobile', 'runtime'].every(mode => results.get(mode)?.ok)) complete(); return;
    }
    if (url.pathname === '/__snapshot') { Object.assign(snapshot, await body()); json({}); return; }
    if (url.pathname === '/__video.mp4') { res.setHeader('content-type', 'video/mp4'); res.end(mp4); return; }
    if (url.pathname === '/__api') {
      const path = url.searchParams.get('path'); let data = {};
      if (path === '/auth/session') data = { twitch: user, app };
      else if (path.endsWith('/access') || path.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
      else if (path === `/triggers/${user.id}`) data = [{ _id: '1'.repeat(24), name: 'Video fixture', file: `http://127.0.0.1:${server.address().port}/__video.mp4`, mediaType: 'video/mp4', volume: 0 }];
      else if (path.startsWith('/triggers/library/')) data = [];
      else if (path.endsWith('/preview')) data = (await body()).texts.map(text => text.replace('$(user)', 'Luna'));
      else if (path.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
      else if (path === `/overlay-studio/${user.id}`) { if (req.method === 'PUT') { state = await body(); state.revision++; } data = state; }
      else if (path.endsWith('/publish')) { const scene = state.scenes[0]; scene.revision++; scene.published = structuredClone({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor, designs: state.designs }); state.revision++; data = state; }
      else if (path.includes('/events/')) {
        const id = path.split('/').at(-1); data = id.startsWith('video') ? { id, kind: 'trigger', triggerId: '1'.repeat(24), media: { type: 'video', url: `http://127.0.0.1:${server.address().port}/__video.mp4`, title: 'Native video fixture', volume: 0, duration: 60 } } : { id, kind: 'sub', layouts: { starter: design.events.sub } };
      } else if (path.startsWith('/overlay-studio/public/')) data = { revision: 0, snapshot };
      json({ error: false, status: 200, data }); return;
    }
    const response = await fetch(new URL(req.url, upstream));
    res.statusCode = response.status; res.setHeader('content-type', response.headers.get('content-type') || 'application/octet-stream');
    if (response.headers.get('content-type')?.includes('text/html')) {
      const script = `(${bootstrap.toString()})(${JSON.stringify({ user, app, snapshot, publicId })});`;
      res.end((await response.text()).replace('<head>', `<head><script>${script}</script>`));
    } else res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});
server.listen(Number(process.env.SAAS_FIXTURE_PORT || 4223), '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
console.log(`Isolated fixture http://127.0.0.1:${server.address().port}/fixture/modules/overlays; runtime /overlays/${publicId}`);
const timer = setTimeout(() => complete(), 600000);
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => new URL(route.request().url()).origin === fixtureOrigin ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => { errors.push(error.message); console.log('Browser error:', error.message); });
  const screenshots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/saas-overlay-stacking-shots';
  await mkdir(screenshots, { recursive: true });
  await page.goto(fixtureOrigin + '/fixture/modules/overlays');
  assert((await page.evaluate(() => fixture.check('editor'))).ok, 'Editor paint order failed');
  await page.screenshot({ path: screenshots + '/desktop.png', fullPage: true });
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  const axe = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.reload();
  assert((await page.evaluate(() => fixture.check('mobile'))).ok, 'Mobile paint order failed');
  await page.screenshot({ path: screenshots + '/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixtureOrigin + '/overlays/' + publicId);
  assert((await page.evaluate(() => fixture.check('runtime'))).ok, 'OBS paint order failed');
  await page.screenshot({ path: screenshots + '/obs.png', fullPage: true });
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  await finished;
  for (const mode of ['editor', 'mobile', 'runtime']) assert(results.get(mode)?.ok, JSON.stringify(results.get(mode) || { missing: mode }));
  console.log('PASS native video paint order, selection, reorder, publish, mobile and OBS runtime.');
} finally { clearTimeout(timer); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
