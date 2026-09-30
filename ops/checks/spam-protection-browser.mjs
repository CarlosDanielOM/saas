import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4226';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-spam-browser';
fs.mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
    for (const [tier, language] of [['free', 'en'], ['premium', 'en'], ['pro', 'es']]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };
        const app = { name: 'Test Streamer', email: 'test@example.invalid', language, plan_tier: tier,
            actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
        await context.addInitScript(({ twitch, app, language }) => {
            localStorage.setItem('userLanguage', language);
            localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'test-only', createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: twitch, appUser: app, permissions: {} }));
        }, { twitch, app, language });
        // Deliberately omit spamProtection initially to test old settings responses.
        let settings = { channelID: twitch.id, channel: 'test', enabled: true, offenseWindowSeconds: 3600, settingsVersion: 1, rules: [] };
        const saves = [];
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === new URL(base).origin) return route.continue();
            if (url.hostname !== 'api.domdimabot.com') return route.abort();
            let data = {};
            if (url.pathname === '/auth/session') data = { twitch, app };
            else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
            else if (url.pathname.endsWith('/settings')) {
                if (route.request().method() === 'PUT') {
                    const payload = route.request().postDataJSON();
                    saves.push(payload);
                    settings = { ...settings, ...payload, settingsVersion: settings.settingsVersion + 1 };
                }
                data = settings;
            } else if (url.pathname.endsWith('/logs')) data = { logs: [{ username: 'adbot', ruleID: 'builtin-spam-protection', ruleType: 'blacklist', action: 'ban', offenseNumber: 1, messageExcerpt: 'Buy viewers!', reason: 'Unsolicited ads', success: true, createdAt: new Date().toISOString() }], total: 1, limit: 10, skip: 0 };
            else if (url.pathname.endsWith('/decisions')) data = { total: 1, limit: 10, skip: 0, decisions: [{ _id: 'first', username: 'adbot', messageText: 'Buy viewers!', ruleID: 'builtin-spam-protection', reviewSource: 'first_message', mode: 'semantic', verdict: 'violation', status: 'completed', scores: { violation: 0.995 }, consequence: { action: 'ban', offenseNumber: 1, success: true }, charge: { credits: 0 }, createdAt: new Date().toISOString() }] };
            return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
        });
        if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/test/modules/moderation`);
        const host = page.locator('app-moderation-page');
        const tile = host.locator('.lf-spam-protection');
        await tile.waitFor({ timeout: 60000 });
        const first = tile.locator('input').nth(0);
        const continuous = tile.locator('input').nth(1);
        assert.equal(await first.isChecked(), true);
        assert.equal(await first.isEnabled(), true, 'free protection editable on every tier');
        assert.equal(await continuous.isChecked(), false);
        assert.equal(await continuous.isDisabled(), tier === 'free', 'continuous review tier gate');
        assert.match(await tile.innerText(), language === 'en' ? /never use AI credits/ : /nunca consumen créditos/);
        const save = host.locator('.lf-save-bar button');
        await first.uncheck();
        await page.waitForFunction(() => document.querySelector('.lf-spam-protection input:nth-of-type(1)')
            && document.querySelectorAll('.lf-spam-protection input')[1]?.disabled);
        await save.click();
        await page.waitForFunction(() => document.querySelector('app-moderation-page .lf-save-bar button')?.disabled);
        assert.deepEqual(saves.at(-1).spamProtection, { enabled: false, reviewAllMessages: false });
        await first.check();
        if (tier !== 'free') await continuous.check();
        await save.click();
        await page.waitForFunction(() => document.querySelector('app-moderation-page .lf-save-bar button')?.disabled);
        assert.deepEqual(saves.at(-1).spamProtection, { enabled: true, reviewAllMessages: tier !== 'free' });
        await page.reload();
        await tile.waitFor();
        assert.equal(await first.isChecked(), true);
        assert.equal(await continuous.isChecked(), tier !== 'free', 'saved setting survives reload');
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${tier}/${language} overflow ${width}`);
            await page.screenshot({ path: `${artifacts}/${tier}-${language}-${width}.png`, fullPage: true });
        }
        const axe = await new AxeBuilder({ page }).include('app-moderation-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        assert.deepEqual(axe.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), []);
        assert.match(await host.innerText(), language === 'en' ? /First-message protection · Free/ : /Protección del primer mensaje · Gratis/);
        assert.deepEqual(errors, []);
        await context.close();
    }
    console.log('PASS first-message controls, free/Premium/Pro gates, legacy defaults, save/reload, decisions and ad logs, EN/ES, 320/390/1280px and accessibility');
} finally { await browser.close(); }
