import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991101', login: 'hub_helper', display_name: 'Hub_Helper' };
const channels = [
  { channelID: '991201', channelName: 'zeta_streams' },
  { channelID: '991202', channelName: 'alpha_live' },
  { channelID: '991203', channelName: 'chatonly_tv' }
];
const website = new Set(['991201', '991202']);
const app = { name: 'Hub_Helper', email: 'hub@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: channels };
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app, theme });
    await context.routeWebSocket(/./, ws => ws.close());
    let accessChecks = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(base).origin) {
        if (/^\/(hub_helper|zeta_streams|alpha_live|chatonly_tv)\//.test(url.pathname)) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
        return route.continue();
      }
      if (url.origin !== api) return route.abort();
      if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: true } });
      const access = url.pathname.match(/^\/auth\/access\/(\d+)$/);
      if (access) {
        accessChecks++;
        const id = access[1];
        const allowed = id === user.id || website.has(id);
        return route.fulfill({ status: allowed ? 200 : 403, json: { error: !allowed, data: { allowed, role: id === user.id ? 'owner' : 'admin' } } });
      }
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.match(/^\/dashboard\/\d+\/access$/)) data = { allowed: true, role: 'admin', planTier: 'free' };
      else if (url.pathname === '/users' && url.searchParams.get('username') === 'alpha_live') data = { id: '991202', username: 'alpha_live' };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/hub_helper/admin-hub');
    const row = name => page.locator('.lf-row').filter({ hasText: name });
    await row('chatonly_tv').getByText('Chat only', { exact: true }).waitFor();
    await row('alpha_live').getByText('Website access', { exact: true }).waitFor();
    assert.match(await page.locator('.lf-head').innerText(), /3 channels[\s\S]*2 with website access/, 'header answers how many channels can be opened');
    assert.equal(await row('chatonly_tv').getByRole('button').count(), 0, 'chat-only channel has no dead-end Open button');
    assert.match(await row('chatonly_tv').innerText(), /admin bot commands in chatonly_tv's chat/, 'chat-only row explains why');
    const order = await page.locator('.lf-row strong').allInnerTexts();
    assert.deepEqual(order, ['alpha_live', 'chatonly_tv', 'zeta_streams'], 'channels sorted by name');
    assert.equal(await page.getByRole('searchbox').count(), 0, 'search hidden for a short list');
    assert.equal(await page.getByText('991201').count(), 0, 'no raw channel ids');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme} ${width}`);
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(() => window.axe.run(document.querySelector('app-admin-hub-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `axe ${theme} ${width}`);
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/admin-hub-${theme}-${width}.png`, fullPage: true }); }
    if (theme === 'dark' && width === 1280) {
      await page.getByRole('button', { name: 'Open alpha_live dashboard' }).click();
      await page.waitForURL(/\/alpha_live\/dashboard$/);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS Admin Hub: per-channel website vs chat-only access, no dead-end Open buttons, plain-language hints, opens the dashboard, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
