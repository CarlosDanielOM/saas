// Run on a host with Playwright: PLAYWRIGHT_PACKAGE=/path/to/package.json node <this-file>.
// TTS_OVERLAY_HTML can point at HTML extracted from the exact candidate image.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const html = readFileSync(process.env.TTS_OVERLAY_HTML || 'dimabot/src/server/routes/public/speech.html', 'utf8');
const rate = 16000, duration = 3, wav = Buffer.alloc(44 + rate * duration * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < rate * duration; i++) wav.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000, 44 + i * 2);
let retryRequests = 0;
const server = http.createServer((req, res) => {
  if (!req.url.endsWith('.wav')) { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  res.setHeader('Content-Type', 'audio/wav');
  if (req.url === '/slow.wav') return setTimeout(() => res.end(wav), 10000);
  if (req.url === '/retry.wav' && ++retryRequests === 1) return setTimeout(() => res.end(wav), 500);
  if (req.url === '/broken.wav') { res.statusCode = 503; return res.end(); }
  res.end(wav);
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.outbound = []; window.handlers = {}; window.io = () => ({
      on(event, handler) { handlers[event] = handler; if (event === 'speech') window.deliverSpeech = handler; },
      emit(event, payload) { outbound.push({ event, ...payload }); }
    });` }));
  await page.goto(`http://127.0.0.1:${server.address().port}/speech/fixture`);
  await page.evaluate(() => handlers['speech-reset']?.());
  const deliver = (id, url = `/${id}.wav`) => page.evaluate(({id, url}) => deliverSpeech({ speechID: id, audioUrl: url }), {id, url});
  const ended = () => page.evaluate(() => outbound.filter(e => e.event === 'speech-ended'));
  await deliver('first');
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > .25);
  await deliver('second');
  await deliver('first');
  await page.waitForFunction(() => outbound.filter(e => e.event === 'speech-ended').length === 2);
  assert.deepEqual((await ended()).map(e => [e.speechID, e.reason, e.position]), [
    ['first', 'ended', 3], ['second', 'ended', 3],
  ], 'overlap and duplicate delivery preserve full, ordered playback');
  await deliver('slow');
  await page.waitForTimeout(9000);
  assert.equal((await ended()).length, 2, 'download delay beyond old watchdog does not discard audio');
  await page.waitForFunction(() => outbound.some(e => e.event === 'speech-ended' && e.speechID === 'slow'));
  assert.equal((await ended()).at(-1).position, 3);
  // Speed only the download timeout to exercise an aborted request resolving late.
  await page.evaluate(() => {
    const original = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) => original(fn, delay === 20000 ? 100 : delay, ...args);
  });
  await deliver('retry');
  await page.waitForFunction(() => outbound.some(e => e.event === 'speech-ended' && e.speechID === 'retry'));
  assert.equal(retryRequests, 2);
  assert.equal((await ended()).at(-1).position, 3);
  await deliver('broken');
  await deliver('last');
  await page.waitForFunction(() => outbound.some(e => e.event === 'speech-ended' && e.speechID === 'last'));
  assert.deepEqual((await ended()).slice(-2).map(e => [e.speechID, e.reason]), [
    ['broken', 'download-error'], ['last', 'ended'],
  ]);
  await deliver('stalled');
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > .25);
  await page.evaluate(() => document.querySelector('audio').pause());
  await page.waitForFunction(() => outbound.some(e => e.event === 'speech-ended' && e.speechID === 'stalled'), null, { timeout: 25000 });
  const stalled = await page.evaluate(() => outbound.filter(e => e.speechID === 'stalled'));
  assert.ok(stalled.some(e => e.phase === 'recovering'), 'stalled decoder is restarted');
  assert.equal(stalled.at(-1).reason, 'ended');
  assert.equal(stalled.at(-1).position, 3);
  assert.equal(await page.locator('audio').count(), 0, 'completed media is stopped and removed');
  await deliver('disconnect-playing');
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > .25);
  await deliver('disconnect-queued');
  await page.evaluate(() => handlers.disconnect?.());
  assert.equal(await page.locator('audio').count(), 0);
  await deliver('recovered-stale-packet');
  assert.equal(await page.locator('audio').count(), 0, 'old connection packets ignored before synchronization');
  await page.evaluate(() => { handlers.connect?.(); handlers['speech-reset']?.(); });
  await deliver('after-reconnect');
  await page.waitForFunction(() => outbound.some(e => e.event === 'speech-ended' && e.speechID === 'after-reconnect'));
  assert.equal((await ended()).filter(e => ['disconnect-playing','disconnect-queued','recovered-stale-packet'].includes(e.speechID)).length, 0);
  // Aborting a pending download must also prevent it starting later.
  await deliver('disconnect-loading', '/slow.wav');
  await page.evaluate(() => handlers.disconnect?.());
  await page.evaluate(() => { handlers.connect?.(); handlers['speech-reset']?.(); });
  await deliver('after-abort');
  await page.waitForFunction(() => outbound.some(e => e.event === 'speech-ended' && e.speechID === 'after-abort'));
  assert.equal(await page.locator('audio').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: real Chromium media completes in order; slow download, abort/retry, duplicate and failed delivery covered');
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
