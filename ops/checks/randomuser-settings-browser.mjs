// Shared randomuser exclusions: all APIs are mocked; never writes to a live channel.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const channelID = '999991';

async function open(browser, { width = 390, theme = 'dark', lang = 'en', canManage = true, failLoad = false, failSave = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const user = { id: channelID, login: 'test', display_name: 'Test' };
  const app = { name: 'Test', email: 'test@example.invalid', language: lang, plan_tier: 'premium', actived: true,
    chat_enabled: true, twitch_user_id: channelID, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  await context.addInitScript(({ user, app, lang, theme }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('dimasite.language', lang);
    localStorage.setItem('userLanguage', lang);
    localStorage.setItem('theme', theme);
    sessionStorage.clear();
  }, { user, app, lang, theme });
  await context.routeWebSocket(/.*/, ws => ws.close());
  const writes = [];
  let reads = 0;
  let saved = ['nightbot'];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/users') data = { id: channelID, username: 'test', display_name: 'Test' };
    else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: url.searchParams.get('permission')?.endsWith(':manage') ? canManage : true };
    else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'premium' };
    else if (url.pathname.endsWith('/randomuser-settings')) {
      if (request.method() === 'PUT') {
        writes.push(request.postDataJSON());
        if (failSave && writes.length === 1) return route.fulfill({ status: 500, json: { error: true } });
        saved = request.postDataJSON().blacklist;
      } else {
        reads++;
        if (failLoad && reads === 1) return route.fulfill({ status: 500, json: { error: true } });
      }
      return route.fulfill({ json: { error: false, status: 200, blacklist: saved } });
    } else if (url.pathname.startsWith('/commands/')) data = { commands: [] };
    else if (url.pathname.startsWith('/timers/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/test/commands`);
  await page.locator('app-commands-page h1').waitFor();
  if (canManage) {
    await page.locator('app-randomuser-settings summary').click();
  } else {
    await page.locator('.lf-chip--warn').waitFor();
  }
  return { page, context, writes, errors };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // Normalization, validation, empty-list removal, and failed-save draft retention.
  {
    const { page, context, writes, errors } = await open(browser, { failSave: true });
    const root = page.locator('app-randomuser-settings');
    const input = root.getByRole('textbox');
    await input.waitFor();
    assert.equal(await input.inputValue(), 'nightbot');
    await input.fill('@Nightbot, Bot_2\nBOT_2');
    await root.getByRole('button', { name: 'Save exclusions', exact: true }).click();
    await root.getByRole('alert').filter({ hasText: "Couldn't save" }).waitFor();
    assert.equal(await input.inputValue(), '@Nightbot, Bot_2\nBOT_2');
    assert.deepEqual(writes[0], { blacklist: ['nightbot', 'bot_2'] });
    await root.getByRole('button', { name: 'Save exclusions', exact: true }).click();
    await root.getByRole('status').filter({ hasText: 'All changes saved' }).waitFor();
    assert.equal(await input.inputValue(), 'nightbot\nbot_2');
    await input.fill('https://twitch.tv/bot');
    await root.getByRole('button', { name: 'Save exclusions', exact: true }).click();
    await root.getByRole('alert').filter({ hasText: 'Use Twitch usernames' }).waitFor();
    assert.equal(writes.length, 2, 'invalid usernames never reach API');
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    await input.fill(Array.from({ length: 201 }, (_, i) => `bot${i}`).join(' '));
    await root.getByRole('button', { name: 'Save exclusions', exact: true }).click();
    await root.getByRole('alert').filter({ hasText: 'up to 200' }).waitFor();
    assert.equal(writes.length, 2, 'oversized list never reaches API');
    await input.fill('');
    await root.getByRole('button', { name: 'Save exclusions', exact: true }).click();
    await root.getByRole('status').filter({ hasText: 'All changes saved' }).waitFor();
    assert.deepEqual(writes[2], { blacklist: [] }, 'empty list clears shared exclusions');
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, context, writes } = await open(browser, { failLoad: true });
    const root = page.locator('app-randomuser-settings');
    await root.getByRole('alert').filter({ hasText: "Couldn't load" }).waitFor();
    assert.equal(await root.getByRole('textbox').count(), 0, 'failed reads cannot overwrite saved settings');
    await root.getByRole('button', { name: 'Retry', exact: true }).click();
    await root.getByRole('textbox').waitFor();
    assert.equal(await root.getByRole('textbox').inputValue(), 'nightbot');
    assert.equal(writes.length, 0);
    await context.close();
  }
  {
    const { page, context } = await open(browser, { canManage: false });
    assert.equal(await page.locator('app-randomuser-settings').count(), 0, 'view-only users cannot edit shared settings');
    await context.close();
  }
  // Mobile and desktop, starting in dark, plus Spanish parity and focused accessibility.
  for (const theme of ['dark', 'light']) {
    for (const width of [320, 390, 1280]) {
      const lang = width === 390 ? 'es' : 'en';
      const { page, context, errors } = await open(browser, { width, theme, lang });
      const root = page.locator('app-randomuser-settings');
      await root.getByRole('textbox').waitFor();
      if (lang === 'es') await root.getByText('Nombres de usuario de Twitch excluidos', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow ${width} ${theme}`);
      const results = await new AxeBuilder({ page }).include('app-randomuser-settings').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(results.violations.map(v => v.id), [], `axe ${width} ${theme}`);
      if (process.env.SAAS_SHOTS_DIR) {
        await root.screenshot({ path: `${process.env.SAAS_SHOTS_DIR}/randomuser-${width}-${theme}.png` });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log('PASS randomuser settings: normalization, validation, save failure/retry, clear, load failure/retry, permissions, EN/ES, mobile/desktop dark/light, axe');
} finally {
  await browser.close();
}
