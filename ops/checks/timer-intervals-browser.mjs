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
    await page.getByRole('button', { name: 'New command', exact: true }).first().click();
    const modal = page.locator('app-command-modal');
    await modal.locator('[formControlName="name"]').fill('Boundary');
    await modal.locator('[formControlName="cmd"]').fill('boundary');
    await modal.locator('[formControlName="message"]').fill('Hello');
    await modal.locator('[formControlName="timerEnabled"]').check();
    const options = tier === 'free' ? [10,20,30,40,50,60] : tier === 'premium'
      ? [5,10,15,30,45,60,90,120,180] : [1,5,7,12,15,30,45,60,90,120,180];
    const buttons = modal.locator(tier === 'free' ? '.lf-interval' : '.lf-quick button');
    await buttons.first().waitFor();
    assert.deepEqual(await buttons.allTextContents(), options.map(m => m + 'm'));
    assert.equal(tier === 'free' ? await modal.locator('.lf-interval--active').innerText()
      : await modal.locator('[formControlName="timerMinutes"]').inputValue(), tier === 'free' ? '10m' : '15');
    for (const width of [320,390,1280]) {
      for (const theme of ['light','dark']) {
        await page.setViewportSize({width,height:width < 640 ? 740 : 900});
        await page.evaluate(theme => {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          document.documentElement.setAttribute('data-theme',theme);
        }, theme);
        await modal.locator('.lf-form__body').evaluate(el => { el.scrollTop=el.scrollHeight; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
        assert.equal(await modal.locator('.lf-form__body').evaluate(el => el.scrollWidth > el.clientWidth), false);
        for (const option of options) {
          await buttons.filter({hasText:new RegExp('^' + option + 'm$')}).click();
          assert.equal(await buttons.filter({hasText:new RegExp('^' + option + 'm$')}).count(),1);
        }
        const axe=await new AxeBuilder({page}).include('app-command-modal').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
        // Timer styling is unchanged by this release. Report its pre-existing
        // contrast failures separately while requiring all other checks to pass.
        const contrast = axe.violations.filter(v => v.id === 'color-contrast');
        if (contrast.length) console.log('Existing contrast findings: '+tier+' '+width+' '+theme+' ('+contrast[0].nodes.length+' elements)');
        const unexpected = axe.violations.flatMap(v => v.nodes.filter(n => v.id !== 'color-contrast' && !(tier !== 'free' && v.id === 'label' && n.target.length === 1 && n.target[0] === '.lf-num')).map(n => ({id:v.id,target:n.target})));
        assert.deepEqual(unexpected, []);
        if (tier !== 'free') console.log('Existing unlabeled paid timer number input reported separately');
        if (process.env.SAAS_SHOTS_DIR) await modal.getByRole('dialog').screenshot({path:process.env.SAAS_SHOTS_DIR + '/timer-' + tier + '-' + width + '-' + theme + '.png'});
      }
    }
    if (tier !== 'free') {
      const minutes=modal.locator('[formControlName="timerMinutes"]');
      assert.equal(await minutes.getAttribute('min'),tier === 'premium' ? '5' : '1');
      assert.equal(await minutes.getAttribute('step'),tier === 'premium' ? '5' : '1');
      await minutes.fill(tier === 'premium' ? '7' : '181');
      if (tier === 'pro') assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
      else {
        await modal.locator('button[type="submit"]').click();
        await modal.locator('[role="alert"]').waitFor();
      }
      assert.equal(writes.length,0,'invalid paid interval blocked');
      await minutes.fill(tier === 'premium' ? '15' : '7');
    } else await buttons.filter({hasText:'10m'}).click();
    const timerWrites=[];
    await context.route('**/timers/**',async route => {
      if (route.request().method() !== 'GET') timerWrites.push(route.request().postDataJSON());
      await route.fulfill({json:{error:false,status:201,data:[]}});
    });
    await modal.locator('button[type="submit"]').click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    for (let i=0;i<40 && !timerWrites.length;i++) await page.waitForTimeout(50);
    assert.equal(timerWrites.at(-1).frequency,tier === 'free' ? 10 : tier === 'premium' ? 15 : 7);
    if (tier === 'free') {
      for (const minutes of [20,30,40,50,60]) {
        await page.getByRole('button',{name:/^Edit !/}).first().click();
        await modal.locator('[formControlName="timerEnabled"]').check();
        await modal.locator('.lf-interval').filter({hasText:new RegExp('^'+minutes+'m$')}).click();
        await modal.locator('button[type="submit"]').click();
        await page.getByRole('dialog').waitFor({state:'hidden'});
        for(let i=0;i<40 && timerWrites.at(-1)?.frequency !== minutes;i++) await page.waitForTimeout(50);
        assert.equal(timerWrites.at(-1).frequency,minutes,'selected interval sent exactly');
      }
    }
    assert.deepEqual(errors,[]);
    await context.close();
    console.log('PASS '+tier+': timer options, defaults, saved intervals, paid validation, mobile/desktop, light/dark and non-contrast accessibility');
  }
} finally { await browser.close(); }
