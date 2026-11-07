// Client tests use a loopback copy, mocked Twitch checkout and mocked API only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright').catch(() => import('/tmp/saas-visual-check/node_modules/playwright/index.mjs'));
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_DIMAFX_PREVIEW_URL;
assert.ok(base, 'SAAS_DIMAFX_PREVIEW_URL required');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const day = 86400000;
// Twitch's hosted-extension CSP (dev.twitch.tv/docs/extensions/life-cycle, "CSP for Reference"), plus 'self' for this loopback copy.
const TWITCH_CSP = [
  "default-src 'self'", "script-src 'self' https://extension-files.twitch.tv", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com", 'img-src * data: blob:', 'media-src * data: blob:', "connect-src 'self' https: wss:",
].join('; ');
async function axe(page, label) {
  // Evaluated rather than injected as a <script>, which the Twitch CSP (correctly) blocks.
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(await fs.readFile(axePath, 'utf8'));
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target).slice(0, 3) })), [], `axe ${label}`);
}
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no viewport overflow: ${label}`);
}
async function openStore({ file, viewport, query = '', theme = 'dark', shared = true, config = { quickPurchasePriority: 'bits_first', quickPurchaseAction: 'use_now' }, balance = 10, items, owned = [], bits = true, catalog = null, userId = 'U-fixture-viewer', setup = null }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const state = { connected: false, shared, requests: [], purchaseStatus: 200 };
  const inventory = { balance, items: owned, config };
  if (setup) await context.addInitScript(setup);
  await context.addInitScript(({ theme, bits, catalog }) => {
    window.bitsCalls = 0;
    window.idShareCalls = 0;
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.cspViolations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
    window.Twitch = { ext: { actions: { requestIdShare() { window.idShareCalls++; } }, onAuthorized(fn) { window.authorize = fn; },
      onContext(fn) { window.setContext = fn; setTimeout(() => fn({ theme }, ['theme'])); }, onVisibilityChanged(fn) { window.setVisible = fn; },
      features: { isBitsEnabled: bits, onChanged(fn) { window.featuresChanged = fn; } }, bits: {
      useBits(sku) { window.bitsCalls++; window.lastSku = sku; }, onTransactionComplete(fn) { window.completeTransaction = fn; }, onTransactionCancelled(fn) { window.cancelTransaction = fn; },
      ...(catalog ? { getProducts: () => Promise.resolve(catalog) } : {}),
    } } };
    // A Twitch transaction for the current viewer, with the receipt the server verifies.
    window.tx = (id, extra = {}) => ({ transactionID: id, transactionReceipt: `receipt.${id}.sig`, initiator: 'current_user', ...extra });
  }, { theme, bits, catalog });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/')) {
      state.requests.push({ path: url.pathname, method: route.request().method(), body: route.request().postData() });
      let data = {};
      if (url.pathname.endsWith('/overlay-status')) data = { connected: state.connected };
      else if (url.pathname.endsWith('/tts-check')) data = state.ttsVerdict || { allowed: true };
      else if (url.pathname.endsWith('/me')) data = state.shared ? { identityShared: true, inventory } : { identityShared: false, inventory: null };
      else if (url.pathname.endsWith('/items')) data = items;
      else if (url.pathname.endsWith('/purchase') && state.purchaseStatus !== 200) {
        return route.fulfill({ status: state.purchaseStatus, contentType: 'application/json', body: JSON.stringify({ error: true, status: state.purchaseStatus, message: 'Fixture failure' }) });
      } else if (url.pathname.endsWith('/purchase') || url.pathname.endsWith('/use-credit') || url.pathname.endsWith('/redeem')) data = (url.pathname.endsWith('/purchase') && state.purchaseData) || { queued: true };
      if (url.pathname.endsWith('/me') && state.holdNextMe) {
        state.holdNextMe = false;
        await new Promise(resolve => { state.releaseMe = resolve; });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: false, data }) });
    }
    if (url.origin === new URL(base).origin && !url.pathname.startsWith('/assets/')) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': TWITCH_CSP } });
    }
    if (url.pathname.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64') });
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/${file}${query}`);
  await page.waitForFunction(() => typeof window.authorize === 'function');
  await page.evaluate((userId) => window.authorize({ token: 'fixture', channelId: '999983', userId }), userId);
  await page.locator('.price-btn, #empty-state:not([hidden])').first().waitFor();
  await page.waitForFunction(() => overlayChecked);
  const setConnected = async (value) => { state.connected = value; await page.evaluate(() => refreshOverlayStatus()); };
  const setShared = async (value) => { state.shared = value; await page.evaluate(() => refreshMe()); };
  return { context, page, state, errors, setConnected, setShared };
}
const fixtureItems = [
  { id: 'item-1', name: 'Fixture audio', category: 'audio', bitsPrice: 5, sku: 'bits5', description: 'Test purchase', mediaType: 'audio', durationMs: 1000, channelName: 'FixtureChannel', createdAt: new Date(Date.now() - day).toISOString() },
  { id: 'item-2', name: 'Fixture voice', category: 'tts', bitsPrice: 20, sku: 'bits20', description: 'Say anything', mediaType: 'audio', tts: { mode: 'custom' }, channelName: 'FixtureChannel' },
  { id: 'item-3', name: 'Fixture image', category: 'gif', bitsPrice: 0, sku: 'dimafx_free', description: 'Free one', mediaType: 'gif', thumbnailUrl: 'https://fixture.test/thumb.png', mediaUrl: 'https://fixture.test/thumb.png', channelName: 'FixtureChannel' },
];
try {
  // Purchase gating and checkout preflight on both entry points (the original contract).
  for (const [file, viewport] of [['panel.html', { width: 318, height: 500 }], ['mobile.html', { width: 390, height: 844 }]]) {
    const { context, page, state, errors, setConnected } = await openStore({ file, viewport, items: fixtureItems.slice(0, 1) });
    assert.equal(await page.locator('.price-btn').isDisabled(), true, 'offline card purchase disabled');
    assert.match(await page.locator('#dimafx-connection-status').innerText(), /paused.*FixtureChannel.*no bits will be used/i, 'offline status explains consequence');
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
    // Another viewer's broadcast transaction must not complete this viewer's checkout.
    await page.evaluate(() => window.completeTransaction(window.tx('someone-else', { initiator: 'other' })));
    assert.equal(state.requests.filter(r => r.path.endsWith('/purchase')).length, 0, 'other viewer transaction ignored');
    await page.evaluate(() => window.completeTransaction(window.tx('fixture-tx')));
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(state.requests.filter(r => r.path.endsWith('/purchase')).length, 1, 'online purchase completes once');
    const paid = JSON.parse(state.requests.find(r => r.path.endsWith('/purchase')).body);
    assert.equal(paid.transactionID, 'fixture-tx', 'Twitch transactionID passed through');
    assert.equal(paid.transactionReceipt, 'receipt.fixture-tx.sig', 'signed receipt passed through');
    assert.equal(await page.evaluate(() => window.idShareCalls), 0, 'no identity prompt without a tap');
    await noOverflow(page, file);
    await page.screenshot({ path: `/tmp/dimafx-${file}.png` });
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
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
      assert.match(await creditsBtn.innerText(), /Use 5\?/, `${label}: credits confirm step`);
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
      await page.evaluate(() => window.completeTransaction(window.tx('tts-tx')));
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
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
      await context.close();
    }
  }

  // Without a shared Twitch ID: no saving, a clear way to share, Spanish copy from Twitch's ?language.
  {
    const { context, page, errors, setConnected } = await openStore({ file: 'panel.html', viewport: { width: 318, height: 500 }, query: '?language=es', shared: false, items: fixtureItems });
    await setConnected(true);
    assert.equal(await page.locator('.nav-tab').first().innerText(), 'Efectos', 'Spanish nav');
    assert.equal(await page.locator('.nav-tab').nth(2).innerText(), 'Configuración', 'es-MX settings label');
    assert.match(await page.locator('#fx-store-title').innerText(), /stream de FixtureChannel/);
    await page.locator('.fx-tile[data-id="item-1"] .card-title').click();
    assert.equal(await page.locator('.drawer-actions input[value="save"]').isDisabled(), true, 'save needs identity');
    assert.equal(await page.locator('.drawer-buy-btn.credits').count(), 0, 'no credits without identity');
    await page.locator('.drawer-actions .fx-link').click();
    assert.ok(await page.evaluate(() => window.idShareCalls >= 1), 'share link requests identity');
    await axe(page, 'es no-id sheet');
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Custom content requires identity; normal and streamer-written voice items stay available.
  for (const theme of ['dark', 'light']) {
    for (const [file, viewport] of [['panel.html', { width: 318, height: 500 }], ['mobile.html', { width: 320, height: 640 }], ['mobile.html', { width: 390, height: 844 }]]) {
      const label = `${file}@${viewport.width} ${theme} no-id custom`;
      const fixed = { ...fixtureItems[1], id: 'fixed-voice', name: 'Streamer message', tts: { mode: 'fixed', text: 'Chosen by the streamer' } };
      const freeCustom = { ...fixtureItems[1], id: 'custom-free', bitsPrice: 0, sku: 'dimafx_free' };
      const missingMode = { ...fixtureItems[1], id: 'legacy-voice', tts: null };
      const { context, page, state, errors, setConnected, setShared } = await openStore({
        file, viewport, theme, shared: false, query: '?language=es', items: [...fixtureItems, fixed, freeCustom, missingMode],
      });
      await setConnected(true);
      await page.locator('.fx-tile[data-id="item-2"] .price-btn').click();
      await page.locator('#preview-drawer.open').waitFor();
      assert.equal(await page.locator('#tts-input-wrap').isHidden(), true, `${label}: custom input hidden`);
      assert.equal(await page.locator('#tts-text-input').isDisabled(), true, `${label}: custom input disabled`);
      assert.equal(await page.locator('.drawer-buy-btn').count(), 0, `${label}: no custom payment button`);
      assert.match(await page.locator('.drawer-actions').innerText(), /Comparte tu ID.*contenido propio/, `${label}: localized restriction`);
      await page.locator('.drawer-actions button').click();
      assert.ok(await page.evaluate(() => window.idShareCalls >= 1), `${label}: share prompt works`);
      await noOverflow(page, label);
      await axe(page, label);
      await page.screenshot({ path: `/tmp/dimafx-identity-${file}-${viewport.width}-${theme}.png` });

      // Direct callers and stale payment callbacks must not bypass the sheet.
      await page.evaluate(async () => {
        const item = products.find(item => item.id === 'item-2');
        document.getElementById('tts-text-input').value = 'unshared input';
        await buyWithBits(item, 'use_now');
        await buyWithCredits(item, 'use_now');
        await triggerFreeItem(products.find(item => item.id === 'custom-free'));
        await redeemSaved(item.id);
        await completeBitsPurchase(item, 'use_now', window.tx('stale-callback'), 'unshared input');
      });
      assert.equal(await page.evaluate(() => window.bitsCalls), 0, `${label}: no Twitch checkout`);
      // A completion callback means Bits were already used: its receipt is still sent (the server makes it good),
      // but the unshared viewer's text never leaves the device.
      const directPosts = state.requests.filter(r => r.method === 'POST' && !r.path.endsWith('/tts-check'));
      assert.equal(directPosts.length, 1, `${label}: only the paid completion is sent`);
      assert.equal(JSON.parse(directPosts[0].body).ttsText, undefined, `${label}: no unshared text`);
      assert.equal(JSON.parse(directPosts[0].body).transactionReceipt, 'receipt.stale-callback.sig', `${label}: receipt kept`);
      state.requests.length = 0;
      assert.equal(await page.evaluate(() => actionInFlight), false, `${label}: rejected callback releases action`);

      // An identity opt-in updates an already open sheet and permits custom TTS.
      // (The paid completion above closed the sheet, as any successful completion does; reopen it.)
      await page.waitForFunction(() => document.querySelector('#preview-drawer').hidden);
      await page.evaluate(() => openDrawerById('item-2'));
      await page.locator('#preview-drawer.open').waitFor();
      await setShared(true);
      assert.equal(await page.locator('#tts-input-wrap').isVisible(), true, `${label}: opt-in unlocks current sheet`);
      await page.locator('#tts-text-input').fill('shared message');
      await page.locator('.drawer-buy-btn.bits').click();
      await page.waitForFunction(() => window.bitsCalls === 1);
      // Revoke identity during Twitch checkout; completion cannot submit the captured message.
      await setShared(false);
      assert.equal(await page.locator('#tts-input-wrap').isHidden(), true, `${label}: revocation hides input`);
      assert.equal(await page.locator('#tts-text-input').inputValue(), '', `${label}: revocation clears draft`);
      await page.evaluate(() => window.completeTransaction(window.tx('revoked-checkout')));
      await page.waitForFunction(() => !actionInFlight);
      const revoked = state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/purchase'));
      assert.equal(revoked.length, 1, `${label}: paid receipt is never dropped`);
      assert.equal(JSON.parse(revoked[0].body).ttsText, undefined, `${label}: revoked identity sends no text`);
      state.requests.length = 0;

      await page.evaluate(() => closeDrawer());
      for (const id of ['custom-free', 'legacy-voice']) {
        await page.evaluate(id => openDrawerById(id), id);
        assert.equal(await page.locator('#tts-input-wrap').isHidden(), true, `${label}: ${id} no input`);
        assert.equal(await page.locator('.drawer-buy-btn').count(), 0, `${label}: ${id} no checkout`);
      }
      await page.evaluate(() => closeDrawer());
      // Fixed TTS can be purchased without identity, and carries no viewer text.
      await page.evaluate(() => openDrawerById('fixed-voice'));
      assert.equal(await page.locator('#tts-input-wrap').isHidden(), true, `${label}: fixed voice has no editor`);
      assert.equal(await page.locator('.drawer-buy-btn.bits').isEnabled(), true, `${label}: fixed voice allowed`);
      await page.locator('.drawer-buy-btn.bits').click();
      await page.waitForFunction(() => window.bitsCalls === 2);
      await page.evaluate(() => window.completeTransaction(window.tx('fixed-voice')));
      await page.waitForFunction(() => !actionInFlight);
      const fixedPurchase = state.requests.find(r => r.path.endsWith('/fixed-voice/purchase'));
      assert.ok(fixedPurchase, `${label}: fixed voice fulfilled`);
      assert.equal(JSON.parse(fixedPurchase.body).ttsText, undefined, `${label}: no text override on fixed TTS`);
      await page.evaluate(() => triggerFreeItem(products.find(item => item.id === 'item-3')));
      assert.ok(state.requests.find(r => r.path.endsWith('/item-3/purchase')), `${label}: normal free item allowed`);
      assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
      await context.close();
    }
  }

  // A response issued under an older Twitch authorization cannot restore revoked identity.
  {
    const { context, page, state, errors, setConnected } = await openStore({
      file: 'panel.html', viewport: { width: 318, height: 500 }, items: fixtureItems, shared: true,
    });
    await setConnected(true);
    await page.evaluate(() => openDrawerById('item-2'));
    await page.locator('#tts-text-input').fill('old identity draft');
    for (const request of ['refreshMe', 'loadStore']) {
      state.shared = true;
      await page.evaluate(() => refreshMe());
      state.holdNextMe = true;
      await page.evaluate(request => { window.oldIdentityRequest = window[request](); }, request);
      // The mock holds exactly the first /me response after it captured shared=true.
      for (let attempts = 0; !state.releaseMe && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(typeof state.releaseMe, 'function', `${request}: fixture captured the old response`);
      state.shared = false;
      await page.evaluate(request => window.authorize({ token: `revoked-${request}`, channelId: '999983' }), request);
      state.releaseMe();
      state.releaseMe = null;
      await page.evaluate(() => window.oldIdentityRequest);
      assert.equal(await page.evaluate(() => identityShared), false, `${request}: old response cannot restore identity`);
      assert.equal(await page.locator('#tts-input-wrap').isHidden(), true, `${request}: custom input stays hidden`);
      assert.equal(await page.locator('.drawer-buy-btn').count(), 0, `${request}: custom checkout stays blocked`);
    }
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Empty store says so in plain words.
  {
    const { context, page, errors } = await openStore({ file: 'mobile.html', viewport: { width: 390, height: 844 }, items: [] });
    assert.equal(await page.locator('#fx-empty-title').innerText(), 'Nothing here yet');
    assert.equal(await page.locator('.fx-tile').count(), 0);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }


  // Bits turned off for the channel (Twitch: checking isBitsEnabled is mandatory): free items and credits only.
  for (const [file, viewport] of [['panel.html', { width: 318, height: 500 }], ['mobile.html', { width: 390, height: 844 }]]) {
    const { context, page, state, errors, setConnected } = await openStore({ file, viewport, bits: false, items: fixtureItems, balance: 0 });
    await setConnected(true);
    assert.match(await page.locator('#dimafx-connection-status').innerText(), /Bits aren't turned on/, `${file}: explains Bits are off`);
    const paidBtn = page.locator('.fx-tile[data-id="item-1"] .price-btn');
    assert.equal(await paidBtn.isDisabled(), true, `${file}: paid item can't start checkout`);
    assert.match(await paidBtn.innerText(), /Bits off/);
    await page.locator('.fx-tile[data-id="item-1"] .card-title').click();
    assert.equal(await page.locator('.drawer-buy-btn.bits').count(), 0, `${file}: no Bits button in sheet`);
    assert.match(await page.locator('.drawer-actions').innerText(), /Bits aren't available/);
    await page.evaluate(() => closeDrawer());
    await page.locator('.fx-tile[data-id="item-3"] .price-btn').click();
    await page.waitForFunction(() => !actionInFlight);
    assert.ok(state.requests.find(r => r.path.endsWith('/item-3/purchase')), `${file}: free item still plays`);
    // Twitch can turn Bits on while the panel is open.
    await page.evaluate(() => { window.Twitch.ext.features.isBitsEnabled = true; window.featuresChanged(['isBitsEnabled']); });
    assert.equal(await paidBtn.isEnabled(), true, `${file}: Bits re-enabled live`);
    assert.equal(await page.evaluate(() => window.bitsCalls), 0);
    await axe(page, `${file} bits off`);
    await noOverflow(page, `${file} bits off`);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Twitch's catalog decides: an item whose SKU is missing or costs a different amount can't start checkout.
  {
    // bits5 is a Twitch test product, which may report 0 Bits; bits20 is live but priced differently from the item.
    const catalog = [{ sku: 'bits5', cost: { amount: 0, type: 'bits' }, inDevelopment: true }, { sku: 'bits20', cost: { amount: 25, type: 'bits' } }];
    const { context, page, errors, setConnected } = await openStore({ file: 'panel.html', viewport: { width: 318, height: 500 }, items: fixtureItems, catalog, balance: 0 });
    await setConnected(true);
    await page.waitForFunction(() => bitsCatalog instanceof Map);
    assert.equal(await page.locator('.fx-tile[data-id="item-1"] .price-btn').isEnabled(), true, 'test product with 0-Bit cost still matches its SKU tier');
    await page.evaluate(() => openDrawerById('item-2'));
    await page.locator('#tts-text-input').fill('hello');
    assert.equal(await page.locator('.drawer-buy-btn.bits').count(), 0, 'cost mismatch hides Bits checkout');
    await page.evaluate(() => buyWithBits(products.find(item => item.id === 'item-2'), 'use_now'));
    assert.equal(await page.evaluate(() => window.bitsCalls), 0, 'direct call cannot charge a mismatched SKU');
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // A catalog Twitch can't load hides Bits checkout (and retries) instead of offering an unverified SKU.
  {
    const { context, page, errors, setConnected } = await openStore({ file: 'panel.html', viewport: { width: 318, height: 500 }, items: fixtureItems.slice(0, 1), balance: 0,
      setup: () => { window.catalogCalls = 0; Object.defineProperty(window, 'Twitch', { configurable: true, set(value) { value.ext.bits.getProducts = () => { window.catalogCalls++; return Promise.reject(new Error('rig')); }; Object.defineProperty(window, 'Twitch', { value, configurable: true, writable: true }); } }); } });
    await setConnected(true);
    await page.waitForFunction(() => window.catalogCalls >= 1 && bitsCatalog instanceof Map);
    assert.equal(await page.locator('.fx-tile[data-id="item-1"] .price-btn').isDisabled(), true, 'unknown catalog hides Bits');
    assert.match(await page.locator('.fx-tile[data-id="item-1"] .price-btn').innerText(), /Bits off/);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    await context.close();
  }

  // A paid completion that can't reach the server is kept and resumed; the viewer is told the Bits went through.
  {
    const { context, page, state, errors, setConnected } = await openStore({ file: 'panel.html', viewport: { width: 318, height: 500 }, items: fixtureItems.slice(0, 1) });
    await setConnected(true);
    state.purchaseStatus = 503;
    await page.locator('.fx-tile[data-id="item-1"] .price-btn').click();
    await page.waitForFunction(() => window.bitsCalls === 1);
    await page.evaluate(() => window.completeTransaction(window.tx('flaky-tx')));
    await page.waitForFunction(() => !actionInFlight, null, { timeout: 15000 });
    assert.equal(state.requests.filter(r => r.path.endsWith('/purchase')).length, 3, 'retries a server failure');
    assert.match(await page.locator('.toast-title').innerText(), /Still confirming/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dimafx-pending-bits'))[0].body.transactionID), 'flaky-tx', 'kept on this device');
    state.purchaseStatus = 200;
    await page.reload();
    await page.waitForFunction(() => typeof window.authorize === 'function');
    await page.evaluate(() => window.authorize({ token: 'fixture', channelId: '999983', userId: 'U-fixture-viewer' }));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('dimafx-pending-bits') || '[]').length === 0);
    assert.equal(state.requests.filter(r => r.path.endsWith('/purchase')).length, 4, 'resumed once after reopening');
    // A final server answer (4xx) is not retried forever.
    state.purchaseStatus = 409;
    await page.evaluate(() => { pendingBitsPurchase = null; });
    await page.locator('.fx-tile[data-id="item-1"] .price-btn').click();
    await page.waitForFunction(() => window.bitsCalls === 1);
    await page.evaluate(() => window.completeTransaction(window.tx('duplicate-tx')));
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dimafx-pending-bits') || '[]').length), 0, 'final answer clears the entry');
    assert.match(await page.locator('#toast-desc').innerText(), /isn't available right now/, 'localized server reason, not English internals');
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Logged-out viewers (opaque ID "A…"): told to log in, Bits checkout still possible (Twitch prompts login), no share prompts.
  for (const theme of ['dark', 'light']) {
    const { context, page, state, errors, setConnected } = await openStore({ file: 'mobile.html', viewport: { width: 320, height: 640 }, theme, shared: false, userId: 'A-anonymous', items: fixtureItems });
    await setConnected(true);
    assert.match(await page.locator('#dimafx-connection-status').innerText(), /Log in to Twitch/);
    assert.equal(await page.locator('.fx-tile[data-id="item-3"] .price-btn').isDisabled(), true, 'free item needs login');
    assert.match(await page.locator('.fx-tile[data-id="item-3"] .price-btn').innerText(), /Log in/);
    assert.equal(await page.locator('.fx-tile[data-id="item-1"] .price-btn').isEnabled(), true, 'Bits checkout available');
    await page.evaluate(() => triggerFreeItem(products.find(item => item.id === 'item-3')));
    assert.equal(state.requests.filter(r => r.method === 'POST' && !r.path.endsWith('/tts-check')).length, 0, 'no anonymous free plays');
    await page.locator('.nav-tab').nth(1).click();
    assert.equal(await page.locator('#inventory-list [data-action="share"]').count(), 0, 'no share button for logged-out viewers');
    await axe(page, `logged out ${theme}`);
    await noOverflow(page, `logged out ${theme}`);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Broadcaster config view: works under the Twitch CSP, es-MX copy, off-site link is labelled and opens the DimaFX page.
  for (const [language, theme] of [['en', 'dark'], ['es', 'light']]) {
    const { context, page, errors } = await openStore({
      file: 'panel.html', viewport: { width: 390, height: 844 }, theme, items: [],
      setup: () => { window.opened = []; window.open = (...args) => { window.opened.push(args); return null; }; },
    });
    await page.goto(`${base}/config.html?language=${language}`);
    await page.waitForFunction(() => typeof window.authorize === 'function');
    await page.evaluate(() => window.authorize({ token: 'fixture', channelId: '999983', userId: 'U-streamer' }));
    await page.waitForFunction((theme) => document.documentElement.classList.contains('dark') === (theme === 'dark'), theme);
    const text = await page.locator('body').innerText();
    if (language === 'es') {
      assert.match(text, /Transmite en vivo/);
      assert.match(text, /espectadores/);
      assert.doesNotMatch(text, /directo|Añade|vídeo/i, 'no Spain Spanish');
    }
    assert.doesNotMatch(text, /\b(buy|purchase|spend|sell|price)\b/i, 'Twitch Bits wording');
    assert.match(await page.locator('#configure-note').innerText(), /domdimabot\.com/, 'off-site indicator');
    await page.locator('#configure-btn').click();
    assert.equal(await page.evaluate(() => window.opened[0][0]), 'https://domdimabot.com/999983/modules/dimafx');
    await axe(page, `config ${language}`);
    await noOverflow(page, `config ${language}`);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Viewer copy avoids the words Twitch bans for Bits (guideline 6.5), in both languages.
  {
    const strings = await (async () => {
      const { context, page } = await openStore({ file: 'panel.html', viewport: { width: 318, height: 500 }, items: [] });
      const value = await page.evaluate(() => STRINGS);
      await context.close();
      return value;
    })();
    // Placeholders such as {price} are variable names, not copy.
    const copy = (value) => value.replace(/\{\w+\}/g, '');
    for (const [key, value] of Object.entries(strings.en)) assert.doesNotMatch(copy(value), /\b(buy|buying|purchases?|spend|sell|sale|price|cost|pay)\b/i, `en ${key}`);
    for (const [key, value] of Object.entries(strings.es)) {
      assert.doesNotMatch(copy(value), /\b(compr\w*|gast\w*|vend\w*|precio|pag(a|ar|o|aste|ues))\b/i, `es ${key}`);
      assert.doesNotMatch(copy(value), /\b(vídeo|directo|añad\w*|ajustes|ordenador|móvil)\b/i, `es-MX ${key}`);
    }
  }


  // Preview sound is off until the viewer turns it on (guideline 2.4), and the choice is remembered.
  {
    const items = [{ ...fixtureItems[0], mediaUrl: 'https://fixture.test/airhorn.mp3' }];
    const { context, page, errors, setConnected } = await openStore({ file: 'mobile.html', viewport: { width: 390, height: 844 }, items });
    await setConnected(true);
    assert.equal(await page.locator('#preview-volume').inputValue(), '0', 'preview volume starts off');
    await page.locator('.fx-tile[data-id="item-1"] .card-title').click();
    assert.equal(await page.locator('#player-sound').getAttribute('aria-pressed'), 'false', 'speaker shows muted');
    await page.locator('#player-play').click();
    assert.equal(await page.evaluate(() => previewPlayer.muted), true, 'muted preview plays silently');
    await page.locator('#player-sound').click();
    assert.equal(await page.locator('#player-sound').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => previewPlayer.muted), false, 'speaker unmutes the playing preview');
    assert.equal(await page.evaluate(() => localStorage.getItem('dimafx-preview-volume')), '60');
    await axe(page, 'preview sound');
    await page.reload();
    await page.waitForFunction(() => typeof window.authorize === 'function');
    assert.equal(await page.locator('#preview-volume').inputValue(), '60', 'choice remembered');
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }

  // Phones: the custom-voice box stays above the keyboard; a token refresh keeps the draft; make-goods are explained.
  {
    const { context, page, state, errors, setConnected } = await openStore({ file: 'mobile.html', viewport: { width: 390, height: 844 }, items: fixtureItems, balance: 0 });
    await setConnected(true);
    await page.evaluate(() => openDrawerById('item-2'));
    await page.locator('#tts-text-input').fill('keep this message');
    await page.evaluate(() => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height: 500, offsetTop: 0, addEventListener() {} } });
      syncKeyboardInset();
    });
    await page.waitForTimeout(350);
    const box = await page.locator('#tts-text-input').boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 500, `message box above keyboard: ${JSON.stringify(box)}`);
    assert.ok(await page.locator('.drawer-buy-btn.bits').boundingBox().then(b => b && b.y + b.height <= 500), 'pay button above keyboard');
    await page.evaluate(() => { delete window.visualViewport; document.documentElement.style.removeProperty('--kb'); document.body.classList.remove('fx--kb'); });
    // Twitch refreshes the token every few minutes; the same viewer's draft survives it.
    await page.evaluate(() => window.authorize({ token: 'refreshed', channelId: '999983', userId: 'U-fixture-viewer' }));
    await page.waitForFunction(() => identityShared && document.getElementById('tts-text-input').value === 'keep this message');
    // A paid play the server couldn't deliver is made good, and the viewer is told how.
    state.purchaseData = { madeGood: { credits: 20 } };
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => window.bitsCalls === 1);
    await page.evaluate(() => window.completeTransaction(window.tx('made-good-tx')));
    await page.waitForFunction(() => !actionInFlight);
    assert.match(await page.locator('#toast-desc').innerText(), /couldn't play, so you got 20 credits back/);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
    await context.close();
  }


  // Viewer-typed voice messages are checked before any Bits or credits are used (GPT-6 Luna Decisions on the server).
  for (const [lang, file, viewport] of [['en', 'panel.html', { width: 318, height: 500 }], ['es', 'mobile.html', { width: 390, height: 844 }]]) {
    const { context, page, state, errors, setConnected } = await openStore({ file, viewport, query: `?language=${lang}`, items: fixtureItems, balance: 50,
      config: { quickPurchasePriority: 'bits_first', quickPurchaseAction: 'use_now' } });
    await setConnected(true);
    await page.evaluate(() => openDrawerById('item-2'));
    assert.match(await page.locator('.drawer-actions').innerText(), lang === 'en' ? /your Twitch name is shown on stream/ : /tu nombre de Twitch aparece en el stream/, `${lang}: attribution disclosed`);
    await page.locator('#tts-text-input').fill('something rude');
    state.ttsVerdict = { allowed: false, reason: 'blocked' };
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(await page.evaluate(() => window.bitsCalls), 0, `${lang}: refused text never opens checkout`);
    assert.equal(await page.locator('#tts-text-input').inputValue(), 'something rude', `${lang}: draft kept to edit`);
    assert.match(await page.locator('.drawer-actions [role="alert"]').innerText(), lang === 'en' ? /can't be played on stream/ : /no se puede reproducir en el stream/);
    const check = state.requests.find(r => r.path.endsWith('/items/item-2/tts-check'));
    assert.equal(JSON.parse(check.body).ttsText, 'something rude', `${lang}: text sent for the check`);
    await page.locator('.drawer-buy-btn.credits').click();
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(state.requests.filter(r => r.path.endsWith('/use-credit')).length, 0, `${lang}: refused text spends no credits`);
    // Editing clears the warning; a moderation outage fails closed without charging.
    await page.locator('#tts-text-input').fill('hello chat');
    assert.equal(await page.locator('.drawer-actions [role="alert"]').count(), 0, `${lang}: warning clears on edit`);
    state.ttsVerdict = { allowed: false, reason: 'unavailable' };
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => !actionInFlight);
    assert.equal(await page.evaluate(() => window.bitsCalls), 0, `${lang}: outage fails closed`);
    state.ttsVerdict = { allowed: true };
    await page.locator('.drawer-buy-btn.bits').click();
    await page.waitForFunction(() => window.bitsCalls === 1);
    // The server can still refuse after payment (cache miss or policy change): the viewer is told and made good.
    state.purchaseData = { blocked: true, madeGood: { credits: 20 } };
    await page.evaluate(() => window.completeTransaction(window.tx('blocked-after-pay')));
    await page.waitForFunction(() => !actionInFlight);
    assert.match(await page.locator('#toast-desc').innerText(), lang === 'en' ? /couldn't be played on stream, so you got 20 credits back/ : /recuperaste 20 créditos/);
    await axe(page, `${lang} moderation`);
    await noOverflow(page, `${lang} moderation`);
    assert.deepEqual(errors, [], `client errors: ${errors}`);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Twitch CSP violations');
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
  console.log('PASS: viewer-text moderation before checkout (Bits + credits, blocked/outage/after-pay), preview sound off by default + remembered speaker toggle, keyboard-safe sheet, draft kept across token refresh, make-good toast, Twitch CSP on every view, isBitsEnabled off/on, Twitch catalog SKU/cost match, receipt + transactionID passthrough, other-viewer transactions ignored, retry/resume of paid completions, logged-out viewers, config view (CSP, es-MX, off-site link), Bits wording in en/es, panel/mobile offline gating, checkout preflight race, online purchase, filters, credits double-tap, custom voice message, saved redeem, identity/Spanish, no-ID custom blocking and opt-in/revocation, fixed voice, empty store, axe + overflow at 318/320/390 in dark and light, and OBS deduplication during playback/completion/reload');
} finally { await browser.close(); }
