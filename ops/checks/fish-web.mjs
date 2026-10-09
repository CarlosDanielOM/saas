// Requires Playwright and @axe-core/playwright in SAAS_BROWSER_TOOLS (outside the production checkout).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-fish-browser-tools') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4207';
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp';
const browserEnv = { ...process.env };
const localLibraries = process.env.SAAS_BROWSER_LIBS || '/tmp/saas-fish-browser-libs';
if (fs.existsSync(localLibraries + '/fonts.conf')) {
  browserEnv.FONTCONFIG_FILE = localLibraries + '/fonts.conf';
  browserEnv.LD_LIBRARY_PATH = localLibraries + '/extracted/usr/lib/x86_64-linux-gnu';
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'], env: browserEnv });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('crash', () => console.log('Page crashed'));
const until = async (fn, message, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(50); }
  assert.fail(message);
};
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
const cover = id => `https://public-platform.r2.fish.audio/cdn-cgi/image/width=128/coverimage/${id}`;
const sample = (id, text) => ({ url: `https://platform.r2.fish.audio/task/${id}.mp3`, text });
const voices = [
  { id: 'a'.repeat(32), name: 'Alice', gender: 'female', languages: ['en'], licensed: true, uses: 2133484,
    description: 'A calm, warm narrator for long stories and late-night streams.', tags: ['calm', 'narration', 'warm'],
    coverUrl: cover('a'.repeat(32)), sample: sample('1'.repeat(32), 'Welcome back, chat. Grab a drink and get comfy.') },
  { id: 'b'.repeat(32), name: 'Bea', gender: 'female', languages: ['es'], licensed: false, uses: 48210,
    description: 'Energetic young voice with a bright, playful tone.', tags: ['energetic', 'young', 'playful'],
    coverUrl: cover('b'.repeat(32)), sample: sample('2'.repeat(32), '¡Hola, chat! ¿Listos para la partida de hoy?') },
  { id: 'c'.repeat(32), name: 'Carlos', gender: 'male', languages: ['es'], licensed: null, uses: null,
    description: '', tags: [], coverUrl: null, sample: null },
  ...Array.from({ length: 17 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: `Voice ${i + 4}`, gender: 'male', languages: ['en'],
    licensed: true, uses: 900 * (i + 1), description: 'Announcer voice for hype moments.', tags: ['announcer'],
    coverUrl: i % 3 ? cover(String(i).padStart(32, '0')) : null, sample: sample(String(i).padStart(32, '9'), 'Let’s go!') }))
];
let previews = 0;
let previewFail = false;
let searchQueries = [];
let sampleRequests = [];
let favorites = [];
let lastPreviewBody;
const tone = (seconds, rate = 8000) => {
  const samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 8) * 2000), 44 + i * 2);
  return wav;
};
// Generated locally. No provider synthesis, Fish CDN traffic or live credits.
const wav = tone(0.1);
const sampleWav = tone(4);
const coverSvg = id => {
  const hue = parseInt(id.slice(0, 6), 16) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,35%)"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><circle cx="64" cy="52" r="22" fill="rgba(255,255,255,.55)"/><rect x="28" y="82" width="72" height="40" rx="20" fill="rgba(255,255,255,.4)"/></svg>`;
};
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
  if (url.hostname === 'public-platform.r2.fish.audio') {
    return route.fulfill({ contentType: 'image/svg+xml', body: coverSvg(url.pathname.split('/').at(-1)) });
  }
  if (url.hostname === 'platform.r2.fish.audio') {
    sampleRequests.push(url.pathname);
    return route.fulfill({ contentType: 'audio/wav', body: sampleWav });
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
    const pageNumber = Number(url.searchParams.get('page'));
    const matches = voices.filter(v => v.name.toLowerCase().includes(name.toLowerCase()) &&
      (gender === 'all' || gender === v.gender) && (lang === 'all' || v.languages.includes(lang)) &&
      (license === 'all' || v.licensed === (license === 'licensed')));
    data = { items: matches.slice((pageNumber - 1) * 12, pageNumber * 12), page: pageNumber, hasMore: matches.length > pageNumber * 12 };
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
  const rows = browserUI.locator('.voice-row:not(.voice-row--skeleton)');
  const row = name => rows.filter({ has: page.getByRole('heading', { name, exact: true }) });
  const chip = name => browserUI.getByRole('button', { name, exact: true });
  const openBrowser = async (waitFor = 'Bea') => {
    await page.getByRole('button', { name: 'Find voice', exact: true }).click();
    await browserUI.getByRole('heading', { name: waitFor, exact: true }).waitFor();
  };
  await page.getByRole('button', { name: 'Find voice', exact: true }).waitFor();
  assert.equal(await browserUI.count(), 0, 'catalog stays out of the settings page');
  assert.equal(searchQueries.length, 0, 'catalog is fetched only when opened');
  await page.setViewportSize({ width: 320, height: 640 });
  await openBrowser();

  // Opens on the channel's TTS language, with "Any language" one tap away.
  assert.ok(searchQueries[0].includes('language=es'), 'first search uses the channel language');
  assert.equal(await chip('Spanish').getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), 2);
  assert.equal(await browserUI.getByRole('heading', { name: 'Alice', exact: true }).count(), 0);
  assert.equal(await browserUI.getByRole('button', { name: 'Show more voices' }).count(), 0, 'no load-more without more results');
  await chip('Any language').click();
  await browserUI.getByRole('heading', { name: 'Alice', exact: true }).waitFor();
  assert.ok(searchQueries.at(-1).includes('language=all'));

  // Favorites.
  await browserUI.getByRole('button', { name: 'Add Alice to favorites' }).click();
  await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).waitFor();
  assert.equal(await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.lf-favorites code').textContent(), 'alice');
  assert.ok((await page.locator('#fish-default-voice').textContent()).includes('Alice'));

  // Free samples play Fish's own clip without a paid preview.
  assert.equal(await row('Alice').locator('img').getAttribute('src'), cover('a'.repeat(32)));
  assert.equal(await row('Carlos').getByRole('button', { name: /free sample/i }).count(), 0, 'no sample button without a sample');
  await browserUI.getByRole('button', { name: 'Play free sample of Alice' }).click();
  await browserUI.getByRole('button', { name: 'Pause sample of Alice' }).waitFor();
  await until(() => sampleRequests.some(p => p.includes('1'.repeat(32))), 'sample audio requested from Fish CDN');
  assert.equal(previews, 0, 'free sample must not start a paid preview');
  await until(() => row('Alice').locator('.voice-row__progress').evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--pct')) > 0), 'sample progress advances');
  await dialog.screenshot({ path: `${shots}/saas-fish-sample-320.png` });
  await browserUI.getByRole('button', { name: 'Pause sample of Alice' }).click();
  await browserUI.getByRole('button', { name: 'Play free sample of Alice' }).waitFor();
  await browserUI.getByRole('button', { name: 'Play free sample of Bea' }).click();
  await browserUI.getByRole('button', { name: 'Pause sample of Bea' }).waitFor();
  assert.equal(await browserUI.locator('.voice-row.is-playing').count(), 1, 'only one sample plays at a time');

  // Row details: description, sample text, licence and the paid test.
  await browserUI.getByRole('button', { name: 'Alice', exact: true }).click();
  await until(async () => await browserUI.getByRole('button', { name: 'Alice', exact: true }).getAttribute('aria-expanded') === 'true', 'row expands');
  await row('Alice').getByText('Welcome back, chat.', { exact: false }).waitFor();
  await row('Alice').getByText('secured rights', { exact: false }).waitFor();
  await row('Alice').getByText('up to 150 AI credits', { exact: false }).waitFor();
  await dialog.screenshot({ path: `${shots}/saas-fish-expanded-320.png` });

  for (const [width, theme] of [[320, 'dark'], [390, 'dark'], [1280, 'dark'], [320, 'light'], [390, 'light'], [1280, 'light']]) {
    await page.evaluate(theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.setAttribute('data-theme', theme); }, theme);
    await page.setViewportSize({ width, height: width < 640 ? 700 : 900 });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= page.viewportSize().height + 1, 'modal fits viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal overflow');
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false, 'dialog overflow');
    const use = await browserUI.getByRole('button', { name: 'Use Alice as default' }).boundingBox();
    assert.ok(use && use.x + use.width <= bounds.x + bounds.width, 'Use button visible inside the dialog');
    assert.notEqual(await browserUI.getByRole('button', { name: 'Use Alice as default' }).evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'Use button is filled');
    await dialog.screenshot({ path: `${shots}/saas-fish-${width}-${theme}.png` });
    const axe = await new AxeBuilder({ page }).include('app-fish-voice-browser').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n=>n.target) })), [], `voice browser accessibility ${width} ${theme}`);
  }
  await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.setViewportSize({ width: 320, height: 640 });

  // Internal scrolling and loading more results.
  const body = browserUI.locator('.voice-body');
  const scrollY = await page.evaluate(() => window.scrollY);
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.ok(await body.evaluate(el => el.scrollTop > 0), 'results scroll internally');
  assert.equal(await page.evaluate(() => window.scrollY), scrollY, 'background does not scroll');
  assert.equal(await rows.count(), 12);
  await browserUI.getByRole('button', { name: 'Show more voices' }).click();
  await until(async () => await rows.count() === 20, 'next page is appended');
  assert.ok(searchQueries.at(-1).includes('page=2'));
  assert.equal(await browserUI.getByRole('button', { name: 'Show more voices' }).count(), 0);
  assert.ok(await body.evaluate(el => el.scrollTop > 0), 'loading more keeps the scroll position');

  // Keyboard and dismissal.
  assert.equal(await browserUI.getByRole('button', { name: 'Close voice browser' }).isVisible(), true);
  await browserUI.getByRole('button', { name: 'Close voice browser' }).focus();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(i < 40 ? 'Tab' : 'Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true, 'focus remains in modal');
  }
  await browserUI.getByRole('button', { name: 'Play free sample of Alice' }).click();
  await browserUI.getByRole('button', { name: 'Pause sample of Alice' }).waitFor();
  await page.evaluate(() => { window.fishSampleAudio = document.querySelector('app-fish-voice-browser dialog > audio'); window.fishSampleAudio.loop = true; });
  assert.equal(await page.evaluate(() => window.fishSampleAudio.paused), false, 'sample still playing before close');
  await page.keyboard.press('Escape');
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fishSampleAudio.paused), true, 'closing stops the free sample');
  assert.equal(await page.getByRole('button', { name: 'Find voice', exact: true }).evaluate(el => document.activeElement === el), true, 'focus returns to opener');
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
  await openBrowser();
  await page.mouse.click(5, 5);
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await browserUI.count(), 0, 'backdrop closes modal');
  const picker = page.locator('.lf-voice-picker__controls');
  await picker.scrollIntoViewIfNeeded();
  const selectBounds = await picker.locator('select').boundingBox();
  assert.ok(selectBounds.x >= 0 && selectBounds.x + selectBounds.width <= 320, 'default dropdown fits mobile width');
  const findBounds = await page.getByRole('button', { name: 'Find voice', exact: true }).boundingBox();
  assert.ok(findBounds.x >= 0 && findBounds.x + findBounds.width <= 320, 'favorite browser button fits mobile width');

  // Search and chip filters.
  await openBrowser();
  await chip('Any language').click();
  await browserUI.getByLabel('Search by name').fill('Alice');
  await until(async () => await rows.count() === 1, 'name search');
  await browserUI.getByLabel('Search by name').fill('');
  await chip('Female').click();
  await chip('Spanish').click();
  await until(async () => searchQueries.at(-1).includes('gender=female') && searchQueries.at(-1).includes('language=es') && await rows.count() === 1, 'female + Spanish filter');
  await browserUI.getByRole('heading', { name: 'Bea', exact: true }).waitFor();
  await chip('Licensed only').click();
  await browserUI.getByText('No voices found').waitFor();
  assert.ok(searchQueries.at(-1).includes('license=licensed'));
  await browserUI.getByRole('button', { name: 'Clear filters' }).click();
  await browserUI.getByRole('heading', { name: 'Alice', exact: true }).waitFor();
  assert.equal(await chip('Licensed only').getAttribute('aria-pressed'), 'false');
  await chip('Spanish').click();
  await until(async () => await rows.count() === 2, 'Spanish filter');
  await browserUI.getByRole('button', { name: 'Use Bea as default', exact: true }).click();
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await browserUI.count(), 0, 'choosing returns to settings');
  assert.equal(await page.locator('#fish-default-voice option:checked').textContent(), 'Bea');
  await page.getByRole('button', { name: 'Save TTS settings', exact: true }).click();
  await until(() => settings.voices.cloneDefault === 'b'.repeat(32), 'settings saved');

  // Paid test lives in the voice's own details.
  await openBrowser();
  assert.equal(await row('Bea').getByText('In use').count(), 1, 'current voice\'s Use button says In use');
  assert.equal(await browserUI.getByRole('button', { name: 'Use Bea as default', exact: true }).isDisabled(), true);
  await browserUI.getByRole('button', { name: 'Bea', exact: true }).click();
  await row('Bea').getByText('may disappear at any time', { exact: false }).waitFor();
  await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).click();
  await row('Bea').locator('audio').waitFor();
  assert.equal(previews, 1); assert.equal(lastPreviewBody.voiceId, 'b'.repeat(32)); assert.equal(lastPreviewBody.language, 'es');
  await row('Bea').getByText('17 credits used', { exact: false }).waitFor();
  await row('Bea').locator('audio').scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: `${shots}/saas-fish-mobile-preview.png` });
  await row('Bea').locator('audio').evaluate(el => el.play());
  assert.equal(previews, 1, 'replay must not request synthesis');
  previewFail = true;
  await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).click();
  await browserUI.getByRole('alert').filter({ hasText: 'balance is too low' }).waitFor();
  assert.equal(await row('Bea').locator('audio').count(), 0);
  await browserUI.getByLabel('Search by name').fill('outage');
  await browserUI.getByRole('alert').filter({ hasText: 'catalog didn’t respond' }).waitFor();
  assert.equal(await browserUI.getByLabel('Search by name').inputValue(), 'outage', 'search kept after an error');
  assert.equal(await browserUI.getByRole('button', { name: 'Try again' }).isVisible(), true);
  await browserUI.getByLabel('Search by name').fill('No match');
  await browserUI.getByText('No voices found').waitFor();
  await page.reload();
  assert.equal(await page.locator('.lf-favorites code').textContent(), 'alice', 'favorite persists across reload');
  await page.getByRole('button', { name: 'Remove Alice from favorites' }).first().click();
  await page.getByText('No favorites yet.').waitFor();
  assert.equal(await page.locator('.lf-favorites code').count(), 0);
  await openBrowser();
  assert.equal(await browserUI.locator('.voice-row.is-current h3').textContent(), 'Bea');
  previewFail = false;
  await browserUI.getByRole('button', { name: 'Bea', exact: true }).click();
  await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).click();
  await row('Bea').locator('audio').waitFor();
  await row('Bea').locator('audio').evaluate(el => { window.fishTestAudio = el; window.fishTestAudio.loop = true; return el.play(); });
  await browserUI.getByRole('button', { name: 'Close voice browser' }).click();
  await browserUI.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fishTestAudio.paused), true, 'closing stops playback');
  await openBrowser();
  assert.equal(await browserUI.locator('.voice-more audio').count(), 0, 'reopening has no stale preview');

  settings.provider = 'piper';
  await page.reload();
  await page.getByRole('button', { name: 'Favorite Fish voices' }).click();
  assert.equal(await page.locator('.lf-favorites').isVisible(), true, 'favorites stay available with Piper as default');
  await openBrowser();
  await chip('Any language').click();
  await browserUI.getByRole('button', { name: 'Add Alice to favorites' }).click();
  await browserUI.getByRole('button', { name: 'Remove Alice from favorites' }).waitFor();
  await browserUI.getByRole('button', { name: 'Use Alice as default' }).click();
  await browserUI.waitFor({ state: 'detached' });
  assert.ok((await page.locator('#fish-default-voice option:checked').textContent()).includes('Alice'));
  assert.equal(await page.locator('.lf-favorites code').textContent(), 'alice');

  // Read-only managers can still hear free samples, but cannot spend credits or change the voice.
  settings.provider = 'fish';
  role = 'admin'; await page.reload();
  await openBrowser();
  await browserUI.getByRole('button', { name: 'Bea', exact: true }).click();
  assert.equal(await browserUI.getByRole('button', { name: 'Test voice Bea', exact: true }).isDisabled(), true);
  assert.equal(await browserUI.getByRole('button', { name: 'Use Carlos as default', exact: true }).isDisabled(), true);
  assert.equal(await browserUI.getByRole('button', { name: 'Play free sample of Bea' }).isDisabled(), false);

  app.language = 'es';
  await page.evaluate(() => localStorage.setItem('userLanguage', 'es'));
  await page.reload();
  await page.getByRole('button', { name: 'Buscar voz', exact: true }).click();
  await browserUI.getByRole('heading', { name: 'Bea', exact: true }).waitFor();
  assert.equal(await chip('Español').getAttribute('aria-pressed'), 'true');
  await browserUI.getByRole('button', { name: 'Bea', exact: true }).click();
  await row('Bea').getByText('Una frase corta en español', { exact: false }).waitFor();
  await dialog.screenshot({ path: `${shots}/saas-fish-mobile-spanish.png` });
  assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false, 'Spanish modal fits mobile');
  const spanishAxe = await new AxeBuilder({ page }).include('app-fish-voice-browser').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(spanishAxe.violations.map(v => v.id), [], 'Spanish modal accessibility');
  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('Fish browser passed: free samples, channel-language default, chip filters, load more, row details, mobile/desktop modal, focus/scroll/close behavior, accessibility, saved selection, websocket preview, replay, billing/error states, read-only access, Spanish.');
} catch (error) { console.log('Browser failure:', error); console.log({ url: page.url(), body: (await page.locator('body').innerText().catch(()=>'' )).slice(0,2500), errors }); await page.screenshot({ path: `${shots}/saas-fish-failure.png` }).catch(() => {}); throw error; } finally { await browser.close(); }
