// Behaviour check for the three landing proposals:
// /mocks/dev/landing-showcase (see what it does), -switch (why switch), -start (get set up fast).
// Every API call is mocked; the site analytics snapshot returns fixed totals and no live channels.
// Twitch login is intercepted, so nothing leaves the browser.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser/node_modules';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || `${tools}/playwright/index.mjs`);
const axePath = process.env.AXE_PATH || `${tools}/axe-core/axe.min.js`;
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const only = process.env.LP_ONLY || '';

const SNAPSHOT = { registeredUsers: 155, liveUsers: 0, authorizedAccounts: 73, totalMessages: 3076700, totalCommands: 4979, totalLiveViewers: 0, liveChannels: [] };
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function open(path, { theme = 'dark', width = 1280, lang = 'en', motion = 'reduce' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: motion });
  await context.addInitScript(({ theme, lang }) => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('userLanguage', lang);
  }, { theme, lang });
  await context.routeWebSocket(/./, (ws) => ws.close());
  await context.route('https://api.domdimabot.com/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/config/site/analytics')) return route.fulfill({ json: { error: false, status: 200, data: SNAPSHOT } });
    if (url.includes('/stream')) return route.abort();
    return route.fulfill({ json: { error: false, status: 200, data: {} } });
  });
  await context.route('https://id.twitch.tv/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>twitch</title>' }));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text())) errors.push(`${path}: ${m.text()}`); });
  await page.goto(base + path);
  await page.locator('h1').first().waitFor();
  return { context, page };
}

async function until(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate(() => window.axe.run(document.querySelector('app-lp-chrome'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target).slice(0, 4) })), [], label);
}

async function layout(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
  const body = await page.locator('main').innerText();
  assert.doesNotMatch(body, /\b(stage|showcase|switch|start|plans|common|modules|nav|mock)\.[a-zA-Z]/, `${label}: untranslated key on screen`);
  const transparent = await page.evaluate(() => [...document.querySelectorAll('.lp-btn--primary')].filter((b) => b.offsetParent && getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)').length);
  assert.equal(transparent, 0, `${label}: invisible primary button`);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const pages = ['landing-showcase', 'landing-switch', 'landing-start'].filter((p) => !only || p.includes(only));

// 1. Every page: phone + desktop, dark + light: layout, axe, no raw keys.
for (const id of pages) {
  for (const width of [320, 390, 1280]) {
    for (const theme of ['dark', 'light']) {
      const label = `${id} ${width} ${theme}`;
      const { context, page } = await open(`/mocks/dev/${id}`, { width, theme });
      await page.waitForTimeout(400);
      await layout(page, label);
      await axe(page, label);
      if (shots && width !== 320) await page.screenshot({ path: `${shots}/${id}-${width}-${theme}.png`, fullPage: true });
      await context.close();
    }
  }
}

// 2. Showcase: the stage plays features; tabs pick one; real duel + roulette overlays render.
if (pages.includes('landing-showcase')) {
  const { context, page } = await open('/mocks/dev/landing-showcase', { motion: 'no-preference' });
  const stage = page.locator('app-lp-stage section.st');
  await until(async () => (await stage.getAttribute('data-scene')) === 'alerts', 'starts on alerts');
  await until(async () => /NovaPlays followed/.test(await text(page, '.st__lines')), 'alert event in chat');
  assert.match(await text(page, 'main'), /3,076,700/, 'messages-handled total shown');
  assert.equal(await page.locator('app-lp-live-strip section').count(), 0, 'no live strip when nobody is live');
  await until(async () => (await stage.getAttribute('data-scene')) === 'tts', 'tour advances to TTS', 14000);

  await page.getByRole('button', { name: 'Duels' }).click();
  await until(async () => (await stage.getAttribute('data-scene')) === 'duel', 'duel tab');
  assert.equal(await page.getByRole('button', { name: 'Play the tour' }).count(), 1, 'picking a tab pauses the tour');
  await until(async () => /!duel @lunatica_v/.test(await text(page, '.st__lines')), 'duel challenge in chat');
  await until(async () => (await page.locator('.st__screen app-duel-stage').count()) === 1, 'real duel arena appears', 8000);
  assert.match(await text(page, '.st__caption'), /Premium/, 'duels are labelled Premium');
  if (shots) await page.locator('section.st').screenshot({ path: `${shots}/showcase-duel.png` });

  await page.getByRole('button', { name: 'Roulette' }).click();
  await until(async () => (await page.locator('.st__screen app-roulette-display').count()) === 1, 'real roulette display');
  await until(async () => /The wheel says: \S+/.test(await text(page, '.st__lines')), 'roulette winner in chat', 12000);
  if (shots) await page.locator('section.st').screenshot({ path: `${shots}/showcase-roulette.png` });

  await page.getByRole('button', { name: 'Moderation' }).click();
  await until(async () => (await page.locator('.ln--removed').count()) === 1, 'scam message struck out', 6000);

  await page.getByRole('button', { name: 'Someone live' }).click();
  await until(async () => (await page.locator('app-lp-live-strip section').count()) === 1, 'live strip appears');
  assert.match(await text(page, 'app-lp-live-strip'), /NovaPlays/);
  await axe(page, 'showcase someone live');

  // Spanish
  await page.getByRole('button', { name: 'Cambiar a español' }).click();
  await until(async () => /en un solo bot/.test(await text(page, 'h1')), 'Spanish title');
  await layout(page, 'showcase es');
  await context.close();

  // Reduced motion: a picked scene shows its finished state, no autoplay.
  const rm = await open('/mocks/dev/landing-showcase', { motion: 'reduce' });
  assert.equal(await rm.page.getByRole('button', { name: 'Play the tour' }).count(), 1, 'reduced motion: tour not playing');
  await rm.page.getByRole('button', { name: 'Duels' }).click();
  await until(async () => / wins the duel\./.test(await text(rm.page, '.st__lines')), 'reduced motion: duel result shown');
  await rm.context.close();
}

// 3. Switch: picking tools updates what is covered and the summary.
if (pages.includes('landing-switch')) {
  const { context, page } = await open('/mocks/dev/landing-switch', { width: 390 });
  const summary = page.locator('.sw-summary');
  assert.equal(await summary.innerText(), 'All 4 are covered here, 4 of them on the Free plan.');
  assert.match(await text(page, '.sw-rows'), /Unlimited commands & timers/);
  await page.getByRole('button', { name: 'Viewer games (duels, wheels)' }).click();
  await until(async () => /All 5 are covered/.test(await summary.innerText()), 'games picked');
  const games = page.locator('.sw-rows li', { hasText: 'Viewer games' });
  assert.match(await games.innerText(), /Roulette\s*Free/);
  assert.match(await games.innerText(), /Widgets\s*Premium/);
  for (const name of ['Chat commands & timers', 'Spam & link filters', 'On-stream alerts', 'Text to speech', 'Viewer games (duels, wheels)']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  await until(async () => /Tap what you use today/.test(await summary.innerText()), 'nothing picked');
  assert.equal(await page.locator('.sw-rows').count(), 0);
  assert.match(await text(page, '#plans-title'), /16 of 20 modules are on the Free plan/);
  assert.match(await text(page, '.sw-proof'), /3,076,700[\s\S]*4,979[\s\S]*73/, 'proof band shows the strong totals');
  assert.doesNotMatch(await text(page, '.sw-proof'), /155/, 'registered-user count is not shown');
  await page.locator('.lp-faq summary').first().click();
  assert.match(await text(page, '.lp-faq details[open] p'), /25,000 AI credits/);
  await axe(page, 'switch after toggles');
  await context.close();
}

// 4. Start: goals change the steps and preview; the finder recommends a plan; plan CTA keeps the plan through login.
if (pages.includes('landing-start')) {
  const { context, page } = await open('/mocks/dev/landing-start', { width: 1280 });
  const steps = page.locator('.sg-steps');
  assert.match(await steps.innerText(), /Turn on Chat moderation/);
  assert.equal(await page.locator('.sg-preview section.st').getAttribute('data-scene'), 'moderation');
  await page.getByRole('button', { name: /Read messages aloud/ }).click();
  await until(async () => /Add the speech link to OBS/.test(await steps.innerText()), 'TTS steps');
  await until(async () => (await page.locator('.sg-preview section.st').getAttribute('data-scene')) === 'tts', 'TTS preview');
  assert.match(await text(page, '.sg-steps__head'), /About 7 minutes · all on the Free plan/);
  await page.getByRole('button', { name: /Games for chat/ }).click();
  await until(async () => /duels need Premium/.test(await text(page, '.sg-steps__head')), 'games note premium');

  const result = page.locator('.sg-result strong');
  assert.equal(await result.innerText(), 'Free covers everything you picked.');
  assert.equal(await page.locator('.plan--rec').getAttribute('data-plan'), 'free');
  await page.getByRole('group', { name: 'Do you want duels or a stream pet?' }).getByRole('button', { name: 'Yes' }).click();
  await until(async () => (await result.innerText()) === 'Premium fits: duels and the pet.', 'premium result');
  assert.equal(await page.locator('.plan--rec').getAttribute('data-plan'), 'premium');
  await page.getByRole('group', { name: /How much will the AI talk/ }).getByRole('button', { name: 'All the time' }).click();
  await until(async () => /^Pro fits: duels and the pet, 800,000 AI credits a month\.$/.test(await result.innerText()), 'pro result');
  assert.equal(await page.locator('.plan--rec').getAttribute('data-plan'), 'pro');

  const later = page.locator('.sg-group');
  assert.equal(await later.count(), 3);
  assert.equal(await page.locator('.sg-group li').count(), 20, 'every module listed once');
  await axe(page, 'start after finder');

  // Pro CTA: pending plan saved, then Twitch login (intercepted).
  // Production bundles redirect to Twitch; development builds use the mock-login endpoint instead.
  let mockLogin = false;
  page.on('request', (r) => { if (r.url().includes('/auth/mock-login')) mockLogin = true; });
  await page.locator('[data-plan="pro"] .lp-btn').click();
  await until(async () => mockLogin || page.url().startsWith('https://id.twitch.tv/'), 'Twitch login starts', 8000);
  if (page.url().startsWith('https://id.twitch.tv/')) {
    await page.goBack();
    await page.locator('h1').waitFor();
  }
  assert.equal(await page.evaluate(() => Object.entries(sessionStorage).find(([, v]) => v === 'pro')?.[1] ?? null), 'pro', 'pending Pro plan kept');
  await context.close();

  const phone = await open('/mocks/dev/landing-start', { width: 390, theme: 'light', lang: 'en' });
  await phone.page.getByRole('button', { name: 'Cambiar a español' }).click();
  await until(async () => /en unos 10 minutos/.test(await text(phone.page, 'h1')), 'Spanish start');
  await layout(phone.page, 'start es 390');
  await axe(phone.page, 'start es 390');
  await phone.context.close();
}

await browser.close();
assert.deepEqual(errors, [], 'page errors');
console.log(`landing proposals OK (${pages.join(', ')})`);
