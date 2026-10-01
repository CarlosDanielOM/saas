// Browser behavior for the standalone OBS HTML. All media/events are local fixtures.
// SAAS_CLIP_HTML selects an isolated API build snapshot; SAAS_CLIP_URL checks a deployed page.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const variants = ['classic', 'third', 'tile', 'cinema', 'orbit', 'pill', 'hud', 'slash'];
const tall = v => ['third', 'cinema', 'pill', 'hud'].includes(v);
const source = process.env.SAAS_CLIP_HTML ? await readFile(process.env.SAAS_CLIP_HTML, 'utf8') : null;
const base = process.env.SAAS_CLIP_URL || 'https://clip.fixture.invalid/clip/990191';
assert.ok(source || process.env.SAAS_CLIP_URL, 'Choose an isolated HTML snapshot or deployed clip URL');
const fixtureCheck = await readFile('/root/saas/ops/checks/overlay-clip-designs.mjs', 'utf8');
const mp4 = Buffer.from(fixtureCheck.match(/const mp4 = Buffer.from\('([^']+)', 'base64'\)/)[1], 'base64');
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const socketFixture = `window.__handlers={}; window.__emissions=[]; window.io=()=>({on(n,f){window.__handlers[n]=f},emit(n,v){window.__emissions.push({n,v})}});`;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdnjs.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: socketFixture });
    if (url.pathname.startsWith('/video/clip/')) return route.fulfill({ contentType: 'video/mp4', body: mp4 });
    if (url.pathname.endsWith('/avatar.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#8b5cf6"/></svg>' });
    if (route.request().isNavigationRequest() && url.origin === new URL(base).origin && url.pathname === new URL(base).pathname) return source ? route.fulfill({ contentType: 'text/html', body: source }) : route.continue();
    return route.abort();
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  for (const variant of variants) {
    await page.goto(base + '?design=' + variant);
    await page.waitForFunction(() => !!window.__handlers?.['play-clip']);
    await page.evaluate(v => window.__handlers['play-clip']({ clipID: v, streamer: 'Fixture streamer', description: 'Complete frame', game: 'Fixture game', title: 'Fixture title', profileImage: 'https://clip.fixture.invalid/avatar.svg', streamerColor: '#8b5cf6', duration: 8 }), variant);
    await page.waitForFunction(() => document.querySelector('#overlay').classList.contains('is-in'));
    // Wait for entrance transforms to settle before measuring the complete composition.
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('video')).opacity) === 1);
    for (const width of [320, 375, 800, 1440]) {
      await page.setViewportSize({ width, height: 450 });
      await page.waitForFunction(() => {
        const frame = document.querySelector('#overlay'), scale = Math.min(innerWidth / 800, innerHeight / frame.offsetHeight);
        return Math.abs(frame.getBoundingClientRect().width - 800 * scale) < 1;
      });
      const state = await page.evaluate(() => {
        const frame = document.querySelector('#overlay'), video = document.querySelector('video'), slot = document.querySelector('.skin__video'), meta = document.querySelector('.skin__meta');
        const f = frame.getBoundingClientRect(), v = slot.getBoundingClientRect(), m = meta.getBoundingClientRect();
        return { width: frame.offsetWidth, height: frame.offsetHeight, renderedWidth: f.width, renderedHeight: f.height, fit: getComputedStyle(video).objectFit, mask: getComputedStyle(slot).clipPath, slotRatio: v.width / v.height, videoWidth: v.width / f.width, metaWidth: m.width / f.width, metaTop: (m.top - f.top) / f.height, nativeRatio: video.videoWidth / video.videoHeight };
      });
      assert.equal(state.width, 800, `${variant}: no flex shrinking at ${width}`);
      assert.equal(state.height, tall(variant) ? 450 : 225);
      assert.ok(state.renderedWidth <= width + 1 && state.renderedHeight <= 451, `${variant} at ${width}: ${JSON.stringify(state)}`);
      assert.ok(Math.abs(state.slotRatio - 16 / 9) < .01, JSON.stringify(state));
      assert.equal(state.fit, 'contain'); assert.equal(state.mask, 'none'); assert.equal(state.nativeRatio, 16 / 9);
      if (tall(variant)) assert.ok(state.videoWidth > .99);
      if (['third', 'cinema'].includes(variant)) { assert.ok(state.metaWidth > .99); assert.ok(state.metaTop > .5); }
    }
    await page.setViewportSize({ width: 800, height: tall(variant) ? 450 : 225 });
    if (process.env.SAAS_SCREENSHOT_DIR) { await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/standalone-${variant}.png`, omitBackground: true }); }
    await page.waitForFunction(v => window.__emissions.some(e => e.n === 'clip-ended' && e.v.clipID === v), variant);
    assert.equal(await page.evaluate(v => window.__emissions.filter(e => e.n === 'clip-ended' && e.v.clipID === v).length, variant), 1);
    console.log(`PASS standalone ${variant}: distinct composition, complete native frame, responsive scale, enter/exit and one completion`);
  }
  assert.deepEqual(errors, []); await context.close();
} finally { await browser.close(); }
