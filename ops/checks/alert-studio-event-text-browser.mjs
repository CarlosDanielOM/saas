// Mocked Studio account: each alert event's sample text is rendered with that event's own sample.
import assert from 'node:assert/strict';
const { chromium } = await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL || process.argv[2]; assert(base);
const api = 'https://api.domdimabot.com';
const user = { id: '990193', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = text => ({ id: 'line', kind: 'text', text, fontSize: 48, x: 0, y: 0, width: 800, height: 240, visible: true, locked: false });
const design = { id: 'design', name: 'Alerts', revision: 1, width: 800, height: 240, events: {
  follow: { duration: 2, widgets: [layer('$(user) followed')] }, bits: { duration: 2, widgets: [layer('$(user) sent $(cheer.amount) bits')] },
  sub: { duration: 2, widgets: [layer('$(user) subscribed')] }, raid: { duration: 2, widgets: [layer('$(user) raided')] } } };
const state = { schemaVersion: 1, revision: 1, designs: [design], scenes: [{ id: 'main', name: 'Main', publicId: 'd'.repeat(48), revision: 1, width: 1280, height: 720, waitFor: ['bits'],
  widgets: [{ id: 'alert', kind: 'alert', designId: 'design', events: ['follow', 'bits', 'sub', 'raid'], x: 0, y: 0, width: 800, height: 240, visible: true, locked: false }] }] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await sleep(25); } throw Error(label); }
// Mirrors the API sample: only the Bits sample carries a bits amount.
const sample = body => body.texts.map(t => t.replaceAll('$(user)', body.user).replaceAll('$(cheer.amount)', body.kind === 'bits' ? String(body.amount) : '0'));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }); const errors = [];
    await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })), { user, app });
    await context.routeWebSocket('**/*', ws => ws.close());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.origin !== api) return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
      else if (url.pathname.endsWith('/preview')) { await sleep(400); return route.fulfill({ json: { data: sample(req.postDataJSON()) } }); }
      else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
      else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, events: [] };
      else if (url.pathname === '/overlay-studio/' + user.id) data = state;
      else if (url.pathname.startsWith('/triggers/')) data = [];
      return route.fulfill({ json: { data } });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/fixture/modules/overlays'); await page.locator('.stage').waitFor({ timeout: 10000 });
    const stageText = () => page.locator('.stage .layer-content span').first().textContent();
    await until(async () => await stageText() === 'Luna followed', 'idle follow text rendered');
    await page.locator('.design-row__actions button').first().click();
    await until(async () => await stageText() === 'Luna followed', 'design editor follow text');
    await page.evaluate(() => { window.seen = []; new MutationObserver(() => { for (const s of document.querySelectorAll('.stage .layer-content span')) window.seen.push(s.textContent); }).observe(document.querySelector('.stage'), { subtree: true, childList: true, characterData: true }); });
    await page.locator('.design-event-tabs').getByRole('button', { name: 'Bits', exact: true }).click();
    await until(async () => await stageText() === 'Luna sent 100 bits', 'bits text');
    await sleep(900); // Let any background render settle; it must not flip the value.
    const seen = await page.evaluate(() => window.seen);
    assert(!seen.some(t => / 0 bits/.test(t)), 'Bits tab never shows a 0-bit sample: ' + JSON.stringify([...new Set(seen)]));
    assert.equal(await stageText(), 'Luna sent 100 bits');
    await page.locator('.design-event-tabs').getByRole('button', { name: 'Follows', exact: true }).click();
    await until(async () => await stageText() === 'Luna followed', 'back to follow text');
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS Studio sample text: each alert event renders with its own sample; switching to Bits shows the bits amount immediately, never 0 first; mobile/desktop');
} finally { await browser.close(); }
