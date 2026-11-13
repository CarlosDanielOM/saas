// Admin channel workspace (/channels/:id/…): the frame (one header, tab strip, badges) and the tabs it owns
// (Overview, Commands, Twitch events, AI & credits, Bot log). Every API call is mocked on both api.domdimabot.com
// and localhost:3000: no credit grant, reminder email or EventSub change can reach production.
// Covers the answer lines, tab switching without reloading the channel, deep links, unknown/failed channel,
// the last-24-hours block and its links, the confirmed grant and reminder flows (request bodies asserted),
// command run stats/reasons/sorts/search, Twitch event activity/alerts/revocations and the confirmed test event,
// the bot log levels/rows/copy/show more/empty/error, and layout + accessibility at 320/390/1280 in dark and light.
//
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4310), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright),
// SAAS_SCREENSHOTS (default /tmp/saas-admin-console-channel).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// ---------------------------------------------------------------------------------------------
// Fixtures (fictional names only)
// ---------------------------------------------------------------------------------------------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const channels = {
  '8100001': { channel: 'mossy_lantern', channelID: '8100001', email: 'mossy_lantern@example.test', plan_tier: 'pro', actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true, isLive: true, liveViewers: 1284, commandsCount: 9, eventsubsActiveCount: 5, eventsubsDisabledCount: 1, created_at: '2026-05-02T10:00:00.000Z', reminder_sent_at: null },
  '8100002': { channel: 'quiet_fjord', channelID: '8100002', email: 'quiet_fjord@example.test', plan_tier: 'free', actived: false, chat_enabled: false, has_permissions: true, up_to_date_permissions: false, isLive: false, liveViewers: 0, commandsCount: 0, eventsubsActiveCount: 0, eventsubsDisabledCount: 0, created_at: '2026-10-28T10:00:00.000Z', reminder_sent_at: '2026-11-01T12:00:00Z' },
};

const commands = [
  { id: 'c1', name: 'Shoutout', cmd: '!so', func: 'shoutout', message: 'Go follow $(touser) at twitch.tv/$(touser), they were playing $(game)!', enabled: true, cooldown: 30, userLevelName: 'Moderators' },
  { id: 'c2', name: 'Discord invite', cmd: '!discord', func: 'send_chat_message', message: 'Join the lantern crew: example.test/discord', enabled: true, cooldown: 120, userLevelName: 'Everyone' },
  { id: 'c3', name: 'Lurk', cmd: '!lurk', func: 'send_chat_message', message: '$(user) is lurking with a warm cup of tea. Enjoy!', enabled: true, cooldown: 10, userLevelName: 'Everyone' },
  { id: 'c4', name: 'Socials', cmd: '!socials', func: 'send_chat_message', message: 'Find me everywhere: example.test/links', enabled: false, cooldown: 60, userLevelName: 'Everyone' },
  { id: 'c5', name: 'Hug', cmd: '!hug', func: 'send_chat_message', message: '$(user) gives $(touser) a big lantern hug', enabled: true, cooldown: 5, userLevelName: 'Subscribers' },
  { id: 'c6', name: 'Uptime', cmd: '!uptime', func: 'uptime', message: '', enabled: true, cooldown: 15, userLevelName: 'Everyone' },
  { id: 'c7', name: 'Ask the AI', cmd: '!ask', func: 'ai_reply', message: 'A long reply template so the two-line clamp has something to cut: the bot answers in the streamer’s voice using what it remembers about the stream, the game and the regulars in chat.', enabled: true, cooldown: 20, userLevelName: 'VIPs' },
  { id: 'c8', name: 'Schedule', cmd: '!schedule', func: 'send_chat_message', message: 'Streams Tue/Thu/Sat 7pm', enabled: true, cooldown: 60, userLevelName: 'Everyone' },
  { id: 'c9', name: 'Points', cmd: '!points', func: 'points', message: '$(user) has $(points) lanterns', enabled: true, cooldown: 0, userLevelName: 'Everyone' },
];

const commandStats = (recorded = true) => ({
  from: ago(7 * 1440), to: ago(0),
  recordsSince: recorded ? ago(9 * 1440) : null,
  commands: recorded ? [
    { name: '!lurk', runs: 512, ok: 490, skipped: 22, blocked: 0, failed: 0, lastAt: ago(4), lastOutcome: 'ok', lastReason: null, reasons: [{ reason: 'cooldown', count: 22 }] },
    { name: '!so', runs: 140, ok: 121, skipped: 11, blocked: 8, failed: 0, lastAt: ago(38), lastOutcome: 'blocked', lastReason: 'permission_denied', reasons: [{ reason: 'cooldown', count: 11 }, { reason: 'permission_denied', count: 8 }] },
    { name: '!ask', runs: 61, ok: 55, skipped: 0, blocked: 0, failed: 6, lastAt: ago(130), lastOutcome: 'failed', lastReason: 'no_credits', reasons: [{ reason: 'no_credits', count: 4 }, { reason: 'exception', count: 2 }] },
    { name: '!discord', runs: 33, ok: 33, skipped: 0, blocked: 0, failed: 0, lastAt: ago(600), lastOutcome: 'ok', lastReason: null, reasons: [] },
    { name: '!socials', runs: 3, ok: 0, skipped: 3, blocked: 0, failed: 0, lastAt: ago(3000), lastOutcome: 'skipped', lastReason: 'disabled', reasons: [{ reason: 'disabled', count: 3 }] },
    { name: '!tts', runs: 18, ok: 18, skipped: 0, blocked: 0, failed: 0, lastAt: ago(55), lastOutcome: 'ok', lastReason: null, reasons: [] },
  ] : [],
});

const standardTypes = [
  { type: 'channel.follow', version: '2', condition: {} },
  { type: 'channel.subscribe', version: '1', condition: {} },
  { type: 'channel.raid', version: '1', condition: {} },
  { type: 'stream.online', version: '1', condition: {} },
  { type: 'channel.bits.use', version: '1', condition: {} },
  { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: {} },
];
const channelEventsubs = (state) => [
  { id: 'es1', type: 'channel.follow', version: '2', status: 'enabled', enabled: state.followEnabled, created_at: '2026-08-10T12:00:00Z' },
  ...(state.subscribeConnected ? [{ id: 'es2', type: 'channel.subscribe', version: '1', status: 'enabled', enabled: true, created_at: '2026-11-03T12:00:00Z' }] : []),
  { id: 'es3', type: 'channel.raid', version: '1', status: 'enabled', enabled: true, created_at: '2026-08-10T12:00:00Z' },
  { id: 'es4', type: 'stream.online', version: '1', status: 'enabled', enabled: true, created_at: '2026-08-10T12:00:00Z' },
  { id: 'es5', type: 'channel.bits.use', version: '1', status: 'enabled', enabled: true, created_at: '2026-08-10T12:00:00Z' },
  { id: 'es6', type: 'channel.channel_points_custom_reward_redemption.add', version: '1', status: 'authorization_revoked', enabled: true, created_at: '2026-08-10T12:00:00Z' },
];
const eventsubActivity = {
  types: [
    { type: 'channel.follow', lastReceivedAt: ago(120), received7d: 14, lastAlert: { at: ago(120), outcome: 'skipped', reason: 'alert_disabled' }, failedDeliveries: 0 },
    { type: 'channel.raid', lastReceivedAt: ago(2 * 1440), received7d: 2, lastAlert: { at: ago(2 * 1440), outcome: 'ok', reason: null }, failedDeliveries: 0 },
    { type: 'stream.online', lastReceivedAt: ago(300), received7d: 4, lastAlert: null, failedDeliveries: 0 },
    { type: 'channel.bits.use', lastReceivedAt: null, received7d: 0, lastAlert: null, failedDeliveries: 0 },
    { type: 'channel.channel_points_custom_reward_redemption.add', lastReceivedAt: ago(4 * 1440), received7d: 31, lastAlert: null, failedDeliveries: 3 },
  ],
  revoked: [
    { at: ago(3 * 1440), type: 'channel.channel_points_custom_reward_redemption.add', reason: 'authorization_revoked' },
    { at: ago(9 * 1440), type: 'channel.raid', reason: 'notification_failures_exceeded' },
  ],
};

const LOG_FUNCS = ['redemptionHandler', 'ttsQueue', 'eventsubHandler', null, 'sendChatMessage', 'aiReply'];
const LOG_MSGS = [
  'Twitch refused to update the redemption status: 403 Forbidden (the reward was not created by this client id)',
  'Voice request skipped: the channel has no credits left',
  'Notification for channel.follow arrived twice; the second copy was ignored',
  'Retrying chat message after a 429 from Twitch',
  'Chat message dropped: msg_duplicate. The same text was sent less than 30 seconds ago, so Twitch would not post it again for this channel.',
  'AI reply took longer than expected',
];
const logEntries = Array.from({ length: 140 }, (_, i) => {
  const level = i === 2 ? 'fatal' : i % 5 === 0 ? 'error' : i % 5 === 1 ? 'warn' : i % 5 === 2 ? 'warn' : i % 5 === 3 ? 'info' : 'debug';
  return {
    id: `log${i}`, at: ago(7 + i * 41), level, function: LOG_FUNCS[i % LOG_FUNCS.length],
    message: i === 9 ? null : LOG_MSGS[i % LOG_MSGS.length],
    data: i % 3 === 0 ? { rewardId: 'f2b1c0de-4a5b-4c3d-9e8f-0011aa22bb33', httpStatus: 403, retry: false, attempt: i % 4 } : { queueLength: i % 7, provider: 'fish' },
  };
});
const logCounts = logEntries.reduce((acc, entry) => ({ ...acc, [entry.level]: (acc[entry.level] ?? 0) + 1 }), { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 });

const feedSummary = (channel) => ({
  from: ago(1440), to: ago(0), partial: channel === '8100001' ? [] : [],
  kinds: channel === '8100001' ? [
    { kind: 'command', total: 412, problems: 31, failed: 2 },
    { kind: 'bot_message', total: 506, problems: 4, failed: 1 },
    { kind: 'twitch_event', total: 58, problems: 0, failed: 0 },
    { kind: 'alert', total: 40, problems: 9, failed: 0 },
    { kind: 'protection', total: 67, problems: 2, failed: 2 },
    { kind: 'voice', total: 128, problems: 5, failed: 3 },
    { kind: 'ai', total: 0, problems: 0, failed: 0 },
  ] : [],
});

const usageSummary = {
  planTier: 'pro',
  credits: { version: 1, used: 37500, limit: 200000, balance: 162500, meterId: 'm', updatedAt: ago(10), available: true },
  billingPeriod: { source: 'subscription', from: '2026-10-20', to: '2026-11-20', totalDayCount: 31, elapsedDayCount: 24 },
  ledger: { status: 'ready', coverageStart: '2026-10-20' },
  pacing: { status: 'over_pace', averageDailyCredits: 9000, projectedPeriodCredits: 270000, remainingPeriodDays: 17, expectedToExhaustWithinPeriod: true, estimatedDaysUntilExhaustion: 12 },
  analytics: {
    itemizationStartedAt: '2026-09-01T00:00:00Z', totalSpentCredits: 117000, averageDailySpentCredits: 9000, grantedCredits: 25000, netConsumedCredits: 92000, transactionCount: 412,
    daily: Array.from({ length: 13 }, (_, i) => ({ date: `2026-11-${String(1 + i).padStart(2, '0')}`, credits: 4000 + ((i * 3137) % 9000), transactionCount: 20 + i })),
    categories: [
      { category: 'tts', credits: 70000, transactionCount: 300, percentage: 60 },
      { category: 'ai_chat', credits: 35000, transactionCount: 100, percentage: 30 },
      { category: 'memory', credits: 12000, transactionCount: 12, percentage: 10 },
    ],
    adjustments: [],
  },
};
const transactions = Array.from({ length: 30 }, (_, i) => ({
  id: `tx${i}`, occurredAt: ago(30 + i * 60), entryKind: i === 4 ? 'adjustment' : 'usage', category: i === 4 ? 'credit_adjustment' : i % 2 ? 'ai_chat' : 'tts',
  operation: i === 4 ? 'admin_grant' : i % 2 ? 'chat_reply' : 'synthesize', provider: 'fixture', model: i % 2 ? 'fixture-model' : null, quantity: null, unit: null, credits: i === 4 ? -25000 : 120 + i,
}));

const petDiagnostics = {
  observedAt: ago(0), configured: false, enabled: false, appearance: null, playbackTarget: null,
  vts: { selectedSessionId: null, session: null, connected: false, reportedReady: false, ready: false, projection: { status: 'missing', lastValidatedAt: null, expiresAt: null } },
  audio: { selectedSessionId: null, session: null, connected: false, reportedReady: false, ready: false }, failures: [],
};

function newState() {
  return { followEnabled: true, subscribeConnected: false, credits: { used: 37500, limit: 200000, balance: 162500 }, recorded: true, fail: new Set(), testCalls: 0, logs: null };
}

const ok = (data) => ({ status: 200, body: { error: false, message: 'ok', status: 200, data } });
const fail = (status = 503, message = 'Fixture failure') => ({ status, body: { error: true, message, status } });

/** Answers one request. `state.fail` holds keys like 'logs', 'command-stats', 'eventsub-activity', 'summary', 'channel'. */
function makeApi(state) {
  return (method, path, url, body) => {
    const params = url.searchParams;
    let m;
    if (method === 'GET' && path === '/admin-site/users') {
      if (state.fail.has('channel')) return fail();
      const search = params.get('search') || '';
      const rows = Object.values(channels).filter((row) => !search || row.channelID === search || row.channel.includes(search))
        .map((row) => (row.channelID === '8100001' ? { ...row, reminder_sent_at: state.reminderSentAt ?? null } : row));
      return ok({ rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 }, summary: {} });
    }
    // The Activity tab (built separately) reads the feed when a shortcut opens it.
    if (method === 'GET' && path === '/admin-site/feed') return ok({ items: [], nextCursor: null, partial: [] });
    if (method === 'GET' && path === '/admin-site/feed/summary') {
      if (state.fail.has('summary')) return fail();
      return ok(feedSummary(params.get('channel')));
    }
    if ((m = path.match(/^\/admin-site\/users\/(\d+)\/(.+)$/))) {
      const [, id, rest] = m;
      if (method === 'GET' && rest === 'commands') {
        const rows = id === '8100001' ? commands : [];
        return ok({ rows, pagination: { page: 1, limit: Number(params.get('limit') || 25), total: rows.length, totalPages: 1 } });
      }
      if (method === 'GET' && rest === 'eventsubs') {
        const rows = id === '8100001' ? channelEventsubs(state) : [];
        return ok({ rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 } });
      }
      if (method === 'GET' && rest === 'ai-credits') return ok({ version: 1, ...state.credits, available: true });
      if (method === 'POST' && rest === 'ai-credits/grant') {
        const credits = body?.credits ?? 0;
        const before = { ...state.credits };
        state.credits = { used: before.used, limit: before.limit + credits, balance: before.balance + credits };
        return ok({ granted: credits, before, after: state.credits, chatAnnouncement: body?.announceInChat === false ? 'skipped' : 'sent' });
      }
      if (method === 'POST' && rest === 'send-reminder') {
        state.reminderSentAt = new Date().toISOString();
        return ok({ message: 'Reminder sent to mossy_lantern@example.test' });
      }
      if (method === 'GET' && rest === 'pet-diagnostics') return ok(petDiagnostics);
      if (method === 'GET' && rest === 'command-stats') return state.fail.has('command-stats') ? fail() : ok(commandStats(state.recorded && id === '8100001'));
      if (method === 'GET' && rest === 'eventsub-activity') {
        if (state.fail.has('eventsub-activity')) return fail();
        return ok(id === '8100001' ? eventsubActivity : { types: [], revoked: [] });
      }
      if (method === 'GET' && rest === 'logs') {
        if (state.fail.has('logs')) return fail();
        const level = params.get('level') || 'problems';
        const limit = Math.min(200, Number(params.get('limit') || 50));
        const source = state.logs ?? (id === '8100001' ? logEntries : []);
        const counts = state.logs ? state.logs.reduce((acc, e) => ({ ...acc, [e.level]: acc[e.level] + 1 }), { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }) : id === '8100001' ? logCounts : { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
        const matched = source.filter((e) => (level === 'problems' ? ['warn', 'error', 'fatal'].includes(e.level) : e.level === level));
        return ok({ entries: matched.slice(0, limit), truncated: matched.length > limit, counts });
      }
      if (method === 'GET' && rest === 'ai-usage/summary') return ok(usageSummary);
      if (method === 'GET' && rest === 'ai-usage/transactions') {
        const category = params.get('category');
        const cursor = Number(params.get('cursor') || 0);
        const list = transactions.filter((t) => !category || t.category === category);
        return ok({ items: list.slice(cursor, cursor + 25), nextCursor: cursor + 25 < list.length ? String(cursor + 25) : null });
      }
    }
    if (method === 'GET' && path === '/eventsubs/standard') return ok({ standardTypes });
    if (method === 'POST' && path === '/eventsubs/8100001/test') {
      state.testCalls += 1;
      state.lastTest = body;
      return ok({});
    }
    if (method === 'POST' && path === '/eventsubs/8100001') {
      state.subscribeConnected = true;
      return { status: 200, body: { error: false, message: 'created' } };
    }
    if (method === 'PATCH' && path === '/eventsubs/8100001/es1') {
      state.followEnabled = body.enabled;
      return { status: 200, body: { error: false, message: 'updated' } };
    }
    if (method === 'GET' && /^\/(rewards|triggers|timers|memories|triggers\/files)\/\d+$/.test(path)) {
      const key = path.startsWith('/triggers/files') ? 'files' : path.split('/')[1];
      const n = { rewards: 4, triggers: 7, timers: 3, memories: 12, files: 18 }[key] ?? 0;
      return ok({ [key]: Array.from({ length: n }, (_, i) => ({ id: `${key}${i}` })) });
    }
    if (method === 'GET' && path === '/users') return { status: 200, body: { data: {} } };
    return null;
  };
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-channel';
fs.mkdirSync(artifacts, { recursive: true });

const state = newState();
const api = makeApi(state);
const requests = [];
const unexpected = [];
const pageErrors = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000');
const count = (pred) => requests.filter(pred).length;
const channelLoads = (id = '8100001') => count((r) => r.method === 'GET' && r.path === '/admin-site/users' && r.query.get('search') === id);
const lastRequest = (pred) => requests.filter(pred).at(-1);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({
      version: 2, token: 'disposable-channel-fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' },
    }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
    if (!isApi(url)) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = request.postDataJSON(); } catch { /* no body */ }
    requests.push({ method: request.method(), path: url.pathname, query: url.searchParams, body });
    const result = api(request.method(), url.pathname, url, body);
    if (!result) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: true, message: 'Not mocked' }) });
    }
    return route.fulfill({ status: result.status, headers: cors, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) pageErrors.push(message.text()); });

  const until = async (check, label, tries = 100) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  const shot = (name) => page.screenshot({ path: `${artifacts}/${name}.png` });
  const h1 = page.locator('main h1');
  const tab = (name) => page.getByRole('navigation', { name: 'Channel sections' }).getByRole('link', { name: new RegExp(`^${name}`) });
  const current = () => page.getByRole('navigation', { name: 'Channel sections' }).locator('[aria-current="page"]');
  // Pages fade in through a view transition; clicks during it land on the transition overlay.
  const settle = () => page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
  const goto = async (path) => { await page.goto(`${base}${path}`); await h1.first().waitFor(); await settle(); };

  // ---------------------------------------------------------------- Frame
  await goto('/channels/8100001');
  assert.equal(await h1.count(), 1, 'one h1');
  assert.equal(await text(h1), 'mossy_lantern');
  await page.getByText('Live with 1,284 watching · joined May 2, 2026').waitFor();
  for (const chip of ['Pro', 'Bot on', 'Twitch access OK', 'Chat on']) await page.getByRole('list', { name: 'Channel status' }).getByText(chip, { exact: true }).waitFor();
  assert.equal(await page.locator('.ws-twitch').getAttribute('href'), 'https://twitch.tv/mossy_lantern');
  assert.equal(await page.locator('.ws-head .lf-back').getAttribute('href'), '/users');
  const tabNames = await page.getByRole('navigation', { name: 'Channel sections' }).getByRole('link').evaluateAll((els) => els.map((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.lf-tab__count').forEach((badge) => badge.remove());
    return copy.textContent.trim();
  }));
  assert.deepEqual(tabNames, ['Overview', 'Activity', 'Commands', 'Twitch events', 'Protection', 'AI & credits', 'Bot log']);
  assert.match(await text(current()), /^Overview/);
  // Badges: failed rows in the last 24 hours (2 + 1 + 2 + 3), protection failures, Twitch events turned off.
  assert.match(await tab('Activity').innerText(), /8/);
  assert.match(await tab('Activity').textContent(), /8 failures in the last 24 hours/);
  assert.match(await tab('Protection').textContent(), /2 messages not reviewed/);
  assert.match(await tab('Twitch events').textContent(), /1 turned off/);
  assert.doesNotMatch(await tab('Commands').innerText(), /\d/);
  await until(async () => count((r) => r.path === '/admin-site/feed/summary') === 1, 'feed summary');
  const summaryQuery = lastRequest((r) => r.path === '/admin-site/feed/summary').query;
  assert.equal(summaryQuery.get('channel'), '8100001');
  assert.ok(Math.abs(Date.now() - 24 * 3_600_000 - Date.parse(summaryQuery.get('from'))) < 120_000, 'summary covers the last 24 hours');
  assert.equal(channelLoads(), 1, 'the frame loads the channel once');
  await page.evaluate(() => { document.querySelector('main h1').dataset.mark = 'kept'; });
  for (const [name, path, ready] of [
    ['Commands', '/commands', '.cmd-answer'],
    ['Twitch events', '/eventsubs', '.es-summary'],
    ['AI & credits', '/usage', '.us-forecast'],
    ['Bot log', '/logs', '[data-log-row]'],
    ['Overview', '', '.ch-health'],
  ]) {
    await tab(name).click();
    await page.locator(ready).first().waitFor();
    assert.equal(new URL(page.url()).pathname, `/channels/8100001${path}`);
    assert.match(await text(current()), new RegExp(`^${name}`));
    assert.equal(await page.evaluate(() => document.querySelector('main h1')?.dataset.mark), 'kept', `${name}: the header is not re-rendered`);
    assert.equal(await h1.count(), 1, `${name}: one h1`);
  }
  assert.equal(channelLoads(), 1, 'switching tabs never re-requests the channel');
  assert.equal(count((r) => r.path === '/admin-site/feed/summary'), 1, 'switching tabs never re-requests the feed summary');

  // Sticky tab strip under the top bar.
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(200);
  const navH = await page.evaluate(() => document.querySelector('.nav')?.getBoundingClientRect().height ?? 60);
  const barTop = await page.evaluate(() => document.querySelector('.ws-bar').getBoundingClientRect().top);
  assert.ok(Math.abs(barTop - navH) <= 2, `tab strip sticks under the top bar (${barTop} vs ${navH})`);
  await page.evaluate(() => window.scrollTo(0, 0));

  // Deep links straight to each tab.
  for (const [name, path, ready] of [
    ['Commands', '/commands', '.cmd-answer'],
    ['Twitch events', '/eventsubs', '.es-summary'],
    ['AI & credits', '/usage', '.us-forecast'],
    ['Bot log', '/logs', '[data-log-row]'],
  ]) {
    await goto(`/channels/8100001${path}`);
    await page.locator(ready).first().waitFor();
    assert.match(await text(current()), new RegExp(`^${name}`));
  }
  // On a narrow phone the active tab is scrolled into view.
  await page.setViewportSize({ width: 320, height: 700 });
  await goto('/channels/8100001/logs');
  await until(async () => page.evaluate(() => {
    const strip = document.querySelector('.ws-tabs').getBoundingClientRect();
    const active = document.querySelector('.ws-tabs .is-active').getBoundingClientRect();
    return active.left >= strip.left - 1 && active.right <= strip.right + 1;
  }), 'active tab in view at 320');
  await page.setViewportSize({ width: 390, height: 844 });

  // Unknown channel and a failed load.
  await goto('/channels/9999999');
  assert.equal(await text(h1), 'No channel with this ID');
  assert.equal(await page.getByRole('link', { name: 'Back to users' }).getAttribute('href'), '/users');
  assert.equal(await page.locator('.ws-bar').count(), 0, 'no tabs for an unknown channel');
  await shot('unknown-dark-390');
  state.fail.add('channel');
  await goto('/channels/8100001');
  assert.equal(await text(h1), "Couldn't load this channel");
  state.fail.delete('channel');
  await page.getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await text(h1)) === 'mossy_lantern', 'retry loads the channel');
  await page.locator('.ws-bar').waitFor();

  // ---------------------------------------------------------------- Overview
  await goto('/channels/8100001');
  await page.getByText('Everything looks good').waitFor();
  await page.getByRole('heading', { name: 'Last 24 hours' }).waitFor();
  const stats = page.locator('.lf-stat[data-kind]');
  await until(async () => (await stats.count()) === 6, 'six kinds with rows');
  assert.deepEqual(await stats.evaluateAll((els) => els.map((el) => el.dataset.kind)), ['command', 'bot_message', 'twitch_event', 'alert', 'protection', 'voice']);
  assert.match(await text(stats.nth(0)), /Commands 412 31 didn't answer \(2 failed\)/);
  assert.match(await text(stats.nth(2)), /Twitch events 58 No problems/);
  assert.match(await text(stats.nth(3)), /Chat alerts 40 9 not sent/);
  assert.match(await text(stats.nth(4)), /Chat protection 67 2 failed/);
  assert.match(await text(stats.nth(5)), /Voice 128 5 not spoken \(3 failed\)/);
  await shot('overview-dark-390');
  await stats.nth(3).click();
  await until(async () => new URL(page.url()).pathname === '/channels/8100001/activity', 'stat opens Activity');
  const statUrl = new URL(page.url());
  assert.equal(statUrl.searchParams.get('kinds'), 'alert');
  assert.equal(statUrl.searchParams.get('range'), '24h');
  assert.match(await text(current()), /^Activity/);
  await page.goBack();
  await page.getByText('Everything looks good').waitFor();
  assert.equal(await page.getByRole('progressbar', { name: 'AI credits used' }).getAttribute('aria-valuenow'), '19');
  assert.match(await page.locator('a.stat-clickable[href$="/commands"]').innerText(), /9/);
  assert.equal(await page.locator('a.stat-clickable[href$="/eventsubs"]').getAttribute('href'), '/channels/8100001/eventsubs');

  // Credit grant: cancel never grants; a confirmed grant posts exactly what the dialog said.
  await page.locator('.grant-open').click();
  await page.locator('dialog[open]').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(count((r) => r.path.endsWith('/ai-credits/grant')), 0, 'cancel never grants');
  await page.locator('.grant-open').click();
  await page.getByRole('radio', { name: '+25K' }).click();
  await page.getByRole('dialog').getByPlaceholder('e.g. bug reimbursement').fill('fixture reimbursement');
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Announce in chat' }).uncheck();
  await page.getByText('Balance goes from 162,500 to 187,500').waitFor();
  await page.getByText('No chat message will be sent.').waitFor();
  await shot('grant-dark-390');
  await page.getByRole('dialog').getByRole('button', { name: 'Add 25K credits' }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(count((r) => r.path.endsWith('/ai-credits/grant')), 1);
  assert.deepEqual(lastRequest((r) => r.path.endsWith('/ai-credits/grant')).body, { credits: 25000, reason: 'fixture reimbursement', announceInChat: false });
  await page.locator('.credit-usage__label', { hasText: '187.5K left' }).waitFor();

  // Activation reminder: Escape cancels; confirming sends one email and refreshes "Last sent" without touching the header.
  await page.evaluate(() => { document.querySelector('main h1').dataset.mark = 'kept'; });
  const loadsBefore = channelLoads();
  await page.getByRole('button', { name: 'Send reminder email' }).click();
  await page.locator('dialog[open]').waitFor();
  await page.getByRole('dialog').getByText('mossy_lantern@example.test', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(count((r) => r.path.endsWith('/send-reminder')), 0, 'cancel never sends a reminder');
  await page.getByRole('button', { name: 'Send reminder email' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send reminder', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(count((r) => r.path === '/admin-site/users/8100001/send-reminder' && r.method === 'POST'), 1);
  await until(async () => channelLoads() === loadsBefore + 1, 'quiet channel refresh after the reminder');
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  await page.locator('.ch-help').getByText(today).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('main h1')?.dataset.mark), 'kept', 'the header stays during the refresh');

  // A channel with problems, and nothing in the last 24 hours.
  await goto('/channels/8100002');
  await page.getByText('3 things need attention').waitFor();
  await page.getByText('Nothing recorded for this channel in the last 24 hours.').waitFor();
  assert.equal(await page.locator('.lf-stat[data-kind]').count(), 0);
  assert.equal(await page.locator('.lf-tab__count').count(), 0, 'no badges without problems');
  await shot('problems-dark-390');
  // The 24-hour block fails on its own and retries.
  state.fail.add('summary');
  await goto('/channels/8100001');
  await page.getByText("Couldn't load the last 24 hours").waitFor();
  await page.getByText('Everything looks good').waitFor();
  state.fail.delete('summary');
  await page.locator('.day').getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await stats.count()) === 6, 'summary retry');
  await until(async () => (await tab('Activity').innerText()).includes('8'), 'badge after retry');

  // ---------------------------------------------------------------- Commands
  await goto('/channels/8100001/commands');
  const answer = page.locator('.cmd-answer');
  await until(async () => (await text(answer)).includes('767'), 'commands answer');
  assert.match(await text(answer), /^9 commands\. In the last 7 days they ran 767 times\. 50 runs didn't answer, mostly cooldowns\. 6 runs failed with an error\./);
  assert.equal(await answer.getByRole('link', { name: 'See every run' }).getAttribute('href'), '/channels/8100001/activity?kinds=command&range=7d');
  const rows = page.locator('li[data-command]');
  const row = (trigger) => page.locator(`li[data-command="${trigger}"]`);
  assert.equal(await rows.count(), 10, 'nine commands plus one that ran but is not listed');
  assert.match(await text(row('!so').locator('.cmd-stat')), /^Ran 140× · 19 didn't answer \(on cooldown 11×\) · last 38 min ago$/);
  assert.match(await text(row('!ask').locator('.cmd-stat')), /6 didn't answer \(no credits left 4×\)/);
  assert.equal(await text(row('!hug').locator('.cmd-stat')), "Didn't run in the last 7 days");
  assert.equal(await text(row('!discord').locator('.cmd-stat')), 'Ran 33× · last 10 h ago');
  await page.getByRole('heading', { name: 'Ran in the last 7 days but not in their list' }).waitFor();
  assert.equal(await row('!tts').count(), 1);
  assert.match(await text(row('!socials')), /Off/);
  await shot('commands-dark-390');
  // Sorts write the URL.
  const order = () => rows.evaluateAll((els) => els.map((el) => el.dataset.command));
  assert.deepEqual((await order()).slice(0, 3), ['!ask', '!discord', '!hug']);
  await page.locator('.cmd-sort').getByText('Most used').click();
  await until(async () => new URL(page.url()).searchParams.get('sort') === 'used', 'sort=used in URL');
  await until(async () => (await order())[0] === '!lurk', 'most used first');
  assert.deepEqual((await order()).slice(0, 4), ['!lurk', '!so', '!ask', '!discord']);
  await page.locator('.cmd-sort').getByText('Most problems').click();
  await until(async () => new URL(page.url()).searchParams.get('sort') === 'problems', 'sort=problems in URL');
  assert.deepEqual((await order()).slice(0, 4), ['!lurk', '!so', '!ask', '!socials']);
  await page.locator('.cmd-sort').getByText('Name').click();
  await until(async () => !new URL(page.url()).searchParams.has('sort'), 'default sort leaves the URL');
  // Search writes the URL.
  await page.getByRole('searchbox', { name: 'Filter commands' }).fill('disc');
  await until(async () => new URL(page.url()).searchParams.get('q') === 'disc' && (await rows.count()) === 1, 'filter');
  await page.getByRole('searchbox', { name: 'Filter commands' }).fill('');
  await until(async () => (await rows.count()) === 10, 'filter cleared');
  // A row opens to its rules, the reason breakdown and its runs.
  await row('!so').locator('summary').click();
  const body = row('!so').locator('[data-command-body]');
  await body.waitFor();
  const bodyText = await text(body);
  for (const part of ['Go follow $(touser)', 'Status On', 'Who can use it Moderators', 'Cooldown 30 seconds between uses', 'Runs shoutout',
    "Last run 38 min ago: didn't answer, this viewer isn't allowed to use it", 'In the last 7 days 121 answered of 140', 'on cooldown 11×', 'viewer not allowed 8×']) {
    assert.ok(bodyText.includes(part), `!so details include "${part}": ${bodyText}`);
  }
  assert.equal(await body.getByRole('link', { name: 'See its runs' }).getAttribute('href'), '/channels/8100001/activity?kinds=command&range=7d');
  await shot('commands-open-dark-390');
  await row('!so').locator('summary').click();
  // Deep link restores sort and search.
  await goto('/channels/8100001/commands?sort=problems&q=lu');
  await until(async () => (await rows.count()) === 1, 'deep-linked filter');
  assert.equal(await page.getByRole('radio', { name: 'Most problems' }).isChecked(), true);
  assert.equal(await page.getByRole('searchbox', { name: 'Filter commands' }).inputValue(), 'lu');
  // Nothing recorded yet.
  state.recorded = false;
  await goto('/channels/8100001/commands');
  await page.getByText('Command runs are recorded from the day this console went live; nothing yet for this channel.').waitFor();
  assert.equal(await page.locator('.cmd-stat').count(), 0, 'no per-row lines before recording starts');
  assert.equal(await rows.count(), 9);
  state.recorded = true;
  // Stats fail on their own; the list stays.
  state.fail.add('command-stats');
  await goto('/channels/8100001/commands');
  await page.getByText("Couldn't load how they ran in the last 7 days.").waitFor();
  assert.equal(await rows.count(), 9);
  state.fail.delete('command-stats');
  await answer.getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await text(answer)).includes('767'), 'stats retry');

  // ---------------------------------------------------------------- Twitch events
  await goto('/channels/8100001/eventsubs');
  await page.getByText('2 of 6 events need attention').waitFor();
  const esRow = (type) => page.locator('.es-row', { hasText: type });
  await until(async () => (await esRow('channel.follow v2').innerText()).includes('Last heard'), 'activity lines');
  const follow = await text(esRow('channel.follow v2'));
  assert.ok(follow.includes('Last heard 2 h ago · 14 in 7 days'), follow);
  assert.ok(follow.includes('Alert not sent 2 h ago: this alert is turned off'), follow);
  assert.ok((await text(esRow('channel.raid v1'))).includes('Alert sent'), 'raid alert sent');
  assert.ok((await text(esRow('channel.bits.use v1'))).includes('Nothing received in 30 days'));
  assert.ok((await text(esRow('stream.online v1'))).includes('Last heard 5 h ago · 4 in 7 days'));
  assert.ok((await text(esRow('custom_reward_redemption'))).includes('3 the bot gave up on'));
  assert.ok(!(await text(esRow('channel.subscribe v1'))).includes('Last heard'), 'missing events have no activity line');
  const heardHref = new URL(await esRow('channel.follow v2').locator('a.es-link').getAttribute('href'), base);
  assert.equal(heardHref.pathname, '/channels/8100001/activity');
  assert.equal(heardHref.searchParams.get('kinds'), 'twitch_event,alert');
  assert.equal(heardHref.searchParams.get('range'), '7d');
  const revoked = page.locator('.es-revoked');
  await revoked.getByRole('heading', { name: 'Twitch stopped sending 1 event' }).waitFor();
  const revokedText = await text(revoked);
  assert.ok(revokedText.includes('Channel point redemptions'));
  assert.ok(revokedText.includes('the streamer removed our access'));
  assert.ok(revokedText.includes('The streamer needs to sign in again on domdimabot.com.'));
  assert.match(revokedText, /Raids Connected again Stopped .*Twitch could not reach us too many times/);
  await shot('eventsubs-dark-390');
  // The test event keeps its confirmation: cancel sends nothing; sending posts the edited payload.
  await page.getByRole('button', { name: 'Test Follows' }).click();
  await page.locator('.payload-editor').waitFor();
  await page.getByText('can really appear on their stream', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.payload-editor').waitFor({ state: 'hidden' });
  assert.equal(state.testCalls, 0, 'cancel never sends a test event');
  await page.getByRole('button', { name: 'Test Follows' }).click();
  await page.getByRole('button', { name: 'Send test event' }).click();
  await page.locator('.payload-editor').waitFor({ state: 'hidden' });
  assert.equal(state.testCalls, 1);
  assert.equal(state.lastTest.subscription.type, 'channel.follow');
  assert.equal(state.lastTest.event.broadcaster_user_id, '8100001');
  // Connect and switch keep working.
  await page.getByRole('button', { name: 'Connect New subs' }).click();
  await page.getByText('1 of 6 events need attention').waitFor();
  assert.equal(lastRequest((r) => r.method === 'POST' && r.path === '/eventsubs/8100001').body.type, 'channel.subscribe');
  await page.getByRole('switch', { name: 'Follows on' }).click();
  await until(async () => count((r) => r.method === 'PATCH' && r.path === '/eventsubs/8100001/es1') === 1, 'follow patch');
  assert.deepEqual(lastRequest((r) => r.method === 'PATCH').body, { enabled: false });
  await page.getByText('2 of 6 events need attention').waitFor();
  // The activity lines fail on their own; the list stays usable.
  state.fail.add('eventsub-activity');
  await goto('/channels/8100001/eventsubs');
  await page.getByText("Couldn't load when each event was last heard", { exact: false }).waitFor();
  assert.ok((await page.locator('.es-row').count()) === 6);
  state.fail.delete('eventsub-activity');
  await page.locator('.lf-notice').getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await page.locator('.es-heard').count()) > 0, 'activity retry');

  // ---------------------------------------------------------------- AI & credits
  await goto('/channels/8100001/usage');
  await page.getByText('On pace to run out in ~12 days').waitFor();
  await page.getByRole('heading', { name: 'AI credit usage' }).waitFor({ state: 'attached' });
  const explorer = page.getByRole('link', { name: /See who used it, by viewer and by model/ });
  assert.equal(await explorer.getAttribute('href'), '/ai/usage?channel=8100001');
  await until(async () => (await page.locator('.usage-transactions li').count()) === 25, 'ledger');
  assert.equal(await page.locator('.lf-back').count(), 1, 'only the frame has a back link');
  await shot('usage-dark-390');

  // ---------------------------------------------------------------- Bot log
  await goto('/channels/8100001/logs');
  const logRows = page.locator('[data-log-row]');
  await until(async () => (await logRows.count()) === 50, 'first 50 lines');
  let logReq = lastRequest((r) => r.path.endsWith('/logs'));
  assert.equal(logReq.query.get('level'), null, 'problems is the default level');
  assert.equal(logReq.query.get('limit'), null, 'default limit');
  await page.getByText('The bot logged 29 errors and 55 warnings about this channel in the last 7 days.').waitFor();
  await page.getByText('1 of the errors was fatal.').waitFor();
  const levels = page.getByRole('group', { name: 'Show log levels' });
  assert.deepEqual((await levels.getByRole('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
    ['Problems 84', 'Fatal 1', 'Errors 28', 'Warnings 55', 'Info 28', 'Debug 28']);
  assert.equal(await levels.getByRole('button', { name: /^Problems/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('link', { name: /Errors, slow calls and traces for this channel/ }).getAttribute('href'), '/observability?channel=8100001&tab=logs');
  const first = logRows.first();
  assert.equal(await text(first.locator('.log-row__where')), 'Redemption handler');
  assert.match(await text(first.locator('.log-row__time')), /min ago/);
  assert.equal(await logRows.nth(1).locator('.log-row__where').innerText(), 'Voice queue', 'TTS reads as voice');
  await page.getByText('Showing the newest 50; narrow by level to see more.').waitFor();
  await shot('logs-dark-390');
  await page.getByRole('button', { name: 'Show more' }).click();
  await until(async () => (await logRows.count()) === 84, 'show more');
  assert.equal(lastRequest((r) => r.path.endsWith('/logs')).query.get('limit'), '100');
  assert.equal(new URL(page.url()).searchParams.get('limit'), '100');
  assert.equal(await page.getByRole('button', { name: 'Show more' }).count(), 0, 'nothing more to show');
  // Level chips change the request and the URL.
  await levels.getByRole('button', { name: /^Errors/ }).click();
  await until(async () => (await logRows.count()) === 28, 'errors only');
  logReq = lastRequest((r) => r.path.endsWith('/logs'));
  assert.equal(logReq.query.get('level'), 'error');
  assert.equal(logReq.query.get('limit'), null, 'a new level starts from the default limit');
  assert.equal(new URL(page.url()).searchParams.get('level'), 'error');
  assert.equal(await levels.getByRole('button', { name: /^Errors/ }).getAttribute('aria-pressed'), 'true');
  // A row opens to every field; Copy puts the whole entry on the clipboard.
  await first.locator('summary').click();
  const logBody = first.locator('[data-log-body]');
  await logBody.waitFor();
  const logText = await text(logBody);
  for (const part of ['Level Error', 'Where redemptionHandler', 'rewardId f2b1c0de-4a5b-4c3d-9e8f-0011aa22bb33', 'httpStatus 403', 'retry false']) {
    assert.ok(logText.includes(part), `log details include "${part}": ${logText}`);
  }
  await logBody.getByRole('button', { name: 'Copy as JSON' }).click();
  await logBody.getByRole('button', { name: 'Copied' }).waitFor();
  const copied = JSON.parse(await page.evaluate(() => window.__copied));
  assert.equal(copied.id, 'log0');
  assert.equal(copied.data.httpStatus, 403);
  await shot('logs-open-dark-390');
  // Deep link to a level.
  await goto('/channels/8100001/logs?level=info');
  await until(async () => (await logRows.count()) === 28, 'deep-linked level');
  assert.equal(lastRequest((r) => r.path.endsWith('/logs')).query.get('level'), 'info');
  // Empty.
  state.logs = [];
  await goto('/channels/8100001/logs');
  await page.getByText('No errors or warnings about this channel in the last 7 days.').waitFor();
  await page.getByText('No errors or warnings in the last 7 days', { exact: true }).waitFor();
  await shot('logs-empty-dark-390');
  state.logs = null;
  // Error + Retry.
  state.fail.add('logs');
  await goto('/channels/8100001/logs');
  await page.getByText("Couldn't load the bot log").waitFor();
  state.fail.delete('logs');
  await page.getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await logRows.count()) === 50, 'logs retry');
  // Refresh asks again (no auto-refresh).
  const logCalls = count((r) => r.path.endsWith('/logs'));
  await page.waitForTimeout(1500);
  assert.equal(count((r) => r.path.endsWith('/logs')), logCalls, 'no auto-refresh');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await until(async () => count((r) => r.path.endsWith('/logs')) === logCalls + 1, 'refresh');

  // ---------------------------------------------------------------- Layout + accessibility matrix
  const matrix = [
    ['/channels/8100001', '.lf-stat[data-kind]', '.grant-open, .ws-tabs .lf-tab, .ws-head .lf-back'],
    ['/channels/8100002', '.ch-health', '.ws-tabs .lf-tab'],
    ['/channels/8100001/commands', 'li[data-command] .cmd-stat', '.cmd-sort span, .cmd-answer .lf-btn'],
    ['/channels/8100001/eventsubs', '.es-heard', '.es-row .lf-btn'],
    ['/channels/8100001/usage', '.usage-transactions li', '.us-explore, .us-bar .lf-btn'],
    ['/channels/8100001/logs', '[data-log-row]', '.log-levels .lf-chip, .log-link, .lf-status .lf-btn'],
    ['/channels/9999999', '.lf-status', '.lf-status .lf-btn'],
  ];
  for (const mode of ['dark', 'light']) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      for (const [path, ready, targets] of matrix) {
        await goto(path);
        await page.locator(ready).first().waitFor();
        await page.waitForTimeout(150);
        const label = `${path} ${mode} ${width}`;
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label}: theme`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${label}: horizontal overflow`);
        assert.equal(await h1.count(), 1, `${label}: one h1`);
        if (width < 960) {
          for (const target of await page.locator(targets).all()) {
            if (!(await target.isVisible())) continue;
            const box = await target.boundingBox();
            assert.ok(box.height >= 43.5, `${label}: 44px touch target for ${await target.evaluate((el) => el.className)} (${box.height})`);
          }
        }
        const axe = await new AxeBuilder({ page }).include('app-channel-shell').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        assert.deepEqual(axe.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${label}: axe`);
        if (width !== 320) await shot(`${path.split('/').slice(2).join('-')}-${mode}-${width}`);
      }
    }
  }

  assert.deepEqual(unexpected, [], 'no unexpected API calls');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`PASS admin channel workspace: frame (one header, seven tabs, badges, sticky strip, tab switch without reloading the channel, deep links, unknown/failed channel), Overview last 24 hours + links, confirmed credit grant and reminder (bodies asserted), Commands answer/stats/reasons/sorts/search/URL/not-recorded/error, Twitch events last heard/alerts/gave-up/revoked + test/connect/switch, AI & credits explorer link, Bot log levels/open/copy/show more/empty/error/refresh, 320/390/1280 dark+light overflow/axe/touch targets. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
