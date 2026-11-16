// Admin System → Versions (/observability?tab=versions) and the Overview "old-version code" row. Every API call is
// mocked: nothing reaches production. Covers the answer line (removable / nothing yet / still collecting / nothing kept),
// one row per compatibility entry with its state chip (Can be removed / Still needed / Collecting data), who needs it,
// when an old page was last seen and when it can go, "Where the code is" with the code list, "Copy request for an
// agent" only on removable code (copied text, double-tap guard, "Copied" feedback, manual copy when the clipboard
// refuses), the versions in use (current/older tags, builds, connected now for OBS only, the 50-row cut note), loading
// error with Retry, a failed refresh keeping the last report, the owner-only 403, empty states, the header Refresh
// reloading the report without any analytics call, the Overview attention row (last, linking to ?tab=versions), and
// layout + accessibility at 320/375/1280 px (dark first, then light) with axe, 44px targets and no horizontal overflow.
// One browser, one page, no parallel workers.
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4394), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright),
// SAAS_SCREENSHOTS (screenshot folder).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4394';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-client-versions';
fs.mkdirSync(artifacts, { recursive: true });
const TOKEN = 'disposable-client-versions-fixture';

// ---------- Fixtures (mirror dimabot/src/overlays/client-versions.ts; ids and code lines from compat.ts) ----------
const NOW = Date.now();
const DAY = 86_400_000;
/** ISO time `days` ago (negative: in the future). */
const at = (days) => new Date(NOW - days * DAY).toISOString();
const SOUND = {
    id: 'overlay-legacy-sound', client: 'overlay', before: 1,
    summary: 'Alert designs also store `sound`, a copy of the first sound, because older OBS pages play only that one sound.',
    code: ['dimabot/src/overlays/store.ts: alertLayout() writes result.sound in design mode', 'dimabot/src/overlays/default-alerts.ts: the default designs write the same mirror'],
    state: 'removable', olderLastSeenAt: at(20), removableFrom: at(6),
};
const STUDIO = {
    id: 'studio-old-editor-sounds', client: 'studio', before: 2,
    summary: 'Saves without `writer` (Studio tabs opened before several sounds per alert) get their single `sound` edit merged into `sounds`.',
    code: ['dimabot/src/overlays/store.ts: the writer < 2 branch of alertLayout()'],
    state: 'needed', olderLastSeenAt: at(2 / 24), removableFrom: at(2 / 24 - 14),
};
const URLS = {
    id: 'overlay-library-urls', client: 'overlay', before: 1,
    summary: 'Published designs sent to OBS also carry the file URL of Dima library pictures and sounds, because older OBS pages only know URLs and Studio assets.',
    code: ['dimabot/src/overlays/store.ts: publicState() calls designsWithLibraryUrls()', 'dimabot/src/overlays/library.ts: layoutWithLibraryUrls() and designsWithLibraryUrls()'],
    state: 'collecting', olderLastSeenAt: null, removableFrom: at(-9),
};
const VERSIONS = [
    { client: 'overlay', protocol: 1, build: 'main-3f9a1c2b', firstSeenAt: at(3), lastSeenAt: at(0.001), connectedNow: 4, outdated: false },
    { client: 'studio', protocol: 2, build: 'main-3f9a1c2b', firstSeenAt: at(3), lastSeenAt: at(0.01), connectedNow: null, outdated: false },
    { client: 'studio', protocol: 1, build: 'unknown', firstSeenAt: at(25), lastSeenAt: at(2 / 24), connectedNow: null, outdated: true },
    { client: 'overlay', protocol: 0, build: 'before-protocol', firstSeenAt: at(30), lastSeenAt: at(20), connectedNow: 0, outdated: true },
];
// Sent in a different order than shown: the page puts removable code first.
const report = (extra = {}) => ({
    checkedAt: at(0), quietDays: 14, current: { overlay: 1, studio: 2 },
    trackingSince: { overlay: at(30), studio: at(25) },
    entries: [STUDIO, URLS, SOUND].map((entry) => ({ ...entry, code: [...entry.code] })),
    versions: VERSIONS.map((row) => ({ ...row })),
    ...extra,
});
const overview = {
    generatedAt: at(0), day: { from: at(1), to: at(0), kinds: [], activeChannels: 3, credits: 0, providerUSD: 0 }, daily: [], features: [], topChannels: [],
    attention: [{ key: 'compat_removable', count: 1 }, { key: 'failed_24h', count: 2 }], recent: [], partial: [],
};
const usersSummary = { totalChannels: 4, activeBots: 3, inactiveBots: 1, withPermissions: 4, permissionsNeedUpdate: 0, liveChannels: 0, liveViewers: 0, totalCommands: 10, totalEventsubsActive: 4, totalEventsubsDisabled: 0 };

// ---------- Mock API ----------
const state = { report: report(), fail: 0, delay: 0 };
const versionCalls = [];
const analyticsCalls = [];
const otherCalls = [];
const unexpected = [];
const pageErrors = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3000');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    await context.addInitScript((token) => {
        localStorage.setItem('dima-admin.session.v1', JSON.stringify({ version: 2, token, createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
            appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' } }));
        if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
        window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
        // Counts clipboard writes (the double-tap guard) and lets the check make the clipboard refuse.
        window.__copies = 0;
        window.__clipboardFail = false;
        const clipboard = navigator.clipboard;
        if (clipboard) {
            const write = clipboard.writeText.bind(clipboard);
            clipboard.writeText = (text) => {
                window.__copies++;
                return window.__clipboardFail ? Promise.reject(new Error('denied')) : write(text);
            };
        }
    }, TOKEN);
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
        if (!isApi(url)) { unexpected.push(`${request.method()} ${url.href}`); return route.abort(); }
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const raw = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
        const json = (data, status = 200, message = 'ok') => raw({ error: status >= 400, message, status, data });
        const method = request.method();
        const path = url.pathname;
        if (path.startsWith('/observability/api/')) {
            analyticsCalls.push(`${method} ${path}`);
            // The owner's analytics session (raw body, like the analytics service). Nothing else is expected here.
            if (method === 'GET' && path === '/observability/api/session') return raw({ grant: { role: 'owner', channels: [], services: [] }, channelNames: {} });
            return raw({});
        }
        if (path === '/admin-site/client-versions') {
            versionCalls.push(method);
            assert.equal(request.headers().authorization, `Bearer ${TOKEN}`, 'the report request carries the admin session');
            if (method !== 'GET') { unexpected.push(`${method} ${path}`); return route.abort(); }
            if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
            if (state.fail === 403) return json(null, 403, 'You do not have permission to access this endpoint');
            if (state.fail) return json(null, state.fail, 'boom');
            return json(state.report);
        }
        if (method === 'GET' && path === '/admin-site/overview') return json(overview);
        if (method === 'GET' && path === '/admin-site/users') return json({ rows: [], pagination: { page: 1, limit: 6, total: 0, totalPages: 1 }, summary: usersSummary });
        if (method === 'GET' && path === '/config/site/analytics') return json({ registeredUsers: 4, liveUsers: 0, authorizedAccounts: 4, totalMessages: 10, totalCommands: 5, totalLiveViewers: 0 });
        otherCalls.push(`${method} ${path}`);
        if (method !== 'GET') { unexpected.push(`${method} ${path}`); return route.abort(); }
        return json({});
    });

    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR|status of 40[34]|status of 50\d/.test(message.text())) pageErrors.push(message.text()); });
    const until = async (check, label, tries = 100) => {
        for (let i = 0; i < tries; i++) { if (await check().catch(() => false)) return; await page.waitForTimeout(100); }
        throw new Error(`Timeout: ${label}`);
    };
    const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
    const shot = (name) => page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
    const answer = page.locator('[data-versions-answer]');
    const entries = page.locator('[data-compat-entry]');
    const rows = page.locator('[data-version-row]');
    const entry = (id) => page.locator(`[data-compat-entry="${id}"]`);
    const copyButton = (id) => entry(id).locator('[data-copy-request]');
    const refresh = page.locator('button.obs-refresh');
    const versionsTab = page.getByRole('button', { name: 'Versions', exact: true });
    const open = async (path = '/observability?tab=versions', settled = async () => (await answer.count()) > 0) => {
        await page.goto(`${base}${path}`);
        await page.locator('h1').waitFor({ timeout: 60000 });
        await until(settled, `${path} loaded`);
    };
    const openCode = async (id) => {
        await entry(id).locator('[data-compat-code] > summary').click();
        await until(async () => entry(id).locator('[data-compat-code]').evaluate((el) => el.open), `${id} code open`);
    };

    // ---------- Removable, needed and collecting code ----------
    await open();
    assert.equal(await versionsTab.getAttribute('aria-pressed'), 'true', 'the Versions tab is selected from ?tab=versions');
    assert.equal(await page.locator('section.obs-filters').count(), 0, 'no analytics range/service filters on Versions');
    assert.equal(await answer.getAttribute('data-tone'), 'warn');
    assert.match(await text(answer), /^1 piece of old-version code can be removed No page that needs it has been seen for 14 days\. Open "Where the code is" and copy the request for an agent\.$/);
    assert.match(await text(page.locator('[data-compat]')), /OBS overlay pages and Studio editor tabs tell the API their version\. Code kept for older versions can go once no page that needs it has been seen for 14 days\. Nothing is removed automatically: ask an agent to remove it\./);
    assert.deepEqual(await entries.evaluateAll((list) => list.map((el) => [el.dataset.compatEntry, el.dataset.state])),
        [['overlay-legacy-sound', 'removable'], ['studio-old-editor-sounds', 'needed'], ['overlay-library-urls', 'collecting']], 'removable first, then needed, then collecting');
    const chip = (id) => entry(id).locator('[data-compat-chip]');
    assert.equal(await text(chip(SOUND.id)), 'Can be removed');
    assert.equal(await text(chip(STUDIO.id)), 'Still needed');
    assert.equal(await text(chip(URLS.id)), 'Collecting data');
    const tones = await Promise.all([SOUND, STUDIO, URLS].map((e) => chip(e.id).evaluate((el) => [...el.classList].find((c) => c.startsWith('lf-chip--')))));
    assert.deepEqual(tones, ['lf-chip--ok', 'lf-chip--muted', 'lf-chip--accent'], 'each state has its own tone');
    assert.deepEqual(await entry(SOUND.id).locator('.ver-entry__summary code').allInnerTexts(), ['sound'], 'backticks in the summary read as code');
    const meta = (id) => text(entry(id).locator('[data-compat-meta]'));
    assert.match(await meta(SOUND.id), /^For OBS overlay pages older than version 1 Old page last seen [A-Z][a-z]{2} \d{1,2} Can go since [A-Z][a-z]{2} \d{1,2}$/);
    assert.match(await meta(STUDIO.id), /^For Studio editor tabs older than version 2 Old page last seen 2 h ago Can go on [A-Z][a-z]{2} \d{1,2} at the earliest$/);
    assert.match(await meta(URLS.id), /^For OBS overlay pages older than version 1 None seen since tracking began \([A-Z][a-z]{2} \d{1,2}\) Can go on [A-Z][a-z]{2} \d{1,2} at the earliest$/);
    assert.ok(await entry(STUDIO.id).locator('[data-compat-meta] [title]').count(), 'the exact last-seen time is in a tooltip');

    // Where the code is: closed until asked, the code list, and the request for an agent only on removable code.
    assert.equal(await entry(SOUND.id).locator('[data-compat-code]').evaluate((el) => el.open), false, 'the code list starts tucked away');
    await openCode(SOUND.id);
    assert.deepEqual(await entry(SOUND.id).locator('.ver-code li').allInnerTexts(), SOUND.code);
    assert.equal(await text(copyButton(SOUND.id)), 'Copy request for an agent');
    await copyButton(SOUND.id).dblclick();
    await until(async () => (await text(copyButton(SOUND.id))) === 'Copied', 'Copied feedback');
    assert.equal(await page.evaluate(() => window.__copies), 1, 'a double tap copies once');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, [
        `Remove the compatibility code "overlay-legacy-sound" (dimabot/src/overlays/compat.ts): ${SOUND.summary}`,
        `No OBS overlay page older than version 1 has been seen for 14 days (last one ${await page.evaluate((iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), SOUND.olderLastSeenAt)}).`,
        'Code:',
        ...SOUND.code.map((line) => `- ${line}`),
        'Then delete its entry from COMPAT_ENTRIES and follow the usual release workflow.',
    ].join('\n'), 'the copied request names the id, compat.ts, the summary, every code line and the release step');
    await until(async () => (await text(copyButton(SOUND.id))) === 'Copy request for an agent', '"Copied" goes back after a moment');
    // A refused clipboard shows the text to copy by hand.
    await page.evaluate(() => { window.__clipboardFail = true; });
    await page.waitForTimeout(900);
    await copyButton(SOUND.id).click();
    const manual = entry(SOUND.id).locator('[data-copy-manual]');
    await manual.waitFor();
    assert.match(await manual.inputValue(), /^Remove the compatibility code "overlay-legacy-sound"/);
    await page.evaluate(() => { window.__clipboardFail = false; });
    // Still needed and collecting code: where it is, but no removal request yet.
    for (const id of [STUDIO.id, URLS.id]) {
        await openCode(id);
        assert.equal(await copyButton(id).count(), 0, `${id}: no removal request while pages may need it`);
        assert.match(await text(entry(id).locator('[data-copy-later]')), /A request to remove it appears here once no page needs it\./);
    }
    assert.deepEqual(await entry(STUDIO.id).locator('.ver-code li').allInnerTexts(), STUDIO.code);

    // ---------- Versions in use ----------
    assert.equal(await rows.count(), VERSIONS.length);
    assert.deepEqual(await rows.evaluateAll((list) => list.map((row) => `${row.dataset.client}:${row.dataset.tag}`)),
        ['overlay:current', 'studio:current', 'studio:older', 'overlay:older'], 'most recently seen first, with current/older tags');
    assert.match(await text(rows.nth(0)), /^OBS overlay Version 1 current Build main-3f9a1c2b Connected now 4 First seen [A-Z][a-z]{2} \d{1,2} Last seen (just now|\d+ min ago)$/i);
    assert.match(await text(rows.nth(1)), /^Studio editor Version 2 current Build main-3f9a1c2b Connected now — First seen/i, 'Studio tabs have no connected count');
    assert.match(await text(rows.nth(2)), /^Studio editor Version 1 older Build Unknown build Connected now —/i);
    assert.match(await text(rows.nth(3)), /^OBS overlay No version older Build From before versions Connected now 0/i);
    assert.equal(await rows.nth(0).locator('.ver-mono').count(), 1, 'a real build id is monospace');
    assert.equal(await rows.nth(3).locator('.ver-mono').count(), 0, 'a plain build label is not');
    assert.equal(await page.locator('[data-versions-cut]').count(), 0, 'no cut note for a short list');

    // ---------- Header Refresh reloads the report; analytics is never asked ----------
    let before = versionCalls.length;
    state.delay = 900;
    await refresh.click();
    await until(async () => refresh.isDisabled(), 'Refresh waits while the report loads');
    await until(async () => !(await refresh.isDisabled()), 'Refresh is back');
    assert.equal(versionCalls.length - before, 1, 'Refresh loads the report once');
    state.delay = 0;

    // ---------- A failed refresh keeps the last report ----------
    state.fail = 500;
    await refresh.click();
    const stale = page.locator('[data-versions-stale]');
    await stale.waitFor();
    assert.match(await text(stale), /^Couldn't refresh\. This is the report from \d{1,2}:\d{2}:\d{2} [AP]M\. Retry$/);
    assert.equal(await entries.count(), 3, 'the last report stays on screen');
    state.fail = 0;
    await stale.getByRole('button', { name: 'Retry' }).click();
    await stale.waitFor({ state: 'detached' });

    // ---------- First load failing, then Retry ----------
    state.fail = 500;
    await open('/observability?tab=versions', async () => (await page.locator('[data-versions-error]').count()) > 0);
    const error = page.locator('[data-versions-error]');
    assert.equal(await error.getAttribute('role'), 'alert');
    assert.match(await text(error), /The version report didn't load\. Nothing was changed\. Retry/);
    state.fail = 0;
    await error.getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await entries.count()) === 3, 'Retry loads the report');

    // Not the owner: says so, no pointless Retry.
    state.fail = 403;
    await open('/observability?tab=versions', async () => (await page.locator('[data-versions-error]').count()) > 0);
    assert.equal(await text(page.locator('[data-versions-error]')), 'Only the site owner can see page versions.');
    assert.equal(await page.locator('[data-versions-error] button').count(), 0);
    state.fail = 0;

    // ---------- Empty states ----------
    state.report = report({ entries: [], versions: [], trackingSince: {} });
    await open();
    assert.match(await text(answer), /^No old-version code is kept /);
    assert.equal(await answer.getAttribute('data-tone'), 'ok');
    assert.match(await text(page.locator('[data-compat-empty]')), /Nothing kept for older pages/);
    assert.match(await text(page.locator('[data-versions-empty]')), /^No page has reported a version yet/);
    state.report = report({ entries: [{ ...URLS }], versions: [], trackingSince: {} });
    await open();
    assert.equal(await text(answer), 'Still collecting data No page has reported its version yet. Open an OBS overlay or Studio to start.');
    assert.match(await text(entry(URLS.id).locator('[data-compat-meta]')), /No page has reported its version yet$/);
    assert.equal(await entry(URLS.id).locator('[data-compat-when]').count(), 0, 'no date before any page has reported');
    state.report = report({ entries: [{ ...STUDIO }, { ...URLS }] });
    await open();
    assert.match(await text(answer), /^Nothing can be removed yet Older pages were seen in the last 14 days\. The first piece can go on [A-Z][a-z]{2} \d{1,2} at the earliest\.$/);

    // ---------- Long lists show the 50 most recently seen ----------
    state.report = report({ versions: Array.from({ length: 60 }, (_, i) => ({ ...VERSIONS[0], build: `main-${String(i).padStart(8, '0')}`, lastSeenAt: at(i / 24) })) });
    await open();
    await until(async () => (await rows.count()) === 50, '50 rows');
    assert.equal(await text(page.locator('[data-versions-cut]')), 'Showing the 50 most recently seen of 60 versions.');
    assert.match(await text(rows.first()), /main-00000000/, 'newest first');
    state.report = report();

    // ---------- Overview: the attention row, last, opens Versions ----------
    await page.goto(`${base}/dashboard`);
    const attention = page.locator('[data-attention="compat_removable"]');
    await attention.waitFor({ timeout: 60000 });
    assert.deepEqual(await page.locator('[data-attention]').evaluateAll((list) => list.map((row) => row.dataset.attention)),
        ['failed_24h', 'bots', 'compat_removable'], 'old-version code is the lowest priority');
    assert.equal(await attention.evaluate((el) => el.tagName), 'A');
    assert.equal(decodeURIComponent(await attention.getAttribute('href')), '/observability?tab=versions');
    assert.match(await text(attention), /1 piece of old-version code can be removed No page that needs it has been seen for 14 days\. Ask an agent to remove it\. .*System/);
    await attention.click();
    await until(async () => new URL(page.url()).pathname === '/observability' && new URL(page.url()).searchParams.get('tab') === 'versions' && (await entries.count()) === 3, 'overview → System → Versions');
    assert.equal(await versionsTab.getAttribute('aria-pressed'), 'true');

    // ---------- Layout and accessibility: dark first, then light ----------
    for (const mode of ['dark', 'light']) {
        await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
        for (const width of [320, 375, 1280]) {
            const label = `${mode} ${width}`;
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 812 });
            await open('/observability?tab=versions', async () => (await entries.count()) === 3 && (await rows.count()) === VERSIONS.length);
            assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label} theme`);
            for (const e of [SOUND, STUDIO, URLS]) await openCode(e.id);
            const wide = await page.evaluate(() => [...document.querySelectorAll('app-observability-versions *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className).slice(0, 5));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}: horizontal overflow ${wide}`);
            for (const target of await page.locator('app-observability-versions summary, app-observability-versions button').all()) {
                const box = await target.boundingBox();
                assert.ok(box && box.height >= 43.5, `${label}: 44px target (${await target.evaluate((el) => el.className || el.textContent)}: ${box?.height})`);
            }
            const first = rows.first();
            const [pageBox, verBox, lastBox] = [await first.locator('.ver-row__page').boundingBox(), await first.locator('.ver-row__ver').boundingBox(), await first.locator('.ver-cell').last().boundingBox()];
            const pageMid = pageBox.y + pageBox.height / 2;
            assert.ok(pageMid >= verBox.y - 2 && pageMid <= verBox.y + verBox.height + 2, `${label}: page and version share the first line`);
            if (width >= 960) {
                assert.equal(await page.locator('.ver-cols').isVisible(), true, `${label}: column heads on wide screens`);
                assert.ok(Math.abs(pageBox.y - lastBox.y) < 12 && lastBox.x > pageBox.x + 500, `${label}: one line per version`);
                assert.ok((await first.boundingBox()).height < 64, `${label}: dense rows`);
            } else {
                assert.equal(await page.locator('.ver-cols').isVisible(), false, `${label}: no column heads on phones`);
                assert.ok(lastBox.y > pageBox.y + 20, `${label}: phone cards stack their facts`);
                assert.equal(await first.locator('.ver-k').first().isVisible(), true, `${label}: phone cards label each fact`);
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            const axe = await new AxeBuilder({ page }).include('app-observability-versions').include('.obs-tabs').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
            assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target) })), [], `${label} axe`);
            await shot(`versions-${mode}-${width}`);
        }
    }

    assert.deepEqual(unexpected, [], 'no unexpected API calls');
    assert.deepEqual(pageErrors, [], 'no page errors');
    assert.deepEqual([...new Set(analyticsCalls)], ['GET /observability/api/session'], 'Versions never asks analytics for data');
    assert.ok(versionCalls.every((method) => method === 'GET'), 'the Versions view only reads');
    assert.deepEqual([...new Set(otherCalls)].filter((call) => !/^GET \/(users|auth\/|config\/)/.test(call)), [], "only the shell's known read-only calls besides the mocked ones");
    console.log(`PASS admin client versions: answer per mix (removable / nothing yet / collecting / nothing kept), entries ordered removable → needed → collecting with distinct chips, who needs it, last seen and when it can go, code list in "Where the code is", copy request only for removable code (exact text, double-tap guard, Copied feedback, manual copy fallback), versions in use (current/older tags, builds, connected now for OBS only, 50-row cut note), header Refresh with no analytics calls, failed refresh keeps the report, first-load error + Retry, owner-only 403, empty states, Overview row last → /observability?tab=versions, 320/375/1280 dark+light overflow/44px/axe. Screenshots: ${artifacts}`);
} catch (error) {
    if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
    console.error('Report requests:', versionCalls.length, 'analytics:', analyticsCalls.slice(-6));
    throw error;
} finally {
    await browser.close();
}
