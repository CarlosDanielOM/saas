// Admin console AI pages: the AI hub (/ai) and the usage explorer (/ai/usage). Every API call is mocked; nothing
// reaches production. Run against a preview: SAAS_PREVIEW_URL=http://127.0.0.1:4310 node ops/checks/admin-console-ai-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-ai';
fs.mkdirSync(artifacts, { recursive: true });
const TOKEN = 'disposable-admin-console-ai-fixture';

// ---------- Fixtures (fictional names; shapes follow admin/src/app/services/*-api.service.ts) ----------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const day = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString().slice(0, 10);
const t = (count, credits, providerUSD = 0, providerKnown = 0) => ({ count, credits, providerUSD, providerKnown });
const CHANNELS = [
  { channelID: '700000001', channel: 'pixel_harbor', planTier: 'pro' },
  { channelID: '700000002', channel: 'luna_plays', planTier: 'premium' },
  { channelID: '700000003', channel: 'cozy_kiln', planTier: 'free' },
  { channelID: '700000004', channel: 'retro_orbit', planTier: 'free' },
  { channelID: '700000005', channel: 'night_owl_tv', planTier: 'premium' },
  { channelID: '700000006', channel: 'maple_and_moss', planTier: null },
];
const VIEWERS = [
  { id: '810000001', login: 'mossy_fern', name: 'Mossy_Fern' },
  { id: '810000002', login: 'quietcomet', name: 'QuietComet' },
  { id: '810000003', login: 'tiny_anvil', name: 'tiny_anvil' },
  { id: '810000004', login: 'saltwater_sam', name: 'Saltwater Sam' },
];

function usageSummary(params) {
  const category = params.get('category');
  const channel = params.get('channel');
  const actor = params.get('actor');
  const scale = (channel ? 0.3 : 1) * (actor ? 0.05 : 1) * (category === 'tts' ? 1 : category ? 0.1 : 1) * (params.get('model') ? 0.5 : 1) * (params.get('source') ? 0.6 : 1);
  const n = (value) => Math.round(value * scale);
  const byCategory = [
    { category: 'tts', ...t(n(7420), n(742300)) },
    { category: 'memory', ...t(n(310), n(88100), 0.881 * scale, n(310)) },
    { category: 'ai_chat', ...t(n(188), n(20400), 0.204 * scale, n(120)) },
    { category: 'other', ...t(n(143), n(4770), 0.05 * scale, n(143)) },
    { category: 'ai_agent', ...t(n(12), n(1300), 0.013 * scale, n(12)) },
  ].filter((row) => !category || row.category === category);
  const totals = byCategory.reduce((a, r) => ({ count: a.count + r.count, credits: a.credits + r.credits, providerUSD: a.providerUSD + r.providerUSD, providerKnown: a.providerKnown + r.providerKnown }), t(0, 0));
  let byChannel = CHANNELS.map((c, i) => ({ ...c, ...t(n(3000 / (i + 1)), n(300000 / (i + 1)), i === 0 ? 0.2 : 0, i === 0 ? n(40) : 0) }));
  if (channel) byChannel = byChannel.filter((row) => row.channelID === channel);
  let byActor = VIEWERS.map((v, i) => ({ actor: v, ...t(n(400 / (i + 1)), n(40000 / (i + 1))) }));
  if (actor) byActor = byActor.filter((row) => row.actor.id === actor);
  const byModel = [
    { category: 'tts', provider: 'fish', model: null, ...t(n(6900), n(700000)) },
    { category: 'tts', provider: 'kokoro', model: 'kokoro-82m', ...t(n(520), n(42300)) },
    { category: 'memory', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', ...t(n(310), n(88100), 0.881 * scale, n(310)) },
    { category: 'ai_chat', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', ...t(n(188), n(20400), 0.204 * scale, n(120)) },
  ].filter((row) => !category || row.category === category).filter((row) => !params.get('model') || row.model === params.get('model'));
  const bySource = [
    { category: 'tts', source: 'ast', ...t(n(5100), n(510000)) },
    { category: 'tts', source: 'redemption', ...t(n(1800), n(180000)) },
    { category: 'tts', source: 'voice_preview', ...t(n(520), n(52300)) },
    { category: 'memory', source: 'stream_summary', ...t(n(310), n(88100), 0.881 * scale, n(310)) },
    { category: 'ai_chat', source: 'chat', ...t(n(188), n(20400), 0.204 * scale, n(120)) },
    { category: 'other', source: 'moderation', ...t(n(143), n(4770), 0.05 * scale, n(143)) },
  ].filter((row) => !category || row.category === category).filter((row) => !params.get('source') || row.source === params.get('source'));
  const from = params.get('from');
  const days = Math.max(1, Math.round((NOW - new Date(from).getTime()) / 86_400_000));
  const daily = Array.from({ length: days }, (_, i) => ({ date: day(days - 1 - i), count: n(900 + ((i * 377) % 700)), credits: n(90000 + ((i * 37123) % 70000)), providerUSD: 0.1 }));
  const withActor = byActor.reduce((sum, row) => sum + row.count, 0);
  return { from, to: ago(0), totals: { ...totals, channels: channel ? 1 : 33, chatters: actor ? 1 : 4, withActor }, granted: 1_200_000, byCategory, byModel, bySource, byChannel, byActor, daily };
}
const emptySummary = () => ({ from: ago(10080), to: ago(0), totals: { ...t(0, 0), channels: 0, chatters: 0, withActor: 0 }, granted: 0, byCategory: [], byModel: [], bySource: [], byChannel: [], byActor: [], daily: [{ date: day(0), count: 0, credits: 0, providerUSD: 0 }] });

const USAGE_ROWS = Array.from({ length: 95 }, (_, i) => {
  const c = CHANNELS[i % 4];
  const voice = i % 5 !== 4;
  return {
    id: `rcpt-${i}`, at: ago(3 + i * 7), channelID: c.channelID, channel: c.channel, entryKind: 'usage',
    category: voice ? 'tts' : 'ai_chat', operation: voice ? 'synthesize' : 'final_response', source: voice ? 'ast' : 'chat', adjustmentType: null,
    provider: voice ? 'fish' : 'openrouter', model: voice ? null : 'deepseek/deepseek-v4.1-flash', voice: voice ? 'Dora' : null,
    quantity: voice ? 20 + i : 4000 + i * 13, unit: voice ? 'characters' : 'tokens', credits: voice ? (20 + i) * 1.5 : 30 + i,
    providerUSD: voice ? null : 0.0003, actor: i % 3 === 0 ? null : VIEWERS[i % 4],
  };
});
const ADJUSTMENTS = [
  { id: 'adj-1', at: ago(10), channelID: '700000003', channel: 'cozy_kiln', entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', source: 'admin_credit_grant', adjustmentType: 'manual_grant', provider: 'polar', model: null, voice: null, quantity: null, unit: null, credits: -800000, providerUSD: null, actor: null },
];
function transactions(params) {
  const kind = params.get('entryKind') || 'usage';
  let rows = kind === 'all' ? [...USAGE_ROWS, ...ADJUSTMENTS].sort((a, b) => b.at.localeCompare(a.at)) : USAGE_ROWS;
  for (const [key, field] of [['channel', 'channelID'], ['category', 'category'], ['model', 'model'], ['source', 'source'], ['provider', 'provider']]) {
    if (params.get(key)) rows = rows.filter((row) => row[field] === params.get(key));
  }
  if (params.get('actor')) rows = rows.filter((row) => row.actor?.id === params.get('actor'));
  if (params.get('sort') === 'credits') rows = [...rows].sort((a, b) => b.credits - a.credits);
  const limit = Number(params.get('limit') || 40);
  const start = Number(params.get('cursor') || 0);
  // The last page repeats one row of the page before, as a cursor race could: the page must not show it twice.
  const items = rows.slice(Math.max(0, start - (start ? 1 : 0)), start + limit);
  return { items, nextCursor: start + limit < rows.length ? String(start + limit) : null };
}
const decisionsSummary = (params) => ({
  from: params.get('from'), to: ago(0), total: 640, aiReviews: 585, ruleHits: 55, violations: 14, bans: 4, bansFailed: 1, notReviewed: 9, included: 520,
  providerUSD: 0.0931, credits: 6500, latencyP50Ms: 820, latencyP95Ms: 2400, channels: 21, labelled: 30, agree: 27, disagree: 3, verdictsWaiting: 12, daily: [],
  byModel: [{ model: 'openai/gpt-6-luna-decisions', reviews: 585, violations: 14, notReviewed: 9, providerUSD: 0.0931, latencyP50Ms: 820 }], byChannel: [],
});
const assistantSummary = (params) => ({
  from: params.get('from'), to: ago(0), daily: [],
  totals: { turns: 56, completed: 53, failed: 1, cancelled: 2, steps: 140, toolCalls: 90, promptTokens: 1, cachedTokens: 1, completionTokens: 1, providerUSD: 0.583, helpful: 4, unhelpful: 1, channels: 9, people: 11 },
  byLevel: [], byModel: [], byChannel: [], byTool: [], errors: [], refusals: { week: 3, total: 17 }, limitsToday: [], recordsSince: day(2),
});
const docsSummary = (params) => ({
  from: params.get('from'), to: ago(0), daily: [], totals: { asked: 12, answered: 11, failed: 1, abandoned: 0, toolCalls: 20, inputTokens: 1, outputTokens: 1, providerUSD: 0.112, helpful: 5, unhelpful: 1 },
  failures: [], byLang: [], topPages: [], medianDurationMs: 9000,
});
const overview = {
  generatedAt: ago(0), day: { from: ago(1440), to: ago(0), kinds: [], activeChannels: 38, credits: 131400, providerUSD: 0.43 }, daily: [],
  features: [
    { feature: 'voice', count: 7420, failed: 31, credits: 742300, providerUSD: null },
    { feature: 'memory', count: 310, failed: 0, credits: 88100, providerUSD: 0.881 },
    { feature: 'ai_chat', count: 188, failed: 2, credits: 20400, providerUSD: 0.204 },
  ],
  topChannels: [], attention: [{ key: 'verdicts_waiting', count: 12 }], recent: [], partial: [],
};
const userRows = CHANNELS.slice(0, 4).map((c) => ({ channelID: c.channelID, channel: c.channel, plan_tier: c.planTier || 'free', isLive: false, liveViewers: 0, actived: true }));

// ---------- Harness ----------
const fail = { usage: 0, transactions: 0, decisions: 0 };
let empty = false;
const seen = { usage: [], transactions: [], decisions: [], assistant: [], docs: [], overview: 0 };
const unexpected = [];
const otherCalls = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript((token) => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({
      version: 2, token, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' },
    }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
  }, TOKEN);
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
    const boom = () => json({ error: true, message: 'fixture failure', status: 500, data: null }, 500);
    const p = url.searchParams;
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname.startsWith('/admin-site/')) assert.equal(request.headers().authorization, `Bearer ${TOKEN}`);
    switch (url.pathname) {
      case '/admin-site/overview': seen.overview++; return ok(overview);
      case '/admin-site/usage/summary': seen.usage.push(p); if (fail.usage > 0) { fail.usage--; return boom(); } return ok(empty ? emptySummary() : usageSummary(p));
      case '/admin-site/usage/transactions': seen.transactions.push(p); if (fail.transactions > 0) { fail.transactions--; return boom(); } return ok(empty ? { items: [], nextCursor: null } : transactions(p));
      case '/admin-site/decisions/summary': seen.decisions.push(p); if (fail.decisions > 0) { fail.decisions--; return boom(); } return ok(decisionsSummary(p));
      case '/admin-site/assistant/summary': seen.assistant.push(p); return ok(assistantSummary(p));
      case '/admin-site/docs-assistant/summary': seen.docs.push(p); return ok(docsSummary(p));
      case '/admin-site/users': {
        const search = (p.get('search') || '').toLowerCase();
        const rows = userRows.filter((row) => row.channel.includes(search));
        return ok({ rows, pagination: { page: 1, limit: 6, total: rows.length, totalPages: 1 }, summary: {} });
      }
      default:
        otherCalls.push(`${request.method()} ${url.pathname}`);
        return json({ error: false, message: 'ok', status: 200, data: {} });
    }
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const until = async (check, label, tries = 120) => {
    for (let i = 0; i < tries; i++) { if (await check().catch(() => false)) return; await page.waitForTimeout(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const query = () => new URL(page.url()).searchParams;
  const textOf = (selector) => page.locator(selector).first().innerText();
  const hoursBack = (params) => (NOW - new Date(params.get('from')).getTime()) / 3_600_000;
  const area = (key) => page.locator(`[data-area="${key}"]`);
  const answer = page.locator('[data-hub-answer]');

  // ================= AI hub =================
  await page.goto(`${base}/ai`);
  await until(async () => /Streamers paid/.test(await answer.innerText()) && /Providers charged us \$/.test(await answer.innerText()), 'hub answer');
  const hubAnswer = await answer.innerText();
  // 856,870 credits in the fixture; provider = usage 1.148 − protection receipts 0.05 + reviews 0.0931 + assistant 0.583 + docs 0.112.
  assert.match(hubAnswer, /Streamers paid 856,870 credits \(≈ \$8\.57\) for AI in the last 7 days/);
  assert.match(hubAnswer, /Across 33 channels/);
  assert.match(hubAnswer, /Providers charged us \$1\.89 where recorded/);
  const reviewLink = page.locator('[data-hub-review]');
  assert.match(await reviewLink.innerText(), /Review 12 waiting messages/);
  assert.equal(await reviewLink.getAttribute('href'), '/moderation-review');

  const rowChecks = {
    protection: { href: '/ai/decisions', texts: [/585 reviews · 4 bans/, /9 couldn't be reviewed/, /1 ban Twitch refused/, /\$0\.093/, /provider cost/] },
    voice: { href: '/ai/usage?category=tts', texts: [/7,420 requests/, /742\.3K credits/, /≈ \$7\.42/, /31 failed in 7 days/] },
    chat: { href: '/ai/usage', texts: [/510 calls/, /109\.8K credits/, /≈ \$1\.10/, /2 failed in 7 days/] },
    assistant: { href: '/ai/assistant', texts: [/56 messages/, /1 failed/, /\$0\.583/] },
    docs: { href: '/ai/docs', texts: [/12 questions/, /5\s*helpful/, /1\s*unhelpful/, /1 question not answered/, /\$0\.112/] },
    review: { href: '/moderation-review', texts: [/Review queue/, /12 waiting/] },
    refusals: { href: '/assistant-refusals', texts: [/Assistant refusals/, /3 this week/] },
  };
  for (const [key, { href, texts }] of Object.entries(rowChecks)) {
    const text = await area(key).innerText();
    for (const pattern of texts) assert.match(text, pattern, `${key} row: ${pattern}`);
    const link = area(key).locator('a').first();
    assert.equal(await link.getAttribute('href'), href, `${key} row link`);
  }
  // Who spends the most and which models.
  const top = page.locator('[data-hub-top] a');
  assert.equal(await top.count(), 5);
  assert.equal(await top.first().getAttribute('href'), '/ai/usage?channel=700000001');
  assert.match(await top.first().innerText(), /pixel_harbor/);
  assert.equal(await page.locator('[data-hub-see-all]').getAttribute('href'), '/ai/usage?view=channels');
  const models = await textOf('[data-hub-models]');
  assert.match(models, /gpt-6-luna-decisions/);
  assert.doesNotMatch(models, /openai\//, 'model names drop the provider prefix');
  assert.match(models, /fish/);
  assert.match(models, /provider cost not recorded/);
  assert.match(await textOf('app-day-bars'), /credits/);

  // One summary failing leaves the others on screen, with a retry.
  fail.decisions = 1;
  await page.goto(`${base}/ai?range=24h`);
  await until(async () => /Didn't load/.test(await area('protection').innerText()), 'protection block fails alone');
  assert.match(await area('voice').innerText(), /requests/, 'voice still visible');
  assert.match(await area('assistant').innerText(), /messages/, 'assistant still visible');
  await until(async () => /not counting chat protection/.test(await answer.innerText()), 'answer says which part is missing');
  await area('protection').getByRole('button', { name: 'Retry chat protection' }).click();
  await until(async () => /585 reviews/.test(await area('protection').innerText()), 'retry loads chat protection');
  assert.ok(hoursBack(seen.decisions.at(-1)) > 23.5 && hoursBack(seen.decisions.at(-1)) < 24.5, 'retry keeps the range');

  // Changing the range asks every summary again with a new `from`, and the URL follows.
  const before = { usage: seen.usage.length, decisions: seen.decisions.length, assistant: seen.assistant.length, docs: seen.docs.length };
  await page.locator('.hub-range').getByText('30d').click();
  await until(async () => query().get('range') === '30d', 'range in URL');
  await until(async () => seen.usage.length > before.usage && seen.decisions.length > before.decisions && seen.assistant.length > before.assistant && seen.docs.length > before.docs, 'every summary re-requested');
  for (const key of ['usage', 'decisions', 'assistant', 'docs']) {
    const hours = hoursBack(seen[key].at(-1));
    assert.ok(hours > 719 && hours < 721, `${key} asked for 30 days, got ${hours} h`);
  }
  await until(async () => /in the last 30 days/.test(await answer.innerText()), 'answer names the new range');
  assert.equal(await area('voice').locator('a').getAttribute('href'), '/ai/usage?range=30d&category=tts', 'links keep the range');

  // ================= Usage explorer =================
  const usageAnswer = page.locator('[data-usage-answer]');
  const lastUsage = () => seen.usage.at(-1);
  await page.goto(`${base}/ai/usage`);
  await until(async () => /charged calls/.test(await usageAnswer.innerText()), 'usage answer');
  assert.match(await usageAnswer.innerText(), /8,073 charged calls in the last 7 days across 33 channels: 856,870 credits \(≈ \$8\.57\)\./);
  assert.match(await usageAnswer.innerText(), /Providers charged us \$1\.15 for the 585 of these calls where it is recorded/);
  assert.match(await textOf('[data-usage-granted]'), /1\.2M credits ≈ \$12\.00 were added in this range \(plan credits, packs, grants\)/);
  assert.equal(await page.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected'), 'true', 'channels is the default view');
  const rows = page.locator('[data-usage-row]');
  assert.equal(await rows.count(), 6);
  assert.match(await rows.first().innerText(), /pixel_harbor[\s\S]*Pro[\s\S]*35% of credits · \$0\.20 provider cost \(40 calls\)[\s\S]*300,000 credits[\s\S]*≈ \$3\.00/);
  assert.doesNotMatch(await rows.nth(1).innerText(), /provider/, 'no provider cost when none is recorded');

  // Range.
  await page.locator('.ux-range').getByText('24h').click();
  await until(async () => query().get('range') === '24h' && hoursBack(lastUsage()) < 24.5, 'range 24h → URL + request');
  assert.match(await usageAnswer.innerText(), /in the last 24 hours/);

  // Feature chip: request + URL + answer limited to it, other chips keep their counts.
  await page.locator('[data-usage-chip="tts"]').click();
  await until(async () => query().get('category') === 'tts' && lastUsage().get('category') === 'tts', 'voice chip → URL + request');
  await until(async () => /Limited to voice\./.test(await usageAnswer.innerText()), 'answer says it is limited to voice');
  assert.equal(await page.locator('[data-usage-chip="tts"]').getAttribute('aria-pressed'), 'true');
  await until(async () => /8,073|8\.1K/.test(await page.locator('[data-usage-chip="all"]').innerText()), 'All chip keeps the full count');

  // Streamer through the picker in the sheet.
  await page.locator('[data-usage-open-sheet]').click();
  const sheet = page.locator('[data-usage-sheet]');
  await until(() => sheet.evaluate((el) => el.open), 'sheet opens');
  await sheet.getByLabel('Streamer').fill('pixel');
  await sheet.getByRole('button', { name: /pixel_harbor/ }).click();
  await until(async () => query().get('channel') === '700000001' && lastUsage().get('channel') === '700000001', 'streamer → URL + request');
  await until(async () => /pixel_harbor/.test(await sheet.innerText()), 'sheet shows the active streamer');
  // Model and source as selects filled from the summary.
  await sheet.getByLabel('Where it came from').selectOption('redemption');
  await until(async () => query().get('source') === 'redemption' && lastUsage().get('source') === 'redemption', 'source → URL + request');
  assert.match(await sheet.getByLabel('Where it came from').innerText(), /Rewards/);
  await sheet.getByLabel('Model').selectOption('kokoro-82m');
  await until(async () => query().get('model') === 'kokoro-82m' && lastUsage().get('model') === 'kokoro-82m', 'model → URL + request');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await until(async () => !(await sheet.evaluate((el) => el.open)), 'sheet closes');
  assert.match(await page.locator('[data-usage-open-sheet]').innerText(), /3/, 'filter badge counts the sheet filters');
  await until(async () => /streamer pixel_harbor/.test(await usageAnswer.innerText()) && /source “Rewards”/.test(await usageAnswer.innerText()), 'answer names the filters');
  assert.equal(await page.locator('[data-usage-open-channel]').getAttribute('href'), '/channels/700000001/usage');
  // Removable chips.
  await page.locator('[data-usage-active="model"]').click();
  await until(async () => !query().has('model') && !lastUsage().has('model'), 'model chip removed');
  await page.locator('[data-usage-active="source"]').click();
  await until(async () => !query().has('source'), 'source chip removed');

  // Viewers: coverage and tap-to-filter.
  await page.goto(`${base}/ai/usage?view=viewers`);
  await until(async () => (await page.locator('[data-usage-coverage]').count()) === 1, 'viewer coverage');
  assert.match(await textOf('[data-usage-coverage]'), /Viewer known for 833 of 8,073 calls/);
  await page.locator('[data-usage-row]').filter({ hasText: 'Mossy_Fern' }).locator('button').click();
  await until(async () => query().get('actor') === '810000001' && lastUsage().get('actor') === '810000001', 'viewer → URL + request');
  await until(async () => (await page.locator('[data-usage-row-link]').count()) === 1, 'offers everything from this viewer');
  assert.equal(await page.locator('[data-usage-row-link]').getAttribute('href'), '/activity?actor=810000001');
  assert.equal(await page.locator('[data-usage-viewer-activity]').getAttribute('href'), '/activity?actor=810000001');
  await page.locator('[data-usage-open-sheet]').click();
  await until(async () => /Mossy_Fern/.test(await sheet.innerText()), 'sheet shows the active viewer');
  await sheet.getByRole('button', { name: 'Remove' }).click();
  await until(async () => !query().has('actor'), 'viewer cleared in the sheet');
  await sheet.getByRole('button', { name: 'Close filters' }).click();

  // Channel row tap sets the channel filter and offers the channel workspace.
  await page.getByRole('tab', { name: 'Channels' }).click();
  await until(async () => query().get('view') === null && (await rows.count()) === 6, 'channels view');
  await rows.filter({ hasText: 'luna_plays' }).locator('button').click();
  await until(async () => query().get('channel') === '700000002', 'channel row → filter');
  await until(async () => (await page.locator('[data-usage-row-link]').getAttribute('href')) === '/channels/700000002/usage', 'open channel link');

  // Models and days.
  await page.getByRole('tab', { name: 'Models' }).click();
  await until(async () => query().get('view') === 'models' && /kokoro-82m/.test(await textOf('[data-usage-panel]')), 'models view');
  assert.match(await textOf('[data-usage-panel]'), /deepseek-v4\.1-flash/);
  assert.doesNotMatch(await textOf('[data-usage-panel]'), /deepseek\/deepseek/);
  await page.getByRole('tab', { name: 'Days' }).click();
  await until(async () => query().get('view') === 'days' && (await page.locator('[data-usage-day]').count()) === 7, 'days view: one row per day');

  // Every call: paging without duplicates, sort, credit changes.
  await page.goto(`${base}/ai/usage?view=calls`);
  const calls = page.locator('[data-usage-call]');
  await until(async () => (await calls.count()) === 40, 'first page of calls');
  assert.match(await calls.first().innerText(), /Voice · fish · 20 characters/);
  await page.locator('[data-usage-more]').click();
  await until(async () => (await calls.count()) === 80, 'second page');
  assert.equal(seen.transactions.at(-1).get('cursor'), '40');
  await page.locator('[data-usage-more]').click();
  await until(async () => (await calls.count()) === 95, 'last page');
  const ids = await calls.evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  assert.equal(new Set(ids).size, ids.length, 'no duplicate rows after paging');
  assert.match(await textOf('[data-usage-panel]'), /That is every call that matches/);
  // Null provider cost reads "not recorded".
  await calls.first().locator('summary').click();
  await until(async () => /not recorded/.test(await calls.first().locator('[data-usage-provider]').innerText()), 'null provider cost');
  assert.match(await calls.first().innerText(), /Channel\s*pixel_harbor/);
  assert.equal(await calls.first().locator('a').first().getAttribute('href'), '/channels/700000001');
  await calls.nth(1).locator('summary').click();
  assert.equal(await calls.nth(1).getByRole('link', { name: 'QuietComet' }).getAttribute('href'), '/activity?actor=810000002');
  // Sort.
  await page.getByRole('button', { name: 'Most expensive' }).click();
  await until(async () => query().get('sort') === 'credits' && seen.transactions.at(-1).get('sort') === 'credits', 'sort → URL + request');
  await until(async () => (await calls.first().getAttribute('data-id')) === 'rcpt-93', 'most expensive first');
  assert.equal(seen.transactions.at(-1).get('cursor'), null, 'a new sort starts from the first page');
  await page.getByRole('button', { name: 'Newest' }).click();
  await until(async () => !query().has('sort'), 'newest is the default');
  // Credit changes.
  await page.locator('[data-usage-kinds]').check();
  await until(async () => query().get('kinds') === 'all' && seen.transactions.at(-1).get('entryKind') === 'all', 'credit changes → URL + request');
  await until(async () => /\+800,000 credits/.test(await textOf('[data-usage-panel]')), 'grant shows with a plus sign');
  await page.locator('[data-usage-kinds]').uncheck();
  await until(async () => !query().has('kinds') && seen.transactions.at(-1).get('entryKind') === null, 'credit changes off');

  // Deep link restores everything.
  await page.goto(`${base}/ai/usage?category=tts&range=7d&view=calls`);
  await until(async () => (await calls.count()) === 40, 'deep link loads calls');
  assert.equal(await page.getByRole('tab', { name: 'Every call' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-usage-chip="tts"]').getAttribute('aria-pressed'), 'true');
  assert.equal(seen.transactions.at(-1).get('category'), 'tts');
  assert.ok(Math.abs(hoursBack(seen.transactions.at(-1)) - 168) < 0.5, 'deep link range');
  assert.equal(await page.locator('.ux-range input:checked').evaluate((el) => el.nextElementSibling.textContent.trim()), '7d');

  // Empty.
  empty = true;
  await page.goto(`${base}/ai/usage?category=memory`);
  await until(async () => (await page.locator('[data-usage-empty]').count()) === 1, 'empty state');
  assert.match(await textOf('[data-usage-empty]'), /Nothing was charged with these filters[\s\S]*Widen the range or clear the filters/);
  await page.goto(`${base}/ai/usage?view=calls`);
  await until(async () => (await page.locator('[data-usage-calls-empty]').count()) === 1, 'empty calls');
  empty = false;

  // Errors + Retry, filters kept.
  fail.usage = 1;
  await page.goto(`${base}/ai/usage?range=30d`);
  await until(async () => (await page.locator('[data-usage-error]').count()) === 1, 'summary error');
  await page.locator('[data-usage-error]').getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await rows.count()) > 0, 'retry loads');
  assert.ok(hoursBack(lastUsage()) > 719, 'retry keeps the filters');
  fail.transactions = 1;
  await page.getByRole('tab', { name: 'Every call' }).click();
  await until(async () => (await page.locator('[data-usage-calls-error]').count()) === 1, 'calls error');
  await page.locator('[data-usage-calls-error]').getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await calls.count()) === 40, 'calls retry');

  // Layout and accessibility, dark first.
  for (const mode of ['dark', 'light']) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      for (const [path, host, ready, targets] of [
        ['/ai', 'app-ai-hub-page', '[data-hub-models]', '.hub-range span, .hub-area__link, .hub-small__row, .hub-see'],
        ['/ai/usage?view=viewers', 'app-usage-page', '[data-usage-coverage]', '.ux-range span, .ux-filters, .ux-chips .lf-chip, .lf-tab, [data-usage-row] button'],
        ['/ai/usage?view=calls&channel=700000001', 'app-usage-page', '[data-usage-call]', '.uc-sort .lf-chip, .uc-kinds, [data-usage-call] summary, [data-usage-active], [data-usage-open-channel]'],
      ]) {
        await page.goto(`${base}${path}`);
        await page.locator(ready).first().waitFor({ timeout: 30000 });
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${mode} ${width} ${path}: overflow`);
        for (const target of await page.locator(targets).all()) {
          const box = await target.boundingBox();
          if (box) assert.ok(box.height >= 43.5, `${mode} ${width} ${path}: touch target ${await target.evaluate((el) => el.className)} is ${box.height}px`);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        const axe = await new AxeBuilder({ page }).include(host).include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `${mode} ${width} ${path}: axe`);
        await page.screenshot({ path: `${artifacts}/${mode}-${width}-${path.replace(/[^a-z0-9]+/gi, '_')}.png` });
      }
      // The filter sheet too.
      if (width !== 1280 || mode === 'dark') {
        await page.goto(`${base}/ai/usage?channel=700000001`);
        await page.locator('[data-usage-row]').first().waitFor();
        await page.locator('[data-usage-open-sheet]').click();
        await until(() => page.locator('[data-usage-sheet]').evaluate((el) => el.open), 'sheet open for axe');
        await page.waitForTimeout(300);
        const axe = await new AxeBuilder({ page }).include('app-usage-filter-sheet').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `${mode} ${width} sheet: axe`);
        await page.screenshot({ path: `${artifacts}/${mode}-${width}-sheet.png` });
      }
    }
  }

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(unexpected, [], 'no unexpected requests');
  assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), [], 'no other API calls');
  console.log('PASS admin console AI: hub answer + five areas with numbers and links, review action, one failing block with retry, range re-requests every summary; usage explorer answer, granted line, range / feature chip / streamer picker / viewer tap / model + source sheet filters in URL and request, removable chips, channels / viewers (coverage) / models / days / every call, paging without duplicates, sort, credit changes, null provider cost, deep link, empty and error states, 320/390/1280 dark + light layout, touch targets and axe');
} catch (error) {
  if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
