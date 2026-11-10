// New-streamer onboarding (2026-11-10): add/remove the bot from chat without full access,
// "Allow on Twitch" fallback + automatic join after sign-in, "Give full access" menu item,
// calm dashboard (Get started, no activation-caused orange), locked built-ins on Commands,
// sign-in asks for channel:bot. Streamers with full access keep the fix-it CTAs.
// SAAS_BROWSER_TOOLS must contain Playwright + @axe-core/playwright. All API traffic is mocked;
// Twitch/API redirects are intercepted, nothing leaves the browser.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
if (shots) mkdirSync(shots, { recursive: true });

const CHANNEL_ID = '424242';
const TWITCH = { id: CHANNEL_ID, login: 'newbie', display_name: 'Newbie', profile_image_url: '' };
const PENDING_JOIN_KEY = 'dimasite.bot-chat-join.v1';

const CATALOG = [
  ['so', 'shoutout', false, 'stream'], ['poll', 'poll', false, 'polls'], ['endpoll', 'endpoll', true, 'polls'],
  ['title', 'title', false, 'stream'], ['s', 'speach', false, 'fun'], ['commands', 'commands', true, 'info'],
  ['vip', 'vip', true, 'roles'], ['amor', 'amor', true, 'fun'], ['cc', 'createCommand', true, 'manage'],
  ['clearchat', 'clearChat', true, 'stream']
].map(([cmd, func, reserved]) => ({
  name: func, cmd, func, type: 'command', reserved, description: `Does ${func}.`, enabled: func !== 'clearChat',
  cooldown: 10, userLevel: reserved ? 7 : 0, userLevelName: reserved ? 'mod' : 'everyone',
  ...(reserved ? {} : { message: `$(${func} &t)` })
}));

function envelope(data) {
  return { error: false, status: 200, message: 'ok', data };
}

/**
 * o: { actived, chatEnabled, hasPermissions, joinStatus (200|403), theme, viewport, path, pending, commands }
 */
async function open(browser, o) {
  const viewport = o.viewport ?? { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'UTC', colorScheme: o.theme ?? 'dark' });
  const state = { chatEnabled: !!o.chatEnabled, posts: [], redirects: [], commandWrites: [] };
  const app = {
    name: 'Newbie', email: 'newbie@example.invalid', language: o.language ?? 'en', plan_tier: 'free', actived: !!o.actived,
    chat_enabled: !!o.chatEnabled, twitch_user_id: CHANNEL_ID, has_permissions: o.hasPermissions ?? !!o.actived,
    up_to_date_permissions: o.hasPermissions ?? !!o.actived, administrating: []
  };
  await context.addInitScript(({ twitch, app, theme, pending, key }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
    }));
    localStorage.setItem('theme', theme);
    localStorage.setItem('dimasite.referral_promo.dismissed_at', String(Date.now()));
    if (!sessionStorage.getItem('onboarding-check')) {
      sessionStorage.setItem('onboarding-check', '1');
      if (pending) localStorage.setItem(key, JSON.stringify({ channelID: app.twitch_user_id, expires: Date.now() + 600000 }));
    }
  }, { twitch: TWITCH, app, theme: o.theme ?? 'dark', pending: !!o.pending, key: PENDING_JOIN_KEY });
  await context.routeWebSocket(/.*/, (ws) => ws.close());

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === 'id.twitch.tv' || (url.hostname === 'api.domdimabot.com' && url.pathname === '/auth/authorize')) {
      state.redirects.push(url.toString());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>intercepted</title><p>intercepted</p>' });
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const p = url.pathname;
    const method = req.method();
    let data = {};
    if (p === '/auth/session') data = { twitch: TWITCH, app: { ...app, chat_enabled: state.chatEnabled } };
    else if (p.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', permissions: {} };
    else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(p)) {
      data = {
        role: 'owner', channel: { id: CHANNEL_ID, name: 'Newbie', chatEnabled: state.chatEnabled }, isLive: false, liveStream: null, liveSession: null,
        kpis: { activeViewers: 0, averageViewers: 0, monthlyAverageViewers: 0, averageHoursPerStream: 0, totalBits: 0, totalStreams: 0, totalDonations: 0, activeFollows: 0, activeSubs: 0, monthlyGoalSubs: 0, subsProgressPct: 0 },
        trend: [], streamHistory: [], totalFollowers: 0, totalSubs: 0,
        monthlyGoals: { followersGoal: 1000, followersCurrent: 0, subsGoal: 1000, subsCurrent: 0 }
      };
    } else if (/^\/dashboard\/[^/]+\/access$/.test(p)) data = { allowed: true, role: 'owner', channelID: CHANNEL_ID, channelName: 'Newbie', planTier: 'free' };
    else if (/^\/dashboard\/[^/]+\/live-status$/.test(p)) data = { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    else if (p.endsWith('/activity')) data = { summary: { commands: [], emotes: [], commandRuns: 0, emoteUses: 0, pending: false, coverageStartedAt: null }, pending: false, stale: false, updatedAt: new Date().toISOString() };
    else if (p === '/billing/ai-credits') data = { used: 0, limit: 100, balance: 100, meterId: 'm', updatedAt: new Date().toISOString(), available: true };
    else if (/^\/moderation\/[^/]+\/logs$/.test(p)) data = { logs: [], total: 0, limit: 100, skip: 0 };
    else if (/^\/moderation\/[^/]+\/settings$/.test(p)) data = { channelID: CHANNEL_ID, channel: 'newbie', enabled: !!o.actived, offenseWindowSeconds: 600, rules: [], settingsVersion: 1 };
    else if (p === '/site/events') data = ['channel.follow', 'channel.raid'].map((type) => ({ name: type, type, version: '1', description: { en: type, es: type }, icon: 'X', color: '#000', textColor: '#fff', releaseStage: 'stable', enabled: false }));
    else if (p.startsWith('/eventsubs/')) data = [];
    else if (p.startsWith('/goals/')) data = { plan: 'free', limit: 1, metrics: ['follows'], revision: 1, goals: [], canManage: true };
    else if (p === '/users') data = { id: CHANNEL_ID, username: 'newbie', profile_image_url: '' };
    else if (p === '/config/commands/reserved') data = { commands: CATALOG };
    else if (p.startsWith('/timers/')) data = [];
    else if (p.startsWith(`/commands/${CHANNEL_ID}`)) {
      if (method === 'GET') data = { commands: o.commands ?? [] };
      else { state.commandWrites.push({ method, path: p }); data = {}; }
    } else if (p.startsWith('/users/chat/') && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      state.posts.push(body.enabled);
      if (body.enabled && (o.joinStatus ?? 200) === 403) {
        return route.fulfill({ status: 403, json: { error: true, status: 403, code: 'chat_permission_missing', message: 'Twitch has not allowed the bot in this chat yet' } });
      }
      state.chatEnabled = !!body.enabled;
      data = { chatEnabled: state.chatEnabled };
    }
    return route.fulfill({ status: 200, json: envelope(data) });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}${o.path ?? '/newbie/dashboard'}`);
  await page.waitForSelector('.auth-navbar', { timeout: 20000 });
  return { context, page, errors, state };
}

async function until(fn, message, timeout = 6000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${message} (last: ${JSON.stringify(last)})`);
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: page overflows horizontally by ${overflow}px`);
}

async function axe(page, label, include) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`), [], `${label}: axe violations`);
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

const chatButton = (page) => page.locator('.auth-navbar__chat');
const chatText = async (page) => (await chatButton(page).innerText()).replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // 1. New streamer, phone + desktop, dark + light: navbar control, calm dashboard, add/remove.
  for (const [theme, viewport] of [['dark', { width: 390, height: 844 }], ['light', { width: 1280, height: 900 }], ['dark', { width: 320, height: 700 }]]) {
    const label = `new-${theme}-${viewport.width}`;
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, theme, viewport });
    await chatButton(page).waitFor();
    assert.equal(await chatText(page), 'Add bot to chat', `${label}: navbar offers to add the bot`);
    assert.equal(await page.locator('.auth-navbar__cta-btn').count(), 0, `${label}: no Activate Bot button in the bar`);
    await page.waitForSelector('.gh__title');
    assert.equal(await page.locator('.gh__bot').count(), 0, `${label}: dashboard header button moved to the navbar`);
    const setup = page.locator('[data-testid="dashboard-setup"]');
    await setup.waitFor();
    assert.equal(await setup.locator('.gs__step').count(), 3, `${label}: three setup steps`);
    assert.equal(await page.locator('.gh__warn').count(), 0, `${label}: no "bot isn't in your chat" warning`);
    assert.equal(await page.locator('.gh .chip--warn').count(), 0, `${label}: header chip not orange`);
    assert.deepEqual(await page.locator('.bs__item[data-tone="warn"]').evaluateAll((els) => els.filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())), [], `${label}: no orange health tiles`);
    assert.equal(await page.locator('.strip__item--warn').count(), 0, `${label}: no orange strip items`);
    await noOverflow(page, label);
    await axe(page, label);
    await shot(page, `${label}-before`);

    await chatButton(page).click();
    await until(async () => (await chatText(page)).startsWith('Bot in chat'), `${label}: navbar shows the bot in chat`);
    assert.deepEqual(state.posts, [true], `${label}: one join request`);
    assert.match(await chatText(page), /Remove/, `${label}: remove hint`);
    await until(async () => /Bot in your chat/.test(await page.locator('.gh .chips').innerText()), `${label}: dashboard chip follows the navbar`);
    await until(async () => (await page.locator('[data-step="chat"].gs__step--done').count()) === 1, `${label}: setup step 1 done`);
    await shot(page, `${label}-in-chat`);

    await chatButton(page).click();
    await until(async () => (await chatText(page)) === 'Tap again to remove', `${label}: remove asks for a second tap`);
    assert.deepEqual(state.posts, [true], `${label}: first tap does not remove`);
    await chatButton(page).click();
    await until(async () => (await chatText(page)) === 'Add bot to chat', `${label}: bot removed`);
    assert.deepEqual(state.posts, [true, false], `${label}: leave request sent`);

    // Confirmation expires on its own.
    await chatButton(page).click();
    await until(async () => (await chatText(page)).startsWith('Bot in chat'), `${label}: re-added`);
    await chatButton(page).click();
    await until(async () => (await chatText(page)) === 'Tap again to remove', `${label}: confirm shown`);
    await page.waitForTimeout(4300);
    assert.ok((await chatText(page)).startsWith('Bot in chat'), `${label}: confirm resets after 4 s`);
    assert.deepEqual(state.posts, [true, false, true], `${label}: no extra leave`);

    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
    console.log(`PASS ${label}: add/remove from the navbar without full access, calm dashboard`);
  }

  // 2. Old sign-in without the chat approval: "Allow on Twitch" → Twitch sign-in with channel:bot.
  {
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, joinStatus: 403 });
    await chatButton(page).click();
    await until(async () => (await chatText(page)) === 'Allow on Twitch', 'needs-ok: button asks to allow on Twitch');
    await until(async () => (await page.locator('app-toast-container').innerText()).includes('Twitch needs your OK first'), 'needs-ok: toast explains');
    await chatButton(page).click();
    await until(async () => state.redirects.some((u) => u.startsWith('https://id.twitch.tv/oauth2/authorize')), 'needs-ok: goes to Twitch sign-in');
    const auth = new URL(state.redirects.find((u) => u.startsWith('https://id.twitch.tv/oauth2/authorize')));
    assert.deepEqual(auth.searchParams.get('scope').split(' ').sort(), ['channel:bot', 'user:read:email'], 'sign-in asks for channel:bot');
    const stored = await context.storageState();
    const site = stored.origins.find((o) => o.origin === origin);
    const pending = JSON.parse(site.localStorage.find((i) => i.name === PENDING_JOIN_KEY)?.value || 'null');
    assert.equal(pending?.channelID, CHANNEL_ID, 'pending join remembered');
    assert.match(site.localStorage.find((i) => i.name === 'dimasite.login-return.v1')?.value || '', /newbie\/dashboard/, 'returns to the same page');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS missing chat approval → Allow on Twitch → sign-in with channel:bot, join remembered');
  }

  // 3. Back from Twitch: the remembered join runs once.
  {
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, pending: true });
    await until(async () => state.posts.length === 1, 'resume: join request sent automatically');
    assert.deepEqual(state.posts, [true]);
    await until(async () => (await chatText(page)).startsWith('Bot in chat'), 'resume: navbar updated');
    await page.reload();
    await chatButton(page).waitFor();
    await page.waitForTimeout(500);
    assert.deepEqual(state.posts, [true], 'resume: only once');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS pending join resumes once after sign-in');
  }

  // 4. Menu: "Unlock all features" starts full access (desktop menu + phone menu).
  {
    const { context, page, state } = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 1280, height: 900 } });
    await page.locator('.auth-navbar__avatar-btn').click();
    await page.locator('.auth-navbar__dropdown-item--access').click();
    await until(async () => state.redirects.some((u) => u.includes('/auth/authorize')), 'menu: full access redirect');
    const target = new URL(state.redirects.find((u) => u.includes('/auth/authorize')));
    assert.equal(target.searchParams.get('action'), 'activate');
    assert.equal(target.searchParams.get('state'), 'newbie');
    await context.close();

    const phone = await open(browser, { actived: false, chatEnabled: true });
    await phone.page.locator('.auth-navbar__mobile-toggle').click();
    await phone.page.locator('.auth-navbar__mobile-link--access').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await phone.page.locator('.auth-navbar__mobile-link--access').innerText(), /Give full access/, 'phone menu offers full access');
    await phone.context.close();
    console.log('PASS Give full access lives in the menus and starts full access');
  }

  // 5. Streamers with full access: in-chat pill, no unlock item; lost permissions keep the fix-it CTA.
  {
    const { context, page } = await open(browser, { actived: true, chatEnabled: true, viewport: { width: 1280, height: 900 } });
    await chatButton(page).waitFor();
    assert.ok((await chatText(page)).startsWith('Bot in chat'));
    await page.locator('.auth-navbar__avatar-btn').click();
    assert.equal(await page.locator('.auth-navbar__dropdown-item--access').count(), 0, 'no unlock item with full access');
    await context.close();

    const broken = await open(browser, { actived: true, chatEnabled: true, hasPermissions: false, viewport: { width: 1280, height: 900 } });
    await broken.page.locator('.auth-navbar__cta-btn--reauthenticate').waitFor();
    assert.equal(await broken.page.locator('.auth-navbar__chat').count(), 0, 'fix-it CTA takes the slot');
    await broken.context.close();
    console.log('PASS full-access streamers: in-chat pill; lost permissions keep Reauthenticate');
  }

  // 6. Commands before full access: every default shown locked, own commands creatable, TTS quick start.
  for (const [theme, viewport] of [['dark', { width: 390, height: 844 }], ['light', { width: 1280, height: 900 }], ['dark', { width: 320, height: 700 }]]) {
    const label = `commands-${theme}-${viewport.width}`;
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, theme, viewport, path: '/newbie/commands' });
    await page.locator('.lf-item--locked').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.lf-item--locked').count(), CATALOG.length, `${label}: every default listed locked`);
    assert.equal(await page.locator('.lf-item--locked .lf-switch, .lf-item--locked button').count(), 0, `${label}: locked rows have no switch or buttons`);
    const note = page.locator('app-full-access-note');
    assert.equal(await note.count(), 1, `${label}: one full-access note`);
    assert.match(await note.innerText(), /Built-in commands are off/);
    assert.ok(await note.locator('button').isVisible(), `${label}: owner gets Give full access`);
    assert.match(await page.locator('.lf-chat-note').innerText(), /The bot isn't in your chat yet/, `${label}: chat note`);
    await page.locator('.lf-filter-tab[data-kind="builtin"]').click();
    await until(async () => (await page.locator('.lf-item--locked').first().isVisible()), `${label}: Built-in tab opens the groups`);
    await noOverflow(page, label);
    await axe(page, label);
    await shot(page, `${label}-locked`);
    await page.locator('.lf-filter-tab[data-kind="all"]').click().catch(() => undefined);
    await page.locator('button', { hasText: 'Text-to-speech command' }).click();
    const modal = page.locator('app-command-modal [role="dialog"]');
    await modal.waitFor();
    assert.equal(await modal.locator('input[formcontrolname="cmd"]').inputValue(), 'tts', `${label}: !tts prefilled`);
    assert.equal(await modal.locator('textarea[formcontrolname="message"]').inputValue(), '$(tts $(user) says: &t)', `${label}: TTS reply prefilled`);
    assert.deepEqual(state.commandWrites, [], `${label}: locked rows and opening the dialog write nothing`);
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
    console.log(`PASS ${label}: locked defaults, full-access note, TTS quick start`);
  }

  // 7. A streamer's own `!s` hides the locked default with the same name; full access shows real built-ins.
  {
    const own = [{ _id: 'own-s', name: 'My TTS', cmd: 's', func: 's', message: '$(tts $(user): &t)', enabled: true, reserved: false, cooldown: 5, userLevel: 1, userLevelName: 'everyone', channel: 'newbie', channelID: CHANNEL_ID, createdAt: '2026-11-10T00:00:00Z' }];
    const { context, page } = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/commands', commands: own });
    await page.locator('.lf-item--locked').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.lf-item--locked').count(), CATALOG.length - 1, 'own !s replaces the locked default');
    assert.equal(await page.locator('.lf-chat-note').count(), 0, 'no chat note while the bot is in chat');
    await context.close();

    const full = [{ ...own[0], _id: 'b-so', name: 'shoutout', cmd: 'so', func: 'shoutout', reserved: true, userLevel: 7, userLevelName: 'mod' }];
    const done = await open(browser, { actived: true, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/commands', commands: full });
    await done.page.locator('.lf-cmd-row').first().waitFor({ state: 'attached' });
    await done.page.waitForTimeout(400);
    assert.equal(await done.page.locator('.lf-item--locked').count(), 0, 'full access: no locked rows');
    assert.equal(await done.page.locator('app-full-access-note').count(), 0, 'full access: no note');
    await done.context.close();
    console.log('PASS own commands win over locked defaults; full access shows real built-ins');
  }
} finally {
  await browser.close();
}
