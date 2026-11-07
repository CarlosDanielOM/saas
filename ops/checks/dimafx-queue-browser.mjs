// Behavior check: the streamer's DimaFX page shows what viewers queued and lets the streamer skip, remove or clear it
// (Twitch extension rule 7.4). All APIs are mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991405', login: 'fx_owner', display_name: 'FX_Owner' };
const app = { name: 'FX_Owner', email: 'fx@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const items = [{ id: 'i1', _id: 'i1', name: 'Airhorn', category: 'audio', bitsPrice: 5, sku: 'dimafx_bits_5', isEnabled: true, sortOrder: 1, volume: 100, durationMs: 2000 }];
const seedQueue = () => ({
  playing: { id: 'j1', itemID: 'i2', itemName: 'Say anything', category: 'tts', source: 'bits', viewerName: 'Viewer_One', text: 'hello chat, great stream', createdAt: new Date().toISOString() },
  queued: [
    { id: 'j2', itemID: 'i1', itemName: 'Airhorn', category: 'audio', source: 'credits', viewerName: null, text: null, createdAt: new Date().toISOString() },
    { id: 'j3', itemID: 'i2', itemName: 'Say anything', category: 'tts', source: 'bits', viewerName: 'Viewer_Two', text: 'a very long message '.repeat(12).trim(), createdAt: new Date().toISOString() },
  ],
});
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const until = async (fn, label, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  assert.fail(`timed out: ${label}`);
};
async function open({ theme = 'dark', width = 1280, edit = true, language = 'en' } = {}) {
  const state = { queue: seedQueue(), calls: [] };
  const localizedApp = { ...app, language };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme, language }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app: localizedApp, theme, language });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith(`/${user.id}/`)) return route.fulfill({ response: await route.fetch({ url: base + (process.env.SAAS_DEV_PREVIEW ? '/index.html' : '/index.csr.html') }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    const ok = (data, extra = {}) => route.fulfill({ json: { error: false, status: 200, data, ...extra } });
    if (url.pathname.startsWith('/auth/access/')) {
      const permission = url.searchParams.get('permission') || '';
      const allowed = permission.startsWith('dimafx:') && permission !== 'dimafx:view' ? edit : true;
      return route.fulfill({ status: allowed ? 200 : 403, json: { error: !allowed, data: { allowed } } });
    }
    const prefix = `/extensions/dimafx/${user.id}`;
    if (url.pathname === `${prefix}/items`) return ok(items, { meta: { allowedBitPrices: [5, 10, 25, 50, 100] } });
    if (url.pathname === `${prefix}/overlay-status`) return ok({ connected: true, overlayUrl: 'https://api.domdimabot.com/overlays/dimafx/fixture' });
    if (url.pathname === `${prefix}/queue`) { state.calls.push('get'); return ok(state.queue); }
    if (url.pathname === `${prefix}/queue/skip` && method === 'POST') {
      const id = request.postDataJSON()?.id;
      state.calls.push(`skip:${id}`);
      if (state.queue.playing?.id === id) state.queue.playing = null;
      state.queue.queued = state.queue.queued.filter(entry => entry.id !== id);
      return ok({ skipped: id });
    }
    if (url.pathname === `${prefix}/queue/clear` && method === 'POST') {
      state.calls.push('clear');
      const removed = state.queue.queued.length; state.queue.queued = [];
      return ok({ removed });
    }
    if (url.pathname === `/users/${user.id}`) return ok({ id: user.id, login: user.login });
    if (url.pathname === '/auth/session') return ok({ twitch: user, app: localizedApp });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'pro' });
    if (url.pathname.includes('/library') || url.pathname.includes('/public')) return ok([]);
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}/${user.id}/modules/dimafx`);
  await page.locator('.lf-item-list, .lf-skeleton-list').first().waitFor();
  return { context, page, state };
}
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-dimafx-page') || document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target).slice(0, 3) })), [], label);
}
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow: ${label}`);
try {
  if (shots) await mkdir(shots, { recursive: true });
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 1280]) {
      const label = `${theme}@${width}`;
      const { context, page, state } = await open({ theme, width });
      const tile = page.locator('.lf-queue');
      await tile.waitFor();
      const playing = tile.locator('.lf-queue__row--playing');
      assert.match(await playing.innerText(), /Playing[\s\S]*Say anything[\s\S]*Bits[\s\S]*from Viewer_One[\s\S]*hello chat, great stream/, `${label}: playing entry names the viewer and their text`);
      assert.equal(await tile.locator('.lf-queue__row').count(), 3);
      await noOverflow(page, label);
      await axe(page, `${label} queue`);
      if (shots) await page.locator('.lf-queue').screenshot({ path: `${shots}/dimafx-queue-${label}.png` });
      // Skip acts at once (speed matters live) and takes the playing entry off.
      await playing.getByRole('button', { name: 'Skip Say anything' }).click();
      await until(() => tile.locator('.lf-queue__row--playing').count().then(n => n === 0), `${label}: playing entry skipped`);
      assert.ok(state.calls.includes('skip:j1'));
      // Clearing several asks once more.
      const clear = tile.getByRole('button', { name: 'Clear queue' });
      await clear.click();
      await until(() => tile.getByRole('button', { name: 'Clear 2?' }).count().then(n => n === 1), `${label}: clear asks to confirm`);
      assert.equal(state.calls.includes('clear'), false, `${label}: first tap clears nothing`);
      await tile.getByRole('button', { name: 'Clear 2?' }).click();
      await until(() => tile.locator('.lf-queue__empty').count().then(n => n === 1), `${label}: queue emptied`);
      assert.ok(state.calls.includes('clear'));
      await context.close();
    }
  }
  // Removing one waiting play, in Spanish (es-MX).
  {
    const { context, page, state } = await open({ language: 'es', width: 390 });
    const tile = page.locator('.lf-queue');
    await tile.waitFor();
    assert.match(await tile.innerText(), /Reproduciendo ahora[\s\S]*de Viewer_One/);
    await tile.getByRole('button', { name: 'Quitar Airhorn de la cola' }).click();
    await until(() => Promise.resolve(state.calls.includes('skip:j2')), 'remove one queued play');
    await until(() => tile.locator('.lf-queue__row').count().then(n => n === 2), 'queued row removed');
    await context.close();
  }
  // Without edit permission the queue controls are not shown or requested.
  {
    const { context, page, state } = await open({ edit: false, width: 390 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.lf-queue').count(), 0, 'no queue tile without permission');
    assert.equal(state.calls.length, 0, 'queue not requested without permission');
    await context.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('PASS DimaFX streamer queue: playing entry with viewer name + text, skip, remove, two-tap clear, es-MX, permission gate, axe + overflow at 390/1280 in dark and light');
} finally { await browser.close(); }
