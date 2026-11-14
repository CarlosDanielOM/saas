// TTS page, Speech URL card: where TTS is open, what is wrong with each copy, and the
// "Play on every open copy" switch. Mocked session and API only: nothing reaches production.
// Requires Playwright and @axe-core/playwright in SAAS_BROWSER_TOOLS (outside the production checkout).
//   scripts/saas-ops verify site-<run> --check ops/checks/tts-outputs-web.mjs
//   (or against a preview: SAAS_PREVIEW_URL=http://127.0.0.1:<port> node ops/checks/tts-outputs-web.mjs)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4207';
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const until = async (fn, message, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(50); }
  assert.fail(message);
};
const user = { id: '999991', login: 'test', display_name: 'Test' };
const app = { name: 'Test', email: 'test@example.invalid', language: 'en', plan_tier: 'premium', actived: true,
  chat_enabled: true, twitch_user_id: '999991', has_permissions: true, up_to_date_permissions: true, administrating: [] };
await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
  version: 2, token: 'test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
  twitchUser: user, appUser: app, permissions: {}
})), { user, app });

let role = 'owner';
// An older saved document without `playback`: the page must treat it as off.
let settings = { channelID: '999991', channel: 'test', enabled: true, provider: 'piper', defaultLanguage: 'es',
  voices: { en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', cloneDefault: 'gojo', kokoroDefault: 'ef_dora' },
  filters: { skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 280, expressiveTags: {} }, queue: { maxItems: 5 } };
const puts = [];
const outputs = (extra) => ({ total: 2, playable: 1, hidden: 1, blocked: 0, failing: 0, unknown: 0, mode: 'one', ...extra });
let status = { connected: true, playing: false, preparing: false, queueLength: 0, outputs: outputs() };
let statusFails = false;
let statusCalls = 0;

await context.routeWebSocket(/api\.domdimabot\.com/, ws => {
  ws.send('0' + JSON.stringify({ sid: 'test', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }));
  ws.onMessage(message => { const text = String(message); if (text.startsWith('40')) ws.send(`40${text.slice(2).split(',')[0]},${JSON.stringify({ sid: 'test-socket' })}`); });
});
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(base).origin) {
    // The helper's static server has no SPA fallback: use the CSR shell for the test route.
    if (url.pathname === '/test/modules/tts') return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
    return route.continue();
  }
  if (url.hostname !== 'api.domdimabot.com') return route.abort();
  let data = {};
  if (url.pathname === '/users') data = { id: '999991', username: 'test' };
  else if (url.pathname === '/auth/session') data = { twitch: user, app };
  else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role };
  else if (url.pathname === '/speech/settings/999991') {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); puts.push(body); settings = body; }
    data = { role, settings };
  } else if (url.pathname === '/speech/999991/status') {
    statusCalls++;
    if (statusFails) return route.fulfill({ status: 500, json: { error: true, status: 500, message: 'Unable to read TTS status' } });
    data = status;
  } else if (url.pathname === '/speech/favorites/999991') data = [];
  else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
  return route.fulfill({ json: { error: false, status: 200, data } });
});

const card = page.locator('[data-assistant-anchor="tts.speech-url"]');
const outputsBox = page.getByTestId('tts-outputs');
const everySwitch = card.getByRole('checkbox', { name: 'Play on every open copy' });
const open = async () => {
  await page.goto(base + '/test/modules/tts');
  await card.waitFor();
  await until(async () => !(await outputsBox.innerText()).includes('Checking'), 'status loaded');
};
const theme = name => page.evaluate(value => { document.documentElement.classList.toggle('dark', value === 'dark'); document.documentElement.setAttribute('data-theme', value); }, name);

try {
  // 1. Two copies, one hidden in OBS (the spectralzero_ case).
  await open();
  let text = await outputsBox.innerText();
  assert.match(text, /Open in 2 places \(1 can play\)\. Each message plays on one of them\./);
  assert.match(text, /1 copy is hidden in OBS and can't play sound\. Put it in the scene you stream with the eye on, or delete it\./);
  assert.match(text, /If you added it twice by mistake, delete the extra one\./);
  assert.equal(await outputsBox.locator('.lf-outputs__status').getAttribute('data-tone'), 'mixed');
  assert.equal(await everySwitch.isChecked(), false, 'a saved document without the setting reads as off');
  assert.match(await card.innerText(), /Off: each message plays on one copy that can play it/);

  // Phone + desktop, dark first, then light: no overflow, accessible, screenshots for review.
  for (const [width, mode] of [[320, 'dark'], [390, 'dark'], [1280, 'dark'], [320, 'light'], [390, 'light'], [1280, 'light']]) {
    await page.setViewportSize({ width, height: 900 });
    await theme(mode);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow ${width} ${mode}`);
    const axe = await new AxeBuilder({ page }).include('[data-assistant-anchor="tts.speech-url"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `speech URL card accessibility ${width} ${mode}`);
    const box = await card.boundingBox();
    assert.ok(box && box.width <= width, `card fits ${width}`);
    await card.screenshot({ path: `${shots}/saas-tts-outputs-${width}-${mode}.png` });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await theme('dark');

  // 2. The switch is a normal draft setting: the save bar sends it, and the hint follows it.
  await everySwitch.check();
  await until(async () => /On: every open copy plays every message/.test(await card.innerText()), 'hint follows the switch');
  const save = page.getByRole('button', { name: 'Save TTS settings' });
  await until(async () => !(await save.isDisabled()), 'save enabled after the change');
  await save.click();
  await until(() => puts.length === 1, 'settings saved');
  assert.deepEqual(puts[0].playback, { allOutputs: true });
  assert.equal(puts[0].queue.maxItems, 5, 'the rest of the settings travel unchanged');

  // 3. Every-copy mode with a blocked browser and a failing copy, plus an older page.
  status = { ...status, outputs: outputs({ total: 3, playable: 1, hidden: 0, blocked: 1, failing: 1, unknown: 1, mode: 'all' }) };
  await open();
  text = await outputsBox.innerText();
  assert.match(text, /Open in 3 places \(1 can play\)\. Every message plays on all of them\./);
  assert.match(text, /1 copy is open in a browser that blocks sound until you click or tap that page\./);
  assert.match(text, /1 copy couldn't play a message recently\./);
  assert.match(text, /1 copy is an older version that can't report problems\. Refresh its browser source in OBS\./);
  assert.doesNotMatch(text, /twice by mistake/, 'no duplicate hint when every copy is meant to play');
  assert.equal(await everySwitch.isChecked(), true);

  // 4. Not open anywhere, and a single failing copy (refresh hint).
  status = { ...status, outputs: outputs({ total: 2, playable: 0, hidden: 2, mode: 'one' }) };
  await open();
  text = await outputsBox.innerText();
  assert.match(text, /Open in 2 places, but none of them can play right now\./);
  assert.match(text, /2 copies are hidden in OBS and can't play sound\./);
  status = { ...status, outputs: outputs({ total: 0, playable: 0, hidden: 0 }) };
  await open();
  assert.match(await outputsBox.innerText(), /Not open anywhere\. Add the speech URL to OBS as a browser source\./);
  assert.equal(await outputsBox.locator('.lf-outputs__status').getAttribute('data-tone'), 'warn');
  status = { ...status, outputs: outputs({ total: 1, playable: 0, hidden: 0, failing: 1 }) };
  await open();
  text = await outputsBox.innerText();
  assert.match(text, /Open in 1 place, but it can't play right now\./);
  assert.match(text, /1 copy couldn't play a message recently\. Refresh the browser source in OBS\./);

  // 5. Status unavailable: says so, keeps the page usable.
  statusFails = true;
  await open().catch(() => {});
  await until(async () => /Couldn't check where TTS is open/.test(await outputsBox.innerText()), 'unavailable state');
  assert.equal(await everySwitch.isDisabled(), false, 'settings still editable');
  statusFails = false;

  // 6. Read-only access sees the status but cannot change the switch.
  role = 'admin';
  status = { ...status, outputs: outputs() };
  await open();
  assert.equal(await everySwitch.isDisabled(), true);
  assert.match(await outputsBox.innerText(), /hidden in OBS/);
  role = 'owner';

  // 7. Spanish (es-MX).
  app.language = 'es';
  await page.evaluate(() => localStorage.setItem('userLanguage', 'es'));
  await page.goto(base + '/test/modules/tts');
  await card.waitFor();
  await until(async () => /Abierta en 2 lugares/.test(await outputsBox.innerText()), 'Spanish status');
  text = await outputsBox.innerText();
  assert.match(text, /Abierta en 2 lugares \(puede sonar en 1\)\. Cada mensaje suena en uno de ellos\./);
  assert.match(text, /1 copia está oculta en OBS y no puede sonar\. Ponla en la escena con la que transmites, con el ojito activado, o bórrala\./);
  assert.ok(await card.getByRole('checkbox', { name: 'Sonar en todas las copias abiertas' }).count() === 1);
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Spanish fits 320');
  await card.screenshot({ path: `${shots}/saas-tts-outputs-320-dark-es.png` });
  const spanishAxe = await new AxeBuilder({ page }).include('[data-assistant-anchor="tts.speech-url"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(spanishAxe.violations.map(v => v.id), [], 'Spanish accessibility');

  assert.ok(statusCalls >= 7, 'status is polled from the page');
  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('PASS: TTS speech URL card explains where TTS is open and what to fix (hidden, blocked, failing, older, none, unavailable), saves "Play on every open copy", read-only, Spanish, 320/390/1280 dark+light, axe');
} catch (error) {
  console.log('Browser failure:', error);
  console.log({ url: page.url(), card: (await card.innerText().catch(() => '')).slice(0, 2000), errors });
  await page.screenshot({ path: `${shots}/saas-tts-outputs-failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
