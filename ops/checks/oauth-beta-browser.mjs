/** Mock every backend call. No production identity, credit, or OAuth session is mutated. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base);
const requestID = 'A'.repeat(43);
const scopes = ['profile:read', 'credits:read', 'desktop:connect', 'pet:read', 'pet:receive',
  'pet:control', 'pet:playback:select', 'ai:interact', 'pet:interact'];
const twitch = { id: '99003101', login: 'oauth_owner', display_name: 'OAuth Owner' };
const appUser = { name: 'OAuth Owner', email: 'private@example.invalid', language: 'en', plan_tier: 'free',
  twitch_user_id: twitch.id, actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const session = { version: 2, token: 'oauth-beta-browser-owner', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600000).toISOString(), twitchUser: twitch, appUser, permissions: {} };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let signedIn = true, expired = false, decisions = [], sessions = [];
await context.addInitScript(({ session }) => {
  localStorage.setItem('dimasite.session.v1', JSON.stringify(session));
  localStorage.setItem('userLanguage', 'en');
  localStorage.setItem('theme', 'dark');
}, { session });
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://api.domdimabot.com') {
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body),
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    if (route.request().method() === 'OPTIONS') return json({});
    if (path === `/oauth/requests/${requestID}`) return expired ? json({ error: 'invalid_request' }, 400) : json({
      client_id: 'dima-desktop', client_name: 'Dima Desktop Beta', device_name: 'Streaming PC',
      scopes, redirect_uri: 'http://127.0.0.1:42781/oauth/callback' });
    if (path === '/oauth/browser-session') return signedIn ? json({ name: 'oauth_owner', user_id: 'test-user', channel_id: twitch.id }) : json({ error: 'login_required' }, 401);
    if (path === `/oauth/requests/${requestID}/decision`) {
      assert.equal(route.request().headers()['authorization'], `Bearer ${session.token}`);
      const input = route.request().postDataJSON(); decisions.push(input);
      return json({ redirect_uri: `http://127.0.0.1:42781/oauth/callback?${input.approve ? 'code=one-use-code' : 'error=access_denied'}&state=test-state&iss=https%3A%2F%2Fapi.domdimabot.com` });
    }
    if (path === '/oauth/connections') return json({ sessions });
    if (path.startsWith('/oauth/connections/') && route.request().method() === 'DELETE') {
      sessions = sessions.filter(item => item._id !== path.split('/').pop()); return json({ revoked: true });
    }
    if (path.startsWith('/oauth/grants/') && route.request().method() === 'DELETE') { sessions = []; return json({ revoked: true }); }
    if (path === '/auth/session') return json({ error: false, data: { twitch, app: appUser } });
    if (path === '/auth/exchange-code') return json({ error: false, data: { access_token: session.token,
      refresh_token: 'fixture-only-browser-refresh', twitch_user: twitch, state: 'fresh-login-state' } });
    if (path === '/auth/login') return json({ error: false, data: appUser });
    return json({ error: false, data: {} });
  }
  if (url.hostname === '127.0.0.1' && url.port === '42781') return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Desktop callback</title><h1>Desktop callback received</h1>' });
  if (url.origin === new URL(base).origin) return route.continue();
  // Block analytics, Twitch and every other external service during browser checks.
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
const consent = () => page.goto(`${base}/oauth/authorize?request=${requestID}`);
const axePath = `${tools}/node_modules/axe-core/axe.min.js`;
async function assertPermissions(language) {
  const permissions = page.locator('.permissions li');
  assert.equal(await permissions.count(), scopes.length, `${language}: all requested permissions disclosed`);
  assert.doesNotMatch(await page.locator('.permissions').innerText(), /oauth\.(?:scopes|descriptions)\.|ai:actions/,
    `${language}: no missing translations or separate action gate`);
  assert.doesNotMatch(await page.locator('app-oauth-page').innerText(),
    /does not enable pet playback or paid actions|no permite reproducir la mascota ni realizar acciones de pago/,
    `${language}: no obsolete beta disclaimer contradicts the interaction permissions`);
  const labels = language === 'en'
    ? ['Talk with your bot as the streamer', 'Talk with your pet as the streamer']
    : ['Hablar con tu bot como streamer', 'Hablar con tu mascota como streamer'];
  for (const label of labels) {
    const disclosure = await permissions.filter({ has: page.getByText(label, { exact: true }) }).innerText();
    for (const expression of language === 'en'
      ? [/streamer-level tools/, /moderation and channel changes/, /read and update shared memory/,
          /existing settings/, /spend AI and TTS credits/]
      : [/herramientas habituales de streamer/, /moderación y los cambios del canal/,
          /leer y actualizar la memoria compartida/, /ajustes actuales/, /gastar créditos de IA y TTS/]) {
      assert.match(disclosure, expression, `${language}: ${label}`);
    }
  }
}
async function checkLayouts(language) {
  for (const theme of ['dark', 'light']) {
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await consent();
      await page.getByRole('button', { name: 'Allow connection', exact: true }).waitFor();
      // The fixture restores its English session on each navigation. Select Spanish
      // through the actual control after that restoration has completed.
      if (language === 'es') {
        await page.getByRole('button', { name: 'Change language' }).click();
        await page.getByRole('button', { name: 'Permitir conexión', exact: true }).waitFor();
      }
      // Drive ThemeService through the real control so shared logos and page tokens agree.
      const isDark = await page.locator('html').evaluate(node => node.classList.contains('dark'));
      const themeLabel = language === 'en' ? (isDark ? 'Dark' : 'Light') : (isDark ? 'Oscuro' : 'Claro');
      if (isDark !== (theme === 'dark')) await page.getByRole('button', { name: themeLabel, exact: true }).click();
      assert.ok(await page.getByText(language === 'en' ? 'Signed in as oauth_owner' : 'Sesión iniciada como oauth_owner', { exact: true }).isVisible());
      await assertPermissions(language);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${language}/${theme}/${width}: overflow`);
      await page.addScriptTag({ path: axePath });
      const violations = await page.evaluate(async () => (await axe.run(document.querySelector('app-oauth-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(item => `${item.id}: ${item.nodes.map(node => node.target.join(' ')).join(', ')}`));
      assert.deepEqual(violations, [], `${language}/${theme}/${width}: accessibility`);
      if (process.env.SAAS_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/oauth-${language}-${theme}-${width}.png`, fullPage: true });
    }
  }
}
await checkLayouts('en');
await page.getByRole('button', { name: 'Allow connection', exact: true }).click();
await page.waitForURL('**/oauth/callback?code=**');
assert.deepEqual(decisions.pop(), { approve: true });
assert.ok(!page.url().includes(session.token));
await consent();
await page.getByRole('button', { name: 'Deny', exact: true }).click();
await page.waitForURL('**/oauth/callback?error=access_denied**');
assert.deepEqual(decisions.pop(), { approve: false });
await consent();
await page.getByRole('button', { name: 'Change language' }).click();
await page.getByRole('button', { name: 'Permitir conexión', exact: true }).waitFor();
assert.ok(await page.getByText('Ver tu saldo de créditos de IA', { exact: true }).isVisible());
await checkLayouts('es');
expired = true;
await consent();
await page.getByRole('alert').waitFor();
assert.equal(await page.getByRole('button', { name: /Allow connection|Permitir conexión/ }).count(), 0);
expired = false;
signedIn = false;
await consent();
await page.getByRole('button', { name: 'Sign in with Twitch', exact: true }).click();
await page.waitForURL('**/login');
assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('dimasite.oauth.return.v1'))).path, `/oauth/authorize?request=${requestID}`);
signedIn = true;
await page.evaluate(session => localStorage.setItem('dimasite.session.v1', JSON.stringify(session)), session);
await page.goto(`${base}/login`);
await page.waitForURL(`**/oauth/authorize?request=${requestID}`);
await page.getByRole('button', { name: 'Allow connection', exact: true }).waitFor();
assert.equal(await page.evaluate(() => sessionStorage.getItem('dimasite.oauth.return.v1')), null);
// Exercise the real code-callback branch too, rather than only resuming a stored session.
await page.evaluate(requestID => {
  localStorage.removeItem('dimasite.session.v1');
  localStorage.setItem('dimasite.oauth.state', 'fresh-login-state');
  sessionStorage.setItem('dimasite.oauth.return.v1', JSON.stringify({ path: `/oauth/authorize?request=${requestID}`, expires: Date.now() + 600000 }));
}, requestID);
await page.goto(`${base}/login?code=fixture-code&state=fresh-login-state`);
await page.waitForURL(`**/oauth/authorize?request=${requestID}`);
await page.getByRole('button', { name: 'Allow connection', exact: true }).waitFor();
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.getByRole('button', { name: 'Sign in with Twitch', exact: true }).waitFor();
await page.evaluate(session => localStorage.setItem('dimasite.session.v1', JSON.stringify(session)), session);
sessions = [
  { _id: '1', grant_id: 'grant', device_name: 'Streaming PC', client_id: 'dima-desktop', scopes },
  { _id: '2', grant_id: 'grant', device_name: 'Laptop', client_id: 'dima-desktop', scopes: ['profile:read'] }
];
await page.goto(`${base}/oauth/connections`);
await page.getByRole('heading', { name: 'Streaming PC', exact: true }).waitFor();
const streamingConnection = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Streaming PC', exact: true }) });
assert.equal(await streamingConnection.getByRole('listitem').count(), scopes.length);
assert.doesNotMatch(await streamingConnection.innerText(), /oauth\.scopes\./);
await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Laptop', exact: true }) }).getByRole('button', { name: 'Disconnect this computer', exact: true }).click();
await page.getByRole('heading', { name: 'Laptop', exact: true }).waitFor({ state: 'detached' });
assert.equal(sessions.length, 1);
await page.getByRole('button', { name: 'Disconnect app on all computers', exact: true }).click();
await page.getByText('No applications are currently connected.', { exact: true }).waitFor();
// A framed consent page must never expose an approval button.
await page.route(`${base}/oauth-frame-test`, route => route.fulfill({ contentType: 'text/html',
  body: `<title>Frame test</title><iframe title="Consent" src="/oauth/authorize?request=${requestID}"></iframe>` }));
await page.goto(`${base}/oauth-frame-test`);
await page.frameLocator('iframe').getByRole('alert').waitFor();
assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Allow connection', exact: true }).count(), 0);
assert.deepEqual(errors, []);
await browser.close();
console.log('PASS OAuth browser: nine scope disclosures with streamer actions/memory/spending, EN/ES dark/light mobile/desktop, axe, allow/deny, expired request, login resume, per-device/app revocation');
