import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), triggerId = '1'.repeat(24), errors = [];
const user = { id: '990291', login: 'placementfixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true,
  twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const widget = { id: 'trigger-a', kind: 'trigger', x: 75, y: 755, width: 400, height: 200, visible: true, locked: false };
let state = { schemaVersion: 1, revision: 0, designs: [], scenes: [{ id: 'main', name: 'Trigger fixture', publicId,
  width: 1920, height: 1080, revision: 0, waitFor: ['trigger'], widgets: [structuredClone(widget)] }] };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" rx="20" fill="#7c3aed"/><text x="200" y="108" fill="white" font-size="28" text-anchor="middle">Trigger fixture</text></svg>';
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const screenshotDir = process.env.SAAS_SCREENSHOT_DIR;
async function screenshot(page, name) {
  if (!screenshotDir) return; await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: true });
}
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(label);
}
async function editorGeometry(page) {
  return page.locator('.widget[data-kind="trigger"]').evaluate(node => Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, parseFloat(node.style[key])])));
}
function placements(page, id) { return page.locator('[data-event="trigger"]').filter({ has: page.getByAltText(id, { exact: true }) }); }
async function runtimeGeometry(page, id, index = 0) {
  return placements(page, id).nth(index).evaluate(node => Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, parseFloat(node.style[key])])));
}
function bounded(rect, canvas, margin) {
  assert(rect.left >= margin - 1e-6 && rect.top >= margin - 1e-6);
  assert(rect.left + rect.width <= canvas.width - margin + 1e-6);
  assert(rect.top + rect.height <= canvas.height - margin + 1e-6);
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app }) => {
    const previous = JSON.parse(localStorage.getItem('dimasite.session.v1') || 'null');
    if (previous) app.language = previous.appUser.language;
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', localStorage.getItem('userLanguage') || 'en'); localStorage.setItem('theme', localStorage.getItem('theme') || 'dark');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'fixture.invalid') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'free' };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}/test`) data = { triggerId, media: { type: 'image', url: 'https://fixture.invalid/trigger.svg', title: 'Fixture', volume: 0 } };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT') { state = structuredClone(req.postDataJSON()); state.revision++; }
      data = structuredClone(state);
    } else if (url.pathname.endsWith('/publish')) {
      state.scenes[0].revision++; state.revision++;
      state.scenes[0].published = structuredClone({ width: state.scenes[0].width, height: state.scenes[0].height,
        widgets: state.scenes[0].widgets, waitFor: state.scenes[0].waitFor, designs: state.designs }); data = structuredClone(state);
    } else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/placementfixture/modules/overlays'); await page.locator('.stage').waitFor();
  await page.locator('.layers').getByRole('button', { name: 'Trigger alerts', exact: true }).click();
  const position = page.getByLabel('Playback position', { exact: true });
  assert.equal(await position.inputValue().catch(async error => { console.log(await page.locator('.properties').innerText(), await page.locator('.properties select').evaluateAll(nodes => nodes.map(n => n.outerHTML))); throw error; }), 'fixed');
  await position.selectOption('random'); const margin = page.getByLabel('Edge margin (px)', { exact: true });
  assert.equal(await margin.inputValue(), '24'); assert(await page.locator('.random-bounds').isVisible());
  await margin.fill('48'); await margin.blur();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.deepEqual(state.scenes[0].widgets[0].triggerPlacement, { mode: 'random', margin: 48 });
  await page.getByRole('button', { name: /Publish live/ }).click();
  await page.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor();
  const frozen = structuredClone(state.scenes[0].published);
  await margin.fill('72'); await margin.blur(); assert.deepEqual(state.scenes[0].published, frozen);
  await margin.fill('48'); await margin.blur();
  // Preview chooses once and survives inspector edits during the active playback.
  await page.locator('.test-btn').filter({ hasText: 'Trigger alerts' }).click();
  await page.locator('.widget[data-kind="trigger"] img').waitFor();
  const preview = await editorGeometry(page);
  bounded({ left: preview.left * 19.2, top: preview.top * 10.8, width: preview.width * 19.2, height: preview.height * 10.8 }, state.scenes[0], 48);
  await margin.fill('100'); await margin.blur(); assert.deepEqual(await editorGeometry(page), preview);
  await until(async () => !await page.locator('.widget[data-kind="trigger"] img').count(), 'Preview ends normally');
  const draftPosition = await editorGeometry(page); assert.equal(draftPosition.left, 75 / 1920 * 100);
  await margin.fill('48'); await margin.blur();
  await page.locator('.test-btn').filter({ hasText: 'Trigger alerts' }).click();
  await page.locator('.widget[data-kind="trigger"] img').waitFor(); assert.notDeepEqual(await editorGeometry(page), preview);
  await until(async () => !await page.locator('.widget[data-kind="trigger"] img').count(), 'Second preview ends');
  await page.locator('.exact').evaluate(node => { node.open = true; });
  await page.getByLabel('W', { exact: true }).fill('3000'); await page.getByLabel('W', { exact: true }).blur();
  assert(await page.getByText(/This size or margin does not fit/).isVisible());
  await page.getByLabel('W', { exact: true }).fill('400'); await page.getByLabel('W', { exact: true }).blur();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { localStorage.setItem('theme', theme); }, theme); await page.reload(); await page.locator('.stage').waitFor();
    await until(async () => await page.locator('html').getAttribute('data-theme') === theme, 'Theme updates');
    await page.locator('.layers').getByRole('button', { name: 'Trigger alerts', exact: true }).click();
    assert.equal(await page.getByLabel('Playback position', { exact: true }).inputValue(), 'random');
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width} overflow`);
      await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
      const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, []); await screenshot(page, `placement-${theme}-${width}`);
    }
  }
  await position.selectOption('fixed'); assert.equal(await margin.count(), 0); assert.equal(await page.locator('.random-bounds').count(), 0);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(state.scenes[0].widgets[0].x, 75); assert.equal(state.scenes[0].widgets[0].y, 755);
  app.language = 'es'; await page.evaluate(() => { localStorage.setItem('userLanguage', 'es'); const session = JSON.parse(localStorage.getItem('dimasite.session.v1')); session.appUser.language = 'es'; localStorage.setItem('dimasite.session.v1', JSON.stringify(session)); }); await page.reload(); await page.locator('.stage').waitFor();
  await page.locator('.layers .layer').first().click();
  assert.equal(await page.getByLabel('Posición de reproducción', { exact: true }).inputValue(), 'fixed');
  await page.getByLabel('Posición de reproducción', { exact: true }).selectOption('random'); await page.getByLabel('Margen de los bordes (px)', { exact: true }).waitFor();
  await screenshot(page, 'placement-spanish'); await context.close();
  console.log('PASS editor: legacy fixed, controls, saved/published settings, stable preview, new position per playback, oversized warning, return to fixed, English/Spanish, mobile/desktop, dark/light and axe.');

  // Two native source renderers receive the same events and must agree on placement.
  const runtime = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  let snapshot = structuredClone(frozen), revision = 1; snapshot.waitFor = ['trigger'];
  snapshot.widgets.push({ ...structuredClone(widget), id: 'trigger-fixed', x: 600 });
  const events = new Map(), sockets = [], acknowledgements = [];
  await runtime.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) { ws.close(); return; } sockets.push(ws);
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => {
      const raw = String(message);
      if (raw.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-state', { revision, snapshot }])}`); }
      if (raw.includes('overlay-ended')) acknowledgements.push(JSON.parse(raw.slice(raw.indexOf(',') + 1))[1]);
    });
  });
  await runtime.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fixture.invalid') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: events.get(url.pathname.split('/').at(-1)) } });
    if (url.pathname.startsWith('/overlay-studio/public/')) return route.fulfill({ json: { data: { revision, snapshot } } });
    return route.abort();
  });
  const pages = await Promise.all([runtime.newPage(), runtime.newPage()]);
  for (const source of pages) {
    source.on('pageerror', e => errors.push(e.message)); await source.goto(base + '/overlays/' + publicId); await source.locator('.canvas').waitFor().catch(async error => { console.log('Runtime startup', pages.indexOf(source), source.url(), errors, sockets.length, await source.locator('body').innerText()); throw error; });
  }
  await pages[0].clock.install(); await pages[0].clock.pauseAt(new Date());
  function send(name, value) { for (const socket of sockets) socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`); }
  async function activate(id, sourceSnapshot = snapshot) {
    events.set(id, { id, kind: 'trigger', snapshot: structuredClone(sourceSnapshot), media: { type: 'image', url: 'https://fixture.invalid/trigger.svg', title: id, volume: 0 } });
    send('overlay-event', { id, kind: 'trigger' });
    for (const page of pages) await until(async () => { await page.clock.runFor(16); return await placements(page, id).locator('img').count() === sourceSnapshot.widgets.length; }, `Event ${id} starts`);
  }
  async function finish() { await pages[0].clock.runFor(5200); }
  await activate('event-a'); const first = await runtimeGeometry(pages[0], 'event-a'); bounded(first, snapshot, 48);
  assert.deepEqual(await runtimeGeometry(pages[1], 'event-a'), first);
  const fixed = await runtimeGeometry(pages[0], 'event-a', 1); assert.deepEqual(fixed, { left: 600, top: 755, width: 400, height: 200 });
  const queuedSnapshot = structuredClone(snapshot);
  events.set('queued', { id: 'queued', kind: 'trigger', snapshot: queuedSnapshot, media: { type: 'image', url: 'https://fixture.invalid/trigger.svg', title: 'queued', volume: 0 } });
  send('overlay-event', { id: 'queued', kind: 'trigger' });
  snapshot.widgets[0].triggerPlacement = { mode: 'fixed', margin: 0 }; snapshot.widgets[0].x = 1200; revision++;
  send('overlay-updated', { revision }); await new Promise(r => setTimeout(r, 100));
  for (const page of pages) await page.clock.runFor(32);
  assert.deepEqual(await runtimeGeometry(pages[0], 'event-a'), first, 'publication cannot move active playback');
  await finish();
  for (const page of pages) await until(async () => { await page.clock.runFor(16); return await placements(page, 'queued').locator('img').count() === 2; }, 'Queued playback starts');
  const queued = await runtimeGeometry(pages[0], 'queued'); bounded(queued, queuedSnapshot, 48); assert.notDeepEqual(queued, first);
  assert.deepEqual(await runtimeGeometry(pages[1], 'queued'), queued); await finish();
  await activate('new-publication'); assert.equal((await runtimeGeometry(pages[0], 'new-publication')).left, 1200); await finish();
  const oversized = structuredClone(queuedSnapshot); oversized.width = 300; oversized.height = 150; oversized.widgets = [oversized.widgets[0]];
  await activate('oversized', oversized); const scaled = await runtimeGeometry(pages[0], 'oversized'); bounded(scaled, oversized, 48);
  assert(Math.abs(scaled.width / scaled.height - 2) < 1e-6); assert(scaled.width < 400); await finish();
  await until(() => acknowledgements.filter(id => id === 'event-a').length === 2, 'Completion acknowledged once per source');
  send('overlay-event', { id: 'event-a', kind: 'trigger' }); await new Promise(r => setTimeout(r, 50));
  for (const page of pages) { await page.clock.runFor(32); assert.equal(await page.locator('[data-event="trigger"]').count(), 0); }
  assert.deepEqual(errors, []); await runtime.close();
  console.log('PASS runtime: bounded random placement, identical multi-source positions, fixed compatibility, queue progression, active/queued published snapshots, proportional shrink, completion and duplicate suppression.');
} finally { await browser.close(); }
