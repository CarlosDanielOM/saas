// es-MX translation pass (2026-11-06): Spanish UI shows Mexican Spanish, translated module/event names and
// page titles, and switches back to English live. Every API request is stubbed; nothing touches live data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });

// Live catalog names are English-only on the server; descriptions are bilingual.
const catalog = [
  ['stream.online', 'Stream Started', 'Announce when you go live.', 'Avisa cuando empiezas a transmitir.'],
  ['stream.offline', 'Stream Ended', 'Say goodbye when the stream ends.', 'Despídete cuando termina el stream.'],
  ['channel.ad_break.begin', 'Ad Break', 'Warn chat before ads.', 'Avisa al chat antes de los anuncios.'],
  ['channel.follow', 'Follows', 'Thank new followers.', 'Agradece a los nuevos seguidores.'],
  ['channel.subscribe', 'New subscriptions', 'Welcome new subscribers.', 'Da la bienvenida a nuevos suscriptores.']
].map(([type, name, EN, ES]) => ({ name, type, icon: 'Star', version: '1', condition: { broadcaster_user_id: 'user' }, releaseStage: 'stable',
  enabled: false, plan_tier: 'free', description: { EN, ES }, config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: 'Hi', canDisable: true }] }));

// Spain-only words and English leftovers that must not appear in Spanish pages.
const SPAIN = /(?<!\p{L})(ordenador(es)?|vídeos?|en directo|el directo|añadir|añade|gestionar|pulsa|rellena|enfadad[oa]|vosotros|podéis|tenéis)(?!\p{L})/iu;
const ENGLISH = /Chat Events|Chat Moderation|Stream Started|Stream Ended|Ad Break|Text to speech|Trigger alerts|Save changes/;

const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

async function open(path, { lang = 'es', theme = 'dark', width = 1280, loggedIn = true } = {}) {
  const app = { name: 'Viewer', language: lang, plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id,
    has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, lang, theme, loggedIn }) => {
    localStorage.setItem('userLanguage', lang);
    localStorage.setItem('dimasite.language', lang);
    localStorage.setItem('theme', theme);
    if (loggedIn) localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app, lang, theme, loggedIn });
  await context.routeWebSocket(/.*/, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/viewer/')) return route.fulfill({ response: await route.fetch({ url: base + (process.env.SAAS_DEV_PREVIEW ? '/index.html' : '/index.csr.html') }) });
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname === '/site/events') data = catalog;
    else if (url.pathname.startsWith('/eventsubs/')) data = [];
    else if (url.pathname.includes('/live-status')) data = { isLive: false };
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(`${path}: ${e.message}`));
  await page.goto(base + path);
  return { context, page };
}

async function noLeftovers(page, label) {
  const text = await page.locator('body').innerText();
  const spain = text.match(SPAIN); assert.equal(spain, null, `${label}: Spain Spanish "${spain?.[0]}"`);
  const english = text.match(ENGLISH); assert.equal(english, null, `${label}: English leftover "${english?.[0]}"`);
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'es-MX', `${label}: html lang`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: no horizontal overflow`);
}
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
const until = async (fn, label, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(r => setTimeout(r, 100)); } };

try {
  // 1) Modules hub: card names translated (was hardcoded "Chat Events", "Chat Moderation").
  for (const width of [390, 1280]) {
    const { context, page } = await open('/viewer/modules', { width });
    const visible = async names => { const text = await page.locator('body').innerText(); return names.every(n => text.split('\n').includes(n)); };
    await until(() => visible(['Eventos de chat', 'Moderación del chat', 'Triggers', 'Texto a voz', 'Defensa contra follows']), 'translated module names');
    await until(async () => (await page.title()) === 'Módulos | DomDimaBot', 'modules title');
    await noLeftovers(page, `modules ${width}`);
    await shot(page, `modules-es-dark-${width}`);
    await context.close();
  }

  // 2) Chat events: event names from the English-only catalog show in Spanish, with Spanish descriptions.
  for (const width of [390, 1280]) {
    const { context, page } = await open('/viewer/modules/chat-events', { width });
    for (const name of ['Inicio del stream', 'Fin del stream', 'Pausa publicitaria', 'Follows', 'Nuevas suscripciones'])
      await page.locator('app-event-card').getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('Avisa cuando empiezas a transmitir.').waitFor();
    await until(async () => (await page.title()) === 'Eventos de chat | DomDimaBot', 'chat events title');
    await noLeftovers(page, `chat-events ${width}`);
    await shot(page, `chat-events-es-dark-${width}`);

    if (width === 1280) {
      // 3) Live switch to English: names, title and lang follow without a reload.
      await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn')?.click());
      await page.locator('button:has(.auth-navbar__lang-icon)').first().click();
      await page.locator('app-event-card').getByRole('heading', { name: 'Stream Started', exact: true }).waitFor();
      await page.locator('app-event-card').getByRole('heading', { name: 'Ad Break', exact: true }).waitFor();
      await until(async () => (await page.title()) === 'Chat Events | DomDimaBot', 'english title after switch');
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
      await shot(page, 'chat-events-en-after-switch');
    }
    await context.close();
  }

  // 4) Light theme sanity on the modules hub (dark is the reference look).
  {
    const { context, page } = await open('/viewer/modules', { theme: 'light', width: 390 });
    await until(async () => (await page.locator('body').innerText()).includes('Eventos de chat'), 'light hub names');
    await noLeftovers(page, 'modules light');
    await shot(page, 'modules-es-light-390');
    await context.close();
  }

  // 5) Public landing in Spanish: pricing table "AI" cell is "IA", no Spain words.
  for (const width of [390, 1280]) {
    const { context, page } = await open('/', { width, loggedIn: false });
    await page.locator('.lf-matrix').first().waitFor();
    await until(async () => (await page.evaluate(() => document.documentElement.lang)) === 'es-MX', 'landing lang');
    const matrix = await page.locator('.lf-matrix').first().innerText();
    assert.match(matrix, /(?<!\p{L})IA(?!\p{L})/u, 'pricing matrix shows IA');
    assert.doesNotMatch(matrix, /(?<!\p{L})AI(?!\p{L})/u, 'pricing matrix has no English AI');
    await noLeftovers(page, `landing ${width}`);
    await shot(page, `landing-es-dark-${width}`);
    await context.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS es-mx translation: modules hub, chat events (+ live switch to English), landing; desktop + phone; dark + light');
} finally {
  await browser.close();
}
