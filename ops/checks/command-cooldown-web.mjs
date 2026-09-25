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
    assert.equal(await cooldown.getAttribute('min'), '0');
    await modal.getByText(`Minimum for your plan: ${min}s.`, { exact: true }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width < 640 ? 667 : 900 });
      const body = modal.locator('.lf-form__body');
      await body.evaluate(el => { el.scrollTop = 0; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await body.evaluate(el => el.scrollWidth > el.clientWidth), false);
      const cooldownBox = await cooldown.boundingBox();
      const levelBox = await modal.locator('[formControlName="userLevel"]').boundingBox();
      assert.ok(Math.abs(cooldownBox.y - levelBox.y) < 3, 'cooldown and user level share a row');
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
    await cooldown.fill(String(min === 1 ? -1 : min - 1));
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(writes.length, 0, 'below-plan value blocked');
    await cooldown.fill('61');
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(writes.length, 0, 'existing 60s upper bound retained');
    await cooldown.fill(String(min));
    const level = modal.locator('[formControlName="userLevel"]');
    await level.selectOption('7');
    assert.equal(await level.inputValue(), '7');
    const axe = await new AxeBuilder({ page }).include('app-command-modal label:has(input[formControlName="cooldown"])').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.at(-1).cooldown, min, 'create sends the exact tier minimum');
    assert.equal(writes.at(-1).userLevel, 7, 'create sends the selected user level');
    assert.equal(writes.at(-1).userLevelName, 'mod', 'create sends the matching level name');
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await cooldown.waitFor();
    assert.equal(await cooldown.inputValue(), String(min));
    assert.equal(await level.inputValue(), '7', 'edit rehydrates the selected level');
    await cooldown.fill(String(min === 1 ? -1 : min - 1));
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(writes.length, 1, 'edit blocks below minimum');
    await cooldown.fill(String(min));
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.length, 2); assert.equal(writes.at(-1).cooldown, min);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS: ${tier} create/edit minimum ${min}s, invalid bounds, mobile/desktop and accessibility`);
  }
} finally { await browser.close(); }
