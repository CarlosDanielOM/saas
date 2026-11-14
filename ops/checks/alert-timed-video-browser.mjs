// Timed videos in alert designs ("Play its sound" / Loop off): inspector controls and saved shape, the Studio
// timeline and design preview, and the OBS page. Every API, socket and media request is mocked; the WebM is
// recorded in the browser (canvas + MediaRecorder), so no file or ffmpeg is needed.
import { openStudio } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const AXE = process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com', VID = '4'.repeat(24), publicId = 'd'.repeat(48);
const user = { id: '990191', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
const still = { enter: 'none', exit: 'none', loop: 'none', delay: 1, enterDuration: .5, exitDuration: .5, loopDuration: 2 };
function initialState(clip = {}) {
  const widgets = () => [layer('text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48 }), layer('clip', 'video', 20, 20, 160, 90, { assetId: VID, motion: still, ...clip }), layer('decor', 'video', 600, 120, 160, 90, { assetId: VID })];
  const design = { id: 'starter', name: 'Video alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, { duration: 5, widgets: widgets() }])) };
  const box = layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] });
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets: [box, layer('scene-video', 'video', 0, 0, 320, 180, { mediaUrl: 'https://fixture.invalid/scene.webm' })] };
  return { schemaVersion: 1, revision: 4, scenes: [main], designs: [design] };
}
function media(route, bytes, mime) {
  const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/), start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: range ? 206 : 200, contentType: mime, headers: { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) }, body: bytes.subarray(start, end + 1) });
}
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function until(predicate, label, tries = 240) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
async function axe(page, label) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
  assert.deepEqual(violations, [], 'axe ' + label);
}
try {
  // A 1.5 s WebM with picture and a tone; its colour changes over time so frames differ.
  const recorder = await browser.newPage();
  const recorded = await recorder.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 }), g = canvas.getContext('2d');
    const audio = new AudioContext(), tone = audio.createOscillator(), out = audio.createMediaStreamDestination(); tone.connect(out); tone.start();
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...out.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' }), chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const began = performance.now(); let frame = 0;
    const timer = setInterval(() => { g.fillStyle = `hsl(${(frame++ * 12) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 90); }, 33);
    rec.start(); await new Promise(r => setTimeout(r, 1500)); rec.stop(); await new Promise(r => rec.onstop = r); clearInterval(timer); tone.stop();
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); let bin = ''; buf.forEach(b => bin += String.fromCharCode(b));
    return { data: btoa(bin), ms: performance.now() - began };
  });
  await recorder.close();
  const webm = Buffer.from(recorded.data, 'base64');
  assert(webm.length > 1000, 'recorded a WebM fixture');
  // The video must know its length (this Chromium's MediaRecorder writes it), so "plays once" has an end to reach.
  const probe = await browser.newPage();
  const length = await probe.evaluate(async b64 => { const bin = atob(b64), u = Uint8Array.from(bin, c => c.charCodeAt(0)), v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(new Blob([u], { type: 'video/webm' })); await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; }); return v.duration; }, recorded.data);
  await probe.close(); assert(Number.isFinite(length) && length > 1 && length < 2, 'WebM length ' + length);

  async function studio({ width = 1280, height = 900, dark = false, touch = false, lang = 'en', state } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    await context.addInitScript(({ user, app, dark, lang }) => {
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      localStorage.setItem('userLanguage', lang); localStorage.setItem('theme', dark ? 'dark' : 'light');
    }, { user, app: { ...app, language: lang }, dark, lang });
    await context.routeWebSocket('**/*', ws => ws.close());
    const ctx = { state: state ?? initialState(), bodies: [] };
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname === 'fixture.invalid' || url.pathname.startsWith('/asset-library/content/')) return media(route, webm, 'video/webm');
      if (url.origin !== api) return route.abort();
      let data = {}; const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined;
      if (url.pathname === `/asset-library/${user.id}`) data = { assets: [{ id: VID, name: 'Clip.webm', kind: 'video', mime: 'video/webm', duration: 1.5, bytes: webm.length, width: 160, height: 90 }], usedBytes: webm.length, quotaBytes: 5e9, maxFileBytes: 5e7, planTier: 'pro' };
      else if (url.pathname.startsWith('/asset-library/') && url.pathname.endsWith('/access')) data = { path: '/asset-library/content/' + url.pathname.split('/').at(-2) };
      else if (url.pathname === '/auth/session') data = { twitch: user, app: { ...app, language: lang } };
      else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
      else if (url.pathname.endsWith('/preview')) data = body.texts.map(t => t.replaceAll('$(user)', body.user));
      else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, needsRefresh: 0, events: [] };
      else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
      else if (url.pathname === `/overlay-studio/${user.id}`) {
        if (req.method() === 'PUT') { ctx.bodies.push(structuredClone(body)); const { writer: _w, ...saved } = body; const prev = ctx.state; ctx.state = { ...saved, revision: prev.revision + 1, scenes: saved.scenes.map(s => ({ ...s, publicId: prev.scenes.find(p => p.id === s.id)?.publicId || 'e'.repeat(48), revision: 3 })) }; }
        data = ctx.state;
      } else if (url.pathname.startsWith('/triggers/')) data = [];
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
    return { context, page, ctx };
  }
  const selectClip = async page => {
    await page.locator('app-overlay-timeline [data-track=clip] .name').click(); await openStudio(page, 'layer');
    await page.locator('.properties details.acc').first().evaluate(d => { d.open = true; });
    const controls = page.locator('app-overlay-video-playback'); await controls.waitFor(); return controls;
  };

  // Inspector: two switches and a volume; presence of `volume` = own sound, `loop: false` = plays once.
  for (const options of [{ width: 1280, dark: true }, { width: 390, touch: true }, { width: 320, touch: true, dark: true, lang: 'es' }]) {
    const { context, page, ctx } = await studio(options), es = options.lang === 'es';
    // A scene-level video has no timing controls (they belong to alert designs).
    await openStudio(page, 'layers'); await page.locator('.layer-row[data-layer-id="scene-video"] button.layer').click();
    await openStudio(page, 'layer'); await page.locator('.properties input[type=url]').waitFor();
    assert.equal(await page.locator('app-overlay-video-playback').count(), 0, 'no timing controls for a scene video');
    await openStudio(page, 'designs'); await page.locator('.design-row__actions button').first().click();
    const controls = await selectClip(page);
    const sound = controls.getByRole('switch', { name: es ? 'Reproducir su sonido' : 'Play its sound' }), loop = controls.getByRole('switch', { name: es ? 'Repetir en bucle' : 'Loop' });
    assert.equal(await sound.isChecked(), false); assert.equal(await loop.isChecked(), true, 'Loop on by default');
    assert.equal(await controls.locator('input[type=range]').count(), 0, 'no volume without its sound');
    await sound.check(); await controls.locator('input[type=range]').fill('50'); await loop.uncheck();
    await until(() => controls.getByText(es ? 'Volumen · 50%' : 'Volume · 50%').count().then(n => n === 1), 'volume readout');
    await axe(page, 'video controls ' + options.width); assert.equal(await overflow(page), false, 'no horizontal overflow');
    for (const box of await controls.locator('.row').evaluateAll(rows => rows.map(r => r.getBoundingClientRect().height))) assert(box >= 44, 'finger-sized switch rows');
    if (shots) { await mkdir(shots, { recursive: true }); await controls.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/timed-video-controls-${options.width}${options.dark ? '-dark' : ''}.png` }); }
    await page.locator('.save-button').click(); await until(() => ctx.bodies.length === 1, 'save timed video');
    const saved = ctx.bodies[0].designs[0].events.follow.widgets;
    assert.equal(ctx.bodies[0].writer, 2); assert.equal(saved[1].volume, .5); assert.equal(saved[1].loop, false);
    assert.equal('volume' in saved[2] || 'loop' in saved[2], false, 'untouched video keeps neither key');
    assert.equal('volume' in ctx.bodies[0].designs[0].events.sub.widgets[1], false, 'other events unchanged');
    await sound.uncheck(); await loop.check(); await page.locator('.save-button').click(); await until(() => ctx.bodies.length === 2, 'save plain video');
    const plain = ctx.bodies[1].designs[0].events.follow.widgets[1]; assert.equal('volume' in plain, false, 'sound off removes volume'); assert.equal('loop' in plain, false, 'Loop on removes loop');
    await context.close();
  }
  console.log('PASS timed video controls: design videos only, Play its sound + volume + Loop, saved volume/loop:false, off removes the keys, EN/ES, 320/390/1280, axe');

  // Studio: the timeline drives the timed video (start at its delay, scrub, play, pause, hidden tab, hold the last frame);
  // the design preview starts it at its delay, after the readiness gate, and plays it once with its sound.
  {
    const { context, page } = await studio({ state: initialState({ volume: .5, loop: false }) });
    await page.locator('.design-row__actions button').first().click();
    const timeline = page.locator('app-overlay-timeline'); await timeline.waitFor();
    const scrub = timeline.getByLabel('Preview position (seconds)'), clip = page.locator('.stage app-overlay-scene-renderer [data-widget-id=clip] video'), decor = page.locator('.stage app-overlay-scene-renderer [data-widget-id=decor] video');
    assert.equal(await page.locator('.stage [data-widget-id=clip] app-overlay-layer').getAttribute('data-timed-video'), '', 'timed layer marked');
    await scrub.fill('0.5'); await clip.waitFor({ state: 'attached' }); await until(() => clip.evaluate(v => v.readyState >= 1), 'clip metadata');
    await until(() => clip.evaluate(v => v.paused && v.currentTime < .05), 'before its start: first frame, paused');
    await scrub.fill('1.6'); await until(() => clip.evaluate(v => v.paused && Math.abs(v.currentTime - .6) < .1), 'scrub seeks to time minus delay');
    await until(() => decor.evaluate(v => v.paused && Number.isFinite(v.duration) && Math.abs(v.currentTime - 1.6 % v.duration) < .1), 'untouched video scrubs as before (looping)');
    await timeline.locator('.primary').click();
    await until(() => clip.evaluate(v => !v.paused && !v.muted && Math.abs(v.volume - .5) < .01 && v.currentTime > .65), 'timeline plays the video with its sound');
    await timeline.locator('.primary').click(); await until(() => clip.evaluate(v => v.paused), 'timeline pause pauses the video');
    await timeline.locator('.primary').click(); await until(() => clip.evaluate(v => !v.paused), 'resume');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await until(() => clip.evaluate(v => v.paused), 'hidden tab pauses the video');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await scrub.fill('4.5'); await until(() => clip.evaluate(v => v.paused && Number.isFinite(v.duration) && v.currentTime > v.duration - .1), 'played once: holds its last frame');
    await scrub.fill('1.2'); await until(() => clip.evaluate(v => Math.abs(v.currentTime - .2) < .1), 'scrubbing back rewinds');
    await timeline.getByRole('button', { name: 'Exit timeline preview', exact: true }).click();
    // Design preview: hidden until ready, then the clip waits for its 1 s start while the decoration loops.
    await openStudio(page, 'test');
    await page.evaluate(() => { window.timedPlays = []; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (this.closest?.('[data-timed-video]')) window.timedPlays.push(performance.now()); return play.call(this); }; });
    await page.locator('.tester').getByRole('button', { name: 'Preview', exact: false }).last().click();
    const shownAt = await page.evaluate(() => new Promise(resolve => { const tick = () => { const el = document.querySelector('.stage app-overlay-scene-renderer [data-widget-id=clip]'); if (el && el.getAttribute('data-waiting') === null && el.closest('.placement')?.style.visibility !== 'hidden' && el.querySelector('app-overlay-layer')?.getAnimations({ subtree: true }).length) resolve(performance.now()); else requestAnimationFrame(tick); }; tick(); }));
    assert.equal(await clip.evaluate(v => v.paused && v.currentTime < .05), true, 'readiness gate does not start the timed video');
    await until(() => decor.evaluate(v => !v.paused && v.muted && v.loop), 'untouched video loops muted');
    await until(() => clip.evaluate(v => !v.paused && !v.muted), 'clip starts at its delay with its sound', 400);
    const firstPlay = await page.evaluate(() => window.timedPlays[0]);
    assert(firstPlay - shownAt > 800, 'started about 1 s after the alert appeared: ' + (firstPlay - shownAt));
    await until(() => clip.evaluate(v => v.ended || v.paused && v.currentTime > v.duration - .1), 'plays once', 400);
    await page.waitForTimeout(300); assert.equal(await clip.evaluate(v => v.paused && v.currentTime > v.duration - .1), true, 'stays on its last frame');
    assert.equal(await page.locator('.stage app-overlay-scene-renderer [data-widget-id=text]').isVisible(), true, 'alert still showing');
    await context.close();
  }
  console.log('PASS Studio timed video: timeline scrub/play/pause/hidden tab/last frame; design preview starts it at its delay after the readiness gate, with its sound, once; untouched video loops muted');

  // OBS page: two placements of one design; only the audio placement plays the video's sound.
  {
    const clip = layer('clip', 'video', 20, 20, 160, 90, { assetId: VID, volume: .7, loop: false, motion: still });
    const layout = { duration: 4, widgets: [layer('text', 'text', 190, 65, 530, 90, { text: 'Video alert' }), clip, layer('decor', 'video', 600, 120, 160, 90, { assetId: VID })] };
    const snapshot = { width: 1280, height: 720, waitFor: ['follow'], widgets: ['one', 'two'].map((id, i) => layer(id, 'alert', i * 640, 0, 640, 192, { designId: 'vid', events: ['follow'] })), designs: [{ id: 'vid', width: 800, height: 240, events: {} }] };
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } }); let socket; const ended = [], health = [];
    const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
    await context.routeWebSocket('**/*', ws => { if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws; ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}'); ws.onMessage(m => { m = String(m); if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision: 1, snapshot }); } if (m.includes('overlay-ended')) ended.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]); if (m.includes('overlay-health')) health.push(m); }); });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === new URL(base).origin) return route.continue(); if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: { id: url.pathname.split('/').at(-1), kind: 'follow', snapshot, layouts: { vid: layout } } } }); if (url.pathname.includes('/assets/')) return media(route, webm, 'video/webm'); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(base + '/overlays/' + publicId); await page.locator('.canvas').waitFor();
    await page.evaluate(() => { window.timedPlays = []; window.blockSound = false; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (this.closest?.('[data-timed-video]')) window.timedPlays.push(performance.now()); return window.blockSound && !this.muted ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : play.call(this); }; });
    const shown = () => page.evaluate(() => new Promise(resolve => { const tick = () => { const el = document.querySelector('[data-event=follow][data-widget-id=one]'); if (el && el.getAttribute('data-waiting') === null && el.style.visibility !== 'hidden') resolve(performance.now()); else requestAnimationFrame(tick); }; tick(); }));
    send('overlay-event', { id: 'video-event', kind: 'follow' }); const shownAt = await shown();
    const clips = page.locator('[data-event=follow] [data-layer-id=clip] video'), decors = page.locator('[data-event=follow] [data-layer-id=decor] video');
    assert.equal(await clips.count(), 2); assert.equal(await clips.evaluateAll(vs => vs.every(v => v.paused && v.currentTime < .05)), true, 'readiness gate leaves timed videos alone');
    await until(() => decors.evaluateAll(vs => vs.every(v => !v.paused && v.muted && v.loop)), 'untouched videos loop muted from the start');
    await until(() => clips.evaluateAll(vs => vs.every(v => !v.paused)), 'both timed videos start', 400);
    const firstPlay = await page.evaluate(() => window.timedPlays[0]); assert(firstPlay - shownAt > 800, 'timed video starts at its delay: ' + (firstPlay - shownAt));
    assert.deepEqual(await clips.evaluateAll(vs => vs.map(v => v.muted)), [false, true], 'only the audio placement plays the video sound');
    assert(Math.abs(await clips.first().evaluate(v => v.volume) - .7) < .01, 'video volume');
    await until(() => clips.evaluateAll(vs => vs.every(v => v.paused && v.currentTime > v.duration - .1)), 'plays once and holds its last frame', 400);
    assert.equal(ended.includes('video-event'), false, 'alert still playing after the video'); assert.equal(await page.locator('[data-event=follow][data-widget-id=one]').isVisible(), true);
    await until(() => ended.includes('video-event'), 'alert completes', 400);
    // Sound refused outside OBS: the video keeps moving silently and one click turns its sound on.
    await page.evaluate(() => { window.blockSound = true; });
    send('overlay-event', { id: 'blocked-event', kind: 'follow' }); await shown();
    const enable = page.locator('[data-layer-id=clip] app-overlay-layer').getByRole('button', { name: 'Enable sound', exact: true });
    await enable.waitFor(); assert.equal(await enable.count(), 1, 'one button, in the audio placement');
    await until(() => clips.first().evaluate(v => !v.paused && v.muted), 'blocked video plays muted instead of freezing');
    await until(() => health.some(m => m.includes('autoplay')), 'autoplay issue reported');
    const healthBefore = health.length;
    await page.evaluate(() => { window.blockSound = false; }); await enable.click();
    await until(() => clips.first().evaluate(v => !v.paused && !v.muted), 'Enable sound unmutes the video'); await until(() => enable.count().then(n => n === 0), 'button gone');
    const issue = m => JSON.parse(m.slice(m.indexOf(',') + 1))[1].issue;
    assert.equal(issue(health[healthBefore - 1]), 'autoplay', 'blocked before the click');
    await until(() => health.slice(healthBefore).some(m => issue(m) === null), 'the source reports its autoplay issue cleared once the video is audible');
    assert.equal(issue(health.at(-1)), null, 'last health report is no longer blocked');
    await until(() => ended.includes('blocked-event'), 'blocked alert completes', 400);
    await context.close();
  }
  console.log('PASS OBS timed video: not started by the readiness gate, starts at its delay, sound only in the audio placement, plays once and holds its last frame; refused sound plays muted, Enable sound unmutes it and the autoplay issue clears; untouched videos loop muted');

  // A timed, audible, LOOPING video whose object ends (motion.end 2.6 s) after one wrap of the 1.5 s file but before
  // the file would finish its second pass; and a silent (volume 0) video that is still timed.
  const looper = layer('looper', 'video', 20, 20, 160, 90, { assetId: VID, volume: .6, motion: { ...still, delay: .5, end: 2.6 } });
  const quiet = layer('quiet', 'video', 600, 120, 160, 90, { assetId: VID, volume: 0, motion: still });
  const loopLayout = { duration: 5, widgets: [layer('text', 'text', 190, 65, 530, 90, { text: 'Loop alert' }), looper, quiet] };
  // In-page watch: wrap (time jumps back while playing) with sound on, first play time, and the playhead after it stops.
  const watch = (page, root) => page.evaluate(root => {
    window.loopWatch = { wrappedAudible: false, last: 0, firstPlay: {}, shownAt: 0 };
    const id = setInterval(() => {
      const q = sel => document.querySelector(`${root} [${root.startsWith('.stage') ? 'data-widget-id' : 'data-layer-id'}="${sel}"] video`);
      const placement = document.querySelector(root.startsWith('.stage') ? '.stage app-overlay-scene-renderer [data-widget-id="text"]' : '[data-event=follow]');
      if (placement && placement.getAttribute('data-waiting') === null && placement.style.visibility !== 'hidden' && !window.loopWatch.shownAt) window.loopWatch.shownAt = performance.now();
      for (const name of ['looper', 'quiet']) { const v = q(name); if (v && !v.paused && !window.loopWatch.firstPlay[name]) window.loopWatch.firstPlay[name] = performance.now(); }
      const v = q('looper'); if (!v) return;
      if (!v.paused && v.currentTime < window.loopWatch.last - .5 && !v.muted && v.volume > .5) window.loopWatch.wrappedAudible = true;
      window.loopWatch.last = v.currentTime;
    }, 15);
    window.stopWatch = () => clearInterval(id);
  }, root);
  const proveLoop = async (page, video, quietVideo, label) => {
    await until(() => page.evaluate(() => window.loopWatch.wrappedAudible), label + ': looping video wraps with its sound on', 400);
    await until(() => video.evaluate(v => v.paused), label + ': paused at the object end', 400);
    const w = await page.evaluate(() => window.loopWatch);
    const at = await video.evaluate(v => v.currentTime); await page.waitForTimeout(400);
    assert.equal(await video.evaluate(v => v.paused && v.currentTime), at, label + ': playhead stays put after the end');
    assert(w.firstPlay.looper - w.shownAt > 350, label + ': looper starts at its 0.5 s delay: ' + (w.firstPlay.looper - w.shownAt));
    assert(w.firstPlay.quiet - w.shownAt > 800, label + ': volume 0 video is still timed (starts at 1 s, not at mount): ' + (w.firstPlay.quiet - w.shownAt));
    assert.equal(await quietVideo.evaluate(v => v.muted || v.volume === 0), true, label + ': volume 0 stays silent');
    await page.evaluate(() => window.stopWatch());
  };
  {
    const state = initialState(); state.designs[0].events.follow.widgets = structuredClone(loopLayout.widgets);
    const { context, page } = await studio({ state });
    await page.locator('.design-row__actions button').first().click(); await openStudio(page, 'test');
    await watch(page, '.stage app-overlay-scene-renderer');
    await page.locator('.tester').getByRole('button', { name: 'Preview', exact: false }).last().click();
    await proveLoop(page, page.locator('.stage app-overlay-scene-renderer [data-widget-id=looper] video'), page.locator('.stage app-overlay-scene-renderer [data-widget-id=quiet] video'), 'Studio');
    assert.equal(await page.locator('.stage app-overlay-scene-renderer [data-widget-id=text]').isVisible(), true, 'Studio: alert still showing after the object end');
    await context.close();
  }
  {
    const snapshot = { width: 1280, height: 720, waitFor: ['follow'], widgets: [layer('one', 'alert', 0, 0, 640, 192, { designId: 'vid', events: ['follow'] })], designs: [{ id: 'vid', width: 800, height: 240, events: {} }] };
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } }); let socket; const ended = [];
    const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
    await context.routeWebSocket('**/*', ws => { if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws; ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}'); ws.onMessage(m => { m = String(m); if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision: 1, snapshot }); } if (m.includes('overlay-ended')) ended.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]); }); });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === new URL(base).origin) return route.continue(); if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: { id: url.pathname.split('/').at(-1), kind: 'follow', snapshot, layouts: { vid: loopLayout } } } }); if (url.pathname.includes('/assets/')) return media(route, webm, 'video/webm'); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(base + '/overlays/' + publicId); await page.locator('.canvas').waitFor();
    await watch(page, '[data-event=follow]'); send('overlay-event', { id: 'loop-event', kind: 'follow' });
    await proveLoop(page, page.locator('[data-event=follow] [data-layer-id=looper] video'), page.locator('[data-event=follow] [data-layer-id=quiet] video'), 'OBS');
    assert.equal(ended.includes('loop-event'), false, 'OBS: alert still playing after the object end');
    await until(() => ended.includes('loop-event'), 'loop alert completes', 400); await context.close();
  }
  console.log('PASS timed looping video with sound: wraps audibly, pauses at its object end with a still playhead (Studio and OBS); volume 0 video stays timed and silent');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
