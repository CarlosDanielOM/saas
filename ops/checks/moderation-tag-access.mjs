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
const rule = {
  id: 'caps-1', type: 'caps', enabled: true,
  firstOffense: { action: 'warn', timeoutSeconds: 60 },
  secondOffense: { action: 'delete', timeoutSeconds: 60 },
  thirdOffense: { action: 'timeout', timeoutSeconds: 60 },
  reason: 'Too many caps', exemptUserLevel: 7, exemptExpression: null,
  capsThresholdMode: 'count', minCapsCount: 8, maxCapsPercentage: 70,
  minMessageLength: 10, allowlistDomains: [], maxEmoteCount: 10, terms: []
};

function hasUserId(node, id) {
  if (!node || typeof node !== 'object') return false;
  if (node.user?.id === id) return true;
  return Object.values(node).some(value =>
    Array.isArray(value) ? value.some(child => hasUserId(child, id)) : hasUserId(value, id)
  );
}

async function testContext(browser, width, height, initialExpression = null) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'test-only', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    twitchUser: user, appUser: app, permissions: {}
  })), { user, app });
  await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
  let settings = {
    channelID: user.id, channel: user.login, enabled: true,
    offenseWindowSeconds: 3600, rules: [{ ...rule, exemptExpression: initialExpression }], settingsVersion: 1
  };
  const writes = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/users') {
      const login = url.searchParams.get('username');
      const ids = { test: user.id, user123: '111', badactor: '222' };
      if (!login || !ids[login]) {
        return route.fulfill({ status: 404, json: { error: true, status: 404, message: 'Not found' } });
      }
      data = { id: ids[login], username: login };
    } else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) {
      data = { allowed: true, role: 'owner' };
    } else if (url.pathname.endsWith('/settings') && url.pathname.startsWith('/moderation/')) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        writes.push(body);
        settings = { ...settings, ...body, settingsVersion: settings.settingsVersion + 1 };
      }
      data = settings;
    } else if (url.pathname.endsWith('/decisions') && url.pathname.startsWith('/moderation/')) {
      data = { decisions: [], total: 0, limit: 10, skip: 0 };
    } else if (url.pathname.endsWith('/logs') && url.pathname.startsWith('/moderation/')) {
      data = { logs: [], total: 0, limit: 10, skip: 0 };
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/test/modules/moderation');
  if (width < 960) await page.locator('.lf-tabs button').filter({ hasText: 'Rules' }).click();
  try {
    await page.locator('.lf-rule-access > summary').waitFor({ timeout: 10000 });
  } catch (error) {
    console.log('moderation debug', page.url(), (await page.locator('body').innerText()).slice(0, 1500), errors);
    throw error;
  }
  return { context, page, writes, errors };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  {
    const { context, page, writes, errors } = await testContext(browser, 1440, 900);
    const editor = page.locator('.lf-rule-access');
    await editor.locator('> summary').click();
    await editor.getByRole('button', { name: 'Tags and accounts' }).click();
    await editor.getByRole('button', { name: 'Everyone: Rule applies' }).waitFor();
    await editor.getByRole('button', { name: 'VIP: No rule' }).click();
    await editor.getByRole('button', { name: 'Mod: No rule' }).click();
    await editor.getByRole('button', { name: 'Subscriber: No rule' }).click();
    await editor.getByRole('button', { name: 'Subscriber: Exempt' }).click();
    await editor.locator('.lf-rule-access__accounts > summary').click();
    await editor.getByRole('textbox', { name: 'Always exempt' }).fill('user123');
    await editor.getByRole('button', { name: 'Add exempt account' }).click();
    await editor.getByText('@user123').waitFor();
    await editor.getByRole('textbox', { name: 'Rule always applies' }).fill('badactor');
    await editor.getByRole('button', { name: 'Add account the rule applies to' }).click();
    await editor.getByText('@badactor').waitFor();
    if (process.env.SAAS_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/moderation-desktop.png`, fullPage: true });
    }
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.getByRole('button', { name: 'Save Settings' }).waitFor({ state: 'visible' });
    assert.equal(writes.length, 1);
    const saved = writes[0].rules[0];
    assert.equal(saved.exemptUserLevel, 7);
    assert.ok(hasUserId(saved.exemptExpression, '111'));
    assert.ok(hasUserId(saved.exemptExpression, '222'));
    assert.equal(JSON.stringify(saved.exemptExpression).includes('"level"'), false,
      'moderation tag mode does not combine with numeric level');

    await editor.getByRole('button', { name: 'User level' }).click();
    await editor.locator('select').first().selectOption('5');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.waitForFunction(() => document.querySelector('.lf-save-bar button')?.hasAttribute('disabled'));
    assert.equal(writes.length, 2);
    assert.equal(writes[1].rules[0].exemptExpression, null, 'level mode clears tag rules');
    assert.equal(writes[1].rules[0].exemptUserLevel, 5);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS moderation tag/account exemption and exclusive level switch');
  }
  {
    const { context, page, writes, errors } = await testContext(browser, 320, 700);
    const editor = page.locator('.lf-rule-access');
    await editor.locator('> summary').click();
    await editor.getByRole('button', { name: 'Tags and accounts' }).click();
    await editor.getByRole('button', { name: 'Everyone: Rule applies' }).click();
    await editor.getByRole('button', { name: 'Everyone: Exempt' }).waitFor();
    await editor.locator('.lf-rule-access__accounts > summary').click();
    await editor.getByRole('textbox', { name: 'Rule always applies' }).fill('badactor');
    await editor.getByRole('button', { name: 'Add account the rule applies to' }).click();
    await editor.getByText('@badactor').waitFor();
    if (process.env.SAAS_SCREENSHOT_DIR) {
      await editor.locator('.lf-rule-access__accounts').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/moderation-mobile.png` });
    }
    const axe = await new AxeBuilder({ page }).include('.lf-rule-access').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      'moderation editor fits 320px');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.waitForFunction(() => document.querySelector('.lf-save-bar button')?.hasAttribute('disabled'));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].rules[0].exemptExpression, {
      and: [{ role: 'everyone' }, { not: { user: { id: '222', login: 'badactor' } } }]
    });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS mobile moderation account exclusion, layout and accessibility');
  }
  {
    const { context, page, writes, errors } = await testContext(browser, 390, 844);
    const editor = page.locator('.lf-rule-access');
    await editor.locator('> summary').click();
    await editor.getByRole('button', { name: 'Tags and accounts' }).click();
    await editor.getByRole('button', { name: 'Everyone: Rule applies' }).waitFor();
    await editor.locator('.lf-rule-access__accounts > summary').click();
    await editor.getByRole('textbox', { name: 'Always exempt' }).fill('user123');
    await editor.getByRole('button', { name: 'Add exempt account' }).click();
    await editor.getByText('@user123').waitFor();
    await editor.getByRole('button', { name: 'Everyone: Rule applies' }).waitFor();
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.waitForFunction(() => document.querySelector('.lf-save-bar button')?.hasAttribute('disabled'));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].rules[0].exemptExpression, {
      and: [{ user: { id: '111', login: 'user123' } }, { not: { role: 'everyone' } }]
    });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS moderation keeps Everyone excluded with a named account exemption');
  }
  {
    const { context, page, writes, errors } = await testContext(browser, 390, 844);
    const editor = page.locator('.lf-rule-access');
    await editor.locator('> summary').click();
    await editor.getByRole('button', { name: 'Tags and accounts' }).click();
    await editor.getByRole('button', { name: 'Everyone: Rule applies' }).waitFor();
    await editor.getByRole('button', { name: 'VIP: No rule' }).click();
    await editor.getByRole('button', { name: 'Mod: No rule' }).click();
    await editor.getByRole('button', { name: 'Everyone: Rule applies' }).waitFor();
    await editor.getByRole('button', { name: 'VIP: Exempt' }).waitFor();
    await editor.getByRole('button', { name: 'Mod: Exempt' }).waitFor();
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.waitForFunction(() => document.querySelector('.lf-save-bar button')?.hasAttribute('disabled'));
    assert.deepEqual(writes[0].rules[0].exemptExpression, {
      and: [{ or: [{ role: 'vip' }, { role: 'mod' }] }, { not: { role: 'everyone' } }]
    });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS moderation keeps Everyone rule-applies with VIP and Mod exemptions');
  }
  {
    const legacyMixed = { or: [{ level: 7 }, { role: 'vip' }] };
    const { context, page, writes, errors } = await testContext(browser, 1440, 900, legacyMixed);
    const editor = page.locator('.lf-rule-access');
    await editor.locator('> summary').click();
    await editor.getByText('This older rule combines user level with tags.').waitFor();
    await page.getByRole('textbox', { name: 'What they see' }).fill('Updated reason');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.getByRole('alert').getByText('Choose one exemption method for every legacy combined rule before saving.').waitFor();
    assert.equal(writes.length, 0);
    await editor.getByRole('button', { name: 'User level' }).click();
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.waitForFunction(() => document.querySelector('.lf-save-bar button')?.hasAttribute('disabled'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].rules[0].exemptExpression, null);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS legacy moderation exemption requires an explicit mode choice');
  }
} finally {
  await browser.close();
}
