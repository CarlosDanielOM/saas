// Trigger looks: a trigger box plays the trigger's look (alert-style layout on its own canvas) instead of its plain
// media, on the OBS page and in the Studio's Test path (same renderer). Every API, socket and media request is
// mocked; the WebM is recorded in the browser (canvas + MediaRecorder) and the WAVs are generated here.
import { openStudio } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import { withLive, publishedCopy } from '/root/saas/ops/checks/overlay-studio-live-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const AXE = process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com', publicId = 'f'.repeat(48), T1 = '1'.repeat(24), T2 = '2'.repeat(24), T3 = '3'.repeat(24);
const user = { id: '990391', login: 'lookfixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
const still = (delay, end) => ({ enter: 'none', exit: 'none', loop: 'none', delay, enterDuration: .5, exitDuration: .5, loopDuration: 2, ...(end === undefined ? {} : { end }) });
const F = 'https://fixture.invalid';
// A 16:9 look: a full-canvas shape, a picture shown from 1 s to 2.5 s, server-rendered text, a timed video with its
// own sound (plays once from 0.5 s) and two sounds in their own windows.
const look = { width: 1600, height: 900, layout: { duration: 4, widgets: [
  layer('bg', 'shape', 0, 0, 1600, 900, { color: '#123456', motion: still(0) }),
  // No entrance animation and a 1 s start: this exact case used to stay invisible in real playback (never when scrubbing).
  layer('pic', 'image', 100, 100, 400, 400, { mediaUrl: `${F}/pic.svg`, motion: still(1, 2.5) }),
  layer('title', 'text', 600, 80, 900, 200, { text: 'Look for Luna', fontSize: 80, motion: still(0) }),
  layer('clip', 'video', 600, 400, 640, 360, { mediaUrl: `${F}/clip.webm`, volume: .8, loop: false, motion: still(.5) })
], sounds: [
  { id: 'one', url: `${F}/one.wav`, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0, end: 1.2 },
  { id: 'two', url: `${F}/two.wav`, volume: .6, delay: 2, fadeIn: 0, fadeOut: 0 }
] } };
const plain = { type: 'image', url: `${F}/plain.svg`, title: 'Plain', volume: 1 };
const svg = (w, h, fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
// 3 s, 8 kHz mono 16-bit tone.
const wave = Buffer.alloc(44 + 16000 * 3); wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 0; i < 24000; i++) wave.writeInt16LE(Math.round(Math.sin(i / 8000 * 2 * Math.PI * 440) * 3000), 44 + i * 2);
function ranged(route, bytes, mime) {
  const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/), start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: range ? 206 : 200, contentType: mime, headers: { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) }, body: bytes.subarray(start, end + 1) });
}
let webm;
/** Requests for /hang.svg never answer while the check looks; they are released before the context closes. */
const hanging = [];
/** Look fixtures; the picture answers late so the readiness gate is visible. */
async function fixture(route) {
  const path = new URL(route.request().url()).pathname;
  if (path === '/hang.svg') { await new Promise(release => hanging.push(release)); return route.fulfill({ status: 404, body: '' }).catch(() => {}); }
  if (path === '/pic.svg') { await new Promise(r => setTimeout(r, 700)); return route.fulfill({ contentType: 'image/svg+xml', body: svg(400, 400, '#f59e0b') }); }
  if (path === '/plain.svg') return route.fulfill({ contentType: 'image/svg+xml', body: svg(400, 200, '#7c3aed') });
  if (path === '/clip.webm') return ranged(route, webm, 'video/webm');
  if (path.endsWith('.wav')) return ranged(route, wave, 'audio/wav');
  return route.fulfill({ status: 404, body: '' });
}
// Records every media play() (element, source, muted, page time) and which events mounted the plain media player.
function instrument() {
  window.__plays = []; const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__plays.push({ tag: this.tagName, src: (this.currentSrc || this.src).split('/').pop(), muted: this.muted, at: performance.now() }); return play.call(this); };
  window.__media = new Set();
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
    for (const el of document.querySelectorAll('app-overlay-media')) window.__media.add(el.closest('[data-playback-key]')?.getAttribute('data-playback-key') ?? 'studio');
  }).observe(document.body, { subtree: true, childList: true }));
}
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function until(predicate, label, tries = 400) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }
const near = (a, b, tolerance, label) => assert(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);
/** Each look object's rectangle in fractions of its trigger box (zoom-independent, so OBS and Studio compare). */
const geometry = placement => placement.evaluate(box => {
  const outer = box.getBoundingClientRect();
  return Object.fromEntries([...box.querySelectorAll('[data-look-layer]')].map(part => { const r = part.getBoundingClientRect();
    return [part.getAttribute('data-layer-id'), { left: (r.left - outer.left) / outer.width, top: (r.top - outer.top) / outer.height, width: r.width / outer.width, height: r.height / outer.height }]; }));
});
/** When the placement of `id` is shown (readiness gate open), in page time. */
const shownAt = (page, selector) => page.evaluate(selector => new Promise(resolve => { const tick = () => { const el = document.querySelector(selector); if (el && el.getAttribute('data-waiting') === null && el.style.visibility !== 'hidden') resolve(performance.now()); else requestAnimationFrame(tick); }; tick(); }), selector);
/** Effective opacity of a look object (its motion shells included). */
const seen = (page, scope, id) => page.locator(`${scope} [data-layer-id="${id}"] .layer-content`).first().evaluate(content => { let o = 1; for (let e = content; e && !e.matches('[data-event]'); e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; });
const now = page => page.evaluate(() => performance.now());
const plays = (page, src) => page.evaluate(src => window.__plays.filter(p => p.src === src), src);
try {
  // A 1.5 s WebM with picture and a tone.
  const recorder = await browser.newPage();
  const recorded = await recorder.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 }), g = canvas.getContext('2d');
    const audio = new AudioContext(), tone = audio.createOscillator(), out = audio.createMediaStreamDestination(); tone.connect(out); tone.start();
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...out.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' }), chunks = [];
    rec.ondataavailable = e => chunks.push(e.data); let frame = 0;
    const timer = setInterval(() => { g.fillStyle = `hsl(${(frame++ * 12) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 90); }, 33);
    rec.start(); await new Promise(r => setTimeout(r, 1500)); rec.stop(); await new Promise(r => rec.onstop = r); clearInterval(timer); tone.stop();
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); let bin = ''; buf.forEach(b => bin += String.fromCharCode(b)); return btoa(bin);
  });
  await recorder.close(); webm = Buffer.from(recorded, 'base64'); assert(webm.length > 1000, 'recorded a WebM fixture');

  // ── OBS page ──────────────────────────────────────────────────────────────────────────────────────────────
  // A square box (fixed) and a wide box (random placement) both accept every trigger; triggers wait for each other.
  const snapshot = { width: 1920, height: 1080, waitFor: ['trigger'], designs: [], widgets: [
    layer('square', 'trigger', 100, 100, 400, 400), layer('wide', 'trigger', 700, 600, 800, 200, { triggerPlacement: { mode: 'random', margin: 24 } })] };
  const events = new Map(); let obsSquare;
  {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); let socket; const ended = new Map();
    const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
    await context.addInitScript(instrument);
    await context.routeWebSocket('**/*', ws => { if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws; ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}'); ws.onMessage(m => { m = String(m); if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision: 1, snapshot }); } if (m.includes('overlay-ended')) ended.set(JSON.parse(m.slice(m.indexOf(',') + 1))[1], Date.now()); }); });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === new URL(base).origin) return route.continue(); if (url.hostname === 'fixture.invalid') return fixture(route); if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: events.get(url.pathname.split('/').at(-1)) } }); if (url.pathname.startsWith('/overlay-studio/public/')) return route.fulfill({ json: { data: { revision: 1, snapshot } } }); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(base + '/overlays/' + publicId); await page.locator('.canvas').waitFor();
    const event = (id, extra) => events.set(id, { id, kind: 'trigger', triggerId: T1, snapshot, media: plain, ...extra });
    event('look-1', { look }); event('plain-1', {}); event('sounds-only', { look: { width: 800, height: 400, layout: { duration: 1.5, widgets: [], sounds: [{ id: 'only', url: `${F}/one.wav`, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }] } } });
    // A healthy shape next to a picture that fails at once and one whose request never settles.
    event('broken-look', { look: { width: 800, height: 400, layout: { duration: 1.5, widgets: [layer('ok', 'shape', 0, 0, 400, 400, { color: '#22c55e', motion: still(0) }),
      layer('gone', 'image', 400, 0, 200, 200, { mediaUrl: `${F}/missing.svg`, motion: still(0) }), layer('hang', 'image', 600, 200, 200, 200, { mediaUrl: `${F}/hang.svg`, motion: still(0) })] } } });
    event('plain-2', {});
    const scope = '[data-event=trigger][data-playback-key="look-1"]', square = page.locator(`${scope}[data-widget-id=square]`), wide = page.locator(`${scope}[data-widget-id=wide]`);
    send('overlay-event', { id: 'look-1', kind: 'trigger' }); send('overlay-event', { id: 'plain-1', kind: 'trigger' });
    // Hidden, and silent, until the look's picture is decoded.
    await square.waitFor({ state: 'attached' }); const mounted = await now(page);
    assert.equal(await square.getAttribute('data-waiting'), '', 'look waits for its pictures'); assert.equal(await square.evaluate(e => e.style.visibility), 'hidden');
    assert.equal((await page.evaluate(() => window.__plays)).length, 0, 'nothing plays while waiting');
    const revealed = await shownAt(page, `${scope}[data-widget-id=square]`), revealedWall = Date.now();
    assert(revealed - mounted > 450, 'shown only once the late picture decoded: ' + (revealed - mounted));
    assert.equal(await wide.getAttribute('data-waiting'), null, 'both boxes open together');
    // The look plays, never the plain media player.
    assert.equal(await page.locator(`${scope} app-overlay-media`).count(), 0, 'no plain media player');
    assert.equal(await square.locator('[data-layer-id=title] span').innerText(), 'Look for Luna', 'server-rendered text shows');
    assert.equal(await page.locator('app-overlay-sound').count(), 2, 'one player per look sound, not one per box');
    // 16:9 look letterboxed in a square box and pillarboxed in a 4:1 box; the full-canvas shape is the stage.
    obsSquare = await geometry(square); const bg = obsSquare.bg;
    near(bg.left, 0, .002, 'square left'); near(bg.width, 1, .002, 'square width'); near(bg.height, 225 / 400, .002, 'square height'); near(bg.top, (1 - 225 / 400) / 2, .002, 'square top');
    const wideBox = await wide.evaluate(e => e.getBoundingClientRect()), wideBg = (await geometry(wide)).bg;
    near(wideBg.width * wideBox.width / (wideBg.height * wideBox.height), 16 / 9, .01, 'wide box keeps the aspect'); near(wideBg.height, 1, .002, 'wide height'); near(wideBg.left, (1 - wideBg.width) / 2, .002, 'wide centred');
    assert(wideBox.left >= 24 - .5 && wideBox.top >= 24 - .5 && wideBox.right <= 1920 - 24 + .5 && wideBox.bottom <= 1080 - 24 + .5, 'random placement inside the canvas margin');
    const pic = square.locator('[data-layer-id=pic]').evaluate(e => e.getBoundingClientRect());
    near((await pic).width / (await pic).height, 1, .01, 'square object stays square');
    // Objects at their times: the picture shows from 1 s to 2.5 s.
    const at = async t => { await until(async () => (await now(page)) - revealed >= t * 1000, 'reach ' + t + ' s'); };
    await at(.4); assert.equal(await seen(page, `${scope}[data-widget-id=square]`, 'pic'), 0, 'picture hidden before its start'); assert(await seen(page, `${scope}[data-widget-id=square]`, 'bg') > .99, 'stage shape visible');
    await at(1.5); assert(await seen(page, `${scope}[data-widget-id=square]`, 'pic') > .99, 'picture visible in its window');
    // Timed video: starts at 0.5 s with its sound in the audio placement only.
    const clips = page.locator(`${scope} [data-layer-id=clip] video`);
    assert.deepEqual(await clips.evaluateAll(vs => vs.map(v => v.muted)), [false, true], 'video sound only in the audio placement');
    await at(3); assert.equal(await seen(page, `${scope}[data-widget-id=square]`, 'pic'), 0, 'picture gone after its end'); assert.equal(ended.has('look-1'), false, 'look still playing');
    assert.equal(await page.locator('[data-playback-key="plain-1"]').count(), 0, 'queued trigger waits');
    const clipPlays = (await plays(page, 'clip.webm')).filter(p => !p.muted);
    assert.equal(clipPlays.length, 1, 'video with sound started once'); near(clipPlays[0].at - revealed, 500, 250, 'video starts at its start');
    assert.equal(await clips.first().evaluate(v => v.paused && v.currentTime > v.duration - .1), true, 'video played once and holds its last frame');
    // Sounds: each starts once, in its own window; the first stops at its end.
    const one = await plays(page, 'one.wav'), two = await plays(page, 'two.wav');
    assert.equal(one.length, 1, 'first sound played once'); assert.equal(two.length, 1, 'second sound played once');
    near(one[0].at - revealed, 0, 300, 'first sound at 0 s'); near(two[0].at - revealed, 2000, 300, 'second sound at 2 s');
    assert.equal(await page.locator('app-overlay-sound audio').first().evaluate(a => a.paused), true, 'first sound stopped at its end');
    // The look lasts its duration, then the queued plain trigger plays as before.
    await until(() => ended.has('look-1'), 'look completes', 400);
    near((ended.get('look-1') - revealedWall) / 1000, 4, .8, 'look lasts its duration');
    const plainBox = page.locator('[data-event=trigger][data-playback-key="plain-1"]');
    await until(() => plainBox.locator('app-overlay-media img').count().then(n => n === 2), 'queued plain trigger starts');
    assert.equal(await plainBox.locator('[data-look-layer]').count(), 0, 'no look without one');
    assert.deepEqual(await page.evaluate(() => [...window.__media]), ['plain-1'], 'only the plain event mounted the media player');
    if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/trigger-look-obs-plain.png` }); }
    await until(() => ended.has('plain-1'), 'plain trigger completes', 400);
    // A look with only sounds plays and finishes. A look with a failed picture and a picture that never loads still
    // opens at the readiness limit (8 s), plays its healthy object for its duration, and releases the queue.
    const onePlays = (await plays(page, 'one.wav')).length;
    for (const id of ['sounds-only', 'broken-look', 'plain-2']) send('overlay-event', { id, kind: 'trigger' });
    await until(async () => (await plays(page, 'one.wav')).length === onePlays + 1, 'sounds-only look plays its sound');
    await until(() => ended.has('sounds-only'), 'sounds-only look completes');
    const broken = '[data-event=trigger][data-playback-key="broken-look"][data-widget-id=square]';
    await page.locator(broken).waitFor({ state: 'attached' }); const brokenMounted = await now(page);
    assert.equal(await page.locator(broken).getAttribute('data-waiting'), '', 'waits while a picture is still loading');
    const brokenShown = await shownAt(page, broken), brokenShownWall = Date.now();
    near(brokenShown - brokenMounted, 8000, 1200, 'opens at the readiness limit');
    assert(await seen(page, broken, 'ok') > .99, 'the healthy object plays'); assert.equal(ended.has('broken-look'), false);
    await until(() => ended.has('broken-look'), 'broken look completes', 400);
    near((ended.get('broken-look') - brokenShownWall) / 1000, 1.5, .8, 'broken look lasts its duration');
    const plain2 = page.locator('[data-event=trigger][data-playback-key="plain-2"]');
    await until(() => plain2.locator('app-overlay-media img').count().then(n => n === 2), 'queue released: next plain trigger plays');
    await until(() => ended.has('plain-2'), 'next plain trigger completes', 400);
    assert.deepEqual(await page.evaluate(() => [...window.__media]), ['plain-1', 'plain-2'], 'looks never mount the media player');
    hanging.splice(0).forEach(release => release()); await context.close();
  }
  console.log('PASS OBS trigger looks: look plays instead of media (no media player), hidden until its picture decodes, text, objects in their windows, timed video once with sound in one box, two sounds once each in their windows, letterboxed in both boxes, random placement inside the canvas, look duration then queued plain trigger as before, sounds-only look finishes, failed and never-loading pictures open at the readiness limit with the healthy object playing for its duration and release the queue');

  // ── Studio Test panel ─────────────────────────────────────────────────────────────────────────────────────
  async function studio({ width = 1440, height = 1000, dark = true, lang = 'en', touch = false, triggersOk = true } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    await context.addInitScript(instrument);
    await context.addInitScript(({ user, app, dark, lang }) => {
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      localStorage.setItem('userLanguage', lang); localStorage.setItem('theme', dark ? 'dark' : 'light');
    }, { user, app: { ...app, language: lang }, dark, lang });
    await context.routeWebSocket('**/*', ws => ws.close());
    // The box accepts Confetti and Airhorn only; Muted is another trigger of the channel.
    const scene = { id: 'main', name: 'Looks', revision: 1, publicId, width: 1920, height: 1080, waitFor: [], widgets: [layer('square', 'trigger', 100, 100, 400, 400, { triggerIds: [T1, T2] })] };
    const state = { schemaVersion: 1, revision: 1, designs: [], scenes: [scene] }; scene.published = publishedCopy(scene, state);
    const ctx = { tests: [], triggersOk, triggerRequests: 0 };
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname === 'fixture.invalid') return fixture(route);
      if (url.origin !== api) return route.abort();
      let data = {}; const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined;
      if (url.pathname === '/auth/session') data = { twitch: user, app: { ...app, language: lang } };
      else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
      else if (url.pathname === `/overlay-studio/${user.id}/test`) {
        ctx.tests.push(body);
        data = body.destination === 'obs' ? { sent: true, clients: 1 } : { triggerId: body.triggerId ?? T2, media: plain, ...(body.triggerId === T1 ? { look } : {}) };
      } else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, needsRefresh: 0, events: [] };
      else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
      else if (url.pathname === `/overlay-studio/${user.id}`) data = withLive(state);
      else if (url.pathname === `/triggers/${user.id}` && (ctx.triggerRequests++, !ctx.triggersOk)) return route.fulfill({ status: 503, json: { error: true, message: 'Temporarily unavailable' } });
      else if (url.pathname === `/triggers/${user.id}`) data = [T1, T2, T3].map((_id, i) => ({ _id, name: ['Confetti', 'Airhorn', 'Muted'][i], channelID: user.id, isEnabled: true, mediaType: 'image', file: plain.url }));
      else if (url.pathname.startsWith('/triggers/')) data = [];
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + `/${user.login}/modules/overlays`); await page.locator('app-overlay-editor .stage').waitFor();
    await openStudio(page, 'test');
    return { context, page, ctx };
  }
  {
    const { context, page, ctx } = await studio();
    const choice = page.locator('.tester [data-test-trigger]'); await choice.waitFor();
    assert.equal(await page.getByLabel('Trigger to test (here and in OBS)', { exact: true }).count(), 1, 'labelled select');
    assert.deepEqual(await choice.locator('option').allInnerTexts(), ['Any trigger', 'Confetti', 'Airhorn'], 'only triggers the trigger boxes accept');
    await choice.selectOption(T1);
    await page.locator('.tester .test-btn').filter({ hasText: 'Trigger alerts' }).click();
    await until(() => ctx.tests.length === 1, 'preview test sent'); assert.equal(ctx.tests[0].triggerId, T1); assert.equal(ctx.tests[0].destination, 'preview');
    const box = page.locator('.stage app-overlay-scene-renderer .placement[data-event=trigger][data-widget-id=square]');
    await box.waitFor({ state: 'attached' }); const mounted = await now(page);
    const revealed = await shownAt(page, '.stage app-overlay-scene-renderer .placement[data-event=trigger][data-widget-id=square]');
    assert(revealed - mounted > 450, 'Studio waits for the look picture too');
    assert.equal(await box.locator('app-overlay-media').count(), 0, 'Studio plays the look, not the plain media');
    assert.equal(await box.locator('[data-layer-id=title] span').innerText(), 'Look for Luna');
    // Same renderer, same stage: the look's geometry in the box matches the OBS page.
    const studioSquare = await geometry(box);
    assert.deepEqual(Object.keys(studioSquare).sort(), Object.keys(obsSquare).sort());
    for (const [id, rect] of Object.entries(obsSquare)) for (const key of Object.keys(rect)) near(studioSquare[id][key], rect[key], .005, `parity ${id}.${key}`);
    assert.equal(await page.locator('.stage app-overlay-sound').count(), 2, 'Studio plays each look sound once');
    await until(async () => (await plays(page, 'two.wav')).length === 1, 'second look sound plays in the Studio');
    if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/trigger-look-studio-dark.png` }); }
    // Same clock as OBS: the look is still showing shortly before 4 s and gone at about 4 s after it appeared.
    await until(async () => (await now(page)) - revealed >= 3500, 'reach 3.5 s'); assert.equal(await box.count(), 1, 'Studio look still showing at 3.5 s');
    const goneAt = await page.evaluate(selector => new Promise(resolve => { const tick = () => { if (!document.querySelector(selector)) resolve(performance.now()); else requestAnimationFrame(tick); }; tick(); }), '.stage app-overlay-scene-renderer .placement[data-event=trigger][data-widget-id=square]');
    near(goneAt - revealed, 4000, 400, 'Studio look lasts its 4 s duration');
    // "Any trigger" sends no triggerId; the server's pick has no look, so its plain media plays.
    await choice.selectOption(''); await page.locator('.tester .test-btn').filter({ hasText: 'Trigger alerts' }).click();
    await until(() => ctx.tests.length === 2, 'second preview test'); assert.equal('triggerId' in ctx.tests[1], false, 'Any trigger sends no triggerId');
    await box.locator('app-overlay-media img').waitFor(); assert.equal(await box.locator('[data-look-layer]').count(), 0);
    await until(() => box.count().then(n => n === 0), 'plain preview ends', 400);
    // Test in OBS sends the chosen trigger too.
    await choice.selectOption(T2);
    await page.locator('.tester select[aria-label="Event to test in OBS"]').selectOption('trigger');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Test this overlay in OBS', exact: true }).click();
    await until(() => ctx.tests.length === 3, 'OBS test sent'); assert.equal(ctx.tests[2].destination, 'obs'); assert.equal(ctx.tests[2].triggerId, T2, 'OBS test sends the chosen trigger');
    await context.close();
  }
  console.log('PASS Studio trigger looks: select lists only accepted triggers, chosen trigger sends triggerId (preview and OBS), preview waits for pictures and plays the look in the trigger box with OBS-identical geometry, its 4 s duration and one player per sound; Any trigger sends none and plays the plain media');

  // A failed trigger list load is tried again when the Test panel opens again (not in a loop).
  {
    const { context, page, ctx } = await studio({ triggersOk: false });
    await until(() => ctx.triggerRequests >= 1, 'first trigger list request'); await page.waitForTimeout(1000);
    const failed = ctx.triggerRequests; await page.waitForTimeout(1500); assert.equal(ctx.triggerRequests, failed, 'no retry loop while the panel stays open');
    assert.equal(await page.locator('.tester [data-test-trigger]').count(), 0, 'no select without a list');
    ctx.triggersOk = true;
    await page.locator('.tester__close').click(); await page.locator('.tester').waitFor({ state: 'hidden' }); await openStudio(page, 'test');
    await page.locator('.tester [data-test-trigger]').waitFor();
    assert.deepEqual(await page.locator('.tester [data-test-trigger] option').allInnerTexts(), ['Any trigger', 'Confetti', 'Airhorn'], 'select appears after the retry');
    await context.close();
  }
  console.log('PASS Test panel trigger list: a failed load shows no select and does not loop; reopening Test loads it');

  // Phone width, keyboard, light theme, Spanish.
  for (const options of [{ width: 320, height: 800, touch: true, dark: true }, { width: 390, height: 844, touch: true, dark: false, lang: 'es' }]) {
    const { context, page } = await studio(options), es = options.lang === 'es';
    const choice = page.getByLabel(es ? 'Trigger para probar (aquí y en OBS)' : 'Trigger to test (here and in OBS)', { exact: true }); await choice.waitFor();
    assert.equal(await choice.locator('option').first().innerText(), es ? 'Cualquier trigger' : 'Any trigger');
    await choice.scrollIntoViewIfNeeded(); const rect = await choice.evaluate(e => e.getBoundingClientRect().toJSON());
    assert(rect.left >= 0 && rect.right <= options.width + .5 && rect.height >= 40, 'select fits the phone and is finger-sized: ' + JSON.stringify(rect));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
    await choice.focus(); await page.keyboard.press('ArrowDown');
    await until(() => choice.inputValue().then(v => v === T1), 'keyboard changes the trigger');
    await page.addScriptTag({ path: AXE });
    const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
    assert.deepEqual(violations, [], 'axe ' + options.width);
    if (shots) await choice.screenshot({ path: `${shots}/trigger-look-select-${options.width}.png` }).catch(() => {});
    if (shots) await page.screenshot({ path: `${shots}/trigger-look-test-${options.width}${options.dark ? '-dark' : '-light'}.png` });
    await context.close();
  }
  console.log('PASS Test panel trigger select: 320 px dark and 390 px light Spanish, fits without overflow, keyboard, axe');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
