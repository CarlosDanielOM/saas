/** Fixture-only integration check: no live events or real accounts. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL required');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  // A real, four-second WebM exercises the browser decoder and native ended event.
  const recorder = await browser.newPage();
  const wav = Buffer.alloc(44 + 16000); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  const video = Buffer.from(await recorder.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(10);
    const recording = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }); const chunks = [];
    recording.ondataavailable = e => chunks.push(e.data);
    const done = new Promise(resolve => recording.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))));
    const timer = setInterval(() => { ctx.fillStyle = '#6941c6'; ctx.fillRect(0, 0, 160, 90); ctx.fillStyle = '#fff'; ctx.fillText('Saved trigger fixture', 12, 44); }, 90);
    recording.start(); await new Promise(r => setTimeout(r, 4000)); recording.stop(); clearInterval(timer); stream.getTracks().forEach(t => t.stop());
    return done;
  }));
  await recorder.close();
  let triggerMode = 'empty', clipMode = 'play', triggerCalls = [], libraryCalls = 0, clipRequests = [], acks = [], socketRoute;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', e => errors.push(e.message));
  await page.routeWebSocket('**/*', ws => {
    if (new URL(ws.url()).hostname === '127.0.0.1') { ws.close(); return; }
    socketRoute = ws;
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    ws.onMessage(message => {
      const msg = String(message);
      if (msg.startsWith('40/clip/')) ws.send(`${msg.split(',')[0]},{"sid":"fixture-namespace"}`);
      if (msg.includes('clip-ended')) acks.push(msg);
    });
  });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/video/clip/') || url.hostname === 'fixture.invalid') {
      if (url.hostname === 'fixture.invalid' && triggerMode === 'image') return route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') });
      if (url.hostname === 'fixture.invalid' && triggerMode === 'audio') return route.fulfill({ contentType: 'audio/wav', body: wav });
      if (triggerMode === 'broken' && url.hostname === 'fixture.invalid') return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: 'video/webm', body: video });
    }
    if (/\/triggers\/library\//.test(url.pathname)) {
      libraryCalls++;
      return route.fulfill({ json: { data: [
        { _id: 'saved-library', assetID: 'saved-asset', asset: { _id: 'saved-asset', mimeType: triggerMode === 'image' ? 'image/gif' : triggerMode === 'audio' ? 'audio/wav' : 'video/webm', playbackUrl: 'https://fixture.invalid/saved.webm' } },
        { _id: 'unreferenced', assetID: 'unreferenced', asset: { _id: 'unreferenced', mimeType: 'video/webm', playbackUrl: 'https://fixture.invalid/WRONG.webm' } }
      ] } });
    }
    if (/\/triggers\/\d+$/.test(url.pathname)) {
      triggerCalls.push(url.pathname);
      if (triggerMode === 'error') return route.fulfill({ status: 403, json: { error: true, message: 'fixture access denied' } });
      return route.fulfill({ json: { data: triggerMode === 'empty' ? [] : [{ _id: 'created-trigger', name: 'My saved trigger', libraryItemID: 'saved-library', volume: 0, mediaType: 'video/webm' }] } });
    }
    if (url.pathname === '/clip/test') {
      clipRequests.push(req.postDataJSON());
      if (clipMode === 'retry' && clipRequests.length === 1) return route.fulfill({ status: 409, json: { error: true, status: 409 } });
      if (clipMode === 'error') return route.fulfill({ status: 500, json: { error: true, status: 500 } });
      await route.fulfill({ json: { error: false, data: { error: false } } });
      if (clipMode !== 'wait') setTimeout(() => socketRoute?.send(`42/clip/${req.postDataJSON().channelID},${JSON.stringify(['play-clip', { clipID: 'fixture-clip', streamerLogin: req.postDataJSON().streamer, title: 'Streamer clip fixture', duration: 15 }])}`), 50);
      return;
    }
    if (url.origin === new URL(base).origin) return route.continue();
    return route.abort();
  });
  const clickTest = name => page.locator('.event-tester__actions').getByRole('button', { name, exact: true }).click();
  const ready = () => page.waitForFunction(() => document.querySelector('.queue-status')?.textContent.includes('Playing: Ready'));
  await page.goto(`${base}/mocks/dev/overlay-editor`); await page.locator('.stage').waitFor();
  await clickTest('Clips'); assert.match(await page.locator('.notice').innerText(), /Sign in/); assert.equal(clipRequests.length, 0);
  await page.evaluate(() => localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '123', login: 'fixtureowner', display_name: 'Fixture Owner' }, appUser: { twitch_user_id: '123', name: 'fixtureowner', language: 'en', plan_tier: 'free', administrating: [{ channelID: '456', channelName: 'managedfixture' }] }, permissions: {} })));
  await page.reload(); await page.locator('.test-account select').waitFor();
  assert.equal(await page.locator('.test-account select').inputValue(), '123');
  // No triggers preserves glow and does not query the asset library.
  await clickTest('Trigger alerts'); await page.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('No saved triggers'));
  assert.equal(libraryCalls, 0); assert.equal(await page.locator('app-overlay-test-player').count(), 0);
  assert.match(await page.locator('.widget[data-kind="trigger"]').getAttribute('class'), /is-preview/);
  await page.waitForTimeout(2700); await ready();
  // Playback must outlive the old 2.5s simulation and keep its FIFO slot until native ended.
  triggerMode = 'video';
  await page.locator('.event-checks').getByLabel('Trigger alerts', { exact: true }).check();
  await clickTest('Trigger alerts'); const triggerVideo = page.locator('.widget[data-kind="trigger"] video'); await triggerVideo.waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('.widget[data-kind="trigger"] video'); return v && v.currentTime > 0; });
  assert.match(await triggerVideo.getAttribute('src'), /saved.webm$/); assert.equal(await triggerVideo.evaluate(v => v.volume), 0);
  await clickTest('Bits'); await page.waitForFunction(() => document.querySelector('.queue-heading')?.textContent.includes('1 waiting'));
  console.log('Checked active FIFO');
  await page.waitForTimeout(2600); assert.equal(await triggerVideo.count(), 1);
  await page.waitForFunction(() => document.querySelector('.queue-status')?.textContent.includes('Playing: Bits'));
  await ready();
  console.log('Checked trigger playback');
  // Access errors do not claim that the streamer has no triggers; failed media releases FIFO.
  triggerMode = 'error'; await clickTest('Trigger alerts'); await page.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('Could not load'));
  await ready();
  triggerMode = 'broken'; await clickTest('Trigger alerts'); await page.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('could not play'));
  await ready();
  // Images hold for five seconds; audio uses native playback completion.
  triggerMode = 'image'; await clickTest('Trigger alerts'); await page.locator('app-overlay-test-player img').waitFor(); await ready();
  triggerMode = 'audio'; await clickTest('Trigger alerts'); await page.locator('app-overlay-test-player .audio-label').waitFor(); await ready();
  console.log('Checked media errors, images and audio');
  // Live clip contract, retry, selected streamer, native playback, single acknowledgement.
  triggerMode = 'video'; clipMode = 'retry';
  await page.locator('.test-account select').selectOption('456');
  await clickTest('Clips'); const clipVideo = page.locator('.widget[data-kind="clip"] video'); await clipVideo.waitFor();
  assert.equal(clipRequests.length, 2); assert.deepEqual(clipRequests[0], { channelID: '456', streamer: 'managedfixture', timeout: 30 });
  assert.match(await clipVideo.getAttribute('src'), /\/video\/clip\/456\?t=/);
  await page.waitForFunction(() => { const v = document.querySelector('.widget[data-kind="clip"] video'); return v && v.currentTime > 0; });
  await page.waitForFunction(() => !document.querySelector('.widget[data-kind="clip"] video'));
  await page.waitForTimeout(150); assert.equal(acks.length, 1); assert.match(acks[0], /fixture-clip/);
  clipMode = 'error'; await clickTest('Clips'); await page.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('could not start'));
  assert.equal(await page.locator('.event-tester__actions').getByRole('button', { name: 'Clips', exact: true }).isEnabled(), true);
  console.log('Checked clip playback');
  // Cancel a pending subscription on channel switch; no phantom completion acknowledgement.
  clipMode = 'wait'; await clickTest('Clips'); await page.waitForTimeout(900);
  await page.locator('.test-account select').selectOption('123');
  assert.equal(await page.locator('.event-tester__actions').getByRole('button', { name: 'Clips', exact: true }).isEnabled(), true);
  assert.equal(acks.length, 1);
  // Responsive playback remains in its source rectangle.
  triggerMode = 'video'; await page.setViewportSize({ width: 375, height: 900 }); await clickTest('Trigger alerts'); await triggerVideo.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SAAS_SCREENSHOT_DIR) { await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/real-trigger-mobile.png`, fullPage: true }); }
  await page.getByLabel('Global overlay', { exact: true }).selectOption('chatting');
  assert.equal(await page.locator('app-overlay-test-player').count(), 0);
  assert(triggerCalls.every(path => path === '/triggers/123'));
  assert.deepEqual(errors, []);
  console.log('PASS: signed-out guard, selected streamer, empty trigger glow, saved trigger media, silent volume, natural playback, FIFO/error release, clip namespace + POST + retry + media + single acknowledgement, cancellation, mobile. All APIs and sockets used fixtures.');
} finally { await browser.close(); }
