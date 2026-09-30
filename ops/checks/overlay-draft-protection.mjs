import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert(base);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const api = 'https://api.domdimabot.com';
const user = { id: '990091', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const widget = { id: 'text-1', kind: 'text', x: 10, y: 10, width: 400, height: 160, visible: true, locked: false, text: '$(user)' };
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 5, widgets: [structuredClone(widget)] }])) };
const scene = { id: 'main', name: 'My overlay', revision: 0, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['bits'], widgets: [{ ...widget, id: 'alert-1', kind: 'alert', designId: 'starter', events: ['follow', 'bits'] }] };
let state = { schemaVersion: 1, revision: 0, scenes: [scene], designs: [design] };
let loadFailure = false, saveFailure = false, conflict = false;
let reads = 0, writes = 0;
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
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
    else if (url.pathname.endsWith('/preview')) {
      const body = request.postDataJSON();
      data = body.texts.map(text => text.replaceAll('$(user)', body.user));
    } else if (url.pathname === `/overlay-studio/${user.id}/connections`) data = { checkedAt: Date.now(), pollingFailed: false, scenes: state.scenes.map(s => ({ id: s.id, published: !!s.published, revision: s.revision, width: s.published?.width ?? s.width, height: s.published?.height ?? s.height, receives: [], sources: [] })) };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (request.method() === 'GET') {
        reads++;
        if (loadFailure) return route.fulfill({ status: 503, json: { error: true, message: 'Fixture load failure' } });
      } else if (request.method() === 'PUT') {
        writes++;
        if (conflict || request.postDataJSON().revision !== state.revision) return route.fulfill({ status: 409, json: { error: true, message: 'Fixture conflict' } });
        if (saveFailure) return route.fulfill({ status: 503, json: { error: true, message: 'Fixture save failure' } });
        state = structuredClone(request.postDataJSON());
        state.revision++;
      }
      data = structuredClone(state);
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  const editor = page.locator('app-overlay-editor');
  const click = name => editor.getByRole('button', { name, exact: true }).click();
  const field = async (name, value) => { await page.getByLabel(name, { exact: true }).fill(value); await page.getByLabel(name, { exact: true }).blur(); };
  const load = async () => { await page.goto(base + '/fixture/modules/overlays'); await editor.locator('.stage').waitFor(); };
  const backups = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domdimabot-overlay-draft:')).map(key => ({ key, value: JSON.parse(localStorage.getItem(key)) })));
  const waitForBackup = name => page.waitForFunction(name => Object.keys(localStorage).some(key => key.startsWith('domdimabot-overlay-draft:') && (!name || JSON.parse(localStorage.getItem(key)).scenes[0].name === name)), name);
  const blocksUnload = () => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  const chooseDialog = async (accept, action) => {
    const next = page.waitForEvent('dialog');
    const pending = action();
    const dialog = await next;
    const message = dialog.message();
    if (accept) await dialog.accept(); else await dialog.dismiss();
    await pending;
    return message;
  };

  await load();
  await editor.locator('.studio-nav').getByRole('button', { name: /Alert design library/ }).click();
  await click('+ New alert design');
  await field('Text template', 'Unsaved recovery fixture');
  loadFailure = true;
  // Before the fix, reload immediately destroys this unsaved design, even when GET fails.
  page.once('dialog', dialog => dialog.accept());
  await click('Reload saved draft');
  await page.getByText('Fixture load failure', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Text template', { exact: true }).inputValue(), 'Unsaved recovery fixture');
  assert.equal(await editor.locator('.design-event-tabs').count(), 1);
  assert.equal(await blocksUnload(), true);
  await waitForBackup();
  assert.equal((await backups())[0].value.designDraft.events.follow.widgets[1].text, 'Unsaved recovery fixture');
  console.log('PASS failed reload preserves the unsaved design and browser recovery copy.');

  loadFailure = false;
  const readsBeforeCancel = reads;
  await chooseDialog(false, () => click('Reload saved draft'));
  assert.equal(reads, readsBeforeCancel);
  assert.equal(await page.getByLabel('Text template', { exact: true }).inputValue(), 'Unsaved recovery fixture');
  await chooseDialog(false, () => editor.getByRole('link', { name: 'Back to modules', exact: true }).click());
  assert(page.url().endsWith('/fixture/modules/overlays'));
  await click('Save design');
  await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(await blocksUnload(), false);
  await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('domdimabot-overlay-draft:')));
  await click('← Save & back to overlay');
  assert.equal(await blocksUnload(), false);
  console.log('PASS cancelled reload/navigation keep edits; successful save clears protection and backup.');

  const originalName = state.scenes[0].name;
  await page.getByLabel('Overlay name', { exact: true }).fill('Still focused draft');
  assert.equal(await blocksUnload(), true, 'typing must protect the draft before the field loses focus');
  await field('Overlay name', 'Changed overlay');
  assert.equal(await blocksUnload(), true);
  await field('Overlay name', originalName);
  assert.equal(await blocksUnload(), false, 'reverting the change restores a clean document');
  await field('Overlay name', 'Recovered overlay');
  await waitForBackup('Recovered overlay');
  // Tab identity is held in session storage. Opening a fresh tab must not overwrite this draft.
  const second = await context.newPage();
  // Browsers copy sessionStorage when duplicating a tab or opening it through an opener.
  const inheritedTabId = await page.evaluate(() => sessionStorage.getItem('domdimabot-overlay-tab'));
  await second.addInitScript(id => sessionStorage.setItem('domdimabot-overlay-tab', id), inheritedTabId);
  second.setDefaultTimeout(12000);
  second.on('pageerror', error => errors.push(error.message));
  await second.goto(base + '/fixture/modules/overlays');
  await second.locator('app-overlay-editor .stage').waitFor();
  await second.getByLabel('Overlay name', { exact: true }).fill('Second tab draft');
  await second.getByLabel('Overlay name', { exact: true }).blur();
  await page.waitForFunction(() => Object.keys(localStorage).filter(key => key.startsWith('domdimabot-overlay-draft:')).length === 2);
  const copies = await backups();
  assert.deepEqual(copies.map(copy => copy.value.scenes[0].name).sort(), ['Recovered overlay', 'Second tab draft']);
  assert(copies.every(copy => copy.value.scenes[0].publicId === undefined && copy.value.scenes[0].published === undefined), 'recovery copies exclude bearer URLs and published snapshots');
  await second.close({ runBeforeUnload: false });

  await chooseDialog(true, () => page.reload());
  await editor.getByRole('button', { name: 'Restore local draft', exact: true }).waitFor();
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `recovery banner overflow at ${width}`);
  }
  await click('Switch language');
  await editor.getByRole('button', { name: 'Restaurar borrador local', exact: true }).waitFor();
  await editor.getByRole('button', { name: 'Cambiar idioma', exact: true }).click();
  await editor.getByRole('button', { name: 'Restore local draft', exact: true }).waitFor();
  if (process.env.SAAS_SCREENSHOT_DIR) {
    await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.screenshot({ path: process.env.SAAS_SCREENSHOT_DIR + '/recovery-banner-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: process.env.SAAS_SCREENSHOT_DIR + '/recovery-banner-desktop.png', fullPage: true });
  }
  await click('Restore local draft');
  await page.waitForFunction(() => document.querySelector('.name-field input')?.value === 'Recovered overlay');
  assert.equal(await page.getByLabel('Overlay name', { exact: true }).inputValue(), 'Recovered overlay');
  assert.equal(await blocksUnload(), true);
  saveFailure = true;
  await click('Save draft');
  await page.getByText('Fixture save failure', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Overlay name', { exact: true }).inputValue(), 'Recovered overlay');
  assert.equal(await blocksUnload(), true);
  saveFailure = false;
  await click('Save draft');
  await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(await blocksUnload(), false);
  console.log('PASS local recovery survives refresh, separates tabs, excludes public URLs, and survives failed saves.');

  // Simulate another browser saving after our backup. Restoring must retain the old CAS revision.
  await field('Overlay name', 'Conflicting local draft');
  await waitForBackup('Conflicting local draft');
  const previousRevision = state.revision;
  state.revision++;
  state.scenes[0].name = 'Another browser saved this';
  await chooseDialog(true, () => page.reload());
  await click('Restore local draft');
  await page.waitForFunction(() => document.querySelector('.name-field input')?.value === 'Conflicting local draft');
  assert.equal(await page.getByLabel('Overlay name', { exact: true }).inputValue(), 'Conflicting local draft');
  await click('Save draft');
  await page.getByText(/This draft changed in another tab/).waitFor();
  assert.equal(state.scenes[0].name, 'Another browser saved this');
  assert.equal((await backups()).find(copy => copy.value.scenes[0].name === 'Conflicting local draft').value.revision, previousRevision);
  const beforeDiscard = reads;
  await chooseDialog(false, () => click('Reload saved draft'));
  assert.equal(reads, beforeDiscard);
  await chooseDialog(true, () => click('Reload saved draft'));
  await page.waitForFunction(() => document.querySelector('.name-field input')?.value === 'Another browser saved this');
  assert.equal(await page.getByLabel('Overlay name', { exact: true }).inputValue(), 'Another browser saved this');
  assert.equal(await blocksUnload(), false);
  console.log('PASS stale recovery preserves CAS, cannot overwrite another browser, and needs explicit discard.');

  // Initial failures must never expose the editor's seeded sample as editable account data.
  await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domdimabot-overlay-draft:')).forEach(key => localStorage.removeItem(key)));
  loadFailure = true;
  await page.reload();
  await page.getByText('Fixture load failure', { exact: true }).waitFor();
  assert.equal(await editor.locator('.stage').count(), 0);
  assert.equal(await editor.getByRole('button', { name: 'Save draft', exact: true }).count(), 0);
  loadFailure = false;
  await click('Try again');
  await editor.locator('.stage').waitFor();
  assert.equal(await blocksUnload(), false);

  // Exercise a realistic JSON recovery copy around 1 MB, including every event layout.
  const previousDesigns = structuredClone(state.designs);
  state.designs = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(design), id: index ? 'large-' + index : 'starter', events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 5, widgets: Array.from({ length: 6 }, (_, layer) => ({ ...widget, id: kind + '-' + layer, text: 'x'.repeat(2000) })) }])) }));
  await page.reload();
  await editor.locator('.stage').waitFor();
  await field('Overlay name', 'Large recovered draft');
  await waitForBackup('Large recovered draft');
  const largeBackup = (await backups()).find(copy => copy.value.scenes[0].name === 'Large recovered draft');
  assert(JSON.stringify(largeBackup.value).length > 1000000);
  await chooseDialog(true, () => page.reload());
  await click('Restore local draft');
  await page.waitForFunction(() => document.querySelector('.name-field input')?.value === 'Large recovered draft');
  await click('Save draft');
  await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(state.designs.length, 20);
  assert.equal(state.designs[19].events.raid.widgets[5].text.length, 2000);
  state.designs = previousDesigns;
  await page.reload();
  await editor.locator('.stage').waitFor();
  console.log('PASS duplicated tabs use distinct backups; JSON recovery over 1 MB keeps all event layouts.');

  // Storage quota failure must leave the actual draft intact and warn that recovery isn't current.
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('domdimabot-overlay-draft:')) throw new DOMException('Fixture quota failure', 'QuotaExceededError'); return set.call(this, key, value); }; });
  await field('Overlay name', 'Quota protected draft');
  await page.getByText(/Could not update the local recovery copy/).waitFor();
  assert.equal(await page.getByLabel('Overlay name', { exact: true }).inputValue(), 'Quota protected draft');
  assert.equal(await blocksUnload(), true);
  await click('Save draft');
  await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();

  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
  }
  if (process.env.SAAS_SCREENSHOT_DIR) {
    await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.screenshot({ path: process.env.SAAS_SCREENSHOT_DIR + '/draft-protection-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: process.env.SAAS_SCREENSHOT_DIR + '/draft-protection-desktop.png', fullPage: true });
  }
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  const accessibility = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(accessibility.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  await editor.getByRole('link', { name: 'Back to modules', exact: true }).click();
  await page.waitForURL('**/fixture/modules');
  assert.deepEqual(errors, []);
  assert(writes > 0);
  console.log('PASS initial-load retry, storage quota errors, clean navigation, responsive layouts and accessibility.');
} finally {
  await browser.close();
}
