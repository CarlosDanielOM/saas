/**
 * Behavior check: sign-in returns to the page the visitor opened (e.g. "View summary" in an email)
 * instead of always opening the dashboard. All APIs and Twitch are mocked; nothing reaches production.
 *
 *  - signed out → /test/modules/stream-summaries → /login → Twitch (mocked redirect) → back on the
 *    summaries page, never the dashboard; the stage label says "Opening the page you asked for";
 *  - query strings survive (/test/modules/clip-recommendations?ref=email, desktop);
 *  - plain /login with nothing remembered still opens /test/dashboard ("Redirecting to your dashboard");
 *  - expired session → /401?reason=expired → Sign in → back on the summaries page;
 *  - a channel the user can't open still ends on the 403 page (guards decide access, not the login page);
 *  - a stored session that visits /login resumes to the remembered page;
 *  - tampered/expired/blocked stored values (//evil.example, expired entry, /login) fall back to the dashboard;
 *  - an old link to an unknown channel (404) signs in to the dashboard, not back to the 404;
 *  - a sign-in that goes to Polar checkout clears the remembered page (no hijacked later login);
 *  - the observability page's sign-in returns to /observability (old one-off flag replaced);
 *  - admin hand-off: only https://admin.domdimabot.com receives the token; a lookalike returnTo
 *    (https://evil.example/admin.domdimabot.com) starts no Twitch login and never reaches that site;
 *    a forged admin callback without this tab's state is refused.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';

const KEY = 'dimasite.login-return.v1';
const ID = '123456789';
const OTHER = '555000111';
const TWITCH = { id: ID, login: 'test', display_name: 'Test Streamer', profile_image_url: '' };
const APP = {
  name: 'Test Streamer', email: 'test@example.invalid', language: 'en', plan_tier: 'free', actived: true,
  chat_enabled: true, twitch_user_id: ID, has_permissions: true, up_to_date_permissions: true, administrating: []
};
const BOOT = {
  role: 'owner', channel: { id: ID, name: 'Test Streamer', chatEnabled: true }, isLive: false,
  liveStream: null, liveSession: null,
  kpis: { activeViewers: 0, averageViewers: 12, monthlyAverageViewers: 11, averageHoursPerStream: 3, totalBits: 100,
    totalStreams: 4, totalDonations: 5, activeFollows: 5, activeSubs: 1, monthlyGoalSubs: 10, subsProgressPct: 10 },
  trend: [], streamHistory: [], totalFollowers: 50, totalSubs: 3,
  monthlyGoals: { followersGoal: 60, followersCurrent: 50, subsGoal: 5, subsCurrent: 3 }
};
const env = (data) => ({ error: false, status: 200, message: 'ok', data });
const LABEL_RETURN = 'Opening the page you asked for';
const LABEL_DASHBOARD = 'Redirecting to your dashboard';

async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

/**
 * `session`: seed a signed-in session once. `expired`: /auth/session answers 401 until a new Twitch sign-in.
 * `checkout`: billing context says a paid checkout should start.
 */
async function newContext(browser, { width = 390, height = 844, session = false, expired = false, checkout = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  await context.addInitScript(({ twitch, app, session }) => {
    localStorage.setItem('theme', 'dark');
    if (session && !sessionStorage.getItem('check.seeded')) {
      sessionStorage.setItem('check.seeded', '1');
      localStorage.setItem('dimasite.session.v1', JSON.stringify({
        version: 2, token: 'test-only', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
      }));
    }
    // Record every login stage label (the final one is on screen only briefly).
    window.__labels = [];
    new MutationObserver(() => {
      const text = document.querySelector('.lf-run__label')?.textContent?.trim();
      if (text && window.__labels[window.__labels.length - 1] !== text) window.__labels.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, { twitch: TWITCH, app: APP, session });

  const state = { expired, twitchRedirects: 0, offsite: [] };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === 'id.twitch.tv') {
      // Twitch approves at once and sends the browser back with the app's own state.
      state.twitchRedirects += 1;
      const back = `${origin}/login?code=test-code&state=${encodeURIComponent(url.searchParams.get('state') || '')}`;
      return route.fulfill({ status: 302, headers: { location: back } });
    }
    if (['admin.domdimabot.com', 'evil.example', 'polar.example'].includes(url.hostname)) {
      state.offsite.push(url.href);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>offsite</title>' });
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const path = url.pathname;
    if (path === '/auth/session') {
      if (state.expired) return route.fulfill({ status: 401, json: { error: true, status: 401, message: 'Unauthorized' } });
      return route.fulfill({ json: env({ twitch: TWITCH, app: APP }) });
    }
    if (path === '/auth/exchange-code') {
      state.expired = false;
      return route.fulfill({ json: env({ access_token: 'test-only', twitch_user: TWITCH }) });
    }
    if (path === '/auth/login') return route.fulfill({ json: env(APP) });
    const access = path.match(/^\/auth\/access\/([^/]+)$/);
    if (access) {
      const allowed = access[1] === ID;
      const batch = url.searchParams.get('permissions');
      if (batch) {
        const permissions = Object.fromEntries(batch.split(',').map((p) => [p, allowed]));
        return route.fulfill({ json: env({ allowed, role: allowed ? 'owner' : 'none', channelID: access[1], permissions }) });
      }
      if (!allowed) return route.fulfill({ status: 403, json: { error: true, status: 403, data: { allowed: false } } });
      return route.fulfill({ json: env({ allowed: true, role: 'owner' }) });
    }
    const dash = path.match(/^\/dashboard\/([^/]+)\/(access|bootstrap|live-status)$/);
    if (dash) {
      const allowed = dash[1] === ID;
      if (dash[2] === 'access') {
        return route.fulfill({ json: env({ allowed, role: allowed ? 'owner' : 'none', channelID: dash[1], planTier: 'free' }) });
      }
      if (dash[2] === 'bootstrap') return route.fulfill({ json: env(BOOT) });
      return route.fulfill({ json: env({ isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null }) });
    }
    if (path === '/users') {
      const name = url.searchParams.get('username');
      const id = name === 'test' ? ID : name === 'other' ? OTHER : null;
      return route.fulfill({ json: env(id ? { id, username: name, profile_image_url: '' } : null) });
    }
    if (path === '/billing/context') return route.fulfill({ json: env({ scenario: checkout ? 'new' : 'none' }) });
    if (path === '/billing/checkout') return route.fulfill({ json: env({ checkoutUrl: 'https://polar.example/checkout' }) });
    return route.fulfill({ json: env({}) });
  });
  return { context, state };
}

async function openPage(context) {
  const page = await context.newPage();
  const visited = [];
  const errors = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) visited.push(frame.url()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, visited, errors };
}

const remembered = (page) => page.evaluate((key) => {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw).path : null;
}, KEY);

/** Reads the remembered page without navigating (the tab may be on a mocked off-site page). */
const rememberedIn = async (context) => {
  const store = (await context.storageState()).origins.find((o) => o.origin === origin)?.localStorage ?? [];
  const raw = store.find((item) => item.name === KEY)?.value;
  return raw ? JSON.parse(raw).path : null;
};

async function signInWithTwitch(page) {
  const button = page.locator('app-login-page .lf-btn--primary:visible').first();
  await button.waitFor({ timeout: 20000 });
  await button.click();
}

const pathOf = (page) => { const u = new URL(page.url()); return `${u.pathname}${u.search}`; };
const visitedDashboard = (visited) => visited.some((u) => /\/test\/dashboard(?:[?#]|$)/.test(new URL(u).pathname));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const passed = [];
try {
  // ---------- Email link while signed out (phone) ----------
  {
    const { context, state } = await newContext(browser);
    const { page, visited } = await openPage(context);
    await page.goto(`${base}/test/modules/stream-summaries`);
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    assert.equal(await remembered(page), '/test/modules/stream-summaries', 'email link remembered');
    if (shots) await page.screenshot({ path: `${shots}/login-return-login-390.png` });
    await signInWithTwitch(page);
    await page.waitForURL(/\/test\/modules\/stream-summaries$/, { timeout: 25000 });
    await page.locator('app-stream-summaries-page').waitFor({ state: 'attached', timeout: 20000 });
    assert.equal(state.twitchRedirects, 1, 'went through Twitch once');
    assert.equal(await remembered(page), null, 'remembered page consumed');
    assert.ok(!visitedDashboard(visited), `never opened the dashboard: ${visited.join(' → ')}`);
    const labels = await page.evaluate(() => window.__labels);
    assert.ok(labels.includes(LABEL_RETURN), `return label shown: ${labels.join(' | ')}`);
    assert.ok(!labels.includes(LABEL_DASHBOARD), `no dashboard label: ${labels.join(' | ')}`);
    if (shots) await page.screenshot({ path: `${shots}/login-return-summaries-390.png` });
    await context.close();
    passed.push('summaries email link (phone)');
  }

  // ---------- Query string survives (desktop) ----------
  {
    const { context } = await newContext(browser, { width: 1280, height: 820 });
    const { page, visited } = await openPage(context);
    await page.goto(`${base}/test/modules/clip-recommendations?ref=email`);
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    await signInWithTwitch(page);
    await page.waitForURL(/\/test\/modules\/clip-recommendations\?ref=email$/, { timeout: 25000 });
    await page.locator('app-clip-recommendations-page').waitFor({ state: 'attached', timeout: 20000 });
    assert.ok(!visitedDashboard(visited), 'clip link: never opened the dashboard');
    await context.close();
    passed.push('clip recommendations link with query (desktop)');
  }

  // ---------- Plain sign-in still opens the dashboard ----------
  {
    const { context } = await newContext(browser);
    const { page } = await openPage(context);
    await page.goto(`${base}/login`);
    assert.equal(await remembered(page), null, 'nothing remembered');
    await signInWithTwitch(page);
    await page.waitForURL(/\/test\/dashboard$/, { timeout: 25000 });
    const labels = await page.evaluate(() => window.__labels);
    assert.ok(labels.includes(LABEL_DASHBOARD), `dashboard label shown: ${labels.join(' | ')}`);
    assert.ok(!labels.includes(LABEL_RETURN), 'no return label on plain sign-in');
    await context.close();
    passed.push('plain sign-in → dashboard');
  }

  // ---------- Expired session → 401 → sign in → back ----------
  {
    const { context } = await newContext(browser, { session: true, expired: true });
    const { page, visited } = await openPage(context);
    await page.goto(`${base}/test/modules/stream-summaries`);
    await page.waitForURL(/\/401\?reason=expired/, { timeout: 20000 });
    assert.equal(await remembered(page), '/test/modules/stream-summaries', 'expired: page remembered');
    await page.locator('app-error-page .lf-err__actions .lf-btn--primary').click();
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    await signInWithTwitch(page);
    await page.waitForURL(/\/test\/modules\/stream-summaries$/, { timeout: 25000 });
    await page.locator('app-stream-summaries-page').waitFor({ state: 'attached', timeout: 20000 });
    assert.ok(!visitedDashboard(visited), 'expired: never opened the dashboard');
    await context.close();
    passed.push('expired session → 401 → back to summaries');
  }

  // ---------- A channel the user can't open still ends on 403 ----------
  {
    const { context } = await newContext(browser);
    const { page, visited } = await openPage(context);
    await page.goto(`${base}/other/modules/stream-summaries`);
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    await signInWithTwitch(page);
    await page.waitForURL(/\/403\?/, { timeout: 25000 });
    assert.equal(new URL(page.url()).searchParams.get('permission'), 'dashboard:view', '403 for dashboard:view');
    assert.equal(new URL(page.url()).searchParams.get('from'), '/other/modules/stream-summaries', '403 from');
    await page.locator('app-error-page h1').waitFor({ timeout: 20000 });
    assert.equal((await page.locator('app-error-page h1').textContent()).trim(), "You can't open this page");
    assert.ok(!visitedDashboard(visited), '403: no dashboard detour');
    await context.close();
    passed.push('no-access channel → 403');
  }

  // ---------- Stored session visiting /login resumes to the remembered page ----------
  {
    const { context, state } = await newContext(browser, { session: true });
    const { page } = await openPage(context);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
      path: '/test/modules/stream-summaries', expires: Date.now() + 60_000
    })), KEY);
    await page.goto(`${base}/login`);
    await page.waitForURL(/\/test\/modules\/stream-summaries$/, { timeout: 25000 });
    assert.equal(state.twitchRedirects, 0, 'resume: no Twitch round-trip');
    await context.close();
    passed.push('stored session resume → remembered page');
  }

  // ---------- Unsafe or stale stored values fall back to the dashboard ----------
  for (const [label, entry] of [
    ['protocol-relative', { path: '//evil.example/x', expires: Date.now() + 600_000 }],
    ['backslash', { path: '/\\evil.example/x', expires: Date.now() + 600_000 }],
    ['expired entry', { path: '/test/modules/stream-summaries', expires: Date.now() - 1000 }],
    ['login loop', { path: '/login?debug=x', expires: Date.now() + 600_000 }],
    ['in-channel 403', { path: '/test/403?permission=settings:view', expires: Date.now() + 600_000 }],
    ['not JSON', 'nope']
  ]) {
    const { context } = await newContext(browser);
    const { page } = await openPage(context);
    await page.goto(`${base}/login`);
    await page.evaluate(([key, value]) => localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)), [KEY, entry]);
    await signInWithTwitch(page);
    await page.waitForURL(/\/test\/dashboard$/, { timeout: 25000 });
    assert.equal(new URL(page.url()).origin, origin, `${label}: stayed on site`);
    await context.close();
  }
  passed.push('unsafe/expired stored values → dashboard');

  // ---------- Observability sign-in returns to /observability ----------
  {
    const { context } = await newContext(browser, { width: 1280, height: 820 });
    const { page } = await openPage(context);
    await page.goto(`${base}/observability`);
    const button = page.locator('app-observability-page section.state button.primary');
    await button.waitFor({ timeout: 20000 });
    await button.click();
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    assert.equal(await remembered(page), '/observability', 'observability remembered');
    await signInWithTwitch(page);
    await page.waitForURL(/\/observability$/, { timeout: 25000 });
    assert.equal(pathOf(page), '/observability');
    await context.close();
    passed.push('observability sign-in → /observability');
  }

  // ---------- Old link to an unknown channel: 404, then sign-in opens the dashboard ----------
  {
    const { context } = await newContext(browser);
    const { page } = await openPage(context);
    await page.goto(`${base}/ghost/modules/stream-summaries`);
    await page.waitForURL(/\/404(?:\?|$)/, { timeout: 20000 });
    // The sign-in guard ran alongside the 404 guard, so the dead link is remembered: the fallback must kick in.
    assert.equal(await remembered(page), '/ghost/modules/stream-summaries', '404: dead link was remembered');
    await page.locator('app-error-page a', { hasText: 'Sign in' }).first().click();
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    await signInWithTwitch(page);
    await page.waitForURL(/\/test\/dashboard$/, { timeout: 25000 });
    await context.close();
    passed.push('unknown channel 404 → dashboard after sign-in');
  }

  // ---------- Sign-in that goes to checkout clears the remembered page ----------
  {
    const { context, state } = await newContext(browser, { checkout: true });
    const { page } = await openPage(context);
    await page.goto(`${base}/test/modules/stream-summaries`);
    await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20000 });
    assert.equal(await rememberedIn(context), '/test/modules/stream-summaries', 'checkout: remembered before sign-in');
    await page.evaluate(() => {
      sessionStorage.setItem('billing.pendingPlan', 'pro');
      sessionStorage.setItem('billing.pendingPlanAt', String(Date.now()));
    });
    await signInWithTwitch(page);
    await until(() => state.offsite.some((u) => u.startsWith('https://polar.example/')), 'went to checkout', 25000);
    assert.equal(await rememberedIn(context), null, 'checkout: remembered page cleared');
    await context.close();
    passed.push('checkout sign-in clears remembered page');
  }

  // ---------- Admin hand-off only to the real admin origin ----------
  {
    const { context, state } = await newContext(browser);
    const { page } = await openPage(context);
    await page.goto(`${base}/login?returnTo=${encodeURIComponent('https://evil.example/admin.domdimabot.com')}`);
    const button = page.locator('app-login-page .lf-btn--primary:visible').first();
    await button.waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    assert.equal(state.twitchRedirects, 0, 'lookalike returnTo: no automatic Twitch login');
    await button.click();
    await page.waitForURL(/\/test\/dashboard$/, { timeout: 25000 });
    assert.deepEqual(state.offsite, [], 'lookalike returnTo: never sent anywhere off-site');
    await context.close();
  }
  {
    const { context, state } = await newContext(browser);
    const { page } = await openPage(context);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
      path: '/test/modules/stream-summaries', expires: Date.now() + 600_000
    })), KEY);
    assert.equal(await rememberedIn(context), '/test/modules/stream-summaries', 'admin: remembered before hand-off');
    await page.goto(`${base}/login?returnTo=${encodeURIComponent('https://admin.domdimabot.com')}`);
    await until(() => state.offsite.length > 0, 'admin hand-off', 25000);
    const target = new URL(state.offsite[0]);
    assert.equal(target.origin, 'https://admin.domdimabot.com', 'admin: token goes to the admin site');
    assert.equal(target.pathname, '/login', 'admin: /login');
    assert.ok(target.searchParams.get('token'), 'admin: token present');
    assert.equal(state.twitchRedirects, 1, 'admin: one Twitch round-trip');
    assert.equal(await rememberedIn(context), null, 'admin hand-off clears the remembered page');
    await context.close();
  }
  {
    const { context, state } = await newContext(browser);
    const { page } = await openPage(context);
    for (const forged of ['admin-https://admin.domdimabot.com', 'admin-https://evil.example']) {
      await page.goto(`${base}/login?code=attacker-code&state=${encodeURIComponent(forged)}`);
      await page.locator('app-login-page [role="alert"], app-login-page .lf-run--error, app-login-page .lf-term--error').first()
        .waitFor({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);
      assert.deepEqual(state.offsite, [], `forged admin callback (${forged}) refused`);
      assert.match(page.url(), /\/login\?/, `forged admin callback (${forged}) stays on login`);
    }
    await context.close();
    passed.push('admin hand-off: exact origin only, lookalike + forged callback refused');
  }

  console.log(`PASS login return: ${passed.join('; ')}`);
} finally {
  await browser.close();
}
