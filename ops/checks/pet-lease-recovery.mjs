// Exact-bundle DIMA-036 checks. All API/WebSocket/media traffic is mocked; no account or paid request.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', capability = 'a'.repeat(43);
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
function wav(seconds) {
  const rate = 8000, count = seconds * rate, data = Buffer.alloc(44 + count * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 * 2 / rate) * 12000), 44 + i * 2);
  return data;
}
async function until(predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function open({ dropAcquire = false, dropRenew = false, dropProgress = false, rejectRenew = false,
  slowAudio = false, ttl = 15_000, seconds = 12 } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__petAudio = this; window.__petPlays = (window.__petPlays || 0) + 1; return play.call(this); };
  });
  const state = { socket: null, leases: [], reports: [], reads: 0, generation: 1, leaseId: 'lease-one', acquireCount: 0, renewCount: 0, expiresAt: 0, rejectedAt: 0 };
  const send = (event, value) => state.socket.send(`42/pet,${JSON.stringify([event, value])}`);
  await context.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) { ws.close(); return; } // Development HMR is unrelated to Pet transport.
    assert(!ws.url().includes(capability)); state.socket = ws;
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(raw => {
      const packet = String(raw);
      if (packet.startsWith('40/pet,')) {
        ws.send('40/pet,{"sid":"browser-one"}');
        send('pet:snapshot', { v: 1, generation: 1, settingsRevision: 1, peerId: 'browser-one', serverTime: Date.now(),
          appearance: { kind: 'vts' }, playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null },
          assets: { idleUrl: null, talkingUrl: null }, active: null, lease: null }); return;
      }
      const match = packet.match(/^42\/pet,(\d*)\[([\s\S]*)$/); if (!match) return;
      const [event, value] = JSON.parse('[' + match[2]);
      const ack = value => { if (match[1]) ws.send(`43/pet,${match[1]}${JSON.stringify([value])}`); };
      if (event === 'pet:ready') ack({ ok: true, data: {} });
      if (event === 'pet:lease') {
        state.leases.push({ ...value, at: Date.now() });
        if (value.action === 'acquire') {
          state.acquireCount++;
          if (!state.expiresAt) state.expiresAt = Date.now() + ttl;
          if (dropAcquire && state.acquireCount === 1) return; // Accepted server-side, only ACK lost; same-peer retry is idempotent.
          if (!dropAcquire && state.acquireCount > 1) { state.leaseId = 'lease-two'; state.expiresAt = Date.now() + ttl; }
        } else {
          state.renewCount++;
          if (rejectRenew) { state.rejectedAt = Date.now(); ack({ ok: false, error: { code: 'stale_lease' } }); return; }
          if (ttl < 15_000) return;
          if (dropRenew && state.renewCount === 1) { state.expiresAt = Date.now() + ttl; return; }
          if (slowAudio && state.renewCount === 1) { ack({ ok: false, error: { code: 'rate_limited', retryAfterMs: 1000 } }); return; }
        }
        if (value.action === 'renew') state.expiresAt = Date.now() + ttl;
        ack({ ok: true, data: { leaseId: state.leaseId, generation: state.generation, serverTime: Date.now(), expiresAt: state.expiresAt, ttlMs: ttl } });
      }
      if (event === 'pet:playback') {
        state.reports.push({ ...value, at: Date.now() });
        if (dropProgress && value.phase === 'progress') return;
        ack({ ok: true, data: {} });
      }
    });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/pet/')) { const response = await route.fetch({ url: base + '/index.csr.html' }); return route.fulfill({ response }); }
      return route.continue();
    }
    if (url.origin !== api) return route.abort(); // Block optional fonts/analytics and every other external origin.
    assert.equal(route.request().headers().authorization, undefined);
    if (/^\/pets\/playback\/[^/]+\/audio$/.test(url.pathname)) {
      state.reads++; if (slowAudio) await new Promise(resolve => setTimeout(resolve, 7000));
      return route.fulfill({ body: wav(seconds), contentType: 'audio/wav', headers: { 'access-control-allow-origin': '*' } });
    }
    return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/pet/' + capability); await page.locator('app-pet-runtime').waitFor();
  await until(() => state.acquireCount >= (dropAcquire ? 2 : 1), 'bounded acquisition retry');
  // The ACK is queued on the same WebSocket, before the play event below.
  const speak = id => send('pet:play', { v: 1, generation: 1, requestId: id, leaseId: state.leaseId, startBefore: Date.now() + 14_000,
    audio: { url: `${api}/pets/playback/${id}/audio?ticket=fixture-only`, mimeType: 'audio/wav', durationMs: seconds * 1000 } });
  return { context, page, state, speak, send };
}
try {
  {
    const { context, state, speak } = await open({ dropAcquire: true, seconds: 3 });
    speak('same-peer-acquire-recovery');
    await until(() => state.reports.some(r => r.phase === 'ended'), 'same-peer acquisition retry recovers without replay');
    assert.equal(state.reads, 1); assert.equal(state.reports.filter(r => r.phase === 'started').length, 1);
    assert.equal(state.acquireCount, 2, 'lost acquire ACK retries the same ownership with its original expiry');
    await context.close();
  }
  {
    const { context, state, speak } = await open({ dropRenew: true, dropProgress: true });
    speak('playing-through-ack-loss');
    await until(() => state.reports.some(r => r.phase === 'ended'), 'speech must finish through transient renewal/progress ACK loss');
    assert.equal(state.reads, 1); assert.equal(state.reports.filter(r => r.phase === 'started').length, 1);
    assert(state.renewCount >= 2); assert.equal(state.acquireCount, 1);
    await context.close();
  }
  {
    const { context, state, speak } = await open({ slowAudio: true, seconds: 3 });
    speak('loading-through-rate-limit');
    await until(() => state.reports.some(r => r.phase === 'ended'), 'slow media must survive transient renewal rejection');
    assert.equal(state.reads, 1); assert.equal(state.reports.filter(r => r.phase === 'started').length, 1);
    assert(state.renewCount >= 2); await context.close();
  }
  {
    const { context, page, state, speak } = await open({ ttl: 3000, seconds: 10 });
    speak('expiry-must-stop'); await until(() => state.reports.some(r => r.phase === 'started'), 'expiry sample starts');
    await until(() => page.evaluate(() => window.__petAudio?.paused === true), 'unchanged conservative deadline must stop playback', 5000);
    await until(() => state.acquireCount >= 2, 'expiry schedules bounded reacquisition');
    assert.equal(state.reads, 1); assert.equal(state.reports.filter(r => r.phase === 'started').length, 1, 'reacquisition never replays old speech');
    await context.close();
  }
  {
    const { context, page, state, speak } = await open({ rejectRenew: true });
    speak('definitive-rejection'); await until(() => state.reports.some(r => r.phase === 'started'), 'rejection sample starts');
    await until(() => state.rejectedAt > 0, 'definitive renewal rejection delivered');
    await until(() => page.evaluate(() => window.__petAudio?.paused === true), 'definitive rejection must stop before natural audio completion', 1000);
    assert(Date.now() - state.rejectedAt < 1200, 'revocation stops immediately rather than waiting for natural end');
    assert(!state.reports.some(r => r.phase === 'ended'), 'revocation must precede natural completion');
    assert.equal(state.reads, 1); assert.equal(state.acquireCount, 1); await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS DIMA-036 exact pet bundle: lost acquisition ACK recovery; active speech survives renewal/progress ACK loss; loading survives rate limit; unchanged expiry still stops; bounded reacquisition never replays; definitive rejection still stops.');
} finally { await browser.close(); }
