// Every external request is intercepted; these fixtures never change live settings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const SHOUTOUT_RECEIVED_EVENT = {
  name: 'Shoutout Received', type: 'channel.shoutout.receive', version: '1',
  condition: { broadcaster_user_id: 'user', moderator_user_id: 'moderator' },
  icon: 'MessageCircle', releaseStage: 'stable', enabled: false, plan_tier: 'free',
  description: { EN: 'Thank another streamer when they send your channel a shoutout.', ES: 'Agradece a otro streamer cuando le hace un shoutout a tu canal.' },
  config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text',
    value: '$(shoutout.channel) has sent a shoutout to $(twitch.channel)!', canDisable: true }]
};

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/shoutout-received-web';
fs.mkdirSync(artifacts, { recursive: true });
const type = SHOUTOUT_RECEIVED_EVENT.type;
const labels = {
  en: { name: 'Shoutout Received', configure: 'Configure', save: 'Save Changes', community: 'Community moments' },
  es: { name: 'Shoutout recibido', configure: 'Configurar', save: 'Guardar Cambios', community: 'Momentos de la comunidad' }
};
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const lang of ['en', 'es']) for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
    const app = { name: 'Viewer', language: lang, plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id,
      has_permissions: true, up_to_date_permissions: true, administrating: [] };
    let stored = { _id: 'fixture-subscription', id: 'twitch-fixture', type, version: '1', enabled: true,
      status: 'enabled', message: 'Existing shoutout thanks' };
    let canManage = true;
    let rejectSave = false;
    const writes = [];
    await context.addInitScript(({ user, app, lang, theme }) => {
      localStorage.setItem('userLanguage', lang);
      localStorage.setItem('theme', theme);
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      sessionStorage.setItem('eventsCache:v5:999991', '[]');
    }, { user, app, lang, theme });
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.includes('/access')) data = { allowed: !url.searchParams.get('permission')?.endsWith(':manage') || canManage, role: 'owner', planTier: 'free' };
      else if (url.pathname === '/site/events') data = [SHOUTOUT_RECEIVED_EVENT];
      else if (url.pathname.startsWith('/eventsubs/')) {
        if (request.method() === 'PATCH') {
          const payload = request.postDataJSON();
          writes.push({ method: 'PATCH', payload });
          if (rejectSave) return route.fulfill({ status: 500, json: { error: true, message: 'Fixture save failure' } });
          stored = { ...stored, ...payload };
          data = stored;
        } else if (request.method() === 'POST') {
          const payload = request.postDataJSON();
          writes.push({ method: 'POST', payload });
          stored = { _id: 'created-subscription', ...payload, ...payload.config, enabled: true };
          data = stored;
        } else data = stored ? [stored] : [];
      } else if (url.pathname.includes('/live-status')) data = { isLive: false };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/viewer/modules/chat-events`);
    const card = page.locator('app-event-card').filter({ has: page.getByRole('heading', { name: labels[lang].name, exact: true }) });
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
    const input = card.locator('#control-message');
    assert.equal(await input.inputValue(), 'Existing shoutout thanks');
    await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
    const axe = await new AxeBuilder({ page }).include('app-chat-events-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations, [], 'chat events accessibility');
    await page.screenshot({ path: `${artifacts}/shoutout-${lang}-${theme}-${width}.png`, fullPage: true });
    const custom = 'Thanks $(shoutout.channel) for shouting out $(twitch.channel)!';
    await input.fill(custom);
    await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { method: 'PATCH', payload: { message: custom } });
    await page.reload();
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
    await page.reload(); // Also exercises the new session cache.
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
    assert.equal(await input.inputValue(), custom);
    const toggle = card.getByRole('switch', { name: labels[lang].name });
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('app-event-card [role=switch]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(writes.at(-1).payload, { enabled: false });
    await toggle.click();
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
    assert.deepEqual(writes.at(-1).payload, { enabled: true });

    if (lang === 'en' && theme === 'dark' && width === 1280) {
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
      await input.fill('Unsaved fixture');
      rejectSave = true;
      await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
      await page.getByText('Fixture save failure', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Unsaved fixture');
      rejectSave = false;
      canManage = false;
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await card.getByRole('heading', { name: labels[lang].name }).waitFor();
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
      assert.equal(await input.isDisabled(), true);
      assert.equal(await card.getByRole('switch').count(), 0);
      assert.equal(await card.getByRole('button', { name: labels[lang].save, exact: true }).count(), 0);
      canManage = true;
      stored = null;
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await card.getByRole('switch').click();
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
      assert.deepEqual(writes.at(-1), { method: 'POST', payload: { type, version: '1',
        condition: { broadcaster_user_id: user.id, moderator_user_id: '698614112' },
        config: { message: SHOUTOUT_RECEIVED_EVENT.config[0].value } } });
    }
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    await context.close();
    console.log(`Shoutout editor passed: ${lang}, ${theme}, ${width}px`);
  }
} finally {
  await browser.close();
}
