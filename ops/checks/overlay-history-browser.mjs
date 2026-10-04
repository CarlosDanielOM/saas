import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', publicId = 'b'.repeat(48);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [], mutations = [];
const user = { id: '990083', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const tts = { id: 'tts-1', kind: 'tts', x: 100, y: 100, width: 400, height: 150, visible: true, locked: false };
const alert = { id: 'alert-1', kind: 'alert', x: 900, y: 200, width: 600, height: 180, visible: true, locked: false, designId: 'starter', events: ['follow'] };
const text = { id: 'text-1', kind: 'text', x: 100, y: 70, width: 400, height: 100, visible: true, locked: false, text: '$(user)', color: '#ffffff', fontSize: 30 };
const design = { id: 'starter', name: 'Alerts', revision: 1, width: 800, height: 240, events: Object.fromEntries(['follow', 'sub', 'bits', 'raid'].map(kind => [kind, { duration: 5, widgets: [structuredClone(text)] }])) };
const snapshot = { width: 1920, height: 1080, widgets: [tts, alert], waitFor: ['tts', 'follow'], designs: [design] };
const initial = { schemaVersion: 1, revision: 1, scenes: [{ id: 'main', name: 'Main', publicId, revision: 1, ...snapshot, published: snapshot }, { id: 'second', name: 'Second', publicId: 'c'.repeat(48), revision: 0, width: 1920, height: 1080, widgets: [], waitFor: [] }], designs: [design] };
let state = structuredClone(initial), failSave = false, failLoad = false, deferSave = null, serial = 0;
const clones = value => structuredClone(value);
async function until(predicate, label) { for (let i = 0; i < 160; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error(label); }
async function eventually(method, read, expected, message) {
  let value;
  try { await until(async () => { value = await read(); try { assert[method](value, expected); return true; } catch { return false; } }, message || `${method}: expected ${JSON.stringify(expected)}`); } catch { assert[method](value, expected, message || `UI ${method}`); }
  assert[method](value, expected, message || `UI ${method}`);
}
async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(({ user, app }) => { localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); localStorage.setItem('dimasite.language', 'en'); }, { user, app });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = req.postDataJSON().texts.map(t => t.replaceAll('$(user)', 'Luna'));
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 0, needsRefresh: 0, events: [] };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'GET' && failLoad) return route.fulfill({ status: 503, json: { error: true, message: 'Fixture load unavailable' } });
      if (req.method() === 'PUT') {
        const body = req.postDataJSON(); mutations.push(clones(body));
        if (deferSave) await new Promise(resolve => { deferSave.resolve = resolve; });
        if (failSave) return route.fulfill({ status: 409, json: { error: true, message: 'Fixture conflict' } });
        assert.equal(body.revision, state.revision, 'undo/redo must keep the latest server revision');
        const previous = state;
        state = { ...body, revision: state.revision + 1,
          scenes: body.scenes.map(scene => { const old = previous.scenes.find(s => s.id === scene.id); return { ...scene, publicId: old?.publicId ?? (++serial).toString(16).padStart(48, 'a'), revision: old?.revision ?? 0, published: old?.published }; }),
          designs: body.designs.map(d => ({ ...d, revision: (previous.designs.find(old => old.id === d.id)?.revision ?? 0) + 1 })) };
      }
      data = state;
    } else if (url.pathname.includes('/scenes/')) {
      const body = req.postDataJSON(); assert.equal(body.revision, state.revision);
      const id = url.pathname.split('/scenes/')[1].split('/')[0];
      const scene = state.scenes.find(s => s.id === id);
      if (url.pathname.endsWith('/rotate')) scene.publicId = 'd'.repeat(48);
      else { scene.revision++; scene.published = { width: scene.width, height: scene.height, widgets: clones(scene.widgets), waitFor: clones(scene.waitFor), designs: clones(state.designs) }; }
      state.revision++; data = state;
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
  return { context, page };
}
try {
  const { context, page } = await fixture();
  const toolbar = page.locator('.history-toolbar');
  const undo = toolbar.getByRole('button', { name: 'Undo', exact: true });
  const redo = toolbar.getByRole('button', { name: 'Redo', exact: true });
  const props = page.locator('.properties');
  const openDetails = selector => page.locator(selector).evaluate(d => { d.open = true; });
  const openExact = () => openDetails('.properties details.exact');
  const openSettings = () => openDetails('.publish-settings');
  const sceneValue = () => page.locator('.scene-tab[aria-pressed="true"]').getAttribute('data-id');
  const sceneCount = () => page.locator('.scene-tab[data-id]').count();
  const toggleLanguage = async () => { await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn').click()); await page.locator('.auth-navbar__dropdown-item .auth-navbar__lang-icon').first().waitFor({ state: 'attached' }); await page.evaluate(() => document.querySelector('.auth-navbar__dropdown-item .auth-navbar__lang-icon').closest('button').click()); };
  const toggleTheme = async () => { await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn').click()); await page.locator('.auth-navbar__dropdown-item .auth-navbar__theme-icon').first().waitFor({ state: 'attached' }); await page.evaluate(() => document.querySelector('.auth-navbar__dropdown-item .auth-navbar__theme-icon').closest('button').click()); };
  const dimensions = key => props.getByLabel(key, { exact: true });
  const widgetIds = () => page.locator('.layers .layer').evaluateAll(els => els.map(el => el.textContent.trim()));
  const selectTts = () => page.locator('.layers').getByRole('button', { name: 'Text to speech', exact: true }).click();
  const save = async () => { const response = page.waitForResponse(r => r.url() === api + '/overlay-studio/' + user.id && r.request().method() === 'PUT'); await page.locator('.lf-save-bar .save-button').click(); await response; await until(() => page.locator('.editor-fields').isEnabled(), 'save finished'); };
  const originalPublished = clones(state.scenes[0].published);
  await eventually('equal', async () => await undo.isDisabled(), true); await eventually('equal', async () => await redo.isDisabled(), true);
  await selectTts(); await openExact();
  await props.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await until(async () => await page.locator('.layers .layer').count() === 3, 'duplicate reflected in DOM; errors: ' + JSON.stringify(errors));
  await undo.click(); await eventually('equal', async () => await page.locator('.layers .layer').count(), 2);
  await redo.click(); await eventually('equal', async () => await page.locator('.layers .layer').count(), 3);
  await props.getByRole('button', { name: 'Delete', exact: true }).click();
  await undo.click(); await eventually('equal', async () => await page.locator('.layers .layer').count(), 3);
  await undo.click(); await eventually('equal', async () => await page.locator('.layers .layer').count(), 2);
  await dimensions('X').fill('333'); await undo.click(); await eventually('equal', async () => await dimensions('X').inputValue(), '100');
  await redo.click(); await eventually('equal', async () => await dimensions('X').inputValue(), '333');
  await undo.click();
  await props.getByRole('switch', { name: 'Lock position', exact: true }).click();
  await eventually('equal', async () => await redo.isDisabled(), true, 'a new edit clears the redo branch');
  await undo.click(); await eventually('equal', async () => await props.getByRole('switch', { name: 'Lock position', exact: true }).isChecked(), false);
  await props.getByRole('switch', { name: 'Show on stream', exact: true }).click();
  await eventually('equal', async () => await page.locator('.widget[data-kind="tts"]').count(), 0);
  await undo.click(); await eventually('equal', async () => await page.locator('.widget[data-kind="tts"]').count(), 1);
  const beforeOrder = await widgetIds();
  await props.getByRole('button', { name: 'Bring forward', exact: true }).click(); await eventually('notDeepEqual', async () => await widgetIds(), beforeOrder);
  await undo.click(); await eventually('deepEqual', async () => await widgetIds(), beforeOrder);
  // Many move/resize events are one command, including pointer cancellation.
  const stage = page.locator('.stage'), target = page.locator('.widget[data-kind="tts"]');
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 30, { steps: 12 }); await page.mouse.up();
  await eventually('notEqual', async () => await dimensions('X').inputValue(), '100');
  await undo.click(); await eventually('equal', async () => await dimensions('X').inputValue(), '100'); await eventually('equal', async () => await dimensions('Y').inputValue(), '100');
  const handle = await target.locator('.resize-handle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + 55, handle.y + 25, { steps: 10 }); await page.mouse.up();
  await eventually('notEqual', async () => await dimensions('W').inputValue(), '400'); await undo.click(); await eventually('equal', async () => await dimensions('W').inputValue(), '400');
  await target.focus(); await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight'); await page.keyboard.up('ArrowRight');
  await eventually('equal', async () => await dimensions('X').inputValue(), '130');
  await page.keyboard.press('Control+z'); await eventually('equal', async () => await dimensions('X').inputValue(), '100');
  await target.focus(); await page.keyboard.press('Control+Shift+z'); await eventually('equal', async () => await dimensions('X').inputValue(), '130');
  await target.focus(); await page.keyboard.press('Meta+z'); await eventually('equal', async () => await dimensions('X').inputValue(), '100');
  await target.focus(); await page.keyboard.press('Control+y'); await eventually('equal', async () => await dimensions('X').inputValue(), '130');
  await undo.click();
  // Wait for undo to render before testing an unchanged input; filling the stale value can create a new edit.
  await eventually('equal', async () => await dimensions('X').inputValue(), '100');
  await eventually('equal', async () => await redo.isEnabled(), true);
  // An unchanged dimension is a no-op and must preserve redo.
  await dimensions('X').fill('100'); await target.focus(); await eventually('equal', async () => await redo.isEnabled(), true);
  const name = page.locator('.name-field input');
  await name.fill('Main'); await name.press('End'); await name.pressSequentially(' native');
  await name.press('Control+z'); await eventually('equal', async () => await page.locator('.layers .layer').count(), 2, 'input shortcuts must not undo canvas commands');
  await name.fill('Renamed'); await name.pressSequentially(' overlay');
  await undo.click(); await eventually('equal', async () => await name.inputValue(), 'Main', 'one focused typing session is one undo step');
  await openSettings(); const width = page.getByLabel('Canvas width', { exact: true });
  await width.fill('1600'); await undo.click(); await eventually('equal', async () => await width.inputValue(), '1920'); await redo.click(); await eventually('equal', async () => await width.inputValue(), '1600');
  await save(); assert.equal(state.scenes[0].width, 1600);
  const afterSave = state.revision;
  await undo.click(); await eventually('equal', async () => await width.inputValue(), '1920');
  assert.deepEqual(state.scenes[0].published, originalPublished, 'undo never publishes');
  await save(); assert.equal(state.revision, afterSave + 1); assert.equal(state.scenes[0].width, 1920);
  await redo.click(); await save(); assert.equal(state.scenes[0].width, 1600);
  // Publish and rotate mutate server metadata; history must preserve their latest values.
  const publishResponse = page.waitForResponse(r => r.url().endsWith('/publish'));
  await page.locator('.publish-button').click(); await publishResponse; await page.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor(); await until(() => page.locator('.editor-fields').isEnabled(), 'published');
  const publication = clones(state.scenes[0].published), publishedRevision = state.scenes[0].revision;
  await openSettings();
  await page.getByRole('button', { name: 'Replace overlay URL', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, invalidate the previous URL', exact: true }).click();
  await until(() => state.scenes[0].publicId === 'd'.repeat(48), 'rotated');
  await until(() => page.locator('.editor-fields').isEnabled(), 'rotation finished');
  const mutationCount = mutations.length;
  await undo.click(); await eventually('equal', async () => await width.inputValue(), '1920');
  assert.equal(mutations.length, mutationCount, 'undo only changes local draft state');
  await save(); assert.equal(state.scenes[0].publicId, 'd'.repeat(48)); assert.equal(state.scenes[0].revision, publishedRevision); assert.deepEqual(state.scenes[0].published, publication);
  assert.equal(mutations.at(-1).scenes[0].publicId, 'd'.repeat(48), 'history preserves the latest local OBS URL');
  assert.equal(mutations.at(-1).scenes[0].revision, publishedRevision, 'history preserves the latest local published revision');
  assert.deepEqual(mutations.at(-1).scenes[0].published, publication, 'history never restores an older local publication');
  await redo.click();
  // Scene creation/deletion are reversible, even when deletion was already saved.
  await page.getByRole('button', { name: 'New overlay', exact: true }).click(); await eventually('equal', async () => await sceneCount(), 3);
  await undo.click(); await eventually('equal', async () => await sceneValue(), 'main');
  await redo.click(); await save(); const newSceneId = await sceneValue();
  await page.getByRole('button', { name: 'Delete this overlay', exact: true }).click(); const deleteResponse = page.waitForResponse(r => r.url() === api + '/overlay-studio/' + user.id && r.request().method() === 'PUT'); await page.getByRole('button', { name: 'Yes, delete this overlay and its URL', exact: true }).click(); await deleteResponse;
  await until(() => page.locator('.editor-fields').isEnabled(), 'scene deleted'); assert(!state.scenes.some(s => s.id === newSceneId));
  await undo.click(); await eventually('equal', async () => await sceneValue(), newSceneId);
  await eventually('equal', async () => await page.locator('.url-row code').textContent(), 'Save this overlay to create its URL.');
  await save(); assert(state.scenes.some(s => s.id === newSceneId));
  await page.locator('.scene-tab[data-id="main"]').click();
  await page.locator('.layers').getByRole('button', { name: 'Alerts', exact: true }).click();
  await props.getByRole('button', { name: 'Edit design', exact: true }).click();
  const textInput = props.getByLabel('Text template', { exact: true }); await textInput.fill('Hello $(user)');
  await undo.click(); await eventually('equal', async () => await textInput.inputValue(), '$(user)'); await redo.click(); await eventually('equal', async () => await textInput.inputValue(), 'Hello $(user)');
  await page.locator('.design-event-tabs').getByRole('button', { name: 'Bits', exact: true }).click();
  const duration = page.getByLabel('Duration (seconds)', { exact: true }); await duration.fill('12'); await undo.click(); await eventually('equal', async () => await duration.inputValue(), '5');
  await redo.click(); await save(); assert.equal(state.designs[0].events.bits.duration, 12);
  await undo.click(); await eventually('equal', async () => await duration.inputValue(), '5'); await save(); assert.equal(state.designs[0].events.bits.duration, 5);
  // A design copy is one undo operation; shared design revisions continue forward.
  const copyResponse = page.waitForResponse(r => r.url() === api + '/overlay-studio/' + user.id && r.request().method() === 'PUT'); await openSettings(); await page.getByRole('button', { name: 'Save as a new design', exact: true }).click(); await copyResponse; await until(() => page.locator('.editor-fields').isEnabled(), 'copy saved');
  assert.equal(state.designs.length, 2); await undo.click(); await save(); assert.equal(state.designs.length, 1);
  await page.getByRole('button', { name: 'Save & back to overlay', exact: true }).click(); await until(() => page.locator('.scene-tabs').isVisible(), 'back to scene');
  // Save failure leaves history/recovery intact; no edits while a save is in flight.
  await selectTts(); await dimensions('X').fill('250'); failSave = true; await save(); failSave = false;
  await eventually('equal', async () => await undo.isEnabled(), true); await undo.click(); await eventually('equal', async () => await dimensions('X').inputValue(), '100');
  await redo.click(); deferSave = {};
  const pending = save(); await until(() => !!deferSave.resolve, 'save held'); await eventually('equal', async () => await undo.isDisabled(), true); await eventually('equal', async () => await redo.isDisabled(), true);
  const duringSave = await target.getAttribute('style'); await target.dispatchEvent('keydown', { key: 'z', ctrlKey: true }); await eventually('equal', async () => await target.getAttribute('style'), duringSave);
  deferSave.resolve(); await pending; deferSave = null;
  await dimensions('X').fill('270'); await undo.click(); await eventually('equal', async () => await dimensions('X').inputValue(), '250'); await redo.click();
  await until(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('domdimabot-overlay-draft:') && JSON.parse(localStorage.getItem(key)).scenes[0].widgets[0].x === 270)), 'recovery after redo');
  page.once('dialog', d => d.accept()); await page.reload(); await page.getByRole('button', { name: 'Restore local draft', exact: true }).click();
  await eventually('equal', async () => await undo.isDisabled(), true); await eventually('equal', async () => await redo.isDisabled(), true); await selectTts(); await openExact(); await eventually('equal', async () => await dimensions('X').inputValue(), '270');
  await dimensions('X').fill('280'); await undo.click(); await eventually('equal', async () => await dimensions('X').inputValue(), '270');
  failLoad = true; page.once('dialog', d => d.accept()); await openSettings(); await page.getByRole('button', { name: 'Reload saved draft', exact: true }).click();
  await until(() => page.locator('.editor-fields').isEnabled(), 'failed reload complete'); await eventually('equal', async () => await redo.isEnabled(), true, 'failed reload preserves history'); failLoad = false;
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Reload saved draft', exact: true }).click();
  await until(() => page.locator('.editor-fields').isEnabled(), 'reload finished'); await eventually('equal', async () => await undo.isDisabled(), true); await eventually('equal', async () => await redo.isDisabled(), true);
  await selectTts(); await props.getByRole('switch', { name: 'Lock position', exact: true }).evaluate(button => { for (let i = 0; i < 110; i++) button.click(); });
  await undo.evaluate(button => { for (let i = 0; i < 100; i++) button.click(); }); await eventually('equal', async () => await undo.isDisabled(), true, 'history is bounded to 100 steps'); await eventually('equal', async () => await redo.isEnabled(), true);
  console.log('PASS editing: grouped move/resize/nudges/typing, add/delete/order/settings/designs/scenes, redo branching, shortcuts, native text undo and bounded history.');
  console.log('PASS draft protection: save/publish/rotate retain current revisions and URLs; save/reload failures and recovery preserve intended state.');
  // Responsive, keyboard-accessible controls with English/Spanish and both themes.
  for (const language of ['en', 'es']) {
    if (language === 'es') await toggleLanguage();
    for (const size of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width: size, height: 1100 });
      await eventually('equal', async () => await toolbar.getByRole('button').count(), 2);
      const layout = await toolbar.evaluate(el => ({ width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right, viewport: innerWidth, buttons: [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) }));
      assert(layout.right <= layout.viewport + 1 && layout.buttons.every(height => height >= 44));
      await page.addScriptTag({ path: process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
      const violations = await page.evaluate(async () => (await axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, [], `${language} ${size} accessibility`);
      if (process.env.SAAS_SCREENSHOT_DIR) { await mkdir(process.env.SAAS_SCREENSHOT_DIR, { recursive: true }); await toolbar.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/history-${language}-${size}.png` }); }
    }
  }
  await toggleTheme();
  await page.addScriptTag({ path: process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  await eventually('deepEqual', async () => await page.evaluate(async () => (await axe.run(document.querySelector('.history-toolbar'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => v.id)), []);
  assert.deepEqual(errors, []); await context.close();
  console.log('PASS mobile/tablet/desktop controls, EN/ES translations, themes and AXE accessibility; no uncaught browser errors.');
} catch (error) { console.log('Browser errors:', errors); throw error; } finally { await browser.close(); }
