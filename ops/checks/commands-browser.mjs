// Commands pages (Live First): dashboard sections, built-in explanations, filters, search, switch rollback,
// keyword shortcut, view only; public page audiences, hidden-off, copy, avatar, es; axe at 320/390/1280.
// SAAS_BROWSER_TOOLS must contain Playwright + @axe-core/playwright. All API traffic is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SHOTS_DIR || '';
const channelID = '999991';
const avatar = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#7c3aed"/></svg>');

const c = (over) => ({ func: 'custom', cooldown: 10, userLevel: 1, userLevelName: 'everyone', enabled: true, reserved: false,
  description: 'No description provided.', channel: 'test', channelID, createdAt: '2026-01-01T00:00:00Z', message: '', ...over });
const fixtures = () => [
  c({ _id: 'discord', name: 'Discord', cmd: 'discord', message: 'Join us: discord.gg/example' }),
  c({ _id: 'speech', name: 'Speech Chat', cmd: 's', message: '$(tts $(user) says: &t)', cooldown: 0 }),
  c({ _id: 'socials', name: 'Socials', cmd: 'socials', message: 'Follow me everywhere!' }),
  c({ _id: 'hug', name: 'Hug', cmd: 'hug', message: '$(user) hugs &p1', userLevel: 5, userLevelName: 'vip' }),
  c({ _id: 'secret', name: 'Secret', cmd: 'secret', message: 'shh', enabled: false }),
  c({ _id: 'kw', name: 'Hello keyword', cmd: 'hola', message: 'Hola $(user)!', activation: 'keyword', keywordSettings: { matchMode: 'start' } }),
  c({ _id: 'b-so', name: 'shoutout', cmd: 'so', func: 'shoutout', reserved: true, userLevel: 7 }),
  c({ _id: 'b-poll', name: 'Create Poll', cmd: 'poll', func: 'poll', reserved: true, userLevel: 7 }),
  c({ _id: 'b-endpoll', name: 'End Poll', cmd: 'endpoll', func: 'endpoll', reserved: true, userLevel: 7 }),
  c({ _id: 'b-follow', name: 'Follow Age', cmd: 'followage', func: 'followage', reserved: true }),
  c({ _id: 'b-amor', name: 'amor', cmd: 'amor', func: 'amor', reserved: true }),
  c({ _id: 'b-clear', name: 'Clear Chat', cmd: 'clearchat', func: 'clearChat', reserved: true, userLevel: 7, enabled: false }),
  c({ _id: 'b-odd', name: 'Mystery Tool', cmd: 'mystery', func: 'someNewFunc', reserved: true, description: 'Does a new thing.' }),
];

async function open(browser, path, { tier = 'premium', canManage = true, width = 1280, height = 900, theme = 'light', lang = 'en', failPut = false, loggedIn = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
  const user = { id: channelID, login: 'test', display_name: 'Test' };
  const app = { name: 'Test', email: 'test@example.invalid', language: lang, plan_tier: tier, actived: true, chat_enabled: true,
    twitch_user_id: channelID, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  await context.addInitScript(({ user, app, lang, theme, loggedIn }) => {
    if (loggedIn) localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('dimasite.language', lang);
    localStorage.setItem('userLanguage', lang);
    localStorage.setItem('theme', theme);
    sessionStorage.clear();
  }, { user, app, lang, theme, loggedIn });
  await context.routeWebSocket(/.*/, ws => ws.close());
  const commands = fixtures();
  const writes = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const method = request.method();
    let data = {};
    if (url.pathname === '/users') data = { id: channelID, username: 'test', display_name: 'TestStreamer', profile_image_url: avatar };
    else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: url.searchParams.get('permission')?.endsWith(':manage') ? canManage : true };
    else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: tier };
    else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    else if (url.pathname.startsWith('/timers/')) data = [{ name: 'socials', frequency: 15, message: 'Follow me everywhere!', active: true }];
    else if (url.pathname.startsWith(`/commands/${channelID}`)) {
      const id = url.pathname.split('/')[3];
      if (method === 'PUT') {
        const body = request.postDataJSON();
        writes.push({ id, body });
        if (failPut) return route.fulfill({ status: 500, json: { error: true, message: 'nope' } });
        const index = commands.findIndex(x => x._id === id);
        commands[index] = { ...commands[index], ...body };
        data = { command: commands[index] };
      } else if (method === 'GET') {
        const activation = url.searchParams.get('activation');
        data = { commands: commands.filter(x => activation === 'all' || x.activation !== 'keyword') };
      }
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}${path}`);
  await page.evaluate(t => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  return { context, page, writes, errors };
}

async function axe(page, label, include) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), [], `axe ${label}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // 1. Dashboard: sections, explanations, filters, search.
  {
    const { context, page, writes, errors } = await open(browser, '/test/commands');
    const root = page.locator('app-commands-page');
    await root.getByRole('heading', { name: 'Commands', level: 1 }).waitFor();
    await root.locator('.lf-cmd-row').first().waitFor();
    await root.getByText('11 of 13 on').waitFor();
    assert.equal(await root.locator('.lf-url-input').inputValue(), `${new URL(base).origin}/commands/test`);

    const yours = root.locator('section.lf-group', { hasText: 'Your commands' });
    assert.equal(await yours.locator('.lf-cmd-row').count(), 5, 'custom commands incl. off and repeating');
    const speech = yours.locator('.lf-cmd-row', { hasText: '!s' }).filter({ hasText: 'Speech Chat' });
    assert.deepEqual(await speech.locator('.lf-reply code').allTextContents(), ['$(tts $(user) says: &t)'], 'reply functions highlighted');
    await speech.getByText('!s <text>').waitFor();
    await speech.getByText('No cooldown').waitFor();
    const hug = yours.locator('.lf-cmd-row', { hasText: 'Hug' });
    await hug.getByText('!hug <word 1>').waitFor();
    await hug.getByText('VIPs and above', { exact: false }).waitFor();
    await yours.locator('.lf-cmd-row', { hasText: 'Socials' }).getByText('Every 15 min').waitFor();
    await root.locator('section.lf-group', { hasText: 'Keywords' }).getByText('Replies when a message starts with “hola”').waitFor();

    const builtin = root.locator('section.lf-group', { hasText: 'Built-in' });
    const polls = builtin.locator('details', { hasText: 'Polls & predictions' });
    assert.equal(await polls.getAttribute('open'), null, 'built-in groups start folded');
    await polls.locator('summary').getByText('2 of 2 on').waitFor();
    await polls.locator('summary').click();
    const poll = polls.locator('.lf-cmd-row', { hasText: '!poll' }).first();
    await poll.getByText('Starts a poll.', { exact: false }).waitFor();
    await poll.getByText('!poll <question>;<option>/<option>;<seconds>').waitFor();
    assert.equal(await poll.getByRole('button', { name: /^Delete/ }).count(), 0, 'built-ins cannot be deleted');
    await builtin.locator('summary').filter({ hasText: /^Other/ }).click();
    await builtin.getByText('Does a new thing.').waitFor();
    assert.equal(await root.getByText('Reserved command').count(), 0, 'no more "Reserved command" placeholders');

    const rowCount = n => page.waitForFunction(n => document.querySelectorAll('app-commands-page .lf-cmd-row').length === n, n);
    await root.getByRole('button', { name: /^Keywords/ }).click();
    await rowCount(1);
    await root.getByRole('button', { name: /^Off/ }).click();
    await rowCount(2);
    assert.deepEqual((await root.locator('.lf-cmd-row h4').allTextContents()).sort(), ['Clear chat', 'Secret']);
    await root.getByRole('button', { name: /^Built-in/ }).click();
    await rowCount(7);
    await page.waitForFunction(() => [...document.querySelectorAll('app-commands-page details')].every(d => d.open));

    await root.getByRole('searchbox').fill('!shoutout');
    await root.getByText('Matches for “!shoutout”: 1').waitFor();
    await root.locator('.lf-cmd-row', { hasText: 'Shoutout' }).getByText('Built-in').waitFor();
    await root.getByRole('searchbox').fill('zzz');
    await root.getByText('Nothing matches.', { exact: false }).waitFor();
    await root.getByRole('searchbox').fill('');

    // Switch writes enabled:false.
    await root.getByRole('button', { name: /^All/ }).click();
    await root.getByRole('checkbox', { name: '!discord on', exact: true }).uncheck();
    await root.locator('.lf-cmd-row.lf-item--off', { hasText: 'Discord' }).waitFor();
    assert.deepEqual(writes.at(-1), { id: 'discord', body: { enabled: false } });

    // Edit names the command; New keyword opens on the Keyword tab.
    await root.getByRole('button', { name: 'Edit !s', exact: true }).click();
    const modal = page.locator('app-command-modal');
    assert.equal(await modal.locator('[formControlName="cmd"]').inputValue(), 's');
    await modal.getByRole('button', { name: 'Close' }).click();
    await root.getByRole('button', { name: 'New keyword' }).click();
    await modal.locator('#keyword-type-tab[aria-selected="true"]').waitFor();
    await page.keyboard.press('Escape');
    await root.getByRole('button', { name: 'New command' }).click();
    await modal.locator('#command-type-tab[aria-selected="true"]').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log('PASS dashboard sections, built-ins, filters, search, switch, editor entry points');
    await context.close();
  }

  // 2. Switch rolls back when saving fails.
  {
    const { context, page } = await open(browser, '/test/commands', { failPut: true });
    const root = page.locator('app-commands-page');
    const box = root.getByRole('checkbox', { name: '!discord on', exact: true });
    const failed = page.waitForResponse(r => r.request().method() === 'PUT' && r.status() === 500);
    await box.click({ force: true });
    await failed;
    await page.waitForFunction(() => {
      const input = [...document.querySelectorAll('.lf-cmd-row')].find(r => r.textContent.includes('!discord'))?.querySelector('.lf-switch input');
      return input?.checked === true && !input.disabled;
    }, null, { timeout: 5000 });
    console.log('PASS switch rollback');
    await context.close();
  }

  // 3. View only.
  {
    const { context, page } = await open(browser, '/test/commands', { canManage: false });
    const root = page.locator('app-commands-page');
    await root.locator('.lf-cmd-row').first().waitFor();
    await root.getByText('View only').waitFor();
    assert.equal(await root.getByRole('button', { name: 'New command' }).count(), 0);
    assert.equal(await root.locator('.lf-switch').count(), 0);
    console.log('PASS view only');
    await context.close();
  }

  // 4. Public page for viewers.
  {
    const { context, page, errors } = await open(browser, '/commands/test', { loggedIn: false });
    const root = page.locator('app-public-commands-page');
    await root.getByRole('heading', { name: "TestStreamer's chat commands", level: 1 }).waitFor();
    assert.equal(await root.locator('.lf-avatar img').getAttribute('src'), avatar);
    await root.locator('.lf-pub-row').first().waitFor();
    await root.getByText('10 commands').waitFor();
    assert.equal(await root.getByText('!secret').count(), 0, 'commands that are off are hidden');
    assert.equal(await root.getByText('hola').count(), 0, 'keywords are not listed as commands');
    const anyone = root.locator('details', { hasText: 'Anyone in chat can use these.' });
    assert.notEqual(await anyone.getAttribute('open'), null);
    assert.equal(await root.locator('details', { hasText: 'Moderation and stream tools.' }).getAttribute('open'), null, 'mod tools start folded');
    await anyone.getByText('Shows how long someone has followed the channel.').waitFor();
    await anyone.getByText('!followage [username]').waitFor();
    assert.equal(await anyone.getByText('No description provided.').count(), 0);
    await root.locator('details', { hasText: 'Only subscribers' }).getByText('VIPs and above', { exact: false }).waitFor();
    await root.getByRole('button', { name: 'Copy !discord' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '!discord');
    await root.getByText('Copied to clipboard').waitFor({ state: 'attached' });
    await root.getByRole('button', { name: /^Mods & the streamer/ }).click();
    await page.waitForFunction(() => {
      const all = document.querySelectorAll('app-public-commands-page details');
      return all.length === 1 && all[0].open;
    });
    await root.getByRole('button', { name: /^Mods & the streamer/ }).click();
    await root.getByRole('searchbox').fill('poll');
    await root.getByText('!poll <question>;<option>/<option>;<seconds>').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS public page');
    await context.close();
    const es = await open(browser, '/commands/test', { loggedIn: false, lang: 'es' });
    await es.page.getByRole('heading', { name: 'Comandos del chat de TestStreamer', level: 1 }).waitFor();
    await es.page.getByText('Muestra cuánto tiempo lleva alguien siguiendo el canal.').waitFor();
    await es.context.close();
    const dash = await open(browser, '/test/commands', { lang: 'es' });
    await dash.page.getByRole('heading', { name: 'Tus comandos' }).waitFor();
    await dash.page.getByText('!hug <palabra 1>').waitFor();
    await dash.context.close();
    console.log('PASS es');
  }

  // 5. Layout + accessibility.
  for (const [width, height, theme] of [[320, 720, 'light'], [390, 844, 'dark'], [390, 844, 'light'], [1280, 900, 'light'], [1280, 900, 'dark']]) {
    for (const [path, host] of [['/test/commands', 'app-commands-page'], ['/commands/test', 'app-public-commands-page']]) {
      const { context, page } = await open(browser, path, { width, height, theme, loggedIn: path !== '/commands/test' });
      await page.locator(`${host} .lf-item`).first().waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${path}: no horizontal scroll at ${width}px (${overflow})`);
      await page.locator(`${host} details`).evaluateAll(all => all.forEach(d => { d.open = true; }));
      await axe(page, `${path} ${width} ${theme}`, host);
      if (shots) await page.screenshot({ path: `${shots}/${host}-${width}-${theme}.png`, fullPage: true });
      console.log(`PASS layout + axe ${path} ${width}px ${theme}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
