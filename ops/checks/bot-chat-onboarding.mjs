// New-streamer onboarding (2026-11-10, revised): the navbar stays the authenticate CTA
// ("Activate Bot"); the dashboard header button turns the bot on/off without full access
// (chat approval from sign-in), with "Allow on Twitch" fallback + automatic join after sign-in,
// a two-tap turn-off and a 1 s click guard (a double-click sends one request). Calm dashboard;
// Commands shows the basic built-ins as real commands and only the Twitch-dependent ones locked.
// Streamers with full access keep the fix-it CTAs.
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

// [cmd, func, reserved, needs full access]
const CATALOG = [
  ['so', 'shoutout', false, true], ['poll', 'poll', false, true], ['endpoll', 'endpoll', true, true],
  ['title', 'title', false, true], ['s', 'speach', false, false], ['commands', 'commands', true, false],
  ['vip', 'vip', true, true], ['amor', 'amor', true, false], ['cc', 'createCommand', true, false],
  ['clearchat', 'clearChat', true, true]
].map(([cmd, func, reserved, full]) => ({
  name: func, cmd, func, type: 'command', reserved, description: `Does ${func}.`, enabled: func !== 'clearChat',
  cooldown: 10, userLevel: reserved ? 7 : 0, userLevelName: reserved ? 'mod' : 'everyone',
  ...(reserved ? {} : { message: `$(${func} &t)` }), ...(full ? { requiresFullAccess: true } : {})
}));
const LOCKED = CATALOG.filter((c) => c.requiresFullAccess);
/** What GET /commands returns before full access: the basic defaults, created for real. */
const BASIC_COMMANDS = CATALOG.filter((c) => !c.requiresFullAccess).map((c) => ({
  _id: `real-${c.func}`, name: c.name, cmd: c.cmd, func: c.func, reserved: c.reserved, enabled: true, cooldown: c.cooldown,
  userLevel: c.userLevel, userLevelName: c.userLevelName, message: c.message ?? '', description: c.description,
  channel: 'newbie', channelID: '424242', createdAt: '2026-11-10T00:00:00Z'
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
  const viewer = o.manager ? { id: '777777', login: 'helper', display_name: 'Helper', profile_image_url: '' } : TWITCH;
  const app = {
    name: 'Newbie', email: 'newbie@example.invalid', language: o.language ?? 'en', plan_tier: 'free', actived: !!o.actived,
    chat_enabled: !!o.chatEnabled, twitch_user_id: CHANNEL_ID, has_permissions: o.hasPermissions ?? !!o.actived,
    up_to_date_permissions: o.hasPermissions ?? !!o.actived, administrating: [],
    ...(o.manager ? { twitch_user_id: viewer.id, actived: true, has_permissions: true, up_to_date_permissions: true, administrating: [{ channelID: CHANNEL_ID, channelName: 'newbie' }] } : {})
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
  }, { twitch: viewer, app, theme: o.theme ?? 'dark', pending: !!o.pending, key: PENDING_JOIN_KEY });
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
    if (p === '/auth/session') data = { twitch: viewer, app: { ...app, chat_enabled: state.chatEnabled } };
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
    else if (p.endsWith('/follow-defense/' + CHANNEL_ID + '/settings')) data = { channelID: CHANNEL_ID, channel: 'newbie', enabled: false, silentModeEnabled: true, protectionModeEnabled: true, attackModeEnabled: true, resetAttackOnNewRaid: true, silentThresholdX: 10, silentWindowYSeconds: 5, protectionThresholdB: 100, attackThreshold: null, silentDurationSeconds: 60, baselineFollowsPerHour: null, language: 'en', settingsVersion: 1 };
    else if (p.endsWith('/follow-defense/' + CHANNEL_ID + '/status')) data = { mode: 'normal', channelID: CHANNEL_ID, channelLogin: 'newbie', channelName: 'Newbie', trackedCount: 0, lastUpdatedAt: Date.now(), raid: null };
    else if (p.includes('/follow-defense/')) data = { items: [], total: 0, page: 1, pages: 1, sessions: [] };
    else if (p.startsWith('/goals/')) data = { plan: 'free', limit: 1, metrics: ['follows'], revision: 1, goals: [], canManage: true };
    else if (p === '/users') data = { id: CHANNEL_ID, username: 'newbie', profile_image_url: '' };
    else if (p === `/users/${CHANNEL_ID}`) {
      // Public channel lookup (actived as the cache's string), used for managed channels.
      return route.fulfill({ status: 200, json: { error: false, streamer: { id: CHANNEL_ID, name: 'newbie', actived: String(o.channelActived ?? !!o.actived), chat_enabled: String(state.chatEnabled) } } });
    }
    else if (p === '/config/commands/reserved') data = { commands: CATALOG };
    else if (p.startsWith('/timers/')) data = [];
    else if (p.startsWith(`/commands/${CHANNEL_ID}`)) {
      if (method === 'GET') {
        // Like the API: list + fullAccess at the top level.
        return route.fulfill({ status: 200, json: { error: false, status: 200, message: 'ok', commands: o.commands ?? [], total: (o.commands ?? []).length, fullAccess: !!o.actived } });
      }
      state.commandWrites.push({ method, path: p }); data = {};
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

const botButton = (page) => page.locator('.gh__bot');
const botText = async (page) => (await botButton(page).innerText()).replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // 1. New streamer, phone + desktop, dark + light: navbar = Activate Bot, dashboard button turns the bot on/off.
  for (const [theme, viewport] of [['dark', { width: 390, height: 844 }], ['light', { width: 1280, height: 900 }], ['dark', { width: 320, height: 700 }]]) {
    const label = `new-${theme}-${viewport.width}`;
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, theme, viewport });
    await page.locator('.auth-navbar__cta-btn--activate').waitFor();
    assert.match(await page.locator('.auth-navbar__cta-btn--activate').innerText(), /Activate Bot/i, `${label}: navbar keeps the authenticate CTA`);
    await page.waitForSelector('.gh__title');
    assert.equal(await botText(page), 'Turn the bot on', `${label}: dashboard button turns the bot on`);
    const setup = page.locator('[data-testid="dashboard-setup"]');
    await setup.waitFor();
    assert.equal(await setup.locator('.gs__step').count(), 3, `${label}: three setup steps`);
    assert.equal(await page.locator('.gh__warn').count(), 0, `${label}: no "bot isn't in your chat" warning`);
    assert.equal(await page.locator('.gh .chip--warn').count(), 0, `${label}: header chip not orange`);
    assert.deepEqual(await page.locator('.bs__item[data-tone="warn"]').evaluateAll((els) => els.filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())), [], `${label}: no orange health tiles`);
    assert.equal(await page.locator('.strip__item--warn').count(), 0, `${label}: no orange strip items`);
    const tall = await botButton(page).evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(tall >= 44, `${label}: bot button is a 44px touch target (${tall})`);
    await noOverflow(page, label);
    await axe(page, label);
    await shot(page, `${label}-before`);

    // A double-click sends one request (1 s click guard).
    await botButton(page).dblclick();
    await until(async () => (await botText(page)) === 'Turn the bot off', `${label}: bot turned on`);
    await page.waitForTimeout(300);
    assert.deepEqual(state.posts, [true], `${label}: one join request for a double-click`);
    await until(async () => /Bot in your chat/.test(await page.locator('.gh .chips').innerText()), `${label}: chip follows`);
    await until(async () => (await page.locator('[data-step="chat"].gs__step--done').count()) === 1, `${label}: setup step 1 done`);
    await shot(page, `${label}-in-chat`);

    // Turning off asks for a second tap; a quick double-tap doesn't confirm it.
    await page.waitForTimeout(1100);
    await botButton(page).dblclick();
    await until(async () => (await botText(page)) === 'Tap again to turn off', `${label}: turn off asks again`);
    await page.waitForTimeout(300);
    assert.deepEqual(state.posts, [true], `${label}: double-tap does not turn the bot off`);
    await page.waitForTimeout(1000);
    await botButton(page).click();
    await until(async () => (await botText(page)) === 'Turn the bot on', `${label}: bot turned off`);
    assert.deepEqual(state.posts, [true, false], `${label}: leave request sent`);

    // The confirmation expires on its own.
    await page.waitForTimeout(1100);
    await botButton(page).click();
    await until(async () => (await botText(page)) === 'Turn the bot off', `${label}: on again`);
    await page.waitForTimeout(1100);
    await botButton(page).click();
    await until(async () => (await botText(page)) === 'Tap again to turn off', `${label}: confirm shown`);
    await page.waitForTimeout(4300);
    assert.equal(await botText(page), 'Turn the bot off', `${label}: confirm resets after 4 s`);
    assert.deepEqual(state.posts, [true, false, true], `${label}: no extra leave`);

    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
    console.log(`PASS ${label}: Activate Bot stays in the navbar; dashboard button turns the bot on/off without full access`);
  }

  // 2. Old sign-in without the chat approval: "Allow on Twitch" → Twitch sign-in with channel:bot.
  {
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, joinStatus: 403 });
    await page.waitForSelector('.gh__title');
    await botButton(page).click();
    await until(async () => (await botText(page)) === 'Allow on Twitch', 'needs-ok: button asks to allow on Twitch');
    await until(async () => (await page.locator('app-toast-container').innerText()).includes('Twitch needs your OK first'), 'needs-ok: toast explains');
    await page.waitForTimeout(1100);
    await botButton(page).click();
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
    await page.waitForSelector('.gh__title');
    await until(async () => (await botText(page)) === 'Turn the bot off', 'resume: dashboard updated');
    await page.reload();
    await page.waitForSelector('.gh__title');
    await page.waitForTimeout(500);
    assert.deepEqual(state.posts, [true], 'resume: only once');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS pending join resumes once after sign-in');
  }

  // 4. The navbar CTA starts full access (desktop + phone); no separate menu item.
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, state } = await open(browser, { actived: false, chatEnabled: true, viewport });
    await page.locator('.auth-navbar__cta-btn--activate').dblclick();
    await until(async () => state.redirects.some((u) => u.includes('/auth/authorize')), 'navbar CTA: full access redirect');
    const target = new URL(state.redirects.find((u) => u.includes('/auth/authorize')));
    assert.equal(target.searchParams.get('action'), 'activate');
    assert.equal(target.searchParams.get('state'), 'newbie');
    await context.close();
  }
  console.log('PASS navbar Activate Bot starts full access on desktop and phone');

  // 5. Streamers with full access: no CTA, dashboard button works; lost permissions keep Reauthenticate.
  {
    const { context, page } = await open(browser, { actived: true, chatEnabled: true, viewport: { width: 1280, height: 900 } });
    await page.waitForSelector('.gh__title');
    assert.equal(await page.locator('.auth-navbar__cta-btn').count(), 0, 'no navbar CTA with full access');
    assert.equal(await botText(page), 'Turn the bot off');
    assert.equal(await page.locator('[data-testid="dashboard-setup"]').count(), 0, 'no setup card with full access');
    await context.close();

    const broken = await open(browser, { actived: true, chatEnabled: true, hasPermissions: false, viewport: { width: 1280, height: 900 } });
    await broken.page.locator('.auth-navbar__cta-btn--reauthenticate').waitFor();
    await broken.context.close();
    console.log('PASS full-access streamers: no CTA, dashboard button; lost permissions keep Reauthenticate');
  }

  // 6. Commands before full access: basic built-ins are real commands, only Twitch-dependent ones locked.
  for (const [theme, viewport] of [['dark', { width: 390, height: 844 }], ['light', { width: 1280, height: 900 }], ['dark', { width: 320, height: 700 }]]) {
    const label = `commands-${theme}-${viewport.width}`;
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: false, theme, viewport, path: '/newbie/commands', commands: BASIC_COMMANDS });
    await page.locator('.lf-item--locked').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.lf-item--locked').count(), LOCKED.length, `${label}: only Twitch-dependent defaults locked`);
    assert.equal(await page.locator('.lf-item--locked .lf-switch, .lf-item--locked button').count(), 0, `${label}: locked rows have no switch or buttons`);
    // textContent: groups start folded on "All", so innerText of the rows would be empty.
    const lockedTriggers = await page.locator('.lf-item--locked .lf-trigger').evaluateAll((els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(lockedTriggers.map((t) => t.replace('!', '')).sort(), LOCKED.map((c) => c.cmd).sort(), `${label}: locked set`);
    const liveSwitches = await page.locator('.lf-cmd-row:not(.lf-item--locked) .lf-switch input').count();
    assert.equal(liveSwitches, BASIC_COMMANDS.length, `${label}: basic built-ins are real, switchable commands`);
    const note = page.locator('app-full-access-note');
    assert.equal(await note.count(), 1, `${label}: one full-access note`);
    assert.match(await note.locator('button').innerText(), /Activate Bot/i, `${label}: note uses the navbar CTA label`);
    assert.match(await page.locator('.lf-chat-note').innerText(), /The bot isn't in your chat yet/, `${label}: chat note`);
    await page.locator('.lf-filter-tab[data-kind="builtin"]').click();
    await until(async () => (await page.locator('.lf-item--locked').first().isVisible()), `${label}: Built-in tab opens the groups`);
    await noOverflow(page, label);
    await axe(page, label);
    await shot(page, `${label}-locked`);
    assert.deepEqual(state.commandWrites, [], `${label}: nothing written`);
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
    console.log(`PASS ${label}: basic built-ins live, Twitch-dependent ones locked`);
  }

  // 7. Own command replaces a locked default; empty list offers the TTS quick start; full access shows no locks.
  {
    const ownTitle = { ...BASIC_COMMANDS[0], _id: 'own-title', name: 'My title', cmd: 'title', func: 'title', reserved: false, message: 'Title: &t' };
    const { context, page } = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/commands', commands: [...BASIC_COMMANDS, ownTitle] });
    await page.locator('.lf-item--locked').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.lf-item--locked').count(), LOCKED.length - 1, 'own !title replaces the locked default');
    assert.equal(await page.locator('.lf-chat-note').count(), 0, 'no chat note while the bot is in chat');
    await context.close();

    const empty = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/commands', commands: [] });
    await empty.page.locator('button', { hasText: 'Text-to-speech command' }).dblclick();
    const modal = empty.page.locator('app-command-modal [role="dialog"]');
    await modal.waitFor();
    assert.equal(await modal.locator('input[formcontrolname="cmd"]').inputValue(), 'tts', '!tts prefilled');
    assert.equal(await modal.locator('textarea[formcontrolname="message"]').inputValue(), '$(tts $(user) says: &t)', 'TTS reply prefilled');
    assert.equal(await modal.locator('.lf-timer-block').count(), 0, 'no timer option before full access');
    assert.deepEqual(empty.state.commandWrites, [], 'opening the dialog writes nothing');
    await empty.context.close();

    const full = CATALOG.map((c) => ({ ...BASIC_COMMANDS[0], _id: `full-${c.func}`, name: c.name, cmd: c.cmd, func: c.func, reserved: c.reserved, message: c.message ?? '' }));
    const done = await open(browser, { actived: true, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/commands', commands: full });
    await done.page.locator('.lf-cmd-row').first().waitFor({ state: 'attached' });
    await done.page.waitForTimeout(400);
    assert.equal(await done.page.locator('.lf-item--locked').count(), 0, 'full access: no locked rows');
    assert.equal(await done.page.locator('app-full-access-note').count(), 0, 'full access: no note');
    await done.context.close();
    console.log('PASS own commands replace locked defaults; TTS quick start; full access shows no locks');
  }
  // 8. Twitch-dependent modules are visible but disabled before full access; the hub marks them.
  {
    const { context, page, errors, state } = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/modules' });
    await page.locator('[data-full-access-chip]').first().waitFor();
    const locked = await page.locator('[data-full-access-chip]').count();
    assert.equal(locked, 7, `modules: 7 modules need full access (got ${locked})`);
    await context.close();

    const full = await open(browser, { actived: true, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/modules' });
    await full.page.waitForSelector('.auth-navbar');
    await full.page.waitForTimeout(800);
    assert.equal(await full.page.locator('[data-full-access-chip]').count(), 0, 'modules: no chips with full access');
    await full.context.close();

    const mod = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 390, height: 844 }, path: '/newbie/modules/moderation' });
    await mod.page.locator('app-full-access-note').waitFor();
    await until(async () => (await mod.page.locator('.lf-rules-head .lf-switch input').count()) > 0, 'moderation: rules render');
    assert.equal(await mod.page.locator('.lf-rules-head .lf-switch input:not(:disabled)').count(), 0, 'moderation: rule switches disabled');
    assert.equal(await mod.page.locator('.lf-save-bar').count(), 0, 'moderation: no save bar');
    await mod.page.waitForTimeout(500); // let loading/colour transitions settle before axe
    await noOverflow(mod.page, 'moderation-setup');
    await axe(mod.page, 'moderation-setup');
    assert.deepEqual(mod.state.commandWrites, []);
    assert.deepEqual(mod.errors, [], 'moderation: page errors');
    await mod.context.close();

    const fd = await open(browser, { actived: false, chatEnabled: true, viewport: { width: 390, height: 844 }, path: '/newbie/modules/follow-defense' });
    await fd.page.locator('app-full-access-note').waitFor();
    await until(async () => (await fd.page.locator('.lf-switch input').count()) > 0, 'follow defense: switches render');
    assert.equal(await fd.page.locator('.lf-switch input:not(:disabled)').count(), 0, 'follow defense: switches disabled');
    assert.equal(await fd.page.locator('.lf-now__actions').count(), 0, 'follow defense: no attack/reset actions');
    assert.equal(await fd.page.locator('.lf-save-bar').count(), 0, 'follow defense: no save bar');
    await fd.page.waitForTimeout(500); // let loading/colour transitions settle before axe
    await noOverflow(fd.page, 'follow-defense-setup');
    await axe(fd.page, 'follow-defense-setup');
    assert.deepEqual(fd.errors, [], 'follow defense: page errors');
    await fd.context.close();
    assert.deepEqual(errors, []);
    // A manager of a channel without full access gets the same locks (owner-only note, no button).
    const mgr = await open(browser, { manager: true, channelActived: false, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/modules/moderation' });
    await mgr.page.locator('app-full-access-note').waitFor();
    assert.match(await mgr.page.locator('app-full-access-note').innerText(), /Only the channel owner/, 'manager: owner-only note');
    assert.equal(await mgr.page.locator('app-full-access-note button').count(), 0, 'manager: no activate button');
    await until(async () => (await mgr.page.locator('.lf-rules-head .lf-switch input').count()) > 0, 'manager: rules render');
    assert.equal(await mgr.page.locator('.lf-rules-head .lf-switch input:not(:disabled)').count(), 0, 'manager: rule switches disabled');
    await mgr.context.close();
    const mgrHub = await open(browser, { manager: true, channelActived: false, chatEnabled: true, viewport: { width: 1280, height: 900 }, path: '/newbie/modules' });
    await until(async () => (await mgrHub.page.locator('[data-full-access-chip]').count()) > 0, 'manager hub: chips once the channel lookup returns');
    await mgrHub.context.close();
    console.log('PASS moderation and follow defense disabled before full access (owner and manager); hub marks 7 modules');
  }
} finally {
  await browser.close();
}
