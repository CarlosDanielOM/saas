// Overlay Studio layer order and reordering. The canvas follows the Layers list (trigger and TTS
// cards included), and rows reorder with a mouse, a finger hold, or the grip on touch screens.
// Every API and socket is mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { openStudio } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL || process.argv[2]; assert(base, 'SAAS_PREVIEW_URL required');
const api = 'https://api.domdimabot.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 8000) { for (let i = 0; i < ms / 25; i++) { if (await fn()) return; await sleep(25); } throw Error('Timed out: ' + label); }
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const user = { id: '990191', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: { follow: { duration: 1, widgets: [layer('t', 'text', 190, 65, 530, 90, { text: '$(user)' })] } } };
// Array order is back to front: the red box is the top layer and overlaps the trigger box.
const widgets = [layer('trigger-1', 'trigger', 100, 100, 700, 360), layer('tts-1', 'tts', 1000, 100, 700, 200), layer('box', 'shape', 250, 180, 400, 220, { color: '#ff0000' })];
const state = () => {
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets: structuredClone(widgets) };
  return { schemaVersion: 1, revision: 4, scenes: [main], designs: [design] };
};
const analyzer = await (await browser.newContext()).newPage();
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return analyzer.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data];
  }, png.toString('base64'));
}
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
// The trigger card: a dark brown-to-navy gradient (a little red shows through at ~8%).
const isCard = ([r, g, b]) => r < 120 && g < 90 && b < 100;
// The element that scrolls the Layers list on this layout (a pane, or the page).
const scrollTop = page => page.locator('.layers__list .layer-row').first().evaluate(row => {
  for (let node = row.parentElement; node; node = node.parentElement) { const o = getComputedStyle(node).overflowY; if ((o === 'auto' || o === 'scroll') && node.scrollHeight > node.clientHeight) return node.scrollTop; }
  return document.scrollingElement.scrollTop;
});
async function fixture({ width, height, touch }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  await context.addInitScript(({ user, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', 'en'); localStorage.setItem('theme', 'dark');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.postDataJSON?.();
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = body.texts.map(t => t.replaceAll('$(user)', body.user));
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, needsRefresh: 0, events: [] };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}`) data = state();
    else if (url.pathname.startsWith('/triggers/') || url.pathname.endsWith('/custom-widgets') || url.pathname.endsWith('/twitch-events')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
  await page.locator('app-overlay-scene-renderer .placement.placeholder[data-kind=trigger]').waitFor({ state: 'attached' });
  return { context, page };
}
const order = page => page.locator('.layers__list .layer-row').evaluateAll(rows => rows.map(row => row.dataset.layerId));
const center = async locator => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
// The visible middle of the overlap between the red box and the trigger card.
async function overlapPoint(page) {
  const [box, trigger] = await Promise.all(['box', 'trigger-1'].map(id => page.locator(`.stage .widget--selection[data-widget-id="${id}"]`).boundingBox()));
  const x1 = Math.max(box.x, trigger.x), x2 = Math.min(box.x + box.width, trigger.x + trigger.width), y1 = Math.max(box.y, trigger.y), y2 = Math.min(box.y + box.height, trigger.y + trigger.height);
  assert.ok(x2 - x1 > 4 && y2 - y1 > 4, 'red box overlaps the trigger card on screen');
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

try {
  // ---------- Desktop: canvas order follows Layers; mouse drag reorders ----------
  {
    const { context, page } = await fixture({ width: 1280, height: 900, touch: false });
    await openStudio(page, 'layers');
    assert.equal(await page.locator('.stage .widget--selection .widget__placeholder').count(), 0, 'selection boxes carry no cards of their own');
    assert.deepEqual(await order(page), ['box', 'tts-1', 'trigger-1'], 'Layers lists the top layer first');
    let point = await overlapPoint(page);
    assert.ok(isRed(await pixel(page, point.x, point.y)), 'the top layer covers the trigger card, as listed');
    // Mouse: drag the trigger row onto the top row; the trigger card now covers the red box.
    const row = id => page.locator(`.layer-row[data-layer-id="${id}"]`);
    await row('trigger-1').dragTo(row('box'));
    await until(async () => (await order(page))[0] === 'trigger-1', 'mouse drag moves the trigger to the top');
    point = await overlapPoint(page);
    const front = await pixel(page, point.x, point.y);
    assert.ok(isCard(front), `the trigger card now shows in front of the red box (${front})`);
    assert.ok(await page.locator('app-overlay-scene-renderer .placement[data-kind=shape][data-widget-id=box]').isVisible(), 'the red box is still drawn behind it');
    await page.screenshot({ path: '/tmp/overlay-layer-order-desktop.png' });
    await context.close();
  }
  // ---------- Phone: hold-and-drag, grip drag, and a quick swipe that must not reorder ----------
  {
    const { context, page } = await fixture({ width: 412, height: 915, touch: true });
    const cdp = await context.newCDPSession(page);
    const touch = async (from, to, holdMs, steps = 12) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
      await sleep(holdMs);
      for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] }); await sleep(16); }
      await sleep(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(150);
    };
    await openStudio(page, 'layers');
    const row = id => page.locator(`.layer-row[data-layer-id="${id}"]`);
    assert.deepEqual(await order(page), ['box', 'tts-1', 'trigger-1']);
    // A quick swipe on a row scrolls; it never reorders.
    const before = await scrollTop(page);
    await touch(await center(row('trigger-1').locator('.layer__name')), await center(row('box').locator('.layer__name')), 30, 4);
    assert.deepEqual(await order(page), ['box', 'tts-1', 'trigger-1'], 'a quick swipe does not reorder layers');
    assert.ok(await scrollTop(page) > before, 'a quick swipe scrolls the page');
    await page.locator('.layers__list').evaluate(list => list.scrollIntoView({ block: 'center' })); await sleep(200);
    // Hold the row, then drag it: the trigger takes the top place.
    await touch(await center(row('trigger-1').locator('.layer__name')), await center(row('box').locator('.layer__name')), 500);
    await until(async () => (await order(page))[0] === 'trigger-1', 'hold-and-drag moves the trigger to the top');
    assert.deepEqual(await order(page), ['trigger-1', 'box', 'tts-1']);
    assert.equal(await page.locator('.layer-row.is-dragging, .layer-row.is-drop-target').count(), 0, 'drag highlights clear after dropping');
    // The grip drags at once, without a hold.
    await touch(await center(row('tts-1').locator('.layer-row__grip')), await center(row('trigger-1').locator('.layer__name')), 30);
    await until(async () => (await order(page))[0] === 'tts-1', 'grip drag moves the TTS layer to the top');
    // Eye and lock buttons still work with a tap.
    await row('box').locator('.layer-toggle').first().tap();
    await until(() => row('box').evaluate(r => r.classList.contains('is-hidden')), 'tap hides a layer');
    await row('box').locator('.layer-toggle').nth(1).tap();
    await until(() => row('box').locator('.layer-toggle').nth(1).evaluate(b => b.classList.contains('on')), 'tap locks a layer');
    // Holding a dragged row at the bottom edge keeps scrolling, so far rows can be reached.
    const edgeFrom = await center(row('tts-1').locator('.layer__name'));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [edgeFrom] }); await sleep(500);
    const edgeY = await page.evaluate(() => innerHeight - 20);
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: edgeFrom.x, y: edgeFrom.y + (edgeY - edgeFrom.y) * i / 8 }] }); await sleep(16); }
    const atEdge = await scrollTop(page); await sleep(700);
    const scrolled = await scrollTop(page) - atEdge;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(150);
    assert.ok(scrolled > 30, `holding at the edge keeps scrolling (${scrolled}px)`);
    await page.screenshot({ path: '/tmp/overlay-layer-order-phone.png' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS layer order: the Studio canvas draws trigger/TTS cards in Layers order (pixel-checked), mouse drag reorders, and on phones a finger hold or the grip reorders, a quick swipe scrolls instead, holding at the edge keeps scrolling; eye/lock taps still work');
} finally { await browser.close(); }
