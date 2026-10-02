/**
 * Chat Moderation redesign — mobile tabbed / desktop single-scroll layout.
 *
 * Exercises the built bundle with a mocked moderation API:
 *  - mobile (< 960px): section tabs, one panel at a time, rules collapsed by default
 *  - desktop (>= 960px): tabs hidden, all panels visible on one scroll
 *  - one rule auto-expands (few taps for the common single-rule case)
 *  - rule summary line, offense ladder, exempt/reason fields, type-specific fields,
 *    advanced moderation (gold Premium · Pro), sticky Save
 *  - logs + decisions rendered as dense rows that keep every value
 *  - no horizontal overflow at 320/390/1280 and no WCAG A/AA axe violations
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/moderation-compact-web';
fs.mkdirSync(artifacts, { recursive: true });

const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };

const ruleBase = {
  enabled: true,
  terms: [],
  patterns: [],
  variations: { mode: 'off', entries: [] },
  semantic: { enabled: false, policy: '', examples: [], onUncertain: 'allow_and_log' },
  firstOffense: { action: 'warn', timeoutSeconds: 60 },
  secondOffense: { action: 'delete', timeoutSeconds: 60 },
  thirdOffense: { action: 'timeout', timeoutSeconds: 600 },
  reason: 'Please follow channel rules',
  exemptUserLevel: 7,
  capsThresholdMode: 'count',
  minCapsCount: 8,
  maxCapsPercentage: 70,
  minMessageLength: 10,
  allowlistDomains: [],
  maxEmoteCount: 10
};

const linksRule = {
  ...ruleBase,
  id: 'links-1',
  type: 'links',
  allowlistDomains: ['example.com', 'twitch.tv'],
  firstOffense: { action: 'warn', timeoutSeconds: 60 },
  secondOffense: { action: 'delete', timeoutSeconds: 60 },
  thirdOffense: { action: 'timeout', timeoutSeconds: 600 }
};

const wordsRule = {
  ...ruleBase,
  id: 'words-1',
  type: 'blacklist',
  terms: ['term_one', 'term_two']
};

const cfgWith = (rules) => ({
  channelID: twitch.id,
  channel: 'test',
  enabled: true,
  offenseWindowSeconds: 3600,
  settingsVersion: 2,
  rules
});

const logsData = {
  total: 25,
  limit: 10,
  skip: 0,
  logs: [
    { _id: 'l1', username: 'spammy_dave', userID: 'u1', ruleType: 'links', action: 'timeout', offenseNumber: 2, success: true, createdAt: '2026-03-03T14:22:00.000Z' },
    { _id: 'l2', username: 'CAPS_KING', userID: 'u2', ruleType: 'caps', action: 'warn', offenseNumber: 1, success: true, createdAt: '2026-03-03T13:40:00.000Z' },
    { _id: 'l3', username: 'lurker_99', userID: 'u3', ruleType: 'blacklist', action: 'delete', offenseNumber: 1, success: false, createdAt: '2026-03-03T12:11:00.000Z' },
    { _id: 'l4', username: 'emote_goblin', userID: 'u4', ruleType: 'emote_spam', action: 'warn', offenseNumber: 3, success: true, createdAt: '2026-03-02T22:05:00.000Z' }
  ]
};

const decisionsData = {
  total: 2,
  limit: 10,
  skip: 0,
  decisions: [
    { _id: 'd1', username: 'spammy_dave', messageText: 'check this out http://sketchy.example', ruleID: 'links-1', mode: 'semantic', verdict: 'violation', status: 'completed', scores: { violation: 0.964 }, consequence: { action: 'timeout', offenseNumber: 2, success: true }, charge: { credits: 1 }, createdAt: '2026-03-03T14:22:00.000Z' },
    { _id: 'd2', username: 'chill_viewer', messageText: 'dude that was such a good play', ruleID: 'links-1', mode: 'semantic', verdict: 'allow', status: 'completed', scores: { violation: 0.121 }, consequence: { status: 'allowed' }, charge: { credits: 1 }, createdAt: '2026-03-03T14:05:00.000Z' }
  ]
};

async function openModeration(browser, { tier = 'pro', rules = [linksRule, wordsRule], viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const app = {
    name: 'Test Streamer',
    email: 'test@example.invalid',
    language: 'en',
    plan_tier: tier,
    actived: true,
    chat_enabled: true,
    twitch_user_id: twitch.id,
    has_permissions: true,
    up_to_date_permissions: true,
    administrating: []
  };
  await context.addInitScript(({ twitch, app }) => {
    localStorage.setItem('userLanguage', 'en');
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2,
      token: 'test-only',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: twitch,
      appUser: app,
      permissions: {}
    }));
  }, { twitch, app });

  let cfg = cfgWith(rules);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch, app };
    else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
    else if (url.pathname.endsWith('/settings')) {
      if (route.request().method() === 'PUT') cfg = { ...cfg, ...route.request().postDataJSON() };
      data = cfg;
    } else if (url.pathname.endsWith('/logs')) data = logsData;
    else if (url.pathname.endsWith('/decisions')) data = decisionsData;
    return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const host = page.locator('app-moderation-page');
  return { context, page, host, errors };
}

const visibleCount = async (locator) => {
  const total = await locator.count();
  let visible = 0;
  for (let i = 0; i < total; i++) if (await locator.nth(i).isVisible()) visible++;
  return visible;
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const failures = [];
try {
  // ---------------------------------------------------------------- mobile
  {
    const { context, page, host, errors } = await openModeration(browser);
    await page.goto(`${base}/test/modules/moderation`);
    await host.locator('.lf-head').waitFor({ timeout: 20000 });
    await host.locator('.lf-tab').first().waitFor({ timeout: 20000 });

    const tabs = host.locator('.lf-tabs');
    assert.equal(await tabs.isVisible(), true, 'mobile tabs visible');
    assert.equal(await host.locator('.lf-tab').count(), 4, 'four section tabs');
    assert.equal(await visibleCount(host.locator('.lf-panel')), 1, 'one panel at a time on mobile');

    const active = host.locator('.lf-panel--active');
    assert.match(await active.innerText(), /Chat protection/, 'status panel first');
    const save = host.locator('.lf-save-bar button');
    assert.equal(await save.isDisabled(), true, 'save disabled before edits');
    await active.locator('.lf-switch input').first().click();
    // Client hydration can replay the click; wait for the edit to register.
    await page.waitForFunction(() => { const button = document.querySelector('.lf-save-bar button'); return !!button && !button.disabled; }, null, { timeout: 8000 });
    assert.equal(await save.isEnabled(), true, 'save enabled after an edit');
    assert.equal(await host.locator('.lf-save-bar').evaluate((el) => getComputedStyle(el).position), 'sticky', 'save bar sticky');

    // Rules tab: collapsed by default with a summary line
    await host.locator('.lf-tab', { hasText: 'Rules' }).click();
    await host.locator('.lf-rule').first().waitFor();
    assert.equal(await host.locator('.lf-rule').count(), 2, 'two rules');
    assert.equal(await host.locator('.lf-rule--open').count(), 0, 'rules collapsed by default');
    assert.equal(await host.locator('.lf-add-row .lf-btn').count(), 4, 'four add-rule buttons');
    const flow = (await host.locator('.lf-rule__flow').first().innerText()).trim();
    assert.match(flow, /→/, 'summary shows the step flow');
    assert.match(flow, /Warn/, 'summary names the first action');

    // expand the links rule — editor contents intact
    await host.locator('.lf-rule__toggle').first().click();
    await host.locator('.lf-rule--open .lf-ladder').waitFor();
    assert.equal(await host.locator('.lf-rule--open .lf-step').count(), 3, 'three offense steps');
    assert.equal(await host.locator('.lf-rule--open .lf-step__cell--2').count(), 1, 'timeout duration field');
    assert.equal(await host.locator('.lf-rule--open .lf-taglist .lf-tag').count(), 2, 'allowlist tags kept');
    assert.equal(await host.locator('.lf-rule--open .lf-select').count() >= 3, true, 'action selects present');

    // blocked words rule keeps advanced moderation with the gold tag
    await host.locator('.lf-rule__toggle').nth(1).click();
    const second = host.locator('.lf-rule').nth(1);
    await second.locator('.advanced-moderation').waitFor();
    assert.equal(await second.locator('.lf-chip--gold').count() >= 1, true, 'Premium · Pro gold tag kept');
    assert.equal(await second.locator('.variation-mode').count(), 1, 'word matching control kept');

    // Logs tab: dense rows preserve every column
    await host.locator('.lf-tab', { hasText: 'Recent Actions' }).click();
    await host.locator('.lf-log').first().waitFor();
    assert.equal(await host.locator('.lf-log').count(), 4, 'log rows rendered');
    const logText = await host.locator('.lf-log').first().innerText();
    assert.match(logText, /spammy_dave/, 'log user');
    assert.match(logText, /Links/, 'log rule type');
    assert.match(logText, /#2/, 'log offense number');
    assert.match(logText, /Applied/, 'log result');
    assert.equal(await host.locator('.lf-panel--active .lf-pager').isVisible(), true, 'log pager kept');

    // Decisions tab
    await host.locator('.lf-tab', { hasText: 'Decisions' }).click();
    await host.locator('.lf-decision').first().waitFor();
    assert.equal(await host.locator('.lf-decision').count(), 2, 'decision rows rendered');
    const decisionText = await host.locator('.lf-decision').first().innerText();
    assert.match(decisionText, /spammy_dave/, 'decision user');
    assert.match(decisionText, /Violation/, 'decision verdict');
    assert.match(decisionText, /96\.4%/, 'decision model score');

    // back to rules for the screenshot
    await host.locator('.lf-tab', { hasText: 'Rules' }).click();
    await host.locator('.lf-rule').first().waitFor();
    await page.screenshot({ path: `${artifacts}/mobile-rules.png`, fullPage: true });

    // narrow viewports must not scroll sideways
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `no horizontal overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(errors, [], 'no page errors (mobile)');
    await context.close();
  }

  // ------------------------------------------- single rule auto-expands
  {
    const { context, page, host } = await openModeration(browser, { rules: [linksRule] });
    await page.goto(`${base}/test/modules/moderation`);
    await host.locator('.lf-tab').first().waitFor({ timeout: 20000 });
    await host.locator('.lf-tab', { hasText: 'Rules' }).click();
    const onlyRule = host.locator('.lf-rule').first();
    await onlyRule.waitFor({ state: 'attached', timeout: 20000 });
    assert.equal(await host.locator('.lf-rule--open').count(), 1, 'single rule auto-expands');
    assert.equal(await onlyRule.evaluate((el) => el.classList.contains('lf-rule--open')), true, 'rule starts expanded');
    await context.close();
  }

  // --------------------------------------------------------------- desktop
  {
    const { context, page, host, errors } = await openModeration(browser, { viewport: { width: 1280, height: 900 } });
    await page.goto(`${base}/test/modules/moderation`);
    await host.locator('.lf-head').waitFor({ timeout: 20000 });
    await host.locator('.lf-rule').first().waitFor();
    assert.equal(await host.locator('.lf-tabs').isVisible(), false, 'tabs hidden on desktop');
    assert.equal(await visibleCount(host.locator('.lf-panel')), 4, 'all panels visible on desktop');
    assert.equal(await visibleCount(host.locator('.lf-log')), 4, 'logs visible on desktop');
    assert.equal(await visibleCount(host.locator('.lf-decision')), 2, 'decisions visible on desktop');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal overflow at 1280px');
    await page.screenshot({ path: `${artifacts}/desktop-full.png`, fullPage: true });

    const axe = await new AxeBuilder({ page }).include('app-moderation-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    if (axe.violations.length) console.log(JSON.stringify(axe.violations, null, 2));
    assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), []);
    assert.deepEqual(errors, [], 'no page errors (desktop)');
    await context.close();
  }

  console.log('moderation compact layout check passed');
} catch (error) {
  failures.push(error);
  console.error(error);
} finally {
  await browser.close();
}
if (failures.length) process.exit(1);
