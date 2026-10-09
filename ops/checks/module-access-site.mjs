// All API, provider and socket traffic uses disposable browser fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
const require = createRequire('/tmp/saas-cooldown-browser/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL required');
const catalog = { ...JSON.parse(readFileSync('/root/saas/dimabot/src/widgets/dbd.json', 'utf8')), packs: ['killer', 'survivor'].flatMap(role => ['challenge', 'characters', 'perks'].map(mode => ({ id: `dbd-${role}-${mode}`, game: 'Dead by Daylight', role, mode }))) };
const shots = '/tmp/roulette-widget-access-shots'; mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const scenario of [
    { role: 'admin', tier: 'premium', width: 390, theme: 'dark' },
    { role: 'admin', tier: 'pro', width: 1280, theme: 'dark' },
    { role: 'owner', tier: 'premium', width: 390, theme: 'light' },
    { role: 'owner', tier: 'pro', width: 1280, theme: 'light' },
    { role: 'limited', tier: 'premium', width: 390, theme: 'dark' },
    { role: 'admin', tier: 'free', width: 390, theme: 'dark' },
  ]) {
    const { role, tier, width, theme } = scenario;
    const user = { id: role === 'owner' ? '997701' : '997702', login: role === 'owner' ? 'accessfixture' : 'accessadmin', display_name: 'Access Fixture' };
    const app = { name: user.display_name, email: 'fixture@example.invalid', language: 'en', plan_tier: role === 'owner' ? tier : 'free', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: role === 'owner' ? [] : [{ channelID: '997701', channelName: 'accessfixture', plan_tier: tier }] };
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    await context.addInitScript(({ user, app, theme }) => {
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      localStorage.setItem('dimasite.theme', theme);
    }, { user, app, theme });
    await context.routeWebSocket(/.*/, socket => socket.close());
    let reads = 0, writes = 0;
    const state = { revision: 1, serverTime: Date.now(), packId: 'dbd-killer-challenge', visible: false, config: { language: 'en', characterDesign: 'cards', spinSeconds: 1, pollSeconds: 15, channelPointsVoting: false, channelPointsPerVote: 100, includeUnavailable: false, excludedIds: [], perkTuning: {}, sequences: { killer: { character: true, fixedCharacterId: null, poll: true, perks: true, perkCount: 4 }, survivor: { character: true, fixedCharacterId: null, poll: true, perks: true, perkCount: 4 } }, targets: { killer: 3, survivor: 4 }, layout: { cameraCorner: 'bottom-right', cameraWidth: 512, cameraHeight: 288, loadoutMode: 'detailed', autoCompact: true, progressStyle: 'badges', showActive: true, showInfo: true, showProgress: true, hideActiveDuringGameplay: true } }, phase: 'idle', run: null, nextAt: null, wins: { killer: 0, survivor: 0 }, loadouts: { killer: { characterId: null, perkIds: [] }, survivor: { characterId: null, perkIds: [] } } };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.startsWith('/auth/access/')) data = { allowed: url.searchParams.get('permission') !== '*' || role !== 'limited' };
      else if (url.pathname.endsWith('/access')) data = { allowed: true, role: role === 'owner' ? 'owner' : 'admin', planTier: tier };
      else if (url.pathname.startsWith('/roulettes/')) { reads++; data = { revision: 1, serverTime: Date.now(), roulettes: [], activeId: null, visible: false, draw: null, history: [], hideAt: null, actionRuns: [] }; }
      else if (url.pathname.startsWith('/widgets/')) {
        reads++;
        if (url.pathname.endsWith('/catalog')) data = catalog;
        else if (url.pathname.endsWith('/events')) data = { enabled: false, active: false, activeSince: null, allowTestEvents: false, rules: [] };
        else { data = state; if (request.method() === 'POST') { writes++; const body = request.postDataJSON(); if (url.pathname.endsWith('/role')) state.packId = `dbd-${body.role}-challenge`; state.revision++; } }
      } else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/accessfixture/modules`);
    await page.locator('app-modules-page').waitFor();
    for (const module of ['roulette', 'widgets/dbd']) {
      await page.goto(`${base}/accessfixture/modules/${module}`);
      if (role === 'limited') { await page.waitForURL(/\/403/); continue; }
      const surface = page.locator(module === 'roulette' ? 'app-roulette-page' : '[data-testid="widgets-page"]');
      await surface.waitFor();
      await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
      if (tier === 'free') await surface.getByRole('heading', { name: module === 'roulette' ? 'Roulette Alpha is available with Premium' : 'Widgets Alpha requires Premium' }).waitFor();
      else if (module === 'roulette') await surface.getByRole('button', { name: 'New roulette', exact: true }).waitFor();
      else { await page.getByTestId('role-survivor').click(); assert(writes > 0, 'admin may change the widget role'); }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
      if (role !== 'limited' && tier !== 'free') await page.screenshot({ path: `${shots}/${module.replace('/', '-')}-${role}-${width}-${theme}.png`, fullPage: true });
    }
    if (role === 'limited' || tier === 'free') assert.equal(reads, 0, 'denied access never reads module state');
    else assert(reads > 0, 'eligible users reach the API');
    assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS ${role} ${tier}, ${width}px ${theme}`);
  }
} finally { await browser.close(); }
