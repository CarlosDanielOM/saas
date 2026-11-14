// Admin console "Activity" page (/activity) and a channel's Activity tab (/channels/:id/activity).
// Every API call is mocked on both api.domdimabot.com and localhost:3000: nothing reaches production.
// Covers the answer line, every filter changing both the request and the URL (range, kinds multi-select,
// problems, streamer through the picker, viewer login, failed only), deep links, opening a row, the
// "Everything from <viewer>" link, load more without duplicates, live refresh (inserted only when allowed,
// a "new" pill otherwise), the partial notice, empty and error + Retry, the Twitch event sheet (?event=),
// the fixed-channel tab, rows that say what went wrong (failed built-ins, usage replies, refused voice requests,
// voice playback), and layout + axe + touch targets at 320/390/1280 in dark then light.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-activity';
fs.mkdirSync(artifacts, { recursive: true });

// ---------- Fake data (fictional names only) ----------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const CHANNELS = [{ channelID: '700000001', channel: 'pixel_harbor' }, { channelID: '700000002', channel: 'luna_plays' }];
const VIEWERS = [{ id: '810000001', login: 'mossy_fern', name: 'Mossy_Fern' }, { id: '810000003', login: 'tiny_anvil', name: 'tiny_anvil' }];
let seq = 0;
const row = (minutes, kind, extra = {}) => {
  const channel = extra.channelIndex === null ? null : CHANNELS[extra.channelIndex ?? 0];
  return {
    id: `fx:${kind}:${++seq}`, at: ago(minutes), kind, name: '!so', outcome: 'ok', reason: null, channelID: channel?.channelID ?? null, channel: channel?.channel ?? null,
    actor: VIEWERS[0], text: null, credits: null, providerUSD: null, durationMs: null, data: {}, ref: null, ...extra,
  };
};
const FIRST = [
  row(1, 'command', { name: '!so', text: '!so quietcomet', data: { func: 'custom', trigger: 'chat' }, ref: { type: 'activity', id: 'a1' } }),
  row(2, 'bot_message', { name: 'command', actor: null, text: 'Go check out QuietComet!', data: { origin: 'command' } }),
  row(3, 'twitch_event', { name: 'channel.follow', channelIndex: 1, actor: VIEWERS[1], ref: { type: 'event', id: 'twitch:evt-follow-1:channel.follow.received' } }),
  row(3, 'alert', { name: 'channel.follow', channelIndex: 1, actor: VIEWERS[1], outcome: 'skipped', reason: 'alert_disabled', ref: { type: 'event', id: 'twitch:evt-follow-1:channel.follow.received' } }),
  row(9, 'command', { name: '!hug', outcome: 'skipped', reason: 'cooldown', text: '!hug tiny_anvil', data: { func: 'custom', trigger: 'chat' } }),
  row(22, 'voice', { name: 'fish', channelIndex: 1, outcome: 'failed', reason: 'synthesis_failed', data: { provider: 'fish', chars: 212 } }),
];
// Refused: by Twitch (a problem) and by the command's own rule (a setting at work, not a problem). Served in section 4 only.
const REFUSALS = [
  row(30, 'bot_message', { name: 'command', actor: null, outcome: 'blocked', reason: 'held_for_moderation', text: 'Thanks for the raid!', data: { origin: 'command' } }),
  row(31, 'command', { name: '!mod', outcome: 'blocked', reason: 'permission_denied', text: '!mod please', data: { func: 'custom', trigger: 'chat' } }),
];
// Rows that explain themselves: a failed built-in in its own words, a usage reply, a refused voice request and
// how voice messages ended on stream (section 16).
const DIAGNOSTICS = [
  row(1, 'command', { name: '!game', outcome: 'failed', reason: 'error', text: '!game ikemeb big bang', data: { func: 'game', trigger: 'chat', error: 'The game does not exist' } }),
  row(2, 'command', { name: '!dc', outcome: 'skipped', reason: 'usage', text: '!dc', data: { func: 'deleteCommand', trigger: 'chat', error: 'Usage: !dc <command name>' } }),
  row(3, 'command', { name: '!s', outcome: 'skipped', reason: 'disabled', text: '!s hola', data: { func: 'speach', trigger: 'chat' } }),
  row(4, 'voice', { name: 'request', outcome: 'failed', reason: 'no_speech_page', text: 'Mossy_Fern dice: hola chat',
    data: { source: 'ast', provider: 'fish', error: 'Speech overlay is not connected. Open the speech URL first and try again.' } }),
  row(5, 'voice', { name: 'playback', outcome: 'ok', reason: null, durationMs: 5400, ref: { type: 'activity', id: 'p1' },
    data: { provider: 'fish', voice: 'rias', source: 'ast', chars: 42, heard: true, pages: 2, movedBecause: 'play-error' } }),
  row(6, 'voice', { name: 'playback', outcome: 'failed', reason: 'play_error', ref: { type: 'activity', id: 'p2' },
    data: { provider: 'piper', chars: 18, heard: false, pages: 1, endReason: 'play-error' } }),
  row(7, 'voice', { name: 'playback', outcome: 'skipped', reason: 'tts_skipped', data: { provider: 'kokoro', heard: true, pages: 1, endReason: 'skip' } }),
];
const PAGE2 = [FIRST[5], ...Array.from({ length: 12 }, (_, i) => row(60 * 3 + i * 20, i % 2 ? 'command' : 'twitch_event', { name: i % 2 ? '!lurk' : 'channel.cheer', data: i % 2 ? {} : { amount: 100 } }))];
const SUMMARY = {
  from: ago(60 * 24), to: ago(0), partial: [],
  kinds: [
    { kind: 'command', total: 1482, problems: 96, failed: 3 }, { kind: 'bot_message', total: 2210, problems: 12, failed: 4 },
    { kind: 'twitch_event', total: 1172, problems: 1, failed: 1 }, { kind: 'alert', total: 388, problems: 41, failed: 2 },
    { kind: 'protection', total: 0, problems: 0, failed: 0 }, { kind: 'voice', total: 1078, problems: 9, failed: 6 },
  ],
};
const EVENT = {
  eventKey: 'twitch:evt-follow-1:channel.follow.received', type: 'channel.follow.received', twitchType: 'channel.follow', source: 'twitch',
  channelID: '700000002', channel: 'luna_plays', occurredAt: ago(3), journaledAt: ago(3), test: true, actor: VIEWERS[1],
  payload: { subscription: { type: 'channel.follow', version: '2' }, event: { user_login: 'tiny_anvil', broadcaster_user_login: 'luna_plays' } },
  deliveries: [
    { consumer: 'chat-announcements-v1', status: 'skipped', attempts: 1, reason: 'alert_disabled', completedAt: ago(3), durationMs: 12 },
    { consumer: 'follow-defense-v1', status: 'succeeded', attempts: 1, reason: null, completedAt: ago(3), durationMs: 34 },
    { consumer: 'widget-actions-v1', status: 'retry', attempts: 3, reason: 'handler_error', completedAt: null, durationMs: null },
    { consumer: 'channel-goals-v1', status: 'dead', attempts: 8, reason: 'handler_error', completedAt: ago(2), durationMs: 2400 },
    { consumer: 'polar-subscription-sync-v1', status: 'succeeded', attempts: 1, reason: null, completedAt: ago(3), durationMs: 80 },
    { consumer: 'mystery-consumer-v9', status: 'succeeded', attempts: 1, reason: null, completedAt: ago(3), durationMs: 5 },
  ],
  steps: [{ step: 'timers', status: 'completed', reason: null, at: ago(3) }, { step: 'editors_sync', status: 'failed', reason: 'no_token', at: ago(3) }],
  traceId: 'trace-abc123',
};

// ---------- Mock API ----------
const state = { failList: 0, partial: [], empty: false, liveExtra: [], emptySummary: false, diagnostics: false, refusals: false };
const feedCalls = [];
const summaryCalls = [];
const eventCalls = [];
const otherCalls = [];
const unexpected = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3000');
function feed(url) {
  const q = Object.fromEntries(url.searchParams);
  feedCalls.push(q);
  if (state.failList) { state.failList--; return { status: 500, body: { error: true, message: 'boom', status: 500 } }; }
  if (state.empty) return { body: { items: [], nextCursor: null, partial: [] } };
  if (state.diagnostics) return { body: { items: DIAGNOSTICS, nextCursor: null, partial: [] } };
  const kinds = (q.kinds || '').split(',').filter(Boolean);
  const keep = (item) => (!kinds.length || kinds.includes(item.kind)) && (!q.channel || item.channelID === q.channel)
    && (!q.actor || item.actor?.id === q.actor) && (!q.actorLogin || item.actor?.login === q.actorLogin)
    // The API's rule: a problem is a failure or a refusal that is not a setting; skips never are.
    && (!q.outcome || (q.outcome === 'failed' ? item.outcome === 'failed'
      : item.outcome === 'failed' || (item.outcome === 'blocked' && item.reason !== 'permission_denied')));
  if (q.cursor === 'p2') return { body: { items: PAGE2.filter(keep), nextCursor: null, partial: [] } };
  return { body: { items: [...state.liveExtra, ...FIRST, ...(state.refusals ? REFUSALS : [])].filter(keep), nextCursor: 'p2', partial: state.partial } };
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'disposable-activity-fixture', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
    if (!isApi(url)) { unexpected.push(`${request.method()} ${url.href}`); return route.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(data) });
    const ok = (data) => json({ error: false, message: 'ok', status: 200, data });
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname.startsWith('/admin-site/')) assert.equal(request.headers().authorization, 'Bearer disposable-activity-fixture', 'admin requests carry the session');
    if (url.pathname === '/admin-site/feed') { const result = feed(url); return result.status ? json(result.body, result.status) : ok(result.body); }
    if (url.pathname === '/admin-site/feed/summary') {
      summaryCalls.push(Object.fromEntries(url.searchParams));
      if (state.emptySummary) return ok({ ...SUMMARY, kinds: SUMMARY.kinds.map((item) => ({ ...item, total: 0, problems: 0, failed: 0 })) });
      return ok({ ...SUMMARY, partial: state.partial });
    }
    if (url.pathname.startsWith('/admin-site/events/')) {
      eventCalls.push(decodeURIComponent(url.pathname.slice('/admin-site/events/'.length)));
      return ok(EVENT);
    }
    if (url.pathname === '/admin-site/users') {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const rows = CHANNELS.filter((item) => item.channel.includes(search) || item.channelID === search).map((item) => ({ ...item, isLive: false, plan_tier: 'free' }));
      return ok({ rows, pagination: { page: 1, limit: 6, total: rows.length, totalPages: 1 }, summary: {} });
    }
    // The shell's own read-only calls (avatars and the like) are answered empty and listed.
    otherCalls.push(url.pathname);
    return ok({});
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) errors.push(message.text()); });
  const until = async (fn, label, tries = 150) => { for (let i = 0; i < tries; i++) { if (await fn().catch(() => false)) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${label}`); };
  const rows = page.locator('[data-feed-row]');
  const answer = page.locator('[data-feed-answer]');
  const lastFeed = () => feedCalls.at(-1);
  const lastSummary = () => summaryCalls.at(-1);
  const hoursBack = (iso) => (NOW - Date.parse(iso)) / 3_600_000;
  const param = (name) => new URL(page.url()).searchParams.get(name);
  const kindChip = (kind) => page.locator(`[data-feed-kind="${kind}"]`);
  const waitFeed = async (check, label) => { await until(async () => feedCalls.length && check(lastFeed()), label); };
  /** Polls until `read()` equals `expected` (the admin is zoneless: the DOM settles a tick after events). */
  const eventually = async (read, expected, label) => { let last; await until(async () => { last = await read(); return last === expected; }, `${label} (last: ${last})`); };
  const openSheet = async () => { await page.locator('[data-feed-filters]').click(); await until(() => page.locator('[data-feed-sheet][open]').isVisible(), 'filters sheet open'); };

  // 1. The answer comes first, from the summary, for the last 24 hours.
  await page.goto(`${base}/activity`);
  await rows.first().waitFor({ timeout: 60000 });
  await until(async () => /things happened/.test(await answer.innerText()), 'answer line');
  assert.match(await answer.innerText(), /6,330 things happened in the last 24 hours\. 159 didn't go as planned \(16 failed\)\./);
  assert.equal(await page.locator('h1').innerText(), 'Activity');
  assert.ok(Math.abs(hoursBack(lastFeed().from) - 24) < 0.2, 'first page reads the last 24 hours');
  assert.ok(Math.abs(hoursBack(lastSummary().from) - 24) < 0.2, 'summary reads the last 24 hours');
  assert.equal(await kindChip('protection').count(), 0, 'kinds with no rows in the range get no chip');
  assert.match(await kindChip('command').innerText(), /Commands\s*1,482/);
  assert.match(await page.locator('[data-feed-problems]').innerText(), /Problems\s*159/);

  // 2. Range: request + URL.
  await page.locator('[data-feed-bar] .lf-seg label', { hasText: '7d' }).click();
  await waitFeed((q) => Math.abs(hoursBack(q.from) - 168) < 0.2, 'range 7d request');
  assert.equal(param('range'), '7d');
  await until(async () => Math.abs(hoursBack(lastSummary().from) - 168) < 0.2, 'summary follows the range');
  await until(async () => /in the last 7 days/.test(await answer.innerText()), 'answer names the range');

  // 3. Kinds: several at once, "All" clears them.
  await kindChip('command').click();
  await waitFeed((q) => q.kinds === 'command', 'kinds=command');
  await kindChip('alert').click();
  await waitFeed((q) => q.kinds === 'command,alert', 'kinds=command,alert');
  assert.equal(param('kinds'), 'command,alert');
  await eventually(() => kindChip('command').getAttribute('aria-pressed'), 'true', 'Commands chip on');
  await eventually(() => kindChip('all').getAttribute('aria-pressed'), 'false', 'All chip off');
  await until(async () => /Counting commands and chat alerts only/.test(await answer.innerText()), 'answer counts only the picked kinds');
  assert.match(await answer.innerText(), /1,870 things happened in the last 7 days\. 137 didn't go as planned/);
  await kindChip('all').click();
  await waitFeed((q) => !q.kinds, 'All clears kinds');
  assert.equal(param('kinds'), null);

  // 4. Problems: the answer's button and the chip.
  state.refusals = true;
  await page.locator('[data-feed-only-problems]').click();
  await waitFeed((q) => q.outcome === 'problems', 'outcome=problems');
  assert.equal(param('outcome'), 'problems');
  await eventually(() => page.locator('[data-feed-problems]').getAttribute('aria-pressed'), 'true', 'Problems chip on');
  await until(async () => (await rows.count()) === 2, 'only the rows that went wrong');
  const problemTitles = await page.locator('[data-feed-row] .feed-row__title').allInnerTexts();
  assert.deepEqual(problemTitles, ['Voice for Mossy_Fern failed: the voice couldn\'t be generated', 'Bot message not sent: Twitch held it for moderation'],
    'cooldown, a turned-off alert and a viewer without the role are not problems');
  state.refusals = false;
  await page.locator('[data-feed-problems]').click();
  await waitFeed((q) => !q.outcome, 'problems chip toggles off');
  assert.equal(param('outcome'), null);

  // 5. Streamer through the picker in the Filters sheet; badge; title; removable chip.
  await openSheet();
  await page.locator('[data-feed-sheet] input[type=search]').fill('pix');
  await page.locator('[data-feed-sheet] button', { hasText: 'pixel_harbor' }).click();
  await page.locator('[data-feed-draft-channel]').waitFor();
  await page.locator('[data-feed-sheet] .lf-choice', { hasText: 'Failed only' }).click();
  await page.locator('[data-feed-apply]').click();
  await waitFeed((q) => q.channel === '700000001' && q.outcome === 'failed', 'channel + failed request');
  await eventually(async () => param('channel'), '700000001', 'channel in URL');
  assert.equal(param('outcome'), 'failed');
  await eventually(() => lastSummary().channel, '700000001', 'summary narrowed to the streamer');
  await until(async () => (await page.locator('h1').innerText()) === 'pixel_harbor only', 'title names the streamer');
  await eventually(() => page.locator('[data-feed-badge]').innerText(), '2', 'filters badge');
  assert.match(await page.locator('[data-feed-problems]').innerText(), /Failed only/);
  await page.locator('[data-feed-active="channel"]').click();
  await waitFeed((q) => !q.channel && q.outcome === 'failed', 'channel chip removed');
  await page.locator('[data-feed-problems]').click();
  await waitFeed((q) => !q.outcome, 'failed off');

  // 6. Viewer login (accepts @name); an impossible name is refused inline.
  await openSheet();
  await page.locator('[data-feed-viewer]').fill('bad name!');
  await page.locator('[data-feed-apply]').click();
  await page.locator('[data-feed-sheet] .lf-error').waitFor();
  assert.equal(await page.locator('[data-feed-viewer]').getAttribute('aria-invalid'), 'true');
  await page.locator('[data-feed-viewer]').fill('@Mossy_Fern');
  await page.locator('[data-feed-apply]').click();
  await waitFeed((q) => q.actorLogin === 'mossy_fern', 'actorLogin request');
  assert.equal(param('actorLogin'), 'mossy_fern');
  await eventually(() => lastSummary().actorLogin, 'mossy_fern', 'summary narrowed to the viewer');
  await until(async () => (await page.locator('h1').innerText()) === 'Everything from Mossy_Fern', 'title names the viewer');
  await page.locator('[data-feed-active="viewer"]').click();
  await waitFeed((q) => !q.actorLogin, 'viewer chip removed');

  // 7. A deep link restores the view; an unknown kind in an old link is ignored.
  await page.goto(`${base}/activity?range=1h&kinds=command,teleport,alert&outcome=problems&channel=700000002`);
  await waitFeed((q) => q.kinds === 'command,alert' && q.outcome === 'problems' && q.channel === '700000002' && Math.abs(hoursBack(q.from) - 1) < 0.1, 'deep link request');
  await until(() => page.getByRole('radio', { name: '1 hour' }).isChecked(), 'range restored');
  await eventually(() => kindChip('alert').getAttribute('aria-pressed'), 'true', 'Chat alerts chip on');
  await until(async () => (await page.locator('h1').innerText()) === 'luna_plays only', 'channel name from the rows');
  await eventually(() => page.locator('[data-feed-problems]').getAttribute('aria-pressed'), 'true', 'Problems chip on');

  // 8. A row opens and shows its facts; "Everything from <viewer>" applies the viewer filter.
  await page.goto(`${base}/activity`);
  await rows.first().waitFor();
  await rows.first().locator('summary').click();
  const body = rows.first().locator('[data-feed-body]');
  await body.waitFor();
  assert.match(await body.innerText(), /Who[\s\S]*Mossy_Fern/);
  await body.getByRole('link', { name: /Everything from Mossy_Fern/ }).click();
  await waitFeed((q) => q.actor === '810000001', 'actor request from a row');
  assert.equal(param('actor'), '810000001');
  await until(async () => (await page.locator('h1').innerText()) === 'Everything from Mossy_Fern', 'viewer title from an id');

  // 9. Load more appends older rows without duplicates.
  await page.goto(`${base}/activity`);
  await rows.first().waitFor();
  assert.equal(await rows.count(), FIRST.length);
  const scrollBefore = await page.evaluate(() => { window.scrollTo(0, 400); return window.scrollY; });
  await page.locator('[data-feed-more]').click();
  await waitFeed((q) => q.cursor === 'p2', 'cursor request');
  assert.ok(Math.abs(hoursBack(lastFeed().from) - 24) < 0.2, 'load more keeps the range');
  await until(async () => (await rows.count()) === FIRST.length + PAGE2.length - 1, 'page 2 appended, duplicate dropped');
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore) < 5, 'scroll position kept');
  assert.equal(await page.locator('[data-feed-more]').count(), 0, 'no more pages');
  assert.match(await page.locator('[data-feed-end]').innerText(), /That's everything in the last 24 hours/);

  // 10. Live: a new row goes in at the top; with a row open it waits behind a pill.
  await page.goto(`${base}/activity`);
  await rows.first().waitFor();
  await page.locator('[data-feed-live]').click();
  await eventually(() => page.locator('[data-feed-live]').getAttribute('aria-pressed'), 'true', 'Live on');
  state.liveExtra = [row(0, 'command', { name: '!lurk', text: '!lurk', id: 'live:1' })];
  await until(async () => (await rows.count()) === FIRST.length + 1, 'live row inserted', 200);
  assert.match(await rows.first().innerText(), /!lurk/);
  await rows.nth(2).locator('summary').click();
  await rows.nth(2).locator('[data-feed-body]').waitFor();
  state.liveExtra = [row(0, 'command', { name: '!dance', id: 'live:2' }), ...state.liveExtra];
  const liveFrom = feedCalls.length;
  await until(async () => (await page.locator('[data-feed-pending]').count()) === 1, `new-rows pill (feed reads since: ${feedCalls.length - liveFrom})`, 250);
  assert.match(await page.locator('[data-feed-pending]').innerText(), /1 new, tap to show/);
  assert.equal(await rows.count(), FIRST.length + 1, 'nothing inserted while a row is open');
  await page.locator('[data-feed-pending]').click();
  await until(async () => (await rows.count()) === FIRST.length + 2 && /!dance/.test(await rows.first().innerText()), 'pill shows the new row');
  await page.locator('[data-feed-live]').click();
  state.liveExtra = [];

  // 11. Partial: a plain notice naming what is missing.
  state.partial = ['voice', 'ai'];
  await page.goto(`${base}/activity`);
  await page.locator('[data-feed-partial]').waitFor();
  assert.match(await page.locator('[data-feed-partial]').innerText(), /Voice and AI rows couldn't be loaded right now; the rest is complete\./);
  state.partial = [];

  // 12. Empty: says so, offers a wider range, and is honest about command records.
  state.empty = true; state.emptySummary = true;
  await page.goto(`${base}/activity?kinds=command&range=7d`);
  await page.locator('[data-feed-empty]').waitFor();
  assert.match(await page.locator('[data-feed-empty]').innerText(), /Nothing recorded in the last 7 days\.[\s\S]*Command runs are recorded from the day this console went live/);
  await until(async () => /Nothing was recorded in the last 7 days\./.test(await answer.innerText()), 'answer says nothing happened');
  await page.locator('[data-feed-wider]').click();
  await waitFeed((q) => Math.abs(hoursBack(q.from) - 720) < 0.5, 'wider range request');
  assert.equal(param('range'), '30d');
  state.empty = false; state.emptySummary = false;

  // 13. Error + Retry, filters kept.
  state.failList = 1;
  await page.goto(`${base}/activity?kinds=voice&range=7d`);
  await page.locator('[data-feed-error]').waitFor();
  assert.equal(await page.locator('[data-feed-error]').getAttribute('role'), 'alert');
  await eventually(() => kindChip('voice').getAttribute('aria-pressed'), 'true', 'filters kept through the error');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await until(async () => (await rows.count()) === 1, 'retry loads');
  assert.equal(lastFeed().kinds, 'voice');

  // 14. ?event= opens the sheet: deliveries in plain words, raw event collapsed, copy, close clears the param.
  await page.goto(`${base}/activity?range=7d&event=${encodeURIComponent(EVENT.eventKey)}`);
  const sheet = page.locator('[data-event-detail]');
  await page.locator('[data-event-delivery]').first().waitFor();
  assert.equal(eventCalls.at(-1), EVENT.eventKey);
  assert.equal(await sheet.locator('h2').innerText(), 'New follower');
  await sheet.locator('[data-event-test]').waitFor();
  const deliveries = await page.locator('[data-event-delivery]').allInnerTexts();
  assert.match(deliveries[0], /Chat alert[\s\S]*This alert is turned off[\s\S]*Skipped/);
  assert.match(deliveries[1], /Follow protection[\s\S]*Done/);
  assert.match(deliveries[2], /Overlay widgets[\s\S]*3 attempts[\s\S]*Still retrying/);
  assert.match(deliveries[3], /Goals[\s\S]*The bot crashed while handling it[\s\S]*Gave up/);
  assert.match(deliveries[4], /Billing/);
  assert.match(deliveries[5], /mystery-consumer-v9/);
  assert.match(await sheet.locator('[data-event-verdict]').innerText(), /6 parts of the bot handled it: 3 done, 1 skipped, 1 still running, 1 gave up\./);
  assert.match(await sheet.locator('[data-event-steps]').innerText(), /Timers[\s\S]*Editors sync[\s\S]*The bot couldn't sign in to Twitch/);
  assert.equal(await sheet.locator('[data-event-trace]').getAttribute('href'), '/observability?tab=traces&trace=trace-abc123');
  assert.equal(await sheet.locator('[data-event-raw]').evaluate((el) => el.open), false, 'raw event starts collapsed');
  await sheet.locator('[data-event-raw] summary').click();
  assert.match(await sheet.locator('.ed-json').innerText(), /"broadcaster_user_login": "luna_plays"/);
  await sheet.getByRole('button', { name: 'Copy' }).click();
  await until(async () => /"type": "channel.follow"/.test(await page.evaluate(() => window.__copied || '')), 'raw event copied');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await until(async () => param('event') === null && (await sheet.count()) === 0, 'close clears the param');
  assert.equal(param('range'), '7d', 'other params kept');
  // From a row: its link opens the sheet; Escape closes it and focus goes back.
  await page.goto(`${base}/activity`);
  await rows.nth(2).locator('summary').click();
  const eventLink = rows.nth(2).getByRole('link', { name: /What the bot did with it/ });
  await eventLink.click();
  await page.locator('[data-event-delivery]').first().waitFor();
  assert.equal(param('event'), EVENT.eventKey);
  await page.keyboard.press('Escape');
  await until(async () => param('event') === null && (await sheet.count()) === 0, 'Escape closes');
  await until(() => page.evaluate(() => /What the bot did/.test(document.activeElement?.textContent || '')), 'focus returns to the link');

  // 15. A channel's tab: fixed channel, no channel names in rows, no streamer filter, link to the wider tools.
  await page.goto(`${base}/channels/700000001/activity`);
  await rows.first().waitFor();
  await waitFeed((q) => q.channel === '700000001', 'tab sends the fixed channel');
  await eventually(() => lastSummary().channel, '700000001', 'tab summary channel');
  assert.equal(await page.locator('app-feed-list .feed-row__meta b').count(), 0, 'channel names hidden');
  assert.equal(await page.locator('app-channel-activity h1').count(), 0, 'no page h1 inside the tab');
  assert.equal(await page.locator('[data-channel-logs]').getAttribute('href'), '/observability?channel=700000001&tab=logs');
  await openSheet();
  assert.equal(await page.locator('[data-feed-sheet] app-channel-picker').count(), 0, 'no streamer picker in the tab');
  await page.keyboard.press('Escape');
  await kindChip('command').click();
  await waitFeed((q) => q.channel === '700000001' && q.kinds === 'command', 'kinds keep the fixed channel');
  assert.equal(param('channel'), null, 'the fixed channel is not written to the URL');

  // 16. Rows say what went wrong in plain words, not "something went wrong".
  state.diagnostics = true;
  await page.goto(`${base}/activity`);
  await eventually(() => rows.count(), DIAGNOSTICS.length, 'diagnostic rows');
  const titles = await page.locator('[data-feed-row] .feed-row__title').allInnerTexts();
  assert.deepEqual(titles, [
    '!game failed for Mossy_Fern: The game does not exist',
    '!dc: Mossy_Fern left out what it needs',
    "!s didn't answer Mossy_Fern: it is turned off",
    'Voice request from Mossy_Fern not read: no speech page was open in OBS',
    'Voice message from Mossy_Fern played',
    "Voice message from Mossy_Fern didn't play: the speech page couldn't start the sound (often a hidden OBS source)",
    'Voice message from Mossy_Fern not finished: a mod skipped it',
  ]);
  const details = await page.locator('[data-feed-row]').evaluateAll((els) => els.map((el) => el.querySelector('.feed-row__detail')?.textContent?.trim() ?? null));
  assert.equal(details[1], 'The bot replied how to use it');
  assert.equal(details[3], 'Speech overlay is not connected. Open the speech URL first and try again. · from a command');
  assert.equal(details[4], 'fish · rias · 42 characters · moved to another speech page (couldn\'t start the sound)');
  const open = async (index) => {
    await rows.nth(index).locator('summary').click();
    const body = rows.nth(index).locator('[data-feed-body]');
    await body.waitFor();
    return body.innerText();
  };
  assert.match(await open(0), /Error\s+The game does not exist/);
  assert.match(await open(1), /Bot replied\s+Usage: !dc <command name>/);
  const moved = await open(4);
  assert.match(moved, /Moved because the first page\s+couldn't start the sound/);
  assert.match(moved, /Speech pages it went to\s+2/);
  assert.match(moved, /Someone heard it\s+Yes/);
  assert.match(await open(5), /Ended as\s+couldn't start the sound/);
  // Tone: a failure is red, a setting at work (turned off, usage) is muted, a played message is ok.
  const tones = await rows.evaluateAll((els) => els.map((el) => el.dataset.tone));
  assert.deepEqual(tones, ['danger', 'muted', 'muted', 'danger', 'ok', 'danger', 'muted']);
  // The filter sheet explains what a problem is.
  await openSheet();
  assert.match(await page.locator('[data-feed-sheet]').innerText(), /Turned off, cooldowns and other skips on purpose aren't problems\./);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${artifacts}/diagnostics-dark-390.png` });
  state.diagnostics = false;

  // 17. Layout and accessibility, dark first.
  for (const mode of ['dark', 'light']) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await page.goto(`${base}/activity`);
      await rows.first().waitFor();
      await until(async () => /things happened/.test(await answer.innerText()), `${mode} ${width} answer`);
      await rows.first().locator('summary').click();
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${mode} overflow at ${width}`);
      for (const control of await page.locator('[data-feed-bar] button, [data-feed-bar] .lf-seg span, [data-feed-live], [data-feed-more]').all()) {
        const box = await control.boundingBox();
        if (box) assert.ok(box.height >= 43.5, `${mode} ${width}: 44px touch target (${await control.innerText()})`);
      }
      // Day headings stick just under the filter bar, never under it.
      await page.evaluate(() => window.scrollTo(0, 700));
      await page.waitForTimeout(200);
      const stick = await page.evaluate(() => ({ bar: document.querySelector('[data-feed-bar]').getBoundingClientRect().bottom, top: parseFloat(getComputedStyle(document.querySelector('.feed__day')).top) }));
      assert.ok(Math.abs(stick.top - stick.bar) < 2, `${mode} ${width}: day heading sticks under the bar (${stick.top} vs ${stick.bar})`);
      await page.evaluate(() => window.scrollTo(0, 0));
      const axe = await new AxeBuilder({ page }).include('app-feed-explorer').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(axe.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${mode} ${width} axe`);
      await page.screenshot({ path: `${artifacts}/${mode}-${width}.png` });
      await openSheet();
      await page.waitForTimeout(300);
      const sheetAxe = await new AxeBuilder({ page }).include('[data-feed-sheet]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(sheetAxe.violations.map((item) => item.id), [], `${mode} ${width} filters sheet axe`);
      await page.keyboard.press('Escape');
      await page.goto(`${base}/activity?event=${encodeURIComponent(EVENT.eventKey)}`);
      await page.locator('[data-event-delivery]').first().waitFor();
      await page.locator('[data-event-raw] summary').click();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${mode} event overflow at ${width}`);
      const eventAxe = await new AxeBuilder({ page }).include('[data-event-detail]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(eventAxe.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${mode} ${width} event axe`);
      await page.screenshot({ path: `${artifacts}/${mode}-${width}-event.png` });
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await page.goto(`${base}/channels/700000001/activity`);
      await rows.first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${mode} channel tab overflow at ${width}`);
      const tabAxe = await new AxeBuilder({ page }).include('app-channel-activity').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(tabAxe.violations.map((item) => item.id), [], `${mode} ${width} channel tab axe`);
    }
  }

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(unexpected, [], 'no unexpected or writing API calls');
  console.log(`PASS admin-console-activity-browser (${feedCalls.length} feed reads, ${summaryCalls.length} summaries, ${eventCalls.length} event reads; other GETs: ${[...new Set(otherCalls)].join(', ') || 'none'})`);
} finally {
  await browser.close();
}
