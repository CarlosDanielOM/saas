// Behaviour check for the wide Overlay Studio mock (/mocks/dev/overlay-studio):
// StreamElements-style layout (layers left, zoomable full-size canvas, inspector right,
// floating tool bar with Test) in the Live First look. The page is fully local; every API
// call is mocked anyway and websockets are closed, so nothing leaves the browser.
// SAAS_SCREENSHOT_DIR (optional) receives desktop/phone screenshots in both themes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser/node_modules';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || `${tools}/playwright/index.mjs`);
const axePath = process.env.AXE_PATH || `${tools}/axe-core/axe.min.js`;
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const PATH = '/mocks/dev/overlay-studio';

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

async function open({ theme = 'dark', width = 1440, height, lang = 'en', touch = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: height ?? (width < 640 ? 844 : 900) }, reducedMotion: 'reduce', hasTouch: touch, isMobile: touch
  });
  await context.addInitScript(({ theme, lang }) => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('userLanguage', lang);
  }, { theme, lang });
  await context.routeWebSocket(/./, (ws) => ws.close());
  await context.route('https://api.domdimabot.com/**', (route) => route.fulfill({ json: { error: false, status: 200, data: {} } }));
  await context.route('https://id.twitch.tv/**', (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|NG0|ReferenceError/.test(m.text())) errors.push(`${width}: ${m.text()}`); });
  await page.goto(base + PATH);
  await page.locator('.stage .ly').first().waitFor();
  await page.waitForTimeout(300);
  return { context, page };
}

async function until(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate(() => window.axe.run(document.querySelector('.osw'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target).slice(0, 4) })), [], label);
}

async function layout(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
  const body = await page.locator('.osw').innerText();
  assert.doesNotMatch(body, /\b(top|obs|left|kinds|kindHints|insp|tools|test|render|overlay|pos|anim|style|mobile|mock|scenes|designs|events|status)\.[a-zA-Z]/, `${label}: raw copy key on screen`);
  const invisible = await page.evaluate(() => [...document.querySelectorAll('.btn--primary, .tb--test')]
    .filter((b) => b.offsetParent && getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)').length);
  assert.equal(invisible, 0, `${label}: invisible primary button`);
}

const num = async (locator) => Number(await locator.inputValue());
const layerBox = (page, label) => page.locator(`.stage .ly[aria-label="${label}"]`);
const toastText = (page) => page.locator('.toast').innerText();
const pressedTab = (page) => page.locator('.mtabs button[aria-pressed="true"]').innerText();
const openTest = async (page) => { if (!(await page.locator('.pop--test').count())) await page.getByRole('button', { name: 'Test', exact: true }).click(); await page.locator('.pop--test').waitFor(); };
const closeMenus = async (page) => { if (await page.locator('.pop').count()) await page.keyboard.press('Escape'); };
const percent = async (page) => Number((await page.locator('.tb--pct').innerText()).replace('%', ''));

// 1. Layout, axe and copy at phone and desktop widths, dark first.
for (const width of [320, 390, 1280, 1920]) {
  for (const theme of ['dark', 'light']) {
    const label = `${width} ${theme}`;
    const { context, page } = await open({ width, theme, touch: width < 640, height: width === 1920 ? 1000 : undefined });
    await layout(page, label);
    await axe(page, label);
    if (shots && width !== 320) await page.screenshot({ path: `${shots}/overlay-studio-${width}-${theme}.png` });
    await context.close();
  }
}

// 2. Desktop: the canvas is large, and the editor works like a design tool.
{
  const { context, page } = await open({ width: 1920, height: 1000 });
  const frame = await page.locator('.frame').boundingBox();
  assert.ok(frame.width >= 1100, `canvas should use the width: ${Math.round(frame.width)}px`);
  assert.match(await page.locator('.insp-head h2').innerText(), /Trigger alerts/, 'starts with Trigger alerts selected');

  // Click a layer on the canvas to select it.
  await layerBox(page, 'Text to speech layer').click();
  await until(async () => /Text to speech/.test(await page.locator('.insp-head h2').innerText()), 'select TTS from canvas');

  // Drag it: moves by the mouse distance divided by the zoom, snapped to 10 px.
  const left = page.getByLabel('Left', { exact: true });
  const x0 = await num(left);
  const box = await layerBox(page, 'Text to speech layer').boundingBox();
  const scale = (await percent(page)) / 100;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + 40, { steps: 6 });
  await page.mouse.up();
  await until(async () => (await num(left)) !== x0, 'drag moved the layer');
  const moved = (await num(left)) - x0;
  assert.ok(Math.abs(moved + 100 / scale) <= 20, `drag distance ${moved} vs ${-100 / scale}`);
  assert.equal((await num(left)) % 10, 0, 'snapped to 10 px');

  // Undo / redo through the tool bar.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await until(async () => (await num(left)) === x0, 'undo restores position');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await until(async () => (await num(left)) === x0 + moved, 'redo reapplies');

  // Resize from the bottom-right corner.
  const width = page.getByLabel('Width', { exact: true });
  const w0 = await num(width);
  const handle = await page.locator('.sel__h[data-h="se"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y + 20, { steps: 5 });
  await page.mouse.up();
  await until(async () => (await num(width)) > w0, 'corner resize grows width');

  // Keyboard: arrows nudge, Shift+arrow nudges 10, Delete removes, Ctrl+Z brings it back.
  await page.locator('.ws').click({ position: { x: 20, y: 300 } });
  await until(async () => (await page.locator('.pane--overlay.d-on').count()) === 1, 'empty canvas click shows overlay settings');
  await layerBox(page, 'Alerts layer').click();
  const x1 = await num(left);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await until(async () => (await num(left)) === x1 + 11, 'arrow + shift-arrow nudge');
  await page.keyboard.press('Delete');
  await until(async () => (await page.locator('.stage .ly[aria-label="Alerts layer"]').count()) === 0, 'Delete removes the layer');
  assert.match(await toastText(page), /Alerts deleted/);
  await page.locator('.toast__action').click();
  await until(async () => (await page.locator('.stage .ly[aria-label="Alerts layer"]').count()) === 1, 'toast Undo restores');

  // Zoom in, then Fit.
  const fit = await percent(page);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await until(async () => (await percent(page)) > fit, 'zoom in');
  await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
  await until(async () => (await percent(page)) === fit, 'fit');

  // Test: Follow plays on the Alerts layer, in the editor only.
  await openTest(page);
  if (shots) await page.screenshot({ path: `${shots}/overlay-studio-1920-test-menu.png` });
  await page.locator('.test-btn[data-kind="follow"]').click();
  await until(async () => /Luna just followed!/.test(await page.locator('.stage .al').innerText()), 'follow plays');
  assert.match(await toastText(page), /Follow played here/);

  // Raids switched off on the only Alerts layer → plain answer + one-tap fix.
  await closeMenus(page);
  await layerBox(page, 'Alerts layer').click();
  await page.locator('.pane--edit .pill', { hasText: 'Raids' }).click();
  await openTest(page);
  await page.locator('.test-btn[data-kind="raid"]').click();
  await until(async () => /Nothing in this overlay plays Raid/.test(await toastText(page)), 'raid has no listener');
  await page.locator('.toast__action', { hasText: 'Turn it on' }).click();
  await until(async () => /raiding with 500 viewers/.test(await page.locator('.stage .al').innerText()), 'raid plays after turning it on');

  // Poll is hidden in the starter overlay → "Show it" fixes and plays it with the real poll renderer.
  await openTest(page);
  await page.locator('.test-btn[data-kind="poll"]').click();
  await until(async () => /Poll is hidden/.test(await toastText(page)), 'hidden poll explained');
  await page.locator('.toast__action', { hasText: 'Show it' }).click();
  await until(async () => (await page.locator('.stage .ly[aria-label="Poll layer"] app-overlay-interaction').count()) === 1, 'poll renders');

  // Trigger: random spot shows the dashed area and lands inside it.
  await closeMenus(page);
  await layerBox(page, 'Trigger alerts layer').click();
  await page.getByRole('button', { name: 'Random spot', exact: true }).click();
  await page.locator('.bounds').waitFor();
  await openTest(page);
  await page.locator('.test-btn[data-kind="trigger"]').click();
  await until(async () => (await page.locator('.stage .tg--live').count()) === 1, 'trigger plays');
  const spot = await page.locator('.stage .ly[data-kind="trigger"]').evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
  assert.ok(spot.x >= 40 && spot.y >= 40 && spot.x + spot.w <= 1880 && spot.y + spot.h <= 1040, `random spot inside margins: ${JSON.stringify(spot)}`);
  if (shots) await page.screenshot({ path: `${shots}/overlay-studio-1920-playing.png` });

  // Clip looks: Premium ones explain the upgrade instead of being picked.
  await closeMenus(page);
  await layerBox(page, 'Clips layer').click();
  await page.locator('.look', { hasText: 'Cinema' }).click();
  await page.locator('.upsell').waitFor();
  assert.equal(await page.locator('.look', { hasText: 'Cinema' }).getAttribute('aria-pressed'), 'false');
  await page.locator('.look', { hasText: 'Classic' }).click();
  await until(async () => (await page.locator('.look', { hasText: 'Classic' }).getAttribute('aria-pressed')) === 'true', 'free look picked');

  // Add from the palette: real prediction renderer, selected, counted.
  const before = await page.locator('.layer-row').count();
  await page.locator('.add-tile[data-kind="prediction"]').click();
  await until(async () => (await page.locator('.layer-row').count()) === before + 1, 'layer added');
  assert.match(await page.locator('.insp-head h2').innerText(), /Prediction/);
  assert.equal(await page.locator('.stage .ly.is-sel app-overlay-interaction').count(), 1, 'real prediction preview');

  // Lock: dragging a locked layer does nothing.
  await page.locator('.insp-head').getByRole('button', { name: 'Lock position' }).click();
  const lx = await num(left);
  const lbox = await page.locator('.stage .ly.is-sel').boundingBox();
  await page.mouse.move(lbox.x + 30, lbox.y + 30);
  await page.mouse.down();
  await page.mouse.move(lbox.x + 130, lbox.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  assert.equal(await num(left), lx, 'locked layer stays put');

  // Canvas size → vertical makes layers fall outside; one tap brings them in.
  await page.keyboard.press('Escape');
  await page.locator('.size', { hasText: 'Vertical' }).click();
  await page.locator('.warn-row').waitFor();
  await page.locator('.warn-row button').click();
  await until(async () => (await page.locator('.warn-row').count()) === 0, 'bring them in');
  assert.equal(await page.locator('.frame__size').innerText(), '1080 × 1920');

  // Publish clears the "behind" status.
  assert.match(await page.locator('.status').innerText(), /Unpublished changes/);
  await page.locator('.top__publish').click();
  await until(async () => /Live in OBS/.test(await page.locator('.status').innerText()), 'published');

  // Overlays: switch and create.
  await page.getByRole('button', { name: 'Switch overlay' }).click();
  await page.locator('.menu__item', { hasText: 'Just chatting' }).click();
  await until(async () => (await page.locator('.top__name').inputValue()) === 'Just chatting', 'switched overlay');
  assert.equal(await page.locator('.stage .ly app-overlay-interaction').count(), 1, 'prediction visible in Just chatting');
  await page.getByRole('button', { name: 'Switch overlay' }).click();
  await page.locator('.menu__item--add').click();
  await until(async () => (await page.locator('.layer-row').count()) === 0, 'new overlay is empty');

  // OBS not connected: amber status and setup steps.
  await page.locator('.chip-btn').click();
  await page.locator('.pop--mock button', { hasText: 'Not connected' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.status').click();
  await page.locator('.pop--obs .steps').waitFor();
  assert.match(await page.locator('.status').innerText(), /Not in OBS yet/);
  await page.keyboard.press('Escape');

  // Hide the side panels: the canvas grows (Just chatting is still 16:9).
  await page.getByRole('button', { name: 'Switch overlay' }).click();
  await page.locator('.menu__item', { hasText: 'Just chatting' }).click();
  const narrow = (await page.locator('.frame').boundingBox()).width;
  await page.getByRole('button', { name: 'Side panels' }).click();
  await until(async () => (await page.locator('.frame').boundingBox()).width > narrow + 100, 'canvas grows without panels');
  if (shots) await page.screenshot({ path: `${shots}/overlay-studio-1920-focus.png` });
  await axe(page, 'desktop after interactions');
  await context.close();
}

// 3. Phone: pinned canvas, bottom tabs, tap-to-select, move pad, test sheet, Spanish.
{
  const { context, page } = await open({ width: 390, touch: true });
  await page.locator('.mtabs button', { hasText: 'Layers' }).tap();
  await page.locator('.pane--layers.m-on').waitFor();
  await layerBox(page, 'Alerts layer').tap();
  await until(async () => (await pressedTab(page)) === 'Edit', 'tapping a canvas layer opens Edit');
  assert.match(await page.locator('.insp-head h2').innerText(), /Alerts/);
  const left = page.getByLabel('Left', { exact: true });
  const x0 = await num(left);
  await page.getByRole('button', { name: 'Move right' }).tap();
  await until(async () => (await num(left)) === x0 + 10, 'move pad nudges 10 px');

  // The canvas stays pinned while the settings scroll.
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(150);
  const pinned = await page.locator('.ws').boundingBox();
  assert.ok(pinned.y >= -1 && pinned.y < 5, `canvas pinned at top: ${pinned.y}`);

  // Test is a bottom sheet in thumb reach.
  await page.getByRole('button', { name: 'Test', exact: true }).tap();
  const sheet = await page.locator('.pop--test').boundingBox();
  assert.ok(sheet.y + sheet.height <= 844 && sheet.y > 200, `test sheet at the bottom: ${JSON.stringify(sheet)}`);
  await page.locator('.test-btn[data-kind="sub"]').tap();
  await until(async () => (await page.locator('.stage .al.is-live').count()) === 1, 'sub plays on phone');
  assert.match(await page.locator('.stage .al').innerText(), /Luna subscribed!/);
  await page.locator('.pop--test .pop__head .icon-btn').tap();

  // Add tab adds and jumps to Edit.
  await page.locator('.mtabs button', { hasText: 'Add' }).tap();
  await page.locator('.pane--add.m-on .add-tile[data-kind="text"]').tap();
  await until(async () => (await pressedTab(page)) === 'Edit', 'add jumps to edit');
  assert.match(await page.locator('.insp-head h2').innerText(), /Text/);
  if (shots) await page.screenshot({ path: `${shots}/overlay-studio-390-edit-text.png` });

  // Spanish through the mock menu.
  await page.locator('.chip-btn').tap();
  await page.locator('.pop--mock button', { hasText: 'Español' }).tap();
  await page.keyboard.press('Escape');
  await until(async () => /Publicar|Publicado/.test(await page.locator('.top__publish').innerText()), 'Spanish');
  await layout(page, '390 es');
  await axe(page, '390 es');
  if (shots) await page.screenshot({ path: `${shots}/overlay-studio-390-es.png` });
  await context.close();
}

await browser.close();
assert.deepEqual(errors, [], 'page errors');
console.log('overlay-studio-wide: all checks passed');
