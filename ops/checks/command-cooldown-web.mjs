// npm install --prefix "$SAAS_BROWSER_TOOLS" playwright @axe-core/playwright
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4213';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [tier, min] of [['free', 5], ['premium', 3], ['pro', 1]]) {
    const context = await browser.newContext();
    const user = { id: '999991', login: 'test', display_name: 'Test' };
    const app = { name: 'Test', email: 'test@example.invalid', language: 'en', plan_tier: tier, actived: true,
      chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
    await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
      twitchUser: user, appUser: app, permissions: {}
    })), { user, app });
    const commands = [];
    const writes = [];
    await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) {
        if (process.env.SAAS_PREVIEW_URL && url.pathname === '/test/commands') {
          return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
        }
        return route.continue();
      }
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/users') data = { id: user.id, username: 'test' };
      else if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner' };
      else if (url.pathname.startsWith('/commands/')) {
        if (request.method() === 'POST' || request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push(body);
          const command = { ...body, _id: 'test-command', channelID: user.id, reserved: false };
          commands.splice(0, commands.length, command);
          data = { command };
        } else data = { commands };
      } else if (url.pathname.startsWith('/timers/')) data = [];
      else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/test/commands');
    await page.getByRole('button', { name: /add command/i }).first().click();
    const modal = page.locator('app-command-modal');
    const cooldown = modal.locator('[formControlName="cooldown"]');
    await modal.locator('[formControlName="name"]').fill('Boundary');
    await modal.locator('[formControlName="cmd"]').fill('boundary');
    await modal.locator('[formControlName="message"]').fill('Hello');
    assert.equal(await cooldown.getAttribute('min'), String(min));
    await modal.getByText(`Minimum for your plan: ${min}s.`, { exact: true }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width < 640 ? 667 : 900 });
      const body = modal.locator('.lf-form__body');
      await body.evaluate(el => { el.scrollTop = 0; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await body.evaluate(el => el.scrollWidth > el.clientWidth), false);
      const cooldownBox = await cooldown.boundingBox();
      const editorBox = await modal.locator('app-permission-expression-editor').boundingBox();
      assert.ok(editorBox && editorBox.y > cooldownBox.y, 'permission editor sits below the cooldown field');
      const submit = modal.locator('button[type="submit"]');
      const before = await submit.boundingBox();
      assert.ok(before.y >= 0 && before.y + before.height <= page.viewportSize().height, 'actions visible without scrolling');
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      const after = await submit.boundingBox();
      assert.equal(before.y, after.y, 'actions stay in place while fields scroll');
      await modal.locator('[formControlName="timerEnabled"]').check();
      await modal.locator('.lf-timer-block .lf-field').waitFor();
      const expanded = await submit.boundingBox();
      assert.ok(expanded.y + expanded.height <= page.viewportSize().height, 'expanded timer keeps actions visible');
      await modal.locator('[formControlName="timerEnabled"]').uncheck();
      await body.evaluate(el => { el.scrollTop = 0; });
      await modal.getByRole('dialog').screenshot({ path: `/tmp/saas-cooldown-${tier}-${width}.png` });
    }
    await cooldown.fill(String(min - 1));
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(writes.length, 0, 'below-plan value blocked');
    await cooldown.fill('61');
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(writes.length, 0, 'existing 60s upper bound retained');
    await cooldown.fill(String(min));
    const editor = modal.locator('app-permission-expression-editor');
    const level = editor.locator('select').first();
    await level.selectOption('7');
    assert.equal(await level.inputValue(), '7');
    const axe = await new AxeBuilder({ page }).include('app-command-modal label:has(input[formControlName="cooldown"])').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.at(-1).cooldown, min, 'create sends the exact tier minimum');
    assert.equal(writes.at(-1).userLevel, 7, 'create sends the selected user level');
    assert.equal(writes.at(-1).userLevelName, 'mod', 'create sends the matching level name');
    assert.equal(writes.at(-1).permissionExpression, null, 'level mode sends the explicit null expression');
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await cooldown.waitFor();
    assert.equal(await cooldown.inputValue(), String(min));
    assert.equal(await level.inputValue(), '7', 'edit rehydrates the selected level');

    // Tag mode: exclusive toggle, explicit role node, live preview, payload tree.
    await editor.getByRole('button', { name: /tags/i }).click();
    await editor.getByRole('button', { name: /^Role$/ }).click();
    const roleSelect = editor.locator('.perm-node[data-kind="role"] select').first();
    await roleSelect.selectOption('sub');
    await page.locator('.perm-preview__value').filter({ hasText: /subscribers/i }).first().waitFor();
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1).permissionExpression, { role: 'sub' }, 'tag mode sends the validated tree');
    assert.equal(writes.at(-1).userLevel, 7, 'numeric pair still stored while tag mode is active');

    // Empty tag mode cannot be saved (no valid node).
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await editor.locator('.perm-root .perm-node__remove').first().waitFor();
    await editor.locator('.perm-root .perm-node__remove').first().click();
    const writesBeforeEmpty = writes.length;
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('alert').filter({ hasText: /at least one/i }).waitFor();
    assert.equal(writes.length, writesBeforeEmpty, 'invalid empty tag mode is not saved');
    await modal.getByRole('button', { name: /cancel/i }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await cooldown.waitFor();
    await cooldown.fill(String(min - 1));
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    const writesBeforeValidEdit = writes.length;
    await cooldown.fill(String(min));
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.length, writesBeforeValidEdit + 1, 'valid edit saves exactly once');
    assert.equal(writes.at(-1).cooldown, min);
    assert.deepEqual(writes.at(-1).permissionExpression, { role: 'sub' }, 'edit preserves the tag expression');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS: ${tier} create/edit minimum ${min}s, invalid bounds, mobile/desktop and accessibility`);
  }
} finally { await browser.close(); }
