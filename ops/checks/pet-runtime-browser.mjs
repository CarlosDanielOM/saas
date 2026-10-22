import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', capability = 'a'.repeat(43);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function wav(seconds) {
  const rate = 16000, samples = Math.floor(rate * seconds), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 * 2 / rate) * 12000), 44 + i * 2);
  return data;
}
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function open({ kind = 'png', target = 'browser', leaseTtl = 15000, holdAcquire = false, holdRenew = false, rejectPhase = '', rejectReady = false, badAudio = false, language = 'en', width = 390 } = {}) {
  const state = { socket: null, reports: [], mouths: [], readies: [], leases: [], audioReads: [], auth: [], pendingAcquire: null, ttl: leaseTtl, generation: 1 };
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(language => {
    localStorage.setItem('userLanguage', language);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__petPlayCount = (window.__petPlayCount || 0) + 1;
      return window.__petBlockAudio ? Promise.reject(new DOMException('Fixture blocks autoplay', 'NotAllowedError')) : play.call(this);
    };
  }, language);
  const snapshot = (overrides = {}) => ({ v: 1, peerId: 'peer-browser', generation: state.generation, settingsRevision: 1, serverTime: Date.now(),
    appearance: { kind, idleAssetId: 'a'.repeat(24), talkingAssetId: 'b'.repeat(24) },
    playback: { target, desktopSessionId: target === 'desktop' ? 'd'.repeat(24) : null, vtsSessionId: kind === 'vts' ? 'd'.repeat(24) : null },
    assets: { idleUrl: `${api}/pets/public/${capability}/assets/${'a'.repeat(24)}`, talkingUrl: `${api}/pets/public/${capability}/assets/${'b'.repeat(24)}` },
    active: null, lease: null, ...overrides });
  const send = (event, payload) => { assert(state.socket); state.socket.send(`42/pet,${JSON.stringify([event, payload])}`); };
  const leaseAck = () => ({ ok: true, data: { leaseId: 'lease-browser', generation: state.generation, serverTime: Date.now(), expiresAt: Date.now() + state.ttl, ttlMs: state.ttl } });
  await context.routeWebSocket('**/*', ws => {
    assert(!ws.url().includes(capability), 'capability never travels in WebSocket URL');
    if (!ws.url().includes('/socket.io/')) { ws.close(); return; }
    state.socket = ws;
    ws.send('0{"sid":"fixture-engine","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(raw => {
      const packet = String(raw);
      if (packet.startsWith('40/pet,')) {
        state.auth.push(JSON.parse(packet.slice('40/pet,'.length)));
        ws.send('40/pet,{"sid":"peer-browser"}'); send('pet:snapshot', snapshot()); return;
      }
      const match = packet.match(/^42\/pet,(\d*)\[([\s\S]*)$/); if (!match) return;
      const [event, payload] = JSON.parse('[' + match[2]);
      const ack = data => match[1] && ws.send(`43/pet,${match[1]}${JSON.stringify([data])}`);
      if (event === 'pet:ready') { state.readies.push(payload); ack(rejectReady ? { ok: false, error: { code: 'not_ready' } } : { ok: true, data: {} }); }
      if (event === 'pet:lease') {
        state.leases.push(payload);
        if (payload.action === 'acquire' && holdAcquire) { state.pendingAcquire = () => ack(leaseAck()); return; }
        if (payload.action === 'renew' && holdRenew) return;
        ack(leaseAck());
      }
      if (event === 'pet:playback') { state.reports.push({ ...payload, at: Date.now() }); ack(payload.phase === rejectPhase ? { ok: false, error: { code: 'stale_generation' } } : { ok: true, data: {} }); }
      if (event === 'pet:mouth') state.mouths.push({ ...payload, at: Date.now() });
    });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/pet/')) { const response = await route.fetch({ url: base + '/index.csr.html' }); return route.fulfill({ response }); }
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    assert.equal(route.request().headers().authorization, undefined, 'public renderer does not send owner credentials');
    if (url.pathname.startsWith(`/pets/public/${capability}/assets/`)) return route.fulfill({ body: png, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
    if (/^\/pets\/playback\/[^/]+\/audio$/.test(url.pathname)) {
      state.audioReads.push(url.pathname);
      return route.fulfill({ body: badAudio ? Buffer.from('invalid-audio') : wav(4), contentType: 'audio/wav', headers: { 'access-control-allow-origin': '*' } });
    }
    return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/pet/' + capability); await page.locator('app-pet-runtime').waitFor();
  await until(() => state.readies.length > 0);
  if (!rejectReady) await until(() => state.readies.some(r => r.renderReady));
  if (target === 'browser' && !rejectReady) await until(() => state.leases.some(l => l.action === 'acquire'));
  async function speak(id, overrides = {}) {
    const frame = { v: 1, requestId: id, generation: state.generation, leaseId: 'lease-browser', startBefore: Date.now() + 8000,
      audio: { url: `${api}/pets/playback/${id}/audio?ticket=fixture-only`, mimeType: 'audio/wav', durationMs: 4000 }, ...overrides };
    send('pet:play', frame); return frame;
  }
  return { context, page, state, send, snapshot, speak };
}
async function until(predicate, message = 'fixture condition', timeout = 10000) {
  const start = Date.now();
  while (!predicate()) { assert(Date.now() - start < timeout, message); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const phases = (state, id) => state.reports.filter(r => r.requestId === id).map(r => r.phase);
const isTalking = page => page.evaluate(() => document.querySelectorAll('.pet-image')[1]?.classList.contains('visible') ?? false);
try {
  {
    const { page, context, state, send, snapshot, speak } = await open();
    assert.deepEqual(state.auth, [{ v: 1, capability }]);
    assert.equal(await page.locator('app-authenticated-layout').count(), 0, 'public renderer stays outside authenticated shell');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
    const readinessCount = state.readies.length;
    for (let i = 0; i < 5; i++) send('pet:snapshot', snapshot({ lease: { leaseId: 'lease-browser', holderPeerId: 'peer-browser', expiresAt: Date.now() + 15000 } }));
    await page.waitForTimeout(400); assert.equal(state.readies.length, readinessCount, 'unchanged snapshots cannot echo readiness');
    const first = await speak('speech-1');
    await until(() => phases(state, 'speech-1').includes('started'));
    assert.equal(await isTalking(page), true);
    send('pet:play', first); // duplicate while active
    await until(() => phases(state, 'speech-1').includes('ended'));
    assert.equal(await isTalking(page), false);
    send('pet:play', { ...first, startBefore: Date.now() + 8000 }); // duplicate after completion
    await page.waitForTimeout(200); assert.equal(state.audioReads.filter(p => p.includes('speech-1')).length, 1);
    await speak('speech-2'); await until(() => phases(state, 'speech-2').includes('started'));
    await until(() => phases(state, 'speech-2').includes('ended'));
    assert.equal(state.reports.filter(r => r.phase === 'started').length, 2, 'two consecutive requests both play');
    assert(state.mouths.some(m => m.value > 0), 'actual decoded PCM drives mouth level');
    for (const id of ['speech-1', 'speech-2']) {
      const telemetry = [...state.reports, ...state.mouths].filter(m => m.requestId === id).sort((a, b) => a.seq - b.seq);
      assert.deepEqual(telemetry.map(m => m.seq), telemetry.map((_, i) => i + 1), 'monotonic request-scoped shared sequence');
      const mouth = state.mouths.filter(m => m.requestId === id);
      assert(mouth.length <= 44, 'mouth reports bounded at 10 Hz');
      assert(mouth.every(m => Number.isFinite(m.value) && m.value >= 0 && m.value <= 1));
    }
    const mouthCount = state.mouths.length; await page.waitForTimeout(350); assert.equal(state.mouths.length, mouthCount, 'no mouth timer work while idle');
    const before = state.audioReads.length;
    await speak('expired', { startBefore: Date.now() - 1 });
    await speak('stale', { generation: 0 });
    await speak('wrong-lease', { leaseId: 'other-lease' });
    await speak('external-url', { audio: { url: 'https://example.invalid/audio.wav', mimeType: 'audio/wav', durationMs: 4000 } });
    await page.waitForTimeout(200); assert.equal(state.audioReads.length, before, 'expired/stale/unassigned/foreign URLs do not load');
    await speak('cancel-me'); await until(() => phases(state, 'cancel-me').includes('started'));
    send('pet:stop', { v: 1, requestId: 'cancel-me', generation: 1, reason: 'cancelled' });
    await until(() => phases(state, 'cancel-me').includes('stopped'));
    assert.equal(await isTalking(page), false);
    await context.close();
  }
  {
    const { context, page, state, send, snapshot, speak } = await open({ target: 'desktop' });
    assert.equal(state.leases.length, 0, 'PNG with desktop audio never acquires browser audio');
    const view = { requestId: 'desktop-speech', operation: 'talk', status: 'playing', version: 3 };
    send('pet:request', { v: 1, generation: 1, request: view });
    await page.waitForFunction(() => document.querySelectorAll('.pet-image')[1]?.classList.contains('visible'));
    send('pet:request', { v: 1, generation: 1, request: { ...view, status: 'ready', version: 2 } });
    await page.waitForTimeout(100); assert.equal(await isTalking(page), true, 'stale request version cannot undo playing');
    send('pet:request', { v: 1, generation: 1, request: { ...view, status: 'completed', version: 4 } });
    await page.waitForFunction(() => !document.querySelectorAll('.pet-image')[1]?.classList.contains('visible'));
    await speak('desktop-ignored');
    send('pet:snapshot', snapshot({ active: view }));
    await page.waitForTimeout(150); assert.equal(state.audioReads.length, 0, 'snapshot and desktop relay never replay speech');
    assert.equal(await isTalking(page), false, 'stale same-generation snapshot cannot resurrect a completed talking sprite');
    await page.addScriptTag({ path: axePath });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document.querySelector('app-pet-runtime'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => v.id)), []);
    await context.close();
  }
  {
    const { context, page, state, speak } = await open({ kind: 'vts' });
    assert.equal(await page.locator('.pet-image').count(), 0, 'VTS browser source is audio only');
    await speak('vts-audio'); await until(() => phases(state, 'vts-audio').includes('started'));
    await context.close();
  }
  for (const rejectPhase of ['started', 'progress']) {
    const { context, page, state, speak } = await open({ rejectPhase });
    await speak('rejected-' + rejectPhase); await until(() => state.reports.some(r => r.phase === rejectPhase));
    await page.waitForTimeout(200); assert.equal(await isTalking(page), false, `rejected ${rejectPhase} stops immediately`);
    const count = state.mouths.length; await page.waitForTimeout(300); assert.equal(state.mouths.length, count);
    await context.close();
  }
  {
    const { context, page, state, send, snapshot, speak } = await open();
    await speak('handover'); await until(() => phases(state, 'handover').includes('started'));
    state.generation = 2;
    send('pet:snapshot', snapshot({ playback: { target: 'desktop', desktopSessionId: 'd'.repeat(24), vtsSessionId: null } }));
    await page.waitForTimeout(150); assert.equal(await isTalking(page), false, 'generation handover immediately resets local media');
    const count = state.mouths.length; await page.waitForTimeout(200); assert.equal(state.mouths.length, count);
    await context.close();
  }
  {
    const { context, page, state, speak } = await open();
    await speak('disconnect'); await until(() => phases(state, 'disconnect').includes('started'));
    state.socket.send('41/pet,');
    await page.waitForTimeout(150); assert.equal(await isTalking(page), false, 'disconnect stops local media');
    const count = state.mouths.length; await page.waitForTimeout(200); assert.equal(state.mouths.length, count);
    await context.close();
  }
  {
    const { context, page, state } = await open({ rejectReady: true });
    await page.waitForTimeout(200); assert.equal(state.leases.length, 0, 'rejected readiness never elects a player');
    await context.close();
  }
  {
    const { context, page, state, send, snapshot, speak } = await open({ holdAcquire: true });
    await until(() => !!state.pendingAcquire);
    send('pet:snapshot', snapshot({ lease: { leaseId: 'other-lease', holderPeerId: 'peer-other', expiresAt: Date.now() + 15000 } }));
    await page.waitForTimeout(100); state.pendingAcquire();
    await speak('late-acquire'); await page.waitForTimeout(250);
    assert.equal(state.audioReads.length, 0, 'late acquire ack cannot restore released ownership');
    await context.close();
  }
  {
    const { context, page, state, speak } = await open({ leaseTtl: 1500, holdRenew: true });
    await speak('lease-expiry'); await until(() => phases(state, 'lease-expiry').includes('started'));
    await page.waitForTimeout(1300); assert.equal(await isTalking(page), false, 'local conservative lease expiry stops media');
    const count = state.mouths.length; await page.waitForTimeout(250); assert.equal(state.mouths.length, count);
    await context.close();
  }
  {
    const { context, page, state, speak } = await open({ badAudio: true });
    await speak('bad-audio'); await until(() => phases(state, 'bad-audio').includes('error'));
    assert.equal(state.mouths.length, 0); assert.equal(await isTalking(page), false);
    await context.close();
  }
  {
    const { context, page, state, speak } = await open({ language: 'es', width: 320 });
    await page.evaluate(() => { window.__petBlockAudio = true; });
    await speak('autoplay-blocked'); await until(() => phases(state, 'autoplay-blocked').includes('error'));
    await until(() => state.readies.some(ready => ready.audioReady === false));
    await speak('while-autoplay-blocked'); await page.waitForTimeout(100);
    assert.equal(state.audioReads.length, 1, 'known autoplay block stops preparing more speech');
    const enable = page.getByRole('button', { name: 'Activar audio de la mascota', exact: true }); await enable.waitFor();
    await page.evaluate(() => { window.__petBlockAudio = false; });
    await enable.focus(); await page.keyboard.press('Enter');
    await until(() => state.readies.at(-1)?.audioReady === true);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__petPlayCount), 1, 'enabling audio never replays blocked speech');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
  }
  assert.deepEqual(errors, [], 'no renderer runtime errors');
  console.log('PASS pet renderer: transparent public source, original scoped image URLs, readiness dedup, audio election, two consecutive real WAV playbacks, actual mouth RMS bounded at 10 Hz and idle cleanup, duplicate/stale request and snapshot/expiry/rejected ack/stale acquire guards, handover/disconnect reset, desktop talking relay, VTS audio-only, media/autoplay failure, Spanish keyboard recovery, axe.');
} finally { await browser.close(); }
