// Local Playwright is authorized for this thread; every external request is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4218';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [tier, min, language] of [['free', 5, 'en'], ['premium', 3, 'en'], ['pro', 1, 'es']]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const user = { id: '999991', login: 'test', display_name: 'Test' };
    const app = { name: 'Test', email: 'test@example.invalid', language, plan_tier: tier, actived: true,
      chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
    await context.addInitScript(({ user, app, language }) => {
      localStorage.setItem('userLanguage', language);
      localStorage.setItem('theme', app.plan_tier === 'premium' ? 'light' : 'dark');
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    }, { user, app, language });
    const commands = [{ _id: 'normal', name: 'Normal command', cmd: 'hormiga', func: 'custom', message: 'Normal', cooldown: 10, userLevel: 1, enabled: true, reserved: false }];
    const writes = [];
    await context.routeWebSocket(/api\.domdimabot\.com/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/users') data = { id: user.id, username: 'test' };
      else if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: tier };
      else if (url.pathname.startsWith('/commands/')) {
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); writes.push(body);
          const command = { ...body, _id: 'keyword', reserved: false, channelID: user.id };
          commands.push(command); data = { command };
        } else if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push(body);
          const index = commands.findIndex(command => command._id === url.pathname.split('/').at(-1));
          commands[index] = { ...commands[index], ...body }; data = { command: commands[index] };
        } else if (request.method() === 'DELETE') {
          commands.splice(commands.findIndex(command => command._id === 'keyword'), 1); data = { success: true };
        } else data = { commands: commands.filter(command => url.searchParams.get('activation') === 'all' || command.activation !== 'keyword') };
      } else if (url.pathname.startsWith('/timers/')) data = [];
      else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/test/commands');
    const keywordTab = page.locator('.lf-activation-tabs button').nth(1);
    await keywordTab.click();
    await page.locator('.lf-actions button').first().click();
    const modal = page.locator('app-command-modal');
    await modal.locator('[formControlName="name"]').fill('Ant keyword');
    await modal.locator('[formControlName="cmd"]').fill('hormiga');
    await modal.locator('[formControlName="message"]').fill('$(upper hello) $(scount)');
    const cooldown = modal.locator('[formControlName="cooldown"]');
    assert.equal(await cooldown.getAttribute('min'), String(min));
    assert.equal(await modal.locator('[formControlName="timerEnabled"]').count(), 0);
    assert.equal(await modal.locator('.lf-input-prefix > span').count(), 0, 'keyword has no ! prefix');
    assert.equal(await modal.locator('[formControlName="matchMode"]').inputValue(), 'start');
    for (const invalid of ['0', String(min-.1), '61']) {
      await cooldown.fill(invalid);
      assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    }
    await cooldown.fill(String(min));
    await modal.locator('[formControlName="matchMode"]').selectOption('anywhere');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width < 640 ? 740 : 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await modal.locator('.lf-form__body').evaluate(el => el.scrollWidth > el.clientWidth), false);
      const box = await modal.locator('button[type="submit"]').boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= page.viewportSize().height);
      assert.equal(await modal.locator('.lf-modal__close').evaluate(el => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + box.width/2, box.y + box.height/2));
      }), true, 'modal close button stays above navigation at every viewport');
      await page.screenshot({ path: `/tmp/keywords-${tier}-${width}.png` });
    }
    const axe = await new AxeBuilder({ page }).include('app-command-modal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    await modal.locator('button[type="submit"]').click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes[0].activation, 'keyword');
    assert.equal(writes[0].cooldown, min);
    assert.equal(writes[0].keywordSettings.matchMode, 'anywhere');
    assert.equal(await page.locator('.lf-code').first().innerText(), 'hormiga');
    await page.locator('.lf-actions-cell button, .lf-cmd__actions button').filter({ hasText: language === 'es' ? 'Editar' : 'Edit' }).first().click();
    assert.equal(await modal.locator('[formControlName="matchMode"]').inputValue(), 'anywhere');
    await modal.locator('[formControlName="matchMode"]').selectOption('exact');
    await modal.locator('[formControlName="cmd"]').fill('abeja');
    await modal.locator('button[type="submit"]').click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.at(-1).keywordSettings.matchMode, 'exact');
    await page.locator('.lf-activation-tabs button').first().click();
    await page.waitForFunction(() => document.querySelector('.lf-code')?.textContent.trim() === '!hormiga');
    await keywordTab.click();
    await page.waitForFunction(() => document.querySelector('.lf-code')?.textContent.trim() === 'abeja');
    await page.locator('.lf-actions-cell button, .lf-cmd__actions button').filter({ hasText: language === 'es' ? 'Deshabilitar' : 'Disable' }).first().click();
    await page.locator('.lf-actions-cell button, .lf-cmd__actions button').filter({ hasText: language === 'es' ? 'Habilitar' : 'Enable' }).first().click();
    await page.locator('.lf-actions-cell button, .lf-cmd__actions button').filter({ hasText: language === 'es' ? 'Eliminar' : 'Delete' }).first().click();
    await page.locator('app-confirmation-modal .modal-btn--confirm').click();
    await page.locator('.lf-code').waitFor({ state: 'hidden' });
    assert.equal(commands.length, 1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${tier}/${language}: CRUD, all match modes, ${min}s minimum/no zero, independent commands, 320/390/1280px and modal accessibility`);
    await context.close();
  }
} finally { await browser.close(); }
