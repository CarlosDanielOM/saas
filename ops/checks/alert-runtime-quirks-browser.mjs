// Isolated public renderer: mocked socket and API, no production events, assets or WebSockets.
import assert from 'node:assert/strict';
const { chromium } = await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL || process.argv[2]; assert(base);
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const publicId = 'd'.repeat(48);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 8000) { for (let i = 0; i < ms / 25; i++) { if (await fn()) return; await sleep(25); } throw Error(label); }
const gifId = 'a'.repeat(24), soundId = 'b'.repeat(24);
const follow = { duration: 1.2, sound: { assetId: soundId, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }, widgets: [
  { id: 'img', kind: 'image', x: 80, y: 50, width: 190, height: 160, visible: true, locked: false, assetId: gifId },
  { id: 'txt', kind: 'text', x: 270, y: 60, width: 230, height: 150, visible: true, locked: false, text: '$(user) followed' }] };
const sub = { duration: .8, widgets: [{ id: 'sub-text', kind: 'text', x: 190, y: 65, width: 530, height: 90, visible: true, locked: false, text: 'sub' }] };
// sub and raid are not in waitFor, matching the default scene.
const snapshot = { width: 1920, height: 1080, waitFor: ['tts', 'trigger', 'bits', 'follow'], widgets: [{ id: 'alert-1', kind: 'alert', x: 110, y: 800, width: 640, height: 192, visible: true, locked: false, designId: 'd1', events: ['sub', 'bits', 'follow', 'raid'] }],
  designs: [{ id: 'd1', name: 'x', width: 800, height: 240, revision: 1, events: { follow, sub, bits: sub, raid: sub } }] };
// A multi-megabyte animated image, larger than the previous 2 MiB total budget.
// A valid 1x1 GIF padded with comment sub-blocks.
const gif = Buffer.concat([Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64').subarray(0, -1), Buffer.from([0x21, 0xfe]),
  ...Array.from({ length: 12300 }, () => Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 32)])), Buffer.from([0, 0x3b])]);
const wav = (() => { const n = 8000, b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44); return b; })();
try {
  for (const [width, height] of [[1920, 1080], [1280, 720], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    let socket; const ended = [], calls = [], errors = [];
    const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
    await context.routeWebSocket('**/*', ws => {
      if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws;
      ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
      ws.onMessage(raw => { const m = String(raw); if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision: 1, snapshot }); }
        if (m.includes('overlay-ended')) ended.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]); });
    });
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.origin === new URL(base).origin || u.hostname.endsWith('googleapis.com') || u.hostname.endsWith('gstatic.com')) return route.continue();
      if (u.pathname.includes('/assets/')) { const id = u.pathname.split('/').at(-1); calls.push(id); await sleep(300);
        return id === gifId ? route.fulfill({ contentType: 'image/gif', body: gif }) : route.fulfill({ contentType: 'audio/wav', body: wav }); }
      if (u.pathname.includes('/events/')) { const id = u.pathname.split('/').at(-1), kind = id.split('-')[0];
        return route.fulfill({ json: { data: { id, kind, snapshot, layouts: { d1: kind === 'follow' ? { ...follow, widgets: follow.widgets.map(w => w.kind === 'text' ? { ...w, text: 'Luna followed' } : w) } : sub } } } }); }
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/overlays/' + publicId);
    await until(() => calls.includes(gifId) && calls.includes(soundId), 'published alert picture and sound preload before any alert');
    // Fit: the whole 1920x1080 canvas is visible in any browser source size.
    const box = await page.locator('.canvas').boundingBox();
    assert.ok(Math.abs(box.width - Math.min(width, height * 16 / 9)) < 2 && box.height <= height + 1, `canvas fits ${width}x${height}: ${JSON.stringify(box)}`);
    await sleep(700);
    send('overlay-event', { id: 'follow-1', kind: 'follow' });
    const image = page.locator('[data-event=follow] img');
    await image.waitFor();
    assert.match(await image.getAttribute('src'), /^blob:/, 'large GIF plays from local bytes');
    assert.ok(await page.evaluate(() => document.fonts.check("400 40px 'Plus Jakarta Sans'")), 'web font is ready before the first alert text');
    assert.equal(await page.locator('app-overlay-sound audio').evaluate(a => a.src.startsWith('blob:')), true, 'sound plays from local bytes');
    await until(() => ended.includes('follow-1'), 'follow completes');
    send('overlay-event', { id: 'follow-2', kind: 'follow' }); await image.waitFor();
    assert.equal(calls.filter(id => id === gifId).length, 1, 'repeat alert reuses picture bytes');
    assert.equal(calls.filter(id => id === soundId).length, 1, 'repeat alert reuses sound bytes');
    await until(() => ended.includes('follow-2'), 'repeat completes');
    // Five simultaneous subs (not in waitFor) and a raid share one alert box: one at a time, in order.
    let peak = 0; const order = [];
    const ids = ['sub-1', 'sub-2', 'raid-1', 'sub-3', 'sub-4'];
    for (const id of ids) send('overlay-event', { id, kind: id.split('-')[0] });
    const t0 = Date.now();
    while (ids.some(id => !ended.includes(id)) && Date.now() - t0 < 15000) {
      const count = await page.locator('[data-event]').count(); peak = Math.max(peak, count);
      for (const id of ended) if (ids.includes(id) && !order.includes(id)) order.push(id);
      await sleep(20);
    }
    for (const id of ended) if (ids.includes(id) && !order.includes(id)) order.push(id);
    assert.equal(peak, 1, 'alerts never overlap in the same box');
    assert.deepEqual(order, ids, 'queued alerts keep arrival order');
    // Skipping the playing alert releases its box for the next one.
    send('overlay-event', { id: 'sub-5', kind: 'sub' }); send('overlay-event', { id: 'sub-6', kind: 'sub' });
    await page.locator('[data-event=sub]').waitFor();
    send('overlay-control', { id: 'skip-1', action: 'skip', eventIds: ['sub-5'] });
    await until(() => ended.includes('sub-5'), 'skip ends playing alert');
    await until(async () => await page.locator('[data-event=sub]').count() === 1, 'next alert starts after skip');
    await until(() => ended.includes('sub-6'), 'next alert completes');
    await page.screenshot({ path: `/tmp/alert-runtime-quirks-${width}.png` });
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS alert runtime: canvas fits 1920/1280/390 sources, multi-MiB GIF and sound preload and replay locally, web font ready, one alert per box in order, skip releases the box');
} finally { await browser.close(); }
