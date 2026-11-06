// Overlay Studio "sticks out of the canvas" notice: one line naming the layer, hidden layers ignored, Show selects the
// layer (cycling), the close button hides it per layer (remembered after a reload), a new layer that sticks out brings it
// back, no overlap with the canvas hint on desktop, Spanish copy, phone + desktop, dark + light, axe and no overflow.
// Every API and socket is mocked (GET only); nothing reaches production.
import { openStudio } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import { withLive } from '/root/saas/ops/checks/overlay-studio-live-fixture.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL must name an isolated preview/candidate');
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const api = 'https://api.domdimabot.com', user = { id: '990301', login: 'canvasfixture', display_name: 'Canvas Fixture' };
const appUser = language => ({ name: 'Fixture', email: 'fixture@example.invalid', language, plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] });
const until = async (fn, label, tries = 120) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out: ' + label); };
const layer = (id, kind, name, x, y, extra = {}) => ({ id, kind, name, x, y, width: 400, height: 200, visible: true, locked: false, ...extra });
const widgets = [layer('meta', 'trigger', 'Bits goal', -40, -60), layer('inside', 'trigger', 'Inside', 600, 400), layer('ghost', 'trigger', 'Hidden one', 1700, 950, { visible: false })];
const scene = { id: 'main', name: 'My overlay', revision: 1, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets };
scene.published = { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: [], designs: [] };
const state = { schemaVersion: 1, revision: 1, scenes: [scene], designs: [] };
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open({ width, height, theme, language }) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: width < 960 });
  await context.addInitScript(({ user, app, theme }) => {
    if (window.top !== window) return;
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    if (!localStorage.getItem('theme')) localStorage.setItem('theme', theme);
  }, { user, app: appUser(language), theme });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    assert.equal(req.method(), 'GET', 'this check never writes');
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app: appUser(language) };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [{ id: 'main', published: true, revision: 1, width: 1920, height: 1080, receives: ['trigger'], sources: [] }] };
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, events: [] };
    else if (url.pathname === `/overlay-studio/${user.id}`) data = withLive(structuredClone(state));
    else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/${user.login}/modules/overlays`); await page.locator('.stage').waitFor();
  return { context, page };
}
const note = page => page.locator('.off-canvas');
const selectedLayer = page => page.locator('li.layer-row.selected').getAttribute('data-layer-id');
async function checkPage(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: no horizontal overflow`);
  const result = await new AxeBuilder({ page }).include('app-overlay-editor').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`), [], `${label}: axe`);
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/off-canvas-${label}.png` }); }
}

try {
  // Desktop, dark, English.
  {
    const { context, page } = await open({ width: 1280, height: 860, theme: 'dark', language: 'en' });
    await note(page).waitFor();
    assert.equal((await note(page).locator('.off-canvas__text').textContent()).trim(), '“Bits goal” sticks out of the canvas. OBS cuts off that part.', 'one line naming the layer; the hidden layer is not counted');
    const [box, hint] = [await note(page).boundingBox(), await page.locator('.studio__hint').boundingBox()];
    assert(box.y + box.height <= hint.y || hint.y + hint.height <= box.y, 'the notice and the canvas hint do not overlap');
    for (const button of [note(page).locator('.off-canvas__btn'), note(page).locator('.off-canvas__close')]) {
      const b = await button.boundingBox(); assert(b.height >= 32, 'buttons are at least 32px (44px hit area)');
    }
    await checkPage(page, 'dark-1280');
    await note(page).getByRole('button', { name: 'Show', exact: true }).click();
    await until(async () => await selectedLayer(page) === 'meta', 'Show selects the layer that sticks out');
    await note(page).getByRole('button', { name: 'Hide this notice', exact: true }).click();
    await until(async () => (await note(page).count()) === 0, 'closed');
    // Remembered after a reload.
    await page.reload(); await page.locator('.stage').waitFor(); await page.waitForTimeout(400);
    assert.equal(await note(page).count(), 0, 'stays hidden for that layer after a reload');
    // Another layer that sticks out (showing the hidden one) brings it back, naming that layer.
    await page.getByRole('button', { name: 'Show Hidden one', exact: true }).click();
    await note(page).waitFor();
    assert.match(await note(page).locator('.off-canvas__text').textContent(), /“Hidden one” sticks out/);
    // Two at once: plural line, Show cycles through them. (Hide it again first, so the reload leaves no unsaved changes.)
    await page.getByRole('button', { name: 'Hide Hidden one', exact: true }).click();
    await until(async () => (await note(page).count()) === 0, 'hidden again');
    await page.evaluate(key => localStorage.removeItem(key), 'dimasite.overlayStudio.offCanvasIgnored.' + user.id);
    await page.reload(); await page.locator('.stage').waitFor();
    await page.getByRole('button', { name: 'Show Hidden one', exact: true }).click();
    await until(async () => /^2 layers stick out of the canvas/.test((await note(page).locator('.off-canvas__text').textContent()).trim()), 'plural line');
    await note(page).getByRole('button', { name: 'Show', exact: true }).click();
    const first = await selectedLayer(page);
    await note(page).getByRole('button', { name: 'Show', exact: true }).click();
    await until(async () => (await selectedLayer(page)) !== first && ['meta', 'ghost'].includes(await selectedLayer(page)), 'Show cycles through the layers');
    await context.close();
  }
  console.log('PASS desktop: one line naming the layer, hidden layers ignored, Show selects (and cycles), close is remembered per layer, a new layer brings it back, no overlap with the hint, axe.');

  // Phone, light, Spanish.
  {
    const { context, page } = await open({ width: 390, height: 844, theme: 'light', language: 'es' });
    await note(page).waitFor();
    assert.equal((await note(page).locator('.off-canvas__text').textContent()).trim(), '«Bits goal» se sale del lienzo. OBS recorta esa parte.');
    await checkPage(page, 'light-390');
    await note(page).getByRole('button', { name: 'Ver', exact: true }).click();
    await until(async () => await selectedLayer(page) === 'meta', 'Ver selects the layer');
    await note(page).getByRole('button', { name: 'Ocultar este aviso', exact: true }).click();
    await until(async () => (await note(page).count()) === 0, 'closed on a phone');
    await openStudio(page, 'layers');
    await context.close();
  }
  // Phone dark and desktop light: layout and axe only.
  for (const [width, height, theme] of [[390, 844, 'dark'], [1280, 860, 'light']]) {
    const { context, page } = await open({ width, height, theme, language: 'en' });
    await note(page).waitFor();
    await checkPage(page, `${theme}-${width}`);
    await context.close();
  }
  console.log('PASS phone + Spanish: «Bits goal» se sale del lienzo, Ver selects, Ocultar este aviso closes; dark/light at 390 and 1280 with axe and no overflow.');
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { await browser.close(); }
