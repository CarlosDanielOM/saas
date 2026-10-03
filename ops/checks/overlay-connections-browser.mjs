import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const navToggle=async(p,which)=>{const icon=`.auth-navbar__dropdown-item .auth-navbar__${which}-icon`;await p.evaluate(()=>document.querySelector('.auth-navbar__avatar-btn').click());await p.locator(icon).first().waitFor({state:'attached'});await p.evaluate(sel=>document.querySelector(sel).closest('button').click(),icon);};
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), errors = [];
const user = { id: '990091', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = { id: 'text', kind: 'text', x: 10, y: 10, width: 400, height: 160, visible: true, locked: false, text: '$(user)' };
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 1, widgets: [layer] }])) };
const scene = { id: 'main', name: 'My overlay', revision: 1, publicId, width: 1920, height: 1080, waitFor: ['tts'], widgets: [{ ...layer, id: 'tts', kind: 'tts' }, { ...layer, id: 'alert', kind: 'alert', designId: 'starter', events: ['bits'] }] };
const state = { schemaVersion: 1, revision: 2, scenes: [scene, { ...scene, id: 'second', name: 'Other overlay', publicId: 'b'.repeat(48) }], designs: [design] };
const saved = { id: 'main', published: false, revision: 1, width: 800, height: 450, receives: ['tts', 'bits'], sources: [] };
let diagnostics = { checkedAt: Date.now(), pollingFailed: false, scenes: [saved, { ...saved, id: 'second', published: true }] }, fail = false, reads = 0, writes = 0;
const source = (overrides = {}) => ({ connected: true, connectedAt: Date.now(), disconnectedAt: null, lastReportAt: Date.now(), revision: 1, status: 'ready', issue: null, issueAt: null, activationFailed: false, stateFailed: false, ...overrides });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })), { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = req.postDataJSON().texts.map(text => text.replaceAll('$(user)', 'Luna'));
    else if (url.pathname === `/overlay-studio/${user.id}/connections`) { reads++; if (fail) return route.fulfill({ status: 503, json: { error: true } }); data = diagnostics; }
    else if (url.pathname === `/overlay-studio/${user.id}`) { if (req.method() !== 'GET') writes++; data = state; }
    return route.fulfill({ json: { data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays');
  const panel = page.locator('app-overlay-connections');
  await panel.locator('details').evaluate(d => { d.open = true; });
  const body = panel.locator('.body');
  const refresh = async () => { const before = reads; const response = page.waitForResponse(r => r.url().endsWith('/connections')); await panel.getByRole('button', { name: 'Refresh status', exact: true }).click(); await response; await page.waitForFunction(() => !document.querySelector('app-overlay-connections button').disabled); assert(reads > before); };
  await body.getByText('Not published', { exact: true }).waitFor();
  saved.published = true; await refresh(); await body.getByText('No connected sources', { exact: true }).waitFor();
  assert((await panel.textContent()).includes('width 800 and height 450'), 'OBS setup uses the published dimensions, not draft dimensions');
  saved.sources = [source(), source()]; await refresh();
  await body.getByText('2 connected', { exact: true }).waitFor(); await body.getByText('Ready', { exact: true }).waitFor();
  assert((await panel.textContent()).includes('doubled audio'));
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false, 'diagnostic polling never dirties the draft');
  const before = reads; saved.sources = [source({ connected: false, status: 'reconnecting', disconnectedAt: Date.now() })];
  await body.getByText('Reconnecting', { exact: true }).waitFor(); assert(reads > before, 'status polls automatically');
  await body.getByText('0 connected', { exact: true }).waitFor();
  saved.sources = [source({ revision: 0, status: 'updating', issue: 'media', issueAt: Date.now() }), source({ status: 'unresponsive', activationFailed: true, stateFailed: true })];
  diagnostics.pollingFailed = true; await refresh();
  await body.getByText('Needs attention', { exact: true }).waitFor();
  for (const text of ['Updating layout', 'No recent report', 'media loading or playback error', 'TTS or clip connections could not start', 'trouble checking live events']) assert((await panel.textContent()).includes(text));
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    assert((await panel.getByRole('button').boundingBox()).height >= 44);
    if (process.env.SAAS_SCREENSHOT_DIR && [375, 1440].includes(width)) { await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true }); await panel.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/connections-${width}.png` }); }
  }
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  const axe = async () => { const result = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-connections'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []); };
  await axe();
  await navToggle(page,'theme'); await axe();
  if (process.env.SAAS_SCREENSHOT_DIR) await panel.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/connections-dark.png` });
  await navToggle(page,'lang');
  await panel.getByRole('heading', { name: 'Diagnóstico de conexión con OBS', exact: true }).waitFor();
  assert((await panel.textContent()).includes('Requiere atención')); await axe();
  await navToggle(page,'lang');
  fail = true; await refresh(); await body.getByText(/Connection status is unavailable/).waitFor();
  assert.equal(await body.getByText('No connected sources', { exact: true }).count(), 0, 'API failure must not look offline');
  fail = false; diagnostics.pollingFailed = false; saved.sources = [source()]; await refresh(); await body.getByText('Ready', { exact: true }).waitFor();
  await page.locator('.scene-tab[data-id="second"]').click();
  await body.getByText('No connected sources', { exact: true }).waitFor();
  assert.equal(writes, 0); await context.close();
  console.log('PASS diagnostics UI: unpublished/ready/reconnect/update/error states, duplicate guidance, published dimensions, automatic polling, recovery, scene isolation, no dirty draft, en/es, light/dark, 320–1440px and axe.');

  const runtime = await browser.newContext(); const health = [], events = new Map(); let socket, currentRevision = 1, failSnapshot = false, failEvent = false;
  const snapshot = { width: 800, height: 450, widgets: scene.widgets, waitFor: scene.waitFor, designs: [design] };
  const wav = Buffer.alloc(44 + 16000); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
  await runtime.routeWebSocket('**/*', ws => {
    if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws;
    ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
    ws.onMessage(message => { const m = String(message); if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision: currentRevision, snapshot }); } else if (m.includes('overlay-health')) health.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]); });
  });
  await runtime.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
    if (url.pathname === '/broken.wav') return route.fulfill({ status: 404, body: '' });
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.pathname.includes('/events/')) return route.fulfill(failEvent ? { status: 503, json: { error: true } } : { json: { data: events.get(url.pathname.split('/').at(-1)) } });
    if (url.pathname.startsWith('/overlay-studio/public/')) return route.fulfill(failSnapshot ? { status: 503, json: { error: true } } : { json: { data: { revision: currentRevision, snapshot } } });
    return route.abort();
  });
  const sourcePage = await runtime.newPage(); sourcePage.on('pageerror', e => errors.push(e.message));
  await sourcePage.clock.install();
  await sourcePage.goto(base + '/overlays/' + publicId); await sourcePage.locator('.canvas').waitFor();
  const waitHealth = async predicate => { for (let i = 0; i < 160; i++) { if (health.some(predicate)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Missing health report ' + JSON.stringify(health)); };
  await waitHealth(h => h.revision === 1 && h.issue === null);
  await sourcePage.clock.runFor(16000); await waitHealth(() => health.length >= 2); await sourcePage.clock.resume();
  failSnapshot = true; send('overlay-updated', { revision: 2 }); await waitHealth(h => h.issue === 'snapshot'); assert.equal(await sourcePage.locator('.canvas').count(), 1);
  failSnapshot = false; currentRevision = 2; send('overlay-updated', { revision: 2 }); await waitHealth(h => h.revision === 2 && h.issue === null);
  failEvent = true; send('overlay-event', { id: 'missing', kind: 'tts' }); await waitHealth(h => h.issue === 'event');
  failEvent = false;
  for (const [id, path] of [['bad', '/broken.wav'], ['good', '/fixture.wav']]) { events.set(id, { id, kind: 'tts', text: 'Speech fixture', media: { type: 'audio', url: api + path, volume: 1, title: 'Speech' } }); send('overlay-event', { id, kind: 'tts' }); await waitHealth(id === 'bad' ? h => h.issue === 'media' : h => h.revision === 2 && h.issue === null && health.at(-1).issue === null); }
  await sourcePage.waitForFunction(() => !document.querySelector('[data-event="tts"]'));
  // Real play() rejection exercises the autoplay report without changing the media component implementation.
  await sourcePage.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Fixture blocked audio', 'NotAllowedError')); });
  events.set('blocked', { id: 'blocked', kind: 'tts', text: 'Speech fixture', media: { type: 'audio', url: api + '/fixture.wav', volume: 1, title: 'Blocked speech' } }); send('overlay-event', { id: 'blocked', kind: 'tts' }); await waitHealth(h => h.issue === 'autoplay');
  assert.equal(await sourcePage.evaluate(() => document.body.style.background), 'transparent');
  assert.equal(await sourcePage.locator('app-overlay-connections').count(), 0, 'diagnostics never appear on the OBS canvas');
  assert.deepEqual(errors, []); await runtime.close();
  console.log('PASS runtime diagnostics: initial layout acknowledgement, heartbeat, failed update preserving canvas, event/media errors, successful recovery, autoplay blocking and transparent output.');
} finally { await browser.close(); }
