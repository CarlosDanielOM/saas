import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL must name an isolated preview/candidate');
const api = 'https://api.domdimabot.com', publicId = 'c'.repeat(48), errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const screenshot = async (page, name) => {
  if (!process.env.SAAS_SCREENSHOT_DIR) return;
  await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/widget-modules-${name}.png`, fullPage: true });
};
const widget = (kind, id, extra = {}) => ({ id, kind, x: 20, y: 20, width: 560, height: 360, visible: true, locked: false, ...extra });
const sample = (kind, revision = 1, counts = [60, 40]) => ({
  kind, id: `${kind}-fixture`, title: `Modular ${kind}`, phase: 'active',
  choices: counts.map((n, i) => ({ id: String(i), title: `Choice ${i + 1}`, votes: n, points: n, users: i + 1, color: i ? 'pink' : 'blue' })),
  startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 90000).toISOString(),
  endedAt: null, winnerId: null, occurredAt: new Date().toISOString(), receipt: `module-${revision}`, revision
});

try {
  // No legacy interactions property/event: this exercises the additive generic transport itself.
  const runtime = await browser.newContext({ viewport: { width: 1280, height: 760 }, reducedMotion: 'reduce' });
  let socket, connections = 0;
  let snapshot = { width: 1280, height: 720, designs: [], waitFor: [], widgets: [
    widget('poll', 'poll-a'),
    widget('poll', 'poll-b', { configVersion: 1, x: 650, interactionDesign: 'compact' }),
    widget('prediction', 'prediction-a', { configVersion: 1, y: 400 }),
    widget('prediction', 'future-version', { configVersion: 99 }),
    widget('future-widget', 'unknown-kind')
  ] };
  let widgetStates = { poll: { revision: 1, state: sample('poll') }, prediction: { revision: 1, state: sample('prediction') } };
  const send = (name, data) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, data])}`);
  const sendState = () => send('overlay-widget-states', { widgetStates, serverTime: Date.now() });
  await runtime.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) return ws.close();
    socket = ws; connections++;
    ws.send('0{"sid":"modules","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => {
      if (!String(message).startsWith('40/overlay-studio/')) return;
      ws.send(`40/overlay-studio/${publicId},{"sid":"modules"}`);
      send('overlay-state', { revision: 1, snapshot, widgetStates, serverTime: Date.now() });
    });
  });
  await runtime.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const page = await runtime.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/overlays/${publicId}`);
  const polls = page.locator('[data-interaction="poll"] .panel');
  await polls.nth(1).waitFor();
  await page.locator('[data-interaction="prediction"] .panel').waitFor();
  assert.equal(await page.locator('.panel').count(), 3, 'unsupported module versions/kinds cannot render live state');
  assert.equal(connections, 1, 'duplicate instances share the scene connection');
  assert.deepEqual(await polls.nth(0).locator('.choice-heading strong').allTextContents(), ['60%', '40%']);
  assert.deepEqual(await polls.nth(1).locator('.choice-heading strong').allTextContents(), ['60%', '40%']);
  widgetStates.poll = { revision: 2, state: sample('poll', 2, [80, 20]) }; sendState();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-interaction="poll"] .choice-heading strong')].map(n => n.textContent).join(',') === '80%,20%,80%,20%');
  assert.equal(connections, 1, 'live updates do not create per-widget connections');
  send('overlay-widget-states', { widgetStates: {}, serverTime: Date.now(), failedSources: ['twitch-interactions'] });
  await page.waitForTimeout(100);
  assert.deepEqual(await polls.nth(0).locator('.choice-heading strong').allTextContents(), ['80%', '20%'], 'temporary source failure preserves the last valid state');
  assert.equal(await page.locator('.panel').count(), 3, 'failure preserves all still-requested instances');
  await screenshot(page, 'generic-duplicate-runtime');
  widgetStates.poll = { revision: 0, state: null }; sendState();
  await polls.first().waitFor({ state: 'hidden' });
  assert.equal(await polls.count(), 0, 'explicit null clears every instance even after a higher revision');
  assert.equal(await page.locator('[data-interaction="prediction"] .panel').count(), 1);
  widgetStates = {}; sendState();
  await page.waitForFunction(() => !document.querySelector('.panel'));
  assert.equal(await page.locator('.panel').count(), 0, 'removed/unrequested keys clear prior scoped state');
  widgetStates = { poll: { revision: 3, state: sample('poll', 3) } }; sendState();
  await polls.nth(1).waitFor();
  snapshot = { ...snapshot, widgets: [] };
  send('overlay-state', { revision: 2, snapshot, widgetStates: {}, serverTime: Date.now() });
  await page.waitForFunction(() => !document.querySelector('.panel'));
  assert.equal(await page.locator('body').evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)');
  await runtime.close();
  console.log('PASS generic module runtime: version compatibility, duplicate instances/one connection, generic hydration/update, explicit-null and scoped-removal clears.');

  const user = { id: '990711', login: 'modulefixture', display_name: 'Fixture' };
  const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: false, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const layout = { duration: 5, widgets: [] };
  let state = { schemaVersion: 1, revision: 0, designs: [{ id: 'default', name: 'Alerts', revision: 1, width: 800, height: 240, events: { sub: layout, bits: layout, follow: layout, raid: layout } }], scenes: [{ id: 'main', name: 'Module recovery fixture', publicId, width: 1920, height: 1080, revision: 0, widgets: [], waitFor: [] }] };
  let writes = 0;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('theme', localStorage.getItem('theme') || 'dark');
    localStorage.setItem('userLanguage', 'en');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'free' };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), scenes: [] };
    else if (url.pathname.endsWith('/twitch-events')) data = { poll: { state: 'ready', events: [] }, prediction: { state: 'ready', events: [] } };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT') { writes++; state = structuredClone(req.postDataJSON()); state.revision++; }
      data = structuredClone(state);
    } else if (url.pathname.endsWith('/publish')) {
      state.scenes[0].revision++; state.revision++;
      state.scenes[0].published = structuredClone({ width: 1920, height: 1080, widgets: state.scenes[0].widgets, designs: [], waitFor: [] });
      data = structuredClone(state);
    }
    return route.fulfill({ json: { error: false, data } });
  });
  const editor = await context.newPage(); editor.setDefaultTimeout(12000); editor.on('pageerror', error => errors.push(error.message));
  await editor.goto(`${base}/modulefixture/modules/overlays`); await editor.locator('.stage').waitFor();
  await editor.locator('.palette-item[data-kind="poll"]').click();
  await editor.getByLabel('Preset design', { exact: true }).selectOption('compact');
  await editor.getByLabel('Preview state', { exact: true }).selectOption('tie');
  await editor.locator('.widget[data-kind="poll"] .panel.compact').waitFor();
  await editor.locator('.palette-item[data-kind="prediction"]').click();
  await editor.getByLabel('Preset design', { exact: true }).selectOption('compact');
  await editor.getByLabel('Preview state', { exact: true }).selectOption('locked');
  await editor.locator('.widget[data-kind="prediction"] [data-phase="locked"]').waitFor();
  const backups = () => editor.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('domdimabot-overlay-draft:')).map(k => JSON.parse(localStorage.getItem(k))));
  await editor.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('domdimabot-overlay-draft:') && JSON.parse(localStorage.getItem(k)).scenes[0].widgets.length === 2));
  const draft = (await backups())[0];
  assert.deepEqual(draft.scenes[0].widgets.map(w => [w.kind, w.interactionDesign]), [['poll', 'compact'], ['prediction', 'compact']]);
  assert.equal(draft.scenes[0].publicId, undefined, 'recovery excludes browser-source bearer URLs');
  assert.equal(writes, 0, 'fixture remains unsaved before reload');
  editor.once('dialog', dialog => dialog.accept()); await editor.reload();
  await editor.getByRole('button', { name: 'Restore local draft', exact: true }).click();
  await editor.locator('.widget[data-kind="poll"] .panel.compact').waitFor();
  await editor.locator('.widget[data-kind="prediction"] .panel.compact').waitFor();
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(writes, 1);
  assert.deepEqual(state.scenes[0].widgets.map(w => [w.kind, w.interactionDesign]), [['poll', 'compact'], ['prediction', 'compact']]);
  await editor.getByRole('button', { name: /Publish live/ }).click();
  await editor.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor();
  assert.deepEqual(state.scenes[0].published.widgets.map(w => [w.kind, w.interactionDesign]), [['poll', 'compact'], ['prediction', 'compact']]);
  for (const theme of ['dark', 'light']) {
    await editor.evaluate(theme => localStorage.setItem('theme', theme), theme); await editor.reload(); await editor.locator('.stage').waitFor();
    for (const width of [320, 390, 1280]) {
      await editor.setViewportSize({ width, height: 1100 });
      assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}px module editor overflow`);
      await editor.locator('.widget[data-kind="prediction"]').dispatchEvent('click');
      assert.equal(await editor.getByLabel('Preset design', { exact: true }).inputValue(), 'compact');
      await editor.getByLabel('Preview state', { exact: true }).selectOption('locked');
      await editor.locator('.widget[data-kind="prediction"] [data-phase="locked"]').waitFor();
      await screenshot(editor, `${theme}-${width}`);
    }
  }
  await context.close(); assert.deepEqual(errors, []);
  console.log('PASS modular editor: unsaved poll/prediction local recovery, restored presets, save/publish persistence and dark/light 320/390/1280 layouts.');
} finally { await browser.close(); }
