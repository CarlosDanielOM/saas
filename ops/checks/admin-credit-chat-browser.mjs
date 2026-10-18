// All API calls are mocked; grants and announcements never reach production.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base);
const artifacts = process.env.SAAS_UI_ARTIFACTS || '/tmp/admin-credit-chat-browser';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    executablePath: process.env.SAAS_CHROMIUM_PATH || undefined });
const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
const failures = [], grants = [];
let chatFails = false, grantFails = false;
const user = { channelID: '9001', channel: 'creditfixture', email: 'fixture@example.test',
    plan_tier: 'pro', actived: true, chat_enabled: true, has_permissions: true,
    up_to_date_permissions: true, isLive: false, liveViewers: 0, commandsCount: 0,
    eventsubsActiveCount: 0, eventsubsDisabledCount: 0 };
const json = (route, body, status = 200) => route.fulfill({ status,
    contentType: 'application/json', body: JSON.stringify(body) });
await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.origin === new URL(base).origin) return route.continue();
    if (!['https://api.domdimabot.com', 'http://localhost:3000'].includes(url.origin)) return route.abort();
    if (path.endsWith('/ai-credits/grant')) {
        const body = JSON.parse(req.postData()); grants.push(body);
        if (grantFails) return json(route, { error: true, message: 'Mock grant failed' }, 502);
        return json(route, { error: false, data: { granted: body.credits,
            chatAnnouncement: body.announceInChat ? chatFails ? 'failed' : 'sent' : 'skipped',
            before: { used: 0, limit: 25000, balance: 25000 },
            after: { used: 0, limit: 25000 + body.credits, balance: 25000 + body.credits } } });
    }
    if (path.endsWith('/ai-credits')) return json(route, { data: { version: 1, used: 0,
        limit: 25000, balance: 25000, meterId: 'm', available: true } });
    if (path === '/admin-site/users') return json(route, { data: { rows: [user],
        pagination: { page: 1, totalPages: 1, total: 1 } } });
    if (path === '/users') return json(route, { data: { profile_image_url: `${base}/favicon.png` } });
    if (/\/(commands|eventsubs)$/.test(path)) return json(route, { data: { rows: [],
        pagination: { page: 1, total: 0, totalPages: 1 } } });
    for (const key of ['files', 'rewards', 'triggers', 'timers', 'memories']) {
        if (path.includes(`/${key}/`)) return json(route, { data: { [key]: [] } });
    }
    failures.push(`Unmocked API: ${req.method()} ${path}`);
    return route.abort();
});
await context.addInitScript(() => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token: 'dummy',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: { id: '533538623', login: 'fixture', display_name: 'Fixture' },
        appUser: { twitch_user_id: '533538623', name: 'fixture', plan_tier: 'free' } }));
});
const page = await context.newPage();
page.on('pageerror', err => failures.push(err.message));
const open = async () => {
    await page.getByRole('button', { name: 'Add credits', exact: true }).click();
    await page.locator('dialog[open]').waitFor();
};
const confirm = () => page.getByRole('dialog').getByRole('button', { name: /^Add .* credits$/ }).click();
const closed = () => page.locator('dialog[open]').waitFor({ state: 'hidden' });
try {
    for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(base);
        await page.evaluate(mode => localStorage.setItem('dima-admin.mode.v1', mode), theme);
        await page.goto(`${base}/channels/9001`);
        await open();
        assert.equal(await page.getByRole('checkbox', { name: 'Announce in chat' }).isChecked(), true);
        await page.getByText('A chat message will announce the added credits.', { exact: false }).waitFor();
        await page.addScriptTag({ path: process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
        const violations = await page.evaluate(async () => (await window.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
        assert.deepEqual(violations, [], `axe ${theme}/${width}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('dialog[open]').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        await page.screenshot({ path: `${artifacts}/grant-${theme}-${width}.png` });
        await page.getByRole('checkbox', { name: 'Announce in chat' }).uncheck();
        await page.getByText('No chat message will be sent.', { exact: false }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
        await closed();
    }
    assert.equal(grants.length, 0, 'cancelling never grants');
    await open();
    await confirm(); await closed();
    assert.equal(grants.at(-1).announceInChat, true);
    await page.getByText(/Announced in chat\./).waitFor();
    await open();
    await page.getByRole('checkbox', { name: 'Announce in chat' }).uncheck();
    await page.getByPlaceholder('e.g. bug reimbursement').fill('Private refund reason');
    await confirm(); await closed();
    assert.equal(grants.at(-1).announceInChat, false);
    assert.equal(grants.at(-1).reason, 'Private refund reason');
    await page.getByText(/No chat message sent\./).waitFor();
    chatFails = true;
    await open(); await confirm(); await closed();
    await page.getByText(/Chat announcement failed. Do not repeat the grant./).waitFor();
    assert.equal(grants.length, 3);
    grantFails = true;
    await open();
    await page.getByPlaceholder('e.g. bug reimbursement').fill('Keep this draft');
    await page.getByRole('checkbox', { name: 'Announce in chat' }).uncheck();
    await confirm();
    await page.getByText('Mock grant failed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'Announce in chat' }).isChecked(), false);
    assert.equal(await page.getByPlaceholder('e.g. bug reimbursement').inputValue(), 'Keep this draft');
    assert.deepEqual(failures, []);
    console.log(`PASS admin credits UI: default/skip/cancel, payload, grant and chat failures, draft retention, axe and layouts at 320/390/1280 dark/light. Screenshots: ${artifacts}`);
} catch (error) {
    console.error({ url: page.url(), failures });
    await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
    throw error;
} finally { await browser.close(); }
