import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4204';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const user = { id: '99001101', login: 'permission_owner', display_name: 'Permission Owner' };
const app = { name: 'Permission Owner', email: 'owner@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const admins = [{ adminName: 'existing_admin', adminID: '99001102', channelName: user.login, channelID: user.id, actived: true, permissions: ['*'] }];
const candidates = [{ id: '99001103', login: 'new_admin', display_name: 'New Admin' }];
const writes = [];

try {
  const context = await browser.newContext();
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {}
  })), { user, app });
  await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (process.env.SAAS_PREVIEW_URL && url.pathname.startsWith('/permission_owner/')) {
        return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      }
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner' };
    else if (url.pathname === `/dashboard/${user.id}/access`) data = { allowed: true, role: 'owner', planTier: 'free' };
    else if (url.pathname === `/admins/${user.id}/candidates`) data = candidates;
    else if (url.pathname === `/admins/${user.id}` && request.method() === 'GET') data = admins;
    else if (url.pathname.startsWith(`/admins/${user.id}`) && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
      writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      if (request.method() === 'PUT') data = { permissions: request.postDataJSON().permissions };
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/permission_owner/settings');
  await page.getByText('existing_admin', { exact: true }).waitFor();
  assert.equal(await page.getByText('99001102').count(), 0, 'raw Twitch ids are not shown');
  const editor = page.getByRole('dialog');
  const level = (area, value) => editor.getByRole('radiogroup', { name: area, exact: true }).getByRole('radio', { name: value, exact: true });
  const chat = () => editor.getByRole('checkbox', { name: 'Bot admin in chat', exact: true });
  const save = () => editor.getByRole('button', { name: /^(Save access|Add to team)$/ });
  await page.getByRole('button', { name: 'Edit access for existing_admin' }).click();
  assert.equal(await editor.getByRole('radio', { name: /^Full access/ }).isChecked(), true, 'existing * admin opens as Full access');
  await editor.getByRole('radio', { name: /^Choose what they can do/ }).check();
  assert.equal(await chat().isChecked(), true, 'custom access starts with Chat Admin on');
  assert.equal(await level('Text to Speech', 'Off').isChecked(), true, 'TTS starts separate from Channel settings');
  await level('Text to Speech', 'Edit').check();
  await page.waitForTimeout(100);
  assert.equal(await level('Dashboard', 'View').isChecked(), true, 'website grant includes Dashboard View');
  assert.equal(await level('Dashboard', 'Off').isDisabled(), true, 'Dashboard is locked while another page is granted');
  assert.equal(await level('Channel settings', 'Off').isChecked(), true, 'TTS does not grant Channel settings');
  assert.match(await editor.locator('.lf-modal__footer').innerText(), /Chat \+ 1 page\b/, 'live summary explains the access');
  await save().click();
  await editor.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1).body.permissions.sort(), ['chat:admin', 'tts:manage', 'tts:view', 'dashboard:view'].sort(), 'chat and limited TTS website access coexist');
  assert.match(await page.locator('.lf-row').filter({ hasText: 'existing_admin' }).innerText(), /Chat \+ 1 page\b[\s\S]*Text to Speech/, 'row summarises access in plain language');

  await page.getByRole('button', { name: 'Edit access for existing_admin' }).click();
  await chat().uncheck();
  await save().click();
  await editor.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1).body.permissions.sort(), ['tts:manage', 'tts:view', 'dashboard:view'].sort(), 'TTS website grants work without Chat Admin');

  await page.getByRole('searchbox').fill('new_admin');
  await page.getByRole('button', { name: 'Add New Admin to your team' }).click();
  assert.equal(await editor.getByRole('radio', { name: /^Full access/ }).isChecked(), true, 'new admins default to Full access');
  await save().click();
  await editor.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1).body.permissions, ['*']);

  await page.getByRole('button', { name: 'Edit access for new_admin' }).click();
  await editor.getByRole('radio', { name: /^Choose what they can do/ }).check();
  assert.equal(await chat().isChecked(), true, 'switching from Full defaults to Chat Admin');
  assert.equal(await level('Dashboard', 'Off').isChecked(), true, 'Chat Admin alone has no website grant');
  await save().click();
  await editor.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1).body.permissions, ['chat:admin'], 'chat-only assignment saves without dashboard access');

  await page.getByRole('button', { name: 'Edit access for new_admin' }).click();
  await chat().uncheck();
  await page.waitForTimeout(100);
  assert.equal(await save().isDisabled(), true, 'empty custom access cannot save');
  await editor.getByRole('alert').filter({ hasText: 'at least one page' }).waitFor();
  await level('Commands and timers', 'View').check();
  await save().click();
  await editor.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1).body.permissions.sort(), ['commands:view', 'dashboard:view'].sort(), 'website-only assignment has no chat role');

  await page.getByRole('button', { name: 'Edit access for new_admin' }).click();
  await level('Triggers and media', 'Edit').check();
  await page.waitForTimeout(100);
  await editor.getByRole('checkbox', { name: 'Delete', exact: true }).uncheck();
  await save().click();
  await editor.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1).body.permissions.sort(), ['commands:view', 'dashboard:view', 'triggers:view', 'triggers:upload', 'triggers:attach', 'triggers:edit'].sort(), 'trigger edit rights can be fine-tuned');

  await page.getByRole('button', { name: 'Remove new_admin from your team' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove new_admin?' });
  await confirm.waitFor();
  await page.keyboard.press('Escape');
  await confirm.waitFor({ state: 'detached' });
  assert.equal(writes.filter(write => write.method === 'DELETE').length, 0, 'Escape cancels removal without a request');
  await page.getByRole('button', { name: 'Remove new_admin from your team' }).click();
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1).method, 'DELETE', 'confirming removal deletes the admin');
  assert.equal(await page.locator('.lf-row').filter({ hasText: 'new_admin' }).count(), 0, 'removed admin leaves the list');

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: width < 640 ? 740 : 900 });
    await page.getByRole('button', { name: 'Edit access for existing_admin' }).click();
    await editor.getByRole('radio', { name: /^Choose what they can do/ }).check();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
    await page.screenshot({ path: `/tmp/channel-admin-permissions-${width}.png` });
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await editor.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('PASS site: plain-language access editor, independent TTS grants, combined chat/website access, fine-tuned trigger rights, remove confirmation, responsive layouts at 320/390/1280px');
  await context.close();
} finally {
  await browser.close();
}
