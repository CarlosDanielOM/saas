/** Isolated public downloads contract/UI checks. All external traffic is mocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const axePath = require.resolve('axe-core/axe.min.js');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const metadataBase = 'https://domdimabot.hel1.your-objectstorage.com/desktop';
const screenshots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/dima-app-downloads-verification';
let groups = 0;
const pass = (label) => { console.log(`PASS ${++groups}: ${label}`); };
function manifest(version = '0.1.0') {
  const artifact = (kind, suffix) => ({ kind, file: `Dima-${version}-${suffix}`,
    url: `${metadataBase}/releases/${version}/Dima-${version}-${suffix}`, size: 65_432_100, sha256: 'a'.repeat(64) });
  return { schema: 1, version, prerelease: version.includes('-'), publishedAt: '2026-10-26T00:00:00Z',
    platforms: {
      'windows-x64': [artifact('zip', 'windows-x64.zip'), artifact('installer', 'windows-x64-setup.exe')],
      'linux-x86_64': [artifact('tar.gz', 'linux-x86_64.tar.gz'), artifact('appimage', 'linux-x86_64.AppImage')]
    }, updates: { 'windows-x64': artifact('exe', 'windows-x64.exe') } };
}
const browser = await chromium.launch({ headless: true });
async function setup({ width = 1280, theme = 'dark', language = 'en', reply } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('userLanguage', language);
    // A stored session must not leak a bearer header to public metadata.
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'test-secret',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: { id: '123', login: 'fixture', display_name: 'Fixture' }, appUser: { name: 'Fixture', email: 'fixture@example.invalid', language, plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: '123', has_permissions: true, up_to_date_permissions: true, administrating: [] }, permissions: {} }));
  }, { theme, language });
  const calls = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.href.startsWith(metadataBase)) {
      assert.equal(route.request().headers()['authorization'], undefined, 'no public bearer header');
      assert.equal(route.request().headers()['cache-control'], undefined, 'no preflight-inducing custom cache header');
      calls.push(url.pathname);
      return reply ? reply(route, url, calls.length) : route.fulfill({ json: manifest(url.pathname.endsWith('latest-beta.json') ? '0.2.0-beta.1' : '0.1.0') });
    }
    // No production APIs, analytics, fonts or external side effects.
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${base.replace(/\/$/, '')}/download`);
  await page.locator('h1').waitFor();
  return { context, page, calls };
}
async function ready(page) { await page.locator('[data-kind="installer"]').waitFor(); }
async function noDownloads(page) { assert.equal(await page.locator('a[data-kind]').count(), 0); }
async function layout(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await axe.run(document.querySelector('app-dima-app-downloads'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
  assert.deepEqual(violations, []);
}
try {
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page, calls } = await setup({ theme, width });
    await ready(page);
    assert.equal(await page.locator('a[data-kind]').count(), 4);
    assert.equal(await page.locator('[data-platform="windows"] a[data-kind]').first().getAttribute('data-kind'), 'installer');
    assert.equal(await page.locator('[data-platform="linux"] a[data-kind]').first().getAttribute('data-kind'), 'appimage');
    for (const link of await page.locator('a[data-kind]').all()) {
      assert.ok((await link.getAttribute('href')).startsWith(`${metadataBase}/releases/0.1.0/`));
      assert.ok(!(await link.getAttribute('href')).endsWith('windows-x64.exe'));
    }
    await page.getByText('Already using Dima App?', { exact: true }).click();
    await page.getByText(/If your sign-in was session-only/).waitFor();
    await page.getByText(/never restart automatically/).waitFor();
    await layout(page);
    if (screenshots) {
      await fs.mkdir(screenshots, { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `${screenshots}/download-${width}-${theme}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: 'Beta', exact: true }).click();
    await page.getByText('Version 0.2.0-beta.1', { exact: true }).waitFor();
    assert.equal(calls.at(-1), '/desktop/latest-beta.json');
    assert.equal(await page.locator('a[data-kind]').count(), 4);
    assert.equal(calls.length, 2, 'one request per selected channel; no polling');
    await context.close();
    pass(`approved stable/beta, recommendations, no updater exe, no token, axe/overflow ${width} ${theme}`);
  }
  {
    const { context, page } = await setup({ width: 320, language: 'es' });
    await ready(page);
    await page.getByRole('link', { name: /Descargar instalador de Windows/ }).waitFor();
    await page.getByText('¿Ya usas Dima App?', { exact: true }).click();
    await page.getByText(/Si tu sesión era temporal/).waitFor();
    await layout(page);
    await page.getByRole('button', { name: 'Modo claro', exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    await page.getByRole('button', { name: 'Switch to English' }).click();
    await page.getByRole('link', { name: /Download Windows installer/ }).waitFor();
    await context.close();
    pass('Spanish, language/theme controls and 320px layout');
  }
  {
    const value = manifest();
    value.platforms['windows-x64'] = [value.platforms['windows-x64'][1]];
    value.platforms['linux-x86_64'] = [value.platforms['linux-x86_64'][1]];
    const { context, page } = await setup({ reply: route => route.fulfill({ json: value }) });
    await ready(page);
    assert.equal(await page.locator('a[data-kind]').count(), 2, 'portable alternatives are optional');
    await page.getByRole('button', { name: 'Beta', exact: true }).click();
    await ready(page);
    await page.getByText('Version 0.1.0', { exact: true }).waitFor();
    await context.close();
    pass('recommended-only release and beta pointer accepting an approved stable version');
  }
  for (const status of [403, 404]) {
    const { context, page } = await setup({ reply: route => route.fulfill({ status, body: '' }) });
    await page.getByText('Downloads are not available yet', { exact: true }).waitFor();
    await noDownloads(page);
    await layout(page);
    await context.close();
    pass(`HTTP ${status}: cautious unavailable copy, retry, no fabricated links`);
  }
  {
    const { context, page, calls } = await setup({ reply: (route, url, count) => count === 1 ? route.abort('failed') : route.fulfill({ json: manifest() }) });
    await page.getByText('We could not load downloads', { exact: true }).waitFor();
    await noDownloads(page);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await ready(page);
    assert.equal(calls.length, 2);
    await context.close();
    pass('network/CORS-style failure and successful manual retry');
  }
  {
    const held = [];
    const { context, page } = await setup({ reply: route => new Promise(resolve => held.push({ route, resolve })) });
    await page.getByText('Checking available downloads…', { exact: true }).waitFor();
    await page.getByText('We could not load downloads', { exact: true }).waitFor({ timeout: 15000 });
    await noDownloads(page);
    for (const request of held) { try { await request.route.abort(); } catch {} request.resolve(); }
    await context.close();
    pass('12-second stalled-request timeout becomes retryable without links');
  }
  for (const [label, mutate] of [
    ['schema', m => { m.schema = 2; }], ['external URL', m => { m.platforms['windows-x64'][0].url = 'https://example.invalid/evil.zip'; }],
    ['path traversal', m => { m.platforms['linux-x86_64'][0].file = '../payload'; }], ['hash', m => { m.platforms['windows-x64'][0].sha256 = 'bad'; }],
    ['size', m => { m.platforms['linux-x86_64'][0].size = -1; }], ['missing platform', m => { delete m.platforms['linux-x86_64']; }],
    ['duplicate kind', m => { m.platforms['windows-x64'][0] = m.platforms['windows-x64'][1]; }],
    ['prerelease stable', m => Object.assign(m, manifest('0.2.0-beta.1'))],
    ['version', m => { m.version = '../../draft'; }], ['date', m => { m.publishedAt = 'not-a-date'; }]
  ]) {
    const value = manifest(); mutate(value);
    const { context, page } = await setup({ reply: route => route.fulfill({ json: value }) });
    await page.getByText('Download information could not be verified', { exact: true }).waitFor();
    await noDownloads(page);
    await context.close();
    pass(`invalid ${label} hides all download links`);
  }
  {
    const { context, page } = await setup({ reply: route => route.fulfill({ body: '{bad json', contentType: 'application/json' }) });
    await page.getByText('Download information could not be verified', { exact: true }).waitFor();
    await noDownloads(page); await context.close();
    pass('malformed JSON hides all download links');
  }
  {
    const held = [];
    const { context, page, calls } = await setup({ reply: (route, url) => new Promise(resolve => held.push({ route, url, resolve })) });
    await page.getByText('Checking available downloads…', { exact: true }).waitFor();
    await noDownloads(page);
    await page.getByRole('button', { name: 'Beta', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(calls.length, 2);
    const beta = held.find(h => h.url.pathname.endsWith('latest-beta.json'));
    assert.ok(beta);
    await beta.route.fulfill({ json: manifest('0.2.0-beta.1') }); beta.resolve();
    await page.getByText('Version 0.2.0-beta.1', { exact: true }).waitFor();
    const stable = held.find(h => h.url.pathname.endsWith('latest.json'));
    try { await stable.route.fulfill({ json: manifest() }); } catch { /* canceled request */ }
    stable.resolve();
    await page.waitForTimeout(100);
    await page.getByText('Version 0.2.0-beta.1', { exact: true }).waitFor();
    await context.close();
    pass('loading state, channel cancellation and stale response cannot replace beta');
  }
  {
    const { context, page } = await setup();
    await ready(page);
    await page.getByRole('link', { name: 'Back to DomDimaBot', exact: true }).first().click();
    await page.waitForURL(`${base.replace(/\/$/, '')}/`);
    await page.locator('.lf-app-link').waitFor();
    for (const width of [320, 960, 1280]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `landing overflow at ${width}`);
      await page.locator('.lf-app-link').click();
      await page.waitForURL('**/download');
      await ready(page);
      await page.getByRole('link', { name: 'Back to DomDimaBot', exact: true }).first().click();
      await page.waitForURL(`${base.replace(/\/$/, '')}/`);
    }
    await context.close();
    pass('landing Dima App link works on mobile/desktop and browser routing returns home');
  }
} finally { await browser.close(); }
console.log(`All ${groups} downloads groups passed.`);
