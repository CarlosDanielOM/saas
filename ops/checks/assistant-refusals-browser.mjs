// Admin "Assistant refusals" page (Review → Assistant refusals). Every API call is mocked; the page is read only.
// Covers the status line, the cards (channel, who asked, plan, the message, steers, how it was declined, models,
// raw signals, partial answer and the context before it), the channel filter in the URL, paging, a failed load
// with Retry, the link both ways with the chat-protection review, and layout + accessibility at 320/390/1280 px
// in dark and light.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4202';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-assistant-refusals';
fs.mkdirSync(artifacts, { recursive: true });

const refusal = (n, extra = {}) => ({
    id: `r${n}`, at: new Date(Date.now() - n * 3_600_000).toISOString(), channelId: '533538623', channelLogin: 'cdom201', userId: '533538623', userLogin: 'cdom201',
    sessionId: `s${n}`, turnId: `t${n}`, step: 0, plan: 'pro', level: 'expert', model: 'anthropic/claude-haiku-5.5', fallbackModel: 'openai/gpt-6-luna',
    source: 'reply', finishReason: 'content_filter', nativeFinishReason: 'refusal', refusal: 'I can’t help with that.', detail: null,
    message: 'Make a !kill command that says the viewer got eliminated', steers: [], partial: 'Sure, here is a', recent: [
        { role: 'user', text: 'Make a !kill command that says the viewer got eliminated' },
        { role: 'assistant', text: '→ search_ast_functions({"query":"random user"})' },
        { role: 'tool', name: 'search_ast_functions', text: '{"functions":["$(random.chatter)"]}' },
    ], ...extra,
});
const all = [
    refusal(1, { steers: ['make it funny, not violent'] }),
    refusal(2, { channelId: '700000001', channelLogin: 'other_streamer', userId: '700000009', userLogin: 'mod_person', plan: 'premium', source: 'error', step: 2,
        finishReason: null, nativeFinishReason: null, refusal: 'OpenRouter 403: Your input was flagged', partial: null, recent: [],
        detail: { errorType: 'refusal', reasons: ['violence'], flaggedInput: 'eliminate ... viewers', providerName: 'Anthropic' } }),
];
const requests = [];
const unexpected = [];
const otherCalls = [];
let failNext = false;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
        localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'disposable-refusal-fixture', createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
            appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
    });
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
        if (url.hostname !== 'api.domdimabot.com') { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
        const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
        if (url.pathname === '/admin-site/assistant-refusals') {
            assert.equal(request.method(), 'GET', 'read only');
            assert.equal(request.headers().authorization, 'Bearer disposable-refusal-fixture');
            requests.push(url.search);
            if (failNext) { failNext = false; return json({ error: true }, 500); }
            const channel = url.searchParams.get('channel');
            const page = Number(url.searchParams.get('page') || '1');
            const rows = channel ? all.filter((row) => row.channelId === channel) : all;
            // Two pages of the same rows without a filter, to exercise the pager.
            return json({ data: { rows: page === 1 ? rows : [refusal(9)], pagination: { page, limit: 20, total: channel ? rows.length : 21, totalPages: channel ? 1 : 2 }, counts: { week: 2, total: 21 } } });
        }
        if (url.pathname === '/admin-site/moderation-reviews') return json({ data: { rows: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 }, counts: { contradiction: 0, near_miss: 0, ban: 0 } } });
        otherCalls.push(`${request.method()} ${url.pathname}`);
        if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        return json({ data: {} });
    });
    const page = await context.newPage();
    const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${label}`); };
    const cards = page.locator('[data-refusal-card]');

    // From the chat-protection review to the refusals: the status line answers "anything new?" first.
    await page.goto(`${base}/moderation-review`);
    await page.getByRole('link', { name: 'Assistant refusals' }).click();
    await cards.first().waitFor({ timeout: 60000 });
    assert.match(page.url(), /\/assistant-refusals$/);
    assert.match(await page.locator('[data-refusal-status]').innerText(), /2 refusals in the last 7 days[\s\S]*21 kept in all\. Each is kept 90 days/);
    assert.equal(await cards.count(), 2);
    assert.equal(await page.locator('.bottom-nav').getByRole('link', { name: 'Review', exact: true }).getAttribute('aria-current'), 'page', 'Review tab stays active');

    // A reply refusal: who, where, the question, what was added, how it was declined, models, partial answer, context.
    const first = cards.first();
    const firstText = await first.innerText();
    assert.match(firstText, /cdom201[\s\S]*asked by cdom201[\s\S]*pro/);
    assert.equal(await first.locator('[data-refusal-message]').innerText(), 'Make a !kill command that says the viewer got eliminated');
    assert.match(firstText, /Added while it worked:[\s\S]*make it funny, not violent/);
    assert.match(firstText, /It started answering, then the safety filter stopped it\./);
    assert.match(firstText, /anthropic\/claude-haiku-5\.5[\s\S]*openai\/gpt-6-luna[\s\S]*step 1/);
    assert.match(firstText, /finish: content_filter[\s\S]*provider: refusal[\s\S]*Refusal text I can’t help with that\./);
    await first.locator('summary', { hasText: 'What it had written before stopping' }).click();
    assert.match(await first.innerText(), /Sure, here is a/);
    await first.locator('summary', { hasText: 'What the assistant saw before (3 items)' }).click();
    assert.match(await first.locator('.ar-recent').innerText(), /STREAMER[\s\S]*ASSISTANT[\s\S]*search_ast_functions[\s\S]*TOOL RESULT · search_ast_functions[\s\S]*random\.chatter/i);

    // A request refused with an error: the moderation reasons and the flagged part.
    const second = cards.nth(1);
    assert.match(await second.innerText(), /other_streamer[\s\S]*asked by mod_person[\s\S]*premium/);
    assert.match(await second.innerText(), /The request was refused before any answer/);
    assert.match(await second.innerText(), /error type: refusal[\s\S]*reason: violence[\s\S]*Flagged part eliminate \.\.\. viewers/);
    assert.equal(await second.locator('details').count(), 0, 'nothing to expand without partial text or context');

    // Only one channel (kept in the URL), then back to all; paging.
    await second.getByRole('button', { name: 'Only this channel' }).click();
    await until(async () => (await cards.count()) === 1 && /channel=700000001/.test(page.url()), 'channel filter');
    assert.match(await page.locator('.ar-filter').innerText(), /Only channel other_streamer/);
    await page.getByRole('button', { name: 'Show all channels' }).click();
    await until(async () => (await cards.count()) === 2 && !/channel=/.test(page.url()), 'all channels');
    await page.getByRole('button', { name: 'Next' }).click();
    await until(async () => /page=2/.test(page.url()) && (await cards.count()) === 1, 'page 2');
    assert.match(await page.locator('.lf-pager__info').innerText(), /Page 2 of 2[\s\S]*21 refusals/);

    // A failed load keeps the filter and offers Retry.
    failNext = true;
    await page.goto(`${base}/assistant-refusals?channel=533538623`);
    await page.getByRole('alert').filter({ hasText: 'The refusals did not load' }).waitFor();
    await page.getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await cards.count()) === 1, 'retry');
    assert.ok(requests.filter((query) => /channel=533538623/.test(query)).length >= 2, 'retry keeps the filter');

    // Back to the chat-protection review from here.
    await page.getByRole('link', { name: 'Chat protection review' }).click();
    await until(async () => /\/moderation-review$/.test(page.url()), 'back to the review');

    // Layout and accessibility, dark first.
    for (const mode of ['dark', 'light']) {
        await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
            await page.goto(`${base}/assistant-refusals`);
            await until(async () => (await cards.count()) === 2, `${mode} ${width} cards`);
            for (const summary of await cards.first().locator('summary').all()) await summary.click();
            assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${mode} overflow at ${width}`);
            for (const button of await page.locator('.ar-page .lf-btn').all()) {
                assert.ok((await button.boundingBox()).height >= 31.5, `${mode} ${width}: button height`);
            }
            // At the top, like the other admin checks: the navbar is see-through, so its brand tag's contrast depends
            // on whatever is scrolled under it (a navbar trait on every page, not this page's).
            await page.evaluate(() => window.scrollTo(0, 0));
            const axe = await new AxeBuilder({ page }).include('app-assistant-refusals-page').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
            assert.deepEqual(axe.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${mode} ${width} axe`);
            await page.screenshot({ path: `${artifacts}/${mode}-${width}.png`, fullPage: true });
        }
    }
    assert.deepEqual(unexpected, []);
    assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), [], 'no other API calls than the shell\'s read-only ones');
    console.log('PASS admin assistant refusals: status line, cards (who, message, steers, how, models, signals, partial, context), channel filter in the URL, paging, failed load + retry, links with the chat-protection review, 320/390/1280 px in dark and light, accessibility');
} finally {
    await browser.close();
}
