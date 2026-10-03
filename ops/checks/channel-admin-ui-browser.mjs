import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4204';
const channelID = '99004401';
const adminID = '99004402';
const streamer = 'permission_streamer';
const user = { id: adminID, login: 'permission_admin', display_name: 'Permission Admin' };
const app = {
  name: user.display_name, email: 'admin@example.invalid', language: 'en', plan_tier: 'free',
  actived: true, chat_enabled: true, twitch_user_id: adminID, has_permissions: true,
  up_to_date_permissions: true,
  administrating: [{ channelID, channelName: streamer }]
};
const speech = {
  channelID, channel: streamer, enabled: true, provider: 'piper', defaultLanguage: 'en',
  voices: { en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', cloneDefault: 'gojo' },
  filters: { skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 280, expressiveTags: {} },
  queue: { maxItems: 5 }
};
const command = {
  _id: 'speech', name: 'Speech Chat', cmd: 's', func: 'speach', message: 'Speak this',
  cooldown: 0, userLevel: 1, userLevelName: 'everyone', enabled: true,
  reserved: false, channelID, channel: streamer
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

async function fixture(grants, width) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 740 : 900 } });
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user,
    appUser: app, permissions: {}
  })), { user, app });
  await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) {
      if (process.env.SAAS_PREVIEW_URL && url.pathname.startsWith(`/${streamer}/`)) {
        return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      }
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname === `/dashboard/${channelID}/access`) data = { allowed: true, role: 'admin', planTier: 'free' };
    else if (url.pathname === `/auth/access/${channelID}`) {
      const permission = url.searchParams.get('permission');
      data = { allowed: grants.has('*') || grants.has(permission), role: 'admin' };
    } else if (url.pathname === `/speech/settings/${channelID}`) {
      data = { role: grants.has('*') || grants.has('tts:manage') ? 'manager' : 'admin', settings: speech };
    } else if (url.pathname === `/speech/favorites/${channelID}`) data = [];
    else if (url.pathname === `/commands/${channelID}`) data = { commands: [command] };
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}

async function visit(page, path) {
  await page.goto(`${base}/${streamer}/${path}`);
  await page.locator('.lf-main').waitFor();
}

try {
  const view = await fixture(new Set(['dashboard:view', 'commands:view', 'tts:view']), 320);
  await visit(view.page, 'modules');
  await view.page.getByText('Text to Speech', { exact: true }).waitFor();
  assert.equal(await view.page.locator('.lf-mod').filter({ hasText: 'DimaFX' }).count(), 0, 'module without View grant is hidden');
  assert.equal(await view.page.locator('.lf-mod').filter({ hasText: 'Overlay Studio' }).count(), 0, 'owner-only module is hidden');
  assert.equal(await view.page.locator('.lf-mod').filter({ hasText: 'Roulette' }).count(), 0, 'owner-only module is hidden');
  assert.equal(await view.page.locator('a[href$="/settings"]').count(), 0, 'admin settings link requires Admins View');
  assert.ok(await view.page.locator('a[href$="/commands"]').count() > 0, 'Commands View exposes navigation');
  assert.equal(await view.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'module hub fits 320px');
  await visit(view.page, 'commands');
  await view.page.getByText('Speech Chat', { exact: true }).waitFor();
  assert.equal(await view.page.getByRole('button', { name: 'New command', exact: true }).count(), 0, 'Commands View cannot add');
  await visit(view.page, 'modules/tts');
  await view.page.locator('section[data-testid="tts-command"]').waitFor();
  await view.page.locator('.lf-toggle-row input[type="checkbox"]').first().waitFor({ state: 'attached' });
  assert.equal(await view.page.locator('.lf-toggle-row input[type="checkbox"]').first().isDisabled(), true, 'TTS View is read-only');
  assert.equal(await view.page.getByRole('button', { name: 'Edit TTS command' }).count(), 0, 'Commands View cannot edit TTS command');
  assert.equal(await view.page.getByRole('link', { name: 'Open Commands' }).count(), 1, 'Commands View can open command list');
  assert.deepEqual(view.errors, [], 'View-only pages have no browser runtime errors');
  await view.context.close();

  const settingsOnly = await fixture(new Set(['dashboard:view', 'tts:view']), 390);
  await visit(settingsOnly.page, 'modules/tts');
  await settingsOnly.page.locator('section[data-testid="tts-command"]').waitFor();
  await settingsOnly.page.waitForTimeout(150);
  assert.equal(await settingsOnly.page.getByRole('link', { name: 'Open Commands' }).count(), 0, 'TTS does not link to an ungranted command page');
  assert.deepEqual(settingsOnly.errors, [], 'TTS-only page has no browser runtime errors');
  await settingsOnly.context.close();

  const full = await fixture(new Set(['*']), 1280);
  await visit(full.page, 'modules');
  await full.page.getByText('Text to Speech', { exact: true }).waitFor();
  assert.ok(await full.page.locator('.lf-mod').filter({ hasText: 'DimaFX' }).count() > 0, 'Full access sees granted modules');
  assert.equal(await full.page.locator('.lf-mod').filter({ hasText: 'Overlay Studio' }).count(), 0, 'Full access still respects owner-only modules');
  await visit(full.page, 'commands');
  await full.page.getByRole('button', { name: 'New command', exact: true }).waitFor();
  await visit(full.page, 'modules/tts');
  await full.page.locator('.lf-toggle-row input[type="checkbox"]').first().waitFor({ state: 'attached' });
  assert.equal(await full.page.locator('.lf-toggle-row input[type="checkbox"]').first().isEnabled(), true, 'Full access can edit TTS settings');
  await full.page.getByRole('button', { name: 'Edit TTS command' }).waitFor();
  assert.equal(await full.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'TTS page fits desktop');
  assert.deepEqual(full.errors, [], 'Full access pages have no browser runtime errors');
  await full.context.close();
  console.log('PASS site: granular View is read-only, Full access edits TTS and commands, module/navigation visibility and responsive layout');
} finally {
  await browser.close();
}
