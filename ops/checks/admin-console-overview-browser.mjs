// Admin Overview ("God's view", /dashboard). Every API call is mocked: nothing reaches production.
// Covers the answer line with and without things that need the owner (plural and singular wording), every
// attention row's destination, the 24-hour numbers and their Activity links (problems → outcome=problems),
// hidden empty kinds, AI spend rows (credits, dollar value, provider cost, "not recorded" for null),
// the newest feed rows, the partial-data notice, the overview failing while health and live numbers still
// render (and the reverse), refresh keeping the last numbers, no stacked requests, the 30 s auto-refresh
// that pauses while the tab is hidden, and layout + accessibility at 320/390/1280 px in dark then light.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-overview';
fs.mkdirSync(artifacts, { recursive: true });
const TOKEN = 'disposable-overview-fixture';

// ---------- Fixtures (fictional names only) ----------
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const day = (back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const ch = (i) => ({ channelID: `70000000${i + 1}`, channel: ['pixel_harbor', 'luna_plays', 'cozy_kiln', 'retro_orbit'][i] });
const viewer = { id: '800000001', login: 'mossy_fern', name: 'Mossy_Fern' };
const item = (minutes, channel, extra) => ({
    id: `f${minutes}-${extra.kind}`, at: ago(minutes), outcome: 'ok', reason: null, actor: null, text: null, credits: null, providerUSD: null,
    durationMs: null, data: {}, ref: null, ...(channel ?? { channelID: null, channel: null }), ...extra,
});
const recent = [
    item(1, ch(0), { kind: 'command', name: '!so', actor: viewer, text: '!so quietcomet', data: { func: 'custom', trigger: 'chat' } }),
    item(2, ch(0), { kind: 'bot_message', name: 'command', text: 'Go check out QuietComet!', data: { origin: 'command' } }),
    item(3, ch(1), { kind: 'twitch_event', name: 'channel.follow', actor: viewer }),
    item(4, ch(1), { kind: 'alert', name: 'channel.follow', outcome: 'skipped', reason: 'alert_disabled', actor: viewer, data: { event: 'channel.follow' } }),
    item(6, ch(2), { kind: 'voice', name: 'fish', actor: viewer, credits: 74, data: { provider: 'fish', chars: 49 } }),
    item(9, ch(2), { kind: 'voice', name: 'fish', outcome: 'failed', reason: 'synthesis_failed', actor: viewer, data: { provider: 'fish', chars: 212 } }),
];
const kinds = [
    { kind: 'command', total: 1482, problems: 96, failed: 3 }, { kind: 'bot_message', total: 2210, problems: 12, failed: 4 },
    { kind: 'twitch_event', total: 1172, problems: 0, failed: 0 }, { kind: 'alert', total: 388, problems: 41, failed: 2 },
    { kind: 'protection', total: 67, problems: 2, failed: 2 }, { kind: 'voice', total: 1078, problems: 6, failed: 6 },
    { kind: 'ai', total: 0, problems: 0, failed: 0 }, { kind: 'assistant', total: 23, problems: 1, failed: 1 },
    { kind: 'docs', total: 0, problems: 0, failed: 0 }, { kind: 'credits', total: 4, problems: 0, failed: 0 },
];
const fullOverview = () => ({
    generatedAt: ago(0),
    day: { from: ago(1440), to: ago(0), kinds, activeChannels: 38, credits: 131400, providerUSD: 0.4312 },
    daily: Array.from({ length: 14 }, (_, i) => ({ date: day(13 - i), events: 4200 + ((i * 937) % 2600), problems: 60 + ((i * 53) % 140), credits: 96000 + ((i * 17123) % 70000), providerUSD: 0.3 })),
    features: [
        { feature: 'voice', count: 7420, failed: 31, credits: 742300, providerUSD: null },
        { feature: 'memory', count: 310, failed: 0, credits: 88100, providerUSD: 0.881 },
        { feature: 'ai_chat', count: 188, failed: 2, credits: 20400, providerUSD: 0.204 },
        { feature: 'assistant', count: 56, failed: 1, credits: 0, providerUSD: 0.583 },
        { feature: 'protection', count: 585, failed: 9, credits: 0, providerUSD: 0.0931 },
        { feature: 'docs', count: 12, failed: 0, credits: 0, providerUSD: 0.112 },
        { feature: 'other', count: 1, failed: 0, credits: 4770, providerUSD: 0.0477 },
    ],
    topChannels: [
        { ...ch(0), events: 2140, problems: 31, credits: 61200 }, { ...ch(1), events: 1322, problems: 0, credits: 40100 },
        { channelID: '700000009', channel: null, events: 1, problems: 0, credits: 0 },
    ],
    attention: [
        { key: 'verdicts_waiting', count: 12 }, { key: 'failed_24h', count: 18 }, { key: 'dead_deliveries', count: 795 }, { key: 'usage_import_stuck', count: 51 },
        { key: 'polar_unsent', count: 4 }, { key: 'gifts_need_support', count: 3 }, { key: 'credits_exhausted', count: 2 },
    ],
    recent,
    partial: [],
});
const summary = (extra = {}) => ({ totalChannels: 167, activeBots: 131, inactiveBots: 36, withPermissions: 140, permissionsNeedUpdate: 9, liveChannels: 2, liveViewers: 460, totalCommands: 4120, totalEventsubsActive: 964, totalEventsubsDisabled: 21, ...extra });
const liveRows = [
    { channelID: '700000001', channel: 'pixel_harbor', plan_tier: 'pro', isLive: true, liveViewers: 320 },
    { channelID: '700000002', channel: 'luna_plays', plan_tier: 'free', isLive: true, liveViewers: 140 },
    { channelID: '700000003', channel: 'cozy_kiln', plan_tier: 'free', isLive: false, liveViewers: 0 },
];
const analytics = { registeredUsers: 412, liveUsers: 7, authorizedAccounts: 167, totalMessages: 5120344, totalCommands: 381220, totalLiveViewers: 612 };

// ---------- Mock API ----------
const state = { overview: fullOverview(), summary: summary(), overviewFail: false, usersFail: false, overviewDelay: 0 };
const calls = [];
const otherCalls = [];
const unexpected = [];
let overviewInFlight = 0, overviewMaxInFlight = 0;
const isApi = (url) => url.hostname === 'api.domdimabot.com' || (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3000');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript((token) => {
        localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token, createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
            appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
        if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
        // The live counters use EventSource directly: a stub that opens and lets the check push messages.
        window.EventSource = class { constructor() { window.__analyticsStream = this; this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
        // Lets the check flip the tab to hidden and back.
        window.__hidden = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    }, TOKEN);
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
        if (!isApi(url)) { unexpected.push(`${request.method()} ${url.href}`); return route.abort(); }
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
        const key = `${request.method()} ${url.pathname}`;
        calls.push(`${key}${url.search}`);
        if (key === 'GET /admin-site/overview') {
            assert.equal(request.headers().authorization, `Bearer ${TOKEN}`, 'the overview request carries the admin session');
            overviewInFlight++; overviewMaxInFlight = Math.max(overviewMaxInFlight, overviewInFlight);
            try {
                if (state.overviewDelay) await new Promise((resolve) => setTimeout(resolve, state.overviewDelay));
                if (state.overviewFail) return await json({ error: true, message: 'boom', status: 500, data: null }, 500);
                return await json({ error: false, message: 'ok', status: 200, data: state.overview });
            } finally { overviewInFlight--; }
        }
        if (key === 'GET /admin-site/users') {
            if (state.usersFail) return json({ error: true, message: 'boom', status: 500, data: null }, 500);
            return json({ error: false, message: 'ok', status: 200, data: { rows: liveRows, pagination: { page: 1, limit: 6, total: 3, totalPages: 1 }, summary: state.summary } });
        }
        if (key === 'GET /config/site/analytics') return json({ data: analytics });
        // The shell's own read-only calls (avatar lookups and the like) are answered empty, and listed below.
        otherCalls.push(key);
        if (request.method() !== 'GET') { unexpected.push(key); return route.abort(); }
        return json({ data: {} });
    });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const until = async (fn, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await fn().catch(() => false)) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${label}`); };
    const answer = page.locator('[data-ov-answer]');
    const rows = page.locator('[data-attention]');
    // Phones show the worst four rows until "Show more" is tapped; most assertions want the whole list.
    const allRows = async () => {
        const more = page.locator('[data-attention-more][aria-expanded="false"]');
        if (await more.count()) await more.click();
        return rows.count();
    };
    const open = async (path = '/dashboard') => {
        await page.goto(`${base}${path}`);
        await answer.waitFor({ timeout: 60000 });
    };
    const hrefOf = async (locator) => {
        const href = await locator.getAttribute('href');
        return href ? decodeURIComponent(href) : null;
    };
    const overviewCalls = () => calls.filter((call) => call.startsWith('GET /admin-site/overview')).length;

    // ---------- Things need the owner: answer, rows worst first, where each goes ----------
    await open();
    // A phone shows the worst four and keeps the rest one tap away.
    const more = page.locator('[data-attention-more]');
    await until(async () => (await rows.count()) === 4, 'the worst four attention rows');
    assert.match(await more.innerText(), /Show 5 more/);
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await more.click();
    await until(async () => (await rows.count()) === 9, 'nine attention rows');
    assert.match(await more.innerText(), /Show fewer/);
    assert.match(await answer.innerText(), /9 things need you/);
    assert.match(await answer.innerText(), /Dima did 6,424 things in the last 24 hours; 158 didn't go as planned\./);
    assert.deepEqual(await rows.evaluateAll((list) => list.map((row) => row.dataset.attention)),
        ['gifts_need_support', 'failed_24h', 'dead_deliveries', 'polar_unsent', 'usage_import_stuck', 'credits_exhausted', 'verdicts_waiting', 'permissions', 'bots']);
    const expectRow = async (key, text, href) => {
        const row = page.locator(`[data-attention="${key}"]`);
        assert.match(await row.innerText(), text, `${key} wording`);
        assert.equal(await hrefOf(row), href, `${key} destination`);
    };
    await expectRow('gifts_need_support', /3 gifted credit purchases could not be delivered[\s\S]*Someone paid and the credits never arrived\.[\s\S]*Gifts/, '/gifts?status=needs_support');
    assert.equal(await page.locator('[data-attention="gifts_need_support"]').evaluate((el) => el.tagName), 'A', 'gifts opens the Gifted credits page');
    assert.equal((await page.locator('[data-attention="gifts_need_support"]').innerText()).includes('No page for this yet'), false);
    await expectRow('failed_24h', /18 things failed in the last 24 hours/, '/activity?outcome=failed&range=24h');
    await expectRow('dead_deliveries', /795 Twitch events a part of the bot gave up on/, '/observability?tab=queues');
    await expectRow('polar_unsent', /4 channels have usage not yet sent to billing/, '/observability?tab=queues');
    await expectRow('usage_import_stuck', /51 usage history imports are stuck/, '/observability?tab=queues');
    await expectRow('credits_exhausted', /2 channels are out of AI credits/, '/users');
    await expectRow('verdicts_waiting', /12 chat protection messages wait for your verdict/, '/moderation-review');
    await expectRow('permissions', /9 channels need to reconnect Twitch/, '/users?sort=has_permissions&order=asc');
    await expectRow('bots', /36 bots aren't active/, '/users?sort=actived&order=asc');
    // Header chips: live updates and the live count.
    await until(async () => /Live updates/.test(await page.locator('.connection').innerText()), 'live updates chip');
    assert.match(await page.locator('[data-ov-live-chip]').innerText(), /7 live/);

    // ---------- Last 24 hours ----------
    const stats = page.locator('app-ov-day .lf-stat');
    assert.match(await page.locator('[data-ov-day-line]').innerText(), /^38 channels active · 131,400 credits used \(≈ \$1\.31\) · \$0\.431 paid to AI providers$/);
    assert.deepEqual(await stats.evaluateAll((list) => list.map((stat) => stat.dataset.kind)),
        ['command', 'bot_message', 'twitch_event', 'alert', 'protection', 'voice', 'assistant'], 'empty AI and Docs AI kinds are hidden; credits is not a 24-hour stat');
    const stat = (kind) => page.locator(`app-ov-day .lf-stat[data-kind="${kind}"]`);
    assert.match(await stat('command').innerText(), /Commands\s+1,482\s+96 didn't answer/);
    assert.equal(await hrefOf(stat('command')), '/activity?kinds=command&range=24h&outcome=problems');
    assert.match(await stat('alert').innerText(), /41 not sent/);
    assert.match(await stat('voice').innerText(), /6 failed/);
    assert.ok(await stat('voice').locator('.lf-stat__note--danger').count(), 'all-failed is shown in the danger style');
    assert.ok(await stat('alert').locator('.lf-stat__note--warn').count(), 'other problems are shown in the warn style');
    assert.equal((await stat('twitch_event').innerText()).includes('planned'), false);
    assert.equal(await hrefOf(stat('twitch_event')), '/activity?kinds=twitch_event&range=24h', 'no problems: plain kind link');
    assert.match(await stat('protection').innerText(), /2 failed/);

    // ---------- AI spend ----------
    const spend = page.locator('app-ov-spend .lf-bars__row');
    assert.deepEqual(await spend.evaluateAll((list) => list.map((row) => row.dataset.feature)), ['voice', 'memory', 'assistant', 'ai_chat', 'docs', 'other', 'protection'], 'biggest money first');
    const spendRow = (feature) => page.locator(`app-ov-spend [data-feature="${feature}"]`);
    assert.match(await spendRow('voice').innerText(), /Voice[\s\S]*7,420 requests · 31 failed[\s\S]*Provider cost: not recorded[\s\S]*742,300 credits[\s\S]*≈ \$7\.42/);
    assert.equal((await spendRow('voice').innerText()).includes('$0 '), false, 'a null provider cost never reads as $0');
    assert.match(await spendRow('protection').innerText(), /Chat protection[\s\S]*585 reviews · 9 failed[\s\S]*Provider cost: \$0\.093[\s\S]*No credits[\s\S]*free to streamers/);
    assert.match(await spendRow('assistant').innerText(), /Dima assistant[\s\S]*56 messages · 1 failed/);
    assert.match(await spendRow('docs').innerText(), /Docs AI[\s\S]*12 questions/);
    assert.equal((await spendRow('docs').innerText()).includes('failed'), false);
    assert.match(await spendRow('other').innerText(), /1 request\b/);
    assert.equal(await hrefOf(spendRow('voice')), '/ai/usage?category=tts&range=7d');
    assert.equal(await hrefOf(spendRow('ai_chat')), '/ai/usage?category=ai_chat&range=7d');
    assert.equal(await hrefOf(spendRow('memory')), '/ai/usage?category=memory&range=7d');
    assert.equal(await hrefOf(spendRow('other')), '/ai/usage?category=other&range=7d');
    assert.equal(await hrefOf(spendRow('protection')), '/ai/decisions');
    assert.equal(await hrefOf(spendRow('assistant')), '/ai/assistant');
    assert.equal(await hrefOf(spendRow('docs')), '/ai/docs');
    assert.equal(await hrefOf(page.locator('app-ov-spend').getByRole('link', { name: 'All AI' })), '/ai');
    assert.match(await page.locator('[data-spend-total]').innerText(), /855,570 credits charged \(≈ \$8\.56\) · \$1\.92 provider cost where recorded/);
    const widths = await spend.locator('.lf-bar > span').evaluateAll((list) => list.map((bar) => parseFloat(bar.style.width)));
    assert.ok(widths[0] > 70 && widths.every((width, i) => i === 0 || width <= widths[i - 1]), `share bars shrink with spend: ${widths}`);

    // ---------- Charts, busiest channels, feed preview, live ----------
    assert.equal(await page.locator('app-ov-trend .days__bar').count(), 28, 'two 14-day charts');
    const busy = page.locator('[data-busy-channel]');
    assert.equal(await busy.count(), 3);
    assert.match(await busy.first().innerText(), /pixel_harbor[\s\S]*2,140 events · 31 problems[\s\S]*61\.2K credits/);
    assert.equal((await busy.nth(1).innerText()).includes('problem'), false);
    assert.match(await busy.nth(2).innerText(), /Channel without an account[\s\S]*1 event[\s\S]*No credits/);
    assert.equal(await hrefOf(busy.first()), '/channels/700000001/activity');
    const feedRows = page.locator('[data-ov-recent] [data-feed-row]');
    assert.equal(await feedRows.count(), recent.length);
    assert.equal(await page.locator('[data-ov-recent] details').count(), 0, 'preview rows do not open');
    assert.equal(await hrefOf(page.locator('[data-ov-recent]').getByRole('link', { name: 'See all activity' })), '/activity');
    assert.equal(await page.locator('[data-ov-live-row]').count(), 2, 'only live channels are listed');
    assert.equal(await page.locator('.live-figure strong').first().innerText(), '7');
    assert.equal(await page.locator('.metrics .metric strong').nth(2).innerText(), '5.1M');
    await page.evaluate(() => window.__analyticsStream.onmessage({ data: JSON.stringify({ liveUsers: 9 }) }));
    await until(async () => (await page.locator('.live-figure strong').first().innerText()) === '9', 'live counter follows the stream');
    await page.evaluate(() => window.__analyticsStream.onmessage({ data: '{broken' }));
    assert.equal(await page.locator('.live-figure strong').first().innerText(), '9', 'a broken stream message keeps the last numbers');

    // ---------- Refresh keeps the numbers; requests never stack ----------
    state.overviewFail = true;
    await page.locator('[data-ov-refresh]').click();
    await page.locator('[data-ov-stale]').waitFor();
    assert.match(await page.locator('[data-ov-stale]').innerText(), /Couldn't refresh\. Showing the numbers from/);
    assert.equal(await stats.count(), 7, 'the last numbers stay on screen');
    await until(async () => (await allRows()) === 9, '9 attention rows');
    state.overviewFail = false;
    state.overviewDelay = 1200;
    const before = overviewCalls();
    await page.locator('[data-ov-stale]').getByRole('button', { name: 'Try again' }).click();
    await page.locator('[data-ov-refresh]').click();
    await page.locator('[data-ov-refresh]').click();
    await page.locator('[data-ov-stale]').waitFor({ state: 'hidden' });
    assert.equal(overviewCalls() - before, 1, 'taps while a refresh is on its way do not send more requests');
    assert.equal(overviewMaxInFlight, 1, 'never two overview requests at once');
    state.overviewDelay = 0;

    // ---------- Auto-refresh every 30 s, paused while the tab is hidden ----------
    await page.clock.install();
    await open();
    await until(async () => (await stats.count()) === 7, 'loaded under a fake clock');
    let count = overviewCalls();
    await page.clock.runFor(30_500);
    await until(async () => overviewCalls() === count + 1, 'refreshes after 30 seconds');
    state.overview = { ...fullOverview(), attention: [{ key: 'failed_24h', count: 19 }] };
    await page.clock.runFor(30_500);
    await until(async () => /19 things failed/.test(await rows.first().innerText()), 'new numbers replace the old ones');
    await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    count = overviewCalls();
    await page.clock.runFor(95_000);
    await page.waitForTimeout(300);
    assert.equal(overviewCalls(), count, 'no refresh while the tab is hidden');
    await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await until(async () => overviewCalls() === count + 1, 'refreshes as soon as the tab is visible again');
    state.overview = fullOverview();

    // ---------- Singular wording ----------
    state.overview = { ...fullOverview(), attention: [{ key: 'failed_24h', count: 1 }] };
    state.summary = summary({ inactiveBots: 0, permissionsNeedUpdate: 0 });
    await open();
    await until(async () => (await allRows()) === 1, 'one row');
    assert.match(await answer.innerText(), /1 thing needs you/);
    assert.match(await rows.first().innerText(), /1 thing failed in the last 24 hours/);
    state.overview = { ...fullOverview(), attention: ['verdicts_waiting', 'dead_deliveries', 'usage_import_stuck', 'polar_unsent', 'gifts_need_support', 'credits_exhausted'].map((key) => ({ key, count: 1 })) };
    state.summary = summary({ inactiveBots: 1, permissionsNeedUpdate: 1 });
    await open();
    await until(async () => (await allRows()) === 8, 'eight singular rows');
    const singular = await rows.allInnerTexts();
    for (const text of ['1 chat protection message waits for your verdict', '1 Twitch event a part of the bot gave up on', '1 usage history import is stuck',
        '1 channel has usage not yet sent to billing', '1 gifted credit purchase could not be delivered', '1 channel is out of AI credits',
        '1 channel needs to reconnect Twitch', "1 bot isn't active"]) {
        assert.ok(singular.some((row) => row.includes(text)), `singular: ${text}`);
    }

    // ---------- Nothing needs the owner; a brand-new install ----------
    const quiet = fullOverview();
    state.overview = { ...quiet, attention: [], recent: [], topChannels: [], features: [],
        day: { ...quiet.day, activeChannels: 0, credits: 0, providerUSD: 0, kinds: quiet.day.kinds.map((count) => ({ ...count, total: 0, problems: 0, failed: 0 })) },
        daily: quiet.daily.map((row) => ({ ...row, events: 0, problems: 0, credits: 0, providerUSD: 0 })) };
    state.summary = summary({ inactiveBots: 0, permissionsNeedUpdate: 0 });
    await open();
    assert.match(await answer.innerText(), /Everything looks good[\s\S]*Checked failures, Twitch deliveries, billing, usage imports, gifted credits, AI credits, the review queue, 167 bots and Twitch access\./);
    assert.ok(await answer.evaluate((el) => el.classList.contains('lf-status--ok')));
    await until(async () => (await allRows()) === 0, '0 attention rows');
    assert.deepEqual(await stats.evaluateAll((list) => list.map((stat) => stat.dataset.kind)), ['command', 'twitch_event', 'protection'], 'the expected kinds stay even at zero');
    assert.match(await stat('command').innerText(), /Commands\s+0\s+None yet/);
    assert.match(await page.locator('[data-ov-day-line]').innerText(), /0 channels active · no credits used · \$0 paid to AI providers/);
    await page.getByText('Nothing recorded yet.', { exact: false }).waitFor();
    await page.getByText('No AI was used in the last 7 days.').waitFor();
    await page.getByText('No channel has done anything in the last 24 hours yet.').waitFor();
    await page.screenshot({ path: `${artifacts}/quiet-dark-390.png` });

    // ---------- Partial data ----------
    state.overview = { ...fullOverview(), partial: ['usage'] };
    state.summary = summary();
    await open();
    assert.equal(await page.locator('[data-ov-partial]').innerText(), "Usage numbers couldn't be loaded. The rest is up to date.");
    state.overview = { ...fullOverview(), partial: ['usage', 'decisions', 'attention'] };
    await open();
    assert.match(await page.locator('[data-ov-partial]').innerText(), /^Usage numbers, chat protection numbers and some of the "needs you" checks couldn't be loaded\./);
    assert.match(await answer.innerText(), /Couldn't check some queues and billing right now\./);
    assert.equal(await stats.count(), 7, 'the rest still renders');

    // ---------- The overview failing must not hide health and live numbers ----------
    state.overview = fullOverview();
    state.overviewFail = true;
    await open();
    await page.locator('[data-ov-error]').waitFor();
    assert.match(await page.locator('[data-ov-error]').innerText(), /Couldn't load today's activity and AI spend/);
    assert.equal(await page.locator('[data-ov-error]').getAttribute('role'), 'alert');
    assert.match(await answer.innerText(), /2 things need you[\s\S]*Couldn't check failures, queues and billing right now\./);
    await until(async () => (await allRows()) === 2, 'bots and Twitch access rows still show');
    assert.equal(await page.locator('[data-ov-live-row]').count(), 2);
    assert.equal(await page.locator('.metrics .metric strong').first().innerText(), '412');
    assert.equal(await page.locator('app-ov-spend').count(), 0, 'no empty spend block after a failure');
    state.overviewFail = false;
    await page.locator('[data-ov-error]').getByRole('button', { name: 'Try again' }).click();
    await until(async () => (await allRows()) === 9, 'retry loads the overview');
    assert.equal(await page.locator('[data-ov-error]').count(), 0);

    // ...and the users summary failing must not hide the overview.
    state.usersFail = true;
    await open();
    await until(async () => (await allRows()) === 7, 'overview rows without the users summary');
    assert.match(await answer.innerText(), /7 things need you[\s\S]*Couldn't check bots and Twitch access right now\./);
    assert.equal(await stats.count(), 7);
    await page.getByText("Couldn't load who's live.").waitFor();
    state.usersFail = false;
    await answer.getByRole('button', { name: 'Try again' }).click();
    await until(async () => (await allRows()) === 9, 'retry brings the users summary back');

    // ---------- Layout and accessibility, dark first ----------
    state.overview = fullOverview();
    state.summary = summary();
    await page.clock.resume().catch(() => {});
    for (const mode of ['dark', 'light']) {
        await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
            await open();
            await until(async () => (await allRows()) === 9 && (await page.locator('[data-ov-recent] [data-feed-row]').count()) === recent.length, `${mode} ${width} loaded`);
            await page.waitForTimeout(700);
            assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
            const wide = await page.evaluate(() => [...document.querySelectorAll('app-dashboard-page *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className).slice(0, 5));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${mode} ${width} overflow: ${wide}`);
            const targets = page.locator('[data-ov-refresh], a[data-attention], app-ov-day .lf-stat, app-ov-spend .lf-bars__row, app-ov-spend .ovs-all, [data-busy-channel], .ov-more, [data-ov-live-row]');
            for (const target of await targets.all()) {
                const box = await target.boundingBox();
                assert.ok(box && box.height >= 43.5, `${mode} ${width}: 44px touch target (${await target.evaluate((el) => el.className)}: ${box?.height})`);
            }
            if (width === 1280) {
                const [left, right] = await page.locator('.lf-panels > .lf-col').evaluateAll((cols) => cols.map((col) => col.getBoundingClientRect().left));
                assert.ok(right > left + 300, 'two columns on desktop');
                assert.equal(await page.locator('.lf-panels > .lf-col').nth(0).locator('[data-ov-answer]').count(), 1, 'answer in the left column');
                assert.equal(await page.locator('.lf-panels > .lf-col').nth(1).locator('app-ov-spend').count(), 1, 'spend in the right column');
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(150);
            const axe = await new AxeBuilder({ page }).include('app-dashboard-page').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
            assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target) })), [], `${mode} ${width} axe`);
            await page.screenshot({ path: `${artifacts}/${mode}-${width}.png` });
        }
    }
    assert.equal(await page.locator('h1').count(), 1);
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(unexpected, [], 'no unexpected API calls');
    assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), [], "the page makes no other API calls than the shell's known read-only ones");
    assert.ok(calls.every((call) => !call.startsWith('GET /admin-site/users') || /limit=6&sortBy=liveViewers&sortOrder=desc/.test(call)), 'health keeps its users query');
    console.log('PASS admin console overview: answer with 9 attention rows worst first (plural + singular wording, every destination, gifts linking to /gifts?status=needs_support), all-clear and new-install zeros, 24-hour stats with problem links and hidden empty kinds, AI spend with credits, dollar value and "not recorded" provider cost, two 14-day charts, busiest channels, feed preview, live counters from the stream, partial notice, overview failing while health/live render and the reverse, refresh keeps numbers, no stacked requests, 30 s auto-refresh paused while hidden, 320/390/1280 px in dark and light with axe, overflow and 44px targets');
} catch (error) {
    if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
    console.error('Last calls:', calls.slice(-8));
    throw error;
} finally {
    await browser.close();
}
