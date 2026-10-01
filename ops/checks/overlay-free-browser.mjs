import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert(base);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const user = { id: '990091', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'free', actived: true,
  chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = { id: 'text', kind: 'text', x: 10, y: 10, width: 400, height: 160, visible: true, locked: false, text: '$(user)' };
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 800, height: 240,
  events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 1, widgets: [layer] }])) };
const scene = { id: 'main', name: 'My overlay', revision: 0, publicId: 'a'.repeat(48), width: 1920, height: 1080,
  waitFor: ['tts'], widgets: [{ ...layer, id: 'tts', kind: 'tts' }, { ...layer, id: 'alert', kind: 'alert', designId: 'starter', events: ['bits'] }] };
let state = { schemaVersion: 1, revision: 0, scenes: [scene], designs: [design] };
let writes = 0, publishes = 0;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    twitchUser: user, appUser: app, permissions: {}
  })), { user, app });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== 'https://api.domdimabot.com') return route.abort();
    let data = {}, body = request.postDataJSON();
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/') || url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: app.plan_tier };
    else if (url.pathname === '/users') data = { id: url.searchParams.get('username') === 'other' ? '990092' : user.id, username: url.searchParams.get('username') };
    else if (url.pathname.endsWith('/preview')) data = body.texts.map(text => text.replaceAll('$(user)', 'Luna'));
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: state.scenes.map(scene => ({
      id: scene.id, published: !!scene.published, revision: scene.revision, width: scene.width, height: scene.height, receives: [], sources: []
    })) };
    else if (url.pathname.endsWith('/queue')) data = { state: { all: false, platforms: { twitch: false, kick: false, other: false } }, events: [], connected: 0, needsRefresh: 0 };
    else if (url.pathname.includes('/scenes/')) {
      publishes++;
      state.revision++; state.scenes[0].revision++;
      state.scenes[0].published = structuredClone({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor, designs: [design] });
      data = state;
    } else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (request.method() === 'PUT') { writes++; state = structuredClone(body); state.revision++; }
      data = state;
    } else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/fixture/modules');
  const card = page.locator('article.lf-mod').filter({ has: page.getByRole('heading', { name: 'Overlay studio', exact: true }) });
  await card.getByText('Alpha', { exact: true }).waitFor();
  assert.equal(await card.getByText('Pro', { exact: true }).count(), 0, 'Free overlay card keeps Alpha without the Pro badge');
  await card.getByRole('button', { name: 'Open Module', exact: true }).click();
  await page.locator('app-overlay-editor .stage').waitFor();
  await page.locator('.mock-chip').getByText('Alpha', { exact: true }).waitFor();
  assert(!await page.locator('app-overlay-editor').innerText().then(text => text.includes('Alpha · Pro')));
  await page.getByLabel('Overlay name', { exact: true }).fill('Free owner overlay');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(writes, 1);
  await page.getByRole('button', { name: /Publish live/ }).click();
  await page.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor();
  assert.equal(publishes, 1);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    if (process.env.SAAS_SCREENSHOT_DIR) {
      await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/overlay-free-${width}.png`, fullPage: true });
    }
  }
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  const axe = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(axe.violations.map(violation => violation.id), []);
  await page.locator('.topbar__actions button').first().click();
  await page.locator('.mock-chip').getByText('Alfa', { exact: true }).waitFor();
  for (const tier of ['premium', 'pro', 'free']) {
    app.plan_tier = tier;
    await page.evaluate(app => {
      const record = JSON.parse(localStorage.getItem('dimasite.session.v1')); record.appUser = app;
      localStorage.setItem('dimasite.session.v1', JSON.stringify(record));
    }, app);
    await page.reload();
    await page.locator('app-overlay-editor .stage').waitFor();
  }
  await page.goto(base + '/other/modules/overlays');
  await page.waitForURL(url => url.searchParams.get('permission') === 'channel:owner');
  assert.equal(await page.locator('app-overlay-editor').count(), 0, 'the owner restriction remains enforced');
  assert.deepEqual(errors, []);
  console.log('PASS Free Overlay Studio: unlocked Alpha module card, owner editor, save/publish, all tiers, EN/ES Alpha label, mobile/desktop, axe and non-owner denial; all APIs mocked');
} finally { await browser.close(); }
