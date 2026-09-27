import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/semantic-moderation-browser';
fs.mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
    for (const [tier, language] of [['premium', 'en'], ['free', 'en'], ['pro', 'es']]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };
        const app = { name: 'Test Streamer', email: 'test@example.invalid', language, plan_tier: tier,
            actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
        await context.addInitScript(({ twitch, app, language }) => {
            localStorage.setItem('userLanguage', language);
            localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'test-only', createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: twitch, appUser: app, permissions: {} }));
        }, { twitch, app, language });
        let cfg = { channelID: twitch.id, channel: 'test', enabled: true, offenseWindowSeconds: 3600, settingsVersion: 2,
            rules: [{ id: 'words', type: 'blacklist', enabled: true, terms: ['fuck', 'rinn'], patterns: [], variations: { mode: 'off', entries: [] },
                semantic: { enabled: false, policy: '', examples: [], onUncertain: 'allow_and_log' },
                firstOffense: { action: 'warn', timeoutSeconds: 60 }, secondOffense: { action: 'delete', timeoutSeconds: 60 }, thirdOffense: { action: 'timeout', timeoutSeconds: 60 },
                reason: 'Please follow channel rules', exemptUserLevel: 7, capsThresholdMode: 'count', minCapsCount: 8, maxCapsPercentage: 70, minMessageLength: 10, allowlistDomains: [], maxEmoteCount: 10 }] };
        const saves = [];
        const generations = [];
        let failGeneration = false;
        let jobPolls = 0;
        const generatedEntries = terms => terms.map(term => ({ term, spellings: [term, term === 'fuck' ? 'fcky' : 'riiinn'], pattern: { id: 'auto-' + term, source: term, boundary: 'whole_word', ignoreCase: true }, version: 'spelling-variants-v1' }));
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === new URL(base).origin) return route.continue();
            if (url.hostname !== 'api.domdimabot.com') return route.abort();
            let data = {};
            if (url.pathname === '/auth/session') data = { twitch, app };
            else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
            else if (url.pathname.endsWith('/variations')) {
                const payload = route.request().postDataJSON(); generations.push(payload);
                data = payload.mode === 'broad' ? { id: 'job1', state: 'pending', entries: [], error: '' } : { id: '', state: 'completed', entries: generatedEntries(payload.terms), error: '' };
            } else if (url.pathname.endsWith('/variations/job1')) {
                jobPolls++;
                data = failGeneration ? { id: 'job1', state: 'failed', entries: [], error: 'invalid_generation' }
                    : { id: 'job1', state: 'completed', entries: generatedEntries(generations.at(-1).terms), error: '' };
            } else if (url.pathname.endsWith('/settings')) {
                if (route.request().method() === 'PUT') { const payload = route.request().postDataJSON(); saves.push(payload); cfg = { ...cfg, ...payload, rules: payload.rules.map(rule => ({ ...rule, variations: rule.variations ? { ...rule.variations, entries: rule.variations.mode === 'off' ? [] : generatedEntries(rule.terms) } : undefined })) }; }
                data = cfg;
            } else if (url.pathname.endsWith('/logs')) data = { logs: [], total: 0, limit: 10, skip: 0 };
            else if (url.pathname.endsWith('/decisions')) data = { total: 1, limit: 10, skip: 0, decisions: [{ _id: 'decision1', username: 'viewer', messageText: 'That was fucking awesome',
                ruleID: 'words', mode: 'semantic', verdict: 'allow', status: 'completed', scores: { violation: 0.01 }, consequence: { status: 'allowed' }, charge: { credits: 0 }, createdAt: new Date().toISOString() }] };
            return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
        });
        if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/test/modules/moderation`);
        const feature = page.locator('app-moderation-page');
        const toggle = feature.getByRole('checkbox', { name: language === 'es' ? 'Revisar el contexto antes de actuar' : 'Review context before acting', exact: true });
        try { await toggle.waitFor({ state: 'attached', timeout: 15000 }); }
        catch (error) { console.log('DEBUG browser', page.url(), await page.locator('body').innerText(), errors); await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }); throw error; }
        if (tier === 'free') {
            assert.equal(await toggle.isDisabled(), true);
            assert.equal(await feature.getByRole('button', { name: 'Add regex pattern', exact: true }).count(), 0);
            await feature.getByText('Saved rules using these features are inactive on Free.', { exact: false }).waitFor();
        } else {
            const mode = feature.locator('.variation-mode');
            const save = feature.locator('.lf-save-bar button');
            const saveChanges = async () => {
                const saved = page.waitForResponse(response => response.url().endsWith('/settings') && response.request().method() === 'PUT');
                await save.click();
                await saved;
            };
            await mode.selectOption('common');
            await feature.locator('.variation-preview').click();
            await feature.locator('.variation-examples').waitFor();
            assert.equal(generations.at(-1).mode, 'common');
            assert.deepEqual(generations.at(-1).terms, ['fuck', 'rinn']);
            await saveChanges();
            await page.waitForFunction(() => document.querySelector('.lf-save-bar button')?.disabled);
            await feature.locator('.manual-patterns summary').click();
            const generated = feature.locator('.generated-regex');
            assert.equal(await generated.count(), 2);
            assert.equal(await generated.first().inputValue(), 'fuck');
            await generated.first().fill('f(?:u|a)ck');
            await saveChanges();
            await page.waitForFunction(() => !document.querySelector('.variation-progress'));
            assert.equal(saves.at(-1).rules[0].variations.overrides[0].source, 'f(?:u|a)ck');
            await page.reload();
            await feature.locator('.variation-mode').waitFor();
            await feature.locator('.manual-patterns summary').click();
            assert.equal(await generated.first().inputValue(), 'f(?:u|a)ck', 'edited common regex survives reload');
            await feature.locator('.reset-variation').click();
            await page.waitForFunction(() => document.querySelector('.generated-regex')?.value === 'fuck');
            assert.equal(await generated.first().inputValue(), 'fuck');
            await feature.locator('.manual-patterns summary').click();
            await mode.selectOption('broad');
            failGeneration = true;
            const savedBeforeFailure = saves.length;
            await save.click();
            await feature.getByText(language === 'es' ? /No se pudieron preparar/ : /Could not prepare variations/).first().waitFor();
            assert.equal(saves.length, savedBeforeFailure, 'generation failure leaves saved configuration unchanged');
            failGeneration = false;
            await feature.locator('.variation-preview').click();
            await feature.locator('.variation-examples').waitFor();
            assert.ok(jobPolls >= 2);
            assert.equal(generations.at(-1).mode, 'broad');
            await saveChanges();
            await page.waitForFunction(() => !document.querySelector('.variation-progress'));
            assert.equal(saves.at(-1).rules[0].variations.mode, 'broad');
            assert.equal(saves.at(-1).rules[0].semantic.enabled, false, 'broad mode permits direct ladder');
            await feature.locator('.manual-patterns summary').click();
            assert.equal(await generated.count(), 2);
            await generated.first().fill('f(?:u|a)?ck(?:ing|y)?');
            await feature.locator('.variation-preview').click();
            await page.waitForFunction(() => !document.querySelector('.variation-progress'));
            assert.equal(await generated.first().inputValue(), 'f(?:u|a)?ck(?:ing|y)?', 'preview preserves broader regex edits');
            await saveChanges();
            await page.waitForFunction(() => !document.querySelector('.variation-progress'));
            assert.equal(saves.at(-1).rules[0].variations.overrides[0].source, 'f(?:u|a)?ck(?:ing|y)?');
            await feature.getByRole('button', { name: language === 'es' ? 'Añadir patrón regex' : 'Add regex pattern', exact: true }).click();
            await feature.getByLabel(language === 'es' ? 'Patrón regex' : 'Regex pattern', { exact: true }).fill('f(?:u|a)?ck(?:ing|y)?');
            // Regex-only is an intentional, saveable mode.
            await saveChanges();
            await page.waitForFunction(() => !document.querySelector('.variation-progress'));
            await page.waitForTimeout(200);
            assert.equal(saves.at(-1).rules[0].patterns[0].source, 'f(?:u|a)?ck(?:ing|y)?');
            assert.equal(saves.at(-1).rules[0].semantic.enabled, false);
            await toggle.check();
            await feature.getByText(language === 'es' ? /según la cantidad de texto/ : /based on the amount of text/).waitFor();
            assert.doesNotMatch(await feature.innerText(), /\$|USD|0[.,]042|million input tokens/);
            await feature.locator('textarea:not(.generated-regex)').fill('The author uses profanity in a negative or hostile way, rather than as positive praise.');
            await feature.getByRole('button', { name: language === 'es' ? 'Añadir ejemplo permitido' : 'Add allowed example', exact: true }).click();
            await feature.locator('.example-editor input').fill('That was fucking awesome');
            await saveChanges();
            await page.waitForFunction(() => !document.querySelector('.variation-progress'));
            await page.waitForTimeout(200);
            assert.equal(saves.at(-1).rules[0].semantic.enabled, true);
            assert.equal(saves.at(-1).rules[0].semantic.examples[0].label, 'allow');
            assert.equal(saves.at(-1).rules[0].semantic.onUncertain, 'allow_and_log');
        }
        await feature.locator('.decision-message').waitFor();
        assert.match(await feature.innerText(), /180/);
        for (const [width, height, theme] of [[320, 700, 'light'], [390, 844, 'dark'], [1280, 900, 'light']]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.setAttribute('data-theme', theme); }, theme);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
            await page.screenshot({ path: `${artifacts}/${tier}-${language}-${width}-${theme}.png`, fullPage: true });
        }
        const axe = await new AxeBuilder({ page }).include('app-moderation-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], 'moderation accessibility');
        assert.deepEqual(errors, [], 'browser runtime errors');
        await context.close();
    }
    console.log('PASS automatic variations UI: common/broad previews, multiple words, failed generation preserves saved rules; moderation UI: paid/free gates; regex-only and contextual saves; examples; decision logs; EN/ES; mobile/desktop; accessibility');
} finally { await browser.close(); }
