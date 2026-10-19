/**
 * Behavior check: the streamer dashboard ("Split + Briefing" layout).
 *
 * Renders the real DashboardComponent against a mocked session + API and
 * asserts the new layout with real numbers:
 *  - header answer line computed from the last 7 days vs the 7 before;
 *  - bot health row (bot in chat, chat events on, credits forecast, automod)
 *    on tablet/desktop and the one-line strip on phones;
 *  - shortcuts to TTS / chat events / triggers / moderation;
 *  - "Your week" facts, automod + sanctions cards from moderation logs;
 *  - "coming soon" tiles for data still being built (tips, games, days,
 *    raids, commands, emotes) and "Show me" chips that hide/show them and
 *    persist across reloads;
 *  - phone tabs between "Your channel" and "Your bot";
 *  - folded stream history (chart sizes once opened, one row per stream) and goals;
 *  - failure cases: bot out of chat (warning + join works), automod off,
 *    chat events failing to load, live stream strip;
 *  - no horizontal overflow, no page errors, no serious axe violations in
 *    dark and light.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/dashboard-split-briefing-shots';
mkdirSync(shots, { recursive: true });

const CHANNEL_ID = '123456789';
const DAY = 86_400_000;
const TWITCH = { id: CHANNEL_ID, login: 'test', display_name: 'Test Streamer', profile_image_url: '' };

/** Noon UTC, `days` ago. */
function daysAgo(days, hour = 12) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return new Date(d.getTime() - days * DAY).toISOString();
}

// This week: 3 streams, 9.5 h, 30 follows. Week before: 2 streams, 25 follows (+20%).
const HISTORY = [
  { d: 27, hours: 2, follows: 4 },
  { d: 20, hours: 3, follows: 6 },
  { d: 15, hours: 2.5, follows: 5 },
  { d: 10, hours: 3, follows: 10 },
  { d: 8, hours: 2, follows: 15 },
  { d: 5, hours: 4.5, follows: 8 },
  { d: 3, hours: 3, follows: 12 },
  { d: 1, hours: 2, follows: 10 }
].map((s, i) => ({
  date: daysAgo(s.d),
  viewers: 40 + i * 5,
  hours: s.hours,
  bits: 100 * (i + 1),
  donations: 2.5 * i,
  follows: s.follows,
  subs: i % 3
}));

// 5 automod actions this week (spam_bot ×3), 2 the week before.
const LOGS = [
  { u: 'spam_bot', rule: 'links', action: 'delete', d: 1 },
  { u: 'spam_bot', rule: 'links', action: 'timeout', d: 1.2 },
  { u: 'spam_bot', rule: 'links', action: 'ban', d: 2 },
  { u: 'loud_lu', rule: 'caps', action: 'delete', d: 3 },
  { u: 'rude_ray', rule: 'blacklist', action: 'warn', d: 4 },
  { u: 'old_one', rule: 'caps', action: 'delete', d: 9 },
  { u: 'old_two', rule: 'links', action: 'delete', d: 10 }
].map((l, i) => ({
  _id: `log${i}`,
  channelID: CHANNEL_ID,
  userID: `u${i}`,
  username: l.u,
  ruleID: `r-${l.rule}`,
  ruleType: l.rule,
  action: l.action,
  offenseNumber: 1 + (i % 3),
  reason: 'test',
  messageID: `m${i}`,
  messageExcerpt: 'x',
  success: true,
  errorMessage: null,
  createdAt: new Date(Date.now() - l.d * DAY).toISOString()
}));

function bootstrapData({ chatEnabled }) {
  return {
    role: 'owner',
    channel: { id: CHANNEL_ID, name: 'Test Streamer', chatEnabled },
    isLive: false,
    liveStream: null,
    liveSession: null,
    kpis: {
      activeViewers: 0, averageViewers: 60, monthlyAverageViewers: 60, averageHoursPerStream: 2.8,
      totalBits: 3600, totalStreams: HISTORY.length, totalDonations: 70, activeFollows: 70, activeSubs: 7,
      monthlyGoalSubs: 100, subsProgressPct: 7
    },
    trend: [],
    streamHistory: HISTORY,
    totalFollowers: 5400,
    totalSubs: 320,
    monthlyGoals: { followersGoal: 6000, followersCurrent: 5400, subsGoal: 500, subsCurrent: 320 }
  };
}

const LIVE_SESSION = {
  isLive: true, startedAt: new Date(Date.now() - 130 * 60_000).toISOString(), durationMinutes: 130,
  averageViewers: 80, peakViewers: 120, currentViewers: 87, follows: 6, subs: 2, bits: 500,
  donations: 5, messages: 1400, commands: 30
};

function usageSummary(overPace) {
  const endsAt = new Date(Date.now() + 11 * DAY).toISOString();
  return {
    planTier: 'premium',
    capabilities: { balance: true, pacing: true, dailySpend: true, categoryBreakdown: true, transactions: true },
    credits: { used: 600, limit: 1000, balance: 400, meterId: 'm', updatedAt: new Date().toISOString(), available: true },
    billingPeriod: {
      source: 'subscription', startsAt: daysAgo(19), endsAt, endExclusive: true,
      from: daysAgo(19), to: endsAt, totalDayCount: 30, elapsedDayCount: 19
    },
    pacing: overPace
      ? {
          status: 'over_pace', forecastBasis: 'current_billing_period', quotaUsedPercent: 60, averageDailyCredits: 95,
          projectedPeriodCredits: 1600, projectedQuotaUsedPercent: 160, projectedOverageCredits: 600,
          remainingPeriodDays: 11, dailyCreditsToLastPeriod: 36, expectedToExhaustWithinPeriod: true,
          estimatedDaysUntilExhaustion: 4.2, estimatedExhaustionAt: new Date(Date.now() + 4.2 * DAY).toISOString()
        }
      : {
          status: 'within_pace', forecastBasis: 'current_billing_period', quotaUsedPercent: 60, averageDailyCredits: 20,
          projectedPeriodCredits: 820, projectedQuotaUsedPercent: 82, projectedOverageCredits: 0,
          remainingPeriodDays: 11, dailyCreditsToLastPeriod: 36, expectedToExhaustWithinPeriod: false,
          estimatedDaysUntilExhaustion: null, estimatedExhaustionAt: null
        },
    analytics: null
  };
}

const SITE_EVENTS = ['channel.follow', 'channel.subscribe', 'channel.raid'].map((type) => ({
  name: type, type, version: '1', description: { en: type, es: type }, icon: 'X', color: '#000', textColor: '#fff',
  releaseStage: 'stable', enabled: false
}));

function envelope(data) {
  return { error: false, status: 200, message: 'ok', data };
}

/**
 * @param {object} o scenario: chatEnabled, live, automodOn, eventsFail, overPace, theme, language
 */
async function newPage(browser, viewport, o) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'UTC', colorScheme: o.theme });
  const state = { chatEnabled: o.chatEnabled, toggles: [] };
  const app = {
    name: 'Test Streamer', email: 'test@example.invalid', language: o.language ?? 'en', plan_tier: 'premium', actived: true,
    chat_enabled: o.chatEnabled, twitch_user_id: CHANNEL_ID, has_permissions: true, up_to_date_permissions: true, administrating: []
  };
  await context.addInitScript(({ twitch, app, theme, keepTopics }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
    }));
    localStorage.setItem('theme', theme);
    localStorage.setItem('dimasite.referral_promo.dismissed_at', String(Date.now()));
    // First load of each tab only, so reloads keep what the page saved.
    if (!sessionStorage.getItem('dash-check')) {
      sessionStorage.clear();
      localStorage.removeItem('dimasite.dashboard.topics');
      sessionStorage.setItem('dash-check', '1');
    }
  }, { twitch: TWITCH, app, theme: o.theme });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();

    const p = url.pathname;
    let data = {};
    if (p === '/auth/session') data = { twitch: TWITCH, app };
    else if (p.startsWith('/auth/access/')) data = { allowed: true, role: 'owner' };
    else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(p)) data = bootstrapData({ chatEnabled: state.chatEnabled });
    else if (/^\/dashboard\/[^/]+\/access$/.test(p)) data = { allowed: true, role: 'owner', channelID: CHANNEL_ID, channelName: 'Test Streamer', planTier: 'premium' };
    else if (/^\/dashboard\/[^/]+\/live-status$/.test(p)) {
      data = o.live
        ? {
            isLive: true, checkedAt: new Date().toISOString(), liveSession: LIVE_SESSION,
            stream: { id: 's', user_id: CHANNEL_ID, user_login: 'test', user_name: 'Test Streamer', game_name: 'Celeste', title: 'Speedrun night',
              viewer_count: 87, started_at: LIVE_SESSION.startedAt, language: 'en', thumbnail_url: '', is_mature: false }
          }
        : { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    } else if (p === '/billing/ai-credits') data = { used: 600, limit: 1000, balance: 400, meterId: 'm', updatedAt: new Date().toISOString(), available: true };
    else if (p === '/billing/ai-usage/summary') data = usageSummary(o.overPace);
    else if (/^\/moderation\/[^/]+\/logs$/.test(p)) data = { logs: LOGS, total: LOGS.length, limit: 100, skip: 0 };
    else if (/^\/moderation\/[^/]+\/settings$/.test(p)) data = { channelID: CHANNEL_ID, channel: 'test', enabled: o.automodOn, offenseWindowSeconds: 600, rules: [], settingsVersion: 1 };
    else if (p === '/site/events') {
      if (o.eventsFail) return route.fulfill({ status: 500, json: { error: true, message: 'boom' } });
      data = SITE_EVENTS;
    } else if (p.startsWith('/eventsubs/')) {
      if (o.eventsFail) return route.fulfill({ status: 500, json: { error: true, message: 'boom' } });
      data = [
        { _id: 'a', status: 'enabled', type: 'channel.follow', version: '1', enabled: true },
        { _id: 'b', status: 'enabled', type: 'channel.raid', version: '1', enabled: true }
      ];
    } else if (p.startsWith('/users/chat/') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      state.chatEnabled = !!body.enabled;
      state.toggles.push(body.enabled);
      data = { chatEnabled: state.chatEnabled };
    } else if (p.startsWith('/goals/')) {
      data = { plan: 'premium', limit: 3, metrics: ['follows'], revision: 1, goals: [], canManage: true };
    } else if (p === '/users') data = { id: CHANNEL_ID, username: 'test', profile_image_url: '' };
    return route.fulfill({ status: 200, json: envelope(data) });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/test/dashboard`);
  await page.waitForSelector('.gh__title', { timeout: 20000 });
  return { context, page, errors, state };
}

async function until(fn, message, timeout = 5000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${message} (last: ${JSON.stringify(last)})`);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const visible = (page, sel) => page.locator(sel).first().isVisible();

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: page overflows horizontally by ${overflow}px`);
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).include('app-dashboard').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.deepEqual(
    bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`),
    [],
    `${label}: axe violations`
  );
}

async function primaryButtonsPainted(page, label) {
  const transparent = await page.evaluate(() =>
    [...document.querySelectorAll('app-dashboard .btn--primary, app-dashboard .bs__buy--primary, app-dashboard .hc__btn--primary')]
      .filter((el) => el.getClientRects().length)
      .filter((el) => ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(el).backgroundColor))
      .map((el) => el.textContent.trim())
  );
  assert.deepEqual(transparent, [], `${label}: primary buttons without a background`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // ---------------------------------------------------- 1. desktop, healthy bot, credits running short
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await newPage(browser, { width: 1366, height: 900 }, {
      chatEnabled: true, automodOn: true, overPace: true, theme
    });
    const label = `desktop-${theme}`;

    await until(async () => (await text(page, '.answer')).includes('Automod stepped in 5 times'), `${label}: answer waits for automod`);
    const answer = await text(page, '.answer');
    assert.match(answer, /3 streams, 9h 30m live\./, `${label}: answer streams`);
    assert.match(answer, /30 new followers \(\+20% vs the week before\)/, `${label}: answer follows`);
    assert.match(await text(page, '.gh .chips'), /Last stream/, `${label}: last stream chip`);
    assert.match(await text(page, '.gh .chips'), /Bot in your chat/, `${label}: bot chip`);

    // Health row
    assert.ok(await visible(page, '.bs'), `${label}: health row visible`);
    assert.ok(!(await visible(page, '.strip')), `${label}: phone strip hidden`);
    const health = await page.locator('.bs__item').allInnerTexts();
    assert.equal(health.length, 4, `${label}: four health items`);
    assert.match(health[0], /Bot in your chat/);
    await until(async () => (await page.locator('.bs__item').nth(1).innerText()).includes('2 of 3 chat events on'), `${label}: chat events count`);
    assert.match(health[2], /40% credits left/, `${label}: credits left`);
    assert.match(health[2], /Runs out in ~4 days, 7 days before reset/, `${label}: credits forecast`);
    assert.equal(await page.locator('.bs__item').nth(2).getAttribute('data-tone'), 'warn', `${label}: credits warn tone`);
    assert.equal(await page.locator('.bs__buy--primary').getAttribute('href'), '/test/credits', `${label}: buy credits link`);
    assert.match(health[3], /5 automod actions/, `${label}: automod count`);

    // Shortcuts
    const hrefs = await page.locator('.hm__btn').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    assert.deepEqual(hrefs, ['/test/modules/tts', '/test/modules/chat-events', '/test/modules/triggers', '/test/modules/moderation'], `${label}: shortcuts`);

    // Both panes side by side, tabs hidden
    assert.ok(!(await visible(page, '.tabs')), `${label}: tabs hidden on desktop`);
    assert.ok(await visible(page, '#dash-channel') && await visible(page, '#dash-bot-title'), `${label}: both panes visible`);
    const panes = await page.evaluate(() => [...document.querySelectorAll('.sp > .pane')].map((p) => Math.round(p.getBoundingClientRect().top)));
    assert.ok(Math.abs(panes[0] - panes[1]) < 4, `${label}: panes side by side (${panes})`);

    // Week facts
    const facts = await page.locator('.wk__fact').allInnerTexts();
    assert.equal(facts.length, 6, `${label}: six week facts`);
    assert.match(facts[0], /Streams\s+3\s+\+50%/, `${label}: streams fact ${facts[0]}`);
    assert.match(facts[2], /New followers\s+30\s+\+20%/, `${label}: follows fact ${facts[2]}`);

    // Coming soon tiles: tips/games/days/raids on the channel, commands/emotes on the bot
    assert.equal(await page.locator('.pane:not(.pane--bot) .soon').count(), 4, `${label}: channel coming-soon tiles`);
    assert.equal(await page.locator('.pane--bot .soon').count(), 2, `${label}: bot coming-soon tiles`);
    assert.equal(await page.locator('.soon__chip').first().innerText(), 'COMING SOON', `${label}: coming soon chip`);

    // Automod + sanctions from logs
    const automod = await text(page, '[aria-labelledby="dash-automod"]');
    assert.match(automod, /Automod stepped in 5 times/);
    assert.match(automod, /\+150% vs the week before/);
    assert.match(automod, /Links\s+3/);
    assert.match(automod, /Caps\s+1/);
    assert.match(automod, /Blocked words\s+1/);
    assert.match(automod, /Deleted\s+2\s+Warned\s+1\s+Timeouts\s+1\s+Bans\s+1/);
    assert.match(automod, /spam_bot was sanctioned 3 times this week/);
    assert.equal(await page.locator('[aria-labelledby="dash-sanctions"] .hs').count(), 6, `${label}: six latest sanctions`);
    assert.match(await text(page, '[aria-labelledby="dash-sanctions"] .hs'), /spam_bot[\s\S]*Links · offense 1[\s\S]*Deleted/);

    // History fold: chart sized once opened, one row per stream
    await page.locator('.fold > summary').first().click();
    await until(async () => page.evaluate(() => {
      const c = document.querySelector('.fold[open] .chart canvas');
      return c && c.getBoundingClientRect().width > 300 && c.getBoundingClientRect().height > 150;
    }), `${label}: chart sized after opening history`);
    assert.equal(await page.locator('.streams .srow').count(), HISTORY.length, `${label}: stream rows`);
    await page.locator('.fold > summary').nth(1).click();
    assert.match(await text(page, '.fold >> nth=1'), /5,400 followers · 320 subs/, `${label}: goals summary`);

    await noOverflow(page, label);
    await primaryButtonsPainted(page, label);
    await axe(page, label);
    await page.screenshot({ path: `${shots}/${label}.png`, fullPage: true });
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
  }

  // ---------------------------------------------------- 2. "Show me" chips hide tiles and persist
  {
    const { context, page } = await newPage(browser, { width: 1366, height: 900 }, { chatEnabled: true, automodOn: true, overPace: false, theme: 'dark' });
    const chip = page.locator('.topic', { hasText: 'Games' });
    assert.equal(await chip.getAttribute('aria-pressed'), 'true');
    await chip.click();
    await until(async () => (await page.locator('.pane:not(.pane--bot) .soon').count()) === 3, 'games tile hidden after chip click');
    await page.locator('.topic', { hasText: 'Moderation' }).click();
    await until(async () => (await page.locator('app-dashboard-moderation-card').count()) === 0, 'moderation cards hidden');
    for (const name of ['Commands', 'Emotes']) await page.locator('.topic', { hasText: name }).click();
    await until(async () => (await text(page, '.pane--bot')).includes('Nothing picked for this side'), 'bot side empty message');
    await page.reload();
    await page.waitForSelector('.gh__title');
    assert.equal(await page.locator('.topic', { hasText: 'Games' }).getAttribute('aria-pressed'), 'false', 'chip choice persisted');
    assert.equal(await page.locator('.pane:not(.pane--bot) .soon').count(), 3, 'games tile still hidden after reload');
    // Credits within pace
    await until(async () => (await page.locator('.bs__item').nth(2).innerText()).includes('Should last until they reset on'), 'credits on-track text');
    assert.equal(await page.locator('.bs__item').nth(2).getAttribute('data-tone'), 'ok');
    await context.close();
  }

  // ---------------------------------------------------- 3. phones: strip, tabs, both themes
  for (const [width, theme] of [[390, 'dark'], [320, 'light']]) {
    const { context, page, errors } = await newPage(browser, { width, height: 844 }, { chatEnabled: true, automodOn: true, overPace: true, theme });
    const label = `mobile-${width}-${theme}`;
    await until(async () => (await text(page, '.strip')).includes('Automod 5'), `${label}: strip automod`);
    assert.ok(!(await visible(page, '.bs')), `${label}: health row hidden`);
    assert.match(await text(page, '.strip'), /Bot in your chat[\s\S]*2\/3 events[\s\S]*40% credits/, `${label}: strip content`);
    assert.ok(await visible(page, '.tabs'), `${label}: tabs visible`);
    assert.ok(await visible(page, '.wk'), `${label}: channel pane shown first`);
    assert.ok(!(await visible(page, '#dash-bot')), `${label}: bot pane hidden first`);
    await page.locator('.tabs button', { hasText: 'Your bot' }).click();
    await until(async () => visible(page, '#dash-bot'), `${label}: bot tab shows bot pane`);
    assert.ok(!(await visible(page, '.wk')), `${label}: bot tab hides channel pane`);
    await page.locator('.tabs button', { hasText: 'Your channel' }).click();
    await until(async () => visible(page, '.wk'), `${label}: channel tab back`);
    await page.locator('.strip').click();
    await until(async () => visible(page, '#dash-bot'), `${label}: strip opens bot pane`);
    // tap targets
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('app-dashboard .tabs button, app-dashboard .topic, app-dashboard .gh__bot, app-dashboard .hm__btn')]
        .filter((el) => el.getClientRects().length && el.getBoundingClientRect().height < 40)
        .map((el) => el.textContent.trim())
    );
    assert.deepEqual(small, [], `${label}: tap targets under 40px`);
    await noOverflow(page, label);
    await primaryButtonsPainted(page, label);
    await axe(page, label);
    await page.locator('.tabs button', { hasText: 'Your channel' }).click();
    await page.screenshot({ path: `${shots}/${label}.png`, fullPage: true });
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
  }

  // ---------------------------------------------------- 4. failure cases: bot out, automod off, events fail
  {
    const { context, page, errors, state } = await newPage(browser, { width: 1366, height: 900 }, {
      chatEnabled: false, automodOn: false, eventsFail: true, overPace: false, theme: 'dark'
    });
    const label = 'desktop-bot-out';
    assert.match(await text(page, '.gh__warn'), /isn't in your chat/, `${label}: warning`);
    assert.equal(await page.locator('.bs__item').first().getAttribute('data-tone'), 'warn');
    await until(async () => (await page.locator('.bs__item').nth(1).innerText()).includes("Couldn't load right now"), `${label}: events error`);
    await until(async () => (await page.locator('.bs__item').nth(3).innerText()).includes('Automod is off'), `${label}: automod off in health`);
    assert.match(await text(page, '[aria-labelledby="dash-automod"]'), /Automod is off[\s\S]*Turn on automod/, `${label}: automod card off`);
    assert.doesNotMatch(await text(page, '.answer'), /Automod/, `${label}: answer skips automod when off`);
    await page.screenshot({ path: `${shots}/${label}.png`, fullPage: false });
    await primaryButtonsPainted(page, label);
    await page.locator('.gh__bot').click();
    await until(async () => (await text(page, '.gh .chips')).includes('Bot in your chat'), `${label}: join flips bot chip`);
    assert.deepEqual(state.toggles, [true], `${label}: one join request`);
    assert.equal(await page.locator('.gh__warn').count(), 0, `${label}: warning gone after join`);
    assert.match(await text(page, '.gh__bot'), /Turn the bot off/, `${label}: button now turns the bot off`);
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
  }

  // ---------------------------------------------------- 5. live stream
  {
    const { context, page, errors } = await newPage(browser, { width: 1366, height: 900 }, { chatEnabled: true, automodOn: true, live: true, theme: 'dark' });
    const label = 'desktop-live';
    await until(async () => visible(page, '.gl'), `${label}: live strip`);
    assert.match(await text(page, '.gh .chips'), /Live for 2h 10m/, `${label}: live chip`);
    const live = await text(page, '.gl');
    assert.match(live, /Speedrun night/);
    assert.match(live, /Celeste/);
    assert.match(live, /Watching\s+87/);
    assert.match(live, /Peak\s+120/);
    assert.match(live, /Follows\s+\+6/);
    assert.match(live, /Messages\s+1\.4K/);
    assert.equal(await page.locator('.gl__link').getAttribute('href'), '/test/modules/analytics/timeline');
    await axe(page, label);
    await page.screenshot({ path: `${shots}/${label}.png`, fullPage: false });
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
  }

  // ---------------------------------------------------- 6. Spanish
  {
    const { context, page, errors } = await newPage(browser, { width: 390, height: 844 }, { chatEnabled: true, automodOn: true, overPace: true, theme: 'dark', language: 'es' });
    await until(async () => (await text(page, '.answer')).includes('El automod actuó 5 veces'), 'es: answer');
    assert.match(await text(page, '.answer'), /3 directos/);
    assert.equal(await page.locator('.soon__chip').first().innerText(), 'MUY PRONTO');
    assert.equal(await page.evaluate(() => document.body.innerText.includes('dashboard.brief')), false, 'es: no missing keys');
    await noOverflow(page, 'es');
    await page.screenshot({ path: `${shots}/mobile-es.png`, fullPage: true });
    assert.deepEqual(errors, [], 'es: page errors');
    await context.close();
  }

  console.log('PASS dashboard split + briefing: health, shortcuts, week, automod, coming soon, topics, tabs, history, failure cases, live, es');
} finally {
  await browser.close();
}
