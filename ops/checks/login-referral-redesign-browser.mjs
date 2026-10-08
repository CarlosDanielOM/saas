/**
 * Behavior check: dashboard referral banner + login progress/console redesign.
 *
 * All APIs are mocked (no production calls). Asserts:
 *  - dashboard banner: kicker/title, Premium +50 and Pro +100 monthly reward pills,
 *    yearly note, CTA to /:streamer/modules/referrals, dismiss hides it and persists;
 *    Spanish strings when the account language is es;
 *  - login callback: segmented 5-step bar advances (active step + caption), terminal
 *    console tails lines with ok tone and a caret while busy, then reaches the dashboard;
 *  - login failure: failed step marked, alert + error line in console, "Stopped" state,
 *    Try again button;
 *  - axe (wcag2a/2aa/21aa) clean and no horizontal overflow at 320/390/1280, dark + light.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');
const axePath = process.env.AXE_PATH || `${tools}/node_modules/axe-core/axe.min.js`;

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';

const ID = '123456789';
const TWITCH = { id: ID, login: 'test', display_name: 'Test Streamer', profile_image_url: '' };
const appUser = (language) => ({
  name: 'Test Streamer', email: 'test@example.invalid', language, plan_tier: 'free', actived: true,
  chat_enabled: true, twitch_user_id: ID, has_permissions: true, up_to_date_permissions: true, administrating: []
});
const BOOT = {
  role: 'owner', channel: { id: ID, name: 'Test Streamer', chatEnabled: true }, isLive: false,
  liveStream: null, liveSession: null,
  kpis: { activeViewers: 0, averageViewers: 12, monthlyAverageViewers: 11, averageHoursPerStream: 3, totalBits: 100,
    totalStreams: 4, totalDonations: 5, activeFollows: 5, activeSubs: 1, monthlyGoalSubs: 10, subsProgressPct: 10 },
  trend: [], streamHistory: [], totalFollowers: 50, totalSubs: 3,
  monthlyGoals: { followersGoal: 60, followersCurrent: 50, subsGoal: 5, subsCurrent: 3 }
};
const env = (data) => ({ error: false, status: 200, message: 'ok', data });

async function until(fn, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** Mocks the API. `gate` holds /auth/login until released; `failLogin` returns 500. */
async function newContext(browser, { width, height, dark, language = 'en', session = true, failLogin = false, reduced = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion: reduced ? 'reduce' : 'no-preference'
  });
  const app = appUser(language);
  await context.addInitScript(({ twitch, app, dark, session }) => {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    if (session && !sessionStorage.getItem('check.sessionSeeded')) {
      sessionStorage.setItem('check.sessionSeeded', '1');
      localStorage.setItem('dimasite.session.v1', JSON.stringify({
        version: 2, token: 'test-only', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
      }));
    }
  }, { twitch: TWITCH, app, dark, session });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    calls.push(`${route.request().method()} ${url.pathname}`);
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: TWITCH, app };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner' };
    else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(url.pathname)) data = BOOT;
    else if (/^\/dashboard\/[^/]+\/access$/.test(url.pathname)) {
      data = { allowed: true, role: 'owner', channelID: ID, channelName: 'Test Streamer', planTier: 'free' };
    } else if (/^\/dashboard\/[^/]+\/live-status$/.test(url.pathname)) {
      data = { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    } else if (url.pathname === '/auth/exchange-code') data = { access_token: 'test-only', twitch_user: TWITCH };
    else if (url.pathname === '/auth/login') {
      await gate;
      if (failLogin) {
        return route.fulfill({ status: 500, json: { error: true, status: 500, message: 'Mock sync failure' } });
      }
      data = app;
    } else if (url.pathname === '/billing/context') data = { scenario: 'none' };
    return route.fulfill({ status: 200, json: env(data) });
  });
  return { context, release, calls };
}

async function axe(page, selector, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate((sel) => window.axe.run(document.querySelector(sel), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  }), selector);
  const violations = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  assert.deepEqual(violations, [], `${label}: axe violations`);
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // ---------- Dashboard referral banner ----------
  for (const dark of [false, true]) {
    for (const [width, height] of [[1280, 900], [390, 844], [320, 640]]) {
      const label = `banner ${dark ? 'dark' : 'light'} ${width}`;
      const { context } = await newContext(browser, { width, height, dark, reduced: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/test/dashboard`);
      const banner = page.locator('app-referral-promo-banner .lf-promo');
      await banner.waitFor({ timeout: 20000 });

      assert.equal((await banner.locator('.lf-promo__kicker').textContent()).trim(), 'Referrals');
      assert.equal((await banner.locator('.lf-promo__title').textContent()).trim(), 'Invite a streamer, earn credits');
      const rewards = await banner.locator('.lf-promo__reward').allTextContents();
      assert.equal(rewards.length, 2, `${label}: two reward pills`);
      assert.match(rewards[0].replace(/\s+/g, ' '), /Premium \+50 credits \/ month/);
      assert.match(rewards[1].replace(/\s+/g, ' '), /Pro \+100 credits \/ month/);
      assert.equal(await banner.locator('.lf-promo__reward--pro').count(), 1, `${label}: pro pill highlighted`);
      assert.match(await banner.locator('.lf-promo__note').textContent(), /10×/);
      assert.equal(await banner.locator('.lf-promo__cta').getAttribute('href'), '/test/modules/referrals');

      const cta = await banner.locator('.lf-promo__cta').boundingBox();
      const close = await banner.locator('.lf-promo__close').boundingBox();
      assert.ok(cta.height >= 44 && close.height >= 44 && close.width >= 44, `${label}: touch targets >= 44px`);
      if (width < 640) {
        const tile = await banner.boundingBox();
        assert.ok(cta.width > tile.width * 0.8, `${label}: phone CTA spans the banner`);
      }

      await noOverflow(page, label);
      await axe(page, 'app-referral-promo-banner', label);
      if (shots) await banner.screenshot({ path: `${shots}/referral-${dark ? 'dark' : 'light'}-${width}.png` });

      if (width === 1280 && !dark) {
        await banner.locator('.lf-promo__close').click();
        await until(async () => (await page.locator('app-referral-promo-banner').count()) === 0, 'banner dismissed');
        assert.ok(await page.evaluate(() => localStorage.getItem('dimasite.referral_promo.dismissed_at')), 'dismiss persisted');
        await page.reload();
        await page.locator('.lf-bento--hero').waitFor({ timeout: 20000 });
        await page.waitForTimeout(400);
        assert.equal(await page.locator('app-referral-promo-banner').count(), 0, 'banner stays dismissed');
      }
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }
  }

  {
    const { context } = await newContext(browser, { width: 390, height: 844, dark: true, language: 'es' });
    const page = await context.newPage();
    await page.goto(`${base}/test/dashboard`);
    const banner = page.locator('app-referral-promo-banner .lf-promo');
    await banner.waitFor({ timeout: 20000 });
    await until(async () => /créditos/.test(await banner.textContent()), 'spanish banner');
    assert.equal((await banner.locator('.lf-promo__kicker').textContent()).trim(), 'Referidos');
    assert.match((await banner.locator('.lf-promo__reward').first().textContent()).replace(/\s+/g, ' '), /\+50 créditos \/ mes/);
    assert.equal((await banner.locator('.lf-promo__cta').textContent()).trim(), 'Obtener mi enlace');
    await context.close();
  }

  // ---------- Login callback: progress + console ----------
  for (const dark of [false, true]) {
    for (const [width, height] of [[1280, 900], [390, 844], [320, 640]]) {
      const label = `login ${dark ? 'dark' : 'light'} ${width}`;
      const { context, release } = await newContext(browser, { width, height, dark, session: false });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/login?code=test-code&state=test-state`);

      // Held at /auth/login → step 2 (Account) is active.
      const run = page.locator('.lf-run');
      await run.waitFor({ timeout: 20000 });
      await until(async () => (await page.locator('.lf-steps__item.is-active').count()) === 1
        && (await page.locator('.lf-steps__item').nth(1).getAttribute('class')).includes('is-active'), 'step 2 active');
      assert.equal(await page.locator('.lf-steps__item').count(), 5, `${label}: five steps`);
      assert.ok((await page.locator('.lf-steps__item').nth(0).getAttribute('class')).includes('is-done'), `${label}: step 1 done`);
      assert.equal((await page.locator('.lf-run__caption').textContent()).trim(), 'Step 2 of 5');
      assert.equal(await page.locator('.lf-run__spinner').count(), 1, `${label}: spinner while busy`);

      const term = page.locator('.lf-term');
      assert.ok((await term.getAttribute('class')).includes('lf-term--busy'), `${label}: console busy`);
      assert.equal((await term.locator('.lf-term__state').textContent()).trim(), 'Live');
      assert.ok((await term.locator('.lf-term__line:not(.lf-term__line--cursor)').count()) >= 3, `${label}: console lines`);
      assert.equal(await term.locator('.lf-term__line--ok').count(), 1, `${label}: exchange success line is ok-toned`);
      assert.equal(await term.locator('.lf-term__caret').count(), 1, `${label}: caret while busy`);
      assert.match(await term.locator('.lf-term__time').first().textContent(), /^\d{2}:\d{2}:\d{2}$/);

      await noOverflow(page, label);
      // Freeze animations before axe so mid-animation opacity doesn't skew contrast.
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
      await axe(page, 'app-login-page', label);
      if (shots) await page.screenshot({ path: `${shots}/login-busy-${dark ? 'dark' : 'light'}-${width}.png` });

      release();
      await page.waitForURL(/\/test\/dashboard/, { timeout: 15000 });
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }
  }

  // ---------- Login failure ----------
  for (const dark of [false, true]) {
    const label = `login error ${dark ? 'dark' : 'light'}`;
    const { context, release } = await newContext(browser, { width: 390, height: 844, dark, session: false, failLogin: true });
    const page = await context.newPage();
    await page.goto(`${base}/login?code=test-code&state=test-state`);
    await page.locator('.lf-run').waitFor({ timeout: 20000 });
    release();
    await page.locator('.lf-alert').waitFor({ timeout: 10000 });
    await until(async () => (await page.locator('.lf-steps__item.is-failed').count()) === 1, 'failed step');
    assert.ok((await page.locator('.lf-steps__item').nth(1).getAttribute('class')).includes('is-failed'), `${label}: step 2 failed`);
    assert.equal(await page.locator('.lf-steps__item.is-active').count(), 0, `${label}: nothing active after error`);
    assert.equal((await page.locator('.lf-run__caption').textContent()).trim(), 'Stopped at step 2 of 5');
    const term = page.locator('.lf-term');
    assert.ok((await term.getAttribute('class')).includes('lf-term--error'), `${label}: console error state`);
    assert.equal((await term.locator('.lf-term__state').textContent()).trim(), 'Stopped');
    assert.ok((await term.locator('.lf-term__line--error').count()) >= 1, `${label}: error line in console`);
    assert.equal(await term.locator('.lf-term__caret').count(), 0, `${label}: no caret after error`);
    assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 1, `${label}: try again`);
    await noOverflow(page, label);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await axe(page, 'app-login-page', label);
    if (shots) await page.screenshot({ path: `${shots}/login-error-${dark ? 'dark' : 'light'}.png` });
    await context.close();
  }

  console.log('PASS referral banner (rewards, CTA, dismiss persists, es) + login step bar, tailing console, error state; axe + overflow at 320/390/1280 dark/light');
} finally {
  await browser.close();
}
