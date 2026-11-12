// Admin "Chat protection review" page. Every API call is mocked: no verdict can reach production.
// Covers the status line, the three queues with counts and URL state, grouped copies with every
// chat that preceded them, the plain reason per card, saving/changing/removing a verdict on exactly
// the listed copies, a slow queue switch, failed loads and saves, and layout + accessibility at
// 320/390/1280 px in dark and light.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4202';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-moderation-review';
fs.mkdirSync(artifacts, { recursive: true });

const CAMPAIGN = 'Best viewers with streamboo .com';
let seq = 0;
const chat = [{ username: 'some_streamer', message: 'bienvenidos al stream', isBroadcaster: true }, { username: 'otro_viewer', message: 'jajaja que buena jugada', isBroadcaster: false }];
const row = (messageText, scores, extra = {}, latest = {}) => {
    const id = `d${++seq}`;
    return { messageText, invited: false, label: null, reviewedAt: null, ids: [id], count: 1, more: 0, channels: 1, withoutContext: 0,
        contexts: [{ copies: 1, channel: 'some_streamer', lines: chat }], ...extra,
        latest: { id, channelID: '700000001', channel: 'some_streamer', username: `viewer_${seq}`, createdAt: new Date(Date.now() - seq * 3_600_000).toISOString(),
            model: 'openai/gpt-6-luna-decisions-20261006', verdict: 'uncertain', status: 'uncertain', reviewSource: 'first_message', messageOrdinal: 1,
            consequence: { status: 'allowed_fallback', action: null, success: null }, thresholdPercent: 85, categories: ['spam', 'ads', 'self_promotion'], scores, ...latest } };
};
const queues = {
    contradiction: [row('🃏 Juega mis cartas en Streamloots: https://l.stls.to/eZdYnC', { spam: 0, ads: 0.99, self_promotion: 0.2, safe: 0.96, violation: 0.99 }, {}, { username: 'StreamlootsBot' })],
    near_miss: [
        row(CAMPAIGN, { spam: 0.64, ads: 0.7, self_promotion: 0.02, safe: 0.73, violation: 0.7 }, { ids: Array.from({ length: 44 }, (_, index) => `c${index}`), count: 44, more: 3, channels: 12, withoutContext: 34,
            contexts: [{ copies: 9, channel: 'some_streamer', lines: chat }, { copies: 1, channel: 'other_streamer', lines: [{ username: 'other_streamer', message: 'what did that bot say? copy it here', isBroadcaster: true }] }] }),
        // 84.96% must read as under the 85% bar, not as "85%".
        row('Oye banda, ando en directo, vayan a verme a mi canal, alli los espero y no se olviden de seguirme en todas mis redes sociales porfa', { spam: 0, ads: 0, self_promotion: 0.8496, safe: 0.22, violation: 0.8496 },
            { invited: true, contexts: [], withoutContext: 1 }, { messageOrdinal: 2 })
    ],
    ban: [
        row('Compra viewers en viewerstobuydotcom', { spam: 0.9, ads: 0.94, self_promotion: 0.19, safe: 0.09, violation: 0.94 }, {}, { verdict: 'violation', status: 'completed', consequence: { status: 'executed', action: 'ban', success: true } }),
        row('Sigan mi canal twitch.tv/otro', { spam: 0, ads: 0, self_promotion: 0.9, safe: 0.2, violation: 0.9 }, {}, { verdict: 'violation', status: 'completed', consequence: { status: 'cancelled', action: null, success: null } })
    ]
};
const puts = [];
const otherCalls = [];
let failNextGet = false, failNextPut = false, slowQueue = null;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
        localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'disposable-review-fixture', createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
            appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
    });
    const unexpected = [];
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
        if (url.hostname !== 'api.domdimabot.com') { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
        const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
        if (url.pathname === '/admin-site/moderation-reviews') {
            assert.equal(request.headers().authorization, 'Bearer disposable-review-fixture', 'every review request carries the admin session');
            if (request.method() === 'GET') {
                if (failNextGet) { failNextGet = false; return json({ error: true }, 500); }
                const kind = url.searchParams.get('kind'), state = url.searchParams.get('state');
                if (slowQueue === kind) await new Promise(resolve => setTimeout(resolve, 1500));
                const rows = queues[kind].filter(item => (state === 'pending') === (item.label === null));
                const counts = Object.fromEntries(Object.entries(queues).map(([key, list]) => [key, list.filter(item => item.label === null).length]));
                return json({ data: { rows, pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 }, counts } });
            }
            if (request.method() === 'PUT') {
                const body = JSON.parse(request.postData());
                puts.push(body);
                if (failNextPut) { failNextPut = false; return json({ error: true }, 500); }
                const item = queues[body.kind].find(entry => JSON.stringify(entry.ids) === JSON.stringify(body.ids));
                if (!item) return json({ error: true }, 404);
                item.label = body.label;
                item.reviewedAt = body.label ? new Date().toISOString() : null;
                return json({ data: { updated: item.count, label: body.label } });
            }
        }
        // The shell's own read-only calls (avatar lookups and the like) are answered empty, and listed below.
        otherCalls.push(`${request.method()} ${url.pathname}`);
        if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        return json({ data: {} });
    });
    const page = await context.newPage();
    const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${label}`); };
    const cards = page.locator('[data-review-card]');
    const status = page.locator('[data-review-status]');
    const toasts = () => page.locator('app-toast, .toast, [role=status], [role=alert]').allInnerTexts().then(items => items.join(' '));
    const queue = name => page.locator('.rv-kinds label').filter({ hasText: name });

    // Lands on contradictions, answers "does anything need me?" first.
    await page.goto(`${base}/moderation-review`);
    await cards.first().waitFor({ timeout: 60000 });
    assert.match(await status.innerText(), /5 messages are waiting for your verdict/);
    assert.equal(await cards.count(), 1);
    assert.match(await cards.first().innerText(), /Ads \/ sales scored 99%, over the 85% bar, but the overall check was only 4% \(it needs 30%\)\. Not banned\./);
    assert.match(await cards.first().innerText(), /some_streamer[\s\S]*StreamlootsBot[\s\S]*first message/);
    assert.equal(await page.locator('.rv-kinds input:checked + span').innerText().then(text => text.replace(/\s+/g, ' ').trim()), 'Contradictions 1');
    assert.equal(await page.locator('.bottom-nav').getByRole('link', { name: 'Review', exact: true }).getAttribute('aria-current'), 'page');

    // Near misses: one card for the copies of one line, with every chat that preceded them; the queue is kept in the URL.
    await queue('Near misses').click();
    await until(async () => await page.getByRole('radio', { name: /Near misses/ }).isChecked() && await cards.count() === 2, 'near misses listed');
    assert.match(page.url(), /kind=near_miss/);
    const campaign = cards.filter({ hasText: CAMPAIGN });
    assert.match(await campaign.locator('[data-review-copies]').innerText(), /44 copies · 12 channels/);
    assert.match(await campaign.innerText(), /Ads \/ sales scored 70%, under the 85% bar\. Not banned\./);
    assert.match(await campaign.locator('[data-review-more]').innerText(), /3 more copies came after other chat\. They stay in the queue/);
    assert.match(await campaign.locator('summary').innerText(), /Chat before the copies \(2 different chats, 34 with none\)/);
    await campaign.locator('summary').click();
    const chats = await campaign.locator('.rv-context').innerText();
    assert.match(chats, /In some_streamer · 9 copies[\s\S]*bienvenidos al stream[\s\S]*In other_streamer[\s\S]*what did that bot say\? copy it here[\s\S]*34 copies had no chat/);
    const invited = cards.nth(1);
    assert.match(await invited.innerText(), /second message/);
    assert.match(await invited.locator('[data-review-invited]').innerText(), /streamer had invited links/);
    assert.match(await invited.innerText(), /Self-promotion scored 84\.9%, under the 85% bar\. Not banned\./, 'compared on the stored score, never rounded up to the bar');
    assert.match(await invited.innerText(), /No chat in the minute before it\./);

    // A failed save says so and leaves the card where it was.
    failNextPut = true;
    await campaign.getByRole('button', { name: 'Should be a ban', exact: true }).click();
    await until(async () => /The verdict was not saved\. Try again\./.test(await toasts()), 'save error shown');
    assert.equal(await cards.count(), 2);
    assert.equal(await campaign.getByRole('button', { name: 'Should be a ban', exact: true }).isEnabled(), true);

    // One tap saves the verdict on exactly the copies the card listed; the card leaves "To review" and the count drops.
    await campaign.getByRole('button', { name: 'Should be a ban', exact: true }).click();
    await until(async () => await cards.count() === 1, 'answered card leaves the queue');
    assert.deepEqual(puts.at(-1), { kind: 'near_miss', ids: Array.from({ length: 44 }, (_, index) => `c${index}`), label: 'violation' });
    await until(async () => /4 messages are waiting/.test(await status.innerText()), 'count updated');
    assert.match(await toasts(), /Saved on 44 copies: should be a ban\./);
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-review-status')), true, 'focus moves to the status line when the card goes away');

    // Reviewed: the verdict is shown and can be changed or removed.
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await until(async () => await page.locator('[data-review-label]').count() === 1, 'reviewed list');
    assert.match(page.url(), /state=labelled/);
    assert.match(await page.locator('[data-review-label]').innerText(), /You said: should be a ban/);
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'reviewed card fits a 320px phone');
    const reviewedAxe = await new AxeBuilder({ page }).include('app-moderation-review-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(reviewedAxe.violations.map(item => item.id), [], 'reviewed card is accessible');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Change to "should not be a ban"' }).click();
    await until(async () => /should not be a ban/.test(await page.locator('[data-review-label]').innerText()), 'verdict changed');
    assert.equal(puts.at(-1).label, 'allow');
    await page.getByRole('button', { name: 'Remove verdict', exact: true }).click();
    await page.locator('[data-review-empty]').waitFor();
    assert.equal(puts.at(-1).label, null);
    assert.match(await page.locator('[data-review-empty]').innerText(), /No verdicts here yet/);
    await page.getByRole('button', { name: 'To review', exact: true }).click();
    await until(async () => await cards.count() === 2, 'back in the queue');

    // A slow queue: the other queue's cards are gone at once, so a verdict cannot land in the wrong queue.
    slowQueue = 'ban';
    await queue('Bans').click();
    await until(async () => await page.getByRole('radio', { name: /Bans/ }).isChecked(), 'bans selected');
    assert.equal(await cards.count(), 0, 'near-miss cards do not stay clickable while bans load');
    assert.equal(await page.getByRole('button', { name: 'Should be a ban', exact: true }).count(), 0);
    await until(async () => await cards.count() === 2, 'bans listed');
    slowQueue = null;
    const banned = cards.filter({ hasText: 'Compra viewers' });
    assert.match(await banned.innerText(), /The classifier said ban: Ads \/ sales scored 94% \(bar 85%\), overall check 91%\. The chatter was banned\./);
    assert.match(await cards.filter({ hasText: 'Sigan mi canal' }).innerText(), /The classifier said ban: Self-promotion scored 90% \(bar 85%\), overall check 80%\. The ban was cancelled before it ran\./);
    const before = puts.length;
    await banned.getByRole('button', { name: 'Should not be a ban', exact: true }).click();
    await until(async () => await cards.count() === 1, 'ban answered');
    assert.equal(puts.length, before + 1);
    assert.deepEqual(puts.at(-1), { kind: 'ban', ids: queues.ban[0].ids, label: 'allow' });

    // A link restores the view; a failed load says so, changes nothing and recovers with Retry.
    failNextGet = true;
    await page.goto(`${base}/moderation-review?kind=near_miss`);
    await page.getByText('The review queue did not load').waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await until(async () => await cards.count() === 2, 'retry loads');
    // The queue can be chosen from the keyboard.
    await page.getByRole('radio', { name: /Near misses/ }).focus();
    await page.keyboard.press('ArrowLeft');
    await until(async () => await page.getByRole('radio', { name: /Contradictions/ }).isChecked() && await cards.count() === 1, 'arrow key switches queue');

    // Layout and accessibility, dark first.
    for (const mode of ['dark', 'light']) {
        await page.evaluate(value => localStorage.setItem('dima-admin.mode.v1', value), mode);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
            await page.goto(`${base}/moderation-review?kind=near_miss`);
            await until(async () => await cards.count() === 2, `${mode} ${width} cards`);
            await cards.first().locator('summary').click();
            assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${mode} overflow at ${width}`);
            for (const button of await page.locator('.rv-btn, .rv-states .lf-chip, .rv-kinds span').all()) {
                assert.ok((await button.boundingBox()).height >= 43.5, `${mode} ${width}: 44px touch target`);
            }
            const axe = await new AxeBuilder({ page }).include('app-moderation-review-page').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
            assert.deepEqual(axe.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), [], `${mode} ${width} axe`);
            await page.screenshot({ path: `${artifacts}/${mode}-${width}.png`, fullPage: false });
        }
    }
    assert.equal(await page.locator('.nav__links').getByRole('link', { name: 'Review', exact: true }).getAttribute('aria-current'), 'page');
    assert.deepEqual(unexpected, []);
    assert.deepEqual([...new Set(otherCalls)].filter(call => !/^GET \/(users|auth\/|config\/)/.test(call)), [], 'the page makes no other API calls than the shell\'s known read-only ones');
    console.log('PASS admin chat protection review: status line, three queues with counts and URL state, grouped copies with every preceding chat, invitation flag, plain reasons on stored scores, save/change/remove verdict on the listed copies, failed save, slow queue switch, error and retry, keyboard, 320/390/1280 px in dark and light, accessibility');
} finally {
    await browser.close();
}
