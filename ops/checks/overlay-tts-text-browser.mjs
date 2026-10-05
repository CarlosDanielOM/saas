import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), errors = [];
const widget = { id: 'tts-a', kind: 'tts', x: 100, y: 100, width: 580, height: 160, visible: true, locked: false };
const rate = 16000, seconds = 1, wav = Buffer.alloc(44 + rate * seconds * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < rate * seconds; i++) wav.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000, 44 + i * 2);
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
async function until(predicate, label) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error(label); }
async function screenshot(page, name) { if (!process.env.SAAS_SCREENSHOT_DIR) return; await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/${name}.png`, fullPage: true }); }
try {
  const runtime = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let snapshot = { width: 1920, height: 1080, widgets: [widget], designs: [], waitFor: ['tts'] };
  const events = new Map(), sockets = [], outbound = [];
  await runtime.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) return ws.close(); sockets.push(ws);
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => { const raw = String(message);
      if (raw.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-state', { revision: 1, snapshot }])}`); }
      if (raw.startsWith('42')) outbound.push(JSON.parse(raw.slice(raw.indexOf(',') + 1)));
    });
  });
  await runtime.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fixture.invalid') return url.pathname === '/broken.wav' ? route.fulfill({ status: 503 }) : route.fulfill({ contentType: 'audio/wav', body: wav });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: events.get(url.pathname.split('/').at(-1)) } });
    if (url.pathname.startsWith('/overlay-studio/public/')) return route.fulfill({ json: { data: { revision: 1, snapshot } } });
    return route.abort();
  });
  const page = await runtime.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/overlays/' + publicId); await page.locator('.canvas').waitFor();
  async function play(id, widgets, expectedText) {
    snapshot = { ...snapshot, widgets };
    events.set(id, { id, kind: 'tts', text: 'Spoken fixture text', snapshot: structuredClone(snapshot), media: { type: 'audio', url: 'https://fixture.invalid/speech.wav', title: 'Private spoken title', volume: .75 } });
    for (const ws of sockets) ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-event', { id, kind: 'tts' }])}`);
    await page.locator('[data-event="tts"] video').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.currentTime > .1));
    assert.equal(await page.locator('.speech-text').count(), expectedText);
    assert.equal(await page.locator('.audio-label,.media-title').count(), 0, 'audio labels must not expose spoken text');
    if (expectedText) assert.equal(await page.locator('.speech-text').innerText(), 'Spoken fixture text');
    else assert.equal((await page.locator('[data-event="tts"]').allTextContents()).join('').trim(), '');
    assert.equal(await page.locator('body').evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)');
    const players = await page.locator('video').evaluateAll(nodes => nodes.map(n => ({ muted: n.muted, volume: n.volume })));
    assert.equal(players.filter(p => !p.muted && p.volume === .75).length, 1);
    await screenshot(page, `tts-${id}`);
    await until(() => outbound.some(e => e[0] === 'overlay-ended' && e[1] === id), `${id} completes`);
    assert.equal(await page.locator('[data-event="tts"]').count(), 0);
  }
  await play('legacy-default', [widget], 0);
  await play('explicit-off', [{ ...widget, showTtsText: false }], 0);
  await play('text-on', [{ ...widget, showTtsText: true }], 1);
  await play('mixed-placements', [{ ...widget, showTtsText: false }, { ...widget, id: 'tts-b', showTtsText: true }], 1);
  assert(outbound.some(e => e[0] === 'overlay-health' && !e[1].issue), 'audio-only source remains healthy');
  events.set('broken', { id: 'broken', kind: 'tts', text: 'Hidden failure text', snapshot: { ...snapshot, widgets: [widget] }, media: { type: 'audio', url: 'https://fixture.invalid/broken.wav', title: 'Hidden failure title', volume: 1 } });
  for (const ws of sockets) ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-event', { id: 'broken', kind: 'tts' }])}`);
  await until(() => outbound.some(e => e[0] === 'overlay-ended' && e[1] === 'broken'), 'failed media releases its queue slot');
  assert(outbound.some(e => e[0] === 'overlay-health' && e[1].issue === 'media'));
  await play('after-failure', [widget], 0);
  events.set('trigger-audio', { id: 'trigger-audio', kind: 'trigger', snapshot: { ...snapshot, widgets: [{ ...widget, kind: 'trigger' }] }, media: { type: 'audio', url: 'https://fixture.invalid/speech.wav', title: 'Trigger title', volume: .75 } });
  for (const ws of sockets) ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-event', { id: 'trigger-audio', kind: 'trigger' }])}`);
  await page.locator('[data-event="trigger"] video').waitFor();
  assert.equal(await page.locator('[data-event="trigger"] .audio-label').innerText(), 'Trigger title');
  assert.equal(await page.locator('[data-event="trigger"] .media-title').innerText(), 'Trigger title');
  await until(() => outbound.some(e => e[0] === 'overlay-ended' && e[1] === 'trigger-audio'), 'trigger completes normally');
  await runtime.close();
  console.log('PASS TTS runtime: omitted/off/on/mixed settings, transparent text-free playback, real audible media, one audio copy, acknowledgements and healthy connection.');
  const user = { id: '990391', login: 'ttstextfixture', display_name: 'Fixture' };
  const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true,
    twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  let state = { schemaVersion: 1, revision: 0, designs: [], scenes: [{ id: 'main', name: 'TTS fixture', publicId, width: 1920, height: 1080, revision: 0, waitFor: ['tts'], widgets: [structuredClone(widget)] }] };
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app }) => {
    const saved = JSON.parse(localStorage.getItem('dimasite.session.v1') || 'null');
    if (saved) app.language = saved.appUser.language;
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', localStorage.getItem('userLanguage') || 'en'); localStorage.setItem('theme', localStorage.getItem('theme') || 'dark');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'fixture.invalid') return route.fulfill({ contentType: 'audio/wav', body: wav });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'free' };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}/test`) data = { text: 'Spoken fixture text', media: { type: 'audio', url: 'https://fixture.invalid/speech.wav', title: 'Spoken fixture text', volume: .75 } };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT') { state = structuredClone(req.postDataJSON()); state.revision++; } data = structuredClone(state);
    } else if (url.pathname.endsWith('/publish')) {
      state.scenes[0].revision++; state.revision++; state.scenes[0].published = structuredClone({ width: 1920, height: 1080, widgets: state.scenes[0].widgets, waitFor: ['tts'], designs: [] }); data = structuredClone(state);
    }
    return route.fulfill({ json: { error: false, data } });
  });
  const editor = await context.newPage(); editor.on('pageerror', e => errors.push(e.message));
  await editor.goto(base + '/ttstextfixture/modules/overlays'); await editor.locator('.stage').waitFor();
  await editor.locator('.layers').getByRole('button', { name: 'Text to speech', exact: true }).click();
  const toggle = editor.getByRole('switch', { name: 'Show spoken text', exact: true });
  assert.equal(await toggle.isChecked(), false, 'existing widgets default off');
  assert(await editor.locator('.widget[data-kind="tts"]').getByText('Audio only · transparent on stream', { exact: true }).isVisible());
  assert.equal(await editor.getByRole('switch', { name: 'Enable TTS playback', exact: true }).isChecked(), true);
  await toggle.check();
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click(); await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(state.scenes[0].widgets[0].showTtsText, true); assert.equal(state.scenes[0].widgets[0].visible, true);
  await editor.getByRole('button', { name: /Publish live/ }).click(); await editor.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor();
  assert.equal(state.scenes[0].published.widgets[0].showTtsText, true);
  await toggle.uncheck();
  assert.equal(state.scenes[0].published.widgets[0].showTtsText, true, 'draft does not change published text setting');
  await editor.locator('.test-btn').filter({ hasText: 'Text to speech' }).click();
  await editor.locator('.widget[data-kind="tts"] video').waitFor();
  assert.equal(await editor.locator('.widget[data-kind="tts"] .audio-label,.widget[data-kind="tts"] .media-title').count(), 0);
  await until(async () => !await editor.locator('.widget[data-kind="tts"] video').count(), 'preview completes');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click(); await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  await editor.reload(); await editor.locator('.stage').waitFor(); await editor.locator('.layers').getByRole('button', { name: 'Text to speech', exact: true }).click();
  assert.equal(await toggle.isChecked(), false, 'off survives reload');
  for (const theme of ['dark', 'light']) {
    await editor.evaluate(theme => localStorage.setItem('theme', theme), theme); await editor.reload(); await editor.locator('.stage').waitFor();
    await editor.locator('.layers').getByRole('button', { name: 'Text to speech', exact: true }).click();
    for (const width of [320, 390, 1280]) {
      await editor.setViewportSize({ width, height: 1100 });
      assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width} overflow`);
      await toggle.scrollIntoViewIfNeeded(); assert(await toggle.isVisible());
      await editor.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
      const violations = await editor.evaluate(async () => (await window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, []); await screenshot(editor, `tts-editor-${theme}-${width}`);
    }
  }
  await editor.locator('.palette-item[data-kind="tts"]').click(); assert.equal(await toggle.isChecked(), false, 'new widgets default off');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click(); await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  await editor.evaluate(() => { localStorage.setItem('userLanguage', 'es'); const s = JSON.parse(localStorage.getItem('dimasite.session.v1')); s.appUser.language = 'es'; localStorage.setItem('dimasite.session.v1', JSON.stringify(s)); });
  app.language = 'es'; await editor.reload(); await editor.locator('.stage').waitFor(); await editor.locator('.layers .layer').first().click();
  assert.equal(await editor.getByRole('switch', { name: 'Mostrar el texto leído', exact: true }).isChecked(), false);
  await screenshot(editor, 'tts-editor-spanish'); await context.close();
  assert.deepEqual(errors, []);
  console.log('PASS TTS editor: default-off, independent playback, on/off saved and published, draft isolation, reload, preview, new widgets, English/Spanish, 320/390/1280 layouts, light/dark and axe.');
} finally { await browser.close(); }
