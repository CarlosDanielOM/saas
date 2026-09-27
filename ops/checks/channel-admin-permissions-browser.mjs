import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4203';
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
    else if (url.pathname.startsWith(`/admins/${user.id}`) && ['POST', 'PUT'].includes(request.method())) {
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
  await page.getByRole('button', { name: 'Edit permissions' }).click();
  const editor = page.locator('.lf-permission-editor');
  await editor.getByRole('button', { name: 'Custom access' }).click();
  assert.equal(await editor.getByLabel('Chat Admin').isChecked(), true, 'custom access starts with Chat Admin on');
  const commands = editor.locator('.lf-permission-row').filter({ hasText: 'Commands and timers' });
  await commands.getByLabel('Manage').check();
  await page.waitForTimeout(100);
  assert.equal(await commands.getByLabel('View').isChecked(), true, 'Manage implies View');
  const dashboard = editor.locator('.lf-permission-row').filter({ hasText: 'Dashboard' });
  assert.equal(await dashboard.getByLabel('View').isChecked(), true, 'website grant includes Dashboard View');
  await editor.getByLabel('Chat Admin').uncheck();
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  assert.deepEqual(writes.at(-1).body.permissions.sort(), ['commands:manage', 'commands:view', 'dashboard:view'].sort());

  await page.getByRole('searchbox').fill('new_admin');
  await page.getByRole('button', { name: 'Add as admin' }).click();
  assert.equal(await editor.getByRole('button', { name: 'Full access' }).getAttribute('aria-pressed'), 'true', 'new admins default to Full access');
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  assert.deepEqual(writes.at(-1).body.permissions, ['*']);

  const newAdminRow = page.locator('.lf-list__row').filter({ hasText: 'new_admin' });
  await newAdminRow.getByRole('button', { name: 'Edit permissions' }).click();
  await editor.getByRole('button', { name: 'Custom access' }).click();
  assert.equal(await editor.getByLabel('Chat Admin').isChecked(), true, 'switching from Full defaults to Chat Admin');
  assert.equal(await dashboard.getByLabel('View').isChecked(), false, 'Chat Admin alone has no website grant');
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  assert.deepEqual(writes.at(-1).body.permissions, ['chat:admin'], 'chat-only assignment saves without dashboard access');

  await newAdminRow.getByRole('button', { name: 'Edit permissions' }).click();
  await editor.getByLabel('Chat Admin').uncheck();
  await page.waitForTimeout(100);
  assert.equal(await editor.getByRole('button', { name: 'Save permissions' }).isDisabled(), true, 'empty custom access cannot save');
  await commands.getByLabel('View').check();
  await editor.getByRole('button', { name: 'Save permissions' }).click();
  assert.deepEqual(writes.at(-1).body.permissions.sort(), ['commands:view', 'dashboard:view'].sort(), 'website-only assignment has no chat role');

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: width < 640 ? 740 : 900 });
    await page.getByRole('button', { name: 'Edit permissions' }).first().click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
    await editor.screenshot({ path: `/tmp/channel-admin-permissions-${width}.png` });
    await editor.getByRole('button', { name: 'Cancel' }).click();
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('PASS site: Full, chat-only, website-only, View/Manage, and responsive picker at 320/390/1280px');
  await context.close();
} finally {
  await browser.close();
}
