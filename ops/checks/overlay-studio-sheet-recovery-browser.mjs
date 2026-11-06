// Overlay Studio: phone sheets above the save bar, and the local recovery banner only when a copy
// holds unsaved work (2026-11-06 user report: switcher rows hidden under the save bar; the
// "Unsaved draft found" banner came back on every visit). Fully mocked API; nothing reaches production.
import { openStudio } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const api = 'https://api.domdimabot.com';
const user = { id: '990091', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const PREFIX = `domdimabot-overlay-draft:${user.id}:`;
const widget = { id: 'text-1', kind: 'text', x: 10, y: 10, width: 400, height: 160, visible: true, locked: false, text: '$(user)' };
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 5, widgets: [structuredClone(widget)] }])) };
const scene = (id, name, n) => ({ id, name, revision: 0, publicId: String(n).repeat(48), width: 1920, height: 1080, waitFor: [], widgets: [{ ...widget, id: 'alert-' + id, kind: 'alert', designId: 'starter', events: ['follow'] }] });
let state = { schemaVersion: 1, revision: 3, scenes: [scene('main', 'My overlay', 'a'), scene('second', 'Second overlay', 'b'), scene('third', 'Third overlay', 'c')], designs: [design] };
let loadFailure = false;
const errors = [];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function studioContext(viewport, phone) {
  const context = await browser.newContext({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.addInitScript(({ user, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = request.postDataJSON().texts;
    else if (url.pathname === `/overlay-studio/${user.id}/connections`) data = { checkedAt: Date.now(), pollingFailed: false, scenes: state.scenes.map(s => ({ id: s.id, published: false, revision: s.revision, width: s.width, height: s.height, receives: [], sources: [] })) };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (request.method() === 'GET' && loadFailure) return route.fulfill({ status: 503, json: { error: true, message: 'Fixture load failure' } });
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        if (body.revision !== state.revision) return route.fulfill({ status: 409, json: { error: true, message: 'Fixture conflict' } });
        state = { ...structuredClone(body), revision: state.revision + 1 };
      }
      data = structuredClone(state);
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  return { context, page };
}
const until = async (test, message, tries = 80) => { for (let i = 0; i < tries; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(message); };
/** True when a tap at the centre of `selector` (nth match) lands on that element. */
const reachable = (page, selector, nth = 0) => page.evaluate(([selector, nth]) => {
  const el = document.querySelectorAll(selector)[nth]; if (!el) return false;
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false;
  return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
}, [selector, nth]);
const hitAt = (page, selector) => page.evaluate(selector => {
  const r = document.querySelector(selector).getBoundingClientRect();
  return document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 60))?.className?.toString() ?? '';
}, selector);
const saveBarVisibility = page => page.evaluate(() => getComputedStyle(document.querySelector('.lf-save-bar')).visibility);

try {
  // ── Part 1: sheets on phones sit above the save bar; desktop popovers are unchanged.
  for (const viewport of [{ width: 360, height: 740 }, { width: 412, height: 860 }]) {
    const { context, page } = await studioContext(viewport, true);
    await page.goto(base + '/fixture/modules/overlays');
    await page.locator('app-overlay-editor .stage').waitFor();
    assert.equal(await saveBarVisibility(page), 'visible');
    await openStudio(page, 'scenes');
    await until(() => page.locator('.studio.studio--sheet').count().then(Boolean), 'sheet class set');
    const tabs = await page.locator('.scene-tab').count();
    assert.equal(tabs, 4, 'three overlays and New overlay');
    for (let i = 0; i < tabs; i++) assert(await reachable(page, '.scene-tab', i), `${viewport.width}px: switcher row ${i} is tappable`);
    assert.equal(await saveBarVisibility(page), 'hidden', 'save bar hides under an open sheet');
    assert.match(await hitAt(page, '.studio__canvas'), /pop-backdrop/, 'backdrop covers the pinned canvas');
    await page.locator('.scene-tab[data-id="third"]').tap();
    await until(async () => (await page.locator('.name-field input').inputValue()) === 'Third overlay', 'tapping a row switches overlay');
    await until(async () => !(await page.locator('.pop--scenes').count()), 'switcher closes');
    assert.equal(await saveBarVisibility(page), 'visible', 'save bar returns when the sheet closes');
    await openStudio(page, 'obs');
    assert(await reachable(page, '.lf-setup .lf-btn'), 'OBS sheet button tappable');
    assert.equal(await saveBarVisibility(page), 'hidden');
    await page.keyboard.press('Escape');
    await page.locator('.studio-menu-btn').tap();
    await page.locator('.pop--menu').waitFor();
    for (const item of ['.studio-leave', '.studio-theme', '.studio-language']) assert(await reachable(page, `.pop--menu ${item}`), `menu ${item} tappable`);
    // Tap the dimmed area between the top bar and the sheet.
    const gap = await page.evaluate(() => [document.querySelector('.studio-top').getBoundingClientRect().bottom, document.querySelector('.pop--menu').getBoundingClientRect().top]);
    assert(gap[1] - gap[0] > 20, 'some dimmed space is left above the menu sheet');
    await page.locator('.pop-backdrop').tap({ position: { x: 20, y: (gap[0] + gap[1]) / 2 } });
    await until(async () => !(await page.locator('.pop--menu').count()), 'tapping the backdrop closes the sheet');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
    console.log(`PASS ${viewport.width}px phone: switcher rows, OBS and menu sheets sit above the save bar; backdrop closes them`);
    await context.close();
  }
  {
    const { context, page } = await studioContext({ width: 1440, height: 900 }, false);
    await page.goto(base + '/fixture/modules/overlays');
    await page.locator('app-overlay-editor .stage').waitFor();
    await openStudio(page, 'scenes');
    const box = await page.locator('.pop--scenes').boundingBox();
    assert(box.y < 120 && box.width < 400, 'desktop switcher stays anchored under the name');
    for (let i = 0; i < 4; i++) assert(await reachable(page, '.scene-tab', i));
    assert.equal(await saveBarVisibility(page), 'visible', 'desktop save bar stays in the top bar');
    await page.keyboard.press('Escape');
    console.log('PASS 1440px desktop: switcher anchored, save bar visible');
    await context.close();
  }

  // ── Part 2: the recovery banner appears only for copies with unsaved work, and goes away for good.
  state.revision = 10; state.scenes = state.scenes.slice(0, 2);
  const { context, page } = await studioContext({ width: 412, height: 860 }, true);
  const editor = page.locator('app-overlay-editor');
  const banner = editor.getByRole('button', { name: 'Restore local draft', exact: true });
  const copies = () => page.evaluate(prefix => Object.keys(localStorage).filter(k => k.startsWith(prefix)).map(k => ({ key: k, name: JSON.parse(localStorage.getItem(k)).scenes[0].name })), PREFIX);
  const settle = async () => { await editor.locator('.stage').waitFor(); await page.waitForTimeout(900); };
  const load = async () => { await page.goto(base + '/fixture/modules/overlays'); await settle(); };
  const reload = async () => { await page.reload(); await settle(); };
  const rename = async name => { const input = page.getByLabel('Overlay name', { exact: true }); await input.fill(name); await input.blur(); };
  const leaveEdit = async name => { await rename(name); await until(async () => (await copies()).some(c => c.name === name), `copy for ${name} written`); };
  const save = async () => { await page.locator('.save-button').click(); await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor(); };
  /** A copy as another tab or an earlier visit would have left it. */
  const plant = (overrides = {}, mutate = () => {}) => {
    const draft = { schemaVersion: 1, channelID: user.id, updatedAt: Date.now(), revision: state.revision, sceneId: 'main', designEvent: 'follow', variantId: null, selectedId: null, designDraft: null,
      scenes: state.scenes.map(({ publicId: _p, published: _s, revision: _r, ...s }) => s), designs: structuredClone(state.designs), ...overrides };
    mutate(draft);
    return page.evaluate(([key, value]) => localStorage.setItem(key, value), [PREFIX + crypto.randomUUID(), JSON.stringify(draft)]);
  };
  const noBanner = async label => { assert.equal(await banner.count(), 0, `${label}: no banner`); assert.deepEqual(await copies(), [], `${label}: no copies left`); };

  await load();
  await noBanner('fresh load');
  await leaveEdit('Unsaved edit');
  await reload();
  await banner.waitFor();
  // The user's report: ignore the banner, save other work, and it must not come back.
  await rename('Saved name'); await save();
  await until(async () => !(await copies()).length, 'saving deletes the passed-over copy');
  await reload();
  await noBanner('after ignoring the banner and saving');
  await reload();
  await noBanner('second visit');
  console.log('PASS a copy passed over and then saved over is deleted and never offered again');

  // A copy that matches the saved draft (fields in another order, as another tab may write them) holds nothing to restore.
  await plant({}, draft => { draft.scenes = draft.scenes.map(s => Object.fromEntries(Object.entries(s).reverse())); draft.designs = draft.designs.map(d => ({ ...d, revision: 99 })); });
  await plant({ updatedAt: Date.now() - 60000, designDraft: structuredClone(state.designs[0]) });
  await reload();
  await noBanner('copies equal to the saved draft');
  console.log('PASS copies equal to the saved draft (any key order, open design unchanged) are deleted silently');

  // Several leftover copies: each holds different work, so only the one the user dealt with is deleted.
  const bannerCopies = async () => { await banner.waitFor(); return (await copies()).length; };
  await plant({ updatedAt: Date.now() - 7200000 }, d => { d.scenes[0].name = 'Old copy A'; });
  await plant({ updatedAt: Date.now() - 3600000 }, d => { d.scenes[0].name = 'Old copy B'; });
  await reload();
  assert.equal(await bannerCopies(), 2);
  await editor.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
  await until(async () => !(await banner.count()), 'banner closes on discard');
  assert.deepEqual((await copies()).map(c => c.name), ['Old copy A'], 'discard deletes only the newest, offered copy');
  await reload();
  await banner.waitFor();
  await editor.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
  await reload();
  await noBanner('after discarding both leftovers');
  await plant({ updatedAt: Date.now() - 7200000 }, d => { d.scenes[0].name = 'Old copy C'; });
  await plant({ updatedAt: Date.now() - 3600000 }, d => { d.scenes[0].name = 'Old copy D'; });
  await reload();
  await banner.waitFor();
  await rename('Saved again'); await save();
  await until(async () => (await copies()).length === 1, 'saving deletes the offered copy');
  assert.deepEqual((await copies()).map(c => c.name), ['Old copy C']);
  await reload();
  await banner.waitFor();
  await editor.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
  await reload();
  await noBanner('after saving over one leftover and discarding the other');
  console.log('PASS discarding or saving over the offered copy deletes only that copy; other leftovers come one at a time');

  // Real unsaved work is still offered, including an edited design and a newer copy from another tab.
  await plant({}, d => { d.designDraft = { ...structuredClone(state.designs[0]), name: 'Edited design' }; });
  await reload();
  await banner.waitFor();
  await editor.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
  await leaveEdit('Restore me');
  await reload();
  await banner.click();
  await until(async () => (await page.getByLabel('Overlay name', { exact: true }).inputValue()) === 'Restore me', 'restored');
  await save();
  await reload();
  await noBanner('after restoring and saving');
  console.log('PASS unsaved overlay and design work is still offered; restore + save leaves nothing behind');

  // Reload saved draft keeps the banner (nothing was saved); a failed first load still offers restore.
  await leaveEdit('Keep offered');
  await reload();
  await banner.waitFor();
  await openStudio(page, 'overlay');
  await editor.locator('.publish-settings').evaluate(d => { d.open = true; });
  await editor.getByRole('button', { name: 'Reload saved draft', exact: true }).click();
  await page.waitForTimeout(900);
  assert.equal(await banner.count(), 1, 'reloading the saved draft keeps the banner');
  loadFailure = true;
  await page.reload();
  await page.getByText('Fixture load failure', { exact: true }).waitFor();
  assert.equal(await banner.count(), 1, 'restore is offered when loading fails');
  loadFailure = false;
  await editor.getByRole('button', { name: 'Try again', exact: true }).click();
  await settle();
  assert.equal(await banner.count(), 1, 'still offered after a successful retry');
  await editor.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
  await reload();
  await noBanner('final');
  console.log('PASS reload keeps the banner; failed first load still offers restore');
  await context.close();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
