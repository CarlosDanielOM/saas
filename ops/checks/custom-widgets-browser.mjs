/**
 * Overlay Studio custom widgets and the widget engine, against an isolated site preview/candidate with every API mocked:
 *  - the Add panel lists imported widgets only when the API says the feature is enabled
 *  - importing the sample package as a .zip (widget.ini + 5 parts): parts found, settings summary,
 *    StreamElements-hosted files warning, then the new layer is added and selected
 *  - right panel: one collapsed group per fields.txt group (+ General), hidden fields left out;
 *    editing a colour / slider / switch / dropdown stores overrides; invalid input shows an inline
 *    error and changes nothing; reset one and reset all; search opens matching groups
 *  - save + publish carry config.values; export downloads a StreamElements zip with this layer's data
 *  - the engine: the imported StreamElements sample runs in a sandboxed frame; Test drawer chat/alerts, the widget's own
 *    button and a settings change reach it; a native Dima widget gets live settings without reloading, store and counters,
 *    and logs to the widget log; the copy-files step; OBS runs published widgets and receives socket chat/alerts
 *  - command signals: the layer's Commands block (snippets aimed at the layer name, copy, "Make a command" link, skipped count),
 *    Test drawer signals reaching Dima (`signal:<name>`) and StreamElements (`dima:signal`) widgets, invalid names, OBS tests,
 *    and OBS delivering a signal only to the layers the server named
 *  - StreamElements goal widgets: a session-only widget reacts to preview test alerts (onSessionUpdate), inline
 *    onerror handlers in the HTML find functions defined in the widget's script, the "Goal data" section names the
 *    goal behind "Manual"; a .rar package imports like the .zip
 *  - live state and bot events: Dima.state('goals'|'polls') starts from the channel's real state, Test drawer bot events
 *    (TTS start/end, trigger, channel points, sample poll/goals) reach Dima and StreamElements (`dima:*`) widgets,
 *    "Replay recent chat" sends stored chat in order, the poll setup shows for widgets that use polls; in OBS a widget
 *    only gets the state it asked for
 *  - plan limit blocks the import with an upgrade prompt
 *  - axe (wcag2a/2aa/21aa) and no horizontal overflow at 320/390/1280, dark then light
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL must name an isolated preview/candidate');
const fixtures = process.env.CUSTOM_WIDGET_FIXTURES || `${process.env.SAAS_REPO || '/root/saas'}/ops/checks/custom-widget-fixtures/sample-chat`;
// Expectations come from the canonical format code (transpiled on the fly), so they match what ships.
const repo = process.env.SAAS_REPO || '/root/saas';
const formatModule = `/tmp/custom-widget-format-${process.pid}.mjs`;
createRequire(`${repo}/dimabot/package.json`)('esbuild').buildSync({ entryPoints: [`${repo}/dimabot/src/custom_widgets/format.ts`], format: 'esm', platform: 'node', outfile: formatModule, logLevel: 'error' });
const { parseFields, parseData, groupFields, resolveFieldData, readPackage } = await import(formatModule);
const api = 'https://api.domdimabot.com', publicId = 'd'.repeat(48), widgetId = 'a1'.repeat(12), errors = [];
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const shot = async (page, name) => { if (!shots) return; await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/custom-widgets-${name}.png` }); };
const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out: ' + label); };

const parts = ['html', 'css', 'js', 'fields', 'data'];
const source = Object.fromEntries(await Promise.all(parts.map(async part => [part, await readFile(`${fixtures}/${part}.txt`, 'utf8')])));
const ini = await readFile(`${fixtures}/widget.ini`, 'utf8');
const pkg = readPackage(source);
const dimaDir = fixtures.replace(/sample-chat$/, 'dima-chat');
const dimaSource = Object.fromEntries(await Promise.all(parts.map(async part => [part, await readFile(`${dimaDir}/${part}.txt`, 'utf8')])));
dimaSource.manifest = await readFile(`${dimaDir}/widget.json`, 'utf8');
const dimaPkg = readPackage(dimaSource), dimaId = 'c3'.repeat(12);
const seMedia = pkg.externalMedia.filter(item => item.host === 'cdn.streamelements.com');
// Two small widgets that react to command signals (Dima SDK and StreamElements layer).
const petId = 'e5'.repeat(12), sePetId = 'f6'.repeat(12), seGoalId = 'a7'.repeat(12);
const petSignals = [{ name: 'feed', description: 'Feed the pet', values: ['pizza', 'cake'] }, { name: 'pet', description: 'Pet it' }];
const extraWidgets = {
  [petId]: { manifest: { engine: 'dima', api: 1, name: 'Pet', uses: ['signals'], signals: petSignals }, css: 'body { color: #fff; font: 20px sans-serif; }',
    html: '<p class="food">hungry</p><p class="who"></p><p class="last"></p>',
    js: "Dima.on('signal:feed', s => { document.querySelector('.food').textContent = s.value || 'snack'; document.querySelector('.who').textContent = s.user ? s.user.name + (s.user.roles.broadcaster ? ' (broadcaster)' : '') : ''; });\n" +
      "Dima.on('signal', s => { document.querySelector('.last').textContent = s.name + ':' + s.args.length; });\n" },
  [sePetId]: { manifest: { engine: 'streamelements', api: 1, name: 'SE pet', uses: ['signals'] }, css: 'body { color: #fff; }', html: '<p class="food">hungry</p>',
    js: "window.addEventListener('onEventReceived', obj => { if (obj.detail.listener === 'dima:signal') document.querySelector('.food').textContent = obj.detail.event.name + ':' + obj.detail.event.value; });\n" }
};
// A StreamElements goal widget that only reads session data, with an early inline onerror handler.
extraWidgets[seGoalId] = { manifest: { engine: 'streamelements', api: 1, name: 'SE goal', uses: ['session'] }, css: 'body { color: #fff; }',
  html: '<p class="goal">0</p><img class="avatar" src="" alt="" onerror="markBroken(this)">',
  js: "function markBroken(img) { img.dataset.fallback = 'yes'; }\n"
    + "window.addEventListener('onWidgetLoad', obj => { document.querySelector('.goal').textContent = obj.detail.session.data['follower-session'].count; });\n"
    + "window.addEventListener('onSessionUpdate', obj => { document.querySelector('.goal').textContent = obj.detail.session['follower-session'].count; });\n" };
// Widgets that read live state and bot events (Dima SDK and StreamElements layer).
const liveId = 'b8'.repeat(12), seLiveId = 'c9'.repeat(12);
extraWidgets[liveId] = { manifest: { engine: 'dima', api: 1, name: 'Live', uses: ['chat', 'polls', 'goals', 'tts', 'triggers', 'rewards', 'pets', 'duels', 'roulette', 'dimafx'] }, css: 'body { color: #fff; }',
  html: '<p class="goals"></p><p class="polls"></p><p class="tts"></p><p class="trigger"></p><p class="reward"></p><p class="pet"></p><p class="duel"></p><p class="roulette"></p><p class="dimafx"></p><ul class="chat"></ul>',
  js: "const out = (key, value) => { document.querySelector('.' + key).textContent = value; };\n"
    + "Dima.state('goals', goals => out('goals', goals.map(goal => goal.name + ':' + goal.current).join(',')));\n"
    + "Dima.state('polls', polls => out('polls', polls.poll ? polls.poll.title + ':' + polls.poll.choices.length : 'none'));\n"
    + "Dima.on('tts', event => out('tts', event.phase + ':' + event.text + ':' + event.test));\n"
    + "Dima.on('trigger', event => out('trigger', event.name + ':' + event.mediaType));\n"
    + "Dima.on('reward', event => out('reward', event.reward.title + ':' + event.input));\n"
    + "Dima.on('pet', event => out('pet', event.phase + ':' + event.text + ':' + event.mood));\n"
    + "Dima.on('duel', event => out('duel', event.phase + ':' + event.winner));\n"
    + "Dima.on('roulette', event => out('roulette', event.phase + ':' + event.label));\n"
    + "Dima.on('dimafx', event => out('dimafx', event.item.name + ':' + event.bits + ':' + (event.user ? event.user.name : 'anonymous')));\n"
    + "Dima.on('chat', message => { const item = document.createElement('li'); item.textContent = message.user.name + ': ' + message.text; document.querySelector('.chat').append(item); });\n" };
extraWidgets[seLiveId] = { manifest: { engine: 'streamelements', api: 1, name: 'SE live', uses: ['polls', 'goals', 'tts'] }, css: 'body { color: #fff; }',
  html: '<p class="goals"></p><p class="polls"></p><p class="tts"></p>',
  js: "window.addEventListener('onEventReceived', obj => { const listener = obj.detail.listener, event = obj.detail.event;\n"
    + "  if (listener === 'dima:goals') document.querySelector('.goals').textContent = event.goals.length + ' goals';\n"
    + "  if (listener === 'dima:polls') document.querySelector('.polls').textContent = event.poll ? event.poll.title : 'none';\n"
    + "  if (listener === 'dima:tts') document.querySelector('.tts').textContent = event.phase; });\n" };
const extraView = id => ({ id, name: extraWidgets[id].manifest.name, engine: extraWidgets[id].manifest.engine, revision: 1, author: '', fields: [], data: {}, externalMedia: [], manifest: extraWidgets[id].manifest, media: {},
  files: Object.fromEntries(parts.map(part => [part, { bytes: 1, sha256: 'f'.repeat(64) }])), createdAt: '', updatedAt: '', usedIn: [] });

// Same stored-zip layout the site writes; used to build the upload.
function zip(files) {
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = data => { let c = 0xffffffff; for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.text), sum = crc(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(sum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(sum, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(entry, name); offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const upload = `/tmp/custom-widget-check-${process.pid}.zip`;
// The same package as a RAR 1.5–4.x archive with stored files (RARLAB technote), the format many SE widgets ship in.
function rar(files) {
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = data => { let c = 0xffffffff; for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const block = body => { const head = Buffer.alloc(2); head.writeUInt16LE(crc(body) & 0xffff, 0); return Buffer.concat([head, body]); };
  const main = Buffer.alloc(11); main.writeUInt8(0x73, 0); main.writeUInt16LE(13, 3);
  const out = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), block(main)];
  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\//g, '\\')), data = Buffer.from(file.text), head = Buffer.alloc(30 + name.length);
    head.writeUInt8(0x74, 0); head.writeUInt16LE(0x8000, 1); head.writeUInt16LE(32 + name.length, 3); head.writeUInt32LE(data.length, 5); head.writeUInt32LE(data.length, 9);
    head.writeUInt8(2, 13); head.writeUInt32LE(crc(data), 14); head.writeUInt32LE(0x5a210000, 18); head.writeUInt8(20, 22); head.writeUInt8(0x30, 23); head.writeUInt16LE(name.length, 24); head.writeUInt32LE(0x20, 26);
    name.copy(head, 30); out.push(block(head), data);
  }
  const end = Buffer.alloc(5); end.writeUInt8(0x7b, 0); end.writeUInt16LE(0x4000, 1); end.writeUInt16LE(7, 3); out.push(block(end));
  return Buffer.concat(out);
}
const rarUpload = `/tmp/custom-widget-check-${process.pid}.rar`;
await writeFile(upload, zip([{ name: 'Sample Chat/widget.ini', text: ini }, ...parts.map(part => ({ name: `Sample Chat/${part}.txt`, text: source[part] }))]));

const user = { id: '533538623', login: 'customfixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: false, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layout = { duration: 5, widgets: [] };
const bundleOf = (id, extra = {}) => {
  const own = extraWidgets[id];
  if (own) return { widgetId: id, revision: 1, engine: own.manifest.engine, manifest: own.manifest, html: own.html, css: own.css, js: own.js, fields: [], data: {}, media: {}, channel: { id: user.id, login: user.login, name: user.display_name }, ...extra };
  const [p, src] = id === dimaId ? [dimaPkg, dimaSource] : [pkg, source];
  return { widgetId: id, revision: 1, engine: p.manifest.engine, manifest: p.manifest, html: src.html, css: src.css, js: src.js, fields: p.fields, data: p.data, media: {}, channel: { id: user.id, login: user.login, name: user.display_name }, ...extra };
};
const dimaView = () => ({ id: dimaId, name: dimaPkg.name, engine: 'streamelements', revision: 1, author: dimaPkg.author, fields: dimaPkg.fields, data: dimaPkg.data, externalMedia: dimaPkg.externalMedia, manifest: dimaPkg.manifest, media: {},
  files: Object.fromEntries(parts.map(part => [part, { bytes: 1, sha256: 'f'.repeat(64) }])), createdAt: '', updatedAt: '', usedIn: [] });
const view = (extra = {}) => ({ id: widgetId, name: pkg.name, engine: 'streamelements', revision: 1, author: pkg.author, fields: pkg.fields, data: pkg.data, externalMedia: pkg.externalMedia, manifest: pkg.manifest, media: {},
  files: Object.fromEntries(parts.map(part => [part, { bytes: Buffer.byteLength(source[part]), sha256: 'f'.repeat(64) }])), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), usedIn: [], ...extra });

function mocks(options) {
  const world = { enabled: options.enabled ?? true, planTier: options.planTier ?? 'premium', limit: options.limit ?? 5, widgets: options.widgets ?? [], imports: [], writes: 0, copies: [], widgetTests: [],
    state: { schemaVersion: 1, revision: 0, designs: [{ id: 'default', name: 'Alerts', revision: 1, width: 800, height: 240, events: { sub: layout, bits: layout, follow: layout, raid: layout } }],
      scenes: [{ id: 'main', name: 'Main overlay', publicId, width: 1920, height: 1080, revision: 0, widgets: options.layers ?? [], waitFor: [] }] } };
  return { world, async install(context) {
    await context.addInitScript(({ user, app, theme }) => {
      if (window.top !== window) return; // widget frames are sandboxed (no storage)
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      localStorage.setItem('theme', localStorage.getItem('theme') || theme); localStorage.setItem('userLanguage', 'en');
    }, { user, app, theme: options.theme ?? 'dark' });
    await context.routeWebSocket('**/*', ws => ws.close());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.origin !== api) return route.abort();
      const path = url.pathname, list = `/overlay-studio/${user.id}/custom-widgets`;
      let data = {}, status = 200;
      if (path === '/auth/session') data = { twitch: user, app };
      else if (path.endsWith('/access') || path.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: world.planTier };
      else if (path.endsWith('/connections')) data = { checkedAt: Date.now(), scenes: [] };
      else if (path === list && req.method() === 'GET') data = { enabled: world.enabled, planTier: world.planTier, limit: world.limit, used: world.widgets.length, widgets: world.widgets };
      else if (path === list && req.method() === 'POST') {
        const body = req.postDataJSON(); world.imports.push(body);
        if (world.widgets.length >= world.limit) return route.fulfill({ status: 403, json: { error: true, status: 403, code: 'plan_limit', message: 'Your plan includes 1 custom widget. Delete one or upgrade to import more.' } });
        const created = view({ name: body.name || pkg.name }); world.widgets.push(created); status = 201; data = { widget: created, issues: [] };
      } else if (path.startsWith(`${list}/${widgetId}/files/`)) {
        const file = path.split('/').pop();
        return file === 'manifest' ? route.fulfill({ status: 404, json: { error: true, status: 404, message: 'This widget has no widget.json' } }) : route.fulfill({ status: 200, contentType: 'text/plain', body: source[file] });
      } else if (/\/custom-widgets\/[a-f0-9]{24}\/bundle$/.test(path)) data = bundleOf(path.split('/').at(-2));
      else if (path === `${list}/session`) data = options.session ?? { data: { 'follower-latest': { name: 'Session Sam' } }, recents: [] };
      else if (path === `${list}/signals`) data = { skipped: options.skipped ?? 0 };
      else if (path === `${list}/state`) data = options.liveState ?? { polls: null, goals: null };
      else if (path === `${list}/chat-history`) data = { messages: options.chatHistory ?? [] };
      else if (path.endsWith('/twitch-events')) data = { poll: { state: 'ready', events: [] }, prediction: { state: 'ready', events: [] } };
      else if (path.startsWith(`${list}/store/`)) data = { value: 3 };
      else if (path.startsWith(`${list}/counters/`)) data = { value: 7 };
      else if (path === `${list}/${widgetId}/media` && req.method() === 'GET') {
        const copied = world.widgets.find(w => w.id === widgetId)?.media ?? {};
        data = { files: seMedia.map(item => ({ url: item.url, kind: item.kind, bytes: copied[item.url] ? null : 120_000, copied: !!copied[item.url] })), totalBytes: seMedia.filter(item => !copied[item.url]).length * 120_000, unknownSizes: 0, quota: { usedBytes: 2_000_000, quotaBytes: 500_000_000 } };
      } else if (path === `${list}/${widgetId}/media` && req.method() === 'POST') {
        world.copies.push(req.postDataJSON()); data = { copied: Object.fromEntries(req.postDataJSON().urls.map((url, i) => [url, 'e'.repeat(23) + i])), failed: [] };
      } else if (path === `/overlay-studio/${user.id}/widget-test`) { world.widgetTests.push(req.postDataJSON()); data = { sent: true, clients: 1 }; }
      else if (path === `/overlay-studio/${user.id}`) {
        if (req.method() === 'PUT') { world.writes++; world.state = structuredClone(req.postDataJSON()); world.state.revision++; }
        data = structuredClone(world.state);
      } else if (path.endsWith('/publish')) {
        world.state.scenes[0].revision++; world.state.revision++;
        world.state.scenes[0].published = structuredClone({ width: 1920, height: 1080, widgets: world.state.scenes[0].widgets.map(w => w.kind === 'custom' ? { ...w, config: { ...w.config, revision: 1 } } : w), designs: [], waitFor: [] });
        data = structuredClone(world.state);
      }
      return route.fulfill({ status, json: { error: false, status, data } });
    });
  } };
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const axe = async (page, label) => {
  const result = await new AxeBuilder({ page }).include('app-overlay-editor').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`), [], `axe ${label}`);
};
const group = (page, name) => page.locator(`app-overlay-custom-widget-fields details.cw-group[data-group="${name}"]`);
const field = (page, key) => page.locator(`app-overlay-custom-widget-fields [data-field-key="${key}"]`);
const lastLayer = world => world.state.scenes[0].widgets.at(-1);

try {
  // 1. Feature off: nothing is shown.
  {
    const m = mocks({ enabled: false }), context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await m.install(context); const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/${user.login}/modules/overlays`); await page.locator('.stage').waitFor();
    await page.locator('.palette-item').first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-custom-widgets]').count(), 0, 'custom widgets stay hidden when the API says disabled');
    await context.close();
    console.log('PASS hidden when not enabled for the channel.');
  }

  // 2. Import → layer → settings → save/publish → export, desktop dark.
  const m = mocks({}), context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
  await m.install(context);
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/${user.login}/modules/overlays`); await page.locator('.stage').waitFor();
  await page.locator('[data-custom-widgets]').waitFor();
  assert.equal((await page.locator('.custom-usage').textContent()).trim(), '0/5');
  await page.locator('[data-custom-import]').click();
  const dialog = page.locator('dialog.cw-dialog');
  await dialog.waitFor();
  await dialog.locator('[data-cw-files]').setInputFiles(upload);
  await dialog.locator('[data-cw-summary]').waitFor();
  assert.deepEqual(await dialog.locator('.parts li').evaluateAll(items => items.map(li => [li.dataset.part, li.classList.contains('missing')])), parts.map(part => [part, false]));
  assert.equal(await dialog.locator('[data-cw-name]').inputValue(), 'Sample chat', 'name comes from the widgetName field');
  const visibleCount = groupFields(pkg.fields).reduce((n, g) => n + g.fields.length, 0);
  assert.match(await dialog.locator('[data-cw-summary]').textContent(), new RegExp(`${visibleCount} settings in 5 groups`));
  assert.match(await dialog.locator('[data-cw-remote]').textContent(), /loads 2 files from StreamElements/);
  assert.equal(await dialog.locator('[data-cw-built-in]').count(), 0, 'built-in values note is an experiment, off by default');
  await shot(page, 'import-dark-1280');
  await axe(page, 'import dialog');
  await dialog.locator('[data-cw-name]').fill('My chat');
  await dialog.locator('[data-cw-submit]').click();
  // StreamElements-hosted files: the dialog offers to copy them (sizes vs storage) or keep linking.
  await dialog.locator('[data-cw-media-storage]').waitFor();
  assert.equal(await dialog.locator('.media-list li').count(), seMedia.length);
  assert.match(await dialog.locator('[data-cw-media-storage]').textContent(), /about 240 KB of your storage \(498 MB free of 500 MB\)/);
  assert.match(await dialog.locator('[data-cw-media-copy]').textContent(), /Copy 2 files/);
  await shot(page, 'media-step-dark-1280');
  await axe(page, 'media step');
  await dialog.locator('[data-cw-media-keep]').click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(m.world.copies.length, 0, 'keep linking copies nothing');
  assert.equal(m.world.imports.length, 1);
  assert.equal(m.world.imports[0].name, 'My chat');
  for (const part of parts) assert.equal(m.world.imports[0].files[part], source[part], `${part} uploaded byte-for-byte`);

  // The new layer is selected; groups render collapsed.
  await page.locator('.selected-card[data-kind="custom"]').waitFor();
  await page.locator('app-overlay-scene-renderer [data-custom-frame="running"]').waitFor();
  assert.equal(await page.locator('app-overlay-custom-widget iframe').getAttribute('sandbox'), 'allow-scripts', 'widget code runs in a scripts-only sandbox');
  const groups = await page.locator('app-overlay-custom-widget-fields details.cw-group').evaluateAll(list => list.map(d => [d.dataset.group, d.open]));
  assert.deepEqual(groups, [['Test', false], ['Messages', false], ['Colors', false], ['', false], ['Alerts', false]], 'one collapsed group per fields.txt group, ungrouped as General');
  assert.equal(await page.locator('app-overlay-custom-widget-fields [data-field-key="widgetName"]').count(), 0, 'hidden fields are not shown');
  await shot(page, 'layer-dark-1280');

  // Colour: valid text, then invalid (inline error, unchanged), then picker.
  await group(page, 'Colors').locator('summary').click();
  const color = field(page, 'textColor').locator('input[type="text"]');
  assert.equal(await color.inputValue(), '#fefefe', 'data.txt value shown');
  await color.fill('rgba(255, 102, 170, 0.8)'); await color.press('Tab');
  await until(() => field(page, 'textColor').locator('.cw-changed').count(), 'changed marker');
  await color.fill('red; } body { display:none'); await color.press('Tab');
  await field(page, 'textColor').locator('.cw-error').waitFor();
  assert.equal(await color.getAttribute('aria-invalid'), 'true');
  const opacity = field(page, 'backgroundOpacity').locator('input[type="range"]');
  assert.equal(await opacity.inputValue(), '9', 'imported 12 is clamped to the slider max');
  await opacity.fill('3');
  await group(page, 'Messages').locator('summary').click();
  await field(page, 'hideCommands').locator('input[role="switch"]').click();
  await field(page, 'alignMessages').locator('select').selectOption('top');
  await field(page, 'messageLimit').locator('input').fill('12'); await field(page, 'messageLimit').locator('input').press('Tab');
  // Same value as the widget's saved data: not stored as a change.
  await field(page, 'ignoredUsers').locator('input').fill('StreamElements,Nightbot'); await field(page, 'ignoredUsers').locator('input').press('Tab');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.deepEqual(lastLayer(m.world).config, { widgetId, values: { textColor: 'rgba(255, 102, 170, 0.8)', backgroundOpacity: 3, hideCommands: false, alignMessages: 'top', messageLimit: 12 } });
  assert.equal(lastLayer(m.world).name, 'My chat');

  // Reset one, then search, then reset all.
  await field(page, 'messageLimit').locator('.cw-reset').click();
  await until(async () => !(await field(page, 'messageLimit').locator('.cw-changed').count()), 'reset one');
  assert.equal(await field(page, 'messageLimit').locator('input').inputValue(), '6');
  const search = page.locator('app-overlay-custom-widget-fields .cw-search input');
  await search.fill('color');
  await until(async () => (await page.locator('app-overlay-custom-widget-fields details.cw-group').count()) === 1, 'search filter');
  assert.equal(await group(page, 'Colors').evaluate(d => d.open), true, 'matching groups open while searching');
  await search.fill('');
  await page.locator('app-overlay-custom-widget-fields .cw-link').click();
  await until(async () => !(await page.locator('app-overlay-custom-widget-fields .cw-changed').count()), 'reset all');
  await field(page, 'textColor').locator('input[type="text"]').fill('#123456'); await field(page, 'textColor').locator('input[type="text"]').press('Tab');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.deepEqual(lastLayer(m.world).config, { widgetId, values: { textColor: '#123456' } });
  await page.getByRole('button', { name: /Publish live/ }).click();
  await page.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor();
  assert.equal(m.world.state.scenes[0].published.widgets.at(-1).config.values.textColor, '#123456');

  // Export: StreamElements zip with this layer's data.
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-cw-export]').click()]);
  assert.match(download.suggestedFilename(), /^My chat\.zip$/);
  const exported = await readFile(await download.path());
  const names = [], texts = {};
  for (let at = 0; exported.readUInt32LE(at) === 0x04034b50;) {
    const nameLength = exported.readUInt16LE(at + 26), size = exported.readUInt32LE(at + 18), name = exported.subarray(at + 30, at + 30 + nameLength).toString();
    names.push(name); texts[name] = exported.subarray(at + 30 + nameLength, at + 30 + nameLength + size).toString(); at += 30 + nameLength + size;
  }
  assert.deepEqual(names, ['widget.ini', 'html.txt', 'css.txt', 'js.txt', 'fields.txt', 'data.txt']);
  for (const part of ['html', 'css', 'js', 'fields']) assert.equal(texts[`${part}.txt`], source[part], `${part} exported unchanged`);
  const fields = parseFields(source.fields).fields;
  assert.deepEqual(JSON.parse(texts['data.txt']), resolveFieldData(fields, parseData(source.data, fields).data, { textColor: '#123456' }));
  console.log('PASS import, grouped settings, overrides/reset/search, save/publish and StreamElements export.');

  // 2b. The engine: the StreamElements sample runs in its frame and reacts to Studio's tests.
  // Settings apply after a short pause (debounced reload); wait for the rebuilt frame.
  await until(() => page.locator('app-overlay-custom-widget iframe').evaluate(f => f.srcdoc.includes('color: #123456;')), 'frame rebuilt with the saved colour');
  const frame = page.frameLocator('app-overlay-custom-widget iframe');
  if (!(await page.locator('.tester').isVisible())) await page.locator('.tb--test').click();
  await page.locator('[data-widget-tests]').waitFor();
  await page.locator('[data-chat-test="viewer"]').click();
  await frame.locator('.row', { hasText: 'Pixel_Fox' }).waitFor();
  assert.equal(await frame.locator('.row', { hasText: 'Pixel_Fox' }).evaluate(n => getComputedStyle(n).color), 'rgb(18, 52, 86)', 'layer settings reach the widget through {placeholders}');
  await page.locator('[data-chat-test="command"]').click(); await page.waitForTimeout(400);
  assert.equal(await frame.locator('.row', { hasText: '!socials' }).count(), 0, 'the widget hides !commands (its own setting)');
  await page.locator('[data-alert-test="follow"]').click();
  await frame.locator('.row.alert', { hasText: 'Luna followed' }).waitFor();
  await page.locator('[data-alert-test="bits"]').click();
  await frame.locator('.row.alert', { hasText: 'cheered 500 Bits' }).waitFor();
  await group(page, 'Test').locator('summary').click();
  await field(page, 'testMessage').locator('button').click();
  await frame.locator('.row', { hasText: 'Hello from the sample widget' }).waitFor();
  // A settings change reloads a StreamElements widget (as StreamElements does) with the new value.
  await field(page, 'textColor').locator('input[type="text"]').fill('#00ff00'); await field(page, 'textColor').locator('input[type="text"]').press('Tab');
  await until(async () => (await frame.locator('.row').count()) === 0, 'widget reloaded');
  await page.locator('[data-chat-test="vip"]').click();
  await until(async () => await frame.locator('.row', { hasText: 'Yuzu' }).evaluate(n => getComputedStyle(n).color).catch(() => '') === 'rgb(0, 255, 0)', 'new colour after reload');
  assert.match(await page.locator('[data-cw-status]').textContent(), /Running in the preview/);
  await shot(page, 'engine-se-dark-1280');
  // Tests can go to OBS instead (after a confirmation).
  page.once('dialog', d => d.accept());
  await page.locator('[data-widget-target="obs"]').click();
  await page.locator('[data-chat-test="moderator"]').click();
  await until(() => m.world.widgetTests.length === 1, 'widget test sent to OBS');
  assert.deepEqual([m.world.widgetTests[0].sceneId, m.world.widgetTests[0].type, m.world.widgetTests[0].data.user.name], ['main', 'chat', 'MOD_kitsune']);
  await page.locator('[data-widget-target="preview"]').click();
  // Copy the StreamElements files later from the layer's settings.
  await page.locator('[data-cw-copy-media]').click();
  const media = page.locator('dialog.cw-dialog');
  await media.locator('[data-cw-media-copy]').click();
  await media.locator('[data-cw-media-result]').waitFor();
  assert.match(await media.locator('[data-cw-media-result]').textContent(), /Copied 2 files/);
  assert.deepEqual(m.world.copies, [{ urls: seMedia.map(item => item.url) }]);
  await media.locator('[data-cw-media-done]').click(); await media.waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-cw-copy-media]').count(), 0, 'nothing left to copy');
  console.log('PASS engine (StreamElements): sandboxed frame, settings via placeholders, chat/command/alert tests, widget button, reload on settings change, tests to OBS, copying files.');

  // 3. Layouts and accessibility: dark then light, phone and desktop.
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => localStorage.setItem('theme', theme), theme);
    await page.reload(); await page.locator('.stage').waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.widget[data-kind="custom"]').first().dispatchEvent('click');
      if (width < 960) await page.locator('.studio-mtabs [data-tab="edit"]').click();
      await page.locator('app-overlay-custom-widget-fields details.cw-group').first().waitFor();
      await group(page, 'Colors').evaluate(d => { d.open = true; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}px overflow`);
      await axe(page, `${theme} ${width} layer`);
      await shot(page, `layer-${theme}-${width}`);
      if (width < 960) await page.locator('.studio-mtabs [data-tab="add"]').click();
      await page.locator('[data-custom-import]').click();
      await page.locator('dialog.cw-dialog').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}px dialog overflow`);
      await axe(page, `${theme} ${width} dialog`);
      await shot(page, `dialog-${theme}-${width}`);
      await page.keyboard.press('Escape'); await page.locator('dialog.cw-dialog').waitFor({ state: 'detached' });
    }
  }
  await context.close();
  console.log('PASS dark/light at 320/390/1280: no overflow, axe clean for the layer panel and import dialog.');

  // 4. Plan limit: the import is blocked with an upgrade prompt.
  {
    const limited = mocks({ planTier: 'free', limit: 1, widgets: [view()] }), ctx = await browser.newContext({ viewport: { width: 390, height: 860 }, reducedMotion: 'reduce' });
    await limited.install(ctx); const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    await p.locator('.studio-mtabs [data-tab="add"]').click();
    await p.locator('[data-custom-import]').click();
    const d = p.locator('dialog.cw-dialog'); await d.locator('[data-cw-limit]').waitFor();
    assert.match(await d.locator('[data-cw-limit]').textContent(), /Free plan includes 1 custom widget/);
    assert.equal(await d.locator('[data-cw-submit]').isDisabled(), true);
    await d.locator('[data-cw-files]').setInputFiles(upload);
    await d.locator('[data-cw-summary]').waitFor();
    assert.equal(await d.locator('[data-cw-submit]').isDisabled(), true, 'still blocked after picking files');
    assert.equal(limited.world.imports.length, 0);
    await shot(p, 'limit-dark-390');
    await ctx.close();
    console.log('PASS plan limit blocks imports with an upgrade prompt.');
  }

  // 4a. Experiment (per browser, ?experiments=widget-built-in-values): the import lists values settings don't show.
  {
    const em = mocks({}), ctx = await browser.newContext({ viewport: { width: 390, height: 860 }, reducedMotion: 'reduce' });
    await em.install(ctx); const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
    const openImport = async () => {
      await p.locator('.stage').waitFor(); await p.locator('.studio-mtabs [data-tab="add"]').click();
      await p.locator('[data-custom-import]').click();
      const d = p.locator('dialog.cw-dialog'); await d.locator('[data-cw-files]').setInputFiles(upload); await d.locator('[data-cw-summary]').waitFor();
      return d;
    };
    for (const theme of ['dark', 'light']) {
      await p.goto(`${base}/${user.login}/modules/overlays?experiments=widget-built-in-values`);
      await p.evaluate(t => localStorage.setItem('theme', t), theme); await p.reload();
      const d = await openImport(), note = d.locator('[data-cw-built-in]');
      assert.equal((await note.locator('summary').textContent()).trim(), "2 built-in values aren't in settings");
      await note.locator('summary').click();
      assert.deepEqual(await note.locator('code').allTextContents(), ['accentGlow', 'legacyCount'], 'data without a field; name/author left out');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} built-in note overflow`);
      await axe(p, `${theme} 390 built-in values`);
      await shot(p, `built-in-${theme}-390`);
    }
    // Remembered in this browser without the parameter; `?experiments=` turns it off again.
    await p.goto(`${base}/${user.login}/modules/overlays`);
    assert.equal(await (await openImport()).locator('[data-cw-built-in]').count(), 1, 'stays on in this browser');
    await p.goto(`${base}/${user.login}/modules/overlays?experiments=`);
    assert.equal(await (await openImport()).locator('[data-cw-built-in]').count(), 0, 'off again');
    await ctx.close();
    console.log('PASS experiment: import lists built-in values (hidden by default, per browser, dark/light, axe clean).');
  }


  // 4b. A native Dima widget: store, counters, session, live settings without reloading, widget log.
  {
    const dm = mocks({ widgets: [dimaView()], layers: [{ id: 'dima-1', kind: 'custom', configVersion: 1, x: 40, y: 40, width: 480, height: 640, visible: true, locked: false, name: 'Dima chat', config: { widgetId: dimaId } }] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }); await dm.install(ctx);
    const p = await ctx.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    await p.locator('.widget[data-kind="custom"]').first().dispatchEvent('click');
    await p.locator('[data-custom-frame="running"]').waitFor();
    const f = p.frameLocator('app-overlay-custom-widget iframe');
    await until(async () => (await f.locator('.count').textContent()) === '3', 'store read');
    assert.equal(await f.locator('.deaths').textContent(), '7', 'command counter');
    assert.deepEqual([await f.locator('body').getAttribute('data-session'), await f.locator('body').getAttribute('data-channel'), await f.locator('body').getAttribute('data-mode')], ['Session Sam', user.login, 'editor']);
    await f.locator('body').evaluate(() => { window.__marker = 'kept'; });
    await p.locator('.tb--test').click(); await p.locator('[data-widget-tests]').waitFor();
    for (const test of ['viewer', 'emotes', 'first', 'command']) await p.locator(`[data-chat-test="${test}"]`).click();
    await until(async () => (await f.locator('.msg').count()) === 3, 'three chat messages (command hidden)');
    assert.equal(await f.locator('.msg img.dima-emote').count(), 3, 'emotes render as images');
    assert.equal(await f.locator('.msg.first').count(), 1, 'first-time chatter flagged');
    await p.locator('[data-chat-delete]').click();
    await until(async () => (await f.locator('.msg').count()) === 2, 'delete removes the last message');
    await p.locator('[data-alert-test="giftBulk"]').click();
    await until(async () => (await f.locator('.banner__text').textContent()) === 'Yuzu · gift ×5', 'alert banner');
    await until(async () => (await f.locator('.count').textContent()) === '4', 'store write (preview only) + store event');
    // Live settings: no reload for Dima widgets.
    await group(p, 'Look').locator('summary').click();
    await field(p, 'accent').locator('input[type="text"]').fill('#00ff00'); await field(p, 'accent').locator('input[type="text"]').press('Tab');
    await until(async () => (await f.locator('html').evaluate(n => n.style.getPropertyValue('--accent'))) === '#00ff00', 'live accent');
    assert.equal(await f.locator('body').evaluate(() => window.__marker), 'kept', 'Dima widgets update settings without reloading');
    await p.locator('[data-cw-log] summary').click();
    await p.locator('[data-cw-log] li', { hasText: `ready ${user.login}` }).waitFor();
    assert.match(await p.locator('[data-cw-uses]').textContent(), /Chat messages.*Saves its own data.*Command counters/);
    await shot(p, 'engine-dima-dark-1280');
    await axe(p, 'native widget layer');
    await ctx.close();
    console.log('PASS engine (Dima): store/counters/session, emotes, first-time, delete, alerts, live settings without reload, widget log, uses.');
  }
  // 4c. Command signals: the layer's Commands block and the Test drawer.
  {
    const petLayer = (id, widgetId, name, x) => ({ id, kind: 'custom', configVersion: 1, x, y: 40, width: 400, height: 300, visible: true, locked: false, name, config: { widgetId } });
    const sm = mocks({ widgets: [extraView(petId), extraView(sePetId)], layers: [petLayer('pet-1', petId, 'Pet corner', 40), petLayer('pet-2', sePetId, 'Chat box', 500)], skipped: 2 });
    sm.world.state.scenes[0].published = { width: 1920, height: 1080, widgets: structuredClone(sm.world.state.scenes[0].widgets), designs: [], waitFor: [] };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    await sm.install(ctx);
    const p = await ctx.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    await p.locator('.widget[data-widget-id="pet-1"]').dispatchEvent('click');
    const block = p.locator('[data-cw-commands]');
    await block.locator('[data-cw-targeted]').waitFor();
    assert.deepEqual(await block.locator('[data-cw-snippet]').allTextContents(), ['$(widget.signal.to "Pet corner" feed &p1)', '$(widget.signal.to "Pet corner" pet)'],
      'another widget here listens too, so snippets name this layer; only signals with example values take &p1');
    assert.match(await block.locator('[data-cw-signal="feed"]').textContent(), /!feed\s*Feed the pet\s*Values: pizza · cake/);
    await block.locator('[data-cw-signal="feed"] [data-cw-copy]').click();
    await block.locator('[data-cw-signal="feed"] [data-cw-copy]', { hasText: 'Copied' }).waitFor();
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), '$(widget.signal.to "Pet corner" feed &p1)');
    const make = block.locator('[data-cw-signal="feed"] [data-cw-make]'), link = new URL(await make.getAttribute('href'), base);
    assert.deepEqual([link.pathname, ...['new', 'cmd', 'name', 'message', 'description'].map(key => link.searchParams.get(key)), await make.getAttribute('target')],
      [`/${user.login}/commands`, 'command', 'feed', 'Feed', '$(widget.signal.to "Pet corner" feed &p1)', 'Feed the pet', '_blank']);
    assert.match(await block.locator('[data-cw-skipped]').textContent(), /2 command signals were skipped/);
    assert.match(await p.locator('[data-cw-uses]').textContent(), /Commands can control it/);
    await axe(p, 'commands block dark');
    if (shots) { await block.scrollIntoViewIfNeeded(); await block.screenshot({ path: `${shots}/custom-widgets-signals-block-dark-1280.png` }); }

    // Test drawer → both preview frames; the Dima widget gets signal:feed and signal, the StreamElements one dima:signal.
    await p.locator('.tb--test').click(); await p.locator('[data-widget-tests]').waitFor();
    const form = p.locator('[data-widget-signal]');
    assert.deepEqual(await form.locator('[data-signal-suggestion]').allTextContents(), ['feed', 'pet']);
    await form.locator('[data-signal-suggestion="feed"]').click();
    await form.locator('[data-signal-value]').fill('cake 2');
    await form.locator('[data-signal-send]').click();
    const dimaFrame = p.frameLocator('app-overlay-scene-renderer [data-widget-id="pet-1"] iframe'), seFrame = p.frameLocator('app-overlay-scene-renderer [data-widget-id="pet-2"] iframe');
    await dimaFrame.locator('.food', { hasText: 'cake 2' }).waitFor();
    assert.deepEqual([await dimaFrame.locator('.who').textContent(), await dimaFrame.locator('.last').textContent()], [`${user.display_name} (broadcaster)`, 'feed:2']);
    await seFrame.locator('.food', { hasText: 'feed:cake 2' }).waitFor();
    await p.locator('[data-cw-log] summary').click();
    await p.locator('[data-cw-log] li', { hasText: `Signal feed → cake 2 from ${user.display_name}` }).waitFor();
    await form.locator('[data-signal-name]').fill('Pet.Feed'); await form.locator('[data-signal-send]').click();
    await p.locator('[role="alert"]', { hasText: 'Signal names use lowercase letters' }).first().waitFor();
    assert.equal(sm.world.widgetTests.length, 0, 'preview tests stay in the browser');
    p.once('dialog', d => d.accept());
    await p.locator('[data-widget-target="obs"]').click();
    await form.locator('[data-signal-name]').fill('pet'); await form.locator('[data-signal-value]').fill(''); await form.locator('[data-signal-send]').click();
    await until(() => sm.world.widgetTests.length === 1, 'signal test sent to OBS');
    assert.deepEqual([sm.world.widgetTests[0].sceneId, sm.world.widgetTests[0].type, sm.world.widgetTests[0].data.name, sm.world.widgetTests[0].data.value, sm.world.widgetTests[0].data.target], ['main', 'signal', 'pet', '', null]);
    await p.locator('[data-widget-target="preview"]').click();
    await shot(p, 'signals-tests-dark-1280');
    // Light theme and phone width: the Commands block stays readable and within the screen.
    await p.evaluate(() => localStorage.setItem('theme', 'light'));
    await p.setViewportSize({ width: 390, height: 900 }); await p.reload(); await p.locator('.stage').waitFor();
    await p.locator('.widget[data-widget-id="pet-1"]').dispatchEvent('click');
    await p.locator('.studio-mtabs [data-tab="edit"]').click();
    await block.locator('[data-cw-snippet]').first().waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'commands block fits a phone');
    await axe(p, 'commands block light 390');
    if (shots) { await block.scrollIntoViewIfNeeded(); await block.screenshot({ path: `${shots}/custom-widgets-signals-block-light-390.png` }); }
    await ctx.close();
    console.log('PASS command signals: Commands block (layer-named snippets, copy, Make a command link, skipped count), Test drawer to Dima and StreamElements widgets, name rules, OBS test, light + phone.');
  }
  // 4e. StreamElements goal widgets and .rar packages.
  {
    const session = { data: { 'follower-session': { count: 3 }, 'follower-total': { count: 900 }, 'follower-goal': { amount: 7 } }, recents: [],
      goalSources: { 'follower-goal': { id: 'g1', name: 'Road to 100', status: 'active' } } };
    const gm = mocks({ widgets: [extraView(seGoalId)], session, layers: [{ id: 'goal-1', kind: 'custom', configVersion: 1, x: 40, y: 40, width: 400, height: 200, visible: true, locked: false, name: 'Goal', config: { widgetId: seGoalId } }] });
    gm.world.state.scenes[0].published = { width: 1920, height: 1080, widgets: structuredClone(gm.world.state.scenes[0].widgets), designs: [], waitFor: [] };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }); await gm.install(ctx);
    const p = await ctx.newPage(); p.setDefaultTimeout(12000);
    const pageErrors = []; p.on('pageerror', e => { errors.push(e.message); pageErrors.push(e.message); });
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    await p.locator('.widget[data-widget-id="goal-1"]').dispatchEvent('click');
    await p.locator('[data-custom-frame="running"]').waitFor();
    const frame = p.frameLocator('app-overlay-scene-renderer [data-widget-id="goal-1"] iframe');
    await until(async () => (await frame.locator('.goal').textContent()) === '3', 'session count on load');
    assert.equal(await frame.locator('img.avatar').getAttribute('data-fallback'), 'yes', 'the inline onerror handler found the function from the widget script');
    await p.locator('.tb--test').click(); await p.locator('[data-widget-tests]').waitFor();
    await p.locator('[data-alert-test="follow"]').click();
    await until(async () => (await frame.locator('.goal').textContent()) === '4', 'a session-only widget reacts to a preview alert (onSessionUpdate)');
    // Tests to OBS: the alert, then the totals it leads to (from the server's snapshot, not the preview's).
    p.once('dialog', d => d.accept());
    await p.locator('[data-widget-target="obs"]').click();
    await p.locator('[data-alert-test="follow"]').click();
    await until(() => gm.world.widgetTests.length === 2, 'alert + session sent to OBS');
    assert.deepEqual(gm.world.widgetTests.map(test => test.type), ['alert', 'session']);
    assert.deepEqual([gm.world.widgetTests[1].data.data['follower-session'], gm.world.widgetTests[1].data.data['follower-goal']], [{ count: 4 }, { amount: 8 }]);
    await p.locator('[data-widget-target="preview"]').click();
    const goalData = p.locator('[data-cw-goal-data]');
    await goalData.locator('summary').click();
    assert.match(await goalData.locator('[data-cw-goal-source="follower"]').textContent(), /Followers: Road to 100/);
    assert.match(await goalData.locator('[data-cw-goal-source="cheer"]').textContent(), /Bits: no active goal/);
    assert.equal(new URL(await goalData.locator('[data-cw-goals-link]').getAttribute('href'), base).href, `${base}/${user.login}/dashboard#goals`);
    await p.locator('[data-cw-log] summary').click();
    assert.equal(await p.locator('[data-cw-log] li[data-level="error"]').count(), 0, 'no widget errors');
    await axe(p, 'goal data');
    await shot(p, 'goal-data-dark-1280');
    // A .rar package (common for StreamElements widgets) imports like the .zip.
    await writeFile(rarUpload, rar([{ name: 'Sample Chat/widget.ini', text: ini }, ...parts.map(part => ({ name: `Sample Chat/${part}.txt`, text: source[part] }))]));
    await p.locator('[data-custom-import]').click();
    const dialog = p.locator('dialog.cw-dialog');
    await dialog.locator('[data-cw-files]').setInputFiles(rarUpload);
    await dialog.locator('[data-cw-summary]').waitFor();
    assert.deepEqual(await dialog.locator('.parts li').evaluateAll(items => items.map(li => [li.dataset.part, li.classList.contains('missing')])), parts.map(part => [part, false]));
    assert.equal(await dialog.locator('[data-cw-name]').inputValue(), 'Sample chat');
    await p.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(pageErrors, []);
    await ctx.close();
    console.log('PASS StreamElements goal widgets: preview alerts update session-only widgets, early inline onerror handlers work, Goal data names the "Manual" goal; .rar imports.');
  }
  // 4f. Live state and bot events.
  {
    const goals = [{ id: 'g1', name: 'Road to 100', metric: 'follows', mode: 'total', target: 100, current: 64, percent: 64, currency: null, status: 'active', startsAt: 0, endsAt: null, windowSeconds: null, period: null }];
    const replay = ['first', 'second'].map((text, i) => ({ id: 'replay-' + i, platform: 'twitch', at: i, user: { id: '', login: 'ada', name: 'Ada', color: null, badges: [], roles: { broadcaster: false, moderator: false, vip: false, subscriber: false, founder: false, artist: false, staff: false, partner: false, turbo: false, prime: false }, subMonths: null },
      text, parts: [{ type: 'text', text }], kind: 'text', action: false, firstMessage: false, bits: 0, rewardId: null, reply: null, sharedChat: null }));
    const lm = mocks({ widgets: [extraView(liveId), extraView(seLiveId)], liveState: { polls: null, goals }, chatHistory: replay,
      layers: [{ id: 'live-1', kind: 'custom', configVersion: 1, x: 40, y: 40, width: 500, height: 300, visible: true, locked: false, name: 'Live', config: { widgetId: liveId } },
        { id: 'live-2', kind: 'custom', configVersion: 1, x: 600, y: 40, width: 400, height: 200, visible: true, locked: false, name: 'SE live', config: { widgetId: seLiveId } }] });
    lm.world.state.scenes[0].published = { width: 1920, height: 1080, widgets: structuredClone(lm.world.state.scenes[0].widgets), designs: [], waitFor: [] };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }); await lm.install(ctx);
    const p = await ctx.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/${user.login}/modules/overlays`); await p.locator('.stage').waitFor();
    const live = p.frameLocator('app-overlay-scene-renderer [data-widget-id="live-1"] iframe'), seLive = p.frameLocator('app-overlay-scene-renderer [data-widget-id="live-2"] iframe');
    await live.locator('.goals', { hasText: 'Road to 100:64' }).waitFor(); // the channel's real goals, as soon as the widget starts
    assert.equal(await live.locator('.polls').textContent(), '', 'no polls value yet: unknown until known');
    await p.locator('.tb--test').click(); await p.locator('[data-widget-tests]').waitFor();
    assert.deepEqual(await p.locator('[data-bot-test]').evaluateAll(items => items.map(item => item.getAttribute('data-bot-test'))), ['tts', 'trigger', 'reward', 'pet', 'duel', 'roulette', 'dimafx', 'polls', 'goals']);
    await p.locator('[data-bot-test="tts"]').click();
    await live.locator('.tts', { hasText: 'start:Yuzu says: the cozy stream continues!:true' }).waitFor();
    await seLive.locator('.tts', { hasText: 'start' }).waitFor();
    await live.locator('.tts', { hasText: 'end:' }).waitFor({ timeout: 6000 });
    await p.locator('[data-bot-test="trigger"]').click(); await live.locator('.trigger', { hasText: 'Airhorn:audio' }).waitFor();
    await p.locator('[data-bot-test="reward"]').click(); await live.locator('.reward', { hasText: 'Hydrate!:stay hydrated, chat' }).waitFor();
    // Paired events: the second half follows (no winner or label before it).
    await p.locator('[data-bot-test="duel"]').click(); await live.locator('.duel', { hasText: 'started:null' }).waitFor();
    await p.locator('[data-bot-test="roulette"]').click(); await live.locator('.roulette', { hasText: 'spinning:null' }).waitFor();
    await p.locator('[data-bot-test="pet"]').click(); await live.locator('.pet', { hasText: 'speaking:Thanks for the follow, Luna!:happy' }).waitFor();
    await p.locator('[data-bot-test="dimafx"]').click(); await live.locator('.dimafx', { hasText: 'Confetti:100:Ame' }).waitFor();
    await live.locator('.duel', { hasText: 'ended:yuzu' }).waitFor({ timeout: 6000 });
    await live.locator('.roulette', { hasText: 'result:Sing a song' }).waitFor({ timeout: 6000 });
    await live.locator('.pet', { hasText: 'done:' }).waitFor({ timeout: 6000 });
    await p.locator('[data-bot-test="polls"]').click();
    await live.locator('.polls', { hasText: 'Next game?:3' }).waitFor(); await seLive.locator('.polls', { hasText: 'Next game?' }).waitFor();
    await p.locator('[data-bot-test="goals"]').click();
    await live.locator('.goals', { hasText: 'Road to 100 followers:64' }).waitFor(); await seLive.locator('.goals', { hasText: '2 goals' }).waitFor();
    // Replay recent chat: stored messages in order (the SE widget doesn't use chat).
    await p.locator('[data-chat-replay]').click();
    await until(async () => (await live.locator('.chat li').allTextContents()).join('|') === 'Ada: first|Ada: second', 'replayed chat in order');
    // Never to OBS: stored history can include messages moderators deleted.
    p.once('dialog', d => d.accept());
    await p.locator('[data-widget-target="obs"]').click();
    assert.equal(await p.locator('[data-chat-replay]').isDisabled(), true, 'replay is preview-only');
    assert.equal(lm.world.widgetTests.length, 0);
    await p.locator('[data-widget-target="preview"]').click();
    // Layer settings: the poll setup for widgets that use polls.
    await p.locator('.widget[data-widget-id="live-1"]').dispatchEvent('click');
    await p.locator('[data-cw-polls-setup] app-overlay-interaction-setup').waitFor();
    await axe(p, 'live state layer');
    await shot(p, 'live-state-dark-1280');
    await ctx.close();
    console.log('PASS live state and bot events: real goals at start, Test drawer TTS/trigger/channel points/pet/duel/roulette/DimaFX/sample poll and goals to Dima and SE widgets, chat replay, poll setup.');
  }
  // 4d. OBS: a signal reaches only the layers the server named.
  {
    const runtime = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const layer = (id, widgetId, name) => ({ id, kind: 'custom', configVersion: 1, x: 0, y: 0, width: 400, height: 300, visible: true, locked: false, name, config: { widgetId, revision: 1 } });
    const snapshot = { width: 1280, height: 720, designs: [], waitFor: [], widgets: [layer('pet-1', petId, 'Pet corner'), layer('pet-2', sePetId, 'Chat box')] };
    let socket;
    await runtime.routeWebSocket('**/*', ws => {
      if (!ws.url().includes('/socket.io/')) return ws.close();
      socket = ws;
      ws.send('0{"sid":"custom","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
      ws.onMessage(message => { if (String(message).startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"custom"}`); ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-state', { revision: 1, snapshot, widgetStates: {}, serverTime: Date.now() }])}`); } });
    });
    await runtime.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      const match = /^\/overlay-studio\/public\/[a-z0-9]+\/custom-widgets\/([a-f0-9]{24})\/1$/.exec(url.pathname);
      return match && extraWidgets[match[1]] ? route.fulfill({ json: { error: false, data: bundleOf(match[1]) } }) : route.abort();
    });
    const p = await runtime.newPage(); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/overlays/${publicId}`);
    await until(async () => (await p.locator('[data-custom-frame="running"]').count()) === 2, 'both widgets running');
    const signal = (name, value, target, layers) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-feed', { v: 1, type: 'signal', layers,
      data: { id: name + value, name, value, json: null, args: value ? value.split(' ') : [], at: Date.now(), user: { id: '5', login: 'ada', name: 'Ada', roles: { broadcaster: false, moderator: true, vip: false, subscriber: false } }, source: { kind: 'command', name }, target } }])}`);
    const frames = ['pet-1', 'pet-2'].map(id => p.frameLocator(`[data-widget-id="${id}"] iframe`));
    signal('feed', 'pizza', 'Pet corner', ['pet-1']);
    await frames[0].locator('.food', { hasText: 'pizza' }).waitFor();
    await p.waitForTimeout(300);
    assert.equal(await frames[1].locator('.food').textContent(), 'hungry', 'a layer the server did not name gets nothing');
    signal('feed', 'cake', null, ['pet-1', 'pet-2']);
    await frames[1].locator('.food', { hasText: 'feed:cake' }).waitFor();
    await frames[0].locator('.food', { hasText: 'cake' }).waitFor();
    assert.equal(await frames[0].locator('.who').textContent(), 'Ada');
    await runtime.close();
    console.log('PASS OBS: signals reach only the layers the server named (Dima and StreamElements widgets).');
  }
  // 5. OBS: published widgets run with this overlay's socket data.
  {
    const runtime = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const snapshot = { width: 1280, height: 720, designs: [], waitFor: [], widgets: [{ id: 'custom-1', kind: 'custom', configVersion: 1, x: 0, y: 0, width: 480, height: 640, visible: true, locked: false, config: { widgetId, revision: 1, values: { textColor: '#123456' } } }] };
    let socket;
    const feed = (type, data) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-feed', { v: 1, type, data }])}`);
    await runtime.routeWebSocket('**/*', ws => {
      if (!ws.url().includes('/socket.io/')) return ws.close();
      socket = ws;
      ws.send('0{"sid":"custom","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
      ws.onMessage(message => { if (String(message).startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"custom"}`); ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-state', { revision: 1, snapshot, widgetStates: {}, serverTime: Date.now() }])}`); } });
    });
    const bundleRequests = [];
    await runtime.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.pathname === `/overlay-studio/public/${publicId}/custom-widgets/${widgetId}/1`) { bundleRequests.push(url.pathname); return route.fulfill({ json: { error: false, data: bundleOf(widgetId) } }); }
      return route.abort();
    });
    const p = await runtime.newPage(); p.on('pageerror', e => errors.push(e.message));
    await p.goto(`${base}/overlays/${publicId}`);
    await p.locator('[data-custom-frame="running"]').waitFor();
    assert.equal(await p.locator('[data-custom-placeholder]').count(), 0, 'no placeholder on stream');
    const f = p.frameLocator('app-overlay-custom-widget iframe');
    feed('chat', { id: 'live-1', platform: 'twitch', at: Date.now(), user: { id: '5', login: 'ada', name: 'Ada', color: null, badges: [], roles: {}, subMonths: null }, text: 'live hello', parts: [{ type: 'text', text: 'live hello' }], kind: 'text', action: false, firstMessage: false, bits: 0, rewardId: null, reply: null, sharedChat: null });
    await f.locator('.row', { hasText: 'live hello' }).waitFor();
    assert.equal(await f.locator('.row', { hasText: 'live hello' }).evaluate(n => getComputedStyle(n).color), 'rgb(18, 52, 86)', 'published layer settings apply on stream');
    feed('alert', { id: 'a1', type: 'raid', at: Date.now(), test: false, user: { id: '9', login: 'sakura', name: 'Sakura' }, amount: 42, tier: null, months: null, streak: null, message: null, recipient: null, currency: null, rule: null });
    feed('storage', { key: 'x', value: 1 });
    await p.waitForTimeout(300);
    assert.equal(await f.locator('.row.alert').count(), 0, 'the sample only shows follows and cheers');
    feed('alert', { id: 'a2', type: 'follow', at: Date.now(), test: false, user: { id: '7', login: 'luna', name: 'Luna' }, amount: 1, tier: null, months: null, streak: null, message: null, recipient: null, currency: null, rule: null });
    await f.locator('.row.alert', { hasText: 'Luna followed' }).waitFor();
    feed('chat.delete', { messageId: 'live-1', userId: '5' });
    await until(async () => (await f.locator('.row', { hasText: 'live hello' }).count()) === 0, 'deleted message removed');
    assert.deepEqual(bundleRequests, [`/overlay-studio/public/${publicId}/custom-widgets/${widgetId}/1`], 'the pinned revision is loaded once');
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
    await runtime.close();
    console.log('PASS OBS runtime: pinned revision, layer settings, live chat and alerts from the overlay socket, transparent output.');
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
