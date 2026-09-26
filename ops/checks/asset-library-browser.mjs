import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), errors = [];
const user = { id: '991003', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = (id, kind) => ({ id, kind, x: 20, y: 20, width: 300, height: 180, visible: true, locked: false });
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 800, height: 240, events: Object.fromEntries(['follow','bits','sub','raid'].map(kind => [kind, { duration: 5, widgets: [{ ...layer(kind, 'text'), text: '$(user)' }] }])) };
let state = { schemaVersion: 1, revision: 0, scenes: [{ id: 'main', name: 'My overlay', width: 1920, height: 1080, revision: 0, publicId, widgets: [{ ...layer('alert-1', 'alert'), designId: 'starter', events: ['follow'] }], waitFor: [] }], designs: [design] };
const art = { id: 'a'.repeat(24), name: 'Stream background.png', kind: 'image', mime: 'image/png', bytes: 240_000, width: 1920, height: 1080, createdAt: new Date().toISOString() };
let assets = [], usedBytes = 0, failList = false, deleteBlocked = false, failedUpload = false;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app }) => !localStorage.getItem('dimasite.session.v1') && localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })), { user, app });
  await context.routeWebSocket('**/*', ws => { if (ws.url().startsWith(base.replace('http', 'ws'))) ws.connectToServer(); else ws.close(); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname.startsWith('/asset-library/content/')) return route.fulfill({ body: png, contentType: 'image/png' });
    if (url.pathname === `/asset-library/${user.id}`) {
      if (request.method() === 'POST') {
        assert.match(request.headers()['content-type'], /multipart\/form-data/);
        assert.equal(request.headers().authorization, 'Bearer fixture-only');
        if (failedUpload) return route.fulfill({ status: 413, json: { error: true, code: 'quota_exceeded' } });
        assets.push(structuredClone(art)); usedBytes += art.bytes; data = art;
      } else {
        if (failList) return route.fulfill({ status: 503, json: { error: true } });
        data = { assets, usedBytes, quotaBytes: ({free:100_000_000,premium:500_000_000,pro:5_000_000_000})[app.plan_tier], maxFileBytes: 50_000_000, planTier: app.plan_tier };
      }
    } else if (url.pathname.startsWith('/asset-library/') && url.pathname.endsWith('/access')) data = { path: `/asset-library/content/${url.pathname.split('/')[3]}?ticket=fixture-scoped-ticket` };
    else if (url.pathname.startsWith('/asset-library/') && request.method() === 'DELETE') {
      if (deleteBlocked) return route.fulfill({ status: 409, json: { error: true, code: 'in_use' } });
      const id = url.pathname.split('/')[3]; usedBytes -= assets.find(a => a.id === id).bytes; assets = assets.filter(a => a.id !== id);
    } else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
    else if (url.pathname.endsWith('/preview')) data = request.postDataJSON().texts.map(t => t.replace('$(user)', 'Luna'));
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (request.method() === 'PUT') { state = request.postDataJSON(); state.revision++; }
      data = state;
    } else if (url.pathname.startsWith('/triggers/') || url.pathname.startsWith('/admins/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('.stage').waitFor();
  await page.locator('.palette-item[data-kind="image"]').click();
  const browse = page.getByRole('button', { name: 'Browse Asset Library', exact: true });
  await browse.click();
  const dialog = page.getByRole('dialog', { name: 'Asset Library', exact: true });
  await dialog.getByText('Your creative space starts here', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Use asset', exact: true }).isEnabled(), false);
  await dialog.locator('input[type=file]').setInputFiles({ name: art.name, mimeType: 'image/png', buffer: png });
  await dialog.locator('.asset').waitFor();
  assert.match(await dialog.locator('.quota').innerText(), /240 KB of 5 GB used/);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await dialog.evaluate(d => d.scrollWidth > d.clientWidth), false, `dialog overflow ${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `page overflow ${width}`);
    assert((await dialog.getByRole('button', { name: 'Use asset', exact: true }).boundingBox()).height >= 44);
  }
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    const result = await page.evaluate(() => window.axe.run(document.querySelector('app-asset-library-dialog'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], theme);
  }
  if (process.env.SAAS_SCREENSHOT_DIR) {
    await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/asset-library-desktop.png` });
    await page.setViewportSize({ width: 375, height: 850 });
    await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/asset-library-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await dialog.getByRole('searchbox', { name: 'Search assets' }).fill('missing'); await dialog.getByText('No matching assets', { exact: true }).waitFor();
  await dialog.getByRole('searchbox', { name: 'Search assets' }).fill('');
  await dialog.getByRole('button', { name: 'Use asset', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  assert.equal(await browse.evaluate(b => document.activeElement === b), true, 'focus returns to opener');
  await page.getByText('Private library asset selected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(state.scenes[0].widgets.at(-1).assetId, art.id); assert.equal(state.scenes[0].widgets.at(-1).mediaUrl, undefined); assert(!JSON.stringify(state).includes('ticket'));
  // The exact same picker can select the same asset in an alert design.
  await page.locator('.layers').getByRole('button', { name: 'Alerts', exact: true }).click();
  await page.getByRole('button', { name: 'Edit design', exact: true }).click();
  await page.locator('.palette-item[data-kind="image"]').click(); await browse.click();
  await dialog.locator('.asset').click(); await dialog.getByRole('button', { name: 'Use asset', exact: true }).click();
  await page.getByRole('button', { name: 'Save design', exact: true }).click(); await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(state.designs[0].events.follow.widgets.at(-1).assetId, art.id);
  // Loading failures, failed uploads, deletion guard and a quota-full account.
  failList = true; await browse.click(); await dialog.getByText('We could not load your assets. Try again.', { exact: false }).waitFor();
  failList = false; await dialog.getByRole('button', { name: 'Try again', exact: true }).click(); await dialog.locator('.asset').waitFor();
  failedUpload = true; await dialog.locator('input[type=file]').setInputFiles({ name: art.name, mimeType: 'image/png', buffer: png });
  await dialog.getByRole('alert').filter({ hasText: 'Your storage is full' }).waitFor();
  deleteBlocked = true; await dialog.locator('.asset').click(); await dialog.getByRole('button', { name: 'Delete asset', exact: true }).click();
  await dialog.getByRole('button', { name: 'Yes, delete permanently', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'This asset is used' }).waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  usedBytes = 5_000_000_000; await browse.click(); await dialog.locator('.asset').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Upload asset', exact: true }).isEnabled(), false);
  // Deleting an unused item requires confirmation and refreshes quota.
  deleteBlocked = false; await dialog.locator('.asset').click(); await dialog.getByRole('button', { name: 'Delete asset', exact: true }).click();
  assert.equal(assets.length, 1); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(assets.length, 1);
  await dialog.getByRole('button', { name: 'Delete asset', exact: true }).click(); await dialog.getByRole('button', { name: 'Yes, delete permanently', exact: true }).click();
  await dialog.getByText('Your creative space starts here', { exact: true }).waitFor(); assert.equal(assets.length, 0);
  await page.keyboard.press('Escape');
  // Spanish strings and focus confinement.
  await page.locator('.topbar__actions .icon-button').first().click(); await page.getByRole('button', { name: 'Explorar biblioteca de recursos' }).click();
  const spanish = page.getByRole('dialog', { name: 'Biblioteca de recursos' }); await spanish.waitFor();
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); assert(await spanish.evaluate(d => d.contains(document.activeElement)), 'native dialog traps focus: ' + JSON.stringify(await spanish.evaluate(d => ({active:document.activeElement.outerHTML.slice(0,200),open:d.open,buttons:[...d.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled}))})))); }
  assert.deepEqual(errors, []);
  console.log('PASS Asset Library UI: empty/loading/errors, multipart upload, storage meter, search, shared overlay/alert selection, persisted IDs, confirmation/in-use protection, quota limit, keyboard/focus, Spanish, 320–1440px and light/dark axe checks.');
  await page.keyboard.press('Escape');
  usedBytes = 0;
  for (const [tier, allowance] of [['free', '100 MB'], ['premium', '500 MB']]) {
    app.plan_tier = tier;
    await page.evaluate(tier => { const session = JSON.parse(localStorage.getItem('dimasite.session.v1')); session.appUser.plan_tier = tier; localStorage.setItem('dimasite.session.v1', JSON.stringify(session)); localStorage.setItem('userLanguage', 'en'); }, tier);
    await page.goto(base + '/fixture/settings');
    await page.getByRole('button', { name: 'Browse Asset Library', exact: true }).click();
    await dialog.getByText('Your creative space starts here', { exact: true }).waitFor();
    assert.match(await dialog.locator('.quota').innerText(), new RegExp(`0 KB of ${allowance} used`));
    assert.equal(await dialog.getByRole('button', { name: 'Use asset', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Upload asset', exact: true }).isEnabled(), true);
    await page.setViewportSize({ width: 375, height: 850 });
    assert.equal(await dialog.evaluate(d => d.scrollWidth > d.clientWidth), false);
    await dialog.locator('footer').getByRole('button', { name: 'Close asset library', exact: true }).click();
    if (process.env.SAAS_SCREENSHOT_DIR && tier === 'free') {
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/asset-settings-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/asset-settings-desktop.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS all-tier Settings: Free/Premium owners can manage storage through the shared modal, with the correct quotas and no design-selection action.');
  const runtime = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const snapshot = { width: 1920, height: 1080, waitFor: [], designs: [design], widgets: [{ ...layer('private-background', 'image'), assetId: art.id }, { ...layer('alert-1', 'alert'), designId: 'starter', events: ['follow'] }] };
  let socket, reads = 0;
  await runtime.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) { ws.close(); return; }
    socket = ws; ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => {
      if (String(message).startsWith('40/overlay-studio/')) {
        ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);
        ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-state', { revision: 1, snapshot }])}`);
      }
    });
  });
  await runtime.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.pathname === `/overlay-studio/public/${publicId}/assets/${art.id}`) { reads++; assert.equal(route.request().headers().authorization, undefined); return route.fulfill({ body: png, contentType: 'image/png' }); }
    if (url.pathname.endsWith('/events/asset-alert')) return route.fulfill({ json: { data: { id: 'asset-alert', kind: 'follow', snapshot, layouts: { starter: { duration: 10, widgets: [{ ...layer('alert-art', 'image'), assetId: art.id }] } } } } });
    return route.abort();
  });
  const source = await runtime.newPage(); source.on('pageerror', error => errors.push(error.message));
  await source.goto(base + '/overlays/' + publicId);
  await source.waitForFunction(() => document.querySelector('.canvas img')?.naturalWidth > 0);
  socket.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-event', { id: 'asset-alert', kind: 'follow' }])}`);
  await source.waitForFunction(() => document.querySelector('[data-event="follow"] img')?.naturalWidth > 0);
  assert(reads > 0); assert.deepEqual(errors, []);
  socket.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-revoked', {}])}`);
  await source.locator('.canvas').waitFor({ state: 'detached' });
  console.log('PASS published renderer: private asset IDs render in the canvas and live alert through the scoped OBS endpoint without owner credentials; revocation clears output.');
} finally { await browser.close(); }
