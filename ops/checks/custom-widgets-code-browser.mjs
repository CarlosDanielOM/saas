/**
 * Overlay Studio custom widget code editor, against an isolated site preview/candidate with every API mocked:
 *  - "New widget": name + Dima SDK starter → editor (CodeMirror) with a live preview of the unsaved code; test chat and
 *    alerts reach only the preview; editing CSS updates the preview; broken fields JSON shows a blocking problem on its
 *    tab (with the line), keeps the last good preview and blocks saving; "Create widget" posts the files and adds a layer
 *  - saving again sends the base revision; version history lists both and "Open" loads an older version as unsaved
 *  - unsaved work survives a reload (restored banner, discard); a stale save is refused and can be saved anyway
 *  - Escape inside the code doesn't close the dialog; Escape elsewhere does
 *  - "Edit code" on an imported StreamElements widget: files load, no widget.json → "Add widget.json" writes one
 *  - phones: Code / Preview switch; axe (wcag2a/2aa/21aa) and no horizontal overflow at 390 and 1280, dark and light
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL must name an isolated preview/candidate');
const repo = process.env.SAAS_REPO || '/root/saas';
const fixtures = process.env.CUSTOM_WIDGET_FIXTURES || `${repo}/ops/checks/custom-widget-fixtures/sample-chat`;
const formatModule = `/tmp/custom-widget-format-code-${process.pid}.mjs`;
createRequire(`${repo}/dimabot/package.json`)('esbuild').buildSync({ entryPoints: [`${repo}/dimabot/src/custom_widgets/format.ts`], format: 'esm', platform: 'node', outfile: formatModule, logLevel: 'error' });
const { readPackage } = await import(formatModule);
const api = 'https://api.domdimabot.com', errors = [];
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const shot = async (page, name) => { if (!shots) return; await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/custom-widgets-code-${name}.png` }); };
const until = async (fn, label, tries = 120) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out: ' + label); };

const parts = ['html', 'css', 'js', 'fields', 'data'];
const sample = Object.fromEntries(await Promise.all(parts.map(async part => [part, await readFile(`${fixtures}/${part}.txt`, 'utf8')])));
const user = { id: '533538623', login: 'customfixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: false, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const seId = 'a1'.repeat(12);

/** Mock API with real file storage per widget and revision (create, replace with baseRevision, files, history). */
function mocks({ theme = 'dark', withSample = false } = {}) {
  const world = { widgets: [], code: new Map(), creates: [], replaces: [], state: { schemaVersion: 1, revision: 0, designs: [],
    scenes: [{ id: 'main', name: 'Main overlay', publicId: 'e'.repeat(48), width: 1920, height: 1080, revision: 0, widgets: [], waitFor: [] }] } };
  const viewOf = (id, name) => {
    const entry = world.code.get(id), files = entry.files[entry.revision], pkg = readPackage(files);
    return { id, name, engine: pkg.manifest.engine, revision: entry.revision, fields: pkg.fields, data: pkg.data, externalMedia: pkg.externalMedia, manifest: pkg.manifest, media: {},
      files: Object.fromEntries(parts.map(part => [part, { bytes: files[part].length, sha256: 'f'.repeat(64) }])), createdAt: '', updatedAt: '', usedIn: [],
      history: Object.keys(entry.files).map(Number).sort((a, b) => b - a).map(revision => ({ revision, createdAt: new Date(Date.UTC(2026, 10, 5, 10, revision)).toISOString(), published: false })) };
  };
  const store = (id, name, files) => { world.code.set(id, { revision: 1, name, files: { 1: files } }); world.widgets.push(viewOf(id, name)); };
  if (withSample) store(seId, 'Sample chat', { ...sample });
  return { world, viewOf, async install(context) {
    await context.addInitScript(({ user, app, theme }) => {
      if (window.top !== window) return;
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      if (!localStorage.getItem('theme')) localStorage.setItem('theme', theme);
      localStorage.setItem('userLanguage', 'en');
    }, { user, app, theme });
    await context.routeWebSocket('**/*', ws => ws.close());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.origin !== api) return route.abort();
      const path = url.pathname, list = `/overlay-studio/${user.id}/custom-widgets`;
      let data = {}, status = 200;
      const file = /\/custom-widgets\/([a-f0-9]{24})\/files\/(\w+)$/.exec(path), files = /\/custom-widgets\/([a-f0-9]{24})\/files$/.exec(path);
      if (path === '/auth/session') data = { twitch: user, app };
      else if (path.endsWith('/access') || path.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'premium' };
      else if (path.endsWith('/connections')) data = { checkedAt: Date.now(), scenes: [] };
      else if (path === list && req.method() === 'GET') data = { enabled: true, planTier: 'premium', limit: 5, used: world.widgets.length, widgets: world.widgets };
      else if (path === list && req.method() === 'POST') {
        const body = req.postDataJSON(), id = (world.code.size + 1).toString(16).padStart(2, '0').repeat(12);
        world.creates.push(body); store(id, body.name, body.files); status = 201; data = { widget: world.widgets.at(-1), issues: [] };
      } else if (files && req.method() === 'PUT') {
        const body = req.postDataJSON(), entry = world.code.get(files[1]); world.replaces.push(body);
        if (body.baseRevision !== undefined && body.baseRevision !== entry.revision) return route.fulfill({ status: 409, json: { error: true, status: 409, code: 'stale', message: `This widget changed since you opened it (now version ${entry.revision})` } });
        entry.revision++; entry.files[entry.revision] = body.files;
        const next = viewOf(files[1], entry.name); world.widgets = world.widgets.map(w => w.id === next.id ? next : w); data = { widget: next, issues: [] };
      } else if (file) {
        const entry = world.code.get(file[1]), revision = Number(url.searchParams.get('revision') ?? entry.revision), text = entry.files[revision]?.[file[2]];
        return text ? route.fulfill({ status: 200, contentType: 'text/plain', body: text }) : route.fulfill({ status: 404, json: { error: true, status: 404, message: 'Not found' } });
      } else if (/\/custom-widgets\/[a-f0-9]{24}\/bundle$/.test(path)) {
        const id = path.split('/').at(-2), entry = world.code.get(id), src = entry.files[entry.revision], pkg = readPackage(src);
        data = { widgetId: id, revision: entry.revision, engine: pkg.manifest.engine, manifest: pkg.manifest, html: src.html, css: src.css, js: src.js, fields: pkg.fields, data: pkg.data, media: {}, channel: { id: user.id, login: user.login, name: user.display_name } };
      } else if (path === `${list}/session`) data = { data: {}, recents: [] };
      else if (path.startsWith(`${list}/store/`)) data = { value: null };
      else if (path.startsWith(`${list}/counters/`)) data = { value: 0 };
      else if (path === `/overlay-studio/${user.id}`) {
        if (req.method() === 'PUT') { world.state = structuredClone(req.postDataJSON()); world.state.revision++; }
        data = structuredClone(world.state);
      }
      return route.fulfill({ status, json: { error: false, status, data } });
    });
  } };
}

const axe = async (page, label) => {
  const result = await new AxeBuilder({ page }).include('dialog.cwc').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`), [], `axe ${label}`);
};
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} overflow`);
/** Replaces the open tab's text in CodeMirror (as a paste would). */
async function setCode(dialog, text) {
  const content = dialog.locator('[data-cwc-editor] .cm-content');
  await content.click();
  await dialog.page().keyboard.press('ControlOrMeta+A');
  await dialog.page().evaluate(value => document.execCommand('insertText', false, value), text);
}
/** Inserts text at the start or end of the open tab. */
async function insertCode(dialog, text, where) {
  await dialog.locator('[data-cwc-editor] .cm-content').click();
  await dialog.page().keyboard.press(where === 'start' ? 'ControlOrMeta+Home' : 'ControlOrMeta+End');
  await dialog.page().evaluate(value => document.execCommand('insertText', false, value), text);
}
/** The rendered text of the open tab (CodeMirror draws the lines on screen, enough for these short checks). */
const code = dialog => dialog.locator('[data-cwc-editor] .cm-content').evaluate(node => node.innerText);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // 1. New widget from the Dima SDK starter, desktop dark.
  const m = mocks(), context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await m.install(context);
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/${user.login}/modules/overlays`); await page.locator('.stage').waitFor();
  await page.locator('[data-custom-new]').click();
  const dialog = page.locator('dialog.cwc');
  await dialog.locator('[data-cwc-start]').waitFor();
  await shot(page, 'start-dark-1280');
  await axe(page, 'start step');
  await dialog.locator('[data-cwc-name]').fill('Code test');
  assert.equal(await dialog.locator('[data-cwc-starter="dima"]').isChecked(), true, 'Dima SDK starter is the default');
  await dialog.locator('[data-cwc-start]').click();
  await dialog.locator('[data-cwc-editor] .cm-editor').waitFor();
  assert.equal(await dialog.locator('[data-cwc-tab="js"]').getAttribute('aria-selected'), 'true');
  assert.match(await code(dialog), /Dima\.on\('chat'/);
  assert.equal(await dialog.locator('[data-cwc-status]').getAttribute('data-status'), 'new');
  const frame = dialog.frameLocator('app-overlay-custom-widget iframe');
  await dialog.locator('app-overlay-custom-widget [data-custom-frame="running"]').waitFor();
  await dialog.locator('[data-cwc-chat="viewer"]').click();
  await frame.locator('.row').first().waitFor();
  await dialog.locator('[data-cwc-alert="follow"]').click();
  await until(async () => /followed!/.test(await frame.locator('#banner').textContent() ?? ''), 'follow banner');
  assert.equal(await page.locator('app-overlay-scene-renderer app-overlay-custom-widget').count(), 0, 'nothing on the canvas yet');
  console.log('PASS new widget: Dima starter in CodeMirror, live preview runs it, test chat and alerts reach the preview.');

  // Edit CSS → the preview restarts with it.
  await dialog.locator('[data-cwc-tab="css"]').click();
  await insertCode(dialog, '\n.row { outline: 3px solid rgb(0, 255, 0); }\n', 'end');
  await until(async () => /rgb\(0, 255, 0\)/.test(await dialog.locator('app-overlay-custom-widget iframe').getAttribute('srcdoc') ?? ''), 'preview uses the new CSS');
  // Broken fields JSON: blocking problem with its line, tab badge, last good preview kept, save refused.
  await dialog.locator('[data-cwc-tab="fields"]').click();
  await setCode(dialog, '{\n  "a": { "type": "text" },\n  oops\n}');
  await dialog.locator('[data-cwc-problems]').waitFor();
  assert.match(await dialog.locator('[data-cwc-problems]').textContent(), /1 error to fix[\s\S]*Fields:3/);
  assert.equal((await dialog.locator('[data-cwc-tab="fields"] .tabs__count').textContent()).trim(), '1');
  assert.equal(await dialog.locator('[data-cwc-status]').getAttribute('data-status'), 'problems');
  assert.match(await dialog.locator('app-overlay-custom-widget iframe').getAttribute('srcdoc'), /rgb\(0, 255, 0\)/, 'the last good preview stays');
  await dialog.locator('[data-cwc-save]').click();
  await page.waitForTimeout(300);
  assert.equal(m.world.creates.length, 0, 'nothing is saved while the code has errors');
  assert.equal(await dialog.locator('[data-cwc-tab="fields"]').getAttribute('aria-selected'), 'true', 'Save jumps to the error');
  assert.equal(await dialog.locator('[data-cwc-error]').count(), 0, 'the problem is explained once (list + footer), not again in an error bar');
  assert.equal(await dialog.locator('[data-cwc-chat="viewer"]').count(), 1, 'tests stay available with the last good manifest');
  assert.match(await dialog.locator('.head__meta').textContent(), /Dima widget/, 'the engine stays the last good one');
  await shot(page, 'problems-dark-1280');
  await axe(page, 'editor with problems');
  await dialog.locator('[data-cwc-editor] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Z');
  await until(async () => (await dialog.locator('[data-cwc-problems]').count()) === 0, 'undo restores the fields');
  assert.match(await code(dialog), /"accentColor"/);
  console.log('PASS editing: CSS changes restart the preview; broken JSON is a blocking problem (tab, line), keeps the last good preview and blocks saving; undo fixes it.');

  // Create → layer added; save again with the base revision; versions.
  await dialog.locator('[data-cwc-save]').click();
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'saved', 'created');
  assert.equal(m.world.creates.length, 1);
  assert.equal(m.world.creates[0].name, 'Code test');
  assert.equal(JSON.parse(m.world.creates[0].files.manifest).engine, 'dima');
  assert.match(m.world.creates[0].files.css, /rgb\(0, 255, 0\)/);
  assert.match(await dialog.locator('#cwc-title').textContent(), /Code · Code test/);
  await dialog.locator('[data-cwc-tab="js"]').click();
  await insertCode(dialog, '// v2\n', 'start');
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'unsaved', 'unsaved after an edit');
  await page.keyboard.press('ControlOrMeta+S');
  await until(async () => m.world.replaces.length === 1, 'Ctrl+S saves');
  assert.equal(m.world.replaces[0].baseRevision, 1);
  await dialog.locator('[data-cwc-versions] summary').click();
  assert.deepEqual(await dialog.locator('[data-cwc-versions] li').evaluateAll(items => items.map(li => li.dataset.revision)), ['2', '1']);
  await dialog.locator('[data-cwc-version="1"]').click();
  await dialog.locator('[data-cwc-opened]').waitFor();
  assert.doesNotMatch(await code(dialog), /^\/\/ v2/, 'version 1 is in the editor');
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'unsaved', 'an opened version is unsaved');
  await dialog.locator('[data-cwc-discard]').click();
  await until(async () => /^\/\/ v2/.test(await code(dialog)), 'discard goes back to the saved version');
  console.log('PASS saving: "Create widget" posts the files, later saves send the base revision (Ctrl+S), versions open as unsaved changes.');

  // Escape in the code keeps the dialog; elsewhere it closes and the layer is on the canvas.
  await dialog.locator('[data-cwc-editor] .cm-content').click();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true, 'Escape inside the code does not close the editor');
  await dialog.locator('[data-cwc-reload]').focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.widget[data-kind="custom"]').count(), 1, 'the created widget was added as a layer');

  // Unsaved work survives a reload; stale saves can be saved anyway.
  await page.locator('.widget[data-kind="custom"]').first().dispatchEvent('click');
  await page.locator('[data-cw-edit-code]').click();
  await dialog.locator('[data-cwc-editor] .cm-editor').waitFor();
  await dialog.locator('[data-cwc-tab="html"]').click();
  await insertCode(dialog, '<p class="draft">draft</p>\n', 'start');
  await page.waitForTimeout(800);
  await page.reload(); await page.locator('.stage').waitFor();
  // Studio wasn't saved, so place the widget again from the Add panel.
  const createdId = [...m.world.code.keys()].at(-1);
  await page.locator(`[data-custom-id="${createdId}"] .palette-item`).click();
  await page.locator('[data-cw-edit-code]').click();
  await dialog.locator('[data-cwc-draft]').waitFor();
  assert.equal(await dialog.locator('[data-cwc-status]').getAttribute('data-status'), 'unsaved');
  await dialog.locator('[data-cwc-tab="html"]').click();
  assert.match(await code(dialog), /class="draft"/, 'the draft is restored');
  const entry = m.world.code.get(createdId);
  entry.revision++; entry.files[entry.revision] = entry.files[entry.revision - 1]; // changed in another tab
  await dialog.locator('[data-cwc-save]').click();
  await dialog.locator('[data-cwc-stale]').waitFor();
  await dialog.locator('[data-cwc-save-anyway]').click();
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'saved', 'saved anyway');
  assert.equal(m.world.replaces.at(-1).baseRevision, undefined, 'save anyway skips the check');
  console.log('PASS drafts and conflicts: unsaved work is restored after a reload; a stale save is refused, then saved anyway.');
  await dialog.locator('[data-cwc-reload]').focus(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await context.close();

  // 2. Edit code of an imported StreamElements widget; phone layout, light then dark.
  for (const theme of ['light', 'dark']) {
    const sm = mocks({ theme, withSample: true }), ctx = await browser.newContext({ viewport: { width: 390, height: 860 }, reducedMotion: 'reduce', hasTouch: true });
    await sm.install(ctx);
    const p = await ctx.newPage(); p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    await p.locator('.studio-mtabs [data-tab="add"]').click();
    await p.locator(`[data-custom-id="${seId}"] .palette-item`).click();
    await p.locator('[data-cw-edit-code]').click();
    const d = p.locator('dialog.cwc');
    await d.locator('[data-cwc-editor] .cm-editor').waitFor();
    assert.equal(await d.locator('[data-cwc-tab="html"]').getAttribute('aria-selected'), 'true');
    assert.equal((await code(d)).trim(), sample.html.trim(), 'the widget\'s files load into the editor');
    assert.equal(await d.locator('[data-cwc-status]').getAttribute('data-status'), 'saved');
    await noOverflow(p, `${theme} 390 code`);
    await axe(p, `${theme} 390 code`);
    await shot(p, `edit-${theme}-390`);
    await d.locator('[data-cwc-tab="manifest"]').click();
    await d.locator('[data-cwc-no-manifest]').waitFor();
    await d.locator('[data-cwc-add-manifest]').click();
    const manifest = JSON.parse(await code(d));
    assert.deepEqual([manifest.engine, manifest.api, manifest.name, 'inferred' in manifest], ['streamelements', 1, 'Sample chat', false]);
    assert.equal(await d.locator('[data-cwc-status]').getAttribute('data-status'), 'unsaved');
    await p.waitForTimeout(700); // the new widget.json restarts the preview once typing settles
    await d.locator('[data-cwc-pane="preview"]').click();
    await d.locator('app-overlay-custom-widget [data-custom-frame="running"]').waitFor();
    assert.equal(await d.locator('[data-cwc-editor]').isVisible(), false, 'phones show one pane at a time');
    await d.locator('[data-cwc-chat="subscriber"]').click();
    await d.frameLocator('app-overlay-custom-widget iframe').locator('.row').first().waitFor();
    await noOverflow(p, `${theme} 390 preview`);
    await axe(p, `${theme} 390 preview`);
    await shot(p, `preview-${theme}-390`);
    if (theme === 'dark') {
      await p.setViewportSize({ width: 1280, height: 900 });
      await noOverflow(p, 'dark 1280 edit');
      await axe(p, 'dark 1280 edit');
      await shot(p, 'edit-dark-1280');
    }
    await ctx.close();
  }
  console.log('PASS edit code: an imported StreamElements widget loads, widget.json can be added from what Studio inferred; phone Code/Preview, axe clean dark/light 390 and 1280.');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
