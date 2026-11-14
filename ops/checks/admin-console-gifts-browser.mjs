// Admin "Gifted credits" page (/gifts). Every API call is mocked: nothing reaches production.
// Covers the answer line for each mix of states (paid and stuck, on the way, all delivered, nobody paid, none),
// chip counts and filtering (the request's status), the channel filter (URL login, picker, clear chip),
// Back restoring filters, rows per state (chips + meta with credits, dollar value and price), the sheet per
// state (answer, timeline, facts, Polar references with Copy), an old unpaid "needs_support" shown as never
// paid with no retry, the deep link ?gift= (from the list, fetched on its own, unknown id), Reload, "Try again
// now" confirmed first then POSTed (success refreshes the row; 409 shows the API's message), load more with
// the cursor, list errors with Retry, the Overview attention row linking here, and layout + accessibility at
// 320/390/1280 px (dark first, then light) with axe and no horizontal overflow.
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4393), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright),
// SAAS_SCREENSHOTS (screenshot folder).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4393';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-gifts';
fs.mkdirSync(artifacts, { recursive: true });
const TOKEN = 'disposable-gifts-fixture';

// ---------- Fixtures (fictional names only) ----------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const inMin = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);
const uuid = (n, part) => `${part}${String(n).padStart(7, '0')}-4a5b-4c3d-9e8f-00${String(n).padStart(10, '0')}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const CH = {
    pixel: { login: 'pixel_harbor', channelID: '700000001' },
    luna: { login: 'luna_plays', channelID: '700000002' },
    cozy: { login: 'cozy_kiln', channelID: '700000003' },
    retro: { login: 'retro_orbit', channelID: '700000004' },
};
const to = (channel) => ({ login: channel.login, displayName: channel.login, channelID: channel.channelID });
const gift = (n, extra) => ({
    id: hex(n), status: 'delivered', paid: true, buyer: CH.pixel, recipient: to(CH.luna),
    credits: 250_000, creditsUSD: 2.5, priceAmount: 500, priceCurrency: 'usd',
    createdAt: ago(3000 + n), paidAt: ago(2990 + n), deliveryStartedAt: ago(2980 + n), deliveredAt: ago(2970 + n), expiredAt: null,
    announcedAt: ago(2960 + n), announcementStoppedAt: null, announcementAttempts: 1, attempts: 0, lastError: null, nextAttemptAt: null, processing: false,
    refs: { checkoutId: uuid(n, 'c'), paidOrderId: uuid(n, 'b'), deliveryCheckoutId: uuid(n, 'd'), deliveryOrderId: uuid(n, 'e'), grantId: uuid(n, 'f') },
    ...extra,
});
const noDelivery = { deliveryStartedAt: null, deliveredAt: null, announcedAt: null, announcementAttempts: 0 };
const unpaidRefs = (n) => ({ checkoutId: uuid(n, 'c'), paidOrderId: null, deliveryCheckoutId: null, deliveryOrderId: null, grantId: null });
const STUCK = gift(1, {
    status: 'needs_support', createdAt: ago(120), paidAt: ago(118), deliveryStartedAt: ago(117), deliveredAt: null, announcedAt: null, announcementAttempts: 0,
    attempts: 7, lastError: 'Polar order create failed: 502 Bad Gateway', nextAttemptAt: inMin(20),
    refs: { checkoutId: uuid(1, 'c'), paidOrderId: uuid(1, 'b'), deliveryCheckoutId: uuid(1, 'd'), deliveryOrderId: null, grantId: null },
});
const MOVING = gift(2, {
    status: 'delivering', buyer: CH.cozy, recipient: to(CH.retro), credits: 1_000_000, creditsUSD: 10, priceAmount: 1800, createdAt: ago(60), paidAt: ago(58),
    ...noDelivery, deliveryStartedAt: ago(57), attempts: 1, lastError: 'Polar request timed out', nextAttemptAt: inMin(10),
    refs: { checkoutId: uuid(2, 'c'), paidOrderId: uuid(2, 'b'), deliveryCheckoutId: uuid(2, 'd'), deliveryOrderId: null, grantId: null },
});
const ANNOUNCED = gift(3, { buyer: { login: 'mossy_fern', channelID: null }, recipient: to(CH.pixel), createdAt: ago(9000), paidAt: ago(8990), deliveredAt: ago(8980), announcedAt: ago(8970) });
const UNANNOUNCED = gift(4, { buyer: CH.luna, recipient: to(CH.cozy), createdAt: ago(7000), paidAt: ago(6990), deliveredAt: ago(6980), announcedAt: null, announcementStoppedAt: ago(6900), announcementAttempts: 5 });
const AWAITING = gift(5, { status: 'awaiting_payment', paid: false, buyer: { login: 'quiet_comet', channelID: '700000005' }, createdAt: ago(30), paidAt: null, ...noDelivery, nextAttemptAt: inMin(5), refs: unpaidRefs(5) });
const EXPIRED = gift(6, { status: 'expired', paid: false, buyer: CH.retro, recipient: to(CH.pixel), createdAt: ago(2900), paidAt: null, ...noDelivery, expiredAt: ago(1460), refs: unpaidRefs(6) });
// Before 2026-11-13 transient Polar errors flagged unpaid gifts "needs_support". Payment is not confirmed either way.
const LEGACY = gift(7, {
    status: 'needs_support', paid: false, buyer: { login: 'sunny_tern', channelID: '700000007' }, createdAt: ago(4400), paidAt: null, ...noDelivery,
    attempts: 5, lastError: 'Polar checkout lookup failed: 503', nextAttemptAt: inMin(10), refs: unpaidRefs(7),
});
const MIX = [STUCK, MOVING, ANNOUNCED, UNANNOUNCED, AWAITING, EXPIRED, LEGACY];

// ---------- Mock API (mirrors dimabot/src/server/routes/admin_site/gifts.route.ts) ----------
const MATCH = {
    needs_support: (g) => g.status === 'needs_support' && g.paid,
    in_progress: (g) => ['payment_received', 'delivering'].includes(g.status),
    awaiting_payment: (g) => ['awaiting_payment', 'needs_support'].includes(g.status) && !g.paid,
    delivered: (g) => g.status === 'delivered',
    expired: (g) => g.status === 'expired',
    all: () => true,
};
const inScope = (g, channel) => !channel || [g.recipient.channelID, g.recipient.login, g.buyer.channelID, g.buyer.login].includes(channel);
const newest = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const state = { gifts: MIX.map((g) => ({ ...g })), listFail: false, retry: { status: 200 }, notFound: new Set() };
const requests = [];
const unexpected = [];
const pageErrors = [];
const otherCalls = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3000');
const overview = {
    generatedAt: ago(0), day: { from: ago(1440), to: ago(0), kinds: [], activeChannels: 3, credits: 0, providerUSD: 0 }, daily: [], features: [], topChannels: [],
    attention: [{ key: 'gifts_need_support', count: 1 }], recent: [], partial: [],
};
const usersSummary = { totalChannels: 4, activeBots: 4, inactiveBots: 0, withPermissions: 4, permissionsNeedUpdate: 0, liveChannels: 0, liveViewers: 0, totalCommands: 10, totalEventsubsActive: 4, totalEventsubsDisabled: 0 };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    await context.addInitScript((token) => {
        localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token, createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
            appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
        if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
        window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
    }, TOKEN);
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
        if (!isApi(url)) { unexpected.push(`${request.method()} ${url.href}`); return route.abort(); }
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const json = (data, status = 200, message = 'ok') => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify({ error: status >= 400, message, status, data }) });
        const method = request.method();
        const path = url.pathname;
        if (path.startsWith('/admin-site/gifts')) {
            requests.push({ method, path, query: url.searchParams });
            assert.equal(request.headers().authorization, `Bearer ${TOKEN}`, 'gift requests carry the admin session');
        }
        if (method === 'GET' && path === '/admin-site/gifts') {
            if (state.listFail) return json(null, 500, 'boom');
            const status = url.searchParams.get('status') || 'all';
            const channel = url.searchParams.get('channel');
            const limit = Number(url.searchParams.get('limit') || 25);
            const offset = url.searchParams.get('cursor') ? Number(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString()) : 0;
            const scoped = state.gifts.filter((g) => inScope(g, channel)).sort(newest);
            const matching = scoped.filter(MATCH[status]);
            const counts = Object.fromEntries(Object.entries(MATCH).map(([key, test]) => [key, scoped.filter(test).length]));
            const rows = matching.slice(offset, offset + limit);
            const next = offset + limit < matching.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
            return json({ rows, next, counts });
        }
        const one = /^\/admin-site\/gifts\/([a-f0-9]{64})(\/retry)?$/.exec(path);
        if (one) {
            const found = state.gifts.find((g) => g.id === one[1]);
            if (!found || state.notFound.has(one[1])) return json(null, 404, 'Gift not found');
            if (method === 'GET' && !one[2]) return json(found);
            if (method === 'POST' && one[2]) {
                if (state.retry.status !== 200) return json(null, state.retry.status, state.retry.message);
                found.nextAttemptAt = new Date().toISOString();
                return json(found, 200, 'The bot will try this gift again within a few seconds');
            }
        }
        if (method === 'GET' && path === '/admin-site/overview') return json(overview);
        if (method === 'GET' && path === '/admin-site/users') {
            const search = url.searchParams.get('search');
            const rows = search ? Object.values(CH).filter((c) => c.login.includes(search)).map((c) => ({ channelID: c.channelID, channel: c.login, isLive: false, plan_tier: 'free' })) : [];
            return json({ rows, pagination: { page: 1, limit: 6, total: rows.length, totalPages: 1 }, summary: usersSummary });
        }
        if (method === 'GET' && path === '/config/site/analytics') return json({ registeredUsers: 4, liveUsers: 0, authorizedAccounts: 4, totalMessages: 10, totalCommands: 5, totalLiveViewers: 0 });
        otherCalls.push(`${method} ${path}`);
        if (method !== 'GET') { unexpected.push(`${method} ${path}`); return route.abort(); }
        return json({});
    });

    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR|status of 40[49]/.test(message.text())) pageErrors.push(message.text()); });
    const until = async (check, label, tries = 100) => {
        for (let i = 0; i < tries; i++) { if (await check().catch(() => false)) return; await page.waitForTimeout(100); }
        throw new Error(`Timeout: ${label}`);
    };
    const settle = () => page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
    const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
    const answer = page.locator('[data-gifts-answer]');
    const rows = page.locator('[data-gift]');
    const sheet = page.locator('[data-gift-sheet]');
    const sheetAnswer = sheet.locator('[data-gift-answer]');
    const confirm = page.locator('dialog.confirm');
    const listCalls = () => requests.filter((r) => r.method === 'GET' && r.path === '/admin-site/gifts');
    const lastList = () => listCalls().at(-1);
    const getCalls = (id) => requests.filter((r) => r.method === 'GET' && r.path === `/admin-site/gifts/${id}`).length;
    const retryCalls = (id) => requests.filter((r) => r.method === 'POST' && r.path === `/admin-site/gifts/${id}/retry`).length;
    const query = () => new URL(page.url()).searchParams;
    const open = async (path = '/gifts', settled = async () => (await answer.count()) > 0) => {
        await page.goto(`${base}${path}`);
        await page.locator('h1').waitFor({ timeout: 60000 });
        await until(settled, `${path} loaded`);
        await settle();
    };
    const rowOf = (g) => page.locator(`[data-gift="${g.id}"]`);
    const chip = (key) => page.locator(`[data-chip="${key}"]`);
    const openSheet = async (g) => {
        await rowOf(g).click();
        await sheet.waitFor({ state: 'visible' });
        await until(async () => (await sheetAnswer.count()) > 0 && query().get('gift') === g.id, `sheet for ${g.id.slice(0, 4)}`);
        await settle();
    };
    const closeSheet = async () => {
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        await until(async () => !query().get('gift'), 'gift leaves the URL');
    };
    const shot = (name) => page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: false });

    // ---------- The mix: one paid gift is stuck, so that is the answer ----------
    await open('/gifts', async () => (await rows.count()) === MIX.length);
    assert.equal(await page.locator('h1').innerText(), 'Gifted credits');
    assert.match(await text(page.locator('.lf-head')), /Credit packs people bought for another channel: paid, delivered and announced in chat\./);
    assert.equal(await answer.getAttribute('data-tone'), 'danger');
    assert.match(await text(answer), /^1 paid gift didn't arrive Someone paid and the credits never reached the streamer\. Open one to see where it stopped\./);
    let req = lastList();
    assert.equal(req.query.get('status'), null, 'All sends no status');
    assert.equal(req.query.get('limit'), '25');
    assert.equal(req.query.get('channel'), null);
    const chipTexts = await page.locator('[data-chip]').evaluateAll((list) => list.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(chipTexts, ['All 7', 'Needs you 1', 'On the way 1', 'Waiting for payment 2', 'Delivered 2', 'Never paid 1'], 'chip counts; an old unpaid needs_support counts as waiting for payment');
    assert.equal(await chip('all').getAttribute('aria-pressed'), 'true');
    assert.ok(await chip('needs_support').evaluate((el) => el.classList.contains('gp-chip--danger')), 'Needs you is red while something is stuck');
    // Rows: newest first, chips and the meta line per state.
    assert.deepEqual(await rows.evaluateAll((list) => list.map((el) => el.dataset.gift)), [...MIX].sort(newest).map((g) => g.id), 'newest first');
    // The visible arrow is decoration (aria-hidden); screen readers hear "to".
    const row = async (g) => (await text(rowOf(g))).replace('→ ', '');
    assert.match(await row(STUCK), new RegExp(`^pixel_harbor to luna_plays Needs you 250,000 credits · \\$2\\.50 value · paid \\$5\\.00 · ${day(STUCK.paidAt)}$`));
    assert.match(await row(MOVING), /^cozy_kiln to retro_orbit On the way 1,000,000 credits · \$10\.00 value · paid \$18\.00 · /);
    assert.match(await row(ANNOUNCED), /^mossy_fern to pixel_harbor Delivered 250,000 credits/);
    assert.match(await row(UNANNOUNCED), /Delivered Not announced/);
    assert.match(await row(AWAITING), new RegExp(`Waiting for payment 250,000 credits · \\$2\\.50 value · checkout opened ${day(AWAITING.createdAt)} · not paid yet$`));
    assert.match(await row(EXPIRED), new RegExp(`Never paid Checkout expired ${day(EXPIRED.expiredAt)} · never paid$`));
    assert.match(await row(LEGACY), new RegExp(`^sunny_tern to luna_plays Payment not confirmed .+ checkout opened ${day(LEGACY.createdAt)} · payment not confirmed$`), 'an old unpaid needs_support reads as payment not confirmed');
    assert.equal((await row(LEGACY)).includes('Needs you'), false);
    await shot('list-dark-390');

    // ---------- Chips filter the request; Back restores the filter ----------
    await answer.getByRole('button', { name: 'Show it' }).click();
    await until(async () => query().get('status') === 'needs_support' && (await rows.count()) === 1, 'needs_support filter');
    assert.equal(lastList().query.get('status'), 'needs_support');
    assert.equal(await chip('needs_support').getAttribute('aria-pressed'), 'true');
    assert.equal(await answer.locator('[data-gifts-show]').count(), 0, 'no "show it" while already filtered');
    assert.match(await text(page.locator('#gp-list-h')), /Needs you/);
    await chip('expired').click();
    await until(async () => query().get('status') === 'expired' && (await rows.count()) === 1 && (await rows.first().getAttribute('data-gift')) === EXPIRED.id, 'expired filter');
    assert.equal(lastList().query.get('status'), 'expired');
    await chip('awaiting_payment').click();
    await until(async () => (await rows.count()) === 2, 'awaiting filter');
    assert.equal(lastList().query.get('status'), 'awaiting_payment');
    await chip('in_progress').click();
    await until(async () => (await rows.count()) === 1 && (await rows.first().getAttribute('data-gift')) === MOVING.id, 'in progress filter');
    await chip('delivered').click();
    await until(async () => (await rows.count()) === 2, 'delivered filter');
    await chip('delivered').click();
    await until(async () => !query().get('status') && (await rows.count()) === MIX.length, 'tapping the pressed chip shows all again');
    await page.goBack();
    await until(async () => query().get('status') === 'delivered' && (await rows.count()) === 2, 'Back restores Delivered');
    assert.equal(await chip('delivered').getAttribute('aria-pressed'), 'true');
    await page.goBack();
    await until(async () => query().get('status') === 'in_progress' && (await rows.count()) === 1, 'Back again restores On the way');

    // ---------- The sheet, state by state ----------
    await open('/gifts', async () => (await rows.count()) === MIX.length);
    const getsBefore = requests.filter((r) => r.method === 'GET' && r.path !== '/admin-site/gifts').length;
    await openSheet(STUCK);
    assert.equal(requests.filter((r) => r.method === 'GET' && r.path !== '/admin-site/gifts').length, getsBefore, 'a gift from the list opens without another request');
    assert.equal(await text(sheet.locator('#gs-h')), 'Gift for luna_plays');
    assert.match(await text(sheetAnswer), new RegExp(`Needs you Paid on ${day(STUCK.paidAt)}, but delivery stopped: Polar order create failed: 502 Bad Gateway\\. The bot keeps retrying, at most 30 minutes apart\\.$`));
    const steps = async () => sheet.locator('[data-step]').evaluateAll((list) => list.map((el) => `${el.dataset.step}:${el.dataset.state}`));
    assert.deepEqual(await steps(), ['opened:done', 'paid:done', 'started:done', 'delivered:stuck', 'announced:todo']);
    assert.match(await text(sheet.locator('[data-step="delivered"]')), /Credits delivered Stopped here/);
    const facts = sheet.locator('[data-gift-facts]');
    assert.match(await text(facts), /Buyer pixel_harbor Recipient luna_plays Pack 250,000 credits · \$2\.50 value Price \$5\.00 before tax Failed attempts at this step 7 Next check in (19|20) min Last error Polar order create failed: 502 Bad Gateway/);
    assert.equal(await sheet.locator('[data-gift-buyer]').getAttribute('href'), '/channels/700000001');
    assert.equal(await sheet.locator('[data-gift-recipient]').getAttribute('href'), '/channels/700000002');
    assert.equal(await sheet.locator('[data-gift-last-error]').evaluate((el) => getComputedStyle(el).fontFamily.includes('monospace') || /mono|Menlo|Consolas/.test(getComputedStyle(el).fontFamily)), true, 'the error is monospace');
    // Polar references, each with its own Copy button.
    assert.match(await text(sheet.locator('[data-gift-refs]')), new RegExp(`Checkout ${uuid(1, 'c')} Copy Order \\(the payment\\) ${uuid(1, 'b')} Copy Delivery checkout ${uuid(1, 'd')} Copy Gift id \\(ours\\) ${STUCK.id} Copy`));
    await sheet.getByRole('button', { name: 'Copy order id' }).click();
    await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === STUCK.refs.paidOrderId, 'order id copied');
    assert.match(await text(sheet.getByRole('button', { name: 'Copy order id' })), /Copied/);
    await sheet.getByRole('button', { name: 'Copy gift id' }).click();
    await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === STUCK.id, 'gift id copied');
    await shot('sheet-stuck-dark-390');

    // "Try again now": confirmed first; Cancel sends nothing.
    const retryButton = sheet.locator('[data-gift-retry]');
    assert.equal(await text(retryButton), 'Try again now');
    await retryButton.click();
    await confirm.waitFor({ state: 'visible' });
    assert.match(await text(confirm), /Try delivering this gift now\? .*The bot runs the next delivery step right away instead of waiting for its retry timer\. It re-checks the payment first and never delivers twice\./);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'hidden' });
    assert.equal(await sheet.isVisible(), true, 'cancelling keeps the sheet open');
    assert.equal(retryCalls(STUCK.id), 0, 'cancel never retries');
    await retryButton.click();
    await confirm.getByRole('button', { name: 'Try again now' }).click();
    await until(async () => retryCalls(STUCK.id) === 1, 'retry POST');
    await sheet.locator('[data-gift-result]').waitFor();
    assert.equal(await text(sheet.locator('[data-gift-result]')), 'The bot will try this gift again within a few seconds');
    await confirm.waitFor({ state: 'hidden' });
    await until(async () => (await text(sheet.locator('[data-gift-next]'))) === 'any moment now', 'the row refreshes from the reply');
    // A 409 shows the API's own words and reloads the gift.
    state.retry = { status: 409, message: 'The bot is working on this gift right now. Check again in a minute.' };
    const getsAtConflict = getCalls(STUCK.id);
    await retryButton.click();
    await confirm.getByRole('button', { name: 'Try again now' }).click();
    await until(async () => (await text(sheet.locator('[data-gift-result]'))) === 'The bot is working on this gift right now. Check again in a minute.', '409 message');
    assert.equal(await sheet.locator('[data-gift-result]').getAttribute('data-tone'), 'danger');
    await until(async () => getCalls(STUCK.id) === getsAtConflict + 1, 'a refused retry reloads the gift');
    state.retry = { status: 200 };
    await closeSheet();
    assert.equal(await rows.count(), MIX.length, 'closing keeps the list');

    // The old unpaid needs_support: payment not confirmed (not proven unpaid), no retry.
    await openSheet(LEGACY);
    assert.match(await text(sheetAnswer), /^Payment not confirmed yet\. The checkout opened on .+, and the bot couldn't check it with Polar .+ It keeps checking: if the buyer paid, delivery starts on its own; if the checkout expired unpaid, it becomes Never paid\.$/);
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 0, 'no "Try again now" for a gift nobody paid');
    assert.equal((await text(sheet)).includes('Needs you'), false);
    assert.deepEqual(await steps(), ['opened:done', 'unpaid:now']);
    assert.match(await text(sheet.locator('[data-gift-price]')), /^\$5\.00 before tax, no payment received yet$/);
    await closeSheet();

    await openSheet(EXPIRED);
    assert.match(await text(sheetAnswer), new RegExp(`^Never paid\\. The checkout expired on ${day(EXPIRED.expiredAt)} without a payment, so nothing is owed\\.$`));
    assert.deepEqual(await steps(), ['opened:done', 'expired:stopped']);
    assert.match(await text(sheet.locator('[data-step="expired"]')), /Checkout expired, no payment/);
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 0);
    assert.equal(await sheet.locator('[data-gift-next]').count(), 0, 'nothing left to check');
    await shot('sheet-expired-dark-390');
    await closeSheet();

    await openSheet(ANNOUNCED);
    assert.match(await text(sheetAnswer), new RegExp(`^Delivered Delivered on ${day(ANNOUNCED.deliveredAt)} and announced in chat\\.$`));
    assert.deepEqual(await steps(), ['opened:done', 'paid:done', 'started:done', 'delivered:done', 'announced:done']);
    assert.match(await text(facts), /Buyer mossy_fern \(no Twitch channel\)/);
    assert.equal(await sheet.locator('[data-gift-buyer]').count(), 0, 'no channel link for a buyer without a channel');
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 0);
    await closeSheet();

    await openSheet(UNANNOUNCED);
    assert.match(await text(sheetAnswer), /Delivered, but the chat announcement was stopped \(held by chat moderation or failed 5 times\)\./);
    assert.deepEqual(await steps(), ['opened:done', 'paid:done', 'started:done', 'delivered:done', 'announced:stopped']);
    assert.match(await text(facts), /Failed chat announcement tries 5/);
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 0);
    await closeSheet();

    await openSheet(AWAITING);
    assert.match(await text(sheetAnswer), /^Waiting for the buyer to pay\./);
    assert.deepEqual(await steps(), ['opened:done', 'paid:now', 'started:todo', 'delivered:todo', 'announced:todo']);
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 0);
    await closeSheet();

    await openSheet(MOVING);
    assert.match(await text(sheetAnswer), /^On the way Paid; the bot is delivering it\. The last try failed; it tries again in \d+ min\.$/);
    assert.deepEqual(await steps(), ['opened:done', 'paid:done', 'started:done', 'delivered:now', 'announced:todo']);
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 1, 'a paid gift on its way can be pushed');
    // Reload shows "working on it" and hides the retry while the bot holds it.
    state.gifts.find((g) => g.id === MOVING.id).processing = true;
    await sheet.getByRole('button', { name: 'Reload this gift' }).click();
    await until(async () => (await text(sheet.locator('[data-gift-next]'))) === 'Working on it now', 'processing after reload');
    assert.equal(await sheet.locator('[data-gift-retry]').count(), 0, 'no retry while the bot works on it');
    assert.match(await text(sheetAnswer), /It's working on it right now\./);
    await closeSheet();
    state.gifts.find((g) => g.id === MOVING.id).processing = false;

    // ---------- Deep links ----------
    // In the list: no extra request.
    let before = getCalls(STUCK.id);
    await open(`/gifts?gift=${STUCK.id}`, async () => (await sheetAnswer.count()) > 0 && (await rows.count()) === MIX.length);
    assert.equal(getCalls(STUCK.id), before, 'a deep link to a listed gift uses the list row');
    assert.match(await text(sheetAnswer), /delivery stopped/);
    await closeSheet();
    // Not in the filtered list: fetched on its own.
    before = getCalls(STUCK.id);
    await open(`/gifts?status=delivered&gift=${STUCK.id}`, async () => (await sheetAnswer.count()) > 0);
    assert.equal(getCalls(STUCK.id), before + 1, 'a deep link outside the list is fetched by id');
    assert.match(await text(sheetAnswer), /Paid on .+, but delivery stopped/);
    assert.equal(await rows.count(), 2, 'the list keeps its filter');
    await shot('deep-link-dark-390');
    await closeSheet();
    assert.equal(query().get('status'), 'delivered', 'closing keeps the filter');
    // Unknown id.
    const ghost = hex(99);
    state.gifts.push(gift(99, {}));
    state.notFound.add(ghost);
    await open(`/gifts?gift=${ghost}&status=expired`, async () => (await sheet.locator('[data-gift-error]').count()) > 0);
    assert.match(await text(sheet.locator('[data-gift-error]')), /This gift doesn't exist, or the link is wrong\./);
    state.gifts.pop();
    await closeSheet();

    // ---------- Channel filter ----------
    await open('/gifts?channel=luna_plays', async () => (await rows.count()) === 4);
    assert.equal(lastList().query.get('channel'), 'luna_plays');
    assert.match(await text(page.locator('[data-channel-chip]')), /Only luna_plays/);
    assert.match(await text(answer), /1 paid gift didn't arrive/, 'counts follow the channel');
    assert.deepEqual(await page.locator('[data-chip]').evaluateAll((list) => list.map((el) => el.textContent.replace(/\s+/g, ' ').trim())),
        ['All 4', 'Needs you 1', 'On the way 0', 'Waiting for payment 2', 'Delivered 1', 'Never paid 0']);
    await page.locator('[data-channel-chip]').click();
    await until(async () => !query().get('channel') && (await rows.count()) === MIX.length, 'clear the channel');
    assert.equal(lastList().query.get('channel'), null);
    // The picker sets the channel id; the chip shows its name.
    await page.locator('[data-channel-open]').click();
    const channelSheet = page.locator('[data-channel-sheet]');
    await channelSheet.waitFor({ state: 'visible' });
    await channelSheet.getByLabel('Streamer').fill('cozy');
    await channelSheet.getByRole('button', { name: /cozy_kiln/ }).click();
    await until(async () => query().get('channel') === '700000003' && (await rows.count()) === 2, 'picked channel');
    assert.equal(lastList().query.get('channel'), '700000003');
    assert.match(await text(page.locator('[data-channel-chip]')), /Only cozy_kiln/);
    await channelSheet.waitFor({ state: 'hidden' });
    await chip('delivered').click();
    await until(async () => query().get('status') === 'delivered' && query().get('channel') === '700000003' && (await rows.count()) === 1, 'channel + status together');
    assert.equal(lastList().query.get('status'), 'delivered');
    assert.equal(lastList().query.get('channel'), '700000003');

    // ---------- Answers for other mixes ----------
    const answerFor = async (gifts, path = '/gifts') => {
        state.gifts = gifts.map((g) => ({ ...g }));
        await open(path, async () => (await answer.count()) > 0 && !(await answer.getAttribute('aria-busy') === 'true'));
        return text(answer);
    };
    assert.match(await answerFor([MOVING, ANNOUNCED, UNANNOUNCED, EXPIRED]), /^1 gift is on its way Paid; the bot is delivering the credits\. Also 2 delivered · 1 never paid \(the checkout expired\)\. Show it$/);
    assert.equal(await answer.getAttribute('data-tone'), 'accent');
    assert.match(await answerFor([ANNOUNCED, UNANNOUNCED, EXPIRED, { ...EXPIRED, id: hex(8) }, { ...EXPIRED, id: hex(9) }]), /^Every paid gift was delivered 2 delivered · 3 never paid \(the checkout expired\)$/);
    assert.equal(await answer.getAttribute('data-tone'), 'ok');
    assert.ok(await answer.evaluate((el) => el.classList.contains('lf-status--ok')));
    await shot('answer-ok-dark-390');
    assert.match(await answerFor([EXPIRED, AWAITING, LEGACY]), /^No payment received yet 1 never paid \(the checkout expired\) · 2 waiting for payment\.$/);
    assert.equal(await answer.getAttribute('data-tone'), 'muted');
    assert.match(await answerFor([]), /^No gifted credits yet When someone buys a credit pack for another channel, it shows up here\.$/);
    assert.match(await text(page.locator('[data-gifts-empty]')), /No gifted credits yet/);
    await answerFor([ANNOUNCED], '/gifts?status=needs_support');
    assert.match(await text(page.locator('[data-gifts-empty]')), /Nothing needs you No paid gift is stuck\. Show every gift/);

    // ---------- Errors keep filters and offer Retry ----------
    state.gifts = MIX.map((g) => ({ ...g }));
    state.listFail = true;
    await page.goto(`${base}/gifts?status=expired`);
    await page.locator('[data-gifts-error]').waitFor({ timeout: 60000 });
    assert.match(await text(page.locator('[data-gifts-error]')), /The gifts didn't load Your filters are kept\. Nothing was changed\. Retry/);
    assert.equal(await page.locator('[data-gifts-error]').getAttribute('role'), 'alert');
    state.listFail = false;
    await page.locator('[data-gifts-error]').getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await rows.count()) === 1, 'retry loads the list');
    assert.equal(lastList().query.get('status'), 'expired', 'retry keeps the filter');
    // A failed refresh keeps the list on screen.
    state.listFail = true;
    await page.locator('[data-gifts-refresh]').click();
    await page.locator('[data-gifts-stale]').waitFor();
    assert.equal(await rows.count(), 1, 'rows stay after a failed refresh');
    state.listFail = false;
    await page.locator('[data-gifts-stale]').getByRole('button', { name: 'Retry' }).click();
    await page.locator('[data-gifts-stale]').waitFor({ state: 'hidden' });

    // ---------- Load more uses the cursor ----------
    state.gifts = Array.from({ length: 30 }, (_, i) => gift(20 + i, { createdAt: ago(100 + i) }));
    await open('/gifts?status=delivered', async () => (await rows.count()) === 25);
    const first = lastList();
    assert.equal(first.query.get('cursor'), null);
    assert.equal(await page.locator('[data-gifts-more]').isVisible(), true);
    await page.locator('[data-gifts-more]').click();
    await until(async () => (await rows.count()) === 30, 'load more');
    const more = lastList();
    assert.equal(more.query.get('cursor'), Buffer.from('25').toString('base64url'), 'load more sends the cursor from the first page');
    assert.equal(more.query.get('status'), 'delivered', 'and keeps the filter');
    assert.equal(await page.locator('[data-gifts-more]').count(), 0, 'nothing more to load');
    await page.getByText("That's every gift that matches.").waitFor();

    // ---------- The Overview attention row now opens this page ----------
    state.gifts = MIX.map((g) => ({ ...g }));
    await page.goto(`${base}/dashboard`);
    const attention = page.locator('[data-attention="gifts_need_support"]');
    await attention.waitFor({ timeout: 60000 });
    assert.equal(await attention.evaluate((el) => el.tagName), 'A');
    assert.equal(decodeURIComponent(await attention.getAttribute('href')), '/gifts?status=needs_support');
    assert.match(await text(attention), /1 gifted credit purchase could not be delivered Someone paid and the credits never arrived\. .*Gifts/);
    await attention.click();
    await until(async () => new URL(page.url()).pathname === '/gifts' && query().get('status') === 'needs_support' && (await rows.count()) === 1, 'overview → gifts needing support');
    assert.equal(await chip('needs_support').getAttribute('aria-pressed'), 'true');

    // ---------- Layout and accessibility: dark first, then light ----------
    for (const mode of ['dark', 'light']) {
        await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
            await open('/gifts', async () => (await rows.count()) === MIX.length);
            assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
            const label = `${mode} ${width}`;
            const overflow = async (where) => {
                const wide = await page.evaluate(() => [...document.querySelectorAll('app-gifts-page *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.lf-strip')).map((el) => el.className).slice(0, 5));
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} ${where}: horizontal overflow ${wide}`);
            };
            await overflow('list');
            for (const target of await page.locator('[data-gift], [data-chip], [data-channel-open], [data-gifts-refresh], [data-gifts-show]').all()) {
                const box = await target.boundingBox();
                assert.ok(box && box.height >= 43.5, `${label}: 44px target (${await target.evaluate((el) => el.className)}: ${box?.height})`);
            }
            if (width === 1280) {
                const box = (selector) => rowOf(STUCK).locator(selector).boundingBox();
                const [who, meta, chips] = [await box('.gp-row__who'), await box('[data-gift-meta]'), await box('[data-gift-chips]')];
                assert.ok(Math.abs(who.y - meta.y) < 12 && meta.x > who.x + 100 && chips.x > meta.x + 100, 'desktop rows put who, what and the stage in columns on one line');
                const rowBox = await rowOf(STUCK).boundingBox();
                assert.ok(rowBox.height < 64, `desktop rows are one line (${rowBox.height})`);
            }
            if ((mode === 'light' && width === 1280) || (mode === 'dark' && width === 390)) {
                const axe = await new AxeBuilder({ page }).include('app-gifts-page').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
                assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target) })), [], `${label} list axe`);
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            await shot(`list-${mode}-${width}`);
            await openSheet(STUCK);
            await overflow('sheet');
            for (const target of await sheet.locator('button, a').all()) {
                const box = await target.boundingBox();
                if (box && box.width > 0) assert.ok(box.height >= 43.5 || (await target.evaluate((el) => el.matches('.gs-link'))), `${label} sheet: 44px target (${await target.evaluate((el) => el.className || el.textContent)}: ${box.height})`);
            }
            const sheetBox = await sheet.boundingBox();
            if (width < 640) assert.ok(Math.abs(sheetBox.y + sheetBox.height - (width === 1280 ? 900 : 844)) < 2, `${label}: bottom sheet on phones`);
            else assert.ok(sheetBox.y > 10 && sheetBox.x > 10, `${label}: centred card on desktop`);
            if ((mode === 'dark' && width === 390) || (mode === 'light' && width === 1280)) {
                const axe = await new AxeBuilder({ page }).include('[data-gift-sheet]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
                assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target) })), [], `${label} sheet axe`);
            }
            await shot(`sheet-${mode}-${width}`);
            await closeSheet();
        }
    }

    assert.deepEqual(unexpected, [], 'no unexpected API calls');
    assert.deepEqual(pageErrors, [], 'no page errors');
    assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), [], "only the shell's known read-only calls besides the mocked ones");
    assert.ok(requests.every((r) => r.method === 'GET' || /^\/admin-site\/gifts\/[a-f0-9]{64}\/retry$/.test(r.path)), 'the only write is the confirmed retry');
    console.log(`PASS admin gifted credits: answer per mix (stuck/on the way/all delivered/nobody paid/none), chip counts + filtering + Back, channel filter (URL login, picker, clear, with status), rows per state, sheet per state (answer, timeline, facts, Polar refs + copy), old unpaid needs_support shown as payment not confirmed without retry, deep links (listed, fetched by id, unknown), reload + processing, confirmed retry (cancel, success, 409 message), list error + stale refresh, load more with cursor, Overview row → /gifts?status=needs_support, 320/390/1280 dark+light overflow/44px/axe. Screenshots: ${artifacts}`);
} catch (error) {
    if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
    console.error('Last gift requests:', requests.slice(-6).map((r) => `${r.method} ${r.path}?${r.query}`));
    throw error;
} finally {
    await browser.close();
}
