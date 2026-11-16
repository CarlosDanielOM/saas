// TTS page, Voice tags card: the "Allow any tag" switch (filters.freeformTags) with its warning.
// Mocked session and API only: nothing reaches production.
// Requires Playwright and @axe-core/playwright in SAAS_BROWSER_TOOLS (outside the production checkout).
//   scripts/saas-ops verify site-<run> --check ops/checks/tts-free-tags-web.mjs
//   (or against a preview: SAAS_PREVIEW_URL=http://127.0.0.1:<port> node ops/checks/tts-free-tags-web.mjs)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4207';
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp';

const user = { id: '999991', login: 'test', display_name: 'Test' };
const app = { name: 'Test', email: 'test@example.invalid', language: 'en', plan_tier: 'premium', actived: true,
  chat_enabled: true, twitch_user_id: '999991', has_permissions: true, up_to_date_permissions: true, administrating: [] };
// An older saved document without `filters.freeformTags`: the page must treat it as off.
const initial = () => ({ channelID: '999991', channel: 'test', enabled: true, provider: 'fish', defaultLanguage: 'es',
  voices: { en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', cloneDefault: 'gojo', kokoroDefault: 'ef_dora' },
  filters: { skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 280, expressiveTags: {} },
  queue: { maxItems: 5 }, playback: { allOutputs: false } });

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
async function session(language) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(({ user, app, language }) => {
    localStorage.setItem('userLanguage', language);
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: user, appUser: { ...app, language }, permissions: {}
    }));
  }, { user, app, language });
  const state = { settings: initial(), puts: [], role: 'owner' };
  await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname === '/test/modules/tts') return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/users') data = { id: '999991', username: 'test' };
    else if (url.pathname === '/auth/session') data = { twitch: user, app: { ...app, language } };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: state.role };
    else if (url.pathname === '/speech/settings/999991') {
      if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); state.puts.push(body); state.settings = body; }
      data = { role: state.role, settings: state.settings };
    } else if (url.pathname === '/speech/999991/status') data = { connected: false, playing: false, preparing: false, queueLength: 0 };
    else if (url.pathname === '/speech/favorites/999991') data = [];
    else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  return { context, page, errors, state };
}
const theme = (page, name) => page.evaluate(value => {
  document.documentElement.classList.toggle('dark', value === 'dark'); document.documentElement.setAttribute('data-theme', value);
}, name);
const until = async (page, fn, message, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(50); }
  assert.fail(message);
};

try {
  // English: off by default, warning visible before turning it on, save sends true, reload keeps it.
  {
    const { context, page, errors, state } = await session('en');
    const card = page.locator('section[aria-labelledby="expressive-tags-title"]');
    const toggle = card.getByRole('checkbox', { name: /Allow any tag/ });
    await page.goto(base + '/test/modules/tts');
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false, 'off for a document without the field');
    assert.match(await card.locator('#tts-freeform-label').innerText(), /Experimental/);
    assert.match(await card.locator('#tts-freeform-hint').innerText(), /\[sad in a nervous voice\]/);
    const warning = card.locator('#tts-freeform-warning');
    assert.match(await warning.innerText(), /unwanted noises/);
    assert.equal(await warning.isVisible(), true, 'warning shows before turning it on');
    assert.equal(await toggle.getAttribute('aria-describedby'), 'tts-freeform-hint tts-freeform-warning');

    for (const name of ['dark', 'light']) {
      await theme(page, name);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: width < 640 ? 800 : 950 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow ${name} ${width}`);
        const axe = await new AxeBuilder({ page }).include('section[aria-labelledby="expressive-tags-title"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        if (axe.violations.length) console.log(JSON.stringify(axe.violations, null, 2));
        assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `axe ${name} ${width}`);
        await card.locator('.lf-freeform').scrollIntoViewIfNeeded();
        await card.locator('.lf-freeform').screenshot({ path: `${shots}/tts-free-tags-${name}-${width}.png` });
      }
    }
    await theme(page, 'dark');
    await page.setViewportSize({ width: 390, height: 900 });

    await toggle.check();
    await until(page, () => toggle.isChecked(), 'switch turns on');
    const save = page.getByRole('button', { name: 'Save TTS settings' });
    await until(page, () => save.isEnabled(), 'save enabled after the change');
    await save.click();
    await until(page, async () => state.puts.length === 1, 'one PUT');
    assert.equal(state.puts[0].filters.freeformTags, true);
    assert.equal(Object.keys(state.puts[0].filters.expressiveTags).length, 75, 'listed tags still sent');
    await card.locator('.lf-freeform').screenshot({ path: `${shots}/tts-free-tags-on-dark-390.png` });

    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true, 'stored value shows after reload');
    await toggle.uncheck();
    await until(page, () => save.isEnabled(), 'save enabled after turning off');
    await save.click();
    await until(page, async () => state.puts.length === 2, 'second PUT');
    assert.equal(state.puts[1].filters.freeformTags, false);

    // Viewers with tts:view see the switch but cannot change it.
    state.role = 'none';
    state.settings.filters.freeformTags = true;
    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await toggle.isDisabled(), true, 'read-only role cannot change it');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS en: off by default, warning, save on/off, reload, read-only, 320/390/1280 dark+light, axe');
  }
  // Mexican Spanish copy.
  {
    const { context, page, errors } = await session('es');
    const card = page.locator('section[aria-labelledby="expressive-tags-title"]');
    const toggle = card.getByRole('checkbox', { name: /Permitir cualquier etiqueta/ });
    await page.goto(base + '/test/modules/tts');
    await toggle.waitFor();
    assert.match(await card.locator('#tts-freeform-warning').innerText(), /ruidos no deseados/);
    await theme(page, 'dark');
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no overflow es 320');
    await card.locator('.lf-freeform').scrollIntoViewIfNeeded();
    await card.locator('.lf-freeform').screenshot({ path: `${shots}/tts-free-tags-es-dark-320.png` });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS es: Spanish label and warning, 320 dark');
  }
} finally {
  await browser.close();
}
