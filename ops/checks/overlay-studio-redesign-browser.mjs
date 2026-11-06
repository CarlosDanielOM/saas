// Overlay Studio (full-screen studio): OBS status chip and link panel, overlay switcher, touch move pad,
// centering, layer quick toggles, tucked-away settings, zoom/fit, side panels, test drawer, snap guides,
// layer reordering, keyboard shortcuts, studio menu, phone tabs with a pinned canvas, design mode,
// EN/ES, light/dark and axe.
// Every API and socket is mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { withLive } from '/root/saas/ops/checks/overlay-studio-live-fixture.mjs';
import { mkdir } from 'node:fs/promises';
import { openStudio, closeStudioMenus, switchStudioScene, studioSceneId, studioToggle } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const AXE = process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '990191', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
function initialState() {
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, { duration: 5, widgets: [layer(k + '-art', 'animation', 50, 50, 120, 120), layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48 })] }])) };
  const widgets = [layer('tts-1', 'tts', 670, 60, 580, 160), layer('trigger-1', 'trigger', 80, 750, 500, 230), layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['tts'], widgets };
  main.published = { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: ['tts'], designs: [design] };
  const chat = { id: 'chat', name: 'Just chatting', revision: 0, publicId: 'b'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets: [layer('tts-2', 'tts', 100, 100, 580, 160)] };
  return { schemaVersion: 1, revision: 4, scenes: [main, chat], designs: [design] };
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function until(predicate, label, tries = 200) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }
async function fixture({ width = 1280, height = 900, dark = false, touch = false, lang = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(({ user, app, dark, lang }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('dimasite.language', lang); localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, { user, app, dark, lang });
  await context.routeWebSocket('**/*', ws => ws.close());
  const ctx = { state: initialState(), writes: 0, sources: 1 };
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.postDataJSON?.();
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = body.texts.map(t => t.replaceAll('$(user)', body.user));
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: ctx.state.scenes.map(s => ({ id: s.id, published: !!s.published, revision: s.revision, width: 1920, height: 1080, receives: ['tts'], sources: s.id === 'main' ? Array.from({ length: ctx.sources }, () => ({ connected: true, connectedAt: Date.now(), disconnectedAt: null, lastReportAt: Date.now(), revision: s.revision, status: 'ready', issue: null, issueAt: null, activationFailed: false, stateFailed: false })) : [] })) };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT') { ctx.writes++; const prev = ctx.state; ctx.state = { ...body, revision: prev.revision + 1, scenes: body.scenes.map(s => { const old = prev.scenes.find(p => p.id === s.id); return { ...s, publicId: old?.publicId || 'e'.repeat(48), revision: old?.revision ?? 0, published: old?.published }; }) }; }
      data = withLive(ctx.state);
    } else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
  return { context, page, ctx };
}
async function axe(page, label) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
  assert.deepEqual(violations, [], 'axe ' + label);
}
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const exactValue = (page, key) => page.locator('.properties').getByLabel(key, { exact: true }).inputValue();

try {
  // Desktop: full screen, plain-language OBS status + link panel, move pad, centering, layer toggles, save states.
  {
    const { context, page, ctx } = await fixture({ width: 1440, height: 900 });
    assert.equal(await page.locator('.auth-navbar').count(), 0, 'the open studio hides the site navbar');
    const head = page.locator('.lf-head__chips');
    await head.getByText('In OBS · 1 connected', { exact: true }).waitFor();
    await head.getByText('Live · v3', { exact: true }).waitFor();
    assert((await page.locator('.stage-frame').boundingBox()).width > 700, 'the canvas uses the width');
    await openStudio(page, 'obs');
    await page.locator('.lf-setup').getByText('Connected. OBS shows what you last published.', { exact: true }).waitFor();
    assert.equal(await page.locator('.lf-setup--warn').count(), 0, 'connected overlay is not amber');
    assert.match(await page.locator('.url-row code').innerText(), /\/overlays\/a{48}$/);
    await page.locator('.url-row').getByRole('button', { name: 'Copy URL', exact: true }).click();
    await page.getByText('Overlay URL copied.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await until(async () => !(await page.getByText('Overlay URL copied.', { exact: true }).count()), 'notice dismissed');
    // Advanced pieces start tucked away; canvas size lives in the Overlay tab.
    for (const selector of ['app-overlay-connections details', 'details.exact', 'details.queue-panel', 'app-overlay-queue details']) {
      assert.equal(await page.locator(selector).evaluate(d => d.open), false, selector + ' starts closed');
    }
    assert.equal(await page.getByLabel('Canvas width', { exact: true }).isVisible(), false, 'canvas size lives in the Overlay tab');

    // Losing OBS turns the status and the link panel amber with a plain consequence.
    ctx.sources = 0; await page.locator('app-overlay-connections details').evaluate(d => { d.open = true; });
    await page.locator('app-overlay-connections').getByRole('button', { name: 'Refresh status', exact: true }).click();
    await head.getByText('Not in OBS yet', { exact: true }).waitFor();
    await page.locator('.lf-setup--warn').getByText(/Viewers can't see this overlay yet/).waitFor();
    assert.match(await page.locator('.studio-status').getAttribute('class'), /is-warn/);
    ctx.sources = 1; await page.locator('app-overlay-connections').getByRole('button', { name: 'Refresh status', exact: true }).click();
    await head.getByText('In OBS · 1 connected', { exact: true }).waitFor();
    await closeStudioMenus(page);

    // Move pad: taps move by the snap step and group into one undo; centering is exact.
    await page.locator('.layers').getByRole('button', { name: 'Text to speech', exact: true }).click();
    await page.locator('details.exact').evaluate(d => { d.open = true; });
    assert.equal(await exactValue(page, 'X'), '670');
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Move right', exact: true }).click();
    await until(async () => await exactValue(page, 'X') === '700', 'nudged right');
    await page.getByRole('button', { name: 'Move down', exact: true }).click();
    await until(async () => await exactValue(page, 'Y') === '70', 'nudged down');
    const undo = page.locator('.history-toolbar').getByRole('button', { name: 'Undo', exact: true });
    await undo.click(); await until(async () => await exactValue(page, 'X') === '700' && await exactValue(page, 'Y') === '60', 'switching arrows is a new step');
    await undo.click(); await until(async () => await exactValue(page, 'X') === '670', 'repeated taps on one arrow undo together');
    await page.getByRole('button', { name: 'Snap to grid', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: 'Snap to grid', exact: true }).getAttribute('aria-pressed') === 'false', 'snap off');
    await page.getByRole('button', { name: 'Move left', exact: true }).click();
    await until(async () => await exactValue(page, 'X') === '669', 'fine nudge without snap');
    await page.getByRole('button', { name: 'Center across', exact: true }).click();
    await until(async () => await exactValue(page, 'X') === String((1920 - 580) / 2), 'centered across');
    await page.getByRole('button', { name: 'Center up and down', exact: true }).click();
    await until(async () => await exactValue(page, 'Y') === String((1080 - 160) / 2), 'centered vertically');
    // The exact section remembers it was opened while hopping between sources.
    await page.locator('.layers').getByRole('button', { name: 'Trigger alerts', exact: true }).click();
    await until(async () => await exactValue(page, 'X') === '80', 'selection switched');
    assert.equal(await page.locator('details.exact').evaluate(d => d.open), true);

    // Layer quick toggles: hide removes it from the canvas; lock disables the move pad.
    await page.getByRole('button', { name: 'Hide Trigger alerts', exact: true }).click();
    await until(async () => !(await page.locator('.widget[data-kind="trigger"]').count()), 'hidden from canvas');
    await until(async () => !(await page.getByRole('switch', { name: 'Show on stream', exact: true }).isChecked()), 'switch reflects hidden');
    await page.getByRole('button', { name: 'Show Trigger alerts', exact: true }).click();
    await page.getByRole('button', { name: 'Lock Trigger alerts', exact: true }).click();
    await until(async () => await page.getByRole('switch', { name: 'Lock position', exact: true }).isChecked(), 'locked');
    await until(() => page.getByRole('button', { name: 'Move up', exact: true }).isDisabled(), 'locked sources cannot be nudged');
    await page.getByText('Turn off Lock position to move it.', { exact: true }).waitFor();

    // Unsaved state is in the save bar; Save writes, Publish stays the one primary action.
    await page.locator('.lf-save-bar').getByText('Unsaved changes', { exact: true }).waitFor();
    assert.equal(await page.locator('.lf-save-bar .lf-btn--primary').count(), 1);
    await page.locator('.lf-save-bar').getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.locator('.lf-save-bar').getByRole('button', { name: 'Saved', exact: true }).waitFor();
    await until(() => ctx.writes === 1, 'one save');
    await page.locator('.lf-save-bar').getByText('Saved · not live in OBS yet', { exact: true }).waitFor();
    await head.getByText('Unpublished changes', { exact: true }).waitFor();

    // The overlay switcher changes overlays.
    await switchStudioScene(page, 'chat');
    await until(async () => await studioSceneId(page) === 'chat' && await page.getByLabel('Overlay name', { exact: true }).inputValue() === 'Just chatting' && await page.locator('.widget').count() === 1, 'scene switched');
    await switchStudioScene(page, 'main');

    // Design rows act on the named design without clashing with the inspector's "Edit design".
    await page.getByRole('button', { name: 'Edit Aurora alerts', exact: true }).click();
    await page.locator('.design-event-tabs').waitFor();
    await page.getByRole('heading', { name: 'Alert design', exact: true }).waitFor({ state: 'attached' });
    await openStudio(page, 'test');
    await page.getByRole('button', { name: 'Preview Follows', exact: true }).waitFor();
    await page.locator('.design-event-tabs').getByRole('button', { name: 'Bits', exact: true }).click();
    await page.getByRole('button', { name: 'Preview Bits', exact: true }).waitFor();
    assert.equal(await page.locator('.lf-setup').count(), 0, 'the OBS link belongs to overlays, not designs');
    if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: shots + '/redesign-design-desktop.png' }); }
    await axe(page, 'design desktop light');
    await page.getByRole('button', { name: 'Save & back to overlay', exact: true }).click();
    await page.locator('.scene-switch').waitFor();
    if (shots) await page.screenshot({ path: shots + '/redesign-desktop.png' });
    await axe(page, 'overlay desktop light');
    await context.close();
  }

  // Desktop studio tools: zoom and fit, side panels, test drawer, snap guide, layer order, keys, menu.
  {
    const { context, page } = await fixture({ width: 1920, height: 1000, dark: true });
    const pct = async () => Number((await page.locator('.tb--pct').innerText()).replace('%', ''));
    const frameWidth = async () => (await page.locator('.stage-frame').boundingBox()).width;
    const fit = await pct(); assert(fit >= 55, 'fit at 1920: ' + fit);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await until(async () => await pct() > fit, 'zoom in');
    await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
    await until(async () => await pct() === fit, 'fit again');
    const wide = await frameWidth();
    await page.getByRole('button', { name: 'Side panels', exact: true }).click();
    await until(async () => await frameWidth() > wide + 150, 'canvas grows without side panels');
    await page.getByRole('button', { name: 'Side panels', exact: true }).click();
    await until(async () => Math.abs(await frameWidth() - wide) < 2, 'side panels back');
    // The test drawer shrinks the canvas instead of covering it.
    await openStudio(page, 'test');
    await until(async () => await frameWidth() < wide - 20, 'canvas makes room for the drawer');
    const stageBox = await page.locator('.stage').boundingBox(), drawerBox = await page.locator('.tester').boundingBox();
    assert(stageBox.y + stageBox.height <= drawerBox.y + 1, 'the drawer never covers the canvas');
    await page.locator('.tester__close').click();
    await until(async () => Math.abs(await frameWidth() - wide) < 2, 'drawer closed');
    // Dragging near the canvas centre snaps to it and shows a guide while dragging.
    await page.locator('.layers').getByRole('button', { name: 'Text to speech', exact: true }).click();
    const tts = await page.locator('.widget[data-kind="tts"]').boundingBox();
    await page.mouse.move(tts.x + tts.width / 2, tts.y + tts.height / 2); await page.mouse.down();
    await page.mouse.move(tts.x + tts.width / 2 + 40, tts.y + tts.height / 2, { steps: 4 });
    await page.mouse.move(tts.x + tts.width / 2 + 3, tts.y + tts.height / 2, { steps: 3 });
    await until(async () => await page.locator('.guide--v').count() === 1, 'centre guide while dragging');
    await page.mouse.up();
    await until(async () => await page.locator('.guide').count() === 0, 'guides cleared');
    assert.equal(await exactValue(page, 'X'), '670', 'snapped back to the centre');
    // Dragging a row in Layers changes what shows in front; undo restores it.
    const names = () => page.locator('.layer__name').allInnerTexts();
    assert.deepEqual(await names(), ['Alerts', 'Trigger alerts', 'Text to speech']);
    const row = name => page.locator('.layer-row').filter({ has: page.locator('.layer__name', { hasText: new RegExp('^' + name + '$') }) });
    await row('Text to speech').dragTo(row('Alerts'));
    await until(async () => (await names())[0] === 'Text to speech', 'dragged to the front');
    await page.locator('.history-toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
    await until(async () => (await names())[0] === 'Alerts', 'order undone');
    // Keyboard: Delete removes the focused, selected source; Ctrl+Z brings it back; + and 0 zoom.
    await page.locator('.widget[data-kind="tts"]').click();
    await page.keyboard.press('Delete');
    await until(async () => await page.locator('.widget[data-kind="tts"]').count() === 0, 'deleted with the keyboard');
    await page.keyboard.press('Control+z');
    await until(async () => await page.locator('.widget[data-kind="tts"]').count() === 1, 'restored with Ctrl+Z');
    await page.locator('.studio__size').click({ force: true });
    await page.keyboard.press('+'); await until(async () => await pct() > fit, '+ zooms in');
    await page.keyboard.press('0'); await until(async () => await pct() === fit, '0 fits');
    // Studio menu: account, theme and language; shortcuts listed.
    await page.locator('.studio-menu-btn').click();
    assert.match(await page.locator('.studio-menu-btn').getAttribute('aria-label'), /Fixture/);
    await page.getByText('Signed in as Fixture', { exact: true }).waitFor();
    await page.getByText('Keyboard shortcuts', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await until(async () => await page.locator('.pop--menu').count() === 0, 'menu closed');
    if (shots) await page.screenshot({ path: shots + '/redesign-desktop-dark-1920.png' });
    await axe(page, 'desktop dark 1920');
    // Leaving the studio brings the site navbar back.
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('link', { name: 'Back to modules', exact: true }).click();
    await page.locator('.auth-navbar').waitFor();
    await context.close();
  }

  // Phone (touch): layers first, pinned canvas, tap-to-select opens Edit, move pad, Test and Overlay tabs.
  for (const dark of [false, true]) {
    const { context, page } = await fixture({ width: 390, height: 844, dark, touch: true });
    assert.equal(await overflow(page), false);
    assert.equal(await page.locator('.studio-mtabs [data-tab="layers"]').getAttribute('aria-pressed'), 'true', 'phones open on Layers');
    await page.locator('.layers').waitFor(); await page.locator('.designs').waitFor();
    const canvas = page.locator('.studio__canvas');
    assert.equal(await canvas.evaluate(el => getComputedStyle(el).position), 'sticky');
    // Tapping a source selects it without moving it and opens its settings.
    await page.locator('.widget[data-kind="trigger"]').tap();
    await until(async () => await page.locator('.studio-mtabs [data-tab="edit"]').getAttribute('aria-pressed') === 'true', 'tap opens settings');
    await until(async () => await page.locator('.selected-card').getAttribute('data-widget-id') === 'trigger-1', 'tap selected');
    await page.locator('details.exact').evaluate(d => { d.open = true; });
    await until(async () => await exactValue(page, 'X') === '80', 'selected coordinates render');
    // Scroll into the settings: the canvas stays pinned on top.
    await page.locator('.mover').scrollIntoViewIfNeeded();
    const pinned = await canvas.boundingBox();
    assert(pinned.y >= -1 && pinned.y < 40, 'canvas pinned at the top, got ' + pinned.y);
    for (const name of ['Move up', 'Move down', 'Move left', 'Move right']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox(); assert(box.width >= 44 && box.height >= 44, name + ' size');
    }
    // Tests have their own tab; the pinned canvas plays them in view.
    await openStudio(page, 'test');
    await page.locator('.event-tester__actions').getByRole('button', { name: 'Raids', exact: true }).click();
    await until(async () => { const b = await page.locator('.stage').boundingBox(); return b && b.y >= -1 && b.y + b.height <= 844; }, 'stage in view');
    // Overlay tab: live controls, polls & predictions and the canvas settings. Save stays in thumb reach.
    await openStudio(page, 'overlay');
    await page.getByLabel('Canvas width', { exact: true }).waitFor();
    const bar = await page.locator('.lf-save-bar').boundingBox();
    assert(bar.y > 844 - 220 && bar.y + bar.height <= 844, 'save bar sits above the tabs');
    if (shots) await page.screenshot({ path: `${shots}/redesign-mobile-${dark ? 'dark' : 'light'}.png` });
    await axe(page, `overlay mobile ${dark ? 'dark' : 'light'}`);
    await context.close();
  }

  // Spanish + widths: no overflow and axe-clean at 320/390/1280 in both themes.
  for (const dark of [false, true]) for (const width of [320, 390, 1280]) {
    const { context, page } = await fixture({ width, height: 900, dark });
    await studioToggle(page, 'lang');
    await openStudio(page, 'obs');
    await page.getByText('Añádelo a OBS', { exact: true }).waitFor();
    await page.locator('.publish-settings').evaluate(d => { d.open = true; });
    await page.locator('details.exact').evaluate(d => { d.open = true; });
    assert.equal(await overflow(page), false, `overflow es ${width} ${dark}`);
    await axe(page, `es ${width} ${dark ? 'dark' : 'light'}`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS Overlay Studio (full-screen studio): OBS status + amber link panel, copy link, dismissable notices, tucked-away settings, overlay switcher, move pad with grouped undo and snap step, centering, remembered exact section, layer hide/lock toggles, save bar states, named design actions, design mode, zoom/fit, side panels, test drawer, snap guide, layer drag order, keyboard delete/undo/zoom, studio menu, navbar restored on leave, phone tabs with pinned canvas, EN/ES, light/dark and axe');
} catch (error) { console.log('Browser errors:', errors); throw error; } finally { await browser.close(); }
