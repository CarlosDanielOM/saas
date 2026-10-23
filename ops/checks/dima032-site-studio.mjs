import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), ns = `/overlay-studio/${publicId}`;
const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const widget = { id: 'tts-a', kind: 'tts', x: 20, y: 20, width: 800, height: 180, visible: true, locked: false, showTtsText: true };
const snapshot = { width: 1280, height: 720, widgets: [widget, { ...widget, id: 'tts-b', y: 250 }], designs: [], waitFor: ['tts'] };
function wav(seconds = 4) {
  const rate = 16000, data = Buffer.alloc(44 + rate * seconds * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < rate * seconds; i++) data.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000, 44 + i * 2);
  return data;
}
async function until(predicate, label = 'Studio condition', ms = 12000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { assert(Date.now() < deadline, label); await new Promise(r => setTimeout(r, 20)); }
}
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function open() {
  const state = { sockets: [], outbound: [], events: new Map(), reads: [], fetches: [], pendingIds: [], releaseFetch: null, deferId: null };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(({ publicId, clientId }) => {
    sessionStorage.setItem('overlay-playback:' + publicId, JSON.stringify({ clientId, completed: [], at: Date.now() }));
  }, { publicId, clientId });
  const send = (event, payload, entry = state.sockets.at(-1)) => entry.ws.send(`42${ns},${JSON.stringify([event, payload])}`);
  await context.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) return ws.close();
    const entry = { ws, id: `fixture-${state.sockets.length + 1}`, clientId: null }; state.sockets.push(entry);
    ws.send('0{"sid":"fixture-engine","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => {
      const raw = String(message);
      if (raw.startsWith(`40${ns},`)) {
        entry.clientId = JSON.parse(raw.slice(`40${ns},`.length)).clientId;
        ws.send(`40${ns},${JSON.stringify({ sid: entry.id })}`);
        send('overlay-state', { revision: 1, snapshot, pendingIds: state.pendingIds }, entry);
      }
      if (raw.startsWith(`42${ns},`)) state.outbound.push({ packet: JSON.parse(raw.slice(`42${ns},`.length)), at: Date.now(), entry });
    });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/overlays/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    if (url.pathname.includes('/events/')) {
      const id = url.pathname.split('/').at(-1), entry = state.sockets.find(s => s.id === url.searchParams.get('socketId'));
      assert(entry, 'metadata has current/original socket identity');
      assert.equal(url.searchParams.get('clientId'), entry.clientId);
      state.fetches.push(id);
      if (state.deferId === id) await new Promise(resolve => { state.releaseFetch = resolve; });
      return route.fulfill({ json: { data: structuredClone(state.events.get(id)) } });
    }
    if (url.pathname.startsWith('/dima032-fixture/')) { state.reads.push(url.pathname); return route.fulfill({ contentType: 'audio/wav', body: wav(url.pathname.includes('long-fallback') ? 75 : 4) }); }
    return route.fulfill({ json: { data: { revision: 1, snapshot } } });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/overlays/' + publicId); await page.locator('.canvas').waitFor();
  const event = (id, { owner = state.sockets.at(-1).clientId, durationMs = 4000, media = true, readTts = true } = {}) => ({ id, kind: 'tts', text: `Caption ${id}`, snapshot,
    ...(readTts ? { tts: { speechID: `speech-${id}`, ownerClientId: owner, durationMs } } : {}),
    ...(media ? { media: { url: `${api}/dima032-fixture/${id}.wav`, type: 'audio', title: 'Private TTS', volume: .75 } } : {}) });
  const dispatch = (id, options) => { const full = event(id, options); state.events.set(id, full); send('overlay-event', { id, kind: 'tts', ...(full.tts ? { tts: full.tts } : {}) }); return full; };
  const reports = id => state.outbound.filter(o => o.packet[0] === 'overlay-speech-playback' && o.packet[1].eventId === id);
  const ended = id => state.outbound.filter(o => o.packet[0] === 'overlay-speech-ended' && o.packet[1].eventId === id);
  const acked = id => state.outbound.some(o => o.packet[0] === 'overlay-ended' && o.packet[1] === id);
  return { context, page, state, send, event, dispatch, reports, ended, acked };
}
try {
  {
    const f = await open(); const { page, state, dispatch, send, ended, acked } = f;
    dispatch('path-a', { owner: null, media: false, durationMs: 800 });
    await page.getByText('Caption path-a', { exact: true }).first().waitFor();
    assert.equal(await page.locator('video,audio').count(), 0, 'Path A captions have no media element');
    await until(() => acked('path-a')); assert.equal(ended('path-a').length, 0, 'caption ACK cannot release TTS queue');
    dispatch('other-source', { owner: 'other-source-client', durationMs: 500 });
    await page.getByText('Caption other-source', { exact: true }).first().waitFor();
    assert.equal(await page.locator('video,audio').count(), 0, 'nonowner ignores even accidentally supplied media');
    await until(() => acked('other-source'));
    dispatch('expire-caption', { owner: null, media: false, durationMs: 60000 });
    await page.getByText('Caption expire-caption', { exact: true }).first().waitFor(); send('overlay-expired', ['expire-caption']);
    await until(() => acked('expire-caption')); assert.equal(await page.locator('.speech-text').count(), 0);
    assert.equal(state.reads.length, 0); assert.equal(state.outbound.filter(o => o.packet[0].startsWith('overlay-speech-')).length, 0);
    await f.context.close();
  }
  {
    const f = await open(); const { page, state, dispatch, reports, ended } = f;
    dispatch('elected');
    await until(() => reports('elected').filter(r => r.packet[1].phase === 'progress').length >= 4);
    assert.equal(await page.locator('video').count(), 1, 'one elected player even with multiple TTS widgets');
    assert.equal(await page.locator('.speech-text').count(), 2);
    const progress = reports('elected').filter(r => r.packet[1].phase === 'progress');
    assert(progress.every((r, i) => !i || r.at - progress[i - 1].at <= 500), 'progress cadence <=500ms');
    assert(progress.every((r, i) => Number.isFinite(r.packet[1].position) && r.packet[1].position > 0 && (!i || r.packet[1].position > progress[i - 1].packet[1].position)), 'positions advance in seconds');
    await page.locator('video').evaluate(v => { v.pause(); v.dispatchEvent(new Event('waiting')); });
    await until(() => reports('elected').some(r => r.packet[1].phase === 'recovering'));
    await page.locator('video').evaluate(v => v.play());
    await until(() => ended('elected').length === 1);
    assert.equal(ended('elected')[0].packet[1].speechID, 'speech-elected');
    assert.equal(ended('elected')[0].packet[1].reason, 'ended');
    assert(reports('elected').some(r => r.packet[1].phase === 'loading'));
    assert(reports('elected').some(r => r.packet[1].phase === 'playing'));
    assert.equal(state.reads.length, 1);
    const count = state.outbound.filter(o => o.packet[0].startsWith('overlay-speech-')).length;
    await page.waitForTimeout(600);
    assert.equal(state.outbound.filter(o => o.packet[0].startsWith('overlay-speech-')).length, count, 'terminal clears telemetry timer');
    dispatch('legacy', { readTts: false });
    await until(() => f.acked('legacy'));
    assert.equal(reports('legacy').length, 0, 'ordinary TTS preserves existing ACK behavior');
    await f.context.close();
  }
  {
    const f = await open(); const { page, state, dispatch } = f;
    // The wire hint is capped at 60s when pet inspection cannot supply a duration.
    await page.clock.install();
    dispatch('long-fallback', { durationMs: 60000 });
    await until(() => f.reports('long-fallback').some(r => r.packet[1].phase === 'playing'));
    assert.equal(await page.locator('video').evaluate(v => v.duration), 75, 'actual decoded mock WAV exceeds pet limit');
    await page.clock.fastForward(66000);
    assert.equal(await page.locator('video').count(), 1, 'normal TTS longer than 60s is not cut off by caption hint');
    assert.equal(f.ended('long-fallback').length, 0);
    assert.equal(state.reads.length, 1, 'unknown pet duration still plays original normal media');
    await page.locator('video').evaluate(v => v.dispatchEvent(new Event('ended')));
    await until(() => f.ended('long-fallback').length === 1);
    await f.context.close();
  }
  {
    const f = await open(); const { page, state, dispatch, send, reports } = f;
    dispatch('active'); await until(() => reports('active').some(r => r.packet[1].phase === 'playing'));
    dispatch('queued'); send('overlay-expired', ['queued', 'active']);
    await until(() => f.acked('queued') && f.acked('active'));
    assert(!state.reads.some(url => url.includes('queued')), 'cancelled queued captions never start audio');
    state.deferId = 'loading'; dispatch('loading'); await until(() => !!state.releaseFetch);
    send('overlay-expired', ['loading']); state.releaseFetch();
    await page.waitForTimeout(250); assert(!state.reads.some(url => url.includes('loading')), 'expired loading fetch never starts media');
    await f.context.close();
  }
  {
    const f = await open(); const { page, state, send, event } = f;
    const duplicate = await f.context.newPage(); duplicate.on('pageerror', e => errors.push(e.message));
    await duplicate.goto(base + '/overlays/' + publicId); await duplicate.locator('.canvas').waitFor();
    assert.equal(state.sockets.length, 2);
    assert.notEqual(state.sockets[0].clientId, state.sockets[1].clientId, 'duplicate tab receives distinct live source identity');
    const full = event('duplicate-tabs'); state.events.set(full.id, full);
    for (const entry of state.sockets) send('overlay-event', { id: full.id, kind: 'tts', tts: full.tts }, entry);
    await until(() => f.reports(full.id).some(r => r.packet[1].phase === 'playing'));
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await duplicate.locator('video').count(), 1);
    assert.equal(state.reads.length, 1, 'duplicate sources cannot duplicate elected audio');
    await f.context.close();
  }
  {
    const f = await open(); const { page, state, dispatch, send, event, reports } = f;
    state.deferId = 'old-fetch'; dispatch('old-fetch'); await until(() => !!state.releaseFetch);
    const releaseOld = state.releaseFetch;
    state.pendingIds = ['unseen-retained']; state.events.set('unseen-retained', event('unseen-retained'));
    state.sockets.at(-1).ws.close();
    await until(() => state.sockets.length > 1 && state.sockets.at(-1).clientId);
    releaseOld();
    // Deliberately stronger than the API: return retained media to prove client defense.
    send('overlay-event', { id: 'unseen-retained', kind: 'tts', tts: state.events.get('unseen-retained').tts });
    await until(() => f.acked('unseen-retained'));
    assert.equal(state.reads.length, 0, 'old async fetch and unseen replay cannot play after reconnect');
    assert.equal(reports('unseen-retained').length, 0);
    dispatch('fresh-after-reconnect');
    await until(() => reports('fresh-after-reconnect').some(r => r.packet[1].phase === 'playing'));
    assert.equal(state.reads.length, 1, 'new delivery can play after reconnect');
    await f.context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS DIMA-032 Studio: caption-only Path A, nonowner captions despite supplied media, duration/expiry, one elected audio source, correlated seconds telemetry <=500ms including recovery/end, legacy compatibility, queued/loading cancellation, disconnect epoch and unseen retained-event replay guards.');
} finally { await browser.close(); }
