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
  const state = { missingImages: [], pendingMoodRoutes: [], moodAssetMode: 'hold404', socket: null, reports: [], mouths: [], readies: [], leases: [], audioReads: [], auth: [], pendingAcquire: null, ttl: leaseTtl, generation: 1 };
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
    moods: { available: true, enabled: true, holdMs: 1000, emotions: Object.fromEntries(['happy', 'excited', 'sad', 'angry', 'surprised', 'scared', 'embarrassed', 'thinking'].map(mood => [mood, []])) },
    assets: { moods: { happy: { idleUrl: `${api}/pets/public/${capability}/assets/${'c'.repeat(24)}`, talkingUrl: `${api}/pets/public/${capability}/assets/${'d'.repeat(24)}` }, sad: { idleUrl: `${api}/pets/public/${capability}/assets/${'e'.repeat(24)}`, talkingUrl: `${api}/pets/public/${capability}/assets/${'f'.repeat(24)}` } }, idleUrl: `${api}/pets/public/${capability}/assets/${'a'.repeat(24)}`, talkingUrl: `${api}/pets/public/${capability}/assets/${'b'.repeat(24)}` },
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
    if ([`/pets/public/${capability}/assets/${'c'.repeat(24)}`, `/pets/public/${capability}/assets/${'d'.repeat(24)}`].includes(url.pathname)) {
      state.missingImages.push(url.pathname);
      const broken = state.moodAssetMode !== 'valid';
      if (state.moodAssetMode === 'hold404') await new Promise(resolve => state.pendingMoodRoutes.push(resolve));
      return route.fulfill(broken ? { status: 404, body: 'missing optional mood image', contentType: 'text/plain', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } } :
        { body: png, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
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
  const { context, page, state, send, snapshot, speak } = await open();
  const readyCount = state.readies.length;
  const request = { requestId: 'missing-mood-images', operation: 'talk', status: 'ready', version: 1, mood: 'happy' };
  send('pet:request', { v: 1, generation: state.generation, request });
  await speak(request.requestId);
  await until(() => phases(state, request.requestId).includes('started'), 'real WAV playback starts');
  await until(() => state.pendingMoodRoutes.length === 2, 'both optional mood images are still loading');
  await page.waitForFunction(({ api, capability }) => {
    const imgs = [...document.querySelectorAll('.pet-image')];
    return imgs.length === 2 && imgs[0].src === `${api}/pets/public/${capability}/assets/${'a'.repeat(24)}` &&
      imgs[1].src === `${api}/pets/public/${capability}/assets/${'b'.repeat(24)}` && imgs.every(img => img.complete && img.naturalWidth > 0);
  }, { api, capability });
  await page.waitForFunction(() => [...document.querySelectorAll('.pet-image')].some(img => img.classList.contains('visible') && img.complete && img.naturalWidth > 0));
  assert.equal(await isTalking(page), true, 'normal talking image stays visible while optional images are still loading');
  for (const release of state.pendingMoodRoutes) release();
  await page.waitForTimeout(100);
  await page.waitForFunction(() => [...document.querySelectorAll('.pet-image')].every(img => img.complete && img.naturalWidth > 0));
  send('pet:snapshot', snapshot({ active: { ...request, status: 'playing', version: 2 },
    lease: { leaseId: 'lease-browser', holderPeerId: 'peer-browser', expiresAt: Date.now() + 15000 } }));
  await page.waitForTimeout(200);
  assert.deepEqual(state.readies.slice(readyCount).filter(ready => ready.renderReady === false), [], 'optional decoration failures never revoke renderer readiness');
  assert.equal(phases(state, request.requestId).includes('error'), false, 'optional image failures never stop audio');
  assert.equal(phases(state, request.requestId).includes('stopped'), false);
  await until(() => phases(state, request.requestId).includes('ended'), 'WAV reaches its natural end');
  assert.equal(await isTalking(page), false, 'normal idle image is visible during the mood hold');
  const idle = page.locator('.pet-image.visible');
  assert.equal(await idle.getAttribute('src'), `${api}/pets/public/${capability}/assets/${'a'.repeat(24)}`);
  assert.doesNotMatch(await page.locator('app-pet-runtime [role=status]').innerText(), /image.*(error|unavailable|load)|could not|failed/i, 'optional decoration failures do not become renderer errors');
  assert.equal(await page.evaluate(() => window.__petPlayCount), 1, 'no automatic retries or extra audio playback');
  send('pet:request', { v: 1, generation: state.generation, request: { ...request, status: 'completed', version: 3 } });
  state.moodAssetMode = 'valid';
  const repaired = { ...request, requestId: 'repaired-mood-images', version: 1 };
  send('pet:request', { v: 1, generation: state.generation, request: repaired });
  await speak(repaired.requestId);
  await until(() => phases(state, repaired.requestId).includes('started'), 'the next actual WAV request starts normally');
  await page.waitForFunction(({ api, capability }) => {
    const imgs = [...document.querySelectorAll('.pet-image')];
    return imgs.length === 2 && imgs[0].src === `${api}/pets/public/${capability}/assets/${'c'.repeat(24)}` &&
      imgs[1].src === `${api}/pets/public/${capability}/assets/${'d'.repeat(24)}` && imgs.every(img => img.complete && img.naturalWidth > 0);
  }, { api, capability });
  assert.equal(await isTalking(page), true, 'the repaired talking mood image is visible on the next request');
  assert.deepEqual(state.readies.slice(readyCount).filter(ready => ready.renderReady === false), [], 'self-healing decoration also preserves baseline readiness');
  await until(() => phases(state, repaired.requestId).includes('ended'), 'second WAV reaches its natural end');
  assert.equal(phases(state, repaired.requestId).includes('error'), false);
  assert.equal(phases(state, repaired.requestId).includes('stopped'), false);
  assert.equal(await page.evaluate(() => window.__petPlayCount), 2, 'one real playback per request with no retry timer');
  assert.equal(await idle.getAttribute('src'), `${api}/pets/public/${capability}/assets/${'c'.repeat(24)}`, 'happy idle image holds after actual playback ends');
  send('pet:request', { v: 1, generation: state.generation, request: { ...repaired, status: 'completed', version: 3 } });
  const replacement = { ...request, requestId: 'switch-during-hold', version: 1, mood: 'sad' };
  send('pet:request', { v: 1, generation: state.generation, request: replacement });
  await speak(replacement.requestId);
  await until(() => phases(state, replacement.requestId).includes('started'), 'new request starts during the happy hold');
  await page.waitForFunction(() => document.querySelector('.pet-image.visible')?.getAttribute('src')?.endsWith('f'.repeat(24)));
  await until(() => phases(state, replacement.requestId).includes('ended'), 'replacement WAV naturally completes');
  assert.equal(await idle.getAttribute('src'), `${api}/pets/public/${capability}/assets/${'e'.repeat(24)}`, 'previous hold cannot reset the new sad mood during playback');
  await page.waitForFunction(() => document.querySelector('.pet-image.visible')?.getAttribute('src')?.endsWith('a'.repeat(24)));
  assert.equal(await page.evaluate(() => window.__petPlayCount), 3);
  assert.deepEqual(state.readies.slice(readyCount).filter(ready => ready.renderReady === false), []);
  assert.deepEqual(errors, [], 'no renderer JavaScript errors');
  await context.close();
  console.log('PASS optional pet mood assets: actual Chromium WAV playback, idle/talking mood images return 404, normal images stay visible during optional loading and 404s, repaired URLs work on the next request, hold/switch/reset, three natural WAV completions, no blank pet, false unready, lease revocation, audio error or replay.');
} finally { await browser.close(); }
