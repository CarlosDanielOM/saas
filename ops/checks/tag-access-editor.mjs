import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const user = { id: '999991', login: 'test', display_name: 'Test Streamer' };
const app = {
  name: 'Test Streamer', email: 'test@example.invalid', language: 'en', plan_tier: 'pro',
  actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true,
  up_to_date_permissions: true, administrating: []
};
const expression = {
  and: [
    { or: [
      { role: 'vip' }, { role: 'mod' },
      { user: { id: '111', login: 'user123' } }
    ] },
    { not: { or: [
      { role: 'sub' }, { user: { id: '222', login: 'badactor' } }
    ] } }
  ]
};
const fixture = {
  id: 'cmd-1', _id: 'cmd-1', channelID: user.id, channel: user.login, cmd: 'announce',
  func: 'announce', name: 'Announcement', message: 'Hello chat', description: '',
  cooldown: 30, enabled: true, reserved: false, userLevel: 10,
  userLevelName: 'broadcaster', permissionExpression: expression, permissionMode: 'tags',
  createdAt: new Date().toISOString()
};

function hasUserId(node, id) {
  if (!node || typeof node !== 'object') return false;
  if (node.user?.id === id) return true;
  return Object.values(node).some(value =>
    Array.isArray(value) ? value.some(child => hasUserId(child, id)) : hasUserId(value, id)
  );
}

async function testContext(browser, width, height, initialExpression = expression) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'test-only', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    twitchUser: user, appUser: app, permissions: {}
  })), { user, app });
  await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
  const commands = [{ ...fixture, permissionExpression: initialExpression }];
  const writes = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/users') {
      const login = url.searchParams.get('username');
      const ids = { test: user.id, user123: '111', badactor: '222', newviewer: '333' };
      if (!login || !ids[login]) {
        return route.fulfill({ status: 404, json: { error: true, status: 404, message: 'Not found' } });
      }
      data = { id: ids[login], username: login };
    } else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) {
      data = { allowed: true, role: 'owner' };
    } else if (url.pathname.startsWith('/commands/')) {
      if (request.method() === 'POST' || request.method() === 'PUT') {
        const body = request.postDataJSON();
        writes.push({ method: request.method(), body });
        const command = {
          ...body, id: request.method() === 'POST' ? 'cmd-2' : 'cmd-1',
          _id: request.method() === 'POST' ? 'cmd-2' : 'cmd-1',
          channelID: user.id, reserved: false,
          permissionMode: body.permissionExpression ? 'tags' : 'level'
        };
        if (request.method() === 'PUT') commands[0] = command;
        else commands.push(command);
        data = { command };
      } else data = { commands };
    } else if (url.pathname.startsWith('/timers/')) data = [];
    else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/test/commands');
  return { context, page, writes, errors };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  {
    const { context, page, writes, errors } = await testContext(browser, 1440, 900);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const modal = page.locator('app-command-modal');
    await modal.locator('.lf-access-desktop').getByRole('button', { name: 'Tags and accounts' }).waitFor();
    await modal.getByRole('button', { name: 'VIP: Allowed' }).click();
    await modal.getByRole('button', { name: 'VIP: Excluded' }).waitFor();
    await modal.getByRole('button', { name: 'VIP: Excluded' }).click();
    await modal.getByRole('button', { name: 'VIP: No rule' }).waitFor();
    await modal.getByRole('button', { name: 'VIP: No rule' }).click();
    await modal.getByRole('button', { name: 'VIP: Allowed' }).waitFor();
    if (process.env.SAAS_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/command-desktop.png` });
    }

    await modal.getByRole('button', { name: /Account exceptions 2/ }).click();
    await modal.getByRole('textbox', { name: 'Always allow' }).fill('newviewer');
    await modal.getByRole('button', { name: 'Add to always allow' }).click();
    await modal.locator('.lf-account-pane:visible').getByText('@newviewer').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'PUT');
    assert.ok(hasUserId(writes[0].body.permissionExpression, '333'), 'resolved Twitch ID saved');
    assert.ok(hasUserId(writes[0].body.permissionExpression, '222'), 'existing exclusion preserved');
    assert.equal(JSON.stringify(writes[0].body.permissionExpression).includes('"level"'), false,
      'tag mode does not combine with user level');
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await modal.locator('.lf-access-desktop').getByRole('button', { name: 'User level' }).click();
    await modal.locator('.lf-level-field select').selectOption('7');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.length, 2);
    assert.equal(writes[1].body.permissionExpression, null, 'level mode clears tag rules');
    assert.equal(writes[1].body.userLevel, 7);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS desktop tag cycle, account lookup, ID-backed update and modal layout');
  }
  {
    const { context, page, writes, errors } = await testContext(browser, 390, 844);
    await page.getByRole('button', { name: /add command/i }).first().click();
    const modal = page.locator('app-command-modal');
    await modal.locator('[formControlName="name"]').fill('Greeting');
    await modal.locator('[formControlName="cmd"]').fill('greet');
    await modal.locator('[formControlName="message"]').fill('Hello');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const footer = await modal.locator('.lf-form__actions--main').boundingBox();
    assert.ok(footer && footer.y + footer.height <= 844, 'mobile action bar stays visible');

    await modal.locator('.lf-mobile-access-trigger').click();
    await modal.locator('.lf-mobile-tags-view').getByRole('button', { name: 'Tags and accounts' }).click();
    if (process.env.SAAS_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/command-mobile.png` });
    }
    await modal.locator('.lf-mobile-tags-view .lf-account-trigger').click();
    await modal.getByRole('textbox', { name: 'Always exclude' }).fill('user123');
    await modal.getByRole('button', { name: 'Add to always exclude' }).click();
    await modal.locator('.lf-mobile-accounts-view:visible').getByText('@user123').waitFor();
    await modal.getByRole('button', { name: 'Done' }).click();
    await modal.getByRole('button', { name: 'Done' }).click();
    await modal.getByRole('button', { name: 'Create' }).click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'POST');
    assert.deepEqual(writes[0].body.permissionExpression, {
      not: { user: { id: '111', login: 'user123' } }
    }, 'everyone except named account');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS mobile compact editor and everyone-except-user create');
  }
  {
    const { context, page, errors } = await testContext(browser, 320, 700);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const modal = page.locator('app-command-modal');
    await modal.locator('.lf-mobile-access-trigger').click();
    assert.equal(await modal.locator('.lf-mobile-tags-view').getByRole('button', { name: 'Tags and accounts' }).getAttribute('aria-pressed'), 'true');
    const axe = await new AxeBuilder({ page }).include('app-command-modal').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS 320px editor layout and modal accessibility');
  }
  {
    const legacyMixed = { or: [{ level: 5 }, { role: 'vip' }] };
    const { context, page, writes, errors } = await testContext(browser, 1440, 900, legacyMixed);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const modal = page.locator('app-command-modal');
    await modal.locator('.lf-access-desktop').getByText('This older command combines user level with tags.').waitFor();
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await modal.getByRole('alert').getByText('Choose user level or reset the legacy tag rule before saving.').waitFor();
    assert.equal(writes.length, 0, 'legacy combined rule cannot be saved again');
    await modal.locator('.lf-access-desktop').getByRole('button', { name: 'User level' }).click();
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.permissionExpression, null,
      'explicit level choice replaces the previous mixed rule');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS legacy combined rule requires an explicit mode choice');
  }
} finally {
  await browser.close();
}
