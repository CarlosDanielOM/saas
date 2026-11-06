// Real browser storage events and the application's real HTTP interceptor; every API/socket is mocked.
import { openStudio, closeStudioMenus, switchStudioScene, studioSceneId, studioToggle } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import assert from 'node:assert/strict';
import { withLive } from '/root/saas/ops/checks/overlay-studio-live-fixture.mjs';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const api = 'https://api.domdimabot.com';
const user = { id: '990191', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [{ channelID: '990192', channelName: 'otherfixture' }] };
const widget = (id, kind, x) => ({ id, kind, name: id, x, y: 30, width: 400, height: 200, visible: true, locked: false });
const widgets = [widget('Trigger alerts', 'trigger', 30), { ...widget('Image', 'image', 500), assetId: '1'.repeat(24) }];
const scene = { id: 'main', name: 'My overlay', revision: 1, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets };
scene.published = { width: scene.width, height: scene.height, widgets: structuredClone(widgets), waitFor: [], designs: [] };
const state = { schemaVersion: 1, revision: 1, scenes: [scene], designs: [] };
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [], requests = [], storageKey = 'dimasite.session.v1';
let failConnections = true, failQueue = true, delayedConnections = false, connectionActive = 0, maxConnectionActive = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(({ user, app, storageKey }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('theme', 'dark');
    window.storageEvents = 0;
    window.addEventListener('storage', () => window.storageEvents++);
  }, { user, app, storageKey });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    assert.equal(req.method(), 'GET', 'This check never mutates application data');
    requests.push({ path: url.pathname, token: req.headers().authorization });
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = url.pathname.startsWith('/asset-library/') ? { path: '/fixture-image.svg' } : { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname === '/fixture-image.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="purple"/></svg>' });
    else if (url.pathname.endsWith('/twitch-events')) return route.fulfill({ status: 502, json: { error: true, message: 'Fixture Twitch failure' } });
    else if (url.pathname.endsWith('/queue')) {
      if (failQueue) return route.fulfill({ status: 503, json: { error: true } });
      data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, events: [] };
    } else if (url.pathname.endsWith('/connections')) {
      connectionActive++; maxConnectionActive = Math.max(maxConnectionActive, connectionActive);
      try {
        if (delayedConnections) await new Promise(resolve => setTimeout(resolve, 700));
        if (failConnections) return await route.fulfill({ status: 503, json: { error: true } });
        data = { checkedAt: Date.now(), pollingFailed: false, scenes: [{ id: 'main', published: true, revision: 1, width: 1920, height: 1080, receives: ['trigger'], sources: [] }] };
        return await route.fulfill({ json: { error: false, data } });
      } finally { connectionActive--; }
    } else if (url.pathname === `/overlay-studio/${user.id}`) data = withLive(state);
    else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('.stage').waitFor();
  await page.locator('.lf-save-bar').getByText('All changes published', { exact: true }).waitFor();
  const second = await context.newPage(); second.on('pageerror', e => errors.push(e.message));
  const before = requests.length;
  await second.goto(base + '/otherfixture/modules'); await second.locator('.auth-navbar').waitFor();
  await page.waitForTimeout(2000);
  const storm = requests.slice(before).filter(r => r.path.startsWith(`/overlay-studio/${user.id}/`));
  assert(storm.length <= 4, `Opening another channel tab restarted ${storm.length} Studio requests`);
  // The module hub legitimately caches its initial permission decisions. Once
  // those finish, neither tab may keep rewriting the channel preference.
  const events = [await page.evaluate(() => window.storageEvents), await second.evaluate(() => window.storageEvents)];
  await page.waitForTimeout(300);
  assert.deepEqual([await page.evaluate(() => window.storageEvents), await second.evaluate(() => window.storageEvents)], events, 'Channel preferences settle after permission checks');
  const readCount = path => requests.filter(r => r.path.endsWith(path)).length;
  assert.equal(readCount('/twitch-events'), 1, 'A failed Twitch check is not automatically retried');
  assert.equal(readCount(`/triggers/${user.id}`), 1, 'Trigger catalog is not reloaded by another tab');
  assert.equal(readCount('/' + '1'.repeat(24) + '/access'), 1, 'Asset access is not refreshed by preference synchronization');

  // Genuine authentication metadata changes still synchronize, without becoming HTTP effect dependencies.
  const checkBefore = readCount('/twitch-events');
  await second.evaluate(key => {
    const session = JSON.parse(localStorage.getItem(key)); session.token = 'fixture-renewed'; session.twitchUser.display_name = 'Renewed Fixture';
    localStorage.setItem(key, JSON.stringify(session));
  }, storageKey);
  await page.waitForFunction(() => [document.querySelector('.auth-navbar__avatar-btn'), document.querySelector('.studio-menu-btn')].some(el => el?.getAttribute('aria-label')?.includes('Renewed Fixture')) || document.querySelector('.auth-navbar')?.textContent?.includes('Renewed Fixture'));
  await page.waitForTimeout(100);
  assert.equal(readCount('/twitch-events'), checkBefore, 'Updating a token must not replay unrelated requests');
  await openStudio(page, 'obs');
  await page.locator('app-overlay-connections details').evaluate(el => { el.open = true; });
  const refresh = page.locator('app-overlay-connections').getByRole('button', { name: 'Refresh status', exact: true });
  failConnections = false; failQueue = false; delayedConnections = true;
  await refresh.click();
  await page.waitForFunction(() => document.querySelector('app-overlay-connections button')?.disabled);
  await page.locator('app-overlay-connections').getByText('No connected sources', { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.path.endsWith('/connections')).at(-1).token, 'Bearer fixture-renewed', 'The next request uses the synchronized token');
  assert.equal(maxConnectionActive, 1, 'Slow connection checks never overlap');
  await page.locator('.lf-save-bar').getByText('All changes published', { exact: true }).waitFor();
  assert.equal(await page.getByText('Everything is live in OBS', { exact: true }).count(), 0, 'Publishing parity never claims OBS is connected');

  // Both successful and failed checks keep the bounded polling cadence, and closing the Studio stops it.
  const countsBefore = { queue: readCount('/queue'), connections: readCount('/connections') };
  await page.waitForTimeout(5500);
  assert(readCount('/queue') - countsBefore.queue <= 3, 'Queue polling stays bounded');
  assert(readCount('/connections') - countsBefore.connections <= 2, 'Connection polling waits for each response');
  assert.equal(readCount('/twitch-events'), 1, 'Twitch failures remain explicit user retries');
  if (process.env.SAAS_SCREENSHOT_DIR) {
    await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true });
    for (const dark of [true, false]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow ${width}`);
        await page.locator('.lf-save-bar').screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/published-${dark ? 'dark' : 'light'}-${width}.png` });
      }
    }
  }
  await second.evaluate(key => localStorage.removeItem(key), storageKey);
  await page.locator('.stage').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.auth-navbar__avatar-btn').getAttribute('aria-label'), 'Streamer', 'Logout clears the synchronized profile');
  await second.evaluate(({ key, user, app }) => localStorage.setItem(key, JSON.stringify({ version: 2, token: 'fixture-restored', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })), { key: storageKey, user, app });
  await page.locator('.stage').waitFor();
  await second.evaluate(() => localStorage.clear());
  await page.locator('.stage').waitFor({ state: 'detached' });
  await page.close();
  const stopped = requests.length;
  await second.waitForTimeout(5500);
  assert.equal(requests.length, stopped, 'Destroyed Studio polling stops');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS real cross-tab storage regression: different channels settle; failed/successful reads bounded; no catalog/media refetch; token sync uses new credentials without replay; logout/clear sync; disposal; published copy stays honest.');
} finally { await browser.close(); }
