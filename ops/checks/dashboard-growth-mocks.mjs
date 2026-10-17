// Behaviour check for the "How am I growing?" dashboard proposals:
// /mocks/dev/dashboard-pulse, /mocks/dev/dashboard-path, /mocks/dev/dashboard-coach.
// Mocks must never need the API; every call is answered with an empty envelope.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser/node_modules';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || `${tools}/playwright/index.mjs`);
const axePath = process.env.AXE_PATH || `${tools}/axe-core/axe.min.js`;
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function open(path, { theme = 'dark', width = 1280, lang = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, lang }) => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('userLanguage', lang);
  }, { theme, lang });
  await context.routeWebSocket(/./, (ws) => ws.close());
  await context.route('https://api.domdimabot.com/**', (route) => route.fulfill({ json: { error: false, status: 200, data: {} } }));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text())) errors.push(`${path}: ${m.text()}`); });
  await page.goto(base + path);
  return { context, page };
}

async function until(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate(() => window.axe.run(document.querySelector('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target).slice(0, 4) })), [], label);
}

async function layout(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
  const body = await page.locator('main').innerText();
  assert.doesNotMatch(body, /devMocks\.|dashboard\.quickActions/, `${label}: untranslated key on screen`);
}

const mocks = {
  pulse: { path: '/mocks/dev/dashboard-pulse', host: 'app-dashboard-pulse-mock', ready: /followers and \d+% more viewers in the last 30 days/ },
  path: { path: '/mocks/dev/dashboard-path', host: 'app-dashboard-path-mock', ready: 'Path to Partner · last 30 days' },
  coach: { path: '/mocks/dev/dashboard-coach', host: 'app-dashboard-coach-mock', ready: 'What grows your channel' }
};

try {
  // ---------------------------------------------------------------- Pulse
  {
    const { context, page } = await open(mocks.pulse.path);
    await page.getByText(mocks.pulse.ready).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn the bot off' }).count(), 1, 'one bot control');
    await page.getByText('Followers today').waitFor();
    await page.getByText(/^You gained \d+ in 30 days, \d+% (more|fewer) than the 30 days before\.$/).waitFor();

    // Switch metric: big label and best-streams title follow.
    await page.locator('.pz-card', { hasText: 'Avg viewers' }).click();
    await page.getByText('Average viewers · last 30 days').waitFor();
    await page.getByRole('heading', { name: 'Most viewers · 30 days' }).waitFor();
    assert.equal(await page.locator('.pt__row').count(), 3);

    // Range: 90 days.
    await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '90d' }).click();
    await page.getByText('Average viewers · last 90 days').waitFor();

    // Keyboard scrub: the big number shows that point, Enter on a stream opens it.
    const slider = page.getByRole('slider', { name: /Avg viewers over time/ });
    await slider.focus();
    await page.keyboard.press('Home');
    await until(async () => /^Avg viewers · [A-Z][a-z]{2} \d+/.test((await page.locator('.pz-big__label').innerText()).trim()), 'scrub label');
    const valuetext = await slider.getAttribute('aria-valuetext');
    assert.match(valuetext, /Avg viewers/);
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'That stream' }).waitFor();
    await page.keyboard.press('Escape');

    // Tapping a best stream selects it.
    await page.locator('.pt__row').first().click();
    await until(async () => (await page.locator('.pt__row').first().getAttribute('aria-pressed')) === 'true', 'top row selected');

    // History is tucked away but complete.
    await page.locator('.ph summary').click();
    assert.ok((await page.locator('.ph__row').count()) >= 30, '90-day history rows');

    // Free plan: one Follow Ledger upsell, credits warn with a forecast.
    await page.locator('.pz-card', { hasText: 'Followers' }).first().click();
    await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Free', exact: true }).click();
    await page.getByText(/Follow Ledger lists every follower/).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Upgrade' }).count(), 1, 'one upsell');
    await page.getByText(/At your pace you'll run out in ~\d+ days, (\d+ days|a day) before the reset\./).waitFor();

    // Goals say whether October will make it.
    await page.getByText(/On pace: about \d+ by Oct 31\./).first().waitFor();

    // Live strip + bot warning.
    await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Live', exact: true }).click();
    await page.getByRole('region', { name: 'Your stream right now' }).waitFor();
    await page.getByRole('button', { name: 'Turn the bot off' }).click();
    await page.getByText(/The bot isn't in your chat/).waitFor();
    await context.close();
  }

  // ----------------------------------------------------------------- Path
  {
    const { context, page } = await open(mocks.path.path);
    await page.getByText(mocks.path.ready).waitFor();
    await page.getByRole('heading', { name: '2 of 3 Partner goals done' }).waitFor();
    assert.equal(await page.locator('.pring').count(), 3);
    assert.equal(await page.locator('.pring--done').count(), 2);
    await page.getByText(/Average viewers is the last step: \d+ of 75\./).waitFor();
    await page.getByText(/you'd get there in about \d+ months/).waitFor();

    // Road: two passed milestones, you, three ahead with dates.
    assert.equal(await page.locator('.road__stop--passed').count(), 2);
    assert.equal(await page.locator('.road__stop--you').count(), 1);
    await page.getByText(/^Between [A-Z][a-z]{2} \d+ and [A-Z][a-z]{2} \d+$/).waitFor();

    // You vs you: every metric is scored once and the verdict matches.
    assert.equal(await page.locator('.pv__row').count(), 6);
    const wins = await page.locator('.pv__row[data-winner="now"]').count();
    const losses = await page.locator('.pv__row[data-winner="before"]').count();
    await page.getByText(`The last 30 days win ${wins}–${losses}.`).waitFor();

    // Records: six, fresh ones tagged.
    assert.equal(await page.locator('.trophy').count(), 6);
    assert.ok((await page.locator('.trophy__new').count()) >= 1);

    // Brand-new channel shows the Affiliate path with four goals.
    await page.getByRole('button', { name: 'Brand-new channel' }).click();
    await page.getByRole('heading', { name: /of 4 Affiliate goals done/ }).waitFor();
    assert.equal(await page.locator('.pring').count(), 4);
    await page.getByText('29 more followers to go.').waitFor();

    // Free plan: goal limit explained with one upgrade.
    await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Free', exact: true }).click();
    await page.getByText('Free includes 2 goals. Premium gets 3 and Pro 4.').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Upgrade' }).count(), 1, 'one upsell');
    await context.close();
  }

  // ---------------------------------------------------------------- Coach
  {
    const { context, page } = await open(mocks.coach.path);
    await page.getByText(mocks.coach.ready).waitFor();
    await page.getByText(/^You're growing: \d+% more viewers and \d+% more new followers/).waitFor();
    assert.equal(await page.locator('.ins').count(), 6, 'six insights on Pro');
    await page.getByText(/streams bring [\d.]+× the new followers of/).waitFor();
    await page.getByText(/Followers per hour peak at 3\.5–4\.5 h/).waitFor();
    await page.getByText(/Weeks with 4 or more streams brought [\d.]+× the followers/).waitFor();
    assert.equal(await page.locator('.vbar--top').count(), 2, 'two best days highlighted');
    assert.equal(await page.locator('.cal__week').count(), 14);

    // Ask your stats: answer appears and says what it cost.
    await page.getByRole('button', { name: 'Why was my best stream so good?' }).click();
    await page.getByText('3 credits used').waitFor();
    await page.getByText(/raided with \d+ viewers/).waitFor();

    // Free: three insights + one locked upsell card.
    await page.getByRole('group', { name: 'Mock preview' }).getByRole('button', { name: 'Free', exact: true }).click();
    await until(async () => (await page.locator('.ins--locked').count()) === 1, 'locked card');
    assert.equal(await page.locator('.ins:not(.ins--locked)').count(), 3);
    assert.equal(await page.getByRole('link', { name: 'Upgrade to see them' }).count(), 1);
    await context.close();
  }

  // Spanish copy renders from es.json.
  {
    const { context, page } = await open(mocks.coach.path, { lang: 'es' });
    await page.getByText('Qué hace crecer tu canal').waitFor();
    await layout(page, 'coach es');
    await context.close();
  }

  // Layout + axe for every mock at phone and desktop widths, dark first.
  for (const [name, m] of Object.entries(mocks)) {
    for (const theme of ['dark', 'light']) {
      for (const width of [320, 390, 1280]) {
        const { context, page } = await open(m.path, { theme, width });
        await page.getByText(m.ready).first().waitFor();
        await layout(page, `${name} ${theme} ${width}`);
        await axe(page, `${name} ${theme} ${width}`);
        if (shots && width !== 320) await page.screenshot({ path: `${shots}/${name}-${theme}-${width}.png`, fullPage: true });
        await context.close();
      }
    }
  }

  assert.deepEqual(errors, [], 'page errors');
  console.log('dashboard growth mocks: ok');
} finally {
  await browser.close();
}
