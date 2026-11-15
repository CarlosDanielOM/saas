// Dima default alerts in the browser (2026-11-15): the public overlay library files, the /mocks/dev/default-alerts page
// playing every alert through the real renderer, and the Overlay Studio editing the default design (library pictures and
// sounds, the "Gifted subs" look, what a save sends). Every API and socket is faked; nothing reaches production.
//   scripts/saas-ops verify site-<run> --check ops/checks/default-alerts-browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const api = 'https://api.domdimabot.com';
const designs = { en: JSON.parse(await readFile('/root/saas/ops/checks/default-alerts-fixtures/design-en.json', 'utf8')), es: JSON.parse(await readFile('/root/saas/ops/checks/default-alerts-fixtures/design-es.json', 'utf8')) };
const EVENTS = ['follow', 'bits', 'sub', 'gift', 'raid'];
const LIBRARY = [...EVENTS.flatMap(e => [...['badge', 'card', 'glow', 'ring', 'sparkle'].map(p => `v1/${p}-${e}.webp`), `v1/sound-${e}.mp3`]), 'v1/wind-raid.webp', ...[1, 2, 3, 4].map(n => `v1/confetti${n}-gift.webp`)];

// 1. Every library file the designs reference is served by the site.
const referenced = new Set();
const collect = layout => { for (const w of layout.widgets) if (w.library) referenced.add(w.library); for (const s of layout.sounds ?? []) if (s.library) referenced.add(s.library); };
for (const d of Object.values(designs)) { Object.values(d.events).forEach(collect); d.variants.sub.forEach(v => collect(v.layout)); }
assert.equal(referenced.size, LIBRARY.length, 'the designs use every library file');
for (const file of LIBRARY) {
  const response = await fetch(`${base}/overlay-library/${file}`);
  assert.equal(response.status, 200, file);
  const bytes = Buffer.from(await response.arrayBuffer()), type = response.headers.get('content-type') ?? '';
  assert(bytes.length > 60, file + ' is not empty');
  if (file.endsWith('.webp')) assert(bytes.subarray(8, 12).toString() === 'WEBP' && !/html/.test(type), file + ' is a WebP picture');
  else assert(bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff, file + ' is an MP3');
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = page => { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/api\.domdimabot\.com|ERR_FAILED|websocket/i.test(m.text())) errors.push(m.text()); }); };
async function until(predicate, label, tries = 240) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }
try {
  // 2. The proposal page plays each alert through the real renderer: pictures decoded, the right sound, the right words.
  for (const options of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }]) {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, isMobile: options.isMobile, hasTouch: options.hasTouch });
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
    const page = await context.newPage(); watch(page); page.setDefaultTimeout(12000);
    await page.goto(base + '/mocks/dev/default-alerts');
    await page.locator('.da__stage app-overlay-scene-renderer').waitFor();
    const expected = { follow: ['New follower', 'LunaPlays'], bits: ['Cheered', 'LunaPlays', '500', 'bits'], sub: ['New subscriber', 'LunaPlays'], gift: ['Gifted subs', 'LunaPlays', '5', 'subs'], raid: ['Raid incoming', 'LunaPlays', '42', 'viewers'] };
    for (const kind of EVENTS) {
      await page.locator(`.chip[data-kind=${kind}]`).click();
      await until(() => page.evaluate(() => { const el = document.querySelector('.da__stage .placement[data-ready-key]'); return !!el && !el.hasAttribute('data-waiting'); }), kind + ' revealed');
      const shown = await page.evaluate(() => {
        const root = document.querySelector('.da__stage .placement[data-ready-key]');
        return { images: [...root.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })), texts: [...root.querySelectorAll('[data-kind=text] span')].map(s => s.textContent.trim()) };
      });
      assert(shown.images.length >= 8 && shown.images.every(i => i.ok && i.src.startsWith('/overlay-library/v1/')), kind + ': every picture decoded from the library ' + JSON.stringify(shown.images.filter(i => !i.ok)));
      assert.deepEqual(shown.texts, expected[kind], kind + ' text');
      await until(() => page.evaluate(k => [...document.querySelectorAll('.da__stage audio')].some(a => a.currentSrc.endsWith(`/overlay-library/v1/sound-${k}.mp3`) && !a.error && a.readyState >= 1), kind), kind + ' sound loaded');
      await until(() => page.evaluate(() => !document.querySelector('.da__stage .placement[data-ready-key]')), kind + ' finished', 480);
    }
    await page.getByRole('button', { name: 'Español' }).click();
    await page.locator('.chip[data-kind=raid]').click();
    await until(() => page.evaluate(() => [...document.querySelectorAll('.da__stage [data-kind=text] span')].map(s => s.textContent.trim()).join('|') === '¡Llegó un raid!|LunaPlays|42|espectadores'), 'Spanish raid text');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no sideways scroll at ' + options.width);
    await context.close();
  }

  // 3. Overlay Studio with the default design: library pictures and sounds show and play, gifted subs, saves keep ids.
  const user = { id: '990591', login: 'fixture', display_name: 'Fixture' };
  const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
  const widgets = [layer('tts-1', 'tts', 670, 62, 580, 160), layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const ctx = { bodies: [], tests: [], state: { schemaVersion: 1, revision: 1, designs: [structuredClone(designs.en)], scenes: [{ id: 'main', name: 'My overlay', revision: 0, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['tts'], widgets }] } };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(({ user, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', 'en'); localStorage.setItem('theme', 'dark');
  }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined;
    let data = {};
    if (url.pathname === `/asset-library/${user.id}`) data = { assets: [], usedBytes: 0, quotaBytes: 100000000, maxFileBytes: 50000000, planTier: 'free' };
    else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'free' };
    else if (url.pathname.endsWith('/preview')) { ctx.tests.push(body); data = body.texts.map(t => t.replaceAll('$(user)', body.user).replaceAll('$(gift.count)', body.tier === 'gift' ? String(body.amount) : '0')); }
    else if (url.pathname.endsWith('/test')) { ctx.tests.push(body); data = { sent: true, clients: 1 }; }
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: ctx.state.scenes.map(s => ({ id: s.id, published: false, revision: s.revision, width: 1920, height: 1080, receives: ['tts'], sources: [] })) };
    else if (url.pathname.endsWith('/live')) data = { revision: ctx.state.revision, live: { main: false } };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT') { ctx.bodies.push(structuredClone(body)); ctx.state = { ...ctx.state, designs: body.designs, scenes: body.scenes.map(s => ({ ...s, publicId: 'a'.repeat(48), revision: 0 })), revision: ctx.state.revision + 1 }; }
      data = { ...ctx.state, live: { main: false } };
    } else if (url.pathname.startsWith('/triggers/') || url.pathname.includes('bits-rules')) data = url.pathname.includes('bits-rules') ? { revision: 0, rules: [], legacy: false } : [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); watch(page); page.setDefaultTimeout(12000);
  await page.goto(base + '/fixture/modules/overlays');
  await page.locator('app-overlay-editor .stage').waitFor();
  // The design list preview already draws the library badge.
  await until(() => page.evaluate(() => [...document.querySelectorAll('app-overlay-editor img')].some(i => i.getAttribute('src') === '/overlay-library/v1/badge-follow.webp' && i.naturalWidth > 0)), 'library badge in the Studio');
  await page.locator('.design-row__actions button').first().click();
  await page.locator('.design-event-tabs').waitFor();
  // Pick the badge: its panel says it comes from the Dima library.
  await page.locator('.layer-row[data-layer-id=badge] .layer').click();
  if (!(await page.locator('.studio-pane.properties').isVisible())) await page.locator('.studio-rtab[data-tab="layer"]').click();
  await page.locator('.library-pick').waitFor();
  assert.match(await page.locator('.library-pick').textContent(), /Dima library/);
  await page.locator('app-overlay-sounds').getByText('Dima · Follow').waitFor();
  // Subs: the "Gifted subs" look is listed and set to every gifted sub.
  await page.locator('.design-event-tabs button', { hasText: 'Sub' }).first().click();
  const variants = page.locator('app-overlay-variants');
  if (!(await variants.isVisible())) await page.locator('.studio-rtab[data-tab="layer"], [data-pane="variants"]').first().click().catch(() => {});
  await variants.locator('.v-row', { hasText: 'Gifted subs' }).click();
  assert.equal(await variants.locator('select').inputValue(), 'gift');
  // An edit, then save: the body keeps library ids and the gift look, never file URLs.
  await variants.getByLabel('Name').fill('Gift bombs'); await variants.getByLabel('Name').press('Tab');
  await page.locator('.save-button').first().click();
  await until(() => ctx.bodies.length === 1, 'saved');
  const saved = ctx.bodies[0].designs[0];
  assert.equal(saved.variants.sub[0].gift, true); assert.equal(saved.variants.sub[0].tier, undefined); assert.equal(saved.variants.sub[0].name, 'Gift bombs');
  assert.equal(saved.events.follow.widgets.find(w => w.id === 'badge').library, 'dima-follow-badge');
  assert(JSON.stringify(saved).indexOf('/overlay-library/') === -1, 'no library URLs are saved');
  assert.deepEqual(saved.events.raid.sounds.map(s => s.library), ['dima-raid-sound']);
  // Switching the look back to a tier drops the gift flag.
  await variants.locator('select').selectOption('2000');
  await page.locator('.save-button').first().click();
  await until(() => ctx.bodies.length === 2, 'saved again');
  assert.deepEqual([ctx.bodies[1].designs[0].variants.sub[0].tier, ctx.bodies[1].designs[0].variants.sub[0].gift], ['2000', undefined]);
  await context.close();
  assert.deepEqual(errors, [], 'no page errors');
  console.log('default alerts browser check passed');
} finally { await browser.close(); }
