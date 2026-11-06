/**
 * Overlay Studio custom widget code editor, against an isolated site preview/candidate with every API mocked:
 *  - "New widget": name + Dima SDK starter → editor (CodeMirror) with a live preview of the unsaved code; test chat and
 *    alerts and the starter's `shout` command signal reach only the preview; editing CSS updates the preview; broken fields JSON shows a blocking problem on its
 *    tab (with the line), keeps the last good preview and blocks saving; "Create widget" posts the files and adds a layer
 *  - saving again sends the base revision; version history lists both and "Open" loads an older version as unsaved
 *  - unsaved work survives a reload (restored banner, discard); a stale save is refused and can be saved anyway
 *  - Escape inside the code doesn't close the dialog; Escape elsewhere does
 *  - "Edit code" on an imported StreamElements widget: files load, no widget.json → "Add widget.json" writes one
 *  - phones: Code / Preview switch; axe (wcag2a/2aa/21aa) and no horizontal overflow at 390 and 1280, dark and light
 *  - live status: a published overlay with a custom widget reads "All changes published"; saving new code turns it to
 *    "not live in OBS yet" at once (even when asking the API again fails) until it is published again; code saved in
 *    another tab shows up when the Studio comes back into view
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
// The kit's zip format and the TypeScript compiler (to prove the typings work as an editor would use them).
const zipModule = `/tmp/custom-widget-zip-${process.pid}.mjs`;
createRequire(`${repo}/dimabot/package.json`)('esbuild').buildSync({ entryPoints: [`${repo}/dimasite/src/app/features/overlays/custom-widget-zip.ts`], format: 'esm', platform: 'neutral', outfile: zipModule, logLevel: 'error' });
const { readZip, writeZip } = await import(zipModule);
const ts = createRequire(`${repo}/dimasite/package.json`)('typescript');
const api = 'https://api.domdimabot.com', errors = [];
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const shot = async (page, name) => { if (!shots) return; await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/custom-widgets-code-${name}.png` }); };
const until = async (fn, label, tries = 120) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out: ' + label); };

const parts = ['html', 'css', 'js', 'fields', 'data'];
const sample = Object.fromEntries(await Promise.all(parts.map(async part => [part, await readFile(`${fixtures}/${part}.txt`, 'utf8')])));
const user = { id: '533538623', login: 'customfixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: false, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const seId = 'a1'.repeat(12);
const { liveMap, withLive } = await import(`${repo}/ops/checks/overlay-studio-live-fixture.mjs`);

/** Mock API with real file storage per widget and revision (create, replace with baseRevision, files, history). */
function mocks({ theme = 'dark', withSample = false } = {}) {
  const world = { widgets: [], code: new Map(), creates: [], replaces: [], renames: [], state: { schemaVersion: 1, revision: 0, designs: [],
    scenes: [{ id: 'main', name: 'Main overlay', publicId: 'e'.repeat(48), width: 1920, height: 1080, revision: 0, widgets: [], waitFor: [] }] } };
  const viewOf = (id, name) => {
    const entry = world.code.get(id), files = entry.files[entry.revision], pkg = readPackage(files);
    return { id, name, engine: pkg.manifest.engine, revision: entry.revision, fields: pkg.fields, data: pkg.data, externalMedia: pkg.externalMedia, manifest: pkg.manifest, media: {},
      files: Object.fromEntries(parts.map(part => [part, { bytes: files[part].length, sha256: 'f'.repeat(64) }])), createdAt: '', updatedAt: '', usedIn: [],
      history: Object.keys(entry.files).map(Number).sort((a, b) => b - a).map(revision => ({ revision, createdAt: new Date(Date.UTC(2026, 10, 5, 10, revision)).toISOString(), published: false })) };
  };
  const store = (id, name, files) => { world.code.set(id, { revision: 1, name, files: { 1: files } }); world.widgets.push(viewOf(id, name)); };
  /** Like the API: the published copy pins each custom layer to its widget's current revision. */
  const publishCopy = scene => structuredClone({ width: scene.width, height: scene.height, waitFor: scene.waitFor, designs: [],
    widgets: scene.widgets.map(w => w.kind === 'custom' ? { ...w, config: { ...w.config, revision: world.code.get(w.config.widgetId).revision } } : w) });
  if (withSample) store(seId, 'Sample chat', { ...sample });
  return { world, viewOf, publishCopy, async install(context) {
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
      } else if (/\/custom-widgets\/[a-f0-9]{24}$/.test(path) && req.method() === 'PATCH') {
        const id = path.split('/').at(-1), entry = world.code.get(id), body = req.postDataJSON(); world.renames.push(body);
        entry.name = body.name.trim(); const next = viewOf(id, entry.name); world.widgets = world.widgets.map(w => w.id === id ? next : w); data = next;
      } else if (files && req.method() === 'PUT') {
        const body = req.postDataJSON(), entry = world.code.get(files[1]); world.replaces.push(body);
        if (body.baseRevision !== undefined && body.baseRevision !== entry.revision) return route.fulfill({ status: 409, json: { error: true, status: 409, code: 'stale', message: `This widget changed since you opened it (now version ${entry.revision})` } });
        entry.revision++; entry.files[entry.revision] = body.files;
        const next = viewOf(files[1], entry.name); world.widgets = world.widgets.map(w => w.id === next.id ? next : w); data = { widget: next, issues: [] };
      } else if (file) {
        const entry = world.code.get(file[1]), revision = Number(url.searchParams.get('revision') ?? entry.revision), text = entry.files[revision]?.[file[2]];
        if (file[2] === 'manifest' && world.failManifest) return route.fulfill({ status: 500, json: { error: true, status: 500, message: 'Storage unavailable' } });
        if (world.slowRevision === revision && url.searchParams.has('revision')) await new Promise(resolve => setTimeout(resolve, 1500));
        return text ? route.fulfill({ status: 200, contentType: 'text/plain', body: text }) : route.fulfill({ status: 404, json: { error: true, status: 404, message: 'Not found' } });
      } else if (/\/custom-widgets\/[a-f0-9]{24}\/bundle$/.test(path)) {
        const id = path.split('/').at(-2), entry = world.code.get(id), src = entry.files[entry.revision], pkg = readPackage(src);
        data = { widgetId: id, revision: entry.revision, engine: pkg.manifest.engine, manifest: pkg.manifest, html: src.html, css: src.css, js: src.js, fields: pkg.fields, data: pkg.data, media: {}, channel: { id: user.id, login: user.login, name: user.display_name } };
      } else if (path === `${list}/session`) data = { data: {}, recents: [] };
      else if (path.startsWith(`${list}/store/`)) data = { value: null };
      else if (path.startsWith(`${list}/counters/`)) data = { value: 0 };
      else if (path === `/overlay-studio/${user.id}`) {
        if (req.method() === 'PUT') { world.state = structuredClone(req.postDataJSON()); world.state.revision++; }
        data = withLive(structuredClone(world.state), publishCopy);
      } else if (path === `/overlay-studio/${user.id}/live`) {
        world.liveReads = (world.liveReads ?? 0) + 1;
        if (world.failLive) return route.fulfill({ status: 503, json: { error: true, status: 503, message: 'Unavailable' } });
        data = { revision: world.state.revision, live: liveMap(world.state, publishCopy) };
      }
      else if (path === `/overlay-studio/${user.id}/scenes/main/publish`) {
        const scene = world.state.scenes[0]; scene.published = publishCopy(scene); scene.revision++; world.state.revision++;
        data = withLive(structuredClone(world.state), publishCopy);
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

/** Downloads the kit from the open editor, unpacks it and returns its folder and file names. */
async function downloadKit(page, dialog) {
  if (!(await dialog.locator('[data-cwc-kit]').evaluate(d => d.open))) await dialog.locator('[data-cwc-kit] summary').click();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('[data-cwc-kit-download]').click()]);
  const dir = await mkdtemp('/tmp/cw-kit-'), zipPath = join(dir, 'kit.zip');
  await download.saveAs(zipPath);
  const entries = await readZip((await readFile(zipPath)).buffer);
  for (const entry of entries) { await mkdir(dirname(join(dir, 'out', entry.name)), { recursive: true }); await writeFile(join(dir, 'out', entry.name), entry.data); }
  const root = join(dir, 'out', entries[0].name.split('/')[0]);
  return { dir, root, names: entries.map(entry => entry.name.split('/').slice(1).join('/')), suggested: download.suggestedFilename() };
}
/** TypeScript errors in a kit folder, using its own jsconfig.json (what VS Code would show). */
function typeErrors(root) {
  const config = ts.readConfigFile(join(root, 'jsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map(d => `${d.file ? d.file.fileName.split('/').pop() : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}
const popup = page => page.locator('.cm-tooltip-autocomplete .cm-completionLabel').allTextContents();

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
  // The starter declares a `shout` command signal: the preview's signal test shows the value in the banner.
  const signalTest = dialog.locator('[data-cwc-signal]');
  await signalTest.locator('[data-cwc-signal-name="shout"]').click();
  await signalTest.locator('[data-cwc-signal-value]').fill('<b>hi</b> chat');
  await signalTest.locator('[data-cwc-signal-send]').click();
  await until(async () => (await frame.locator('#banner').textContent()) === '<b>hi</b> chat', 'shout banner (text, never HTML)');
  await signalTest.locator('[data-cwc-signal-input]').fill('Bad.Name'); await signalTest.locator('[data-cwc-signal-send]').click();
  await signalTest.locator('[role="alert"]').waitFor();
  assert.equal(await page.locator('app-overlay-scene-renderer app-overlay-custom-widget').count(), 0, 'nothing on the canvas yet');
  console.log('PASS new widget: Dima starter in CodeMirror, live preview runs it, test chat, alerts and its command signal reach the preview.');

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
  assert.match((await page.locator('.layer-row .layer').allTextContents()).join('|'), /Code test/, 'the new layer is named after the widget');
  // Studio's own shortcuts stay off while the editor is open (Delete would remove the selected layer).
  await dialog.locator('[data-cwc-tab="html"]').focus();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.widget[data-kind="custom"]').count(), 1, 'Delete inside the editor never deletes the layer underneath');
  await dialog.locator('[data-cwc-tab="js"]').click();
  // Rename: Escape cancels (the editor stays open), an empty name is refused, Enter saves; widget.json and the layer follow.
  await dialog.locator('[data-cwc-rename]').click();
  const renameInput = dialog.locator('[data-cwc-rename-input]');
  assert.equal(await renameInput.evaluate(input => document.activeElement === input && input.selectionEnd - input.selectionStart === input.value.length), true, 'the field opens focused and selected');
  await renameInput.fill('Nope');
  await page.keyboard.press('Escape');
  await dialog.locator('[data-cwc-rename]').waitFor();
  assert.equal(await dialog.isVisible(), true, 'Escape in the rename field keeps the editor open');
  assert.match(await dialog.locator('#cwc-title').textContent(), /Code test/);
  await dialog.locator('[data-cwc-rename]').click();
  await renameInput.fill('   ');
  await page.keyboard.press('Enter');
  await dialog.locator('[data-cwc-rename-error]').waitFor();
  assert.equal(await renameInput.getAttribute('aria-invalid'), 'true');
  await shot(page, 'rename-dark-1280');
  await axe(page, 'rename');
  await renameInput.fill('Chat box');
  await page.keyboard.press('Enter');
  await until(async () => /Code · Chat box/.test(await dialog.locator('#cwc-title').textContent()), 'renamed title');
  assert.deepEqual(m.world.renames, [{ name: 'Chat box' }]);
  await dialog.locator('[data-cwc-manifest-renamed]').waitFor();
  await dialog.locator('[data-cwc-tab="manifest"]').click();
  assert.equal(JSON.parse(await code(dialog)).name, 'Chat box', 'widget.json follows the new name (unsaved)');
  assert.match((await page.locator('.layer-row .layer').allTextContents()).join('|'), /Chat box/, 'the layer that showed the old name follows');
  assert.equal(await page.locator('[data-custom-widgets] .palette-item__name', { hasText: 'Chat box' }).count(), 1, 'the Add panel list shows the new name');
  await dialog.locator('[data-cwc-tab="js"]').click();
  await insertCode(dialog, '// v2\n', 'start');
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'unsaved', 'unsaved after an edit');
  await page.keyboard.press('ControlOrMeta+S');
  await until(async () => m.world.replaces.length === 1, 'Ctrl+S saves');
  assert.equal(m.world.replaces[0].baseRevision, 1);
  assert.equal(JSON.parse(m.world.replaces[0].files.manifest).name, 'Chat box', 'the renamed widget.json is saved with the code');
  await dialog.locator('[data-cwc-versions] summary').click();
  assert.deepEqual(await dialog.locator('[data-cwc-versions] li').evaluateAll(items => items.map(li => li.dataset.revision)), ['2', '1']);
  // Typing while a version loads wins over the version.
  m.world.slowRevision = 1;
  await dialog.locator('[data-cwc-version="1"]').click();
  await insertCode(dialog, '// typed\n', 'start');
  await dialog.locator('[data-cwc-version-error]').waitFor();
  assert.match(await code(dialog), /^\/\/ typed/, 'the edit made while loading is kept');
  m.world.slowRevision = null;
  await dialog.locator('[data-cwc-version="1"]').click();
  await dialog.locator('[data-cwc-opened]').waitFor();
  assert.doesNotMatch(await code(dialog), /^\/\/ (v2|typed)/, 'version 1 is in the editor');
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'unsaved', 'an opened version is unsaved');
  await dialog.locator('[data-cwc-discard]').click();
  await until(async () => /^\/\/ v2/.test(await code(dialog)), 'discard goes back to the saved version');
  // Saving an opened version makes it the newest one.
  await dialog.locator('[data-cwc-version="1"]').click();
  await dialog.locator('[data-cwc-opened]').waitFor();
  await dialog.locator('[data-cwc-save]').click();
  await until(async () => m.world.replaces.length === 2, 'opened version saved');
  assert.deepEqual([m.world.replaces[1].baseRevision, /^\/\/ v2/.test(m.world.replaces[1].files.js)], [2, false]);
  await until(async () => (await dialog.locator('[data-cwc-versions] li').evaluateAll(items => items.map(li => li.dataset.revision))).join() === '3,2,1', 'history shows the new version');
  console.log('PASS saving: "Create widget" posts the files; Delete never reaches the canvas; rename (Escape cancels, empty refused, widget.json + layer follow); later saves send the base revision (Ctrl+S); versions open as unsaved changes, lose to typing while loading, and save as the newest.');

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
  // Closing right after typing keeps that text (no waiting for the autosave pause).
  await insertCode(dialog, '<p class="draft">draft</p>\n', 'start');
  await dialog.locator('[data-cwc-reload]').focus(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await page.locator('[data-cw-edit-code]').click();
  await dialog.locator('[data-cwc-draft]').waitFor();
  await dialog.locator('[data-cwc-tab="html"]').click();
  assert.match(await code(dialog), /class="draft"/, 'the draft is restored after closing straight away');
  // So does reloading right after typing.
  await insertCode(dialog, '<p class="draft2">again</p>\n', 'start');
  await page.reload(); await page.locator('.stage').waitFor();
  // Studio wasn't saved, so place the widget again from the Add panel.
  const createdId = [...m.world.code.keys()].at(-1);
  await page.locator(`[data-custom-id="${createdId}"] .palette-item`).click();
  await page.locator('[data-cw-edit-code]').click();
  await dialog.locator('[data-cwc-draft]').waitFor();
  assert.equal(await dialog.locator('[data-cwc-status]').getAttribute('data-status'), 'unsaved');
  await dialog.locator('[data-cwc-tab="html"]').click();
  assert.match(await code(dialog), /class="draft2"[\s\S]*class="draft"/, 'the draft is restored after a reload');
  const entry = m.world.code.get(createdId);
  entry.revision++; entry.files[entry.revision] = entry.files[entry.revision - 1]; // changed in another tab
  await dialog.locator('[data-cwc-save]').click();
  await dialog.locator('[data-cwc-stale]').waitFor();
  await dialog.locator('[data-cwc-save-anyway]').click();
  await until(async () => (await dialog.locator('[data-cwc-status]').getAttribute('data-status')) === 'saved', 'saved anyway');
  assert.equal(m.world.replaces.at(-1).baseRevision, undefined, 'save anyway skips the check');
  // A draft made on an older version waits for "Open them" / "Discard", even across closing the editor.
  await dialog.locator('[data-cwc-tab="html"]').click();
  await insertCode(dialog, '<p class="older">older</p>\n', 'start');
  await dialog.locator('[data-cwc-reload]').focus(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  entry.revision++; entry.files[entry.revision] = entry.files[entry.revision - 1]; // saved somewhere else meanwhile
  m.world.widgets = m.world.widgets.map(w => w.id === createdId ? m.viewOf(createdId, entry.name) : w);
  await page.reload(); await page.locator('.stage').waitFor();
  await page.locator(`[data-custom-id="${createdId}"] .palette-item`).click();
  await page.locator('[data-cw-edit-code]').click();
  await dialog.locator('[data-cwc-draft-open]').waitFor();
  await page.waitForTimeout(800);
  await dialog.locator('[data-cwc-reload]').focus(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await page.locator('[data-cw-edit-code]').click();
  await dialog.locator('[data-cwc-draft-open]').click();
  await dialog.locator('[data-cwc-tab="html"]').click();
  assert.match(await code(dialog), /class="older"/, 'the older draft survived closing without a decision');
  console.log('PASS drafts and conflicts: drafts survive closing or reloading right after typing and waiting decisions; a stale save is refused, then saved anyway.');
  await dialog.locator('[data-cwc-discard]').click();
  await dialog.locator('[data-cwc-reload]').focus(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await context.close();

  // 3. Suggestions (typing, handler types, hover) and the own-editor kit (typings checked by TypeScript, load back).
  for (const starter of ['dima', 'streamelements']) {
    const km = mocks(), kctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
    await km.install(kctx);
    const kp = await kctx.newPage(); kp.setDefaultTimeout(15000); kp.on('pageerror', e => errors.push(e.message));
    await kp.goto(`${base}/${user.login}/modules/overlays`); await kp.locator('.stage').waitFor();
    await kp.locator('[data-custom-new]').click();
    const kd = kp.locator('dialog.cwc');
    await kd.locator(`[data-cwc-starter="${starter}"]`).check();
    await kd.locator('[data-cwc-start]').click();
    await kd.locator('[data-cwc-editor] .cm-editor').waitFor();
    if (starter === 'dima') {
      await kd.locator('[data-cwc-editor] .cm-content').click();
      await kp.keyboard.press('ControlOrMeta+End');
      await kp.keyboard.type('\nDima.');
      await until(async () => { const list = await popup(kp); return ['on', 'fields', 'storage', 'ready'].every(label => list.includes(label)); }, 'Dima. suggestions');
      await shot(kp, 'suggest-dark-1280');
      await kp.keyboard.press('Escape');
      await until(async () => (await kp.locator('.cm-tooltip-autocomplete').count()) === 0, 'Escape closes the suggestions');
      assert.equal(await kd.isVisible(), true, 'and keeps the editor open');
      await kp.keyboard.type("fields.");
      await until(async () => (await popup(kp)).includes('accentColor'), 'settings after Dima.fields.');
      // Accepting a suggestion inserts it.
      await kp.keyboard.type('maxM');
      await until(async () => (await popup(kp))[0] === 'maxMessages', 'filtered to maxMessages');
      await kp.keyboard.press('Enter');
      await until(async () => /Dima\.fields\.maxMessages$/.test((await code(kd)).trimEnd()), 'accepted suggestion');
      await kp.keyboard.type(";\nDima.on('alert', a => a.");
      await until(async () => { const list = await popup(kp); return ['amount', 'user', 'tier'].every(label => list.includes(label)); }, 'alert handler parameter');
      await kp.keyboard.type('user.');
      await until(async () => (await popup(kp)).includes('name'), 'nested user');
      await kp.keyboard.press('Escape');
      // Hover docs.
      await kp.keyboard.type('name);\nconst saved = Dima.storage;'); // a reference only: the preview runs this code
      const box = await kd.locator('.cm-content').evaluate(content => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent.indexOf('storage'); if (at < 0) continue;
          const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 7);
          const r = range.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      });
      assert(box, 'found the word to hover');
      await kp.mouse.move(box.x, box.y);
      await until(async () => /storage: DimaStorage/.test(await kd.locator('.cm-dima-hover').textContent().catch(() => '')), 'hover doc');
      await shot(kp, 'hover-dark-1280');
      await axe(kp, 'suggestions and hover');
      console.log('PASS suggestions: Dima members, settings (accepted with Enter), handler parameter types (alert → user → name), Escape closes only the list, hover docs.');
    }
    // The kit: real names, typings that TypeScript accepts for the starter, and a typo that it catches.
    const kit = await downloadKit(kp, kd);
    assert.equal(kit.suggested, 'My widget.zip', 'named after the widget');
    assert.deepEqual(kit.names.sort(), ['.vscode/fields.schema.json', '.vscode/settings.json', '.vscode/widget.schema.json', 'README.md', 'data.json', 'dima.d.ts', 'fields.json', 'jsconfig.json',
      'widget.css', 'widget.html', 'widget.ini', 'widget.js', ...(starter === 'dima' ? ['widget.json'] : [])].sort());
    // The Dima starter got a typed line above (with the user's typing); both starters must type-check cleanly.
    assert.deepEqual(typeErrors(kit.root), [], `${starter} kit type-checks`);
    if (starter === 'streamelements') assert.match(await readFile(join(kit.root, 'dima.d.ts'), 'utf8'), /declare const SE_API: SEApi;/);
    await writeFile(join(kit.root, 'widget.js'), (await readFile(join(kit.root, 'widget.js'), 'utf8')) + '\nDima.storage.gett("x");\n');
    assert.match(typeErrors(kit.root).join('\n'), /gett/, 'a typo in an SDK call is an error in the editor');
    // Edited elsewhere → load the zip back: the CSS change lands in the tab as an unsaved change.
    await writeFile(join(kit.root, 'widget.css'), (await readFile(join(kit.root, 'widget.css'), 'utf8')) + '\n/* from my editor */\n');
    await writeFile(join(kit.root, 'widget.js'), (await readFile(join(kit.root, 'widget.js'), 'utf8')).replace('\nDima.storage.gett("x");\n', '\n'));
    const files = [];
    for (const name of kit.names) files.push({ name: `edited/${name}`, text: await readFile(join(kit.root, name), 'utf8') });
    const edited = join(kit.dir, 'edited.zip');
    await writeFile(edited, Buffer.from(await writeZip(files).arrayBuffer()));
    await kd.locator('[data-cwc-kit-files]').setInputFiles(edited);
    await kd.locator('[data-cwc-loaded]').waitFor();
    assert.match(await kd.locator('[data-cwc-loaded]').textContent(), new RegExp(`Loaded ${starter === 'dima' ? 6 : 5} files`));
    await kd.locator('[data-cwc-tab="css"]').click();
    await until(async () => /from my editor/.test(await code(kd)), 'loaded files replace the tab');
    assert.equal(await kd.locator('[data-cwc-status]').getAttribute('data-status'), 'new');
    await rm(kit.dir, { recursive: true, force: true });
    await kctx.close();
  }
  console.log('PASS own code editor: kit with real names, typings + jsconfig that TypeScript accepts (and that catch an SDK typo), JSON schemas; edited files load back as unsaved changes.');

  // 2. Edit code of an imported StreamElements widget; phone layout, light then dark.
  for (const theme of ['light', 'dark']) {
    const sm = mocks({ theme, withSample: true }), ctx = await browser.newContext({ viewport: { width: 390, height: 860 }, reducedMotion: 'reduce', hasTouch: true });
    // Dark run: the owner blocked outside connections; the code preview must follow that choice.
    if (theme === 'dark') sm.world.widgets[0].network = 'restricted';
    await sm.install(ctx);
    const p = await ctx.newPage(); p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    await p.locator('.studio-mtabs [data-tab="add"]').click();
    await p.locator(`[data-custom-id="${seId}"] .palette-item`).click();
    const d = p.locator('dialog.cwc');
    if (theme === 'light') {
      // A widget.json that fails to load is an error, never "no widget.json" (saving would drop it).
      sm.world.failManifest = true;
      await p.locator('[data-cw-edit-code]').click();
      await d.locator('[data-cwc-load-error]').waitFor();
      assert.equal(await d.locator('[data-cwc-editor]').count(), 0, 'no editor without every file');
      await d.locator('.head .icon-button[aria-label="Close"]').click(); await d.waitFor({ state: 'detached' });
      sm.world.failManifest = false;
    }
    await p.locator('[data-cw-edit-code]').click();
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
    assert.equal((await d.locator('app-overlay-custom-widget iframe').getAttribute('csp') ?? '').includes("connect-src 'none'"), theme === 'dark',
      'the code preview runs under the owner\'s "Block outside connections" choice');
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
  console.log('PASS edit code: an imported StreamElements widget loads, widget.json can be added from what Studio inferred; phone Code/Preview (under the owner\'s outside-connection choice), axe clean dark/light 390 and 1280.');

  // 4. Live status: published with a custom widget = live (its pin is only in the published copy, VTLuciel 2026-11-06);
  // new code is not live until published again.
  {
    const lm = mocks({ withSample: true }), scene = lm.world.state.scenes[0];
    scene.widgets = [{ id: 'custom-1', kind: 'custom', configVersion: 1, name: 'Sample chat', x: 10, y: 10, width: 480, height: 640, visible: true, locked: false, config: { widgetId: seId } }];
    scene.published = lm.publishCopy(scene); scene.revision = 1; lm.world.state.revision = 1;
    const lctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await lm.install(lctx);
    const lp = await lctx.newPage(); lp.setDefaultTimeout(15000); lp.on('pageerror', e => errors.push(e.message));
    await lp.goto(`${base}/${user.login}/modules/overlays`); await lp.locator('.stage').waitFor();
    const bar = lp.locator('.lf-save-bar');
    await bar.getByText('All changes published', { exact: true }).waitFor();
    assert.equal(await lp.locator('.publish-status').count(), 0, 'no "Unpublished changes" chip');
    await lp.locator('.widget[data-kind="custom"]').first().dispatchEvent('click');
    await lp.locator('[data-cw-edit-code]').click();
    const ld = lp.locator('dialog.cwc');
    await ld.locator('[data-cwc-editor] .cm-editor').waitFor();
    await ld.locator('[data-cwc-tab="css"]').click();
    await insertCode(ld, '/* new look */\n', 'start');
    await until(async () => (await ld.locator('[data-cwc-status]').getAttribute('data-status')) === 'unsaved', 'unsaved code');
    lm.world.failLive = true; // asking the API again fails: the new code must still read as not live
    await ld.locator('[data-cwc-save]').click();
    await until(async () => lm.world.replaces.length === 1 && (await ld.locator('[data-cwc-status]').getAttribute('data-status')) === 'saved', 'code saved');
    await ld.locator('[data-cwc-reload]').focus(); await lp.keyboard.press('Escape'); await ld.waitFor({ state: 'detached' });
    await bar.getByText('Saved · not live in OBS yet', { exact: true }).waitFor();
    await lp.locator('.publish-status').waitFor();
    assert(lm.world.liveReads >= 1, 'the Studio asked the API again');
    lm.world.failLive = false;
    await lp.getByRole('button', { name: /Publish live/ }).click();
    await bar.getByText('All changes published', { exact: true }).waitFor();
    assert.equal(lm.world.state.scenes[0].published.widgets[0].config.revision, 2, 'the new code is pinned');
    // Code saved in another tab: this tab's widget list doesn't change, so it asks again when it comes back into view.
    const other = lm.world.code.get(seId); other.revision++; other.files[other.revision] = other.files[other.revision - 1];
    lm.world.widgets = lm.world.widgets.map(w => w.id === seId ? lm.viewOf(seId, other.name) : w);
    await lp.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await bar.getByText('Saved · not live in OBS yet', { exact: true }).waitFor();
    await lp.getByRole('button', { name: /Publish live/ }).click();
    await bar.getByText('All changes published', { exact: true }).waitFor();
    assert.equal(lm.world.state.scenes[0].published.widgets[0].config.revision, 3);
    await lctx.close();
  }
  console.log('PASS live status: a published overlay with a custom widget is live; new code turns it to "not live in OBS yet" (even if asking again fails) until published again; another tab\'s code shows up on return.');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
