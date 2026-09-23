// Requires Playwright and @axe-core/playwright in SAAS_BROWSER_TOOLS (outside the production checkout).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-fish-browser-tools') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4207';
const browserEnv = { ...process.env };
const localLibraries = process.env.SAAS_BROWSER_LIBS || '/tmp/saas-fish-browser-libs';
if (fs.existsSync(localLibraries + '/fonts.conf')) {
  browserEnv.FONTCONFIG_FILE = localLibraries + '/fonts.conf';
  browserEnv.LD_LIBRARY_PATH = localLibraries + '/extracted/usr/lib/x86_64-linux-gnu';
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], env: browserEnv });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('crash', () => console.log('Page crashed'));
const user = { id: '999991', login: 'test', display_name: 'Test' };
const app = { name: 'Test', email: 'test@example.invalid', language: 'en', plan_tier: 'premium', actived: true,
  chat_enabled: true, twitch_user_id: '999991', has_permissions: true, up_to_date_permissions: true, administrating: [] };
await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
  version: 2, token: 'test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
  twitchUser: user, appUser: app, permissions: {}
})), { user, app });
let role = 'owner';
let settings = { channelID: '999991', channel: 'test', enabled: true, provider: 'fish', defaultLanguage: 'es',
  voices: { en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', cloneDefault: 'gojo' },
  filters: { skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 280, expressiveTags: {} }, queue: { maxItems: 5 } };
const voices = [
  { id: 'a'.repeat(32), name: 'Alice', gender: 'female', languages: ['en'], licensed: true },
  { id: 'b'.repeat(32), name: 'Bea', gender: 'female', languages: ['es'], licensed: false },
  { id: 'c'.repeat(32), name: 'Carlos', gender: 'male', languages: ['es'], licensed: false },
  ...Array.from({ length: 17 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: `Voice ${i + 4}`, gender: 'male', languages: ['en'], licensed: true }))
];
let previews = 0;
let previewFail = false;
let searchQueries = [];
let favorites = [];
let lastPreviewBody;
// Valid short WAV, generated locally. No provider synthesis or live credits.
const wav = Buffer.alloc(44 + 1600);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28);
wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(1600,40);
await context.routeWebSocket(/api\.domdimabot\.com/, ws => {
  ws.send('0'+JSON.stringify({ sid: 'test', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }));
  ws.onMessage(message => {
    const m = String(message);
    if (m.startsWith('40')) {
      const ns = m.slice(2).split(',')[0];
      ws.send(`40${ns},${JSON.stringify({ sid: 'test-socket' })}`);
    }
    if (m.startsWith('42/speech-preview/')) {
      const match = m.match(/^42([^,]+),(\d+)(.*)$/);
      previews++;
      lastPreviewBody = JSON.parse(match[3])[1];
      setTimeout(() => ws.send(`43${match[1]},${match[2]}${JSON.stringify([previewFail ? { error: true, code: 'insufficient_credits' } : {
        error: false, data: { voiceId: lastPreviewBody.voiceId, text: 'Hola, chat.', credits: 17, mimeType: 'audio/wav', audio: wav.toString('base64') }
      }])}`), 100);
    }
  });
});
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(base).origin) {
    // The helper's static server has no SPA fallback. Use the built CSR shell for this test route.
    if (process.env.SAAS_PREVIEW_URL && url.pathname === '/test/modules/tts') {
      const r = await route.fetch({ url: base + '/index.csr.html' }); return route.fulfill({ response: r });
    }
    return route.continue();
  }
  if (url.hostname !== 'api.domdimabot.com') return route.abort();
  let data = {};
  if (url.pathname === '/users') data = { id: '999991', username: 'test' };
  else if (url.pathname === '/auth/session') data = { twitch: user, app };
  else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner' };
  else if (url.pathname === '/speech/settings/999991') {
    if (route.request().method() === 'PUT') settings = route.request().postDataJSON();
    data = { role, settings };
  } else if (url.pathname === '/speech/voices/999991') {
    searchQueries.push(url.searchParams.toString());
    if (url.searchParams.get('name') === 'outage') return route.fulfill({ status: 503, json: { error: true } });
    const name = url.searchParams.get('name') || '';
    const gender = url.searchParams.get('gender'); const lang = url.searchParams.get('language'); const license = url.searchParams.get('license');
    data = { items: voices.filter(v => v.name.toLowerCase().includes(name.toLowerCase()) &&
      (gender === 'all' || gender === v.gender) && (lang === 'all' || v.languages.includes(lang)) &&
      (license === 'all' || v.licensed === (license === 'licensed'))), page: Number(url.searchParams.get('page')), hasMore: !name && url.searchParams.get('page') === '1' };
  } else if (url.pathname === '/speech/favorites/999991') {
    if (route.request().method() === 'POST') {
      const id = route.request().postDataJSON().id;
      const voice = voices.find(v => v.id === id);
      const favorite = { id, name: voice.name, alias: voice.name.toLowerCase() };
      favorites.push(favorite);
      data = favorite;
    } else data = favorites;
  } else if (url.pathname.startsWith('/speech/favorites/999991/') && route.request().method() === 'DELETE') {
    favorites = favorites.filter(favorite => favorite.id !== url.pathname.split('/').at(-1));
    data = favorites;
  } else if (url.pathname === '/speech/preview-session/999991') data = { ticket: 'test-ticket' };
  else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
  return route.fulfill({ json: { error: false, status: 200, data } });
});
try {
  await page.goto(base + '/test/modules/tts');
  const browserUI = page.locator('app-fish-voice-browser');
  const dialog = browserUI.getByRole('dialog');
  const openBrowser = async () => {
    await page.getByRole('button', { name: 'Find voice', exact: true }).click();
    await browserUI.getByRole('heading', { name: 'Alice', exact: true }).waitFor();
  };
  await page.getByRole('button', { name: 'Find voice', exact: true }).waitFor();
  assert.equal(await browserUI.count(), 0, 'catalog stays out of the settings page');
  assert.equal(searchQueries.length, 0, 'catalog is fetched only when opened');
  await page.setViewportSize({ width: 320, height: 640 });
  await openBrowser();
  assert.equal(await browserUI.getByRole('button', { name: 'Add Alice to favorites' }).locator('.voice-star__label').innerText(), 'Save voice');
  await browserUI.getByRole('button', { name: 'Add Alice to favorites' }).click();
  await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).waitFor();
  assert.equal(await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).locator('.voice-star__label').innerText(), 'Saved voice');
  assert.equal(await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.lf-favorites code').textContent(), 'alice');
  assert.ok((await page.locator('#fish-default-voice').textContent()).includes('Alice'));
  for (const [width, theme] of [[320, 'dark'], [390, 'dark'], [1280, 'dark'], [320, 'light'], [1280, 'light']]) {
    await page.evaluate(theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.setAttribute('data-theme', theme); }, theme);
    await page.setViewportSize({ width, height: width < 640 ? 640 : 900 });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= page.viewportSize().height + 1, 'modal fits viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal overflow');
    await dialog.screenshot({ path: `/tmp/saas-fish-${width}-${theme}.png` });
    const axe = await new AxeBuilder({ page }).include('app-fish-voice-browser').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n=>n.target) })), [], 'voice browser accessibility');
  }
  const body = browserUI.locator('.voice-body');
  const scrollY = await page.evaluate(() => window.scrollY);
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.ok(await body.evaluate(el => el.scrollTop > 0), 'results scroll internally');
  assert.equal(await page.evaluate(() => window.scrollY), scrollY, 'background does not scroll');
  assert.equal(await browserUI.getByRole('button', { name: 'Close voice browser' }).isVisible(), true);
  await browserUI.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal(await browserUI.locator('.voice-pagination span').textContent(), '2');
  await browserUI.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.waitForTimeout(400);
  await browserUI.getByRole('button', { name: 'Close voice browser' }).focus();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(i < 40 ? 'Tab' : 'Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true, 'focus remains in modal');
  }
  await page.keyboard.press('Escape');
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await browserUI.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Find voice', exact: true }).evaluate(el => document.activeElement === el), true, 'focus returns to opener');
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
  await openBrowser();
  await page.mouse.click(5, 5);
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await browserUI.count(), 0, 'backdrop closes modal');
  await page.setViewportSize({ width: 320, height: 640 });
  const picker = page.locator('.lf-voice-picker__controls');
  await picker.scrollIntoViewIfNeeded();
  await picker.screenshot({ path: '/tmp/saas-fish-picker-mobile.png' });
  const selectBounds = await picker.locator('select').boundingBox();
  assert.ok(selectBounds.x >= 0 && selectBounds.x + selectBounds.width <= 320, 'default dropdown fits mobile width');
  const findBounds = await page.getByRole('button', { name: 'Find voice', exact: true }).boundingBox();
  assert.ok(findBounds.x >= 0 && findBounds.x + findBounds.width <= 320, 'favorite browser button fits mobile width');
  await openBrowser();
  await browserUI.getByLabel('Search by name').fill('Alice');
  await page.waitForTimeout(450);
  assert.equal(await browserUI.locator('.voice-card').count(), 1);
  await browserUI.getByLabel('Search by name').fill('');
  await browserUI.getByRole('button', { name: 'Filters', exact: true }).click();
  await browserUI.getByLabel('Voice gender').selectOption('female');
  await browserUI.getByLabel('Language').selectOption('es');
  await browserUI.getByLabel('Licensing').selectOption('unlicensed');
  await page.waitForTimeout(450);
  assert.equal(await browserUI.locator('.voice-card').count(), 1);
  await browserUI.getByRole('heading', { name: 'Bea', exact: true }).waitFor();
  assert.ok(searchQueries.at(-1).includes('license=unlicensed'));
  await browserUI.getByRole('button', { name: 'Use Bea as default', exact: true }).click();
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await browserUI.count(), 0, 'choosing returns to settings');
  assert.equal(await page.locator('#fish-default-voice option:checked').textContent(), 'Bea');
  await page.getByRole('button', { name: 'Save TTS settings', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(settings.voices.cloneDefault, 'b'.repeat(32));
  await openBrowser();
  await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).click();
  await browserUI.locator('audio').waitFor();
  assert.equal(previews, 1); assert.equal(lastPreviewBody.voiceId, 'b'.repeat(32)); assert.equal(lastPreviewBody.language, 'es');
  await browserUI.getByText('17 credits used', { exact: false }).waitFor();
  await dialog.screenshot({ path: '/tmp/saas-fish-mobile-preview.png' });
  await browserUI.locator('audio').evaluate(el => el.play());
  assert.equal(previews, 1, 'replay must not request synthesis');
  previewFail = true;
  await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).click();
  await browserUI.getByRole('alert').filter({ hasText: 'balance is too low' }).waitFor();
  assert.equal(await browserUI.locator('audio').count(), 0);
  await browserUI.getByLabel('Search by name').fill('outage');
  await browserUI.getByRole('alert').filter({ hasText: 'catalog could not' }).waitFor();
  await browserUI.getByLabel('Search by name').fill('No match');
  await browserUI.getByText('No voices match', { exact: false }).waitFor();
  await page.reload();
  assert.equal(await page.locator('.lf-favorites code').textContent(), 'alice', 'favorite persists across reload');
  await page.getByRole('button', { name: 'Remove Alice from favorites' }).first().click();
  await page.getByText('No favorites yet.').waitFor();
  assert.equal(await page.locator('.lf-favorites code').count(), 0);
  await openBrowser();
  assert.equal(await browserUI.locator('.voice-card.is-selected h3').textContent(), 'Bea');
  previewFail = false;
  await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).click();
  await browserUI.locator('audio').waitFor();
  await browserUI.locator('audio').evaluate(el => { window.fishTestAudio = el; window.fishTestAudio.loop = true; return el.play(); });
  await browserUI.getByRole('button', { name: 'Close voice browser' }).click();
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fishTestAudio.paused), true, 'closing stops playback');
  await openBrowser();
  assert.equal(await browserUI.locator('audio').count(), 0, 'reopening has no stale preview');
  settings.provider = 'piper';
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await page.getByRole('button', { name: 'Favorite Fish voices' }).click();
  assert.equal(await page.locator('.lf-favorites').isVisible(), true, 'favorites stay available with Piper as default');
  await page.getByRole('button', { name: 'Find voice', exact: true }).click();
  await browserUI.getByRole('button', { name: 'Add Alice to favorites' }).click();
  await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).waitFor();
  await browserUI.getByRole('button', { name: 'Use Alice as default' }).click();
  await browserUI.waitFor({ state: 'detached' });
  assert.ok((await page.locator('#fish-default-voice option:checked').textContent()).includes('Alice'));
  assert.equal(await page.locator('.lf-favorites code').textContent(), 'alice');
  settings.provider = 'fish';
  role = 'admin'; await page.reload();
  await openBrowser();
  assert.equal(await browserUI.getByRole('button', { name: 'Test voice Alice', exact: true }).isDisabled(), true);
  assert.equal(await browserUI.getByRole('button', { name: 'Use Alice as default', exact: true }).first().isDisabled(), true);
  app.language = 'es';
  await page.evaluate(() => localStorage.setItem('userLanguage', 'es'));
  await page.reload();
  await page.getByRole('button', { name: 'Buscar voz', exact: true }).click();
  await browserUI.getByRole('heading', { name: 'Alice', exact: true }).waitFor();
  await browserUI.getByRole('button', { name: 'Filtros', exact: true }).click();
  await dialog.screenshot({ path: '/tmp/saas-fish-mobile-spanish.png' });
  assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false, 'Spanish modal fits mobile');
  const spanishAxe = await new AxeBuilder({ page }).include('app-fish-voice-browser').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(spanishAxe.violations.map(v => v.id), [], 'Spanish modal accessibility');
  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('Fish browser passed: mobile/desktop modal, focus/scroll/close behavior, accessibility, filters, saved selection, websocket preview, replay, billing/error states, read-only access.');
} catch (error) { console.log('Browser failure:', error); console.log({ url: page.url(), body: (await page.locator('body').innerText().catch(()=>'' )).slice(0,2500), errors }); throw error; } finally { await browser.close(); }
