import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991403', login: 'defense_owner', display_name: 'Defense_Owner' };
const app = { name: 'Defense_Owner', email: 'fd@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const settingsSeed = () => ({ channelID: user.id, channel: user.login, enabled: true, silentModeEnabled: true, protectionModeEnabled: true, attackModeEnabled: true, resetAttackOnNewRaid: true, silentThresholdX: 10, silentWindowYSeconds: 5, protectionThresholdB: 100, attackThreshold: null, silentDurationSeconds: 60, baselineFollowsPerHour: null, language: 'en', settingsVersion: 1 });
const logs = [
  { id: 'l1', channelID: user.id, channelLogin: user.login, channelName: user.display_name, triggeredMode: 'attack', triggeredBy: 'manual', totalFollows: 2400, velocity: 18, isRaid: true, raiderChannelName: 'HateRaider', bannedCount: 2380, createdAt: Date.now() - 86400000 },
  { id: 'l2', channelID: user.id, channelLogin: user.login, channelName: user.display_name, triggeredMode: 'silent', triggeredBy: 'threshold', totalFollows: 14, velocity: 3, isRaid: false, bannedCount: 0, createdAt: Date.now() - 3 * 86400000 }
];
const sources = [{ id: 's1', raiderChannelID: '77', raiderChannelLogin: 'hateraider', raiderChannelName: 'HateRaider', count: 2, firstSeen: Date.now() - 9 * 86400000, lastSeen: Date.now() - 86400000, lastRaidViewers: 1200 }];
async function open({ theme = 'dark', width = 1280, manage = true, mode = 'normal', tracked = 0, raid = false, enabled = true } = {}) {
  const settings = { ...settingsSeed(), enabled }; const writes = [];
  const state = { mode, tracked };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app, theme });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/defense_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    const ok = data => route.fulfill({ json: { error: false, status: 200, data } });
    const root = `/follow-defense/${user.id}`;
    if (url.pathname.startsWith('/auth/access/')) {
      const allowed = url.searchParams.get('permission') === 'moderation:manage' ? manage : true;
      return route.fulfill({ status: allowed ? 200 : 403, json: { error: !allowed, data: { allowed } } });
    }
    if (url.pathname === `${root}/settings`) {
      if (method === 'PATCH') { const body = request.postDataJSON(); writes.push({ path: 'settings', body }); Object.assign(settings, body); }
      return ok(settings);
    }
    if (url.pathname === `${root}/status`) return ok({ mode: state.mode, channelID: user.id, channelLogin: user.login, channelName: user.display_name, modeStartedAt: Date.now() - 125000, burstStartedAt: Date.now() - 125000, expiresAt: Date.now() + 95000, triggeredBy: 'threshold', lastTransitionReason: 'internal: velocity>=X', lastUpdatedAt: Date.now(), trackedCount: state.tracked, dynamicBaseline: { calculatedAt: Date.now(), averageDaily: 180, averageStream: 240, sampleDays: 30, streamCount: 22, attackThreshold: 500 }, raid: raid ? { raiderChannelID: '77', raiderChannelLogin: 'bigraider', raiderChannelName: 'BigRaider', raidViewers: 3400, createdAt: Date.now() - 60000, expiresAt: Date.now() + 240000 } : null });
    if (url.pathname === `${root}/attack`) { writes.push({ path: 'attack' }); state.mode = 'attack'; return ok({ success: true, mode: 'attack' }); }
    if (url.pathname === `${root}/reset`) { writes.push({ path: 'reset' }); state.mode = 'normal'; return ok({ success: true, mode: 'normal' }); }
    if (url.pathname === `${root}/attacks`) return ok({ entries: logs, total: 2, page: 1, limit: 10 });
    if (url.pathname === `${root}/hate-raids`) return ok({ sources, total: 1, page: 1, limit: 10 });
    if (url.pathname === `${root}/raid-sessions`) return ok({ sessions: [], total: 0, page: 1, limit: 20, canBan: true, planTier: 'pro', canBanSession: true, canBanIndividual: true });
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'pro' });
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + '/defense_owner/modules/follow-defense');
  await page.locator('.lf-now').waitFor();
  return { context, page, writes, settings, state };
}
const settle = page => page.waitForTimeout(150);
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-follow-defense-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
try {
  {
    const { context, page, writes, settings } = await open();
    const now = page.locator('.lf-now');
    await now.getByRole('heading', { name: 'All quiet. No follow wave right now.' }).waitFor();
    const head = page.locator('.lf-head');
    assert.match(await head.innerText(), /All quiet[\s\S]*Bans at 500 follows \(auto\)/);
    assert.equal(await page.getByText(/internal: velocity|Triggered By|Tracked Count|Last Transition/).count(), 0, 'no raw status jargon');
    // Rules read as sentences and follow the inputs live.
    await page.getByText('Starts when 10 people follow within 5 seconds.').waitFor();
    await page.getByRole('spinbutton', { name: 'Follows', exact: true }).fill('25');
    await page.getByRole('spinbutton', { name: 'Follows', exact: true }).blur();
    await page.getByText('Starts when 25 people follow within 5 seconds.').waitFor();
    await page.getByText('Each mode switches off 1m after follows calm down. New bursts restart the timer.').waitFor();
    const bar = page.locator('.lf-save-bar');
    await bar.getByText('Unsaved changes').waitFor();
    await bar.getByRole('button', { name: 'Save changes' }).click();
    await bar.getByText('All changes saved').waitFor();
    assert.deepEqual(writes.at(-1), { path: 'settings', body: { silentThresholdX: 25 } });
    // Custom attack threshold shows in the header chip after saving.
    await page.getByPlaceholder('Automatic (30 days)').fill('1500');
    await page.getByPlaceholder('Automatic (30 days)').blur();
    await bar.getByRole('button', { name: 'Save changes' }).click();
    await head.getByText('Bans at 1,500 follows').waitFor();
    assert.equal(settings.attackThreshold, 1500);
    // History and hate raid sources are plain rows.
    const history = page.locator('.lf-log__row');
    assert.equal(await history.count(), 2);
    assert.match(await history.first().innerText(), /Attack[\s\S]*2,400 follows \(18\/s\) · Started by a moderator\. · raid from HateRaider · 2,380 banned/);
    assert.match(await history.nth(1).innerText(), /Silent[\s\S]*14 follows \(3\/s\) · Started automatically\./);
    assert.match(await page.locator('.lf-row').filter({ hasText: 'HateRaider' }).innerText(), /Raided 2 times · last .* · 1,200 viewers/);
    // Turning the module off is a draft too and changes the answer at the top.
    await page.getByRole('checkbox', { name: 'Enable Follow Defense' }).uncheck();
    await now.getByRole('heading', { name: 'Follow Defense is off' }).waitFor();
    await now.getByRole('button', { name: 'Turn on Follow Defense' }).click();
    await now.getByRole('heading', { name: 'All quiet. No follow wave right now.' }).waitFor();
    await bar.getByText('All changes saved').waitFor();
    await context.close();
  }
  {
    // Protection during a raid: plain explanation, raid line, attack needs typed confirmation, Escape returns focus.
    const { context, page, writes } = await open({ mode: 'protection', tracked: 340, raid: true });
    const now = page.locator('.lf-now');
    await now.getByRole('heading', { name: 'A raid is being watched: 340 followers tracked so far' }).waitFor();
    await now.getByText(/Raid from BigRaider \(3,400 viewers\)\. Tracked for 3m 5\d?s more\.|Raid from BigRaider \(3,400 viewers\)\. Tracked for 4m more\./).waitFor();
    assert.match(await page.locator('.lf-head').innerText(), /Watching a raid/);
    const activate = now.getByRole('button', { name: 'Activate Attack Mode' });
    await activate.click();
    const dialog = page.getByRole('alertdialog', { name: 'Activate Attack Mode?' });
    await dialog.getByText('340 tracked followers will be banned.').waitFor();
    await dialog.getByText(/A raid is currently being tracked/).waitFor();
    const go = dialog.getByRole('button', { name: 'Activate Attack Mode' });
    assert.equal(await go.isDisabled(), true, 'needs ATTACK typed');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('Activate Attack Mode'));
    assert.equal(writes.length, 0);
    await activate.click();
    await dialog.getByRole('textbox', { name: 'Type ATTACK to confirm' }).fill('ATTACK');
    await go.click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(writes.at(-1), { path: 'attack' });
    await now.getByRole('heading', { name: 'Attack Mode is on: banning 340 tracked followers' }).waitFor();
    await now.getByRole('button', { name: 'Stop Attack Mode' }).click();
    await now.getByRole('heading', { name: 'A raid is being watched: 340 followers tracked so far' }).waitFor();
    assert.deepEqual(writes.at(-1), { path: 'reset' });
    await context.close();
  }
  {
    // Silent mode headline; view-only helpers see state but no controls.
    const { context, page } = await open({ mode: 'silent', tracked: 12, manage: false });
    await page.locator('.lf-now').getByRole('heading', { name: /A small follow wave started 2m \d+s ago/ }).waitFor();
    await page.locator('.lf-head').getByText('View only').waitFor();
    assert.equal(await page.locator('.lf-save-bar').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Activate Attack Mode' }).count(), 0);
    assert.equal(await page.getByRole('checkbox', { name: 'Silent Mode' }).isDisabled(), true);
    await context.close();
  }
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page } = await open({ theme, width, mode: 'protection', tracked: 340 });
    await page.locator('.lf-log__row').first().waitFor();
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme} ${width}`);
    await axe(page, `axe ${theme} ${width}`);
    if (width < 960) {
      const order = await page.evaluate(() => ['.lf-now', 'app-raid-sessions', '#fd-rules-title', '#fd-history-title'].map(s => document.querySelector(s).getBoundingClientRect().top));
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'phone order: now, raids, rules, history');
    }
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/follow-defense-${theme}-${width}.png`, fullPage: true }); }
    if (width === 390 && theme === 'light') {
      await page.locator('.lf-now').getByRole('button', { name: 'Activate Attack Mode' }).click();
      await page.waitForTimeout(250);
      await axe(page, 'attack dialog axe');
      if (shots) await page.screenshot({ path: `${shots}/follow-defense-attack-390.png` });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS follow defense: plain "right now" answer per mode (quiet/silent/protection/raid/attack/off), header mode + attack-threshold chips, live rule sentences, save bar status + minimal patch, custom threshold chip, plain history and hate-raid rows, off/on draft, typed ATTACK confirmation with Escape focus return, stop attack, view-only, phone ordering, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
