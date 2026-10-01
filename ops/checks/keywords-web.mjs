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
    const defaults = { func: 'custom', cooldown: 10, userLevel: 1, enabled: true, reserved: false };
    const commands = [
      { ...defaults, _id: 'normal', name: 'Normal command', cmd: 'hormiga', message: 'Normal' },
      { ...defaults, _id: 'repeat', name: 'Repeatable command', cmd: 'repeats', message: 'Repeat' },
      { ...defaults, _id: 'seed-keyword', name: 'Existing keyword', cmd: 'f', message: 'Failure', activation: 'keyword', keywordSettings: { matchMode: 'start' } }
    ];
    const timerWrites = [];
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
          const command = { ...body, _id: body.activation === 'keyword' ? 'keyword' : 'created-command', reserved: false, channelID: user.id };
          commands.push(command); data = { command };
        } else if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push(body);
          const index = commands.findIndex(command => command._id === url.pathname.split('/').at(-1));
          commands[index] = { ...commands[index], ...body }; data = { command: commands[index] };
        } else if (request.method() === 'DELETE') {
          commands.splice(commands.findIndex(command => command._id === url.pathname.split('/').at(-1)), 1); data = { success: true };
        } else data = { commands: commands.filter(command => url.searchParams.get('activation') === 'all' || command.activation !== 'keyword') };
      } else if (url.pathname.startsWith('/timers/')) {
        if (request.method() !== 'GET') timerWrites.push(request.method());
        data = [{ name: 'repeats', frequency: 15, message: 'Repeat', active: true }];
      }
      else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/test/commands');
    await page.locator('.lf-code').first().waitFor();
    assert.equal(await page.locator('.lf-activation-tabs').count(), 0);
    const createButton = page.locator('.lf-actions button').first();
    assert.equal(await createButton.innerText(), language === 'es' ? 'Crear nuevo' : 'Create new');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width < 640 ? 740 : 900 });
      for (const [view, index] of [['cards', 1], ['table', 0]]) {
        await page.locator('.lf-view button').nth(index).click();
        const root = page.locator(view === 'cards' ? '.lf-cmd-grid' : '.lf-matrix');
        await root.waitFor();
        assert.equal(await root.locator('.lf-code').count(), 3, 'one list includes commands, keywords and repeatables');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const keywordColor = await root.locator('.lf-code--keyword').evaluate(el => getComputedStyle(el).color);
        const repeatColor = await root.locator('.lf-code--timer').evaluate(el => getComputedStyle(el).color);
        const commandColor = await root.locator('.lf-code:not(.lf-code--keyword):not(.lf-code--timer)').evaluate(el => getComputedStyle(el).color);
        assert.equal(new Set([keywordColor, repeatColor, commandColor]).size, 3, 'distinct blue, green and purple');
        if (view === 'table') assert.equal(await root.locator('.lf-kind-dot--keyword').evaluate(el => getComputedStyle(el).backgroundColor), keywordColor);
        else assert.equal(await root.locator('.lf-chip--keyword').evaluate(el => getComputedStyle(el).color), keywordColor);
        assert.equal(keywordColor, tier === 'premium' ? 'rgb(29, 78, 216)' : 'rgb(147, 197, 253)');
        assert.equal(repeatColor, tier === 'premium' ? 'rgb(21, 128, 61)' : 'rgb(134, 239, 172)');
        assert.equal(commandColor, tier === 'premium' ? 'rgb(109, 40, 217)' : 'rgb(196, 181, 253)');
        if (width === 1280) {
          const axe = await new AxeBuilder({ page }).include('app-commands-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `/tmp/commands-unified-${tier}-${width}-${view}.png`, fullPage: true });
      }
    }
    await createButton.click();
    const modal = page.locator('app-command-modal');
    const commandTab = modal.getByRole('tab').nth(0), keywordTab = modal.getByRole('tab').nth(1);
    assert.equal(await commandTab.getAttribute('aria-selected'), 'true');
    assert.equal(await modal.locator('[formControlName="timerEnabled"]').count(), 1);
    assert.equal(await modal.locator('.lf-input-prefix > span').innerText(), '!');
    await modal.locator('[formControlName="name"]').fill('Ant keyword');
    await modal.locator('[formControlName="cmd"]').fill('hormiga');
    await modal.locator('[formControlName="message"]').fill('$(upper hello) $(scount)');
    const cooldown = modal.locator('[formControlName="cooldown"]');
    await cooldown.fill('0');
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), false, 'normal command retains its zero cooldown option');
    await commandTab.focus();
    await commandTab.press('ArrowRight');
    await modal.locator('#keyword-type-tab[aria-selected="true"]').waitFor();
    assert.equal(await keywordTab.getAttribute('aria-selected'), 'true');
    assert.equal(await keywordTab.evaluate(el => el === document.activeElement), true);
    assert.equal(await modal.locator('[formControlName="name"]').inputValue(), 'Ant keyword', 'switching tabs preserves the draft');
    assert.equal(await cooldown.getAttribute('min'), String(min));
    assert.equal(await modal.locator('[formControlName="timerEnabled"]').count(), 0);
    assert.equal(await modal.locator('.lf-input-prefix > span').count(), 0, 'keyword has no ! prefix');
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true, 'keyword cannot inherit command zero cooldown');
    await keywordTab.press('ArrowLeft');
    await modal.locator('#command-type-tab[aria-selected="true"]').waitFor();
    assert.equal(await commandTab.getAttribute('aria-selected'), 'true');
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), false);
    await keywordTab.click();
    await modal.locator('#keyword-type-tab[aria-selected="true"]').waitFor();
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
    const keywordRow = page.locator('.lf-matrix__row--keyword').filter({ hasText: 'Ant keyword' });
    await keywordRow.waitFor();
    assert.equal(await keywordRow.locator('.lf-code').innerText(), 'hormiga');
    assert.equal(await page.locator('.lf-code').count(), 4);
    await keywordRow.getByRole('button', { name: language === 'es' ? 'Editar' : 'Edit', exact: true }).click();
    assert.equal(await modal.getByRole('tab').count(), 0, 'editing preserves the existing activation type');
    assert.equal(await modal.locator('[formControlName="matchMode"]').inputValue(), 'anywhere');
    await modal.locator('[formControlName="matchMode"]').selectOption('exact');
    await modal.locator('[formControlName="cmd"]').fill('repeats');
    await modal.locator('button[type="submit"]').click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes.at(-1).keywordSettings.matchMode, 'exact');
    await keywordRow.getByRole('button', { name: language === 'es' ? 'Deshabilitar' : 'Disable', exact: true }).click();
    await keywordRow.getByRole('button', { name: language === 'es' ? 'Habilitar' : 'Enable', exact: true }).click();
    await keywordRow.getByRole('button', { name: language === 'es' ? 'Eliminar' : 'Delete', exact: true }).click();
    await page.locator('app-confirmation-modal .modal-btn--confirm').click();
    await keywordRow.waitFor({ state: 'hidden' });
    assert.equal(commands.length, 3);
    assert.deepEqual(timerWrites, [], 'keyword CRUD does not mutate a same-named command timer');
    assert.equal(await page.locator('.lf-matrix__row--timer .lf-code').innerText(), '!repeats');
    await createButton.click();
    assert.equal(await commandTab.getAttribute('aria-selected'), 'true', 'a new modal starts on Command');
    await modal.locator('[formControlName="name"]').fill('Created command');
    await modal.locator('[formControlName="cmd"]').fill('hello');
    await modal.locator('[formControlName="message"]').fill('Hello!');
    await modal.locator('button[type="submit"]').click();
    await modal.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.notEqual(writes.at(-1).activation, 'keyword');
    assert.equal(writes.at(-1).keywordSettings, undefined);
    await page.locator('.lf-code').filter({ hasText: '!hello' }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${tier}/${language}: unified table/cards, blue/purple/green, modal tabs and keyboard navigation, command/keyword creation and CRUD, ${min}s keyword minimum/no zero, timer isolation, 320/390/1280px and modal accessibility`);
    await context.close();
  }
} finally { await browser.close(); }
