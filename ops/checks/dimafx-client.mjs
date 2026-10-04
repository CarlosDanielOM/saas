// Client tests use a loopback copy, mocked Twitch checkout and mocked API only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import('/tmp/saas-visual-check/node_modules/playwright/index.mjs'));
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_DIMAFX_PREVIEW_URL;
assert.ok(base, 'SAAS_DIMAFX_PREVIEW_URL required');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const day = 86400000;
async function axe(page, label) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target).slice(0, 3) })), [], `axe ${label}`);
}
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no viewport overflow: ${label}`);
}
async function openStore({ file, viewport, query = '', theme = 'dark', shared = true, config = { quickPurchasePriority: 'bits_first', quickPurchaseAction: 'use_now' }, balance = 10, items, owned = [] }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const state = { connected: false, requests: [] };
  const inventory = { balance, items: owned, config };
  await context.addInitScript((theme) => {
    window.bitsCalls = 0;
    window.Twitch = { ext: { actions: { requestIdShare() { window.idShareCalls = (window.idShareCalls || 0) + 1; } }, onAuthorized(fn) { window.authorize = fn; },
      onContext(fn) { window.setContext = fn; setTimeout(() => fn({ theme }, ['theme'])); }, bits: {
      useBits() { window.bitsCalls++; }, onTransactionComplete(fn) { window.completeTransaction = fn; }, onTransactionCancelled(fn) { window.cancelTransaction = fn; },
    } } };
  }, theme);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/')) {
      state.requests.push({ path: url.pathname, method: route.request().method(), body: route.request().postData() });
      let data = {};
      if (url.pathname.endsWith('/overlay-status')) data = { connected: state.connected };
      else if (url.pathname.endsWith('/me')) data = shared ? { identityShared: true, inventory } : { identityShared: false, inventory: null };
      else if (url.pathname.endsWith('/items')) data = items;
      else if (url.pathname.endsWith('/purchase') || url.pathname.endsWith('/use-credit') || url.pathname.endsWith('/redeem')) data = { queued: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: false, data }) });
    }
    if (url.origin === new URL(base).origin && !url.pathname.startsWith('/assets/')) return route.continue();
    if (url.pathname.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64') });
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/${file}${query}`);
  await page.waitForFunction(() => typeof window.authorize === 'function');
  await page.evaluate(() => window.authorize({ token: 'fixture', channelId: '999983' }));
  await page.locator('.price-btn, #empty-state:not([hidden])').first().waitFor();
  await page.waitForFunction(() => overlayChecked);
  const setConnected = async (value) => { state.connected = value; await page.evaluate(() => refreshOverlayStatus()); };
  return { context, page, state, errors, setConnected };
}
const fixtureItems = [
  { id: 'item-1', name: 'Fixture audio', category: 'audio', bitsPrice: 5, sku: 'dimafx_bits_5', description: 'Test purchase', mediaType: 'audio', durationMs: 1000, channelName: 'FixtureChannel', createdAt: new Date(Date.now() - day).toISOString() },
  { id: 'item-2', name: 'Fixture voice', category: 'tts', bitsPrice: 20, sku: 'dimafx_bits_20', description: 'Say anything', mediaType: 'audio', tts: { mode: 'custom' }, channelName: 'FixtureChannel' },
  { id: 'item-3', name: 'Fixture image', category: 'gif', bitsPrice: 0, sku: 'dimafx_free', description: 'Free one', mediaType: 'gif', thumbnailUrl: 'https://fixture.test/thumb.png', mediaUrl: 'https://fixture.test/thumb.png', channelName: 'FixtureChannel' },
];
try {
  // Purchase gating and checkout preflight on both entry points (the original contract).
  for (const [file, viewport] of [['panel.html', { width: 318, height: 500 }], ['mobile.html', { width: 390, height: 844 }]]) {
    const { context, page, state, errors, setConnected } = await openStore({ file, viewport, items: fixtureItems.slice(0, 1) });
    assert.equal(await page.locator('.price-btn').isDisabled(), true, 'offline card purchase disabled');
    assert.match(await page.locator('#dimafx-connection-status').innerText(), /paused.*FixtureChannel.*won't be charged/i, 'offline status explains consequence');
    await page.locator('.card-title').click();
    assert.equal(await page.locator('.drawer-buy-btn.bits').isDisabled(), true, 'offline drawer purchase disabled');
    assert.equal(await page.locator('.drawer-buy-btn.credits').isDisabled(), true, 'offline credit purchase disabled');
    await setConnected(true);
    assert.equal(await page.locator('#fx-live-label').innerText(), 'On stream');
    assert.equal(await page.locator('.drawer-buy-btn.bits').isEnabled(), true);
    // Lose connectivity after rendering the enabled button, before checkout.
    state.connected = false;
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(await page.evaluate(() => window.bitsCalls), 0, 'fresh preflight prevents Twitch charge');
    await setConnected(true);
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => window.bitsCalls === 1);
    await page.evaluate(() => window.completeTransaction({ transactionId: 'fixture-tx' }));
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(state.requests.filter(r => r.path.endsWith('/purchase')).length, 1, 'online purchase completes once');
    await noOverflow(page, file);
    await page.screenshot({ path: `/tmp/dimafx-${file}.png` });
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    await context.close();
  }

  // Store browsing, credits double-tap, custom voice message, saved items, a11y and themes.
  for (const theme of ['dark', 'light']) {
    for (const [file, viewport] of [['panel.html', { width: 318, height: 500 }], ['mobile.html', { width: 320, height: 640 }], ['mobile.html', { width: 390, height: 844 }]]) {
      const label = `${file}@${viewport.width} ${theme}`;
      const { context, page, state, errors, setConnected } = await openStore({
        file, viewport, theme, items: fixtureItems, balance: 50,
        config: { quickPurchasePriority: 'credits_first', quickPurchaseAction: 'use_now' },
        owned: [{ channelExtensionItemID: 'item-1', quantity: 2 }],
      });
      await setConnected(true);
      await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
      assert.equal(await page.locator('.fx-filter').count(), 4, `${label}: type chips with All`);
      await page.locator('.fx-filter', { hasText: 'Voice' }).click();
      assert.equal(await page.locator('.fx-tile').count(), 1, `${label}: filter narrows list`);
      await page.locator('.fx-filter', { hasText: 'All' }).click();
      assert.equal(await page.locator('.fx-tile').count(), 3);
      assert.equal(await page.locator('#fx-saved-count').innerText(), '2', `${label}: saved badge`);
      await noOverflow(page, label);
      await axe(page, `${label} store`);

      // One tap never spends credits: the first tap asks, the second pays.
      const creditsBtn = page.locator('.fx-tile[data-id="item-1"] .price-btn');
      assert.match(await creditsBtn.innerText(), /5 credits/);
      await creditsBtn.click();
      assert.match(await creditsBtn.innerText(), /Spend 5\?/, `${label}: credits confirm step`);
      assert.equal(state.requests.filter(r => r.path.endsWith('/use-credit')).length, 0, `${label}: first tap spends nothing`);
      await creditsBtn.click();
      await page.waitForFunction(() => !actionInFlight);
      assert.equal(state.requests.filter(r => r.path.endsWith('/use-credit')).length, 1, `${label}: second tap pays with credits`);

      // Custom voice message: tile opens the sheet, Bits disabled until text, no save option.
      await page.locator('.fx-tile[data-id="item-2"] .price-btn').click();
      await page.locator('#preview-drawer.open').waitFor();
      assert.equal(await page.locator('.drawer-actions input[value="save"]').count(), 0, `${label}: custom voice can't be saved`);
      assert.equal(await page.locator('.drawer-buy-btn.bits').isDisabled(), true, `${label}: needs message`);
      await page.locator('#tts-text-input').fill('hello chat');
      assert.equal(await page.locator('.drawer-buy-btn.bits').isEnabled(), true);
      await noOverflow(page, `${label} sheet`);
      await axe(page, `${label} sheet`);
      await page.locator('.drawer-buy-btn.bits').click();
      await page.waitForFunction(() => window.bitsCalls === 1);
      await page.evaluate(() => window.completeTransaction({ transactionId: 'tts-tx' }));
      await page.waitForFunction(() => !actionInFlight);
      const ttsPurchase = state.requests.find(r => r.path.endsWith('/items/item-2/purchase'));
      assert.equal(JSON.parse(ttsPurchase.body).ttsText, 'hello chat', `${label}: message passed through`);
      await page.waitForFunction(() => !document.querySelector('#preview-drawer').classList.contains('open'));

      // Escape closes the sheet.
      await page.locator('.fx-tile[data-id="item-3"] .card-title').click();
      await page.locator('#preview-drawer.open').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#preview-drawer').classList.contains('open'));

      // Saved tab plays an owned item.
      await page.locator('.nav-tab').nth(1).click();
      await page.locator('.btn-use-item').click();
      await page.waitForFunction(() => !actionInFlight);
      assert.equal(state.requests.filter(r => r.path.endsWith('/items/item-1/redeem')).length, 1, `${label}: redeem saved`);
      await axe(page, `${label} saved`);
      await page.locator('.nav-tab').nth(2).click();
      await axe(page, `${label} settings`);
      await noOverflow(page, `${label} settings`);
      assert.deepEqual(errors, [], `client errors: ${errors}`);
      await context.close();
    }
  }

  // Without a shared Twitch ID: no saving, a clear way to share, Spanish copy from Twitch's ?language.
  {
    const { context, page, errors, setConnected } = await openStore({ file: 'panel.html', viewport: { width: 318, height: 500 }, query: '?language=es', shared: false, items: fixtureItems });
    await setConnected(true);
    assert.equal(await page.locator('.nav-tab').first().innerText(), 'Tienda', 'Spanish nav');
    assert.match(await page.locator('#fx-store-title').innerText(), /stream de FixtureChannel/);
    await page.locator('.fx-tile[data-id="item-1"] .card-title').click();
    assert.equal(await page.locator('.drawer-actions input[value="save"]').isDisabled(), true, 'save needs identity');
    assert.equal(await page.locator('.drawer-buy-btn.credits').count(), 0, 'no credits without identity');
    await page.locator('.drawer-actions .fx-link').click();
    assert.ok(await page.evaluate(() => window.idShareCalls >= 2), 'share link requests identity');
    await axe(page, 'es no-id sheet');
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    await context.close();
  }

  // Empty store says so in plain words.
  {
    const { context, page, errors } = await openStore({ file: 'mobile.html', viewport: { width: 390, height: 844 }, items: [] });
    assert.equal(await page.locator('#fx-empty-title').innerText(), 'Nothing for sale yet');
    assert.equal(await page.locator('.fx-tile').count(), 0);
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
  console.log('PASS: panel/mobile offline gating, checkout preflight race, online purchase, filters, credits double-tap, custom voice message, saved redeem, identity/Spanish, empty store, axe + overflow at 318/320/390 in dark and light, and OBS deduplication during playback/completion/reload');
} finally { await browser.close(); }
