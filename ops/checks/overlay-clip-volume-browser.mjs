// Clip layer volume: the Studio slider (save, publish, Studio test playback, live change, en/es, themes, phones, axe)
// and the OBS page (each clip layer plays at its own volume, old layers at full volume, 0 = silent but still timed).
// Run: scripts/saas-ops verify site-<run> --check ops/checks/overlay-clip-volume-browser.mjs
import { openStudio, studioToggle } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
// The one-second H.264/AAC clip fixture of the clip designs check (one copy of the bytes).
const designs = await readFile('/root/saas/ops/checks/overlay-clip-designs.mjs', 'utf8');
const mp4 = Buffer.from(designs.match(/const mp4 = Buffer\.from\('([A-Za-z0-9+/=]+)', 'base64'\)/)[1], 'base64');
const api = 'https://api.domdimabot.com', publicId = 'c'.repeat(48), errors = [];
const user = { id: '990293', login: 'clipvolumefixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true,
  twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const metadata = { streamer: 'Fixture streamer', game: 'Fixture game', description: 'Fixture caption', streamerColor: '#22c55e' };
// A clip layer saved before clip volume existed: no `volume` key.
const widget = { id: 'clip-1', kind: 'clip', x: 40, y: 40, width: 800, height: 450, visible: true, locked: false };
let state = { schemaVersion: 1, revision: 0, designs: [], scenes: [{ id: 'main', name: 'Clip fixture', publicId,
  width: 1920, height: 1080, revision: 0, waitFor: ['clip'], widgets: [structuredClone(widget)] }] };
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const shots = process.env.SAAS_SCREENSHOT_DIR;
async function screenshot(page, name) { if (!shots) return; await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png` }); }
async function until(predicate, label) { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error(label); }
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≠ ${expected}`);
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(({ user, app }) => {
    const previous = JSON.parse(localStorage.getItem('dimasite.session.v1') || 'null');
    if (previous) app.language = previous.appUser.language;
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', localStorage.getItem('userLanguage') || 'en'); localStorage.setItem('theme', localStorage.getItem('theme') || 'dark');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  const saves = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/video/clip/')) return route.fulfill({ contentType: 'video/mp4', body: mp4 });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'free' };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}/test`) data = { media: { type: 'video', url: api + '/video/clip/' + user.id, title: 'Fixture title', duration: 30, volume: 1, clip: metadata } };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT') { const body = req.postDataJSON(); saves.push(body); state = structuredClone(body); delete state.writer; delete state.build; state.revision++; }
      data = structuredClone(state);
    } else if (url.pathname.endsWith('/publish')) {
      const s = state.scenes[0]; s.revision++; state.revision++;
      s.published = structuredClone({ width: s.width, height: s.height, widgets: s.widgets, waitFor: s.waitFor, designs: state.designs }); data = structuredClone(state);
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/clipvolumefixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
  await page.locator('.widget[data-kind="clip"]').first().click();
  const slider = page.locator('app-overlay-clip-volume input[type="range"]');
  const label = page.locator('app-overlay-clip-volume label > span');
  await slider.waitFor();
  assert.equal(await slider.inputValue(), '100', 'a clip layer without a volume plays at full volume');
  assert.equal((await label.textContent()).trim(), 'Clip volume · 100%');
  assert.equal(await page.getByLabel(/^Clip volume/).count(), 1, 'the slider has an accessible name');
  assert.equal(await slider.getAttribute('aria-valuetext'), '100%');
  assert.match(await page.locator('#clip-volume-hint').textContent(), /How loud clips play in this layer/);
  assert.equal(state.scenes[0].widgets[0].volume, undefined);

  await slider.fill('35');
  await until(async () => (await label.textContent()).trim() === 'Clip volume · 35%', 'label follows the slider');
  const save = async () => { await page.locator('app-overlay-editor .lf-save-bar').getByRole('button', { name: 'Save draft', exact: true }).click(); await page.locator('app-overlay-editor .lf-save-bar').getByRole('button', { name: 'Saved', exact: true }).waitFor(); };
  await save(); near(state.scenes[0].widgets[0].volume, .35, 'saved volume');

  // The Studio test plays the clip at the layer's volume, and a change applies at once without restarting it.
  const video = page.locator('app-overlay-scene-renderer .placement[data-event="clip"] app-overlay-clip video');
  await openStudio(page, 'test');
  await page.locator('.event-tester__actions').getByRole('button', { name: 'Clips', exact: true }).click();
  await video.waitFor(); await until(() => video.evaluate(v => v.readyState >= 2 && !v.paused), 'test clip plays');
  await video.evaluate(v => v.pause());
  const playing = await video.evaluate(v => ({ volume: v.volume, muted: v.muted }));
  near(playing.volume, .35, 'Studio test volume'); assert.equal(playing.muted, false);
  // Like OBS, a playing clip keeps the settings it started with; the next test uses the change.
  await openStudio(page, 'layer'); await slider.fill('80');
  await until(async () => (await label.textContent()).trim() === 'Clip volume · 80%', 'label follows the second change');
  near(await video.evaluate(v => v.volume), .35, 'the playing test keeps the volume it started with');
  await video.evaluate(v => v.dispatchEvent(new Event('ended')));
  await until(async () => await video.count() === 0, 'test clip completes');
  await openStudio(page, 'test');
  await page.locator('.event-tester__actions').getByRole('button', { name: 'Clips', exact: true }).click();
  await video.waitFor(); await until(() => video.evaluate(v => v.readyState >= 2 && !v.paused), 'second test clip plays');
  await video.evaluate(v => v.pause());
  near(await video.evaluate(v => v.volume), .8, 'the next test plays at the new volume');
  await video.evaluate(v => v.dispatchEvent(new Event('ended')));
  await until(async () => await video.count() === 0, 'second test clip completes');

  await save(); near(state.scenes[0].widgets[0].volume, .8, 'saved volume after the change');
  const publish = page.waitForResponse(r => r.url().endsWith('/publish')); await page.locator('.publish-button').click(); await publish;
  await page.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor();
  near(state.scenes[0].published.widgets[0].volume, .8, 'published volume');
  await slider.fill('0'); await save(); assert.equal(state.scenes[0].widgets[0].volume, 0, '0% is stored as silent, not removed');
  near(state.scenes[0].published.widgets[0].volume, .8, 'saving a draft never changes the published layout');
  await slider.fill('80'); await save();

  // Themes, phone widths and axe; then Spanish.
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  const axe = async () => {
    const result = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  };
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await studioToggle(page, 'theme');
    await until(async () => await page.locator('html').getAttribute('data-theme') === theme, `${theme} theme`);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width < 800 ? 844 : 1100 });
      await openStudio(page, 'layer'); await slider.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width} overflow`);
      const box = await slider.boundingBox(); assert.ok(box && box.height >= 44, `${theme} ${width}: the slider is finger-sized`);
      await axe(); await screenshot(page, `clip-volume-${theme}-${width}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await studioToggle(page, 'lang');
  await until(async () => (await label.textContent()).trim() === 'Volumen del clip · 80%', 'Spanish label');
  assert.match(await page.locator('#clip-volume-hint').textContent(), /Qué tan fuerte se escuchan los clips en esta capa/);
  await axe(); await screenshot(page, 'clip-volume-spanish');
  assert.ok(saves.every(body => body.writer === 2), 'the Studio saves as the current editor');
  await context.close();
  console.log('PASS editor: full volume for old layers, slider label/name, save, Studio test at the layer volume, playing test keeps its volume and the next uses the change, publish isolation, 0% kept, en/es, dark/light, 320/390/1440, axe.');

  // OBS page: each clip layer plays at its own volume; only the first plays sound, as before.
  const runtime = await browser.newContext({ viewport: { width: 960, height: 650 } }); let socket; const revision = 1, ended = [], events = new Map();
  const snapshot = { width: 900, height: 600, waitFor: ['clip'], designs: [], widgets: [
    { ...widget, width: 400, height: 225, x: 20, y: 20, volume: .25 }, { ...widget, id: 'second', width: 400, height: 225, x: 460, y: 20, volume: .9 }] };
  const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
  await runtime.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws;
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => {
      const m = String(message);
      if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision, snapshot }); }
      else if (m.includes('overlay-ended')) ended.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]);
    });
  });
  await runtime.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/clip-fixture.mp4') return route.fulfill({ contentType: 'video/mp4', body: mp4 });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: events.get(url.pathname.split('/').at(-1)) } });
    if (url.pathname.startsWith('/overlay-studio/public/')) return route.fulfill({ json: { data: { revision, snapshot } } });
    return route.abort();
  });
  const source = await runtime.newPage(); source.on('pageerror', e => errors.push(e.message));
  await source.goto(base + '/overlays/' + publicId); await source.locator('.canvas').waitFor();
  const players = source.locator('app-overlay-clip video');
  async function play(id, layers) {
    events.set(id, { id, kind: 'clip', snapshot: { ...structuredClone(snapshot), widgets: layers }, revision, media: { type: 'video', url: api + '/clip-fixture.mp4', title: 'Fixture title', volume: 1, duration: 30, clip: metadata } });
    send('overlay-event', { id, kind: 'clip' });
    await until(async () => await players.count() === layers.length && (await players.evaluateAll(videos => videos.every(v => v.readyState >= 2 && !v.paused))), `${id} plays`);
    const result = await players.evaluateAll(videos => videos.map(v => ({ volume: v.volume, muted: v.muted })));
    await players.evaluateAll(videos => videos.forEach(v => v.dispatchEvent(new Event('ended'))));
    await until(() => ended.includes(id), `${id} completes`);
    await until(async () => await players.count() === 0, `${id} unmounts`);
    return result;
  }
  const two = await play('two-layers', snapshot.widgets);
  near(two[0].volume, .25, 'first clip layer volume'); assert.equal(two[0].muted, false);
  assert.equal(two[1].muted, true, 'only one placement plays the clip sound');
  const legacy = await play('legacy-layer', [structuredClone(widget)]);
  near(legacy[0].volume, 1, 'a layer without a volume plays at full volume'); assert.equal(legacy[0].muted, false);
  const silent = await play('silent-layer', [{ ...widget, volume: 0 }]);
  near(silent[0].volume, 0, 'a 0% layer is silent'); assert.equal(silent[0].muted, false, '0% still plays the clip (timed, not muted)');
  assert.deepEqual(errors, []);
  console.log('PASS OBS page: per-layer clip volume, one audible placement, full volume for old layers, 0% silent but still played to the end.');
} finally { await browser.close(); }
