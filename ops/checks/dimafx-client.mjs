// Client tests use a loopback copy, mocked Twitch checkout and mocked API only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import('/tmp/saas-visual-check/node_modules/playwright/index.mjs'));
const base = process.env.SAAS_DIMAFX_PREVIEW_URL;
assert.ok(base, 'SAAS_DIMAFX_PREVIEW_URL required');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [file, viewport] of [['panel.html', { width: 320, height: 650 }], ['mobile.html', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    let connected = false;
    const requests = [];
    const item = { id: 'item-1', name: 'Fixture audio', category: 'audio', bitsPrice: 5, sku: 'dimafx_bits_5', description: 'Test purchase', mediaType: 'audio', durationMs: 1000 };
    const inventory = { balance: 10, items: [], config: { quickPurchasePriority: 'bits_first', quickPurchaseAction: 'use_now' } };
    await context.addInitScript(() => {
      window.bitsCalls = 0;
      window.Twitch = { ext: { actions: { requestIdShare() {} }, onAuthorized(fn) { window.authorize = fn; }, bits: {
        useBits() { window.bitsCalls++; }, onTransactionComplete(fn) { window.completeTransaction = fn; }, onTransactionCancelled(fn) { window.cancelTransaction = fn; },
      } } };
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/')) {
        requests.push({ path: url.pathname, method: route.request().method() });
        let data = {};
        if (url.pathname.endsWith('/overlay-status')) data = { connected };
        else if (url.pathname.endsWith('/me')) data = { identityShared: true, inventory };
        else if (url.pathname.endsWith('/items')) data = [item];
        else if (url.pathname.endsWith('/purchase')) data = { queued: true };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: false, data }) });
      }
      if (url.origin === new URL(base).origin && !url.pathname.startsWith('/assets/')) return route.continue();
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/${file}`);
    await page.waitForFunction(() => typeof window.authorize === 'function');
    await page.evaluate(() => window.authorize({ token: 'fixture', channelId: '999983' }));
    await page.locator('.price-btn').waitFor();
    assert.equal(await page.locator('.price-btn').isDisabled(), true, 'offline card purchase disabled');
    await page.locator('.card-title').click();
    assert.equal(await page.locator('.drawer-buy-btn.bits').isDisabled(), true, 'offline drawer purchase disabled');
    assert.equal(await page.locator('.drawer-buy-btn.credits').isDisabled(), true, 'offline credit purchase disabled');
    connected = true;
    await page.evaluate(() => refreshOverlayStatus());
    assert.equal(await page.locator('.drawer-buy-btn.bits').isEnabled(), true);
    // Lose connectivity after rendering the enabled button, before checkout.
    connected = false;
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(await page.evaluate(() => window.bitsCalls), 0, 'fresh preflight prevents Twitch charge');
    connected = true;
    await page.evaluate(() => refreshOverlayStatus());
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => window.bitsCalls === 1);
    await page.evaluate(() => window.completeTransaction({ transactionId: 'fixture-tx' }));
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(requests.filter(r => r.path.endsWith('/purchase')).length, 1, 'online purchase completes once');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no viewport overflow');
    await page.screenshot({ path: `/tmp/dimafx-${file}.png` });
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    await context.close();
  }
  // Exercise the actual OBS player with a mock socket and local image media.
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<div id="dimafx-player"></div>' }));
  await page.goto('http://127.0.0.1:4284/overlays/dimafx/999983?token=fixture');
  await page.evaluate(() => {
    window.handlers = {}; window.emitted = [];
    window.io = (namespace, options) => {
      window.overlayNamespace = namespace; window.overlayAuth = options.auth;
      return { on(name, fn) { window.handlers[name] = fn; }, emit(name, payload) { window.emitted.push({ name, payload }); } };
    };
  });
  const source = await fs.readFile(path.resolve('dimabot/src/server/routes/public/dimafx-player.js'), 'utf8');
  await page.addScriptTag({ content: source });
  await page.evaluate(() => window.handlers.connect());
  assert.equal(await page.evaluate(() => window.overlayNamespace), '/overlays/dimafx/999983');
  assert.equal(await page.evaluate(() => window.overlayAuth.token), 'fixture');
  const job = { triggerID: 'same-purchase', mediaType: 'image/png', volume: 100, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=' };
  await page.evaluate(job => { window.handlers['dimafx-play'](job); window.handlers['dimafx-play'](job); }, job);
  assert.equal(await page.locator('#dimafx-player img').count(), 1, 'active job redelivery creates only one player');
  await page.waitForFunction(() => window.emitted.some(e => e.name === 'dimafx-ended'), { timeout: 8000 });
  await page.evaluate(job => window.handlers['dimafx-play'](job), job);
  assert.equal(await page.locator('#dimafx-player img').count(), 0, 'completed delivery is acknowledged without replay');
  await page.reload();
  await page.evaluate(() => { window.handlers = {}; window.emitted = []; window.io = () => ({ on(name, fn) { window.handlers[name] = fn; }, emit(name, payload) { window.emitted.push({ name, payload }); } }); });
  await page.addScriptTag({ content: source });
  await page.evaluate(job => window.handlers['dimafx-play'](job), job);
  assert.equal(await page.locator('#dimafx-player img').count(), 0, 'completed receipt survives player reload');
  assert.equal(await page.evaluate(() => window.emitted[0].name), 'dimafx-ended');
  await context.close();
  console.log('PASS: panel/mobile offline gating, checkout preflight race, online purchase, and OBS deduplication during playback/completion/reload');
} finally { await browser.close(); }
