/** DIMA-033 authenticated App utility. Run alongside the unchanged public download regression. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const axePath = require.resolve('axe-core/axe.min.js');
const base = process.env.SAAS_PREVIEW_URL?.replace(/\/$/, '');
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const downloadBase = 'https://domdimabot.hel1.your-objectstorage.com/desktop';
const appPath = '/fixture/modules/app';
const screenshotDir = process.env.SAAS_SCREENSHOT_DIR || '/tmp/dima-app-module-verification';
let groups = 0;
const pass = label => console.log(`PASS ${++groups}: ${label}`);
function manifest(version = '0.1.0') {
  const artifact = (kind, suffix) => ({ kind, file: `Dima-${version}-${suffix}`,
    url: `${downloadBase}/releases/${version}/Dima-${version}-${suffix}`, size: 65_432_100, sha256: 'a'.repeat(64) });
  return { schema: 1, version, prerelease: version.includes('-'), publishedAt: '2026-10-26T00:00:00Z', platforms: {
    'windows-x64': [artifact('installer', 'windows-x64-setup.exe'), artifact('zip', 'windows-x64.zip')],
    'linux-x86_64': [artifact('appimage', 'linux-x86_64.AppImage'), artifact('tar.gz', 'linux-x86_64.tar.gz')]
  } };
}
const browser = await chromium.launch({ headless: true });
async function setup({ width = 1280, theme = 'dark', language = 'en', managed = false, signedIn = true,
  dashboardAllowed = true, metadataReply } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
  const user = { id: managed ? '456' : '123', login: managed ? 'manager' : 'fixture', display_name: 'Fixture User' };
  const app = { name: 'Fixture User', email: 'fixture@example.invalid', language, plan_tier: 'free', actived: true,
    chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true,
    administrating: managed ? [{ channelID: '123', channelName: 'fixture' }] : [] };
  await context.addInitScript(({ user, app, theme, language, signedIn }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language);
    if (signedIn) localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app, theme, language, signedIn });
  await context.routeWebSocket(/.*/, socket => socket.close());
  const metadataCalls = [], apiCalls = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.href.startsWith(downloadBase)) {
      assert.equal(request.headers()['authorization'], undefined, 'metadata never receives session bearer token');
      metadataCalls.push(url.pathname);
      return metadataReply ? metadataReply(route, url, metadataCalls.length) : route.fulfill({ json: manifest(url.pathname.endsWith('latest-beta.json') ? '0.2.0-beta.1' : '0.1.0') });
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    apiCalls.push(url.pathname + url.search);
    assert.equal(request.method(), 'GET', 'utility navigation never mutates the API');
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname === '/users') data = { id: '123', username: 'fixture' };
    else if (url.pathname.endsWith('/access') && !url.pathname.startsWith('/auth/')) data = { allowed: dashboardAllowed, role: managed ? 'admin' : 'owner', planTier: 'free' };
    else if (url.pathname.startsWith('/auth/access/')) {
      const allowed = permission => !managed || permission === 'dashboard:view';
      const permissions = Object.fromEntries((url.searchParams.get('permissions') || '').split(',').filter(Boolean).map(p => [p, allowed(p)]));
      data = { allowed: allowed(url.searchParams.get('permission')), role: managed ? 'admin' : 'owner', permissions };
    } else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    else if (url.pathname.startsWith('/eventsubs/') || url.pathname.startsWith('/rewards/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  return { context, page, metadataCalls, apiCalls, errors };
}
async function openApp(page) {
  await page.goto(base + appPath);
  await page.locator('app-desktop-module').waitFor();
}
async function ready(page) { await page.locator('app-desktop-module [data-kind="installer"]').waitFor(); }
async function assertEmbedded(page) {
  assert.equal(new URL(page.url()).pathname, appPath);
  assert.equal(await page.locator('.auth-layout__content app-desktop-module app-dima-app-downloads').count(), 1);
  assert.equal(await page.locator('app-dima-app-downloads .lf-nav, app-dima-app-downloads footer').count(), 0, 'shell owns chrome');
  assert.equal(await page.locator('main main, .auth-layout__content [role="main"]').count(), 0, 'one main landmark');
  assert.equal(await page.locator('app-dima-app-downloads .lf').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('app-desktop-module h1').innerText(), 'App');
}
async function formats(page, version) {
  const anchors = page.locator('app-dima-app-downloads a[data-kind]');
  assert.equal(await anchors.count(), 4);
  assert.deepEqual((await anchors.evaluateAll(links => links.map(a => a.dataset.kind))).sort(), ['appimage', 'installer', 'tar.gz', 'zip']);
  for (const link of await anchors.all()) assert.ok((await link.getAttribute('href')).startsWith(`${downloadBase}/releases/${version}/`));
}
async function accessibility(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await axe.run(document.querySelector('app-dima-app-downloads'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
  assert.deepEqual(violations, []);
}
try {
  for (const language of ['en', 'es']) for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page, metadataCalls, errors } = await setup({ width, theme, language });
    await openApp(page); await ready(page); await assertEmbedded(page); await formats(page, '0.1.0');
    assert.equal(metadataCalls.length, 1, 'one fetch per mounted route');
    await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
    await page.getByRole('link', { name: language === 'es' ? /Descargar instalador de Windows/ : /Download Windows installer/ }).waitFor();
    await accessibility(page);
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/app-${width}-${theme}-${language}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Beta', exact: true }).click();
    await page.getByText(`${language === 'es' ? 'Versión' : 'Version'} 0.2.0-beta.1`, { exact: true }).waitFor();
    await formats(page, '0.2.0-beta.1'); assert.equal(metadataCalls.length, 2);
    assert.deepEqual(errors, []); await context.close();
    pass(`embedded approved formats/channels, token isolation, axe/overflow ${width} ${theme} ${language}`);
  }
  {
    const { context, page, metadataCalls } = await setup();
    await page.goto(base + '/fixture/modules');
    const card = page.locator('app-modules-page a[href="/fixture/modules/app"]');
    await card.first().waitFor();
    assert.equal(await card.first().locator('.lf-mod__name').innerText(), 'App');
    assert.equal(metadataCalls.length, 0, 'hub does not fetch download metadata');
    await card.first().click(); await ready(page); await assertEmbedded(page); assert.equal(metadataCalls.length, 1);
    await page.reload(); await ready(page); await assertEmbedded(page); assert.equal(metadataCalls.length, 2, 'reload accepts route whitelist');
    await page.locator('.module-back').click(); await page.waitForURL('**/fixture/modules');
    assert.equal(metadataCalls.length, 2, 'leaving route causes no further requests');
    await page.goto(base + '/download'); await page.locator('a[data-kind="installer"]').waitFor();
    await formats(page, '0.1.0'); assert.equal(await page.locator('app-desktop-module').count(), 0);
    assert.equal(await page.locator('app-dima-app-downloads .lf-nav').count(), 1, 'public page keeps its chrome');
    await context.close(); pass('App hub navigation, deep link/reload, lifecycle fetch count and public route retained');
  }
  {
    const { context, page, apiCalls } = await setup({ managed: true });
    await page.goto(base + '/fixture/modules');
    await page.locator('app-modules-page a[href="/fixture/modules/app"]').first().waitFor();
    for (const module of ['pet', 'overlays', 'tts', 'moderation', 'roulette']) {
      assert.equal(await page.locator(`app-modules-page [href="/fixture/modules/${module}"]`).count(), 0, `${module} permissions preserved`);
    }
    await page.locator('app-modules-page a[href="/fixture/modules/app"]').first().click();
    await ready(page); await assertEmbedded(page);
    assert.equal(apiCalls.some(url => /permission=app|permission=pet/.test(url)), false);
    await page.goto(base + '/fixture/modules/tts'); await page.waitForURL(/\/403/);
    await context.close(); pass('managed dashboard-authorized utility visible/free while owner-only and denied modules stay denied');
  }
  for (const scenario of [{ signedIn: false }, { managed: true, dashboardAllowed: false }]) {
    const { context, page, metadataCalls } = await setup(scenario);
    await page.goto(base + appPath);
    await page.waitForURL(scenario.signedIn === false ? /\/login/ : /\/403/);
    assert.equal(await page.locator('app-desktop-module').count(), 0); assert.equal(metadataCalls.length, 0);
    await context.close(); pass(scenario.signedIn === false ? 'signed-out App route denied' : 'unauthorized channel parent guard preserved');
  }
  {
    let mode = 'error';
    const { context, page } = await setup({ metadataReply: route => mode === 'error' ? route.abort('failed') : mode === 'invalid' ? route.fulfill({ json: { schema: 99 } }) : route.fulfill({ json: manifest() }) });
    await openApp(page); await page.getByText('We could not load downloads', { exact: true }).waitFor();
    assert.equal(await page.locator('a[data-kind]').count(), 0);
    mode = 'invalid'; await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByText('Download information could not be verified', { exact: true }).waitFor();
    mode = 'success'; await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
    await context.close(); pass('embedded network/invalid states hide links and manual retry recovers');
  }
  {
    const held = [];
    const { context, page, metadataCalls } = await setup({ metadataReply: (route, url) => url.pathname.endsWith('latest-beta.json')
      ? route.fulfill({ json: manifest('0.2.0-beta.1') }) : new Promise(resolve => held.push({ route, resolve })) });
    await openApp(page); await page.getByText('Checking available downloads…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Beta', exact: true }).click();
    await page.getByText('Version 0.2.0-beta.1', { exact: true }).waitFor();
    for (const item of held) { try { await item.route.fulfill({ json: manifest() }); } catch {} item.resolve(); }
    await page.getByText('Version 0.2.0-beta.1', { exact: true }).waitFor();
    assert.equal(metadataCalls.length, 2);
    await page.locator('.module-back').click(); await page.waitForURL('**/fixture/modules');
    await context.close(); pass('embedded loading/channel cancellation ignores stale response and releases route');
  }
  {
    const held = [];
    const { context, page, metadataCalls } = await setup({ metadataReply: route => new Promise(resolve => held.push({ route, resolve })) });
    await openApp(page); await page.getByText('Checking available downloads…', { exact: true }).waitFor();
    await page.locator('.module-back').click(); await page.waitForURL('**/fixture/modules');
    for (const item of held) { try { await item.route.fulfill({ json: manifest() }); } catch {} item.resolve(); }
    assert.equal(await page.locator('app-desktop-module').count(), 0);
    assert.equal(await page.locator('a[data-kind]').count(), 0);
    assert.equal(metadataCalls.length, 1);
    await context.close(); pass('leaving embedded route while loading cancels metadata without populating hub');
  }
  {
    const { context, page } = await setup(); await openApp(page); await ready(page);
    await page.locator('.auth-navbar__avatar-btn').click();
    await page.getByRole('menuitem', { name: 'Light', exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    await page.locator('.auth-navbar__avatar-btn').click();
    await page.getByRole('menuitem', { name: 'EN', exact: true }).click();
    await page.getByRole('link', { name: /Descargar instalador de Windows/ }).waitFor();
    assert.equal(await page.locator('app-desktop-module h1').innerText(), 'App');
    await context.close(); pass('authenticated shell alone controls embedded theme/language');
  }
} finally { await browser.close(); }
console.log(`All ${groups} authenticated App groups passed.`);
