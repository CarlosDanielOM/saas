// Login/authorization regression check against the exact admin candidate.
// No live tokens, grants, emails, or API mutations; every external request is intercepted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/analytics-access-shots';
await mkdir(shots, { recursive: true });
const summary = { count: 12, average: 10, p50: 10, p95: 25, p99: 25, errors: 0, max: 20 };
const date = new Date().toISOString();
const span = { at: date, trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), parent_id: null,
  service: 'bot', channel: '123', kind: 'chat', name: 'fixture request', outcome: 'ok', duration: 10, partial: false };
const overview = { lastAt: date, generatedAt: date, http: summary, chat: summary, groups: [], timeline: [], minutes: 60 };
const session = (id = '900002') => ({ version: 2, token: 'fixture-only', createdAt: date,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  twitchUser: { id, login: 'invited', display_name: 'Invited User' },
  appUser: { twitch_user_id: id, name: 'Invited User', administrating: [] } });
const callback = id => '/login?token=' + encodeURIComponent(Buffer.from(JSON.stringify(session(id))).toString('base64'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const state = { role: 'viewer', channels: ['123'], failure: 0, adminCalls: [], external: [] };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') {
        // Inspect the outgoing login link without contacting Twitch or the public site.
        if (url.hostname === 'domdimabot.com' && url.pathname === '/login') {
          state.external.push(url.toString());
          return route.fulfill({ contentType: 'text/html', body: 'Disposable OAuth stand-in' });
        }
        return route.abort();
      }
      if (!url.pathname.startsWith('/config/site/analytics')) {
        assert.equal(request.headers().authorization, 'Bearer fixture-only', url.pathname);
      }
      assert.equal(request.method(), 'GET', 'No API mutations in this check');
      if (url.pathname.startsWith('/observability/api/')) {
        if (state.failure) return route.fulfill({ status: state.failure, json: { message: 'Fixture denied' } });
        const name = url.pathname.split('/api/')[1];
        const json = name === 'session' ? { grant: { role: state.role, channels: state.channels, services: [] }, channelNames: { '123': 'pixelpilot' } }
          : name === 'overview' ? overview : name === 'resources' ? { samples: [] }
          : name === 'traces' ? { spans: [span] } : name.startsWith('traces/') ? { spans: [span], partial: true }
          : name === 'logs' ? { logs: [] } : { grants: [] };
        return route.fulfill({ json });
      }
      state.adminCalls.push(url.pathname);
      const json = url.pathname.startsWith('/admin-site/users')
        ? { data: { rows: [], pagination: { page: 1, totalPages: 1, total: 0, limit: 100 }, summary: { totalChannels: 0 } } }
        : { data: {} };
      return route.fulfill({ json });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const analytics = async () => {
      await page.getByRole('heading', { name: 'System analytics', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Calls', exact: true }).waitFor();
    };
    const tab = name => page.getByRole('button', { name, exact: true });

    // A direct invitation link requires sign-in and remembers the analytics view across OAuth.
    await page.goto(base + '/observability?tab=chat');
    await page.waitForURL(/\/login\?/);
    assert.equal(new URL(page.url()).searchParams.get('returnTo'), '/observability?tab=chat');
    await page.getByRole('button', { name: 'Continue with Twitch' }).click();
    await page.waitForURL('https://domdimabot.com/login?*');
    assert.equal(new URL(state.external[0]).searchParams.get('returnTo'), 'https://admin.domdimabot.com');
    await page.goto(base + callback('900002'));
    await analytics();
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'chat', page.url());
    assert(!page.url().includes('token='), 'OAuth token removed from URL');
    assert.deepEqual(state.adminCalls, [], 'Invitee never loads an admin API');

    // Analytics-only shell: desktop and mobile menus have no admin destinations.
    for (const theme of ['dark', 'light']) {
      await page.evaluate(mode => {
        localStorage.setItem('dima-admin.mode.v1', mode);
        window.dispatchEvent(new StorageEvent('storage', { key: 'dima-admin.mode.v1' }));
      }, theme);
      await page.locator('html' + (theme === 'dark' ? '.dark' : ':not(.dark)')).waitFor();
      await page.getByRole('button', { name: 'Account menu', exact: true }).click();
      await page.getByText('Analytics access', { exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Settings', exact: true }).count(), 0);
      const destinations = await page.locator('app-navbar a[href^="/"]').evaluateAll(links => links.map(link => link.getAttribute('href')));
      assert(destinations.every(path => path === '/observability'), JSON.stringify(destinations));
      await page.keyboard.press('Escape');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow ${width} ${theme}`);
      await page.addScriptTag({ path: `${tools}/node_modules/axe-core/axe.min.js` });
      const axe = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `accessibility ${width} ${theme}`);
      await page.screenshot({ path: `${shots}/invitee-${width}-${theme}.png`, fullPage: true });
    }
    for (const name of ['Servers', 'Traces', 'Logs', 'Access']) assert.equal(await tab(name).count(), 0, `scoped viewer cannot open ${name}`);

    // Direct URLs and browser history navigation cannot mount admin pages.
    for (const path of ['/dashboard', '/users', '/settings', '/read-tool', '/email-test', '/analytics', '/channels/123', '/channels/123/usage', '/channels/123/eventsubs', '/channels/123/commands']) {
      await page.goto(base + path);
      await analytics();
      assert.equal(new URL(page.url()).pathname, '/observability');
    }
    await page.evaluate(() => {
      history.pushState({}, '', '/users');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForURL(/\/observability/);
    assert.deepEqual(state.adminCalls, [], 'Admin APIs remain untouched on forbidden navigation');

    state.role = 'investigator';
    await page.goto(base + '/observability?tab=traces');
    await analytics();
    await tab('Logs').waitFor();
    assert.equal(await tab('Access').count(), 0);
    await page.getByRole('button').filter({ hasText: 'fixture request' }).click();
    await page.getByRole('dialog').waitFor();
    // A revoked/expired grant clears a previously open trace on the next refresh.
    state.failure = 403;
    await page.getByRole('alert').filter({ hasText: "doesn't have analytics access" }).waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.obs-tabs').count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.goto(base + '/observability');
    await page.waitForURL(/access-denied/);
    await page.getByText(/doesn’t have active analytics access/).waitFor();

    // Temporary outage is distinct from missing permission; retry recovers.
    state.failure = 503;
    await page.goto(base + '/observability');
    await page.getByRole('heading', { name: 'Analytics is unavailable.' }).waitFor();
    state.failure = 0;
    await page.getByRole('link', { name: 'Retry', exact: true }).click();
    await analytics();
    state.failure = 401;
    await page.goto(base + '/observability');
    await page.waitForURL(/\/login/);
    assert.equal(await page.evaluate(() => localStorage.getItem('dima-admin.session.v1')), null);

    // Ordinary login (no invitation URL) also sends an analytics invitee to analytics.
    state.failure = 0;
    await page.goto(base + callback('900002'));
    await analytics();
    assert.equal(new URL(page.url()).pathname, '/observability');
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(/\/login/);
    await page.goto(base + '/observability');
    await page.waitForURL(/\/login/);

    // Existing owner login keeps the admin landing and full navigation.
    await page.goto(base + callback('533538623'));
    await page.waitForURL(/\/dashboard/);
    await page.getByRole('link', { name: 'Users', exact: true }).last().waitFor({ state: 'attached' });
    await page.goto(base + '/users');
    await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
    assert(state.adminCalls.some(path => path.startsWith('/admin-site/users')));
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Analytics invitation/login, scoped viewer/investigator, admin isolation, expiration/revocation, outage retry, sign-out, owner regression, axe and overflow passed at 320/390/1280 dark/light');
} finally {
  await browser.close();
}
