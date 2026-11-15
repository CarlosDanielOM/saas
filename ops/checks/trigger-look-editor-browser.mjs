// Trigger look editor: Triggers page dialog (owner and channel admin) and Overlay Studio's in-place entry.
// Every API, socket and media request is mocked with disposable fixtures; nothing reaches production.
// Checks are run from a copy by saas-ops verify, so shared helpers are imported by absolute path.
import { openStudio, closeStudioMenus } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const AXE = process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const repo = process.env.SAAS_REPO_ROOT || '/root/saas';
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const api = 'https://api.domdimabot.com';
const owner = { id: '991777', login: 'lookfixture', display_name: 'Look Fixture' };
const helper = { id: '991778', login: 'modfixture', display_name: 'Mod Fixture' };
const hex = n => String(n).padStart(24, '0');

// ── Fixtures (generated here, never downloaded) ───────────────────────────────
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function png(width, height, rgb) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.forEach((v, i) => { rows[y * (width * 3 + 1) + 1 + x * 3 + i] = v; });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds) {
  const b = Buffer.alloc(44 + 16000 * seconds);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const files = {
  'portrait.png': { mime: 'image/png', body: png(20, 40, [124, 58, 237]) },
  'wide.png': { mime: 'image/png', body: png(32, 18, [20, 160, 90]) },
  'spark.gif': { mime: 'image/gif', body: Buffer.from('47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex') },
  'chime.wav': { mime: 'audio/wav', body: wav(3) },
  'drum.wav': { mime: 'audio/wav', body: wav(20) },
  'clip.webm': { mime: 'video/webm', body: readFileSync(`${repo}/ops/checks/clip-recommendations-fixtures/moment-1.webm`) }
};
function media(route, name) {
  const file = files[name]; if (!file) return route.abort();
  const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/), size = file.body.length;
  const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  return route.fulfill({ status: range ? 206 : 200, contentType: file.mime, headers: { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) }, body: file.body.subarray(start, end + 1) });
}
const TYPE = { 'image/png': 'image', 'image/gif': 'gif', 'audio/wav': 'audio', 'video/webm': 'video' };
function item(n, name, file, alias) {
  const f = files[file], mediaType = TYPE[f.mime];
  const asset = { _id: hex(n), displayName: alias ?? name, fileName: file, extension: file.split('.').pop(), mimeType: f.mime, mediaType, bytes: f.body.length,
    ownerChannelID: owner.id, ownerChannelName: owner.login, scope: 'private', marketplaceStatus: 'not_listed', storageUrl: `https://media.fixture.invalid/${file}`, playbackUrl: `https://media.fixture.invalid/${file}?k=fx${n}` };
  return { _id: hex(n + 100), assetID: asset._id, relationType: 'owner_upload', localAlias: null, quotaBytesCharged: 0, assetScope: 'private', mediaType, isActive: true, asset };
}
const trigger = (n, name, libraryItem, extra = {}) => ({ _id: hex(500 + n), name, channel: owner.login, channelID: owner.id, rewardID: '', file: name, type: 'media', mediaType: libraryItem.asset.mimeType,
  isEnabled: true, cost: 0, cooldown: 0, prompt: '', volume: 100, libraryItemID: libraryItem._id, assetID: libraryItem.assetID, reward: null, ...extra });
const GONE = hex(999);

function initialData({ plan = 'pro', manyPictures = false, extra = false } = {}) {
  const library = [item(1, 'Big_Clip', 'clip.webm'), item(2, 'Portrait', 'portrait.png'), item(3, 'Spark', 'spark.gif'), item(4, 'Chime', 'chime.wav'), item(5, 'Drum', 'drum.wav'), item(6, 'Wide', 'wide.png')];
  if (manyPictures) for (let i = 0; i < 6; i++) library.push(item(20 + i, 'Extra_' + i, 'wide.png'));
  const [clip, portrait, , chime, drum] = library;
  const triggers = [trigger(1, 'Video_Trigger', clip), trigger(2, 'Picture_Trigger', portrait), trigger(3, 'Sound_Trigger', chime), trigger(4, 'Looked_Trigger', portrait, { volume: 50 }),
    // Its file is no longer in the library: a new look starts empty and says so.
    trigger(5, 'Lost_Trigger', item(60, 'Gone', 'wide.png'))];
  const looks = new Map();
  // An existing look: a text, a picture whose library item was removed, and one sound at 80%.
  looks.set(triggers[3]._id, { revision: 3, look: { width: 1280, height: 720, revision: 3, updatedAt: new Date().toISOString(), layout: { duration: 5, widgets: [
    { id: 'text-1', kind: 'text', name: 'Title', x: 100, y: 80, width: 600, height: 120, visible: true, locked: false, text: 'Big moment $(channel)', fontSize: 64 },
    { id: 'image-1', kind: 'image', name: 'Old picture', x: 200, y: 260, width: 300, height: 300, visible: true, locked: false, mediaId: GONE }
  ], sounds: [{ id: 'sound-1', mediaId: drum._id, name: 'Drum', volume: 0.8, delay: 0, fadeIn: 0, fadeOut: 0 }] } } });
  if (extra) {
    // Muted (volume 0); its look uses its own file twice, Drum (also in Looked_Trigger's look) and Chime (Sound_Trigger's file).
    const wide = library[5], muted = trigger(6, 'Muted_Trigger', wide, { volume: 0 });
    triggers.push(muted);
    looks.set(muted._id, { revision: 1, look: { width: 1280, height: 720, revision: 1, updatedAt: new Date().toISOString(), layout: { duration: 5, widgets: [
      { id: 'image-1', kind: 'image', name: 'Wide A', x: 0, y: 0, width: 320, height: 180, visible: true, locked: false, mediaId: wide._id },
      { id: 'image-2', kind: 'image', name: 'Wide B', x: 400, y: 0, width: 320, height: 180, visible: true, locked: false, mediaId: wide._id },
      { id: 'text-1', kind: 'text', name: 'Thanks', x: 100, y: 400, width: 600, height: 120, visible: true, locked: false, text: 'Thanks!', fontSize: 48 }
    ], sounds: [{ id: 'sound-1', mediaId: drum._id, name: 'Drum', volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }, { id: 'sound-2', mediaId: chime._id, name: 'Chime', volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }] } } });
  }
  return { library, triggers, looks, meta: { planTier: plan, quotaBytesUsed: 0, quotaBytesLimit: 1_000_000_000 } };
}
function editorForm(data, look) {
  if (!look) return null;
  const find = id => data.library.find(entry => entry._id === id && entry.isActive && entry.asset);
  const layout = structuredClone(look.layout);
  layout.widgets = layout.widgets.map(w => { if (!w.mediaId) return w; const hit = find(w.mediaId); return hit ? { ...w, mediaUrl: hit.asset.playbackUrl, mediaType: hit.asset.mediaType } : { ...w, unavailable: true }; });
  if (layout.sounds) layout.sounds = layout.sounds.map(s => { const hit = find(s.mediaId); return hit ? { ...s, url: hit.asset.playbackUrl, mediaType: 'audio' } : { ...s, unavailable: true }; });
  return { ...look, layout };
}
/** The list/create/update summary (contract section 3): `mediaIds` = library items the look references, each once. */
const summary = look => look && ({ revision: look.revision, width: look.width, height: look.height, updatedAt: look.updatedAt, objectCount: look.layout.widgets.length, soundCount: look.layout.sounds?.length ?? 0,
  mediaIds: [...new Set([...look.layout.widgets.map(w => w.mediaId), ...(look.layout.sounds ?? []).map(s => s.mediaId)].filter(Boolean))] });

function studioState() {
  const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, { duration: 5, widgets: [layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)' })] }])) };
  const widgets = [layer('trigger-1', 'trigger', 80, 750, 500, 230), layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['follow'] })];
  return { schemaVersion: 1, revision: 4, scenes: [{ id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets, published: { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: [], designs: [design] } }], designs: [design] };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function until(predicate, label, tries = 240) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open({ width = 1280, dark = true, touch = false, lang = 'en', as = 'owner', plan = 'pro', manyPictures = false, path = 'triggers', libraryDelay = 0, recoveryOffer = false, extra = false } = {}) {
  const user = as === 'owner' ? owner : helper;
  const app = { name: user.display_name, email: 'fixture@example.invalid', language: lang, plan_tier: plan, actived: true, chat_enabled: true, twitch_user_id: user.id,
    has_permissions: true, up_to_date_permissions: true, administrating: as === 'owner' ? [] : [{ channelID: owner.id, channelName: owner.login }] };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, dark, lang }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', lang); localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, { user, app, dark, lang });
  // A recovery copy left by an earlier Studio tab (written once per test page), so the Studio offers it.
  if (recoveryOffer) {
    const state = studioState();
    const draft = { schemaVersion: 1, writer: 2, channelID: owner.id, updatedAt: Date.now(), revision: state.revision, designs: state.designs, designDraft: null,
      scenes: state.scenes.map(({ publicId: _p, published: _pub, revision: _r, ...scene }) => ({ ...scene, name: 'Recovered gameplay' })), sceneId: 'main', designEvent: 'follow', variantId: null, selectedId: null };
    await context.addInitScript(({ key, draft }) => { if (sessionStorage.getItem('fixture-offer')) return; sessionStorage.setItem('fixture-offer', '1'); localStorage.setItem(key, JSON.stringify(draft)); }, { key: OFFERED_KEY, draft });
  }
  const data = initialData({ plan, manyPictures, extra });
  // delay: { get, put } in ms for the look routes; failGet answers the look GET with a 500.
  const ctx = { data, requests: [], puts: [], deletes: [], uploads: [], renders: [], renderBodies: [], sends: [], patches: [], refuseDelete: null, studioPuts: [], next: null, studio: studioState(), sockets: [], delay: {}, failGet: false };
  // Every socket attempt is recorded (and refused): embedded mode must never try one.
  await context.routeWebSocket(/.*/, ws => { ctx.sockets.push(ws.url()); ws.close(); });
  context.on('request', request => ctx.requests.push(request.method() + ' ' + request.url()));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method();
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname === 'media.fixture.invalid') return media(route, p.slice(1));
    if (url.origin !== api) return route.abort();
    const json = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : undefined;
    const fail = (status, code, message) => route.fulfill({ status, json: { error: true, status, message, code } });
    let body = {};
    const look = p.match(new RegExp(`^/triggers/${owner.id}/([0-9a-f]{24})/look$`));
    if (p === '/auth/session') body = { twitch: user, app };
    else if (p.startsWith('/auth/access/') || p.endsWith('/access')) body = { allowed: true, role: as === 'owner' ? 'owner' : 'admin', planTier: plan };
    else if (look) {
      if (method === 'GET' && ctx.failGet) return fail(500, null, 'Fixture failure');
      const getDelay = ctx.delay.getFor?.[look[1]] ?? ctx.delay.get;
      if (method === 'GET' && getDelay) await sleep(getDelay);
      if (method === 'PUT' && ctx.delay.put) await sleep(ctx.delay.put);
      const id = look[1], entry = data.looks.get(id) ?? { revision: 0, look: null }, t = data.triggers.find(x => x._id === id);
      if (method === 'PUT') {
        ctx.puts.push(structuredClone(json));
        const next = ctx.next; ctx.next = null;
        if (next === 'conflict' || json.revision !== entry.revision) return fail(409, 'look_conflict', 'This look was changed somewhere else. Reload it before saving.');
        if (next) return fail(400, next, 'Rejected by the fixture');
        const stored = { width: json.width, height: json.height, layout: json.layout, revision: entry.revision + 1, updatedAt: new Date().toISOString() };
        data.looks.set(id, { revision: entry.revision + 1, look: stored }); t.look = summary(stored);
        body = { look: editorForm(data, stored), volume: t.volume, revision: entry.revision + 1 };
      } else if (method === 'DELETE') {
        ctx.deletes.push(url.searchParams.get('revision'));
        if (Number(url.searchParams.get('revision')) !== entry.revision) return fail(409, 'look_conflict', 'This look was changed somewhere else. Reload it first.');
        data.looks.set(id, { revision: entry.revision + 1, look: null }); delete t.look;
        body = { look: null, volume: t.volume, revision: entry.revision + 1 };
      } else body = { look: editorForm(data, entry.look), volume: t.volume, revision: entry.revision };
    }
    // Like the API: a sample viewer (`user`, default Luna) stands in for whoever fires the trigger.
    else if (p === `/triggers/${owner.id}/look/render`) { ctx.renders.push(json.texts); ctx.renderBodies.push(json); body = json.texts.map(text => text.replaceAll('$(channel)', owner.login).replaceAll('$(user)', typeof json.user === 'string' ? json.user : 'Luna')); }
    else if (p === `/triggers/library/${owner.id}/upload`) {
      const multipart = request.postDataBuffer().toString('latin1'); ctx.uploads.push(multipart);
      const added = item(40 + ctx.uploads.length, (multipart.match(/name="name"\r\n\r\n([^\r]*)/) || [])[1] || 'Upload', multipart.includes('Content-Type: audio/wav') ? 'chime.wav' : 'wide.png');
      data.library.unshift(added); body = added;
    }
    else if (p === `/triggers/library/${owner.id}`) { if (libraryDelay) await sleep(libraryDelay); return route.fulfill({ json: { error: false, status: 200, data: data.library, total: data.library.length, meta: data.meta } }); }
    else if (p === `/triggers/${owner.id}/send`) { ctx.sends.push(json); body = {}; }
    else if (method === 'DELETE' && p.startsWith(`/triggers/library/${owner.id}/`)) {
      if (ctx.refuseDelete) return fail(409, 'media_in_use', ctx.refuseDelete);
      const id = p.split('/').pop(); data.library = data.library.filter(entry => entry._id !== id); body = {};
    }
    else if (method === 'PATCH' && new RegExp(`^/triggers/${owner.id}/[0-9a-f]{24}$`).test(p)) {
      ctx.patches.push(structuredClone(json));
      const t = data.triggers.find(x => x._id === p.split('/').pop()); Object.assign(t, json.name ? { name: json.name } : {}, 'volume' in json ? { volume: json.volume } : {});
      const l = data.looks.get(t._id)?.look; const { look: _l, ...rest } = t; body = l ? { ...rest, look: summary(l) } : rest;
    }
    else if (p === `/extensions/dimafx/${owner.id}/items`) body = [];
    else if (p === `/triggers/${owner.id}`) body = data.triggers.map(t => { const l = data.looks.get(t._id)?.look; const { look: _l, ...rest } = t; return l ? { ...rest, look: summary(l) } : rest; });
    else if (p.startsWith('/overlays/triggers/')) return route.fulfill({ body: '<!doctype html><title>Trigger overlay</title>', contentType: 'text/html' });
    else if (p === `/overlay-studio/${owner.id}`) { if (method === 'PUT') { ctx.studioPuts.push(structuredClone(json)); ctx.studio = { ...ctx.studio, revision: ctx.studio.revision + 1, scenes: json.scenes.map(s => ({ ...s, publicId: 'a'.repeat(48), revision: 3 })), designs: json.designs }; } body = ctx.studio; }
    else if (p.endsWith('/queue')) body = { state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] };
    else if (p.endsWith('/connections')) body = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
    else if (p.endsWith('/preview')) body = json.texts;
    return route.fulfill({ json: { error: false, status: 200, data: body, meta: data.meta } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', e => errors.push(e.message)); ctx.downloads = 0; page.on('download', () => ctx.downloads++);
  await page.goto(`${base}/${owner.login}/modules/${path === 'studio' ? 'overlays' : path === 'library' ? 'library' : 'triggers'}`);
  if (path === 'studio') await page.locator('app-overlay-editor .stage').waitFor();
  else if (path === 'library') await page.locator('app-media-library-page .lf-lib-row:not(.lf-lib-row--skeleton)').first().waitFor();
  else await page.locator('app-triggers-page .lf-trigger').first().waitFor();
  return { context, page, ctx, user };
}
const row = (page, name) => page.locator('app-triggers-page .lf-trigger').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });
const dialog = page => page.locator('app-trigger-look-dialog .tld');
const editor = page => page.locator('app-trigger-look-dialog app-overlay-editor');
async function openLook(page, name) {
  await row(page, name).locator('.lf-trigger__look').click();
  await dialog(page).waitFor();
  await editor(page).locator('.look-save').waitFor();
  await until(() => page.locator('.look-status').innerText().then(t => !/Opening|Abriendo/.test(t)), 'look loaded');
}
async function closeLook(page) {
  await page.locator('.look-back').click();
}
async function axe(page, selector, label) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async selector => (await window.axe.run(document.querySelector(selector), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(', ')}`), selector);
  assert.deepEqual(violations, [], 'axe ' + label);
}
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('.tld, .tmp-panel')].some(el => el.scrollWidth > el.clientWidth + 1));
async function shot(page, name) { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); }
/** The trigger's file length as the editor measures it (metadata, rounded up to 0.1 s, 1–120 s, 10 s fallback). */
const measured = (page, url, kind) => page.evaluate(({ url, kind }) => new Promise(resolve => {
  const el = document.createElement(kind); el.preload = 'metadata'; el.muted = true;
  const done = s => resolve(s); setTimeout(() => done(10), 4000);
  el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? Math.min(120, Math.max(1, Math.ceil(el.duration * 10 - 1e-6) / 10)) : 10);
  el.onerror = () => done(10); el.src = url;
}), { url, kind });
const studioKeys = page => page.evaluate(() => Object.keys(localStorage).filter(k => /overlay-draft|overlayStudio|overlay-editor/i.test(k)).sort().map(k => k + '=' + localStorage.getItem(k)));
const lengthInput = page => page.locator('.look-settings input[type=number]').nth(2);
const OFFERED_KEY = `domdimabot-overlay-draft:${owner.id}:00000000-0000-4000-8000-000000000000`;
/** Every localStorage entry (to prove nothing was written or removed). */
const storageDump = page => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
/** The Studio's own recovery copies (not the one offered by the fixture), parsed. */
const ownCopies = page => page.evaluate(([prefix, offered]) => Object.entries(localStorage).filter(([k]) => k.startsWith(prefix) && k !== offered).map(([, v]) => JSON.parse(v)), [`domdimabot-overlay-draft:${owner.id}:`, OFFERED_KEY]);
const beforeUnloadBlocked = page => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
async function lookSettings(page) { await openStudio(page, 'overlay'); await page.locator('.look-settings').waitFor(); }

try {
  // 1. Desktop, dark, English, free plan: a video trigger with no look, the seed, picker + upload, end grip, save, reopen.
  {
    const { context, page, ctx } = await open({ width: 1280, plan: 'free' });
    const keysBefore = await studioKeys(page), socketsBefore = ctx.sockets.length;
    const video = row(page, 'Video_Trigger');
    assert.equal(await video.locator('.lf-chip--look').count(), 0, 'no look chip yet');
    assert.equal(await video.locator('.lf-trigger__look').getAttribute('aria-label'), 'Design a look for Video_Trigger');
    await openLook(page, 'Video_Trigger');
    assert.equal(await dialog(page).getAttribute('role'), 'dialog'); assert.equal(await dialog(page).getAttribute('aria-modal'), 'true');
    assert.match(await dialog(page).getAttribute('aria-label'), /Video_Trigger/);
    assert.equal(await page.locator('.look-status').innerText(), 'New look · not saved yet');
    assert.equal(await page.locator('.look-chip').innerText(), 'Trigger look');
    assert.equal(await page.locator('.publish-button, .design-event-tabs, .studio-obs, .tb--test + .tester').count(), 0, 'no publish, event tabs or OBS controls');
    assert.equal(await page.locator('.layers .layer-row').count(), 1, 'seed: one object');
    const expected = await measured(page, 'https://media.fixture.invalid/clip.webm', 'video');
    await lookSettings(page);
    assert.equal(Number(await lengthInput(page).inputValue()), expected, 'seed length = measured video length');
    await shot(page, 'look-editor-seed-desktop-dark');
    // An untouched seed closes without asking or saving.
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    assert.equal(ctx.puts.length, 0, 'untouched seed saves nothing');
    await openLook(page, 'Video_Trigger');
    // Add a GIF: adding a picture opens the trigger media picker right away (pictures and GIFs only).
    await openStudio(page, 'add'); await page.locator('.palette-item[data-kind=image]').click();
    const picker = page.locator('app-overlay-trigger-media-picker'); await picker.locator('.tmp-row').first().waitFor();
    assert.equal(await picker.locator('[role=dialog]').getAttribute('aria-modal'), 'true');
    assert.deepEqual(await picker.locator('.tmp-pick__name').allInnerTexts(), ['Portrait', 'Spark', 'Wide'], 'picture picker lists pictures and GIFs only');
    assert.equal(await picker.locator('.tmp-thumb img').count(), 3, 'real picture previews');
    await shot(page, 'look-picker-desktop-dark');
    await axe(page, 'app-overlay-trigger-media-picker', 'picker desktop dark');
    await picker.getByRole('button', { name: 'Use Spark', exact: true }).click(); await picker.waitFor({ state: 'detached' });
    await until(() => page.locator('.layers .layer-row').count().then(n => n === 2), 'GIF object added');
    // Sounds: one from the library, one uploaded inside the picker (free plan: public only, said honestly).
    await openStudio(page, 'timeline');
    await page.locator('app-overlay-sounds .sounds__add').click(); await picker.locator('.tmp-row').first().waitFor();
    assert.deepEqual(await picker.locator('.tmp-pick__name').allInnerTexts(), ['Chime', 'Drum'], 'sound picker lists sounds only');
    const play = picker.getByRole('button', { name: 'Play Chime', exact: true });
    await play.click(); await until(() => picker.locator('.tmp-thumb--sound').first().getAttribute('aria-pressed').then(v => v === 'true'), 'sound preview plays');
    await until(() => ctx.requests.some(r => r.includes('media.fixture.invalid/chime.wav')), 'sound preview fetched');
    await picker.getByRole('button', { name: 'Use Chime', exact: true }).click(); await picker.waitFor({ state: 'detached' });
    await page.locator('app-overlay-sounds .sounds__add').click(); await picker.locator('.tmp-upload').click();
    await picker.locator('.tmp-note--gold').waitFor();
    assert.equal(await picker.locator('input[type=radio]').count(), 0, 'free plan: no private choice');
    await picker.locator('input[type=file]').setInputFiles({ name: 'hey.png', mimeType: 'image/png', buffer: files['wide.png'].body });
    await picker.locator('.tmp-error').getByText('Pick a sound here (MP3, WAV or OGG).').waitFor();
    await picker.locator('input[type=file]').setInputFiles({ name: 'Crowd cheer 2.wav', mimeType: 'audio/wav', buffer: files['chime.wav'].body });
    assert.equal(await picker.locator('.tmp-field input').inputValue(), 'Crowd_cheer_2', 'valid name pre-filled from the file name');
    await shot(page, 'look-upload-desktop-dark');
    await axe(page, 'app-overlay-trigger-media-picker', 'upload desktop dark');
    await picker.locator('.tmp-submit').click(); await picker.waitFor({ state: 'detached' });
    assert.equal(ctx.uploads.length, 1);
    assert.match(ctx.uploads[0], /name="trigger"; filename="Crowd cheer 2.wav"/); assert.match(ctx.uploads[0], /name="name"\r\n\r\nCrowd_cheer_2/); assert.match(ctx.uploads[0], /name="scope"\r\n\r\npublic/);
    await until(() => page.locator('app-overlay-sounds .sound').count().then(n => n === 2), 'two sounds');
    // Drag the GIF's end grip to the left on the timeline.
    const end = page.locator("app-overlay-timeline [data-track^=\"image-\"] .end-handle");
    await end.scrollIntoViewIfNeeded(); const box = await end.boundingBox(), track = await page.locator("app-overlay-timeline [data-track^=\"image-\"]").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - track.width * 0.3, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.locator('.look-status').innerText(), 'Unsaved changes');
    await shot(page, 'look-editor-edited-desktop-dark');
    await axe(page, 'app-trigger-look-dialog', 'look editor desktop dark');
    await page.locator('.look-save').click();
    await until(() => page.locator('.look-status').innerText().then(t => t === 'Saved · live on the next play'), 'saved status');
    assert.equal(ctx.puts.length, 1); const put = ctx.puts[0];
    assert.equal(put.width, 1280); assert.equal(put.height, 720); assert.equal(put.revision, 0, 'loaded revision');
    assert.equal(JSON.stringify(put).includes('assetId'), false, 'never assetId'); assert.equal('sound' in put.layout, false, 'sounds only');
    assert.equal(put.layout.duration, expected);
    const [videoObject, gifObject] = put.layout.widgets;
    assert.deepEqual([videoObject.kind, videoObject.mediaId, videoObject.volume, videoObject.loop, videoObject.x, videoObject.y, videoObject.width, videoObject.height, videoObject.motion.enter, videoObject.motion.exit], ['video', hex(101), 1, false, 0, 0, 1280, 720, 'none', 'none'], 'video seed');
    assert.equal(gifObject.mediaId, hex(103)); assert.ok(gifObject.motion.end > 0 && gifObject.motion.end < expected, 'end grip stored: ' + gifObject.motion.end);
    assert.equal('mediaUrl' in videoObject || 'mediaUrl' in gifObject, false, 'resolved URLs are not sent');
    assert.deepEqual(put.layout.sounds.map(s => [s.mediaId, s.name, s.volume, 'url' in s]), [[hex(104), 'Chime', 1, false], [hex(141), 'Crowd_cheer_2', 1, false]]);
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    await until(() => video.locator('.lf-chip--look').count().then(n => n === 1), 'row chip');
    assert.equal(await video.locator('.lf-trigger__look').getAttribute('aria-label'), 'Edit the look of Video_Trigger');
    await shot(page, 'triggers-row-chip-desktop-dark');
    await openLook(page, 'Video_Trigger');
    assert.equal(await page.locator('.layers .layer-row').count(), 2, 'reopened look has its objects');
    await openStudio(page, 'timeline'); assert.equal(await page.locator('app-overlay-sounds .sound').count(), 2, 'and its sounds');
    assert.equal(await page.locator('.look-status').innerText(), 'Saved · live on the next play');
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    // Isolation: nothing of Overlay Studio was requested or stored, and the editor is gone.
    assert.deepEqual(ctx.requests.filter(r => r.includes('/overlay-studio/')), [], 'no Overlay Studio request');
    assert.deepEqual(await studioKeys(page), keysBefore, 'Studio local drafts untouched');
    assert.deepEqual(ctx.sockets.slice(socketsBefore), [], 'embedded mode never tried a socket (Studio or other)');
    assert.equal(await page.locator('app-overlay-editor').count(), 0, 'no editor element remains');
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '', 'page scroll restored');
    await context.close();
  }

  // 2. Phone 390, touch, light, Spanish: picture and audio seeds, untouched close, the unsaved-changes dialog.
  {
    const { context, page, ctx } = await open({ width: 390, dark: false, touch: true, lang: 'es' });
    const keysBefore = await studioKeys(page);
    assert.equal(await row(page, 'Picture_Trigger').locator('.lf-trigger__look').getAttribute('aria-label'), 'Crear un diseño para Picture_Trigger');
    assert.equal(await row(page, 'Picture_Trigger').locator('.lf-trigger__look').innerText(), 'Diseño', 'narrow row: a short word, not a bare icon');
    await openLook(page, 'Picture_Trigger');
    assert.equal(await page.locator('.studio-mtabs [data-tab=test]').count(), 0, 'no Test tab in look mode');
    await lookSettings(page);
    assert.equal(Number(await lengthInput(page).inputValue()), 5, 'picture seed: 5 s');
    assert.equal(await page.locator('.studio-pane__title', { hasText: 'Ajustes del diseño' }).count(), 1);
    await shot(page, 'look-settings-phone-light-es');
    assert.equal(await overflow(page), false, 'no overflow 390');
    await axe(page, 'app-trigger-look-dialog', 'look editor phone light es');
    // Unsaved close: keep editing, then discard, then save.
    await lengthInput(page).fill('6');
    await closeLook(page);
    const prompt = page.locator('app-overlay-look-prompt [role=alertdialog]'); await prompt.waitFor();
    await shot(page, 'look-unsaved-phone-light-es');
    await axe(page, 'app-overlay-look-prompt', 'unsaved prompt');
    await prompt.locator('[data-action=cancel]').click(); await prompt.waitFor({ state: 'detached' });
    assert.equal(await dialog(page).count(), 1, 'keep editing stays open');
    await closeLook(page); await prompt.locator('[data-action=discard]').click();
    await dialog(page).waitFor({ state: 'detached' }); assert.equal(ctx.puts.length, 0, 'discard saves nothing');
    await openLook(page, 'Picture_Trigger'); await lookSettings(page); await lengthInput(page).fill('6');
    await closeLook(page); await prompt.locator('[data-action=save]').click();
    await dialog(page).waitFor({ state: 'detached' });
    assert.equal(ctx.puts.length, 1, 'save from the prompt');
    const image = ctx.puts[0].layout.widgets[0];
    assert.deepEqual([image.kind, image.mediaId, image.width, image.height, image.x, image.y, ctx.puts[0].layout.duration], ['image', hex(102), 360, 720, 460, 0, 6], 'picture fitted inside the canvas keeping its ratio');
    await until(() => row(page, 'Picture_Trigger').locator('.lf-chip--look').count().then(n => n === 1), 'chip after save');
    // Audio seed: one sound, no objects, length = the file's.
    await openLook(page, 'Sound_Trigger');
    assert.equal(await page.locator('.layers .layer-row').count(), 0, 'audio seed: no objects');
    await openStudio(page, 'timeline'); assert.equal(await page.locator('app-overlay-sounds .sound').count(), 1, 'audio seed: one sound');
    await lookSettings(page); assert.equal(Number(await lengthInput(page).inputValue()), await measured(page, 'https://media.fixture.invalid/chime.wav', 'audio'));
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' }); assert.equal(ctx.puts.length, 1, 'untouched audio seed saves nothing');
    await shot(page, 'triggers-rows-phone-light-es');
    assert.equal(await overflow(page), false, 'no overflow on the Triggers page 390');
    assert.deepEqual(ctx.requests.filter(r => r.includes('/overlay-studio/')), []);
    assert.deepEqual(await studioKeys(page), keysBefore);
    await context.close();
  }

  // 3. Desktop, light, an existing look: test note, removed file, validation error, replace, conflict + reload, master volume, search, remove.
  {
    const { context, page, ctx } = await open({ width: 1280, dark: false, manyPictures: true });
    const looked = row(page, 'Looked_Trigger');
    assert.equal(await looked.locator('.lf-chip--look').innerText(), 'Look');
    await looked.getByRole('button', { name: /Test/ }).click();
    await page.locator('.lf-note--look').getByText('This preview shows the plain file. Overlay Studio overlays play this trigger’s look.').waitFor();
    await page.locator('.lf-modal--test .lf-modal__footer .lf-btn--primary:not([disabled])').waitFor();
    await page.locator('.lf-modal--test .lf-modal__close').click(); await page.locator('.lf-modal--test').waitFor({ state: 'detached' });
    await openLook(page, 'Looked_Trigger');
    assert.equal(await page.locator('.look-status').innerText(), 'Saved · live on the next play');
    const missing = page.locator('.layers .layer-row').filter({ hasText: 'Old picture' });
    await missing.locator('.layer__missing').getByText('File removed').waitFor();
    await until(() => ctx.renders.length > 0, 'text preview rendered through the look route');
    assert.deepEqual(ctx.renders[0], ['Big moment $(channel)']);
    await until(() => page.locator('.stage app-overlay-scene-renderer').innerText().then(t => t.includes('Big moment lookfixture')), 'rendered text shown');
    // A validation error by code, in plain words.
    ctx.next = 'look_media_unavailable';
    await lookSettings(page); await lengthInput(page).fill('5.5');
    await page.locator('.look-save').click();
    await page.locator('.lf-toast--error').getByText('A file in this look was removed from your trigger library. Pick another file or remove it, then save again.').waitFor();
    // Fix the removed file: select it, it says so, pick another file.
    await missing.locator('.layer').click(); await page.locator('.studio-pane.properties .look-file').waitFor();
    await page.locator('.look-file').getByText('This file was removed from your trigger library. Pick another file or remove it.').waitFor();
    await page.locator('.look-pick').click();
    const picker = page.locator('app-overlay-trigger-media-picker'); await picker.locator('.tmp-search input').waitFor();
    await picker.locator('.tmp-search input').fill('wide'); await until(() => picker.locator('.tmp-row').count().then(n => n === 1), 'search filters');
    await picker.locator('.tmp-search input').fill('extra_3'.replace('_', ' ')); await until(() => picker.locator('.tmp-row').count().then(n => n === 1), 'search by name');
    // Escape closes only the picker.
    await page.keyboard.press('Escape'); await picker.waitFor({ state: 'detached' }); assert.equal(await dialog(page).count(), 1, 'Escape closed only the picker');
    await page.locator('.look-pick').click(); await picker.locator('.tmp-row').first().waitFor();
    await picker.getByRole('button', { name: 'Use Portrait', exact: true }).click(); await picker.waitFor({ state: 'detached' });
    await until(() => missing.locator('.layer__missing').count().then(n => n === 0), 'removed file replaced');
    // Upload on a paid plan: private by default.
    await page.locator('.look-pick').click(); await picker.locator('.tmp-upload').click();
    assert.equal(await picker.locator('input[type=radio]').first().isChecked(), true, 'paid plan: private by default');
    await picker.locator('input[type=file]').setInputFiles({ name: 'Logo.png', mimeType: 'image/png', buffer: files['wide.png'].body });
    await picker.locator('.tmp-submit').click(); await picker.waitFor({ state: 'detached' });
    assert.match(ctx.uploads.at(-1), /name="scope"\r\n\r\nprivate/);
    // Conflict: someone saved elsewhere; reloading takes that version and drops these changes.
    const id = hex(504), stored = ctx.data.looks.get(id);
    ctx.data.looks.set(id, { revision: 4, look: { ...stored.look, revision: 4, layout: { ...stored.look.layout, duration: 7 } } });
    await page.locator('.look-save').click();
    const banner = page.locator('.look-conflict'); await banner.waitFor();
    await shot(page, 'look-conflict-desktop-light');
    await banner.getByRole('button', { name: 'Reload it' }).click(); await banner.waitFor({ state: 'detached' });
    await lookSettings(page); assert.equal(await lengthInput(page).inputValue(), '7', 'reloaded the other version');
    assert.equal(await page.locator('.look-status').innerText(), 'Saved · live on the next play');
    // Master volume: the trigger is at 50%, the sound stored at 80% plays at 40%.
    await page.locator('.tb--test').click();
    const audio = page.locator('app-overlay-sound audio').first();
    await until(() => audio.count().then(n => n > 0) , 'replay mounts the sound');
    await until(() => audio.evaluate(a => !a.paused && a.currentTime > 0.05), 'replayed sound plays');
    assert.ok(Math.abs(await audio.evaluate(a => a.volume) - 0.4) < 0.02, 'effective volume = stored × master');
    assert.equal(ctx.data.looks.get(id).look.layout.sounds[0].volume, 0.8, 'stored value unchanged');
    // Remove the look: confirmation, DELETE with the revision, the row loses its chip.
    await lookSettings(page); await page.locator('.look-remove').click();
    const prompt = page.locator('app-overlay-look-prompt [role=alertdialog]'); await prompt.waitFor();
    assert.match(await prompt.innerText(), /goes back to playing its plain file everywhere/);
    await shot(page, 'look-remove-desktop-light');
    await axe(page, 'app-overlay-look-prompt', 'remove prompt light');
    await prompt.locator('[data-action=remove]').click(); await dialog(page).waitFor({ state: 'detached' });
    assert.deepEqual(ctx.deletes, ['4']);
    await until(() => looked.locator('.lf-chip--look').count().then(n => n === 0), 'chip removed');
    await shot(page, 'triggers-rows-desktop-light');
    await axe(page, 'app-triggers-page', 'triggers page light');
    assert.deepEqual(ctx.requests.filter(r => r.includes('/overlay-studio/')), []);
    await context.close();
  }

  // 4. A channel admin (not the owner) opens, edits and saves a look from the Triggers page.
  {
    const { context, page, ctx } = await open({ width: 1280, as: 'admin' });
    await openLook(page, 'Video_Trigger');
    await lookSettings(page); await lengthInput(page).fill('4');
    await page.locator('.look-save').click();
    await until(() => page.locator('.look-status').innerText().then(t => t === 'Saved · live on the next play'), 'admin saved');
    assert.equal(ctx.puts.length, 1); assert.equal(ctx.puts[0].layout.duration, 4);
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    assert.deepEqual(ctx.requests.filter(r => r.includes('/overlay-studio/')), [], 'admin: no Overlay Studio request');
    await context.close();
  }

  // 5. Overlay Studio, everything observed from the browser (DOM, network, storage, dialogs, history):
  //    unsaved overlay edits + undo/redo, a recovery copy offered before the look, the Test drawer open → Trigger looks →
  //    look mode → save → back: edits, unsaved status, both histories, the offered copy and the Studio's own copy intact.
  for (const options of [{ width: 1280, dark: true }, { width: 390, dark: false, touch: true, lang: 'es' }]) {
    const es = options.lang === 'es', desktop = options.width >= 960;
    const { context, page, ctx } = await open({ ...options, path: 'studio', recoveryOffer: desktop });
    const before = structuredClone(ctx.studio.scenes[0].widgets);
    const alertLayer = () => page.evaluate(() => { const row = document.querySelector('.layers .layer-row[data-layer-id=alert-1]'); return row && { visible: !row.classList.contains('is-hidden'), locked: row.querySelectorAll('.layer-toggle')[1].classList.contains('on') }; });
    const unsavedText = es ? 'Cambios sin guardar' : 'Unsaved changes';
    const status = () => page.locator('.lf-save-bar__status').first().textContent().then(t => t.trim());
    const undo = page.locator('.history-toolbar .tb').nth(0), redo = page.locator('.history-toolbar .tb').nth(1);
    const offerButton = () => page.getByRole('button', { name: es ? 'Restaurar borrador local' : 'Restore local draft', exact: true });
    if (desktop) {
      await offerButton().waitFor();
      // A real in-app history entry: leave to Modules (nothing unsaved yet) and come back.
      await page.locator('a.studio-top__back').click(); await until(() => /\/modules$/.test(page.url()), 'left the Studio');
      await page.goBack(); await page.locator('app-overlay-editor .stage').waitFor(); await offerButton().waitFor();
    }
    const offered = desktop ? await page.evaluate(key => localStorage.getItem(key), OFFERED_KEY) : null;
    await openStudio(page, 'layers');
    await page.locator('.layers .layer-row[data-layer-id=alert-1] .layer-toggle').nth(1).click(); await until(() => alertLayer().then(l => l.locked), 'lock step');
    await openStudio(page, 'layers'); await page.locator('.layers .layer-row[data-layer-id=alert-1] .layer-toggle').nth(0).click(); await until(() => alertLayer().then(l => !l.visible), 'hide step');
    await undo.click(); await until(() => alertLayer().then(l => l.visible && l.locked), 'undo one step');
    await until(() => redo.isEnabled(), 'redo step available'); await until(() => undo.isEnabled(), 'undo step available');
    await until(() => status().then(t => t === unsavedText), 'status says unsaved');
    if (desktop) await openStudio(page, 'test');
    await openStudio(page, 'layers'); await page.locator('.layers .layer-row[data-layer-id=trigger-1] .layer').click(); await openStudio(page, 'layer');
    const list = page.locator('app-overlay-trigger-looks'); await list.locator('.tl__row').first().waitFor();
    assert.equal(await list.locator('.tl__row').count(), 5);
    assert.equal(await list.locator('.tl__row[data-trigger-id="' + hex(504) + '"] .tl__chip').count(), 1, 'chip on a trigger with a look');
    await list.locator('.tl__row').first().scrollIntoViewIfNeeded();
    await shot(page, `studio-trigger-looks-${options.width}`);
    assert.equal(await list.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'list has no horizontal scroll');
    // A scene edit IMMEDIATELY before opening the look (inside the 250 ms recovery debounce): the overlay name.
    const nameInput = page.locator('.name-field input');
    await nameInput.fill('Gameplay 2'); await nameInput.press('Tab');
    const studioWrites = () => ctx.requests.filter(r => r.includes('/overlay-studio/') && !r.startsWith('GET ')).length;
    const writesBefore = studioWrites();
    await list.getByRole('button', { name: es ? 'Darle a Video_Trigger su propio diseño' : 'Give Video_Trigger its own look' }).click();
    await page.locator('.look-chip').waitFor();
    let copies = await ownCopies(page);
    assert.equal(copies.length, 1, 'the overlay copy exists on entering the look');
    assert.equal(copies[0].scenes[0].name, 'Gameplay 2', 'it holds the edit made right before opening the look');
    assert.equal(copies[0].designDraft, null, 'the look is not in the overlay copy');
    assert.equal(copies[0].scenes[0].widgets.find(w => w.id === 'alert-1').locked, true);
    assert.equal(await page.locator('.look-back').getAttribute('aria-label'), es ? 'Volver al overlay' : 'Back to the overlay');
    if (desktop) {
      await page.locator('.studio__timeline').waitFor(); assert.equal(await page.locator('.tester').isVisible(), false, 'the Test drawer gave way to the timeline');
      assert.equal(await offerButton().count(), 0, 'the offered Studio copy is not actionable during the look');
      assert.equal(await page.locator('.studio-banners .lf-banner:not(.look-conflict):not(.look-missing-file)').count(), 0, 'no Studio banner in look mode');
    }
    // Edit and undo inside the look; after the debounce the stored copy is still the overlays', never the look.
    await lookSettings(page); await lengthInput(page).fill('9'); await undo.click();
    await until(() => lengthInput(page).inputValue().then(v => v !== '9'), 'look undo');
    await sleep(700);
    copies = await ownCopies(page);
    assert.equal(copies.length, 1); assert.equal(copies[0].scenes[0].name, 'Gameplay 2'); assert.equal(copies[0].designDraft, null);
    assert.equal(JSON.stringify(copies[0]).includes('trigger-look'), false, 'the look never reaches the overlay copy');
    // Departure protection, untouched look over unsaved overlay edits: tab close and real history navigation.
    assert.equal(await beforeUnloadBlocked(page), true, 'tab close asks (overlay edits unsaved)');
    if (desktop) {
      let asked = '';
      page.once('dialog', d => { asked = d.message(); d.dismiss().catch(() => {}); });
      await page.goForward().catch(() => {});
      await until(() => asked !== '', 'in-app navigation asked'); await sleep(300);
      assert.match(page.url(), /\/modules\/overlays$/, 'stayed in the Studio'); assert.equal(await page.locator('.look-chip').count(), 1, 'look still open');
    }
    await lookSettings(page); await lengthInput(page).fill('3');
    await page.locator('.look-save').click();
    await until(() => ctx.puts.length === 1, 'look saved from the Studio');
    await shot(page, `studio-look-mode-${options.width}`);
    if (desktop) {
      assert.equal(await page.evaluate(key => localStorage.getItem(key), OFFERED_KEY), offered, 'offered copy unchanged while the look is open');
      assert.equal(studioWrites(), writesBefore, 'no Studio write while the look was open');
      assert.equal(ctx.downloads, 0, 'no export/download');
    }
    await page.locator('.look-back').click(); await page.locator('.look-chip').waitFor({ state: 'detached' });
    assert.equal(await nameInput.getAttribute('data-scene-id'), 'main', 'back on the overlay');
    assert.equal(await nameInput.inputValue(), 'Gameplay 2', 'overlay edit intact');
    if (desktop) {
      await page.locator('.tester').waitFor();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), OFFERED_KEY), offered, 'offered copy unchanged after returning');
      await offerButton().waitFor();
    }
    assert.deepEqual(await alertLayer(), { visible: true, locked: true }, 'unsaved overlay edits intact');
    await until(() => status().then(t => t === unsavedText), 'still marked unsaved');
    // Both histories work after returning: undo the rename, redo it, undo back to the saved layers.
    await undo.click(); await until(() => nameInput.inputValue().then(v => v === 'Gameplay'), 'undo after return');
    await redo.click(); await until(() => nameInput.inputValue().then(v => v === 'Gameplay 2'), 'redo after return');
    if (desktop) {
      // A fresh editor restores the overlays' own copy: the same overlay content as before reloading.
      const expected = { name: await nameInput.inputValue(), alert: await alertLayer() };
      await page.reload(); await page.locator('app-overlay-editor .stage').waitFor();
      await offerButton().click();
      await until(() => nameInput.inputValue().then(v => v === expected.name), 'restored name');
      await openStudio(page, 'layers'); assert.deepEqual(await alertLayer(), expected.alert, 'restored layers');
      await closeStudioMenus(page);
      await page.locator('.save-button').click();
      await until(() => ctx.studioPuts.length === 1, 'restored overlay saveable');
      assert.equal(ctx.studioPuts[0].scenes[0].name, 'Gameplay 2');
      assert.equal(JSON.stringify(ctx.studioPuts[0].designs).includes('trigger-look'), false, 'the look never enters Studio designs');
    } else {
      await undo.click(); await undo.click(); await until(() => alertLayer().then(l => l.visible && !l.locked), 'undo back to saved layers');
      await openStudio(page, 'layers'); assert.equal(await page.locator('.layers .layer-row').count(), before.length, 'scene layers intact');
      await closeStudioMenus(page);
      await page.locator('.save-button').click();
      await until(() => ctx.studioPuts.length === 1, 'scene still saveable');
      assert.deepEqual(ctx.studioPuts[0].scenes[0].widgets, before, 'scene back to its saved state, untouched by the look');
    }
    await context.close();
  }
  // 5b. Late responses: look A's slow load arrives after look B (Triggers page) or an alert design (Studio) is open.
  {
    const { context, page, ctx } = await open({ width: 1280, path: 'studio' });
    await page.locator('.layers .layer-row[data-layer-id=trigger-1] .layer').click(); await openStudio(page, 'layer');
    const list = page.locator('app-overlay-trigger-looks'); await list.locator('.tl__row').first().waitFor();
    ctx.delay.get = 1500;
    const lateGet = page.waitForResponse(r => r.url().endsWith(`/triggers/${owner.id}/${hex(501)}/look`) && r.request().method() === 'GET');
    await list.getByRole('button', { name: 'Give Video_Trigger its own look' }).click();
    await openStudio(page, 'designs'); await page.locator('.design-row__actions button').first().click();
    await page.locator('.design-event-tabs').waitFor();
    await lateGet; const requestsAfter = ctx.requests.length, storageAfter = await storageDump(page);
    await sleep(800);
    assert.equal(await page.locator('.look-chip').count(), 0, 'late look not opened');
    assert.equal(await page.locator('.name-field input').inputValue(), 'Aurora alerts', 'the alert design is still what is open');
    assert.equal(await page.locator('.layers .layer-row[data-layer-id=follow-text]').count(), 1, 'with its own layers');
    // (Look A's loader may still read its file's metadata; no API request may follow.)
    assert.deepEqual(ctx.requests.slice(requestsAfter).filter(r => !r.includes('media.fixture.invalid')), [], 'no API request after the late answer');
    assert.equal(await storageDump(page), storageAfter, 'no storage write after the late answer');
    await context.close();
  }
  {
    const { context, page, ctx } = await open({ width: 1280 });
    ctx.delay.getFor = { [hex(501)]: 1500 };
    const lateGet = page.waitForResponse(r => r.url().endsWith(`/triggers/${owner.id}/${hex(501)}/look`) && r.request().method() === 'GET');
    await row(page, 'Video_Trigger').locator('.lf-trigger__look').click();
    await page.locator('.look-cancel').click(); await dialog(page).waitFor({ state: 'detached' });
    await openLook(page, 'Looked_Trigger');
    await lateGet; const requestsAfter = ctx.requests.length, storageAfter = await storageDump(page);
    await sleep(800);
    assert.equal(await page.locator('.look-name').inputValue(), 'Looked_Trigger', 'look B is still the one open');
    assert.deepEqual(await page.locator('.layers .layer__name').allInnerTexts(), ['Old picture', 'Title'], 'with look B content');
    assert.equal(await page.locator('app-overlay-editor').count(), 1, 'one editor');
    assert.equal(ctx.requests.filter(r => !r.includes('media.fixture.invalid')).length, ctx.requests.slice(0, requestsAfter).filter(r => !r.includes('media.fixture.invalid')).length, 'no API request after the late answer');
    assert.equal(await storageDump(page), storageAfter, 'no storage write after the late answer');
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    await context.close();
  }

  // 6. 320 px: Triggers page and the open editor + picker without horizontal overflow.
  {
    const { context, page } = await open({ width: 320, touch: true });
    assert.equal(await overflow(page), false, 'triggers page 320');
    await openLook(page, 'Video_Trigger'); assert.equal(await overflow(page), false, 'editor 320');
    await openStudio(page, 'timeline'); await page.locator('app-overlay-sounds .sounds__add').click();
    await page.locator('app-overlay-trigger-media-picker .tmp-row').first().waitFor(); assert.equal(await overflow(page), false, 'picker 320');
    await shot(page, 'look-picker-phone-320-dark');
    await context.close();
  }
  // 7. Triggers page: library slower than triggers, a trigger whose file is gone, no sockets, SPA navigation prompt,
  //    double submit, closing during a slow load, and a channel admin whose look GET fails (no Studio request).
  {
    const { context, page, ctx } = await open({ width: 1280, libraryDelay: 2500 });
    const sockets = ctx.sockets.length;
    const videoButton = row(page, 'Video_Trigger').locator('.lf-trigger__look');
    await videoButton.click();
    await until(() => videoButton.innerText().then(t => t === 'Opening…'), 'button says it is opening'); assert.equal(await videoButton.isDisabled(), true, 'waits for the library');
    assert.equal(await dialog(page).count(), 0, 'no look built before the library answered');
    await dialog(page).waitFor(); await editor(page).locator('.look-save').waitFor();
    assert.equal(await page.locator('.layers .layer-row').count(), 1, 'seed built from the trigger file once the library arrived');
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    await openLook(page, 'Lost_Trigger');
    await page.locator('.look-missing-file').getByText('This look starts empty').waitFor();
    assert.equal(await page.locator('.layers .layer-row').count(), 0);
    await shot(page, 'look-missing-file-desktop-dark');
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    // Double submit: two clicks before the first save answers send one PUT.
    ctx.delay.put = 1200;
    await openLook(page, 'Picture_Trigger'); await lookSettings(page); await lengthInput(page).fill('7');
    await page.evaluate(() => { const b = document.querySelector('.look-save'); b.click(); b.click(); });
    await until(() => page.locator('.look-status').innerText().then(t => t === 'Saved · live on the next play'), 'slow save done');
    assert.equal(ctx.puts.length, 1, 'one PUT for a double click'); ctx.delay.put = 0;
    // In-app navigation (browser history) with unsaved look changes asks; staying keeps the editor, leaving drops it.
    await closeLook(page); await dialog(page).waitFor({ state: 'detached' });
    await page.locator('app-triggers-page a.lf-back').click(); await until(() => /\/modules$/.test(page.url()), 'to Modules');
    await page.goBack(); await page.locator('app-triggers-page .lf-trigger').first().waitFor();
    // Confirming leaves (and saves nothing)…
    await openLook(page, 'Picture_Trigger'); await lookSettings(page); await lengthInput(page).fill('8');
    let asked = '';
    page.once('dialog', d => { asked = d.message(); d.accept().catch(() => {}); });
    await page.goForward().catch(() => {});
    await until(() => asked !== '', 'navigation asked'); assert.match(asked, /unsaved changes/);
    await page.locator('app-trigger-look-dialog').waitFor({ state: 'detached' });
    await until(() => /\/modules$/.test(page.url()), 'left after confirming');
    assert.equal(ctx.puts.length, 1, 'leaving saved nothing');
    // …dismissing stays with the editor and its changes.
    await page.goBack(); await page.locator('app-triggers-page .lf-trigger').first().waitFor();
    await openLook(page, 'Picture_Trigger'); await lookSettings(page); await lengthInput(page).fill('9');
    asked = '';
    page.once('dialog', d => { asked = d.message(); d.dismiss().catch(() => {}); });
    await page.goForward().catch(() => {});
    await until(() => asked !== '', 'navigation asked'); await sleep(400);
    assert.equal(await dialog(page).count(), 1, 'stayed'); assert.match(page.url(), /\/modules\/triggers$/);
    assert.equal(await lengthInput(page).inputValue(), '9', 'changes kept');
    // Closing while a slow load is still running applies nothing afterwards.
    await page.goto(`${base}/${owner.login}/modules/triggers`); await page.locator('app-triggers-page .lf-trigger').first().waitFor();
    const socketsBefore = ctx.sockets.length; ctx.delay.get = 1500;
    await row(page, 'Sound_Trigger').locator('.lf-trigger__look').click();
    await page.locator('.look-cancel').click(); await dialog(page).waitFor({ state: 'detached' });
    await sleep(1800); assert.equal(await page.locator('app-overlay-editor').count(), 0, 'late answer applied nothing');
    assert.equal(ctx.sockets.length, socketsBefore, 'no socket attempt from the look editor');
    assert.equal(sockets, 0, 'the Triggers page itself opened no socket');
    await context.close();
  }
  {
    const { context, page, ctx } = await open({ width: 390, touch: true, as: 'admin' });
    assert.equal(await row(page, 'Video_Trigger').locator('.lf-trigger__look').innerText(), 'Look', 'narrow row keeps a word');
    const sockets = ctx.sockets.length; ctx.failGet = true;
    await row(page, 'Video_Trigger').locator('.lf-trigger__look').click();
    await page.locator('app-trigger-look-dialog [role=alert]').getByText('We couldn’t open this look. Try again.').waitFor();
    await sleep(1500);
    assert.deepEqual(ctx.requests.filter(r => r.includes('/overlay-studio/')), [], 'failed look: no Overlay Studio request');
    assert.equal(ctx.sockets.length, sockets, 'failed look: no socket attempt');
    await page.locator('app-trigger-look-dialog').getByRole('button', { name: 'Close' }).click(); await dialog(page).waitFor({ state: 'detached' });
    await context.close();
  }
  // 8. Who fired it, files used by looks, volume 0 and signed media links (contract sections 1–3).
  const textRow = page => page.locator('.layers .layer-row').filter({ hasText: 'Title' }).locator('.layer');
  const template = page => page.locator('.studio-pane.properties textarea');
  const insertButton = page => page.locator('.studio-pane.properties app-overlay-look-user-token button');
  const HINT = {
    en: '$(user) shows whoever fired the trigger: the chatter who ran the command or the viewer who redeemed the reward. When nobody did (for example a timer) it shows "Viewer", and previews here use a sample name.',
    es: '$(user) muestra a quien activó el trigger: quien usó el comando en el chat o quien canjeó la recompensa. Si nadie lo activó (por ejemplo, un temporizador) aparece "Viewer", y aquí la vista previa usa un nombre de ejemplo.'
  };
  async function openTextInspector(page) {
    await openStudio(page, 'layers'); await textRow(page).click(); await openStudio(page, 'layer');
    await template(page).waitFor();
  }
  const fieldState = page => template(page).evaluate(el => ({ value: el.value, focused: document.activeElement === el, caret: el.selectionStart }));
  const mediaRow = (page, name) => page.locator('app-triggers-page .lf-media-row').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
  {
    const { context, page, ctx } = await open({ width: 1280, extra: true });
    // Files used by a look count as in use: distinct triggers, own file or inside the look.
    const usage = async name => { const r = mediaRow(page, name); return { chip: await r.locator('.lf-chip--ok').innerText().catch(() => ''), use: await r.getByRole('button', { name: `Create a trigger with ${name}` }).count() }; };
    await mediaRow(page, 'Drum').waitFor();
    assert.deepEqual(await usage('Drum'), { chip: 'In 2 triggers', use: 0 }, 'Drum: only inside two looks, counted, no Use');
    assert.deepEqual(await usage('Wide'), { chip: 'In 1 trigger', use: 0 }, 'Wide: own file + twice in the same look = one trigger');
    assert.deepEqual(await usage('Chime'), { chip: 'In 2 triggers', use: 0 }, 'Chime: own file of one trigger + in another look');
    assert.deepEqual(await usage('Portrait'), { chip: 'In 2 triggers', use: 0 }, 'Portrait: own file of two triggers');
    assert.deepEqual(await usage('Spark'), { chip: '', use: 1 }, 'Spark: unused, Use offered');
    // Signed playback links are used unchanged (query string kept).
    await until(() => ctx.requests.some(r => r === 'GET https://media.fixture.invalid/wide.png?k=fx6'), 'thumbnail requested with its signed link');
    assert.equal(ctx.requests.some(r => /media\.fixture\.invalid\/[a-z]+\.(png|gif|wav|webm)$/.test(r)), false, 'no media request without the signature');
    await shot(page, 'triggers-media-in-use-desktop-dark');
    // A delete the API refuses (a look uses the file) shows the API's own message.
    ctx.refuseDelete = 'Drum is used in the look of Looked_Trigger. Remove it from the look first.';
    await mediaRow(page, 'Drum').getByRole('button', { name: 'Remove Drum from your media' }).click();
    await page.locator('app-confirmation-modal .modal-btn--confirm').click();
    await until(() => page.locator('app-toast-container').innerText().then(t => t.includes(ctx.refuseDelete)), 'refused delete: the API message is shown');
    assert.equal(await mediaRow(page, 'Drum').count(), 1, 'refused delete keeps the file');
    ctx.refuseDelete = null;
    // Volume 0: the row, the edit dialog and what it sends back.
    const muted = row(page, 'Muted_Trigger');
    assert.equal((await muted.locator('.lf-trigger__vol').innerText()).trim(), '0%', 'row shows 0%');
    await muted.getByRole('button', { name: 'Edit Muted_Trigger', exact: true }).click();
    const form = page.locator('.lf-modal--form'); await form.waitFor();
    assert.equal(await form.locator('.lf-range').inputValue(), '0', 'slider at 0'); assert.equal(await form.locator('.lf-label__value').innerText(), '0%');
    await form.locator('.lf-modal__footer .lf-btn--primary').click(); await form.waitFor({ state: 'detached' });
    assert.equal(ctx.patches.length, 1); assert.equal(ctx.patches[0].volume, 0, 'edit dialog sends 0 back');
    await until(() => muted.locator('.lf-trigger__vol').innerText().then(t => t.trim() === '0%'), 'row still 0% after saving');
    // Test: the /send body says who pressed it (the signed-in user).
    await muted.getByRole('button', { name: 'Test Muted_Trigger on the overlay' }).click();
    // Opening the test sends once; the dialog's button sends again.
    await until(() => ctx.sends.length === 1, 'test sent on open');
    await page.locator('.lf-modal--test .lf-modal__footer .lf-btn--primary:not([disabled])').click();
    await until(() => ctx.sends.length === 2, 'test sent again');
    for (const sent of ctx.sends) {
      assert.deepEqual(sent.firedBy, { login: owner.login, name: owner.display_name }, 'firedBy = session user');
      assert.equal(sent.triggerId, hex(506)); assert.equal(sent.url, 'https://media.fixture.invalid/wide.png?k=fx6', 'send uses the signed link unchanged');
    }
    await page.locator('.lf-modal--test .lf-modal__close').click(); await page.locator('.lf-modal--test').waitFor({ state: 'detached' });
    // The look editor: hint, insert at the cursor / appended, keyboard, undo/redo, render with the sample name, save.
    await openLook(page, 'Looked_Trigger');
    await openTextInspector(page);
    assert.equal(await page.locator('#look-text-hint').innerText(), HINT.en);
    assert.equal(await template(page).getAttribute('aria-describedby'), 'look-text-hint');
    assert.equal(await insertButton(page).innerText().then(t => t.replace(/\s+/g, ' ').trim()), 'Insert who fired it $(user)');
    const undo = page.locator('.history-toolbar .tb').nth(0), redo = page.locator('.history-toolbar .tb').nth(1);
    await template(page).click(); await page.keyboard.press('Control+Home'); for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await insertButton(page).click();
    await until(() => fieldState(page).then(s => s.value === 'Big $(user)moment $(channel)'), 'inserted at the cursor');
    await until(() => fieldState(page).then(s => s.focused && s.caret === 11), 'focus kept, cursor after the token');
    await until(() => page.locator('.stage app-overlay-scene-renderer').innerText().then(t => t.includes('Big Lunamoment lookfixture')), 'canvas shows the sample name');
    assert.ok(ctx.renders.some(texts => texts.includes('Big $(user)moment $(channel)')), 'rendered through the look route');
    assert.equal(ctx.renderBodies.every(b => !('user' in b)), true, 'the API default sample name is used');
    await undo.click(); await until(() => fieldState(page).then(s => s.value === 'Big moment $(channel)'), 'undo the insert');
    await redo.click(); await until(() => fieldState(page).then(s => s.value === 'Big $(user)moment $(channel)'), 'redo the insert');
    // Not in the field: appended (with a space).
    await page.locator('#look-text-hint').click();
    assert.equal((await fieldState(page)).focused, false);
    await insertButton(page).click();
    await until(() => fieldState(page).then(s => s.value === 'Big $(user)moment $(channel) $(user)' && s.focused), 'appended when not focused');
    // Keyboard: Tab from the field to the action and Enter inserts at the field's cursor.
    await template(page).focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Tab');
    assert.equal(await insertButton(page).evaluate(el => document.activeElement === el), true, 'Tab reaches the action');
    await page.keyboard.press('Enter');
    await until(() => fieldState(page).then(s => s.value === '$(user)Big $(user)moment $(channel) $(user)' && s.focused && s.caret === 7), 'keyboard insert at the cursor');
    await undo.click(); await until(() => fieldState(page).then(s => s.value === 'Big $(user)moment $(channel) $(user)'), 'keyboard insert is one undo step');
    // Two activations within one frame (no render in between) both land, one after the other.
    await template(page).focus(); await page.keyboard.press('Control+Home');
    await page.evaluate(() => { const b = document.querySelector('.studio-pane.properties app-overlay-look-user-token button'); b.click(); b.click(); });
    await until(() => fieldState(page).then(s => s.value === '$(user)$(user)Big $(user)moment $(channel) $(user)' && s.focused && s.caret === 14), 'two quick inserts both kept');
    // Typing right after an insert, before any render, is kept (a keystroke = text at the cursor + an input event).
    await page.evaluate(() => {
      document.querySelector('.studio-pane.properties app-overlay-look-user-token button').click();
      const f = document.querySelector('.studio-pane.properties textarea'); f.setRangeText('!', f.selectionStart, f.selectionEnd, 'end'); f.dispatchEvent(new InputEvent('input', { bubbles: true, data: '!', inputType: 'insertText' }));
    });
    await sleep(400);
    let state = await fieldState(page);
    assert.equal(state.value, '$(user)$(user)$(user)!Big $(user)moment $(channel) $(user)', 'typing right after an insert is kept'); assert.equal(state.caret, 22, 'cursor after the typed text');
    // Focus moved on past the action (field → Insert → next control): a later Insert appends, no stale cursor.
    await template(page).focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Tab');
    assert.equal(await insertButton(page).evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Tab');
    assert.equal(await insertButton(page).evaluate(el => document.activeElement !== el), true, 'focus moved on');
    await insertButton(page).click();
    await until(() => fieldState(page).then(s => s.value === '$(user)$(user)$(user)!Big $(user)moment $(channel) $(user) $(user)'), 'appended after focus moved on');
    await shot(page, 'look-text-insert-desktop-dark');
    await axe(page, 'app-trigger-look-dialog', 'text inspector desktop dark');
    await page.locator('.look-save').click();
    await until(() => ctx.puts.length === 1, 'saved');
    assert.equal(ctx.puts[0].layout.widgets.find(w => w.id === 'text-1').text, '$(user)$(user)$(user)!Big $(user)moment $(channel) $(user) $(user)', 'saved template: every insert and the typing');
    // New text objects in a look still start with plain text.
    await openStudio(page, 'add'); await page.locator('.palette-item[data-kind=text]').click();
    await openStudio(page, 'layer'); assert.equal((await template(page).inputValue()).includes('$('), false, 'new text starts plain');
    await closeLook(page); await page.locator('app-overlay-look-prompt [data-action=discard]').click(); await dialog(page).waitFor({ state: 'detached' });
    await context.close();
  }
  // The media library page counts look use the same way, names the looks, and shows a refused delete's API message.
  {
    const { context, page, ctx } = await open({ width: 390, touch: true, path: 'library', extra: true });
    const libRow = name => page.locator('app-media-library-page .lf-lib-row').filter({ has: page.locator('.lf-lib-row__name', { hasText: new RegExp(`^${name}$`) }) });
    const tags = async name => (await libRow(name).locator('.lf-tag--ok, .lf-tag--muted').allInnerTexts()).map(t => t.trim());
    assert.deepEqual(await tags('Drum'), ['In 2 triggers']); assert.deepEqual(await tags('Wide'), ['In 1 trigger']); assert.deepEqual(await tags('Chime'), ['In 2 triggers']);
    assert.deepEqual(await tags('Spark'), ['Not used yet']);
    await libRow('Drum').getByRole('button', { name: 'Delete Drum' }).click();
    const modal = page.locator('app-media-library-page [role=alertdialog]'); await modal.waitFor();
    assert.deepEqual((await modal.locator('.lf-usage-list li').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()), ['Trigger look Looked_Trigger', 'Trigger look Muted_Trigger'], 'look uses are named as looks');
    await shot(page, 'library-delete-look-use-390-dark');
    await axe(page, 'app-media-library-page [role=alertdialog]', 'library in-use dialog');
    await modal.getByRole('button', { name: 'Close' }).click(); await modal.waitFor({ state: 'detached' });
    ctx.refuseDelete = 'Spark is used in a trigger look. Remove it from the look first.';
    await libRow('Spark').getByRole('button', { name: 'Delete Spark' }).click(); await modal.waitFor();
    await modal.getByRole('button', { name: 'Delete', exact: true }).click();
    await until(() => page.locator('app-toast-container').innerText().then(t => t.includes(ctx.refuseDelete)), 'library: refused delete shows the API message');
    assert.equal(await overflow(page), false, 'library 390');
    await context.close();
  }
  // Alert designs keep their own text inspector (no insert action, the alert tokens hint).
  {
    const { context, page } = await open({ width: 1280, path: 'studio' });
    await openStudio(page, 'designs'); await page.locator('.design-row__actions button').first().click(); await page.locator('.design-event-tabs').waitFor();
    await openStudio(page, 'layers'); await page.locator('.layers .layer-row[data-layer-id=follow-text] .layer').click(); await openStudio(page, 'layer');
    await template(page).waitFor();
    assert.equal(await page.locator('app-overlay-look-user-token').count(), 0, 'no insert action in alert designs');
    await page.locator('.studio-pane.properties .lf-note').getByText('Use $(user) for the event user', { exact: false }).first().waitFor();
    await context.close();
  }
  // Spanish, phones (touch) and desktop, dark and light: the action fits, is a 44 px target, passes axe.
  for (const [width, dark, lang] of [[320, true, 'en'], [390, true, 'es'], [390, false, 'en'], [1280, false, 'es']]) {
    const touch = width < 640, tag = `${width}-${dark ? 'dark' : 'light'}-${lang}`;
    const { context, page, ctx } = await open({ width, dark, touch, lang, extra: true });
    if (width === 390) { await mediaRow(page, 'Drum').scrollIntoViewIfNeeded(); await shot(page, `triggers-media-in-use-${tag}`); }
    assert.equal(await overflow(page), false, 'triggers page ' + tag);
    await openLook(page, 'Looked_Trigger'); await openTextInspector(page);
    assert.equal(await page.locator('#look-text-hint').innerText(), HINT[lang], 'hint ' + tag);
    const box = await insertButton(page).boundingBox(), pane = await page.locator('.studio-pane.properties').boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44, 'touch target ' + tag + ' ' + JSON.stringify(box));
    assert.ok(box.x >= pane.x - 1 && box.x + box.width <= pane.x + pane.width + 1, 'action fits the pane ' + tag);
    if (touch) await insertButton(page).tap(); else await insertButton(page).click();
    await until(() => fieldState(page).then(s => s.value === 'Big moment $(channel) $(user)' && s.focused), 'insert ' + tag);
    await until(() => page.locator('.stage app-overlay-scene-renderer').innerText().then(t => t.includes('Big moment lookfixture Luna')), 'sample name on canvas ' + tag);
    await template(page).evaluate(el => el.blur());
    await insertButton(page).scrollIntoViewIfNeeded();
    await shot(page, `look-text-insert-${tag}`);
    assert.equal(await overflow(page), false, 'editor ' + tag);
    await axe(page, 'app-trigger-look-dialog', 'text inspector ' + tag);
    assert.ok(ctx.requests.some(r => r.includes('media.fixture.invalid/drum.wav?k=fx5') || r.includes('?k=fx')), 'signed links in use ' + tag);
    await context.close();
  }
  // Screenshot matrix for visual review (only when screenshots are asked for): 390 touch and 1280, dark and light.
  if (shots && process.env.SAAS_LOOK_SHOT_MATRIX) for (const [width, dark] of [[390, true], [390, false], [1280, true], [1280, false]]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`, touch = width < 640;
    const { context, page } = await open({ width, dark, touch });
    await shot(page, `m-triggers-rows-${tag}`);
    await openLook(page, 'Looked_Trigger'); await shot(page, `m-editor-${tag}`);
    await openStudio(page, 'timeline'); await shot(page, `m-timeline-${tag}`);
    await page.locator('app-overlay-sounds .sounds__add').click(); await page.locator('.tmp-row').first().waitFor(); await shot(page, `m-picker-${tag}`);
    await page.locator('.tmp-upload').click(); await page.locator('input[type=file]').setInputFiles({ name: 'Crowd.wav', mimeType: 'audio/wav', buffer: files['chime.wav'].body }); await shot(page, `m-upload-${tag}`);
    await page.keyboard.press('Escape'); await page.locator('app-overlay-trigger-media-picker').waitFor({ state: 'detached' });
    await lookSettings(page); await shot(page, `m-settings-${tag}`); await lengthInput(page).fill('6'); await closeLook(page);
    await page.locator('app-overlay-look-prompt [role=alertdialog]').waitFor(); await shot(page, `m-unsaved-${tag}`);
    await context.close();
    const studio = await open({ width, dark, touch, path: 'studio' });
    await openStudio(studio.page, 'layers'); await studio.page.locator('.layers .layer-row[data-layer-id=trigger-1] .layer').click(); await openStudio(studio.page, 'layer');
    await studio.page.locator('app-overlay-trigger-looks .tl__row').first().waitFor(); await studio.page.locator('app-overlay-trigger-looks').scrollIntoViewIfNeeded();
    await shot(studio.page, `m-studio-list-${tag}`);
    await studio.context.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS trigger look editor (observed through DOM, network, storage, dialogs and history only): Triggers page dialog (lazy, isolated from Overlay Studio, owner + admin), seeds (video/picture/audio, measured lengths), trigger media picker (kinds, search, previews, upload rules), timeline end grip, save body + revision, status, unsaved/remove prompts, validation + conflict reload, removed files, master volume; Overlay Studio in place: unsaved overlay edits + undo/redo + Test drawer kept, overlay recovery copy written on entry and never containing the look, offered recovery copy untouched and banner back after return, fresh-editor restore, tab-close and history-navigation prompts; late look answers after look B / an alert design change nothing; one PUT per double click; library slower than triggers; missing trigger file; history navigation prompt on the Triggers page; admin failed GET without Studio requests; no sockets; who fired it (look text hint EN/ES, insert $(user) at the cursor / appended / by keyboard with undo/redo, sample name on the canvas, saved template, none in alert designs, Test sends firedBy); files used by looks in use on the Triggers and library pages (distinct per trigger, look-only = no Use) and refused deletes show the API message; volume 0 kept through the edit dialog; signed media links used unchanged; EN/ES, dark/light, 320/390/1280, axe');
} finally { await browser.close(); }
