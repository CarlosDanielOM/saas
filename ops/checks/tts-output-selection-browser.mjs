// Speech page side of TTS output selection: page id, state reports, the silent audio probe,
// the `ready` phase, cancel/reset confirmations and the autoplay-blocked path, in real Chromium.
// Run on a host with Playwright: PLAYWRIGHT_PACKAGE=/path/to/package.json node <this-file>.
// TTS_OVERLAY_HTML can point at HTML extracted from the exact candidate image.
// Not covered here: Chromium in Playwright always reports pages as visible, so OBS hiding a
// source (and holding its audio back) is exercised by the server unit tests with simulated reports.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const html = readFileSync(process.env.TTS_OVERLAY_HTML || 'dimabot/src/server/routes/public/speech.html', 'utf8');
const rate = 16000, duration = 2, wav = Buffer.alloc(44 + rate * duration * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < rate * duration; i++) wav.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000, 44 + i * 2);
const server = http.createServer((req, res) => {
  if (!req.url.endsWith('.wav')) { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  res.setHeader('Content-Type', 'audio/wav');
  if (req.url === '/slow.wav') return setTimeout(() => res.end(wav), 5000);
  res.end(wav);
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/speech/fixture/`;

const fakeSocket = `
  window.outbound = []; window.handlers = {}; window.ioCalls = [];
  window.io = (path, options) => { ioCalls.push({ path, options }); return {
    connected: true,
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload) { outbound.push({ event, ...payload }); }
  }; };`;

async function openPage(browser, { obs = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (obs) await page.addInitScript(() => { window.obsstudio = { pluginVersion: '2.24.0' }; });
  await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: fakeSocket }));
  await page.goto(url);
  return { page, errors };
}
const outbound = (page, event) => page.evaluate(name => outbound.filter(entry => entry.event === name), event);
const lastState = async (page) => (await outbound(page, 'speech-state')).at(-1);
const deliver = (page, id, audioUrl = `/${id}.wav`) => page.evaluate(({ id, audioUrl }) => handlers.speech({ speechID: id, audioUrl }), { id, audioUrl });
const cancel = (page, id) => page.evaluate(speechID => new Promise(resolve => handlers['speech-cancel']({ speechID }, resolve)), id);
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const { page, errors } = await openPage(browser, { obs: true });
  const [call] = await page.evaluate(() => ioCalls);
  assert.equal(call.options.auth.v, 2);
  assert.match(call.options.auth.pageId, /^[A-Za-z0-9_-]{8,64}$/, 'a page id the server accepts');
  await page.evaluate(() => handlers['speech-reset']());
  await until(page, () => outbound.some(entry => entry.event === 'speech-state' && entry.probe === 'ok'));
  const state = await lastState(page);
  assert.deepEqual([state.v, state.pageId, state.visible, state.obs, state.played, state.probe], [2, call.options.auth.pageId, true, true, true, 'ok'],
    'the silent probe played: this page can play sound');
  assert.equal(await page.locator('audio').count(), 0, 'the probe leaves nothing in the page');

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('obsSourceActiveChanged', { detail: { active: false } })));
  assert.equal((await lastState(page)).obsActive, false, 'OBS program-output changes are reported');

  // Normal playback: ready comes after the download and before playing; the end says it was heard.
  await deliver(page, 'first');
  await until(page, () => outbound.some(entry => entry.event === 'speech-ended' && entry.speechID === 'first'));
  const phases = (await outbound(page, 'speech-playback')).filter(entry => entry.speechID === 'first').map(entry => entry.phase);
  assert.ok(phases.indexOf('loading') < phases.indexOf('ready') && phases.indexOf('ready') < phases.indexOf('playing'), `phases: ${phases}`);
  const first = (await outbound(page, 'speech-ended')).find(entry => entry.speechID === 'first');
  assert.deepEqual([first.reason, first.started], ['ended', true]);

  // Cancel while downloading: confirmed, nothing plays later, no ending reported.
  await deliver(page, 'slow-cancel', '/slow.wav');
  await until(page, () => outbound.some(entry => entry.phase === 'loading' && entry.speechID === 'slow-cancel'));
  assert.deepEqual(await cancel(page, 'slow-cancel'), { stopped: true, started: false });
  await page.waitForTimeout(5500);
  assert.equal(await page.locator('audio').count(), 0, 'a cancelled download never starts');
  assert.equal((await outbound(page, 'speech-ended')).filter(entry => entry.speechID === 'slow-cancel').length, 0);

  // Cancel while playing: the page says it had started, so the server never replays it.
  await deliver(page, 'play-cancel');
  await until(page, () => document.querySelector('audio')?.currentTime > 0.25);
  assert.deepEqual(await cancel(page, 'play-cancel'), { stopped: true, started: true });
  assert.equal(await page.locator('audio').count(), 0);

  // A queued message can be cancelled without touching the one playing.
  await deliver(page, 'keep');
  await deliver(page, 'queued-cancel');
  assert.deepEqual(await cancel(page, 'queued-cancel'), { stopped: true, started: false });
  await until(page, () => outbound.some(entry => entry.event === 'speech-ended' && entry.speechID === 'keep'));
  await page.waitForTimeout(300);
  assert.equal((await outbound(page, 'speech-playback')).filter(entry => entry.speechID === 'queued-cancel').length, 0);
  assert.deepEqual(await cancel(page, 'never-seen'), { stopped: true, started: false }, 'unknown ids are confirmed too');

  // A server reset while playing is confirmed as a stop (releases a skipped message right away).
  await deliver(page, 'play-reset');
  await until(page, () => document.querySelector('audio')?.currentTime > 0.25);
  const statesBefore = (await outbound(page, 'speech-state')).length;
  await page.evaluate(() => handlers['speech-reset']());
  const reset = (await outbound(page, 'speech-ended')).find(entry => entry.speechID === 'play-reset');
  assert.deepEqual([reset?.reason, reset?.started], ['reset', true]);
  assert.ok((await outbound(page, 'speech-state')).length > statesBefore, 'the page re-reports its state after a reset');
  assert.equal(await page.locator('audio').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
  await browser.close();

  // A browser that blocks sound until the page is clicked. Playwright's evaluate counts as a click
  // (it unlocks sound), so this part runs from inside the page and is read from console output.
  browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'] });
  const blockedPage = await browser.newPage();
  const logs = [], blockedErrors = [];
  blockedPage.on('pageerror', error => blockedErrors.push(error.message));
  blockedPage.on('console', message => { if (message.text().startsWith('OUT ')) logs.push(JSON.parse(message.text().slice(4))); });
  await blockedPage.addInitScript(() => {
    window.addEventListener('load', () => setTimeout(() => {
      handlers['speech-reset']();
      handlers.speech({ speechID: 'blocked-1', audioUrl: '/blocked-1.wav' });
    }, 300));
  });
  await blockedPage.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript',
    body: fakeSocket.replace('outbound.push({ event, ...payload });', "outbound.push({ event, ...payload }); console.log('OUT ' + JSON.stringify({ event, ...payload }));") }));
  const logged = async (match, label) => {
    for (let i = 0; i < 150; i++) { const found = logs.find(match); if (found) return found; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.fail(`${label} not seen: ${JSON.stringify(logs)}`);
  };
  await blockedPage.goto(url);
  const blockedEnd = await logged(entry => entry.event === 'speech-ended' && entry.speechID === 'blocked-1', 'blocked ending');
  assert.deepEqual([blockedEnd.reason, blockedEnd.started], ['play-error', false]);
  const blockedState = logs.filter(entry => entry.event === 'speech-state').at(-1);
  assert.deepEqual([blockedState.probe, blockedState.played, blockedState.obs], ['blocked', false, false], 'the server is told this copy blocks sound');
  await blockedPage.mouse.click(10, 10);
  await logged(entry => entry.event === 'speech-state' && entry.probe === 'ok', 'probe after a click');
  await deliver(blockedPage, 'blocked-2');
  const unblocked = await logged(entry => entry.event === 'speech-ended' && entry.speechID === 'blocked-2', 'ending after a click');
  assert.equal(unblocked.reason, 'ended');
  assert.deepEqual(blockedErrors, []);
  console.log('PASS: speech page reports its state, probes audio, says ready, confirms cancels and resets, and recovers from blocked autoplay');
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
