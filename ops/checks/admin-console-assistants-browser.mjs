// Admin "Dima assistant" (/ai/assistant) and "Docs AI" (/ai/docs) pages. Every API call is mocked (on both
// api.domdimabot.com and localhost:3000); nothing reaches production and the pages make no writes.
// Covers: the answer lines (ok, warn, per channel, empty), ranges re-requesting with a new `from`, every chip and
// sort changing the request and the URL, the channel filter from the Channels block and from the Filters sheet,
// today's limit rows, question-first rows, the fallback chip, the exchange sheet (message, steers, tool arguments
// and results, answer as text, never HTML), its error + Retry and cache, `?open=` deep links, "Only this person",
// `recordsSince` note and empty state, docs answers with sources/failed questions/"not helpful" shortcut, empty
// and error states with Retry, and no overflow + axe + touch targets at 320/390/1280 px in dark then light.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-assistants';
fs.mkdirSync(artifacts, { recursive: true });
const TOKEN = 'disposable-assistants-fixture';
const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const XSS = '<img src=x onerror="window.__xss=1">';

// ---------------------------------------------------------------------------------------------------------------
// Dima assistant fixtures (fictional channels and people)
// ---------------------------------------------------------------------------------------------------------------
const CH = {
    luna: { channelID: '710000001', channel: 'luna_plays', plan: 'premium' },
    pixel: { channelID: '710000002', channel: 'pixelmonk', plan: 'pro' },
    sol: { channelID: '710000003', channel: 'sol_rides', plan: 'free' },
    kaito: { channelID: '710000004', channel: 'kaito_live', plan: 'free' },
};
const PEOPLE = {
    mia: { id: '810000001', login: 'mia_torres', name: 'Mia Torres', role: 'owner' },
    rafa: { id: '810000002', login: 'rafa_quinn', name: 'Rafa Quinn', role: 'admin' },
    sol: { id: '810000003', login: 'sol_rides', name: 'Sol Ridley', role: 'owner' },
    kai: { id: '810000004', login: 'kaito_live', name: 'Kaito', role: 'owner' },
};
const tool = (name, state, ms, approval = null) => ({ name, state, ms, approval });
const turn = (id, at, ch, user, extra) => ({
    id, at: ago(at), channelID: ch.channelID, channel: ch.channel, user, plan: ch.plan, level: 'standard', fellBack: false,
    models: ['openai/gpt-6-luna'], status: 'completed', errorCode: null, lang: 'en', pageRoute: `/${ch.channel}/dashboard`, steps: 2,
    question: null, textKept: true, tools: [], units: 1, promptTokens: 9_400, cachedTokens: 6_100, completionTokens: 380, providerUSD: 0.0091,
    durationMs: 6_400, activeMs: 6_100, feedback: null, ...extra,
});
const TURNS = [
    turn('t1', 4 * MIN, CH.luna, PEOPLE.mia, { level: 'expert', models: ['anthropic/claude-haiku-5-5'], question: 'How do I make a !hug command that tags whoever I mention?', steps: 3,
        tools: [tool('read_docs', 'done', 420), tool('create_command', 'done', 910, 'applied')], units: 2, providerUSD: 0.0214, durationMs: 18_200, activeMs: 9_300, feedback: 'helpful', pageRoute: '/luna_plays/dashboard/commands' }),
    turn('t2', 38 * MIN, CH.pixel, PEOPLE.rafa, { status: 'failed', errorCode: 'model_timeout', question: 'Add a timer that posts the Discord link every 20 minutes', steps: 2,
        tools: [tool('list_timers', 'done', 120), tool('create_timer', 'error', 3_100)], providerUSD: 0.0062, durationMs: 61_000, activeMs: 61_000 }),
    turn('t3', 2 * HOUR, CH.sol, PEOPLE.sol, { status: 'cancelled', question: null, steps: 1, providerUSD: 0.0011, durationMs: 2_100, activeMs: 2_100 }),
    turn('t4', 5 * HOUR, CH.luna, PEOPLE.mia, { level: 'expert', fellBack: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'], question: 'Why did my song request command stop answering?',
        tools: [tool('get_settings', 'done', 160), tool('update_settings', 'denied', null), tool('navigate', 'done', 20)], units: 2, providerUSD: 0.0143, durationMs: 12_800, feedback: 'unhelpful' }),
    turn('t5', 26 * HOUR, CH.kaito, PEOPLE.kai, { question: '¿Cómo pongo las alertas de bits en OBS?', lang: 'es', tools: [tool('navigate', 'done', 30)] }),
    turn('t6', 3 * DAY, CH.pixel, PEOPLE.rafa, { status: 'interrupted', errorCode: 'interrupted', question: 'Make a poll for the next game', tools: [tool('create_poll', 'interrupted', null)] }),
];
const DETAIL = {
    t1: { message: 'How do I make a !hug command that tags whoever I mention? Like "!hug @friend" and the bot says "Mia hugs @friend".', steers: ['Make it work for mods only'],
        answer: `Done! I made **!hug** for mods only.\n\n- Type \`!hug @friend\`\n- The bot replies: "Mia hugs @friend"\n\n${XSS}`,
        tools: [{ ...TURNS[0].tools[0], args: '{"query":"command variables $(touser)"}', result: 'Found 3 pages: Variables, Commands, Permissions' },
            { ...TURNS[0].tools[1], args: '{"name":"hug","response":"$(user) hugs $(touser)","permission":"mods"}', result: `{"ok":true,"id":"cmd_91"} ${XSS}` }] },
    t2: { message: 'Add a timer that posts the Discord link every 20 minutes', steers: [], answer: null,
        tools: [{ ...TURNS[1].tools[0], args: '{}', result: '[]' }, { ...TURNS[1].tools[1], args: '{"minutes":20}', result: null }] },
    t4: { message: 'Why did my song request command stop answering?', steers: ['It was working yesterday', 'Now nothing happens'], answer: 'Song requests are turned off in Settings. Turn them back on under Music.',
        tools: TURNS[3].tools.map((t) => ({ ...t, args: '{"section":"music"}', result: t.state === 'denied' ? null : '{"songRequests":false}' })) },
};
const days = (n, fill) => Array.from({ length: n }, (_, i) => {
    const date = new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10);
    return { date, turns: 0, completed: 0, failed: 0, cancelled: 0, steps: 0, toolCalls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, providerUSD: 0, helpful: 0, unhelpful: 0, ...fill(i, n) };
});
function assistantSummary(url) {
    const fromMs = Date.parse(url.searchParams.get('from') || ago(30 * DAY));
    const n = Math.max(1, Math.round((NOW - fromMs) / DAY) + 1);
    const warn = state.summary === 'warn';
    const totals = warn ? { turns: 56, completed: 48, failed: 7, cancelled: 1 } : { turns: 56, completed: 54, failed: 1, cancelled: 1 };
    const daily = days(n, (i) => (i >= n - 8 ? { turns: 7, completed: 7, providerUSD: 0.0725 } : {}));
    daily[n - 1] = { ...daily[n - 1], failed: totals.failed, cancelled: totals.cancelled, completed: 7 - totals.failed - totals.cancelled };
    const empty = state.summary === 'empty';
    const channel = url.searchParams.get('channel');
    const byChannel = [
        { ...CH.luna, turns: 24, failed: 0, cancelled: 0, units: 41, providerUSD: 0.29, lastAt: ago(4 * MIN) },
        { ...CH.pixel, turns: 18, failed: warn ? 6 : 1, cancelled: 1, units: 18, providerUSD: 0.17, lastAt: ago(38 * MIN) },
        { ...CH.sol, turns: 9, failed: 0, cancelled: 0, units: 9, providerUSD: 0.07, lastAt: ago(2 * HOUR) },
        { ...CH.kaito, turns: 5, failed: warn ? 1 : 0, cancelled: 0, units: 5, providerUSD: 0.05, lastAt: ago(26 * HOUR) },
    ].filter((row) => !channel || row.channelID === channel);
    const limits = [
        { channelID: CH.luna.channelID, channel: CH.luna.channel, used: 78, limit: 80 },
        { channelID: CH.pixel.channelID, channel: CH.pixel.channel, used: 40, limit: 400 },
        { channelID: CH.sol.channelID, channel: CH.sol.channel, used: 3, limit: 20 },
    ].filter((row) => !channel || row.channelID === channel);
    return {
        from: new Date(fromMs).toISOString(), to: new Date(NOW).toISOString(),
        daily: empty ? days(n, () => ({})) : daily,
        totals: empty ? { ...Object.fromEntries(Object.keys(daily[0]).filter((k) => k !== 'date').map((k) => [k, 0])), channels: 0, people: 0 }
            : { ...totals, steps: 140, toolCalls: 88, promptTokens: 520_000, cachedTokens: 340_000, completionTokens: 21_000, providerUSD: 0.58, helpful: 3, unhelpful: 1, channels: 4, people: 5 },
        byLevel: empty ? [] : [{ level: 'expert', turns: 14, failed: warn ? 2 : 0, providerUSD: 0.26, avgDurationMs: 14_100 }, { level: 'standard', turns: 42, failed: warn ? 5 : 1, providerUSD: 0.32, avgDurationMs: 6_900 }],
        byModel: empty ? [] : [{ model: 'openai/gpt-6-luna', turns: 44, providerUSD: 0.34 }, { model: 'anthropic/claude-haiku-5-5', turns: 14, providerUSD: 0.24 }],
        byChannel: empty ? [] : byChannel,
        byTool: empty ? [] : [{ name: 'navigate', calls: 31, failed: 0 }, { name: 'create_command', calls: 12, failed: 1 }, { name: 'read_docs', calls: 19, failed: 0 }, { name: 'create_timer', calls: 6, failed: 2 },
            { name: 'list_commands', calls: 9, failed: 0 }, { name: 'update_settings', calls: 4, failed: 1 }, { name: 'create_poll', calls: 2, failed: 1 }],
        errors: empty ? [] : warn ? [{ code: 'model_timeout', count: 4, lastAt: ago(38 * MIN) }, { code: 'model_overloaded', count: 2, lastAt: ago(DAY) }, { code: 'interrupted', count: 1, lastAt: ago(3 * DAY) }]
            : [{ code: 'model_timeout', count: 1, lastAt: ago(38 * MIN) }],
        refusals: { week: empty ? 0 : 3, total: 9 },
        limitsToday: empty ? [] : limits,
        recordsSince: state.recordsSince,
    };
}
function assistantTurns(url) {
    const p = url.searchParams;
    let rows = TURNS.filter((row) => (!p.get('channel') || row.channelID === p.get('channel')) && (!p.get('user') || row.user.id === p.get('user'))
        && (!p.get('level') || row.level === p.get('level'))
        && (!p.get('status') || (p.get('status') === 'problems' ? ['failed', 'interrupted'].includes(row.status) : row.status === p.get('status'))));
    if (p.get('sort') === 'cost') rows = [...rows].sort((a, b) => b.providerUSD - a.providerUSD);
    if (p.get('sort') === 'slowest') rows = [...rows].sort((a, b) => b.durationMs - a.durationMs);
    if (state.turns === 'empty') rows = [];
    return { rows, pagination: { page: Number(p.get('page') || 1), limit: 25, total: rows.length, totalPages: rows.length ? 1 : 0 } };
}

// ---------------------------------------------------------------------------------------------------------------
// Docs AI fixtures
// ---------------------------------------------------------------------------------------------------------------
const answerRow = (id, at, extra) => ({ id, at: ago(at), lang: 'en', page: '/en/commands/', turn: 1, question: '', answer: '', sources: [], tools: [], rounds: 1,
    durationMs: 5_200, inputTokens: 4_100, outputTokens: 310, providerUSD: 0.0098, stopReason: 'end_turn', feedback: null, failed: null, ...extra });
const DOCS = [
    answerRow('d1', 12 * MIN, { question: 'How do I add a cooldown to a command so viewers cannot spam it?', answer: `Open **Commands**, edit the command and set *Cooldown*.\n\n1. Global cooldown\n2. Per-user cooldown\n\n${XSS}`,
        sources: ['https://docs.domdimabot.com/en/commands/cooldowns/', 'javascript:alert(1)'], tools: ['search_docs', 'read_page'], rounds: 2, feedback: 'helpful' }),
    answerRow('d2', 40 * MIN, { lang: 'es', page: '/es/tts/', question: '¿Cómo cambio la voz del TTS para los bits?', answer: 'Ve a Voz → Voces y elige una voz para los bits.', sources: ['https://docs.domdimabot.com/es/tts/voces/'], tools: ['search_docs'], feedback: 'unhelpful' }),
    answerRow('d3', 3 * HOUR, { question: 'And what about subscribers?', turn: 2, answer: 'Subscribers use the same cooldown settings.', stopReason: 'max_tokens' }),
    answerRow('d4', 6 * HOUR, { question: 'Can the bot read donations from another site?', answer: '', failed: 'timeout', stopReason: 'timeout', providerUSD: 0, inputTokens: 0, outputTokens: 0, durationMs: 30_000, rounds: null }),
    answerRow('d5', 2 * DAY, { lang: 'es', page: null, question: '¿El bot funciona en YouTube?', answer: 'No, DomDimaBot funciona solo con Twitch.', feedback: 'helpful' }),
];
delete DOCS[4].failed; // an older API response without the field must read as answered
function docsSummary(url) {
    const fromMs = Date.parse(url.searchParams.get('from') || ago(30 * DAY));
    const n = Math.max(1, Math.round((NOW - fromMs) / DAY) + 1);
    const empty = state.docsSummary === 'empty';
    const unhelpful = state.docsSummary === 'unhelpful' ? 2 : 0;
    const failed = state.docsSummary === 'unhelpful' ? 1 : 0;
    const daily = Array.from({ length: n }, (_, i) => ({ date: new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10), asked: 0, answered: 0, failed: 0, abandoned: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, providerUSD: 0, helpful: 0, unhelpful: 0 }));
    if (!empty) daily[n - 1] = { ...daily[n - 1], asked: 47, answered: 44 - failed, failed, abandoned: 3, providerUSD: 0.47, helpful: 3, unhelpful };
    const { date: _d, ...totals } = daily[n - 1];
    return { from: new Date(fromMs).toISOString(), to: new Date(NOW).toISOString(), daily, totals: empty ? { ...totals, asked: 0 } : totals,
        failures: failed ? [{ reason: 'timeout', count: 1 }] : [],
        byLang: empty ? [] : [{ lang: 'en', answers: 30 }, { lang: 'es', answers: 14 }],
        topPages: empty ? [] : [{ page: '/en/commands/', answers: 12 }, { page: '/es/tts/', answers: 7 }, { page: '/en/', answers: 4 }], medianDurationMs: empty ? 0 : 5_900 };
}
function docsAnswers(url) {
    const p = url.searchParams;
    let rows = DOCS.filter((row) => (!p.get('lang') || row.lang === p.get('lang'))
        && (!p.get('feedback') || (p.get('feedback') === 'none' ? row.feedback === null : row.feedback === p.get('feedback'))));
    if (p.get('sort') === 'cost') rows = [...rows].sort((a, b) => b.providerUSD - a.providerUSD);
    if (p.get('sort') === 'slowest') rows = [...rows].sort((a, b) => b.durationMs - a.durationMs);
    if (state.docsAnswers === 'empty') rows = [];
    return { rows, pagination: { page: 1, limit: 20, total: rows.length, totalPages: rows.length ? 1 : 0 } };
}

// ---------------------------------------------------------------------------------------------------------------
const state = { summary: 'ok', turns: 'ok', recordsSince: ago(5 * DAY), fail: new Set(), docsSummary: 'ok', docsAnswers: 'ok' };
const seen = { summary: [], turns: [], detail: [], docsSummary: [], docsAnswers: [] };
const unexpected = [], otherCalls = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3000');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript((token) => {
        localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
            twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' }, appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
        if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
        window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
    }, TOKEN);
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
        if (!isApi(url)) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(status === 200 ? { error: false, status, message: 'ok', data } : { error: true, status, message: data }) });
        if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        const mine = /^\/admin-site\/(assistant|docs-assistant)\//.test(url.pathname);
        if (mine) assert.equal(request.headers().authorization, `Bearer ${TOKEN}`);
        const fail = (key) => { if (state.fail.has(key)) { state.fail.delete(key); return true; } return false; };
        if (url.pathname === '/admin-site/assistant/summary') { seen.summary.push(url.searchParams); return fail('summary') ? json('fixture failure', 500) : json(assistantSummary(url)); }
        if (url.pathname === '/admin-site/assistant/turns') { seen.turns.push(url.searchParams); return fail('turns') ? json('fixture failure', 500) : json(assistantTurns(url)); }
        const detail = /^\/admin-site\/assistant\/turns\/([\w-]+)$/.exec(url.pathname);
        if (detail) {
            seen.detail.push(detail[1]);
            if (fail('detail')) return json('fixture failure', 500);
            const row = TURNS.find((t) => t.id === detail[1]);
            if (!row) return json('Not found', 404);
            const extra = DETAIL[row.id] ?? { message: row.question, steers: [], answer: row.status === 'completed' ? 'Okay, done.' : null, tools: row.tools.map((t) => ({ ...t, args: null, result: null })) };
            const { question: _q, ...rest } = row;
            return json({ ...rest, question: row.question, ...extra });
        }
        if (url.pathname === '/admin-site/docs-assistant/summary') { seen.docsSummary.push(url.searchParams); return fail('docsSummary') ? json('fixture failure', 500) : json(docsSummary(url)); }
        if (url.pathname === '/admin-site/docs-assistant/answers') { seen.docsAnswers.push(url.searchParams); return fail('docsAnswers') ? json('fixture failure', 500) : json(docsAnswers(url)); }
        if (url.pathname === '/admin-site/users') {
            const search = (url.searchParams.get('search') || '').toLowerCase();
            const rows = Object.values(CH).filter((c) => c.channel.includes(search)).map((c) => ({ channelID: c.channelID, channel: c.channel, isLive: false, plan_tier: c.plan }));
            return json({ rows, pagination: { page: 1, limit: 6, total: rows.length, totalPages: 1 } });
        }
        otherCalls.push(`GET ${url.pathname}`);
        return json({});
    });

    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { errors.push(`native dialog: ${dialog.message()}`); void dialog.dismiss(); });
    const until = async (check, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${label}`); };
    const q = () => new URL(page.url()).searchParams;
    const last = (list) => list[list.length - 1];
    const fromAgo = (params) => NOW - Date.parse(params.get('from'));
    const near = (ms, target) => Math.abs(ms - target) < 15 * MIN;
    const text = (selector) => page.locator(selector).first().innerText();
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: `${artifacts}/${name}.png` }); };
    const rows = page.locator('[data-turn-row]');
    const numbers = page.locator('[data-numbers]');
    const numbersOpen = () => numbers.evaluate((d) => d.open);
    const openNumbers = async () => { if (!(await numbersOpen())) { await numbers.locator('summary').click(); await until(numbersOpen, 'numbers open'); } };
    const answerLine = page.locator('[data-answer]');
    const reset = () => Object.assign(state, { summary: 'ok', turns: 'ok', recordsSince: ago(5 * DAY), docsSummary: 'ok', docsAnswers: 'ok' });

    // ================================ Dima assistant ================================
    await page.goto(`${base}/ai/assistant`);
    await rows.first().waitFor({ timeout: 60_000 });
    await until(async () => (await answerLine.count()) > 0, 'answer line');
    let answer = (await answerLine.innerText()).replace(/\s+/g, ' ');
    assert.match(answer, /56 messages in the last 30 days from 4 channels/);
    assert.match(answer, /54 answered, 1 failed, 1 stopped by the person\. It cost us \$0\.58\./);
    assert.equal(await answerLine.getAttribute('data-tone'), 'ok');
    assert.ok(near(fromAgo(last(seen.summary)), 720 * HOUR), 'summary from = 30 days');
    assert.ok(near(fromAgo(last(seen.turns)), 720 * HOUR), 'turns from = 30 days');
    // Phones: the list first; the numbers are one tap away; the limit warning stays visible.
    assert.equal(await numbersOpen(), false, 'numbers start folded on a phone');
    assert.ok(await rows.first().isVisible(), 'list visible without opening anything');
    assert.ok(await page.locator('#as-list-h').evaluate((h) => h.getBoundingClientRect().top < innerHeight), 'list heading on the first screen');
    assert.ok(await page.locator('[data-limit-row]').first().isVisible(), 'limit warning visible above the fold');
    assert.equal(await page.locator('[data-block="levels"]').isVisible(), false);
    assert.ok((await numbers.boundingBox()).y < (await page.locator('[data-turns]').boundingBox()).y, 'numbers toggle is above the list');
    await shot('assistant-phone-first-dark-390');
    await openNumbers();
    assert.ok(await page.locator('[data-block="levels"]').isVisible());
    assert.equal(await text('[data-privacy]'), "Only you can see these chats here. Other people on the channel can't.");
    const refusals = page.locator('[data-refusals]');
    assert.match(await refusals.innerText(), /Refusals \(3 this week\)/);
    assert.equal(await refusals.getAttribute('href'), '/assistant-refusals');
    assert.match(await text('[data-records-note]'), /^Per-message details start \w{3} \d{1,2}\. Daily totals go back further\.$/);
    assert.match(await text('[data-cost-line]'), /\$0\.58 in total · .* a day · \$0\.01\d* per message/);

    // Question-first rows; a turn without text says so; the fallback chip.
    assert.equal(await rows.count(), TURNS.length);
    assert.equal(await rows.nth(0).locator('[data-turn-question]').innerText(), TURNS[0].question);
    assert.match(await rows.nth(2).innerText(), /No text recorded/);
    assert.match(await rows.nth(2).innerText(), /Stopped by the person/);
    assert.match(await rows.nth(1).innerText(), /Failed: the model took too long/);
    assert.match(await rows.nth(1).innerText(), /Rafa Quinn, editor\s· pixelmonk/);
    assert.equal(await page.locator('[data-turn-id="t4"] [data-fell-back]').innerText(), 'fell back to Standard');
    assert.equal(await page.locator('[data-fell-back]').count(), 1);

    // Blocks: limits lead with channels near their limit; tools in plain words; errors in plain words.
    assert.deepEqual(await page.locator('[data-limit-row]').allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, ' ').trim())), ['luna_plays used 78 of 80 today 98%']);
    assert.match(await text('[data-block="tools"]'), /Opened a page[\s\S]*Read the docs[\s\S]*Created a command[\s\S]*1 failed/);
    assert.match(await text('[data-block="tools"]'), /Create timer/, 'unmapped tools keep the plain transform');
    assert.match(await text('[data-block="levels"]'), /gpt-6-luna/);
    assert.doesNotMatch(await text('[data-block="levels"]'), /openai\//);
    assert.match(await text('[data-error-row]'), /The model took too long/);
    assert.match(await text('[data-block="ratings"]'), /3\s+helpful[\s\S]*1\s+not helpful/);
    await shot('assistant-dark-390');

    // Range re-requests both with a new `from`.
    let summaries = seen.summary.length, turnsCalls = seen.turns.length;
    await page.locator('label:has(input[name="as-range"][value="7d"]) span').click();
    await until(async () => seen.summary.length > summaries && seen.turns.length > turnsCalls && near(fromAgo(last(seen.summary)), 168 * HOUR) && near(fromAgo(last(seen.turns)), 168 * HOUR), 'range reload');
    assert.equal(q().get('range'), '7d');
    assert.ok(near(fromAgo(last(seen.summary)), 168 * HOUR), 'summary from = 7 days');
    assert.ok(near(fromAgo(last(seen.turns)), 168 * HOUR), 'turns from = 7 days');
    await until(async () => /in the last 7 days/.test(await answerLine.innerText()), '7d answer');

    // Chips and sort change the request and the URL; filters keep the range and never reload the summary.
    const summariesBeforeChips = seen.summary.length;
    const chip = (key) => page.locator(`[data-chip="${key}"]`);
    for (const [key, param, value] of [['problems', 'status', 'problems'], ['cancelled', 'status', 'cancelled'], ['expert', 'level', 'expert'], ['standard', 'level', 'standard']]) {
        turnsCalls = seen.turns.length;
        await chip(key).click();
        await until(async () => seen.turns.length > turnsCalls && q().get(param) === value && last(seen.turns).get(param) === value, `chip ${key}`);
        assert.equal(last(seen.turns).get(param), value);
        assert.equal(q().get('range'), '7d');
        assert.equal(await chip(key).getAttribute('aria-pressed'), 'true');
    }
    assert.equal(q().get('status'), 'cancelled', 'status and level combine');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await until(async () => !q().get('status') && !q().get('level'), 'All clears');
    for (const [label, value] of [['Costliest', 'cost'], ['Slowest', 'slowest']]) {
        turnsCalls = seen.turns.length;
        await page.locator(`label:has(input[name="as-sort"][value="${value}"]) span`).click();
        await until(async () => seen.turns.length > turnsCalls && q().get('sort') === value && last(seen.turns).get('sort') === value, `sort ${label}`);
        assert.equal(last(seen.turns).get('sort'), value);
    }
    await until(async () => (await rows.first().getAttribute('data-turn-id')) === 't2', 'slowest first');
    assert.equal(seen.summary.length, summariesBeforeChips, 'chips and sort do not reload the summary');

    // The "See the failed message" shortcut.
    await page.goto(`${base}/ai/assistant`);
    await rows.first().waitFor();
    await page.locator('[data-see-problems]').click();
    await until(async () => q().get('status') === 'problems', 'see problems');
    await openNumbers();

    // Channel filter from the Channels block: URL, summary and list follow it.
    summaries = seen.summary.length; turnsCalls = seen.turns.length;
    await page.locator(`[data-channel-row][data-channel-id="${CH.pixel.channelID}"]`).click();
    await until(async () => q().get('channel') === CH.pixel.channelID && last(seen.summary)?.get('channel') === CH.pixel.channelID && last(seen.turns)?.get('channel') === CH.pixel.channelID, 'channel filter');
    assert.equal(last(seen.summary).get('channel'), CH.pixel.channelID);
    assert.equal(last(seen.turns).get('channel'), CH.pixel.channelID);
    assert.equal(q().get('status'), 'problems', 'channel keeps the status chip');
    await until(async () => /18 messages from pixelmonk in the last 30 days/.test(await answerLine.innerText()), 'channel answer');
    assert.match((await answerLine.innerText()).replace(/\s+/g, ' '), /16 answered, 1 failed, 1 stopped by the person\. They used 18 daily messages\. It cost us \$0\.17\./);
    assert.match(await text('[data-channel-chip]'), /Only pixelmonk/);
    assert.equal(await page.locator(`[data-channel-row][data-channel-id="${CH.pixel.channelID}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator('[data-channel-chip]').click();
    await until(async () => !q().get('channel'), 'channel removed');

    // The Filters sheet with the channel picker.
    await page.goto(`${base}/ai/assistant`);
    await rows.first().waitFor();
    await page.locator('[data-open-filters]').click();
    const filterSheet = page.locator('[data-filter-sheet]');
    await until(async () => filterSheet.evaluate((d) => d.open), 'filter sheet open');
    await filterSheet.locator('input[type="search"]').fill('sol');
    await filterSheet.getByRole('button', { name: /sol_rides/ }).click();
    await until(async () => q().get('channel') === CH.sol.channelID, 'picked channel');
    assert.equal(await filterSheet.evaluate((d) => d.open), false);
    assert.match(await page.locator('[data-open-filters]').innerText(), /Filters\s*1/);

    // Opening a turn: URL, detail request, the whole exchange as text.
    await page.goto(`${base}/ai/assistant`);
    await rows.first().waitFor();
    const sheet = page.locator('[data-turn-sheet]');
    let details = seen.detail.length;
    await rows.first().click();
    await until(async () => q().get('open') === 't1' && (await sheet.evaluate((d) => d.open)), 'sheet open');
    await until(async () => (await page.locator('[data-sheet-answer]').count()) > 0, 'detail loaded');
    assert.equal(seen.detail.length, details + 1);
    assert.equal(last(seen.detail), 't1');
    assert.equal(await sheet.locator('[data-sheet-message]').innerText(), DETAIL.t1.message);
    assert.deepEqual(await sheet.locator('[data-sheet-steer] .lf-quote').allInnerTexts(), DETAIL.t1.steers);
    assert.equal(await sheet.locator('[data-sheet-tool]').count(), 2);
    await sheet.locator('[data-sheet-tool] summary').nth(1).click();
    assert.match(await sheet.locator('[data-sheet-tool]').nth(1).innerText(), /Created a command[\s\S]*done[\s\S]*approved and applied/);
    assert.match(await sheet.locator('[data-sheet-tool]').nth(0).innerText(), /Read the docs/);
    assert.equal(await sheet.locator('[data-tool-args]').nth(1).innerText(), DETAIL.t1.tools[1].args);
    assert.equal(await sheet.locator('[data-tool-result]').nth(1).innerText(), DETAIL.t1.tools[1].result);
    assert.equal(await sheet.locator('[data-sheet-answer]').innerText(), DETAIL.t1.answer);
    assert.equal(await sheet.locator('img').count(), 0, 'answer and tool results are text, not HTML');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await sheet.innerText(), /Daily messages used\s*2/);
    assert.match(await sheet.innerText(), /Rating\s*Helpful/);
    assert.match(await sheet.innerText(), /\/luna_plays\/dashboard\/commands/);
    assert.match(await sheet.innerText(), /claude-haiku-5-5/);
    assert.equal(await sheet.getByRole('link', { name: 'Everything from this person' }).getAttribute('href'), `/activity?actor=${PEOPLE.mia.id}`);
    assert.equal(await sheet.getByRole('link', { name: 'luna_plays' }).getAttribute('href'), `/channels/${CH.luna.channelID}`);
    await shot('assistant-sheet-dark-390');
    await page.keyboard.press('Escape');
    await until(async () => !q().get('open') && !(await sheet.evaluate((d) => d.open)), 'sheet closed by Escape');
    await rows.first().click();
    await until(async () => (await page.locator('[data-sheet-answer]').count()) > 0, 'reopened from cache');
    assert.equal(seen.detail.length, details + 1, 'a loaded exchange is cached');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await until(async () => !q().get('open'), 'sheet closed by button');

    // Detail error + Retry, inside the sheet.
    state.fail.add('detail');
    await rows.nth(1).click();
    await sheet.locator('[data-sheet-error]').waitFor();
    assert.match(await sheet.locator('[data-sheet-error]').innerText(), /didn't load/);
    assert.equal(await sheet.locator('[data-sheet-answer]').count(), 0);
    await sheet.locator('[data-sheet-error]').getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await sheet.locator('[data-sheet-tools]').count()) > 0 && (await sheet.locator('[data-sheet-error]').count()) === 0, 'detail retry');
    assert.match(await sheet.innerText(), /No answer: The model took too long/);
    // "Only this person" filters the list by them and closes the sheet.
    turnsCalls = seen.turns.length;
    await sheet.locator('[data-only-person]').click();
    await until(async () => q().get('user') === PEOPLE.rafa.id && !q().get('open') && last(seen.turns).get('user') === PEOPLE.rafa.id, 'only this person');
    assert.equal(last(seen.turns).get('user'), PEOPLE.rafa.id);
    await until(async () => /Only Rafa Quinn/.test(await page.locator('[data-user-chip]').innerText().catch(() => '')), 'person chip');

    // Deep links: filters and an open turn.
    await page.goto(`${base}/ai/assistant?range=24h&level=expert&sort=cost&open=t4`);
    await until(async () => (await sheet.evaluate((d) => d.open)) && (await sheet.locator('[data-sheet-answer]').count()) > 0, 'deep-linked sheet');
    assert.deepEqual(await sheet.locator('[data-sheet-steer] .lf-quote').allInnerTexts(), DETAIL.t4.steers);
    assert.match(await sheet.innerText(), /fell back to Standard/);
    assert.match(await sheet.innerText(), /not allowed/);
    assert.equal(last(seen.turns).get('level'), 'expert');
    assert.equal(last(seen.turns).get('sort'), 'cost');
    assert.ok(near(fromAgo(last(seen.turns)), 24 * HOUR));
    assert.equal(await chip('expert').getAttribute('aria-pressed'), 'true');
    await page.goto(`${base}/ai/assistant?open=missing`);
    await sheet.locator('[data-sheet-error]').waitFor();
    assert.match(await sheet.locator('[data-sheet-error]').innerText(), /no longer kept/);
    await page.keyboard.press('Escape');

    // Warn tone with the most common error in plain words.
    state.summary = 'warn';
    await page.goto(`${base}/ai/assistant`);
    await until(async () => (await answerLine.getAttribute('data-tone').catch(() => null)) === 'warn', 'warn tone');
    answer = (await answerLine.innerText()).replace(/\s+/g, ' ');
    assert.match(answer, /48 answered, 7 failed, 1 stopped by the person\. It cost us \$0\.58\. Most common error: the model took too long \(4 times\)\./);
    assert.match(await page.locator('[data-see-problems]').innerText(), /See the 7 failed messages/);
    await shot('assistant-warn-dark-390');
    reset();

    // No filter match, then nothing recorded yet.
    state.turns = 'empty';
    await page.goto(`${base}/ai/assistant?status=cancelled`);
    await page.locator('[data-turns-empty]').waitFor();
    assert.match(await text('[data-turns-empty]'), /No messages match[\s\S]*Widen the range or clear the filters/);
    state.recordsSince = null; state.summary = 'empty';
    await page.goto(`${base}/ai/assistant`);
    await until(async () => /No assistant messages recorded yet/.test(await page.locator('[data-turns-empty]').innerText().catch(() => '')), 'nothing recorded');
    assert.match(await answerLine.innerText(), /No messages in the last 30 days/);
    assert.equal(await page.locator('[data-records-note]').count(), 0);
    assert.equal(await page.locator('[data-block]').count(), 0, 'empty blocks are hidden');
    assert.match(await refusals.innerText(), /^Refusals$/);
    await shot('assistant-empty-dark-390');
    reset();

    // Errors + Retry, filters kept.
    state.fail.add('summary'); state.fail.add('turns');
    await page.goto(`${base}/ai/assistant?level=standard`);
    await page.locator('[data-summary-error]').waitFor();
    await page.locator('[data-turns-error]').waitFor();
    assert.equal(await page.getByRole('alert').count(), 2);
    await page.locator('[data-turns-error]').getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await rows.count()) > 0 && (await answerLine.count()) > 0, 'assistant retry');
    assert.equal(q().get('level'), 'standard');
    assert.equal(last(seen.turns).get('level'), 'standard');

    // ================================ Docs AI ================================
    const docRows = page.locator('[data-docs-row]');
    await page.goto(`${base}/ai/docs`);
    await docRows.first().waitFor();
    await until(async () => (await answerLine.count()) > 0, 'docs answer');
    answer = (await answerLine.innerText()).replace(/\s+/g, ' ');
    assert.match(answer, /47 questions in the last 30 days/);
    assert.match(answer, /44 answered, 3 abandoned before the answer, 0 failed\. It cost \$0\.47\. 3 rated helpful, 0 not helpful\./);
    assert.equal(await page.locator('[data-see-unhelpful]').count(), 0);
    assert.equal(await numbersOpen(), false, 'docs numbers start folded on a phone');
    assert.ok(await docRows.first().isVisible(), 'docs list visible without opening anything');
    await shot('docs-phone-first-dark-390');
    await openNumbers();
    assert.ok(near(fromAgo(last(seen.docsSummary)), 720 * HOUR));
    assert.match(await text('[data-cost-line]'), /typical answer in 5\.9 s/);
    assert.equal(await docRows.count(), DOCS.length);
    assert.equal(await docRows.first().locator('[data-docs-question]').innerText(), DOCS[0].question);
    assert.match(await page.locator('[data-docs-id="d3"]').innerText(), /follow-up/);
    assert.match(await text('[data-block="where"]'), /English[\s\S]*Spanish[\s\S]*\/en\/commands\//);
    await shot('docs-dark-390');

    // Opening an answer: text with line breaks, no HTML, safe source links in a new tab.
    await docRows.first().locator('summary').click();
    const body = docRows.first().locator('[data-docs-body]');
    await body.waitFor();
    assert.equal(await body.locator('[data-docs-answer]').innerText(), DOCS[0].answer);
    assert.equal(await body.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    const sources = body.locator('[data-docs-sources] a');
    assert.equal(await sources.count(), 1, 'non-http sources are dropped');
    assert.equal(await sources.getAttribute('href'), DOCS[0].sources[0]);
    assert.equal(await sources.getAttribute('target'), '_blank');
    assert.equal(await sources.getAttribute('rel'), 'noopener');
    assert.match(await body.innerText(), /Searched the docs, Read page \(2 rounds\)/);
    await shot('docs-open-dark-390');
    // Unusual stop reason; failed question shows why.
    await page.locator('[data-docs-id="d3"] summary').click();
    assert.match(await page.locator('[data-docs-id="d3"] [data-docs-body]').innerText(), /Stopped because\s*max_tokens/);
    assert.match(await page.locator('[data-docs-id="d4"]').innerText(), /Not answered: the AI took too long/);
    await page.locator('[data-docs-id="d4"] summary').click();
    assert.match(await page.locator('[data-docs-id="d4"] [data-docs-why]').innerText(), /Not answered: the AI took too long/);
    assert.equal(await page.locator('[data-docs-id="d4"] [data-docs-answer]').count(), 0);
    assert.doesNotMatch(await page.locator('[data-docs-id="d1"] [data-docs-body]').innerText(), /Stopped because/);
    assert.doesNotMatch(await page.locator('[data-docs-id="d5"]').innerText(), /Not answered/, 'a row without the failed field is answered');
    assert.equal(await page.locator('[data-docs-failed]').count(), 1);

    // Range, chips, sort.
    summaries = seen.docsSummary.length;
    await page.locator('label:has(input[name="dc-range"][value="7d"]) span').click();
    await until(async () => q().get('range') === '7d' && seen.docsSummary.length > summaries && near(fromAgo(last(seen.docsSummary)), 168 * HOUR), 'docs range');
    assert.ok(near(fromAgo(last(seen.docsSummary)), 168 * HOUR));
    for (const [key, param, value] of [['en', 'lang', 'en'], ['es', 'lang', 'es'], ['helpful', 'feedback', 'helpful'], ['unhelpful', 'feedback', 'unhelpful'], ['none', 'feedback', 'none']]) {
        const calls = seen.docsAnswers.length;
        await chip(key).click();
        await until(async () => seen.docsAnswers.length > calls && q().get(param) === value && last(seen.docsAnswers).get(param) === value, `docs chip ${key}`);
        assert.equal(last(seen.docsAnswers).get(param), value);
    }
    for (const value of ['cost', 'slowest']) {
        const calls = seen.docsAnswers.length;
        await page.locator(`label:has(input[name="dc-sort"][value="${value}"]) span`).click();
        await until(async () => seen.docsAnswers.length > calls && q().get('sort') === value && last(seen.docsAnswers).get('sort') === value, `docs sort ${value}`);
        assert.equal(last(seen.docsAnswers).get('sort'), value);
    }

    // "See the N not helpful" shortcut.
    state.docsSummary = 'unhelpful';
    await page.goto(`${base}/ai/docs?lang=en`);
    await page.locator('[data-see-unhelpful]').waitFor();
    assert.match(await page.locator('[data-see-unhelpful]').innerText(), /See the 2 not helpful/);
    await openNumbers();
    assert.match(await text('[data-failure-row]'), /The AI took too long\s*1 time/);
    await page.locator('[data-see-unhelpful]').click();
    await until(async () => q().get('feedback') === 'unhelpful' && !q().get('lang'), 'not helpful shortcut');
    await until(async () => last(seen.docsAnswers).get('feedback') === 'unhelpful' && (await docRows.count()) === 1, 'unhelpful rows');
    reset();

    // Deep link.
    await page.goto(`${base}/ai/docs?lang=es&feedback=helpful&sort=cost`);
    await docRows.first().waitFor();
    assert.equal(await chip('es').getAttribute('aria-pressed'), 'true');
    assert.equal(await chip('helpful').getAttribute('aria-pressed'), 'true');
    assert.deepEqual([last(seen.docsAnswers).get('lang'), last(seen.docsAnswers).get('feedback'), last(seen.docsAnswers).get('sort')], ['es', 'helpful', 'cost']);
    assert.equal(await docRows.count(), 1);

    // Empty, then error + Retry.
    state.docsAnswers = 'empty'; state.docsSummary = 'empty';
    await page.goto(`${base}/ai/docs`);
    await page.locator('[data-answers-empty]').waitFor();
    assert.match(await text('[data-answers-empty]'), /No questions in the last 30 days/);
    await until(async () => /No questions in the last 30 days/.test(await answerLine.innerText().catch(() => '')), 'docs empty answer');
    reset();
    state.fail.add('docsSummary'); state.fail.add('docsAnswers');
    await page.goto(`${base}/ai/docs?feedback=none`);
    await page.locator('[data-answers-error]').waitFor();
    await page.locator('[data-summary-error]').waitFor();
    await page.locator('[data-summary-error]').getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await docRows.count()) > 0 && (await answerLine.count()) > 0, 'docs retry');
    assert.equal(last(seen.docsAnswers).get('feedback'), 'none');

    // ================================ Layout matrix ================================
    const targets = async () => page.evaluate(() => {
        const small = [];
        const sel = '[data-numbers] > summary, [data-turn-row], .lf-strip > .lf-chip, .lf-seg label span, [data-channel-row], .ab__go, [data-docs-row] > summary, .as-refresh, .dc-refresh, .lf-back';
        for (const element of document.querySelectorAll(sel)) {
            const box = element.getBoundingClientRect();
            if (box.width && box.height < 43.5 && !element.classList.contains('lf-back')) small.push(`${element.className} ${Math.round(box.height)}`);
        }
        return small;
    });
    for (const mode of ['dark', 'light']) {
        await page.evaluate((m) => localStorage.setItem('dima-admin.mode.v1', m), mode);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
            for (const [path, ready, host] of [['/ai/assistant', '[data-turn-row]', 'app-assistant-page'], ['/ai/docs', '[data-docs-row]', 'app-docs-ai-page']]) {
                await page.goto(`${base}${path}`);
                await page.locator(ready).first().waitFor();
                await until(async () => (await answerLine.count()) > 0, `${path} answer`);
                await page.waitForTimeout(700);
                assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${path} ${mode} ${width} overflow`);
                assert.deepEqual(await targets(), [], `${path} ${mode} ${width} touch targets`);
                await page.evaluate(() => window.scrollTo(0, 0));
                const axe = await new AxeBuilder({ page }).include(host).include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
                assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `${path} ${mode} ${width} axe`);
                const name = path.split('/').pop();
                await page.screenshot({ path: `${artifacts}/${name}-${mode}-${width}.png` });
                if (width >= 960) {
                    assert.equal(await numbersOpen(), true, `${path} ${width} numbers open on desktop`);
                    assert.equal(await numbers.locator('summary').isVisible(), false, `${path} ${width} no toggle on desktop`);
                } else {
                    assert.equal(await numbersOpen(), false, `${path} ${width} numbers folded on phones`);
                    await openNumbers();
                    await page.waitForTimeout(200);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${path} ${mode} ${width} numbers overflow`);
                    assert.deepEqual(await targets(), [], `${path} ${mode} ${width} numbers touch targets`);
                    const numbersAxe = await new AxeBuilder({ page }).include(host).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
                    assert.deepEqual(numbersAxe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `${path} ${mode} ${width} numbers axe`);
                    await numbers.locator('summary').click();
                    await until(async () => !(await numbersOpen()), 'numbers closed');
                }
                if (width !== 320) {
                    // Viewport shots while scrolling (full-page shots are distorted by the sticky bars).
                    const height = await page.evaluate(() => document.documentElement.scrollHeight);
                    for (let step = 1; step * 700 < height && step < 6; step++) {
                        await page.evaluate((y) => window.scrollTo(0, y), step * 700);
                        await page.waitForTimeout(150);
                        await page.screenshot({ path: `${artifacts}/${name}-${mode}-${width}-scroll${step}.png` });
                    }
                    await page.evaluate(() => window.scrollTo(0, 0));
                }
                if (path === '/ai/assistant') {
                    await rows.first().click();
                    await page.locator('[data-sheet-answer]').waitFor();
                    await page.locator('[data-sheet-tool] summary').first().click();
                    await page.waitForTimeout(300);
                    const sheetAxe = await new AxeBuilder({ page }).include('[data-turn-sheet]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
                    assert.deepEqual(sheetAxe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `sheet ${mode} ${width} axe`);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `sheet ${mode} ${width} overflow`);
                    assert.equal(await page.evaluate(() => { const d = document.querySelector('[data-turn-sheet]'); return d.scrollWidth > d.clientWidth + 1; }), false, `sheet ${mode} ${width} inner overflow`);
                    await page.screenshot({ path: `${artifacts}/assistant-sheet-${mode}-${width}.png` });
                    await page.keyboard.press('Escape');
                } else {
                    await docRows.first().locator('summary').click();
                    await page.waitForTimeout(200);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `docs open ${mode} ${width} overflow`);
                    const openAxe = await new AxeBuilder({ page }).include(host).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
                    assert.deepEqual(openAxe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], `docs open ${mode} ${width} axe`);
                }
            }
        }
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), []);
    console.log(`PASS admin console assistants: answer lines (ok/warn/channel/empty), ranges, ${4} assistant chips + sorts, channel filter (block + sheet), limits, question rows, exchange sheet (message, steers, tool args/results, answer as text), detail cache/error/retry/404, deep links, docs answers/sources/failed/not-helpful shortcut, empty/error/retry, axe + overflow + touch at 320/390/1280 dark+light`);
} catch (error) {
    if (page) {
        await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
        console.error('URL:', page.url());
    }
    throw error;
} finally {
    await browser.close();
}
