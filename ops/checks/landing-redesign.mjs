// Behaviour check for the landing redesign proposal: /mocks/dev/landing-redesign.
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

const PATH = '/mocks/dev/landing-redesign';
const SNAPSHOT = { registeredUsers: 155, liveUsers: 0, authorizedAccounts: 73, totalMessages: 3076700, totalCommands: 4979, totalLiveViewers: 0, liveChannels: [] };
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function open({ theme = 'dark', width = 1280, lang = 'en', motion = 'reduce' } = {}) {
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
  await context.route('https://tadd.domdimabot.com/**', (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  // NG02955 (LCP hint) is dev-mode noise here: the check scrolls the lazy screenshot into view itself.
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text()) && !/NG02955/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + PATH);
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
  assert.doesNotMatch(body, /\b(redesign|stage|showcase|switch|start|plans|common|modules|nav|mock)\.[a-zA-Z]/, `${label}: untranslated key on screen`);
  const transparent = await page.evaluate(() => [...document.querySelectorAll('.lp-btn--primary')].filter((b) => b.offsetParent && getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)').length);
  assert.equal(transparent, 0, `${label}: invisible primary button`);
  const small = await page.evaluate(() => [...document.querySelectorAll('.lp-main button, .lp-main summary')]
    .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 43.5)
    .map((b) => `${b.textContent.trim().slice(0, 30)} (${Math.round(b.getBoundingClientRect().height)}px)`));
  assert.deepEqual(small, [], `${label}: touch targets under 44px`);
}

/** Scrolls the lazy phone screenshot into view and returns its file name once decoded. */
async function phoneImage(page) {
  const img = page.locator('.rd-phone__frame img');
  await img.scrollIntoViewIfNeeded();
  await until(async () => img.evaluate((el) => el.complete && el.naturalWidth > 0), 'dashboard screenshot loads');
  return img.evaluate((el) => new URL(el.currentSrc).pathname.split('/').pop());
}

const text = (page, sel) => page.locator(sel).first().innerText();

// 1. Phone + desktop, dark + light: layout, touch targets, axe, no raw keys.
for (const width of [320, 390, 1280]) {
  for (const theme of ['dark', 'light']) {
    const label = `${width} ${theme}`;
    const { context, page } = await open({ width, theme });
    await page.waitForTimeout(400);
    await layout(page, label);
    assert.equal(await phoneImage(page), 'dashboard-phone-en.jpg', `${label}: English dashboard screenshot`);
    // Phones swipe through the four cards (keyboard reachable); wider screens show them all in a grid.
    const strip = await page.locator('.rd-beyond').evaluate((el) => ({ scrolls: el.scrollWidth > el.clientWidth + 1, tab: el.getAttribute('tabindex') }));
    assert.deepEqual(strip, width < 640 ? { scrolls: true, tab: '0' } : { scrolls: false, tab: null }, `${label}: beyond-the-basics strip`);
    await axe(page, label);
    if (shots && width !== 320) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${shots}/redesign-${width}-${theme}.png`, fullPage: true });
    }
    await context.close();
  }
}

// 2. The stage plays features with the real overlays; the page makes no tip-page claim.
{
  const { context, page } = await open({ motion: 'no-preference' });
  const stage = page.locator('app-lp-stage section.st');
  await until(async () => (await stage.getAttribute('data-scene')) === 'alerts', 'starts on alerts');
  await until(async () => /NovaPlays followed/.test(await text(page, '.st__lines')), 'alert event in chat');
  assert.match(await text(page, 'main'), /3,076,700/, 'messages-handled total shown');
  assert.doesNotMatch(await text(page, 'main'), /155/, 'registered-user count is not shown');
  assert.equal(await page.locator('app-lp-live-strip section').count(), 0, 'no live strip when nobody is live');
  assert.doesNotMatch(await text(page, 'main'), /\btips?\b|PayPal/i, 'no tip page claims (the tip page is not a working product)');

  await page.locator('.st__tabs').getByRole('button', { name: 'Duels' }).click();
  await until(async () => (await page.locator('.st__screen app-duel-stage').count()) === 1, 'real duel arena appears', 8000);
  assert.match(await text(page, '.st__caption'), /Premium/, 'duels are labelled Premium');
  await page.locator('.st__tabs').getByRole('button', { name: 'Roulette' }).click();
  await until(async () => (await page.locator('.st__screen app-roulette-display').count()) === 1, 'real roulette display');

  await page.getByRole('button', { name: 'Someone live' }).click();
  await until(async () => (await page.locator('app-lp-live-strip section').count()) === 1, 'live strip appears');
  assert.match(await text(page, 'app-lp-live-strip'), /NovaPlays/);
  await axe(page, 'someone live');
  await context.close();
}

// 3. The picker: tapping tools updates what is covered and the summary.
{
  const { context, page } = await open({ width: 390 });
  const summary = page.locator('.rd-summary');
  assert.equal(await summary.innerText(), 'All 4 are covered here, 4 of them on the Free plan.');
  assert.match(await text(page, '.rd-rows'), /Unlimited commands & timers/);
  const uses = page.locator('.rd-uses');
  assert.equal(await uses.getByRole('button').count(), 7);
  assert.equal(await uses.getByRole('button', { name: 'A tip page' }).count(), 0, 'tip page is not offered as covered');
  await uses.getByRole('button', { name: 'Viewer games (duels, wheels)' }).click();
  await until(async () => /All 5 are covered/.test(await summary.innerText()), 'games picked');
  const games = page.locator('.rd-rows li', { hasText: 'Viewer games' });
  assert.match(await games.innerText(), /Roulette\s*Free/);
  assert.match(await games.innerText(), /Widgets\s*Premium/);
  for (const name of ['Chat commands & timers', 'Spam & link filters', 'On-stream alerts', 'Text to speech', 'Viewer games (duels, wheels)']) {
    await uses.getByRole('button', { name, exact: true }).click();
  }
  await until(async () => /Tap what you use today/.test(await summary.innerText()), 'nothing picked');
  assert.equal(await page.locator('.rd-rows').count(), 0);

  // Plans heading is computed from the real module catalog.
  assert.match(await text(page, '#rd-plans-title'), /^\d+ of \d+ modules are on the Free plan$/);
  await page.locator('.lp-faq summary').first().click();
  assert.match(await text(page, '.lp-faq details[open] p'), /25,000 AI credits/);
  assert.equal(await page.locator('.lp-faq details').count(), 5);
  await axe(page, 'after picker + faq');
  await context.close();
}

// 4. Spanish is Mexican Spanish and swaps the dashboard screenshot.
{
  const { context, page } = await open({ width: 390, theme: 'light' });
  await page.getByRole('button', { name: 'Cambiar a español' }).click();
  await until(async () => /en un solo bot/.test(await text(page, 'h1')), 'Spanish title');
  await layout(page, 'es 390');
  const body = await text(page, 'main');
  assert.doesNotMatch(body, /directo|añad|ordenador|\bmóvil\b|propina/i, 'Spain Spanish or tip wording on screen');
  assert.match(body, /celular/, 'Mexican Spanish copy');
  assert.match(await text(page, '.rd-summary'), /en el plan Gratis/);
  assert.equal(await phoneImage(page), 'dashboard-phone-es.jpg', 'Spanish dashboard screenshot');
  await axe(page, 'es 390 light');
  await context.close();
}

// 5. A plan button keeps the plan through login (intercepted).
{
  const { context, page } = await open({ width: 1280 });
  // Production bundles redirect to Twitch; development builds use the mock-login endpoint instead.
  let mockLogin = false;
  page.on('request', (r) => { if (r.url().includes('/auth/mock-login')) mockLogin = true; });
  await page.locator('[data-plan="premium"] .lp-btn').click();
  await until(async () => mockLogin || page.url().startsWith('https://id.twitch.tv/'), 'Twitch login starts', 8000);
  if (page.url().startsWith('https://id.twitch.tv/')) {
    await page.goBack();
    await page.locator('h1').waitFor();
  }
  assert.equal(await page.evaluate(() => Object.entries(sessionStorage).find(([, v]) => v === 'premium')?.[1] ?? null), 'premium', 'pending Premium plan kept');
  await context.close();
}

await browser.close();
assert.deepEqual(errors, [], 'page errors');
console.log('landing redesign OK');
