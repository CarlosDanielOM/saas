// Behaviour check for the "channel + bot" dashboard proposals:
// /mocks/dev/dashboard-split, /mocks/dev/dashboard-widgets, /mocks/dev/dashboard-briefing.
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

const count = (page, sel) => page.locator(sel).count();
const waitCount = (page, sel, n, label) => until(async () => (await count(page, sel)) === n, `${label}: ${sel} = ${n}`);

async function axe(page, label, root = 'main') {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate((root) => window.axe.run(document.querySelector(root), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }), root);
  assert.deepEqual(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target).slice(0, 4) })), [], label);
}

async function layout(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
  const body = await page.locator('main').innerText();
  assert.doesNotMatch(body, /devMocks\.|moderation\.types|dashboard\.quickActions/, `${label}: untranslated key on screen`);
}

const preview = (page) => page.getByRole('group', { name: 'Mock preview' });

const mocks = {
  split: { path: '/mocks/dev/dashboard-split', ready: /habits to fix, found in your own streams/ },
  widgets: { path: '/mocks/dev/dashboard-widgets', ready: /tips to fix this week/ },
  briefing: { path: '/mocks/dev/dashboard-briefing', ready: /things to fix this week/ }
};

try {
  // ---------------------------------------------------------------- Split
  {
    const { context, page } = await open(mocks.split.path);
    await page.getByText(mocks.split.ready).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn the bot off' }).count(), 1, 'one bot control');
    // Quick buttons: the four most used modules, with this week's number.
    const quick = page.getByRole('navigation', { name: 'Most used modules' });
    assert.deepEqual(await quick.locator('.hm__name').allInnerTexts(), ['TTS', 'Chat events', 'Triggers', 'Moderation']);
    await quick.getByText('46 actions this week').waitFor();
    // Both panes on desktop; every bot card from the brief is there.
    for (const h of ['Bot status', 'AI credits', 'Automod', 'Sanctions', 'Top commands', 'Top emotes', 'Most watched games', 'Best days', 'Raids']) {
      await page.getByRole('heading', { name: h, exact: true }).waitFor();
    }
    await page.getByText('Automod acted on 46 messages.').first().waitFor();
    await page.getByText(/Valorant brings 49% of your watch time/).first().waitFor();
    assert.equal(await count(page, '.tip:not(.tip--locked)'), 5, 'five habit tips on Pro');
    await page.getByText(/Friday is your weakest day: Sunday streams bring [\d.]+× more new followers\./).waitFor();
    await page.getByText(/End your next stream with a raid to pixel_pancho/).waitFor();
    assert.equal(await count(page, '.hr__back--owed'), 3, 'three raids not returned');

    // Hide a tip from its card.
    await page.getByRole('button', { name: 'Hide the tip: Weakest day' }).click();
    await waitCount(page, '.tip:not(.tip--locked)', 4, 'tip hidden');
    await page.getByRole('button', { name: /Choose cards.*1 hidden/ }).waitFor();

    // Picker: bot status + credits are locked on; hiding a card is immediate.
    await page.getByRole('button', { name: /Choose cards/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose what you see' });
    await dialog.waitFor();
    assert.ok(await dialog.getByRole('checkbox', { name: /Bot status/ }).isDisabled(), 'bot status locked');
    assert.ok(await dialog.getByRole('checkbox', { name: /AI credits/ }).isChecked(), 'credits on');
    assert.ok(!(await dialog.getByRole('checkbox', { name: /Weakest day/ }).isChecked()), 'hidden tip unchecked');
    await dialog.getByRole('checkbox', { name: /Sanctions/ }).uncheck();
    await dialog.getByRole('checkbox', { name: /^Raids/ }).uncheck();
    await axe(page, 'split picker', 'dialog');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await until(async () => !(await dialog.isVisible()), 'picker closed');
    await waitCount(page, '.card[data-kind="sanctions"]', 0, 'sanctions hidden');
    assert.equal(await page.getByRole('heading', { name: 'Raids', exact: true }).count(), 0, 'raids hidden');

    // Choices survive a reload; Show everything brings them back.
    await page.reload();
    await page.getByText(mocks.split.ready).waitFor();
    await page.getByRole('button', { name: /Choose cards.*3 hidden/ }).click();
    await dialog.getByRole('button', { name: 'Show everything' }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await waitCount(page, '.tip:not(.tip--locked)', 5, 'tips back');
    await waitCount(page, '.card[data-kind="sanctions"]', 1, 'sanctions back');

    // Free: one tip + one upsell; credits warn with a forecast.
    await preview(page).getByRole('button', { name: 'Free', exact: true }).click();
    await waitCount(page, '.tip--locked', 1, 'locked tips');
    assert.equal(await count(page, '.tip:not(.tip--locked)'), 1);
    assert.equal(await page.getByRole('link', { name: 'Upgrade to see them' }).count(), 1, 'one upsell');
    await page.getByText(/At your pace you'll run out in ~\d+ days/).first().waitFor();

    // Bot off: the bot card and strip say so.
    await page.getByRole('button', { name: 'Turn the bot off' }).click();
    await page.getByText('Your bot is out of your chat.').waitFor();
    await context.close();
  }

  // Phones: tabs switch panes and the bot strip stays visible.
  {
    const { context, page } = await open(mocks.split.path, { width: 390 });
    await page.getByText(mocks.split.ready).waitFor();
    await page.locator('.strip').getByText('Bot in chat').waitFor();
    assert.ok(await page.getByRole('heading', { name: 'Most watched games' }).isVisible());
    assert.ok(!(await page.getByRole('heading', { name: 'Top emotes' }).isVisible()), 'bot pane hidden on channel tab');
    await page.getByRole('group', { name: 'Dashboard section' }).getByRole('button', { name: 'Your bot' }).click();
    await page.getByRole('heading', { name: 'Top emotes' }).waitFor({ state: 'visible' });
    assert.ok(!(await page.getByRole('heading', { name: 'Most watched games' }).isVisible()), 'channel pane hidden on bot tab');
    assert.ok(await page.locator('.strip').isVisible(), 'strip on bot tab');
    await context.close();
  }

  // -------------------------------------------------------------- Widgets
  {
    const { context, page } = await open(mocks.widgets.path);
    await page.getByText(mocks.widgets.ready).waitFor();
    assert.equal(await count(page, '.wd'), 8, 'default widgets');
    assert.equal(await count(page, '.gl'), 4, 'four small widgets');
    assert.equal(await page.getByRole('navigation', { name: 'Most used modules' }).locator('.hm__btn').count(), 4, 'dock shortcuts');

    // Small widget opens the full card in a sheet.
    await page.getByRole('button', { name: /^Automod: 46/ }).click();
    const detail = page.getByRole('dialog', { name: 'Automod' });
    await detail.getByText('Automod acted on 46 messages.').waitFor();
    await page.keyboard.press('Escape');
    await until(async () => !(await detail.isVisible()), 'detail closed');

    // Tip widget cycles through tips.
    await page.getByText('1 of 5').waitFor();
    await page.getByRole('button', { name: 'Next tip' }).click();
    await page.getByText('2 of 5').waitFor();

    // Edit mode.
    await page.getByRole('button', { name: 'Customize' }).click();
    await waitCount(page, '.wd__edit', 8, 'edit bars');
    assert.equal(await page.getByRole('button', { name: 'Remove Bot status' }).count(), 0, 'bot status cannot be removed');
    assert.equal(await page.getByRole('button', { name: 'Remove AI credits' }).count(), 0, 'credits cannot be removed');
    await page.getByRole('button', { name: 'Remove Top emotes' }).click();
    await waitCount(page, '.wd:not(.wd--add)', 7, 'removed');
    await page.getByRole('status').filter({ hasText: 'Top emotes removed' }).waitFor({ state: 'attached' });
    // Move "Most watched games" earlier and make it small.
    const kinds = () => page.locator('.wd:not(.wd--add)').evaluateAll((els) => els.map((e) => e.dataset.kind));
    const before = await kinds();
    await page.getByRole('button', { name: 'Move Most watched games earlier' }).click();
    await until(async () => (await kinds()).indexOf('games') === before.indexOf('games') - 1, 'moved');
    await page.getByRole('group', { name: 'Size of Most watched games' }).getByRole('button', { name: 'Small' }).click();
    await page.getByRole('button', { name: /^Most watched games: Valorant/ }).waitFor();
    // Add from the catalog.
    await page.getByRole('button', { name: /Add widget \(3 available\)/ }).click();
    const cat = page.getByRole('dialog', { name: 'Add widgets' });
    await cat.getByRole('button', { name: 'Add Raids' }).click();
    await waitCount(page, '.wd[data-kind="raids"]', 1, 'raids added');
    await axe(page, 'widgets catalog', 'dialog[open]');
    await cat.getByRole('button', { name: 'Done' }).click();
    // Dock: up to four shortcuts.
    const dock = page.getByRole('region', { name: 'Shortcuts' }).or(page.locator('.dockedit'));
    assert.ok(await dock.getByRole('button', { name: 'Duels' }).isDisabled(), 'fifth shortcut blocked');
    await dock.getByRole('button', { name: 'TTS' }).click();
    await dock.getByRole('button', { name: 'Duels' }).click();
    await until(async () => (await page.locator('nav .hm__name').allInnerTexts()).includes('Duels'), 'dock updated');
    await axe(page, 'widgets edit mode');
    // Preset.
    await page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: 'Moderation' }).click();
    await waitCount(page, '.wd:not(.wd--add)', 6, 'moderation preset');
    await page.getByRole('button', { name: 'Done' }).click();
    await waitCount(page, '.wd__edit', 0, 'edit closed');

    // Layout survives a reload.
    await page.reload();
    await page.getByText(mocks.widgets.ready).waitFor();
    await waitCount(page, '.wd', 6, 'saved layout');
    assert.ok((await page.locator('nav .hm__name').allInnerTexts()).includes('Duels'), 'saved dock');

    // Free: tips widget offers one upgrade.
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Reset' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await preview(page).getByRole('button', { name: 'Free', exact: true }).click();
    await page.getByText('4 more tips with Premium').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Upgrade to see them' }).count(), 1, 'one upsell');
    await context.close();
  }

  // ------------------------------------------------------------- Briefing
  {
    const { context, page } = await open(mocks.briefing.path);
    await page.getByText(mocks.briefing.ready).waitFor();
    await page.getByText(/Week of Oct 10 – Oct 16/).first().waitFor();
    await page.getByText(/5 streams, \d+ new followers \([+−]\d+% vs the week before\), and your bot handled 46 messages\./).waitFor();
    const health = page.getByRole('region', { name: 'Bot health' });
    await health.getByText('Bot in chat').waitFor();
    await health.getByText('Twitch events 11/11').waitFor();
    await health.getByRole('link', { name: 'Buy credits' }).waitFor();
    assert.equal(await count(page, '.fix:not(.fix--locked)'), 4, 'four fixes');
    assert.deepEqual(await page.locator('.fix__n').allInnerTexts(), ['1', '2', '3', '4']);

    // Hide a fix, then restore it.
    await page.getByRole('button', { name: 'Hide the tip: Short streams' }).click();
    await waitCount(page, '.fix:not(.fix--locked)', 3, 'fix hidden');
    await page.getByText('1 tip hidden.').waitFor();
    await page.getByRole('button', { name: 'Show them again' }).click();
    await waitCount(page, '.fix:not(.fix--locked)', 4, 'fix restored');

    // Topics: switch moderation off; it's remembered after reload.
    const topics = page.getByRole('group', { name: 'Show me' });
    await topics.getByRole('button', { name: 'Moderation' }).click();
    await until(async () => (await page.getByRole('heading', { name: 'Automod', exact: true }).count()) === 0, 'automod hidden');
    await page.reload();
    await page.getByText(mocks.briefing.ready).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Sanctions', exact: true }).count(), 0, 'topic remembered');
    // Every topic off: bot health still there, plus a clear empty state.
    for (const name of ['Tips', 'Games', 'Best days', 'Raids', 'Commands', 'Emotes']) await topics.getByRole('button', { name }).click();
    await page.getByText('Nothing to show. Pick a topic above.').waitFor();
    assert.ok(await health.isVisible(), 'bot health always shown');
    for (const name of ['Tips', 'Games', 'Best days', 'Raids', 'Moderation', 'Commands', 'Emotes']) await topics.getByRole('button', { name }).click();

    // Free: one fix + one upsell.
    await preview(page).getByRole('button', { name: 'Free', exact: true }).click();
    await waitCount(page, '.fix--locked', 1, 'locked fixes');
    assert.equal(await count(page, '.fix:not(.fix--locked)'), 1);
    assert.equal(await page.getByRole('link', { name: 'Upgrade to see them' }).count(), 1, 'one upsell');
    await context.close();
  }

  // Spanish copy renders from es.json.
  for (const [name, text] of [['split', /hábitos para mejorar/], ['widgets', /consejos para mejorar esta semana/], ['briefing', /cosas para mejorar esta semana/]]) {
    const { context, page } = await open(mocks[name].path, { lang: 'es', width: 390 });
    await page.getByText(text).waitFor();
    await layout(page, `${name} es`);
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
  console.log('dashboard hq mocks: ok');
} finally {
  await browser.close();
}
