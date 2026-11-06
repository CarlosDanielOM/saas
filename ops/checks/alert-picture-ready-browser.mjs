// Designed alerts appear only once their displayed pictures are loaded and decoded:
// never blank or half painted, and their motion, sound and duration start at that moment.
// OBS renderer and Studio test alerts. Every API and socket is mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { openStudio } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL || process.argv[2]; assert(base, 'SAAS_PREVIEW_URL required');
const api = 'https://api.domdimabot.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 8000) { for (let i = 0; i < ms / 25; i++) { if (await fn()) return; await sleep(25); } throw Error('Timed out: ' + label); }
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];

// A large baseline JPEG, the kind that paints top to bottom while its bytes stream in.
const jpeg = await (async () => {
  const page = await browser.newPage();
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1042; c.height = 1024; const g = c.getContext('2d');
    for (let y = 0; y < c.height; y += 8) for (let x = 0; x < c.width; x += 8) { g.fillStyle = `hsl(${(x * 7 + y * 13) % 360} 80% ${30 + (x * y) % 40}%)`; g.fillRect(x, y, 8, 8); }
    const bytes = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', .95))).arrayBuffer());
    let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
  });
  await page.close(); return Buffer.from(b64, 'base64');
})();
const wav = (() => { const n = 8000, b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44); return b; })();

// Per alert (playback key): frames hidden, motion or sound while hidden, and visible frames
// whose picture was not complete. Idle Studio thumbnails are not alerts.
const SAMPLER = () => {
  window.__gate = {};
  const tick = () => {
    for (const el of document.querySelectorAll('.placement[data-event]:not([data-idle])')) {
      const key = el.dataset.playbackKey, rec = window.__gate[key] ??= { hidden: 0, motionHidden: 0, soundHidden: 0, partialVisible: 0, firstVisible: 0, firstSeen: Date.now() };
      if (getComputedStyle(el).visibility !== 'visible') {
        rec.hidden++;
        if (el.getAnimations({ subtree: true }).some(a => /^alert-(object|keyframe)/.test(a.id))) rec.motionHidden++;
        if (document.querySelector('app-overlay-sound')) rec.soundHidden++;
      } else {
        rec.firstVisible ||= Date.now();
        const images = [...el.querySelectorAll('[data-overlay-image]')].map(layer => layer.querySelector('img'));
        if (images.some(img => !img || !img.complete || !img.naturalWidth)) rec.partialVisible++;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
// Holds HTMLImageElement.decode() for pictures whose URL contains window.__holdDecode,
// to prove an alert waits for decoding, not only for its bytes.
const DECODE_HOLD = () => {
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    const done = decode.call(this);
    return window.__holdDecode && this.currentSrc.includes(window.__holdDecode) ? done.then(() => new Promise(r => { window.__releaseDecode = r; })) : done;
  };
};
const gate = (page, key) => page.evaluate(key => window.__gate[key], String(key));

// ---------- OBS renderer ----------
const publicId = 'd'.repeat(48);
const ids = { fast: 'a'.repeat(24), slow: 'b'.repeat(24), broken: 'c'.repeat(24), stalled: 'e'.repeat(24), sound: 'f'.repeat(24), second: '9'.repeat(24) };
const motion = { enter: 'fade', exit: 'fade', loop: 'none', delay: 0, enterDuration: .2, exitDuration: .2, loopDuration: 1 };
const layoutWith = (imageId, extra = []) => ({ duration: 1.2, sound: { assetId: ids.sound, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }, widgets: [
  { id: 'img', kind: 'image', x: 80, y: 50, width: 190, height: 160, visible: true, locked: false, assetId: imageId, motion }, ...extra,
  { id: 'spark', kind: 'animation', x: 60, y: 40, width: 450, height: 180, visible: true, locked: true },
  { id: 'txt', kind: 'text', x: 270, y: 60, width: 230, height: 150, visible: true, locked: false, text: 'Luna followed' }] });
const snapshot = { width: 1920, height: 1080, waitFor: ['follow'], widgets: [{ id: 'alert-1', kind: 'alert', x: 110, y: 800, width: 640, height: 192, visible: true, locked: false, designId: 'd1', events: ['follow'] }],
  designs: [{ id: 'd1', name: 'x', width: 800, height: 240, revision: 1, events: { follow: layoutWith(ids.fast) } }] };

async function obs(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  let socket; const ended = {}, health = [], calls = [], held = [];
  const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
  await context.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws;
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(raw => {
      const m = String(raw);
      if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision: 1, snapshot }); }
      if (m.includes('"overlay-ended"')) ended[JSON.parse(m.slice(m.indexOf(',') + 1))[1]] = Date.now();
      if (m.includes('"overlay-health"')) health.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1].issue);
    });
  });
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin === new URL(base).origin || u.hostname.endsWith('googleapis.com') || u.hostname.endsWith('gstatic.com')) return route.continue();
    if (u.pathname.includes('/assets/')) {
      const id = u.pathname.split('/').at(-1), type = req.resourceType(); calls.push({ id, type });
      if (id === ids.sound) return route.fulfill({ contentType: 'audio/wav', body: wav });
      if (id === ids.fast) return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
      // Slow, broken and stalled pictures fail the local download, so the alert falls
      // back to a network <img>: the case that used to paint top to bottom on screen.
      if (type === 'fetch') return route.fulfill({ status: 503, body: '' });
      if (id === ids.broken) return route.fulfill({ status: 404, body: '' });
      held.push({ id, route }); return;
    }
    if (u.pathname.includes('/events/')) {
      const id = u.pathname.split('/').at(-1), name = id.split('-')[1];
      // "mixed": a broken picture next to one that is still loading.
      const layout = name === 'mixed' ? layoutWith(ids.broken, [{ id: 'img-2', kind: 'image', x: 560, y: 50, width: 190, height: 160, visible: true, locked: false, assetId: ids.second }]) : layoutWith(ids[name]);
      return route.fulfill({ json: { data: { id, kind: 'follow', snapshot, layouts: { d1: layout } } } });
    }
    return route.abort();
  });
  await context.addInitScript(DECODE_HOLD);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/overlays/' + publicId);
  await until(() => calls.some(c => c.id === ids.fast) && calls.some(c => c.id === ids.sound), 'published picture and sound preload');
  await sleep(500); await page.evaluate(SAMPLER);
  const placement = page.locator('.placement[data-event=follow]');

  // 1. Local bytes (the normal case): shown at once, whole.
  let sent = Date.now(); send('overlay-event', { id: 'follow-fast-1', kind: 'follow' });
  await until(async () => (await gate(page, 'follow-fast-1'))?.firstVisible, 'local alert shows');
  let rec = await gate(page, 'follow-fast-1');
  assert.ok(rec.firstVisible - sent < 600, `local picture alert shows promptly (${rec.firstVisible - sent} ms)`);
  assert.match(await placement.locator('img').getAttribute('src'), /^blob:/, 'local bytes are displayed');
  assert.equal(rec.partialVisible, 0, 'never visible before its picture is complete');
  await until(() => ended['follow-fast-1'], 'local alert completes');

  // 2. Network picture held mid-load, then mid-decode: hidden, still and silent until decoded.
  await page.evaluate(id => { window.__holdDecode = id; }, ids.slow);
  sent = Date.now(); send('overlay-event', { id: 'follow-slow-1', kind: 'follow' });
  await until(() => held.some(h => h.id === ids.slow), 'network picture requested');
  await placement.locator('[data-overlay-image] img').waitFor({ state: 'attached' });
  await sleep(1500);
  rec = await gate(page, 'follow-slow-1');
  assert.ok(rec.hidden > 10 && !rec.firstVisible, 'alert stays hidden while its picture loads');
  assert.equal(await placement.getAttribute('data-waiting'), '', 'waiting state is exposed');
  assert.equal(rec.motionHidden, 0, 'no motion before the picture is ready');
  assert.equal(rec.soundHidden, 0, 'no sound before the picture is ready');
  assert.equal(ended['follow-slow-1'], undefined, 'its duration has not started');
  for (const h of held.filter(h => h.id === ids.slow)) await h.route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  await until(() => placement.locator('[data-overlay-image] img').evaluate(img => img.complete && img.naturalWidth > 0), 'picture bytes arrive');
  await until(() => page.evaluate(() => !!window.__releaseDecode), 'displayed picture is being decoded');
  await sleep(600);
  rec = await gate(page, 'follow-slow-1');
  assert.ok(!rec.firstVisible && rec.motionHidden + rec.soundHidden === 0, 'loaded but undecoded picture still holds the alert');
  const released = Date.now();
  await page.evaluate(() => { window.__holdDecode = ''; window.__releaseDecode(); });
  await until(async () => (await gate(page, 'follow-slow-1'))?.firstVisible, 'alert shows after its picture is decoded');
  rec = await gate(page, 'follow-slow-1');
  assert.equal(rec.partialVisible, 0, 'first visible frame already has the whole picture');
  await until(() => page.locator('app-overlay-sound audio').evaluate(a => !a.paused && a.currentTime > 0).catch(() => false), 'sound plays from the reveal', 3000);
  assert.ok(await placement.evaluate(e => e.getAnimations({ subtree: true }).some(a => a.id.startsWith('alert-object'))), 'motion starts with the reveal');
  await until(() => ended['follow-slow-1'], 'held alert completes');
  const played = ended['follow-slow-1'] - rec.firstVisible;
  assert.ok(rec.firstVisible >= released && played >= 1050 && played < 2600, `full duration runs after the reveal (${played} ms)`);

  // 3. Broken picture: reported, never holds the alert back.
  sent = Date.now(); send('overlay-event', { id: 'follow-broken-1', kind: 'follow' });
  await until(async () => (await gate(page, 'follow-broken-1'))?.firstVisible, 'broken picture alert still shows');
  rec = await gate(page, 'follow-broken-1');
  assert.ok(rec.firstVisible - sent < 2000, `broken picture does not delay the alert (${rec.firstVisible - sent} ms)`);
  await until(() => health.includes('media'), 'broken picture is reported');
  await until(() => ended['follow-broken-1'], 'broken picture alert completes');

  // 4. A broken picture next to a loading one: the alert still waits for the healthy picture.
  send('overlay-event', { id: 'follow-mixed-1', kind: 'follow' });
  await until(() => held.some(h => h.id === ids.second), 'second picture requested');
  await until(() => placement.locator('[data-overlay-failed]').count().then(n => n === 1), 'broken picture reported');
  await sleep(1000);
  rec = await gate(page, 'follow-mixed-1');
  assert.ok(rec.hidden > 10 && !rec.firstVisible, 'one broken picture does not reveal a still-loading one');
  for (const h of held.filter(h => h.id === ids.second)) await h.route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  await until(async () => (await gate(page, 'follow-mixed-1'))?.firstVisible, 'mixed alert shows once the healthy picture is ready');
  const shown = await placement.evaluate(el => [...el.querySelectorAll('[data-overlay-image]:not([data-overlay-failed]) img')].every(img => img.complete && img.naturalWidth > 0));
  assert.ok(shown, 'healthy picture is whole when the mixed alert appears');
  await until(() => ended['follow-mixed-1'], 'mixed alert completes');
  await page.screenshot({ path: `/tmp/alert-picture-ready-${width}.png` });
  return { context, page, send, ended, held, placement };
}

// ---------- Studio test alert ----------
async function studio(width) {
  const user = { id: '990191', login: 'fixture', display_name: 'Fixture' };
  const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const layer = (id, kind, x, y, w, h, extra = {}) => ({ id, kind, x, y, width: w, height: h, visible: true, locked: false, ...extra });
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, { duration: 1.2, sound: { assetId: 'sound', volume: 0, delay: 0, fadeIn: 0, fadeOut: 0 },
    widgets: [layer(k + '-art', 'image', 50, 50, 120, 120, { assetId: k, motion }), layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48 })] }])) };
  const widgets = [layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['tts'], widgets, published: { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: ['tts'], designs: [design] } };
  const state = { schemaVersion: 1, revision: 4, scenes: [main], designs: [design] };
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(({ user, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', 'en'); localStorage.setItem('theme', 'dark');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  const held = [], requests = [];
  let holdImages = false, fetchOk = false;
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.postDataJSON?.();
    if (url.pathname.startsWith('/asset-library/') && url.pathname.endsWith('/access')) {
      const id = url.pathname.split('/').at(-2); requests.push({ id, type: 'access' });
      return route.fulfill({ json: { data: { path: `/asset-library/content/${id}?ticket=${requests.length}` } } });
    }
    if (url.pathname.startsWith('/asset-library/content/')) {
      const id = url.pathname.split('/').at(-1); requests.push({ id, type: req.resourceType() });
      if (id === 'sound') return route.fulfill({ contentType: 'audio/wav', body: wav });
      // First the local download fails and the displayed <img> is held mid-load;
      // later tests download normally, to prove repeats reuse the bytes.
      if (req.resourceType() === 'fetch') return fetchOk ? route.fulfill({ contentType: 'image/jpeg', body: jpeg }) : route.fulfill({ status: 503, body: '' });
      if (holdImages) { held.push({ id, route }); return; }
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    }
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = body.texts.map(t => t.replaceAll('$(user)', body.user));
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}`) data = state;
    else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
  await openStudio(page, 'test');
  // The box's resting example (another event's design) is fully shown before the test.
  await until(() => page.locator('.stage .placement[data-idle] [data-overlay-image] img').evaluateAll(imgs => imgs.length > 0 && imgs.every(img => img.complete && img.naturalWidth > 0)), 'resting example loaded');
  holdImages = true;
  await page.evaluate(SAMPLER);
  // What the user saw: after clicking a test, the box's resting example switched to the tested
  // design and streamed its picture in. No visible frame of the box may show a partial picture.
  await page.evaluate(() => {
    window.__idlePartial = 0;
    const tick = () => {
      for (const el of document.querySelectorAll('.stage .placement[data-idle][data-widget-id="alert-1"]')) {
        if (getComputedStyle(el).visibility !== 'visible') continue;
        if ([...el.querySelectorAll('[data-overlay-image]')].some(layer => { const img = layer.querySelector('img'); return !img || !img.complete || !img.naturalWidth; })) window.__idlePartial++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('.test-btn').filter({ hasText: 'Follow' }).click();
  const placement = page.locator('.stage .placement[data-event=follow]:not([data-idle])');
  await placement.locator('[data-overlay-image] img').waitFor({ state: 'attached' });
  const key = await placement.getAttribute('data-playback-key');
  await sleep(1200);
  let rec = await gate(page, key);
  assert.ok(rec.hidden > 5 && !rec.firstVisible, 'Studio test alert stays hidden while its picture loads');
  assert.equal(rec.motionHidden + rec.soundHidden, 0, 'Studio: no motion or sound before the picture');
  const released = Date.now();
  holdImages = false;
  for (const h of held.splice(0)) await h.route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  await until(async () => (await gate(page, key))?.firstVisible, 'Studio alert shows after its picture loads');
  rec = await gate(page, key);
  assert.equal(rec.partialVisible, 0, 'Studio: first visible frame has the whole picture');
  await until(async () => await placement.count() === 0, 'Studio alert completes', 6000);
  const played = Date.now() - rec.firstVisible;
  assert.ok(rec.firstVisible >= released && played >= 1050, `Studio: full duration runs after the reveal (${played} ms)`);
  assert.equal(await page.evaluate(() => window.__idlePartial), 0, 'Studio: the box never shows a half-loaded resting example while a test prepares');

  // Repeat tests reuse the downloaded picture: no new link or download, and it shows at once.
  fetchOk = true;
  await page.locator('.test-btn').filter({ hasText: 'Follow' }).click();
  await until(async () => await placement.count() === 1, 'second Studio test starts');
  await until(async () => await placement.count() === 0, 'second Studio test completes', 8000);
  const before = requests.filter(r => r.id === 'follow' && (r.type === 'access' || r.type === 'fetch')).length;
  const clicked = Date.now();
  await page.locator('.test-btn').filter({ hasText: 'Follow' }).click();
  await until(async () => await placement.count() === 1, 'third Studio test starts');
  const third = await placement.getAttribute('data-playback-key');
  await until(async () => (await gate(page, third))?.firstVisible, 'third Studio test shows');
  rec = await gate(page, third);
  assert.ok(rec.firstVisible - clicked < 800 && rec.partialVisible === 0, `Studio: repeat test shows whole and promptly (${rec.firstVisible - clicked} ms)`);
  assert.equal(requests.filter(r => r.id === 'follow' && (r.type === 'access' || r.type === 'fetch')).length, before, 'Studio: repeat test downloads nothing new');
  assert.match(await placement.locator('[data-overlay-image] img').getAttribute('src'), /^blob:/, 'Studio: repeat test plays local bytes');
  assert.equal(await page.evaluate(() => window.__idlePartial), 0, 'Studio: resting example stays hidden during repeat tests');
  await until(async () => await placement.count() === 0, 'third Studio test completes', 8000);
  await page.screenshot({ path: `/tmp/alert-picture-ready-studio-${width}.png` });
  await context.close();
}

try {
  for (const [width, height] of [[1920, 1080], [1280, 720]]) {
    const run = await obs(width, height);
    if (width === 1920) {
      // 5. A picture that never arrives still lets the alert play after the bounded wait.
      const sent = Date.now(); run.send('overlay-event', { id: 'follow-stalled-1', kind: 'follow' });
      await until(async () => (await gate(run.page, 'follow-stalled-1'))?.firstVisible, 'stalled picture alert shows after the limit', 12000);
      const waited = (await gate(run.page, 'follow-stalled-1')).firstVisible - sent;
      assert.ok(waited >= 7500 && waited < 10500, `stalled picture waits the bounded limit (${waited} ms)`);
      await until(() => run.ended['follow-stalled-1'], 'stalled alert completes', 4000);
    }
    await run.context.close();
  }
  for (const width of [390, 1280]) await studio(width);
  assert.deepEqual(errors, []);
  console.log('PASS alert picture readiness: OBS and Studio alerts stay hidden, still and silent until their displayed pictures are loaded and decoded, then show whole with sound playing and full duration; local bytes show promptly; a broken picture is reported without delay and never reveals a still-loading one; stalled pictures wait a bounded 8 s');
} finally { await browser.close(); }
