// Admin "Chat protection decisions" ledger (/ai/decisions) and a channel's Protection tab. Every API call is
// mocked (on api.domdimabot.com and the dev server's localhost:3000): no verdict can reach production.
// Covers the answer line (warn and ok tones), every chip and sheet filter in the request and the URL, sort,
// paging, the detail sheet (scores against the ban bar, collapsed chat, cost facts, Twitch's refusal),
// Next/Previous, a deep link to a decision that is not on the list, saving/changing/removing a verdict
// (PUT body asserted), the note limit, a failed save keeping the note, the row updating in place, the
// channel tab's fixed channel, empty and error + Retry, and axe/overflow/touch targets at 320/390/1280 px in
// dark and light with the sheet closed and open.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-decisions';
fs.mkdirSync(artifacts, { recursive: true });

// ---- Fixtures (fictional names) ----
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const baseRow = {
  channelID: '700001', channel: 'maplewave', kind: 'ai', ruleType: 'builtin', ruleReason: null, source: 'first_message', messageOrdinal: 1,
  verdict: 'allow', status: 'completed', outcome: 'allowed', action: null, actionError: null, model: 'openai/gpt-6-luna-decisions', provider: 'openai',
  scores: null, thresholdPercent: 85, inputTokens: 412, providerUSD: 0.00018, credits: 0, included: true, latencyMs: 610, nearMiss: false, feedback: null,
};
function makeRows() {
  const rows = [
    { ...baseRow, id: 'd1', at: ago(12), chatter: { id: '81001', login: 'pixelpeddler', name: 'PixelPeddler' }, messageText: 'Get cheap viewers and followers at boostr dot shop!! best prices, real people', verdict: 'violation', outcome: 'acted', action: 'ban', scores: { ads: 0.972, spam: 0.62, self_promotion: 0.41, safe: 0.02, violation: 0.972 }, providerUSD: 0.00021, latencyMs: 640 },
    { ...baseRow, id: 'd2', at: ago(55), channelID: '700002', channel: 'quietfjord', chatter: { id: '81002', login: 'spamsprout', name: 'SpamSprout' }, messageText: 'FREE SKINS at sk1ns-giveaway . net claim before it ends', verdict: 'violation', outcome: 'action_failed', action: 'ban', actionError: 'The user specified in the user_id field is already banned.', scores: { spam: 0.913, ads: 0.55, safe: 0.04, violation: 0.913 }, included: false, credits: 120, providerUSD: 0.00024, latencyMs: 820, feedback: { label: 'violation', note: null, reviewedAt: ago(30) } },
    { ...baseRow, id: 'd3', at: ago(140), chatter: { id: '81003', login: 'lunaknits', name: 'LunaKnits' }, messageText: 'omg love this! I stream knitting on weekends too, come say hi sometime', scores: { self_promotion: 0.748, ads: 0.12, safe: 0.22, violation: 0.748 }, messageOrdinal: 2, feedback: { label: 'allow', note: 'Friendly regular from another community.', reviewedAt: ago(100) } },
    { ...baseRow, id: 'd4', at: ago(200), chatter: { id: '81004', login: 'speedrunsam', name: 'SpeedrunSam' }, messageText: 'gg that was a clean run', scores: { self_promotion: 0.03, ads: 0.01, safe: 0.97, violation: 0.03 } },
    { ...baseRow, id: 'd5', at: ago(260), channelID: '700002', channel: 'quietfjord', chatter: { id: '81005', login: 'mossy_tea', name: 'Mossy_Tea' }, messageText: 'is the giveaway still on? where do I sign up', verdict: 'uncertain', status: 'timeout', outcome: 'not_reviewed', scores: null, latencyMs: 0, providerUSD: 0, inputTokens: 0, messageOrdinal: 1 },
    { ...baseRow, id: 'd6', at: ago(320), kind: 'rule', ruleType: 'links', ruleReason: 'No links unless the streamer asks', source: 'rule', messageOrdinal: null, chatter: { id: '81006', login: 'clipcollector', name: 'ClipCollector' }, messageText: 'clip of that jump: clips.example.tv/AbCdEf', verdict: 'violation', status: 'matched', outcome: 'acted', action: 'warn', model: null, provider: null, thresholdPercent: null, inputTokens: 0, providerUSD: 0, included: false, latencyMs: 0 },
    { ...baseRow, id: 'd7', at: ago(400), chatter: { id: '81007', login: null, name: 'Ghost_Viewer' }, messageText: 'anyone want to trade accounts dm me', scores: { spam: 0.41, ads: 0.3, safe: 0.55, violation: 0.41 }, included: false, credits: 80, providerUSD: 0.00019, latencyMs: 1900, feedback: { label: 'violation', note: 'Account trading is always a scam here.', reviewedAt: ago(380) } },
    { ...baseRow, id: 'd8', at: ago(600), channelID: '700003', channel: 'emberlane', source: 'spam_continuous', messageOrdinal: null, chatter: { id: '81008', login: 'hypehorn', name: 'HypeHorn' }, messageText: 'FOLLOW ME FOLLOW ME FOLLOW ME I follow back 100%', verdict: 'violation', outcome: 'acted', action: 'ban', scores: { self_promotion: 0.88, spam: 0.8, safe: 0.05, violation: 0.88 }, included: false, credits: 95, providerUSD: 0.0002, feedback: { label: 'allow', note: null, reviewedAt: ago(500) } },
  ];
  for (let i = 0; i < 22; i++) {
    rows.push({ ...baseRow, id: `f${i + 1}`, at: ago(700 + i * 90), chatter: { id: `82${String(i).padStart(3, '0')}`, login: `viewer_${i + 1}`, name: `Viewer_${i + 1}` }, messageText: `hello chat, first time here #${i + 1}`, scores: { self_promotion: 0.02, safe: 0.98, violation: 0.02 } });
  }
  // The API marks near misses itself (not a ban, answered in time, top score at least 50%, not sure it was safe).
  return rows.map((row) => ({ ...row, nearMiss: nearMissOf(row) }));
}
function nearMissOf(row) {
  return row.kind === 'ai' && row.verdict !== 'violation' && ['completed', 'uncertain'].includes(row.status)
    && (row.scores?.violation ?? 0) >= 0.5 && (row.scores?.safe ?? 1) <= 0.9;
}

const deepDecision = { ...baseRow, id: 'deep1', at: ago(60 * 24 * 5), channelID: '700003', channel: 'emberlane', chatter: { id: '81099', login: 'oldtimer', name: 'OldTimer' }, messageText: 'buy gold here cheap cheap', verdict: 'violation', outcome: 'acted', action: 'timeout', scores: { ads: 0.9, safe: 0.08, violation: 0.9 }, latencyMs: 700 };

function makeSummary({ bansFailed = 1, notReviewed = 9, total = 585, labelled = 14 } = {}) {
  const daily = [];
  for (let d = 6; d >= 0; d--) {
    const date = new Date(NOW - d * 86_400_000).toISOString().slice(0, 10);
    daily.push({ date, reviews: [70, 92, 64, 110, 88, 96, 65][6 - d], violations: [0, 1, 0, 2, 1, 1, 0][6 - d], notReviewed: [1, 2, 0, 3, 1, 2, 0][6 - d], providerUSD: 0.012 });
  }
  return {
    from: ago(7 * 24 * 60), to: ago(0), total, aiReviews: total ? total - 45 : 0, ruleHits: total ? 45 : 0, violations: 5, bans: total ? 3 : 0, bansFailed, notReviewed,
    included: total ? 500 : 0, providerUSD: total ? 0.0912 : 0, credits: total ? 4200 : 0, latencyP50Ms: 620, latencyP95Ms: 1800, channels: 12,
    labelled, agree: labelled ? 12 : 0, disagree: labelled ? 2 : 0, verdictsWaiting: 12, daily,
    byModel: [
      { model: 'openai/gpt-6-luna-decisions', reviews: 520, violations: 5, bans: 3, notReviewed: 9, providerUSD: 0.088, latencyP50Ms: 610 },
      { model: 'openai/gpt-6-luna', reviews: 20, violations: 0, bans: 0, notReviewed: 0, providerUSD: 0.0032, latencyP50Ms: 1200 },
    ],
    byChannel: [
      { channelID: '700001', channel: 'maplewave', reviews: 310, violations: 3, providerUSD: 0.05 },
      { channelID: '700002', channel: 'quietfjord', reviews: 180, violations: 1, providerUSD: 0.03 },
      { channelID: '700003', channel: 'emberlane', reviews: 95, violations: 1, providerUSD: 0.0112 },
    ],
  };
}

function detailOf(row) {
  return {
    ...row,
    invited: row.id === 'd3',
    categories: row.kind === 'ai' ? ['spam', 'ads', 'self_promotion'] : [],
    context: row.id === 'd5' ? [] : [
      { username: 'maplewave', message: 'welcome in everyone, giveaway at 100 followers!', isBroadcaster: true, at: ago(14) },
      { username: 'SpeedrunSam', message: 'lets gooo', isBroadcaster: false, at: ago(13) },
      { username: 'LunaKnits', message: 'hi hi', isBroadcaster: false, at: ago(13) },
    ],
    history: row.id === 'd1' ? [
      { id: 'd4', at: ago(200), messageText: 'gg that was a clean run', verdict: 'allow', outcome: 'allowed', action: null },
      { id: 'deep1', at: ago(60 * 24 * 5), messageText: 'buy gold here cheap cheap', verdict: 'violation', outcome: 'acted', action: 'timeout' },
    ] : [],
  };
}

/** A filtering mock over the rows, the way the API answers. */
function filterRows(rows, params) {
  const p = (key) => params.get(key);
  let list = rows.filter((row) => {
    if (p('channel') && row.channelID !== p('channel')) return false;
    if (p('chatter') && row.chatter.id !== p('chatter')) return false;
    if (p('chatterName') && ![row.chatter.name, row.chatter.login].some((name) => name && name.toLowerCase() === p('chatterName').toLowerCase())) return false;
    if (p('kind') && row.kind !== p('kind')) return false;
    if (p('source') && row.source !== p('source')) return false;
    if (p('model') && row.model !== p('model')) return false;
    const show = p('show');
    if (show === 'bans' && row.action !== 'ban') return false;
    if (show === 'action_failed' && row.outcome !== 'action_failed') return false;
    if (show === 'not_reviewed' && row.outcome !== 'not_reviewed') return false;
    if (show === 'allowed' && row.outcome !== 'allowed') return false;
    if (show === 'near_miss' && !row.nearMiss) return false;
    const fb = p('feedback');
    const agrees = row.feedback && (row.feedback.label === 'violation' ? row.verdict === 'violation' : row.verdict !== 'violation');
    if (fb === 'none' && row.feedback) return false;
    if (fb === 'any' && !row.feedback) return false;
    if (fb === 'agree' && !(row.feedback && agrees)) return false;
    if (fb === 'disagree' && !(row.feedback && !agrees)) return false;
    return true;
  });
  const sort = p('sort');
  if (sort === 'cost') list = [...list].sort((a, b) => b.providerUSD - a.providerUSD);
  if (sort === 'score') list = [...list].sort((a, b) => (b.scores?.violation ?? 0) - (a.scores?.violation ?? 0));
  if (sort === 'slowest') list = [...list].sort((a, b) => b.latencyMs - a.latencyMs);
  const page = Number(p('page') || 1);
  const limit = Number(p('limit') || 25);
  return { rows: list.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / limit)) } };
}


// ---------------------------------------------------------------------------------------------------
const TOKEN = 'disposable-decisions-fixture';
const isApi = (url) => url.hostname === 'api.domdimabot.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000');
const state = { rows: makeRows(), summary: makeSummary(), failList: 0, failSummary: 0, failPut: 0 };
const listCalls = [];
const summaryCalls = [];
const puts = [];
const otherCalls = [];
const unexpected = [];
const user = (channelID, channel, isLive = false) => ({ channelID, channel, email: `${channel}@example.test`, plan_tier: 'free', actived: true, chat_enabled: true, has_permissions: true,
  up_to_date_permissions: true, isLive, liveViewers: 0, commandsCount: 4, eventsubsActiveCount: 6, eventsubsDisabledCount: 0 });
const users = [user('700001', 'maplewave'), user('700002', 'quietfjord'), user('700009', 'quietpine', true)];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript((token) => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
  }, TOKEN);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
    if (!isApi(url)) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(data) });
    const ok = (data) => json({ error: false, message: 'ok', status: 200, data });
    const path = url.pathname;
    if (path.startsWith('/admin-site/decisions')) {
      assert.equal(request.headers().authorization, `Bearer ${TOKEN}`, 'decision requests carry the admin session');
      if (request.method() === 'GET' && path === '/admin-site/decisions') {
        listCalls.push(url.searchParams);
        if (state.failList) { state.failList--; return json({ error: true, message: 'fixture failure', status: 500 }, 500); }
        return ok(filterRows(state.rows, url.searchParams));
      }
      if (request.method() === 'GET' && path === '/admin-site/decisions/summary') {
        summaryCalls.push(url.searchParams);
        if (state.failSummary) { state.failSummary--; return json({ error: true, message: 'fixture failure', status: 500 }, 500); }
        return ok(state.summary);
      }
      const parts = path.split('/');
      const id = decodeURIComponent(parts[3] || '');
      const row = [...state.rows, deepDecision].find((item) => item.id === id);
      if (request.method() === 'GET' && parts.length === 4) return row ? ok(detailOf(row)) : json({ error: true, message: 'Decision not found', status: 404 }, 404);
      if (request.method() === 'PUT' && parts[4] === 'feedback') {
        const body = JSON.parse(request.postData() || '{}');
        puts.push({ id, body });
        if (state.failPut) { state.failPut--; return json({ error: true, message: 'fixture failure', status: 500 }, 500); }
        const feedback = body.label ? { label: body.label, note: body.note, reviewedAt: new Date().toISOString() } : null;
        if (row) row.feedback = feedback;
        return ok({ feedback });
      }
    }
    if (request.method() === 'GET' && path === '/admin-site/users') {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const rows = users.filter((item) => item.channel.includes(search) || item.channelID === search);
      return ok({ rows, pagination: { page: 1, limit: 6, total: rows.length, totalPages: 1 }, summary: {} });
    }
    // The channel frame around the Protection tab reads its own 24-hour summary.
    if (request.method() === 'GET' && path === '/admin-site/feed/summary') return ok({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), kinds: [], partial: [] });
    otherCalls.push(`${request.method()} ${path}`);
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return route.abort(); }
    return ok({});
  });

  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const until = async (fn, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${label}`); };
  const rows = page.locator('[data-decision-row]');
  const answer = page.locator('[data-decisions-answer]');
  const sheet = page.locator('dialog[data-decision-sheet]');
  const filterSheet = page.locator('dialog[data-decisions-filter-sheet]');
  const query = () => new URL(page.url()).searchParams;
  const lastList = () => listCalls[listCalls.length - 1];
  /** Click, then wait for a new list request whose params pass `test`, and for the URL to follow. */
  const listAfter = async (action, test, label) => {
    const before = listCalls.length;
    await action();
    await until(() => listCalls.length > before && test(lastList()), `${label}: list request`);
    return lastList();
  };
  const goto = async (path) => {
    await page.goto(`${base}${path}`);
    await page.locator('[data-decision-row], [data-decisions-empty], [data-decisions-error]').first().waitFor({ timeout: 60000 });
  };

  // ---- The answer line ----
  await goto('/ai/decisions');
  await until(async () => (await answer.count()) > 0, 'answer line');
  const answerText = (await answer.innerText()).replace(/\s+/g, ' ');
  assert.match(answerText, /585 messages reviewed in the last 7 days: 3 banned, 9 couldn't be reviewed\. It cost us \$0\.091\./, 'answer sentence');
  assert.equal(await answer.getAttribute('data-tone'), 'warn', 'a refused ban makes the answer a warning');
  assert.match(answerText, /Twitch refused 1 ban\./, 'the warning says which');
  assert.match(answerText, /You've judged 14: 12 agreed with the bot, 2 didn't/, 'verdict agreement fact');
  assert.match(answerText, /Typical review 620 ms/, 'typical time fact');
  assert.match(answerText, /500 included free reviews/, 'included fact');
  const totals = (await page.locator('[data-numbers-totals]').textContent()).replace(/\s+/g, ' ');
  assert.match(totals, /Charged to channels\s*4,200 credits ≈ \$0\.042/, 'credits are labelled and shown in dollars');
  assert.match(totals, /Provider cost\s*\$0\.091/, 'provider cost kept apart from credits');
  assert.match(await page.locator('[data-review-link]').innerText(), /Review queue \(12\)/, 'review queue link with count');
  assert.equal(await page.locator('app-decisions-page h1').count(), 1, 'one h1');
  const firstSummary = summaryCalls[summaryCalls.length - 1];
  const fromHours = (params) => (Date.now() - Date.parse(params.get('from'))) / 3_600_000;
  assert.ok(Math.abs(fromHours(firstSummary) - 168) < 0.2, 'default range is 7 days');
  assert.ok(Math.abs(fromHours(lastList()) - 168) < 0.2, 'list uses the same range');
  assert.equal(lastList().get('limit'), '25');

  // The answer's "See refused" shortcut is a filter.
  await listAfter(() => answer.getByRole('button', { name: 'See refused' }).click(), (p) => p.get('show') === 'action_failed', 'answer shortcut');
  await until(() => query().get('show') === 'action_failed', 'shortcut in URL');

  // OK tone when nothing failed.
  state.summary = makeSummary({ bansFailed: 0, notReviewed: 2 });
  await goto('/ai/decisions');
  await until(async () => (await answer.getAttribute('data-tone')) === 'ok', 'ok tone');
  assert.match((await answer.innerText()).replace(/\s+/g, ' '), /585 messages reviewed in the last 7 days: 3 banned, 2 couldn't be reviewed\./);
  // A large share not reviewed is a warning on its own.
  state.summary = makeSummary({ bansFailed: 0, notReviewed: 60 });
  await goto('/ai/decisions');
  await until(async () => (await answer.getAttribute('data-tone')) === 'warn', 'not-reviewed warn tone');
  assert.match(await answer.innerText(), /60 of 540 AI reviews \(11%\) didn't finish/);
  state.summary = makeSummary();

  // ---- Range ----
  await goto('/ai/decisions');
  for (const [key, hours] of [['24h', 24], ['30d', 720], ['7d', 168]]) {
    const beforeSummary = summaryCalls.length;
    const params = await listAfter(() => page.locator(`.dx-range label:has(input[data-range="${key}"])`).click(), (p) => Math.abs(fromHours(p) - hours) < 0.2, `range ${key}`);
    assert.ok(params);
    await until(() => summaryCalls.length > beforeSummary && Math.abs(fromHours(summaryCalls[summaryCalls.length - 1]) - hours) < 0.2, `summary for ${key}`);
    await until(() => (key === '7d' ? query().get('range') === null : query().get('range') === key), `range ${key} in URL`);
  }

  // ---- Chips ----
  const chips = [
    ['bans', { show: 'bans', kind: null }],
    ['near_miss', { show: 'near_miss', kind: null }],
    ['allowed', { show: 'allowed', kind: null }],
    ['not_reviewed', { show: 'not_reviewed', kind: null }],
    ['action_failed', { show: 'action_failed', kind: null }],
    ['rule', { show: null, kind: 'rule' }],
    ['all', { show: null, kind: null }],
  ];
  for (const [chip, expected] of chips) {
    await listAfter(() => page.locator(`[data-chip="${chip}"]`).click(), (p) => p.get('show') === expected.show && p.get('kind') === expected.kind, `chip ${chip}`);
    await until(() => query().get('show') === expected.show && query().get('kind') === expected.kind, `chip ${chip} URL`);
    assert.equal(await page.locator(`[data-chip="${chip}"]`).getAttribute('aria-pressed'), 'true', `${chip} pressed`);
  }
  // Counts come from the summary where they mean the same thing as the filter.
  assert.match(await page.locator('[data-chip="bans"]').innerText(), /4/, 'bans count = accepted + refused bans');
  assert.match(await page.locator('[data-chip="rule"]').innerText(), /45/);
  for (const [chip, value] of [['feedback-none', 'none'], ['feedback-any', 'any']]) {
    await listAfter(() => page.locator(`[data-chip="${chip}"]`).click(), (p) => p.get('feedback') === value, chip);
    await until(() => query().get('feedback') === value, `${chip} URL`);
  }
  await listAfter(() => page.locator('[data-chip="feedback-any"]').click(), (p) => p.get('feedback') === null, 'feedback chip toggles off');
  await until(() => query().get('feedback') === null, 'feedback cleared from URL');

  // ---- Sheet filters ----
  const openFilters = async () => {
    await page.locator('[data-decisions-filters]').click();
    await until(() => filterSheet.evaluate((el) => el.open), 'filters sheet open');
  };
  await openFilters();
  await listAfter(() => filterSheet.locator('[data-filter-model]').selectOption('openai/gpt-6-luna'), (p) => p.get('model') === 'openai/gpt-6-luna', 'model filter');
  await until(() => query().get('model') === 'openai/gpt-6-luna', 'model URL');
  await listAfter(() => filterSheet.locator('[data-filter-model]').selectOption(''), (p) => p.get('model') === null, 'model cleared');
  for (const source of ['first_message', 'spam_continuous', 'rule']) {
    await listAfter(() => filterSheet.locator(`[data-filter-source="${source}"]`).click(), (p) => p.get('source') === source, `source ${source}`);
    await until(() => query().get('source') === source, `source ${source} URL`);
  }
  for (const feedback of ['agree', 'disagree']) {
    await listAfter(() => filterSheet.locator(`[data-filter-feedback="${feedback}"]`).click(), (p) => p.get('feedback') === feedback, `feedback ${feedback}`);
    await until(() => query().get('feedback') === feedback, `feedback ${feedback} URL`);
  }
  for (const sort of ['cost', 'score', 'slowest', 'newest']) {
    await listAfter(() => filterSheet.locator(`[data-filter-sort="${sort}"]`).click(), (p) => p.get('sort') === (sort === 'newest' ? null : sort), `sort ${sort}`);
    await until(() => query().get('sort') === (sort === 'newest' ? null : sort), `sort ${sort} URL`);
  }
  await filterSheet.locator('[data-filter-viewer]').fill('LunaKnits');
  await listAfter(() => filterSheet.getByRole('button', { name: 'Apply' }).click(), (p) => p.get('chatterName') === 'LunaKnits', 'viewer name');
  await until(() => query().get('chatterName') === 'LunaKnits', 'viewer URL');
  await filterSheet.getByLabel('Streamer').fill('quiet');
  await filterSheet.getByRole('button', { name: /quietfjord/ }).click();
  await until(() => query().get('channel') === '700002' && lastList().get('channel') === '700002', 'streamer filter');
  await until(async () => (await filterSheet.locator('.df__current').first().innerText()).includes('quietfjord'), 'picked streamer shown by name');
  await filterSheet.locator('[data-filter-done]').click();
  await until(async () => !(await filterSheet.evaluate((el) => el.open)), 'filters sheet closes');
  // Active filters are removable chips, and the Filters button counts them.
  const active = page.locator('[data-active-filter]');
  await until(async () => (await active.count()) === 4, 'four active filter chips');
  assert.match(await page.locator('[data-decisions-filters]').innerText(), /4/, 'filter count badge');
  assert.ok((await active.allInnerTexts()).some((text) => text.includes('Streamer: quietfjord')), 'channel chip by name');
  await listAfter(() => page.getByRole('button', { name: 'Remove filter: Viewer: LunaKnits' }).click(), (p) => p.get('chatterName') === null && p.get('channel') === '700002', 'remove a chip');
  await until(() => query().get('chatterName') === null, 'chip removal URL');
  await listAfter(() => page.getByRole('button', { name: 'Clear all' }).click(), (p) => !p.get('channel') && !p.get('source') && !p.get('feedback'), 'clear all');
  await until(() => ![...query().keys()].length, 'URL back to defaults');

  // ---- Paging ----
  await goto('/ai/decisions');
  assert.equal(await rows.count(), 25);
  await listAfter(() => page.locator('[data-page-next]').click(), (p) => p.get('page') === '2', 'next page');
  await until(() => query().get('page') === '2', 'page in URL');
  await until(async () => (await rows.count()) === 5, 'page 2 rows');
  await listAfter(() => page.locator('[data-chip="bans"]').click(), (p) => p.get('page') === '1' && p.get('show') === 'bans', 'filter resets page');
  await until(() => query().get('page') === null, 'page reset in URL');

  // ---- A row opens the sheet ----
  await goto('/ai/decisions');
  await rows.first().click();
  await until(() => query().get('open') === 'd1', 'open in URL');
  await until(() => sheet.evaluate((el) => el.open), 'sheet open');
  await sheet.locator('[data-decision-scores]').waitFor();
  assert.match(await sheet.locator('[data-decision-what]').innerText(), /^Banned for ads \(97\.2%\)\. Twitch accepted the ban\.$/);
  const scores = await sheet.locator('[data-decision-scores]').innerText();
  assert.match(scores, /Ads \/ sales\s+97\.2%/);
  assert.match(scores, /Spam \/ scams\s+62%/);
  assert.match(scores, /Safe\s+2%/);
  assert.match(scores, /Ban bar: 85%/);
  assert.equal(await sheet.locator('[data-decision-context]').evaluate((el) => el.open), false, 'chat before it starts collapsed');
  await sheet.locator('[data-decision-context] summary').click();
  await until(async () => (await sheet.locator('[data-decision-context] li.is-streamer').count()) === 1, 'streamer line marked');
  const cost = await sheet.locator('[data-decision-cost]').innerText();
  assert.match(cost, /Model\s+gpt-6-luna-decisions/);
  assert.doesNotMatch(cost, /openai\//, 'no provider prefix');
  assert.match(cost, /Provider cost\s+\$0\.0002/);
  assert.match(cost, /Charged to the channel\s+None: included review/);
  assert.match(cost, /Time taken\s+640 ms/);
  assert.match(await sheet.locator('[data-decision-history]').innerText(), /gg that was a clean run/);
  assert.match(await sheet.locator('[data-decision-verdict]').innerText(), /Your verdict is saved for tuning\. It changes nothing for the viewer\./);
  assert.equal(await sheet.locator('.dec-sheet__pos').innerText(), '1 of 30');

  // ---- Next / Previous ----
  await sheet.locator('[data-decision-next]').click();
  await until(() => query().get('open') === 'd2', 'next decision');
  await until(async () => (await sheet.locator('[data-decision-twitch]').count()) === 1, 'refused ban says what Twitch said');
  assert.match(await sheet.locator('[data-decision-twitch]').innerText(), /already banned/);
  assert.match(await sheet.locator('[data-decision-cost]').innerText(), /120 credits ≈ \$0\.0012/);
  await sheet.locator('[data-decision-prev]').click();
  await until(() => query().get('open') === 'd1', 'previous decision');
  assert.equal(await sheet.locator('[data-decision-prev]').isDisabled(), true, 'nothing before the first row');
  // Next/Previous cross into the neighbouring page.
  await goto('/ai/decisions?open=f17');
  await until(async () => (await sheet.locator('.dec-sheet__pos').count()) === 1 && (await sheet.locator('.dec-sheet__pos').innerText()) === '25 of 30', 'last row of page 1');
  await sheet.locator('[data-decision-next]').click();
  await until(() => query().get('page') === '2' && query().get('open') === 'f18', 'Next opens the first row of page 2');
  await until(async () => (await sheet.locator('blockquote').innerText()) === 'hello chat, first time here #18', 'page 2 decision shown');
  await sheet.locator('[data-decision-prev]').click();
  await until(() => query().get('page') === null && query().get('open') === 'f17', 'Previous returns to the last row of page 1');
  await goto('/ai/decisions?open=d1');
  await until(() => sheet.evaluate((el) => el.open), 'sheet open again');
  // The history switches the sheet to another decision.
  await sheet.locator('[data-decision-history] button', { hasText: 'buy gold' }).click();
  await until(() => query().get('open') === 'deep1', 'history row opens its decision');
  await until(async () => (await sheet.locator('[data-decision-what]').innerText()).startsWith('Timed out for ads'), 'history decision shown');
  await page.keyboard.press('Escape');
  await until(() => query().get('open') === null, 'Escape closes and clears the URL');

  // ---- Deep link to a decision that is not in the list ----
  await goto('/ai/decisions?open=deep1');
  await until(() => sheet.evaluate((el) => el.open), 'deep link opens the sheet');
  await until(async () => (await sheet.locator('blockquote').innerText()) === 'buy gold here cheap cheap', 'deep-linked message');
  assert.equal(await sheet.locator('[data-decision-next]').isDisabled(), true);
  assert.equal(await sheet.locator('[data-decision-prev]').isDisabled(), true);
  assert.equal(await sheet.locator('.dec-sheet__pos').count(), 0, 'no position for a decision that is not on the list');
  await goto('/ai/decisions?open=missing1');
  await until(async () => (await sheet.locator('[data-decision-load-error]').count()) === 1, 'missing decision says so');
  assert.match(await sheet.locator('[data-decision-load-error]').innerText(), /not found/);
  await page.keyboard.press('Escape');

  // ---- Verdicts ----
  await goto('/ai/decisions?open=d1');
  await sheet.locator('[data-decision-ban]').waitFor();
  const note = sheet.locator('[data-decision-note]');
  // The note limit: 500 characters, with a counter near it.
  await note.fill('x'.repeat(600));
  await until(async () => (await note.inputValue()).length === 500, 'note capped at 500');
  assert.equal(await sheet.locator('[data-decision-note-count]').innerText(), '500 / 500');
  await note.fill('Short note');
  assert.equal(await sheet.locator('[data-decision-note-count]').count(), 0, 'no counter on a short note');
  // A failed save keeps the note and says so.
  state.failPut = 1;
  await sheet.locator('[data-decision-ban]').click();
  await until(async () => (await sheet.locator('[data-decision-save-error]').count()) === 1, 'save error shown');
  assert.match(await sheet.locator('[data-decision-save-error]').innerText(), /not saved/);
  assert.equal(await note.inputValue(), 'Short note', 'note kept after a failed save');
  assert.deepEqual(puts.pop(), { id: 'd1', body: { label: 'violation', note: 'Short note' } });
  // Save "should be a ban".
  await note.fill('Classic follower seller');
  await sheet.locator('[data-decision-ban]').click();
  await until(async () => (await sheet.locator('[data-decision-said]').count()) === 1, 'verdict saved');
  assert.deepEqual(puts[puts.length - 1], { id: 'd1', body: { label: 'violation', note: 'Classic follower seller' } });
  assert.match(await sheet.locator('[data-decision-said]').innerText(), /You said: should be a ban[\s\S]*agrees with the bot[\s\S]*Classic follower seller/);
  assert.equal(await sheet.evaluate((el) => el.open), true, 'sheet stays open after saving');
  const firstRow = rows.first();
  await until(async () => (await firstRow.locator('[data-row-verdict]').count()) === 1, 'row shows the verdict without a reload');
  assert.match(await firstRow.locator('[data-row-verdict]').innerText(), /You agreed/);
  // Change it.
  await sheet.locator('[data-decision-change]').click();
  assert.equal(await note.inputValue(), 'Classic follower seller', 'the note is kept for a change');
  await sheet.locator('[data-decision-allow]').click();
  await until(async () => (await sheet.locator('[data-decision-said]').innerText()).includes('should not be a ban'), 'verdict changed');
  assert.deepEqual(puts[puts.length - 1], { id: 'd1', body: { label: 'allow', note: 'Classic follower seller' } });
  assert.match(await sheet.locator('[data-decision-said]').innerText(), /disagrees with the bot/);
  await until(async () => (await firstRow.locator('[data-row-verdict]').innerText()).includes("You didn't agree"), 'row follows the change');
  // Remove it.
  await sheet.locator('[data-decision-remove]').click();
  await until(async () => (await sheet.locator('[data-decision-ban]').count()) === 1, 'verdict removed');
  assert.deepEqual(puts[puts.length - 1], { id: 'd1', body: { label: null, note: null } });
  await until(async () => (await firstRow.locator('[data-row-verdict]').count()) === 0, 'row mark removed');
  await page.keyboard.press('Escape');

  // ---- Rows read right ----
  const rowText = async (id) => (await page.locator(`[data-decision-row][data-id="${id}"]`).innerText()).replace(/\s+/g, ' ');
  assert.match(await rowText('d2'), /Ban refused/);
  assert.match(await rowText('d2'), /quietfjord/);
  assert.match(await rowText('d2'), /120 credits ≈ \$0\.0012/);
  assert.match(await rowText('d3'), /Almost banned.*You agreed/);
  assert.match(await rowText('d4'), /Allowed/);
  assert.match(await rowText('d5'), /Not reviewed/);
  assert.match(await rowText('d6'), /Warned.*links rule/);
  assert.match(await rowText('d1'), /ads 97\.2%.*free review/);
  assert.match(await rowText('d7'), /Ghost_Viewer/);

  // ---- Only this viewer (and a viewer with no login) ----
  await page.locator('[data-decision-row][data-id="d7"]').click();
  await sheet.locator('[data-decision-only-viewer]').waitFor();
  await listAfter(() => sheet.locator('[data-decision-only-viewer]').click(), (p) => p.get('chatter') === '81007', 'only this viewer');
  await until(() => query().get('chatter') === '81007' && query().get('open') === null, 'viewer filter in URL');
  await until(async () => (await active.allInnerTexts()).some((text) => text.includes('Viewer: Ghost_Viewer')), 'viewer chip by name');
  await until(() => summaryCalls[summaryCalls.length - 1].get('chatter') === '81007', 'summary follows the viewer');

  // ---- Empty, then error + Retry ----
  await goto('/ai/decisions?chatterName=nobody_here');
  await page.locator('[data-decisions-empty]').waitFor();
  assert.match(await page.locator('[data-decisions-empty]').innerText(), /Nothing matches these filters in the last 7 days[\s\S]*Widen the range or clear the filters/);
  state.failList = 1;
  await goto('/ai/decisions?show=bans');
  await page.locator('[data-decisions-error][role="alert"]').waitFor();
  await listAfter(() => page.locator('[data-decisions-error]').getByRole('button', { name: 'Retry' }).click(), (p) => p.get('show') === 'bans', 'retry keeps filters');
  await rows.first().waitFor();
  state.failSummary = 1;
  await goto('/ai/decisions');
  await page.locator('[data-decisions-summary-error]').waitFor();
  await page.locator('[data-decisions-summary-error]').getByRole('button', { name: 'Retry' }).click();
  await answer.waitFor();

  // ---- The channel's Protection tab ----
  await goto('/channels/700001/protection');
  await until(() => lastList().get('channel') === '700001' && summaryCalls[summaryCalls.length - 1].get('channel') === '700001', 'fixed channel sent');
  await answer.waitFor();
  assert.match((await answer.innerText()).replace(/\s+/g, ' '), /Chat protection reviewed 585 of this channel's messages in the last 7 days: 3 banned/);
  assert.equal(await page.locator('app-channel-protection h1').count(), 0, 'the tab has no h1 of its own');
  assert.doesNotMatch(await rowText('d1'), /maplewave/, 'rows leave out the fixed channel');
  await listAfter(() => page.locator('[data-chip="bans"]').click(), (p) => p.get('channel') === '700001' && p.get('show') === 'bans', 'filters keep the channel');
  assert.equal(query().get('channel'), null, 'the fixed channel is not written to the URL');
  await page.locator('[data-decisions-filters]').click();
  await until(() => filterSheet.evaluate((el) => el.open), 'channel filters open');
  assert.equal(await filterSheet.getByLabel('Streamer').count(), 0, 'no streamer picker on a channel tab');
  await filterSheet.locator('[data-filter-done]').click();

  // ---- Layout, axe and touch targets, sheet closed and open ----
  // With the sheet open the rest of the page is inert (a modal dialog), so axe checks the sheet's page only.
  const axeCheck = async (label, sheetOpen = false) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    let builder = new AxeBuilder({ page }).include('app-decisions-page');
    if (!sheetOpen) builder = builder.include('app-navbar');
    const result = await builder.withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `${label} axe`);
  };
  const small = async (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && (box.height < 43.5 || box.width < 43.5);
  }).map((el) => `${el.className} ${el.textContent.trim().slice(0, 30)}`), selector);
  for (const mode of ['dark', 'light']) {
    await page.evaluate((m) => localStorage.setItem('dima-admin.mode.v1', m), mode);
    for (const width of [320, 390, 1280]) {
      const label = `${mode} ${width}`;
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await goto('/ai/decisions');
      await answer.waitFor();
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label} theme`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} overflow`);
      await axeCheck(label);
      assert.deepEqual(await small('.dx-chips .lf-chip, .dx-range label span, [data-decisions-filters], [data-decision-row], [data-page-next], [data-page-prev]'), [], `${label} touch targets`);
      await page.screenshot({ path: `${artifacts}/${mode}-${width}.png` });
      await rows.first().click();
      await until(() => sheet.evaluate((el) => el.open), `${label} sheet`);
      await sheet.locator('[data-decision-context]').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} overflow with the sheet`);
      assert.equal(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, `${label} sheet has no sideways scroll`);
      const box = await sheet.boundingBox();
      if (width < 640) assert.ok(Math.abs(box.y + box.height - (width === 1280 ? 900 : 844)) < 2, `${label} bottom sheet sits on the bottom edge`);
      else assert.ok(box.y > 0 && box.y + box.height < 900, `${label} centred card`);
      assert.deepEqual(await small('[data-decision-ban], [data-decision-allow], [data-decision-next], [data-decision-prev]'), [], `${label} sheet touch targets`);
      const foot = await sheet.locator('[data-decision-verdict]').boundingBox();
      assert.ok(foot.y + foot.height <= box.y + box.height + 1, `${label} verdict footer visible`);
      await axeCheck(`${label} sheet open`, true);
      await page.screenshot({ path: `${artifacts}/${mode}-${width}-sheet.png` });
      await page.keyboard.press('Escape');
    }
  }

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(unexpected, [], 'no unexpected requests');
  assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), [], 'no other API calls');
  console.log(`PASS admin decisions: answer (warn/ok), ${chips.length + 2} chips + 5 sheet filters + 4 sorts in request and URL, paging, sheet with scores/context/cost, Next/Previous, deep link, verdict save/change/remove/limit/failure, channel tab, empty, error + Retry, axe/overflow/touch at 320/390/1280 dark+light with the sheet closed and open`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
    console.error('URL:', page.url());
    console.error('Last list calls:', listCalls.slice(-3).map((p) => p.toString()));
  }
  throw error;
} finally {
  await browser.close();
}
