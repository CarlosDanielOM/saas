import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function open(path, { theme = 'dark', width = 1280, lang = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, lang }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', lang); }, { theme, lang });
  await context.routeWebSocket(/./, ws => ws.close());
  // Mocks must never need the API: answer any API call with an empty envelope.
  await context.route('https://api.domdimabot.com/**', route => route.fulfill({ json: { error: false, status: 200, data: {} } }));
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', e => errors.push(`${path}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text())) errors.push(`${path}: ${m.text()}`); });
  await page.goto(base + path);
  return { context, page };
}
async function axe(page, selector, label) {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate(sel => window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }), selector);
  assert.deepEqual(r.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
const hosts = { '/mocks/dev/landing-next': 'app-landing-next-mock', '/mocks/dev/dashboard-refresh': 'app-dashboard-refresh-mock', '/mocks/dev/dashboard-studio': 'app-dashboard-studio-mock' };
try {
  {
    // Landing: honest empty live tile with a chat demo; "Someone live" shows the board; plan cues are computed.
    const { context, page } = await open('/mocks/dev/landing-next');
    await page.getByRole('list', { name: 'Example chat' }).waitFor();
    await page.getByRole('button', { name: 'Someone live' }).click();
    await page.getByText('NovaPlays', { exact: true }).waitFor();
    await page.getByText('4 live · 2.4k viewers').waitFor();
    assert.equal(await page.getByText('Most popular').count(), 0);
    await page.getByText('Most AI credits per dollar').waitFor();
    await page.getByText('32× Free\'s credits · 53k credits per $1').waitFor();
    assert.equal(await page.locator('.ln-feature').count(), 8);
    assert.match(await page.locator('.ln-feature').first().getAttribute('href'), /^https:\/\/docs\.domdimabot\.com\/moderation\/$/);
    await context.close();
  }
  {
    // Dashboard A: one bot control, plain answer, metric + range switches, goal pace.
    const { context, page } = await open('/mocks/dev/dashboard-refresh');
    await page.getByText(/Last stream Oct 1: 3h 12m with 46 average viewers\./).waitFor();
    await page.getByText("That's 12% above your 30-day average.").waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn the bot off' }).count(), 1, 'one bot control');
    await page.getByText(/run out in about 10 days, before the reset in 11 days/).waitFor();
    await page.getByText('66 to go, about 6 more streams at your pace.').waitFor();
    await page.getByRole('button', { name: '7d' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.srow').length === 3);
    await page.getByRole('button', { name: 'New followers' }).click();
    await page.getByRole('button', { name: /^Sep 29: 27 follows$/ }).focus();
    await page.locator('.tc__tip').getByText('27').waitFor();
    await page.getByRole('button', { name: 'Turn the bot off' }).click();
    await page.getByText(/The bot isn't in your chat/).first().waitFor();
    await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Live' }).click();
    await page.getByText('This stream').waitFor();
    await context.close();
  }
  {
    // Dashboard B: checklist answers "am I ready?", fixes update it; live mode actions respond.
    const { context, page } = await open('/mocks/dev/dashboard-studio');
    await page.getByText('Almost ready: 2 things to check before you go live.').waitFor();
    await page.getByRole('button', { name: 'Copy OBS link' }).click();
    await page.getByText('Almost ready: 1 thing to check before you go live.').waitFor();
    await page.getByText('4 of 5 ready').waitFor();
    await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Live' }).click();
    await page.getByText('58 watching right now.').waitFor();
    await page.getByRole('button', { name: 'Shout out pixel_pancho' }).click();
    await page.getByText('Shouted out').waitFor();
    await page.getByRole('button', { name: 'Pause' }).first().click();
    await page.getByText('Paused, messages wait in line').waitFor();
    await context.close();
  }
  {
    // Spanish strings resolve (no raw keys).
    for (const path of Object.keys(hosts)) {
      const { context, page } = await open(path, { lang: 'es' });
      await page.locator(hosts[path]).waitFor(); await page.waitForTimeout(300);
      assert.doesNotMatch(await page.locator(hosts[path]).innerText(), /devMocks\.|\{\{/, `es keys ${path}`);
      await context.close();
    }
  }
  for (const path of Object.keys(hosts)) for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page } = await open(path, { theme, width });
    await page.locator(hosts[path]).waitFor(); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${path} ${theme} ${width}`);
    await axe(page, hosts[path], `axe ${path} ${theme} ${width}`);
    const name = path.split('/').pop();
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}-${theme}-${width}.png`, fullPage: true }); }
    if (path !== '/mocks/dev/landing-next') {
      await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Live' }).click();
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow live ${path} ${theme} ${width}`);
      await axe(page, hosts[path], `axe live ${path} ${theme} ${width}`);
      if (shots && width !== 320) await page.screenshot({ path: `${shots}/${name}-live-${theme}-${width}.png`, fullPage: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS dev mocks: landing-next (chat demo when nobody is live, simulated live board, computed plan cues, 8 docs-linked features), dashboard A (plain answers, one bot control, credit forecast, goal pace, metric/range chart with keyboard tooltip, bot-off and live states), dashboard B (go-live checklist that updates, live feed actions, TTS pause), Spanish strings, axe + no overflow at 320/390/1280 in dark and light (offline and live).');
} finally { await browser.close(); }
