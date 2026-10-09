/**
 * Behavior check: unified error pages (401/403/404/500/503) and the guards that route to them.
 * All APIs are mocked; nothing reaches production services.
 *
 *  - every code renders its title, code chip, decorative screen and actions; axe (wcag2a/2aa/21aa)
 *    clean and no horizontal overflow at 320/390/1280 in dark (first) and light;
 *  - 403 shows the human permission label ("Bot settings · View"), never the raw id, plus the page;
 *  - 503 counts down an auto retry that can be stopped; "Try now"/"Try again" return to `from`;
 *  - guards: unknown route → 404; expired session (401 from /auth/session) → /401?reason=expired with
 *    the session cleared; API unreachable → /503 with the session kept; a channel you can't open →
 *    /403 (dashboard:view); a page your admin role lacks → embedded 403 inside the app shell with
 *    "You're an admin on dima, but not for Admin list";
 *  - Spanish copy via the language toggle.
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

const OWN = '123456789';
const DIMA = '555000111';
const TWITCH = { id: OWN, login: 'test', display_name: 'Test Streamer', profile_image_url: '' };
const APP = {
  name: 'Test Streamer', email: 'test@example.invalid', language: 'en', plan_tier: 'free', actived: true,
  chat_enabled: true, twitch_user_id: OWN, has_permissions: true, up_to_date_permissions: true,
  administrating: [{ channelID: DIMA, channelName: 'dima' }]
};
const env = (data) => ({ error: false, status: 200, message: 'ok', data });

async function until(fn, label, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** `session`: seed a signed-in session. `sessionMode`: ok | expired | down. `access`: per-path overrides. */
async function newContext(browser, { width = 390, height = 844, dark = true, session = false, sessionMode = 'ok', denyDashboard = [], denyPermission = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
  await context.addInitScript(({ twitch, app, dark, session }) => {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    if (session && !sessionStorage.getItem('check.seeded')) {
      sessionStorage.setItem('check.seeded', '1');
      localStorage.setItem('dimasite.session.v1', JSON.stringify({
        version: 2, token: 'test-only', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
      }));
    }
  }, { twitch: TWITCH, app: APP, dark, session });

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const path = url.pathname;
    if (path === '/auth/session') {
      if (sessionMode === 'expired') return route.fulfill({ status: 401, json: { error: true, status: 401, message: 'Unauthorized' } });
      if (sessionMode === 'down') return route.abort('connectionrefused');
      return route.fulfill({ json: env({ twitch: TWITCH, app: APP }) });
    }
    const dash = path.match(/^\/dashboard\/([^/]+)\/access$/);
    if (dash) {
      const allowed = !denyDashboard.includes(dash[1]);
      return route.fulfill({ json: env({ allowed, role: allowed ? 'admin' : 'none', channelID: dash[1], planTier: 'free' }) });
    }
    const access = path.match(/^\/auth\/access\/([^/]+)$/);
    if (access) {
      const permission = url.searchParams.get('permission');
      if (denyPermission.includes(permission)) {
        return route.fulfill({ status: 403, json: { error: true, status: 403, data: { allowed: false } } });
      }
      return route.fulfill({ json: env({ allowed: true, role: 'admin' }) });
    }
    if (path === '/users') return route.fulfill({ json: env({ id: OWN, username: 'test', profile_image_url: '' }) });
    return route.fulfill({ json: env({}) });
  });
  return context;
}

async function axe(page, label) {
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-error-page'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  }));
  const violations = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  assert.deepEqual(violations, [], `${label}: axe`);
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
}

const h1 = (page) => page.locator('app-error-page h1').textContent().then((t) => t.trim());

const PAGES = [
  { path: '/401', code: '401', title: 'Sign in to see this page', primary: 'Sign in with Twitch' },
  { path: '/401?reason=expired', code: '401', title: 'Your session expired', primary: 'Sign in with Twitch' },
  { path: '/403?permission=settings:view&from=%2Ftest%2Fsettings', code: '403', title: "You can't open this page", primary: 'Back home' },
  { path: '/404', code: '404', title: "This page doesn't exist", primary: 'Back home' },
  { path: '/500', code: '500', title: 'Something broke on our side', primary: 'Try again' },
  { path: '/503', code: '503', title: "We'll be right back", primary: 'Try now' }
];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // ---------- Every page, every viewport, dark first ----------
  for (const dark of [true, false]) {
    for (const [width, height] of [[1280, 820], [390, 844], [320, 640]]) {
      const context = await newContext(browser, { width, height, dark });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      for (const spec of PAGES) {
        const label = `${spec.path} ${dark ? 'dark' : 'light'} ${width}`;
        await page.goto(`${base}${spec.path}`);
        await page.locator('app-error-page h1').waitFor({ timeout: 20000 });
        assert.equal(await h1(page), spec.title, `${label}: title`);
        assert.equal((await page.locator('.lf-err__code').textContent()).trim(), `Error ${spec.code}`, `${label}: code chip`);
        assert.equal(await page.locator('.lf-screen[aria-hidden="true"]').count(), 1, `${label}: decorative screen`);
        const primary = page.locator('.lf-err__actions .lf-btn--primary');
        assert.equal((await primary.textContent()).trim(), spec.primary, `${label}: primary action`);
        const box = await primary.boundingBox();
        assert.ok(box.height >= 44, `${label}: primary touch target`);
        assert.equal(await page.locator('.lf-err__actions .lf-btn').count(), 2, `${label}: two actions`);
        if (spec.code === '403') {
          const facts = (await page.locator('.lf-err__facts').textContent()).replace(/\s+/g, ' ');
          assert.match(facts, /Bot settings ?· View/, `${label}: human permission label`);
          assert.match(facts, /\/test\/settings/, `${label}: page shown`);
          assert.ok(!(await page.locator('app-error-page').textContent()).includes('settings:view'), `${label}: no raw permission id`);
        }
        await noOverflow(page, label);
        await axe(page, label);
        if (shots && width !== 320) {
          await page.screenshot({ path: `${shots}/err-${spec.code}${spec.path.includes('expired') ? '-expired' : ''}-${dark ? 'dark' : 'light'}-${width}.png` });
        }
      }
      assert.deepEqual(errors, [], `errors ${dark} ${width}`);
      await context.close();
    }
  }

  // ---------- 503 auto retry + retry back to `from` ----------
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(`${base}/503?from=%2F404`);
    const status = page.locator('.lf-err__retry');
    await status.waitFor({ timeout: 20000 });
    const first = await status.textContent();
    assert.match(first, /Trying again in (29|30)s/);
    await until(async () => /Trying again in 2[0-8]s/.test(await status.textContent()), 'countdown ticks');
    await page.locator('.lf-err__stop').click();
    await until(async () => (await page.locator('.lf-err__retry').count()) === 0, 'auto retry stopped');
    await page.locator('.lf-err__actions .lf-btn--primary').click();
    await page.waitForURL(/\/404$/, { timeout: 15000 });

    await page.goto(`${base}/500?from=%2F404`);
    await page.locator('.lf-err__actions .lf-btn--primary').click();
    await page.waitForURL(/\/404$/, { timeout: 15000 });
    await page.goto(`${base}/500?from=https%3A%2F%2Fevil.example`);
    await page.locator('app-error-page h1').waitFor();
    await page.locator('.lf-err__actions .lf-btn--primary').click();
    await page.waitForTimeout(800);
    assert.ok(page.url().startsWith(origin), '500 retry ignores off-site `from`');
    await context.close();
  }

  // ---------- Guards route to the right page ----------
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(`${base}/this/route/does/not/exist/at/all`);
    await page.waitForURL(/\/404$/, { timeout: 15000 });
    assert.equal(await h1(page), "This page doesn't exist");
    await context.close();
  }
  {
    const context = await newContext(browser, { session: true, sessionMode: 'expired' });
    const page = await context.newPage();
    await page.goto(`${base}/test/dashboard`);
    await page.waitForURL(/\/401\?reason=expired$/, { timeout: 15000 });
    assert.equal(await h1(page), 'Your session expired');
    assert.equal(await page.evaluate(() => localStorage.getItem('dimasite.session.v1')), null, 'expired session cleared');
    await context.close();
  }
  {
    const context = await newContext(browser, { session: true, sessionMode: 'down' });
    const page = await context.newPage();
    await page.goto(`${base}/test/dashboard`);
    await page.waitForURL(/\/503\?from=%2Ftest%2Fdashboard$/, { timeout: 15000 });
    assert.equal(await h1(page), "We'll be right back");
    assert.ok(await page.evaluate(() => localStorage.getItem('dimasite.session.v1')), 'outage keeps the session');
    await context.close();
  }
  {
    const context = await newContext(browser, { session: true, denyDashboard: [DIMA] });
    const page = await context.newPage();
    await page.goto(`${base}/dima/dashboard`);
    await page.waitForURL(/\/403\?permission=dashboard:view&from=%2Fdima%2Fdashboard$/, { timeout: 15000 });
    assert.equal(await h1(page), "You can't open this page");
    assert.match(await page.locator('.lf-err__copy').textContent(), /doesn't have access to this part of the channel/);
    assert.equal((await page.locator('.lf-err__actions .lf-btn--primary').textContent()).trim(), 'My dashboard: Test Streamer');
    await context.close();
  }
  {
    const context = await newContext(browser, { width: 1280, height: 820, session: true, denyPermission: ['admins:view'] });
    const page = await context.newPage();
    await page.goto(`${base}/dima/settings`);
    await page.waitForURL(/\/dima\/403\?permission=admins:view/, { timeout: 15000 });
    await page.locator('app-error-page .lf--embedded').waitFor();
    assert.equal(await page.locator('app-error-page .lf-nav').count(), 0, 'embedded: no second navbar');
    assert.ok(await page.locator('.auth-navbar, app-authenticated-layout').count(), 'embedded: app shell present');
    assert.match(await page.locator('.lf-err__copy').textContent(), /You're an admin on dima, but not for Admin list/);
    assert.equal((await page.locator('.lf-err__actions .lf-btn--primary').textContent()).trim(), 'Open dima dashboard');
    await noOverflow(page, 'embedded 403');
    await axe(page, 'embedded 403');
    if (shots) await page.screenshot({ path: `${shots}/err-403-embedded-dark-1280.png` });
    await context.close();
  }

  // ---------- Spanish ----------
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(`${base}/404`);
    await page.locator('app-error-page h1').waitFor({ timeout: 20000 });
    await page.locator('.lf-nav__actions button').first().click();
    await until(async () => (await h1(page)) === 'Esta página no existe', 'spanish 404');
    await page.goto(`${base}/503`);
    await until(async () => (await h1(page)) === 'Ya volvemos', 'spanish 503');
    assert.match(await page.locator('.lf-err__retry').textContent(), /Reintentando en \d+s/);
    await context.close();
  }

  console.log('PASS error pages 401/403/404/500/503: copy, actions, human 403 labels, 503 auto retry + stop, safe retry to from, guards (404, expired→401, outage→503 keeps session, no channel access→403, embedded 403 in shell), es; axe + overflow at 320/390/1280 dark/light');
} finally {
  await browser.close();
}
