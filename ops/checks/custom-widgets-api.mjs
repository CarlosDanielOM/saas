// saas-ops only (api target): disposable Mongo/Redis, fixture identities and an in-check fake S3.
// Custom widgets: availability, plan limits, import parsing, private S3 files, Studio save/publish
// validation, revisions (10 newest + published), stale editor saves, prune, delete protection and file cleanup,
// and the Studio live status (a published overlay with custom widgets reads as live; new code makes it not live).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const fixtures = '/tmp/saas-fixtures/sample-chat';
const preview = '533538623', other = '990241';
const parts = ['html', 'css', 'js', 'fields', 'data'];
const source = Object.fromEntries(await Promise.all(parts.map(async part => [part, await readFile(`${fixtures}/${part}.txt`, 'utf8')])));

// Fake S3 on the endpoint named by S3_ENDPOINT_URL in test-env.json (path-style: /bucket/key).
const objects = new Map(), requests = [];
const s3 = createServer((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
    const key = decodeURIComponent(new URL(req.url, 'http://s3').pathname).replace(/^\/fixture-bucket\//, '');
    requests.push({ method: req.method, key, acl: req.headers['x-amz-acl'] ?? null });
    if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.setHeader('ETag', '"fixture"'); return res.end(); }
    if (req.method === 'GET') { const body = objects.get(key); if (!body) { res.statusCode = 404; res.setHeader('Content-Type', 'application/xml'); return res.end('<Error><Code>NoSuchKey</Code></Error>'); } res.setHeader('Content-Length', body.length); return res.end(body); }
    if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
    res.statusCode = 405; res.end();
  });
});
await new Promise(resolve => s3.listen(9311, '127.0.0.1', resolve));

const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js'); await getMongoDBConnection('custom-widgets-test');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js'); const redis = await getDragonflyClient('custom-widgets-test');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { CustomWidgets } = await import('/app/dist/custom_widgets/store.js');
for (const [id, plan] of [[preview, 'free'], [other, 'pro']]) {
  await Users.collection.insertOne({ accounts: [{ type: 'twitch', id }], plan_tier: plan });
  await redis.hSet('token:cw-' + id, { id, login: 'fixture' + id, display_name: 'Fixture' });
}
async function req(method, path, body, status = 200, owner = preview) {
  const response = await fetch('http://127.0.0.1:3000' + path, { method, headers: { Authorization: 'Bearer cw-' + owner, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const data = async (...args) => (await req(...args)).data;
async function fileText(path) {
  const response = await fetch('http://127.0.0.1:3000' + path, { headers: { Authorization: 'Bearer cw-' + preview } });
  assert.equal(response.status, 200, path); assert.match(response.headers.get('content-type'), /^text\/plain/); return response.text();
}
const base = '/overlay-studio/' + preview, widgetsPath = base + '/custom-widgets';
const keysFor = id => [...objects.keys()].filter(key => key.startsWith(`custom-widgets/${preview}/${id}/`)).sort();

try {
  // Available to every channel; owner-only access.
  assert.deepEqual(await data('GET', `/overlay-studio/${other}/custom-widgets`, null, 200, other), { enabled: true, planTier: 'pro', limit: 100, used: 0, widgets: [] });
  const otherWidget = (await data('POST', `/overlay-studio/${other}/custom-widgets`, { files: source }, 201, other)).widget;
  await req('DELETE', `/overlay-studio/${other}/custom-widgets/${otherWidget.id}`, null, 403);
  await req('GET', widgetsPath, null, 403, other);
  assert.deepEqual(await data('DELETE', `/overlay-studio/${other}/custom-widgets/${otherWidget.id}`, null, 200, other), { deleted: true });
  assert.deepEqual(await data('GET', widgetsPath), { enabled: true, planTier: 'free', limit: 5, used: 0, widgets: [] });
  console.log('PASS every channel can use custom widgets; owner-only access; free-plan limit in the list.');

  // Bad imports are rejected before anything is stored.
  for (const [body, pattern] of [[{ files: { ...source, fields: '{oops' } }, /fields file isn't valid JSON/], [{ files: { ...source, data: '[1]' } }, /data file must be a JSON object/],
    [{ files: { ...source, js: 'x'.repeat(1_000_001) } }, /js file is too large/], [{ files: { ...source, extra: 'x' } }, /Unknown widget file/], [{ files: { ...source, html: 5 } }, /must be text/],
    [{ name: 'x'.repeat(81), files: source }, /name up to 80/], [{}, /Choose the widget files/]]) {
    assert.match((await req('POST', widgetsPath, body, 400)).message, pattern);
  }
  assert.equal(objects.size, 0, 'nothing reaches S3 for rejected imports');

  // Import: name from widgetName, repaired data, private content-addressed files.
  const created = await data('POST', widgetsPath, { files: source }, 201);
  const widget = created.widget, id = widget.id;
  assert.match(id, /^[a-f0-9]{24}$/);
  assert.deepEqual(created.issues, []);
  assert.equal(widget.name, 'Sample chat'); assert.equal(widget.author, 'DomDimaBot'); assert.equal(widget.revision, 1); assert.equal(widget.engine, 'streamelements');
  assert.equal(widget.fields.length, 20);
  assert.deepEqual([widget.data.messageLimit, widget.data.backgroundOpacity, widget.data.nameWeight, widget.data.alertSound, widget.data.accentGlow], [6, 9, '700', null, '#ec6b93']);
  assert.equal(widget.externalMedia.filter(m => m.host === 'cdn.streamelements.com').length, 2);
  assert.equal(keysFor(id).length, 5);
  assert(requests.filter(r => r.method === 'PUT').every(r => r.acl === null), 'widget files are never public');
  for (const part of parts) assert.equal(await fileText(`${widgetsPath}/${id}/files/${part}`), source[part], `${part} round-trips byte-for-byte`);
  await req('GET', `${widgetsPath}/${id}/files/secrets`, null, 404);
  await req('GET', `${widgetsPath}/${'0'.repeat(24)}/files/html`, null, 404);
  const stored = await CustomWidgets.findById(id).lean();
  assert.equal(stored.owner, preview); assert.equal(stored.revisions.length, 1); assert.equal(stored.revisions[0].files.html.key, `custom-widgets/${preview}/${id}/html/${stored.revisions[0].files.html.sha256}.txt`);
  console.log('PASS import: parsed fields/data, issues, private S3 files that round-trip, stored revision 1.');

  // Plan limit (free = 5), then premium allows more (20). The extra imports are removed again.
  const fillers = [];
  for (let n = 2; n <= 5; n++) fillers.push((await data('POST', widgetsPath, { name: 'Filler ' + n, files: { ...source, js: source.js + '\n// filler ' + n } }, 201)).widget);
  assert.equal((await data('GET', widgetsPath)).used, 5);
  const limited = await req('POST', widgetsPath, { files: source }, 403);
  assert.equal(limited.code, 'plan_limit'); assert.match(limited.message, /includes 5 custom widgets/);
  for (const filler of fillers) assert.deepEqual(await data('DELETE', `${widgetsPath}/${filler.id}`), { deleted: true });
  await Users.collection.updateOne({ accounts: { $elemMatch: { type: 'twitch', id: preview } } }, { $set: { plan_tier: 'premium' } });
  assert.equal((await data('GET', widgetsPath)).limit, 20);
  const second = (await data('POST', widgetsPath, { name: 'Second', files: { ...source, js: source.js + '\n// second' } }, 201)).widget;
  assert.equal((await data('GET', widgetsPath)).used, 2);
  assert.equal((await data('PATCH', `${widgetsPath}/${second.id}`, { name: 'Renamed' })).name, 'Renamed');
  // Block outside connections: the owner's choice (never widget.json), in the view and the bundle; outside code is listed.
  assert.deepEqual([second.network, second.outsideCode], ['open', []]);
  const blocked = await data('PATCH', `${widgetsPath}/${second.id}`, { network: 'restricted' });
  assert.deepEqual([blocked.network, blocked.name], ['restricted', 'Renamed'], 'changing one keeps the other');
  await req('PATCH', `${widgetsPath}/${second.id}`, { network: 'off' }, 400);
  assert.equal((await data('GET', `${widgetsPath}/${second.id}/bundle`)).network, 'restricted');
  assert.equal((await data('PATCH', `${widgetsPath}/${second.id}`, { network: 'open' })).network, 'open');
  await req('POST', widgetsPath, { name: 'Bad', network: 'nope', files: source }, 400);
  const outside = (await data('POST', widgetsPath, { name: 'Outside', network: 'restricted', files: { ...source, html: source.html + '<script src="https://cdn.jsdelivr.net/npm/gsap@3"></script>' } }, 201)).widget;
  assert.deepEqual([outside.network, outside.outsideCode], ['restricted', ['cdn.jsdelivr.net']], 'imported blocked; the outside code is named');
  await data('DELETE', `${widgetsPath}/${outside.id}`);
  assert.equal((await data('GET', widgetsPath)).used, 2);
  console.log('PASS plan limits (free 5, premium 20, pro 100), rename, and "Block outside connections" (owner setting, bundle, import opt-in, outside code listed).');

  // Studio save: valid layer values are kept; stale keys dropped; bad values and foreign IDs rejected.
  let state = await data('GET', base);
  const sceneId = state.scenes[0].id;
  // Live status: whether OBS already plays the saved draft (computed by the server on every Studio response).
  const live = async expected => {
    const status = await data('GET', `${base}/live`);
    assert.equal(status.revision, state.revision, 'the live status names the saved draft it describes');
    assert.equal(status.live[sceneId], expected, `GET live: ${JSON.stringify(status.live)}`);
  };
  assert.deepEqual(state.live, { [sceneId]: false }, 'never published');
  const layer = { id: 'custom-1', kind: 'custom', configVersion: 1, x: 10, y: 10, width: 480, height: 640, visible: true, locked: false, name: 'Chat', config: { widgetId: id, revision: 99, values: { textColor: '#123456', hideCommands: false, removedSetting: 1, testMessage: 'x' } } };
  state.scenes[0].widgets.push(layer);
  state = await data('PUT', base, state);
  assert.deepEqual(state.scenes[0].widgets.at(-1).config, { widgetId: id, values: { textColor: '#123456', hideCommands: false } }, 'drafts never pin a revision; removed settings and buttons are dropped');
  for (const config of [{ widgetId: id, values: { textColor: 'red;} body{display:none' } }, { widgetId: id, values: { nameWeight: '900' } }, { widgetId: id, values: { alertImage: 'javascript:alert(1)' } }]) {
    const copy = structuredClone(state); copy.scenes[0].widgets.at(-1).config = config;
    assert.match((await req('PUT', base, copy, 400)).message, /Sample chat: Invalid value/);
  }
  for (const [config, status] of [[{ widgetId: 'b'.repeat(24) }, 404], [{ widgetId: 'not-an-id' }, 400], [{}, 400], [{ widgetId: id, values: [] }, 400]]) {
    const copy = structuredClone(state); copy.scenes[0].widgets.at(-1).config = config; await req('PUT', base, copy, status);
  }
  const design = structuredClone(state); design.designs[0].events.follow.widgets.push({ ...layer, id: 'in-design' }); await req('PUT', base, design, 400);
  console.log('PASS Studio save: values checked against fields, stale keys dropped, injection/foreign IDs/design placement rejected.');

  // Publish pins revision 1; replacing files makes revision 2 for drafts only.
  assert.equal(state.live[sceneId], false, 'saved, not published');
  state = await data('POST', `${base}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  assert.deepEqual(state.scenes[0].published.widgets.at(-1).config, { widgetId: id, revision: 1, values: { textColor: '#123456', hideCommands: false } });
  // The pin exists only in the published copy, yet the overlay is live (VTLuciel, 2026-11-06: it read "not live" forever).
  assert.deepEqual(state.scenes[0].widgets.at(-1).config, { widgetId: id, values: { textColor: '#123456', hideCommands: false } });
  assert.equal(state.live[sceneId], true, 'publish response: live');
  assert.equal((await data('GET', base)).live[sceneId], true, 'reload: live');
  await live(true);
  state = await data('PUT', base, state);
  assert.equal(state.live[sceneId], true, 'saving with no changes keeps it live');
  state = await data('POST', `${base}/scenes/${sceneId}/rotate`, { revision: state.revision });
  assert.equal(state.live[sceneId], true, 'a new OBS link keeps it live');
  const newFields = JSON.parse(source.fields); delete newFields.hideCommands; newFields.glow = { type: 'colorpicker', label: 'Glow', value: '#ff00ff', group: 'Colors' };
  const replaced = await data('PUT', `${widgetsPath}/${id}/files`, { files: { ...source, fields: JSON.stringify(newFields) } });
  assert.equal(replaced.widget.revision, 2); assert(replaced.widget.fields.some(f => f.key === 'glow'));
  await live(false); // OBS still runs revision 1
  assert.deepEqual((await CustomWidgets.findById(id).lean()).revisions.map(r => r.revision), [1, 2], 'published revision 1 is kept');
  assert.equal(keysFor(id).length, 6, 'unchanged files are shared between revisions');
  assert.equal(await fileText(`${widgetsPath}/${id}/files/fields?revision=1`), source.fields);
  const publicView = await data('GET', `/overlay-studio/public/${state.scenes[0].publicId}`);
  assert.equal(publicView.snapshot.widgets.at(-1).config.revision, 1, 'OBS keeps the published revision');
  // The block applies to the published revision too (it's the owner's current choice, not part of the files).
  const pinned = `/overlay-studio/public/${state.scenes[0].publicId}/custom-widgets/${id}/1`;
  assert.equal((await data('GET', pinned)).network, 'open');
  await data('PATCH', `${widgetsPath}/${id}`, { network: 'restricted' });
  assert.equal((await data('GET', pinned)).network, 'restricted');
  await data('PATCH', `${widgetsPath}/${id}`, { network: 'open' });
  state = await data('PUT', base, state);
  assert.deepEqual(state.scenes[0].widgets.at(-1).config.values, { textColor: '#123456' }, 'settings removed by new files are dropped on save');
  assert.equal(state.live[sceneId], false, 'saved, still not published');
  state = await data('POST', `${base}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  assert.equal(state.scenes[0].published.widgets.at(-1).config.revision, 2);
  assert.equal(state.live[sceneId], true, 'published revision 2: live');
  // A layer with no changed settings (no values at all), as VTLuciel's was.
  state.scenes[0].widgets.at(-1).config = { widgetId: id };
  state = await data('PUT', base, state);
  assert.deepEqual(state.scenes[0].widgets.at(-1).config, { widgetId: id });
  assert.equal(state.live[sceneId], false, 'settings changed');
  state = await data('POST', `${base}/scenes/${sceneId}/publish`, { revision: state.revision });
  assert.deepEqual(state.scenes[0].published.widgets.at(-1).config, { widgetId: id, revision: 2 });
  assert.equal(state.live[sceneId], true, 'no settings: live after publishing');
  assert.deepEqual((await CustomWidgets.findById(id).lean()).revisions.map(r => r.revision), [1, 2], 'recent revisions stay as version history');
  assert.equal(await fileText(`${widgetsPath}/${id}/files/fields?revision=1`), source.fields);
  assert.equal((await data('PUT', `${widgetsPath}/${id}/files`, { files: { ...source, css: source.css + '\n/* v3 */' } })).widget.revision, 3);
  await live(false); // new code that OBS doesn't run yet
  const listed = (await data('GET', widgetsPath)).widgets.find(w => w.id === id);
  assert.deepEqual(listed.history.map(h => [h.revision, h.published]), [[3, false], [2, true], [1, false]], 'history: newest first, published marked');
  // Code editor saves name the version they started from; a stale one is refused instead of overwriting.
  const staleSave = await req('PUT', `${widgetsPath}/${id}/files`, { files: { ...source, css: source.css + '\n/* stale */' }, baseRevision: 2 }, 409);
  assert.equal(staleSave.code, 'stale'); assert.match(staleSave.message, /version 3/);
  await req('PUT', `${widgetsPath}/${id}/files`, { files: source, baseRevision: 'x' }, 400);
  assert.equal((await data('PUT', `${widgetsPath}/${id}/files`, { files: { ...source, css: source.css + '\n/* v4 */' }, baseRevision: 3 })).widget.revision, 4);
  // History keeps the 10 newest plus published ones; files only the pruned revisions used are deleted.
  let saved;
  for (let v = 5; v <= 14; v++) saved = await data('PUT', `${widgetsPath}/${id}/files`, { files: { ...source, css: source.css + `\n/* v${v} */` }, baseRevision: v - 1 });
  const kept = (await CustomWidgets.findById(id).lean()).revisions;
  assert.deepEqual(kept.map(r => r.revision), [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 'newest 10 + the published revision 2');
  assert.deepEqual(saved.widget.history.map(h => h.revision), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 2], 'the save response shows what was kept');
  await req('GET', `${widgetsPath}/${id}/files/css?revision=3`, null, 404);
  assert.deepEqual(keysFor(id), [...new Set(kept.flatMap(r => Object.values(r.files).map(f => f.key)))].sort(), 'S3 holds exactly the kept revisions\' files');
  console.log('PASS publish pins revisions; version history (10 newest + published), stale editor saves refused, pruned files deleted.');
  console.log('PASS live status: published with custom widgets = live (with and without settings), new code or settings = not live until published.');

  // Delete: refused while used (draft or published), then removes the document and every file.
  const inUse = await req('DELETE', `${widgetsPath}/${id}`, null, 409);
  assert.equal(inUse.code, 'in_use'); assert.match(inUse.message, /My overlay/);
  state.scenes[0].widgets = state.scenes[0].widgets.filter(w => w.kind !== 'custom');
  state = await data('PUT', base, state);
  assert.equal((await req('DELETE', `${widgetsPath}/${id}`, null, 409)).code, 'in_use', 'the published overlay still uses it');
  assert.equal(state.live[sceneId], false, 'the published copy still has the layer');
  state = await data('POST', `${base}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  assert.equal(state.live[sceneId], true, 'published without custom widgets: live');
  assert.deepEqual((await CustomWidgets.findById(id).lean()).revisions.map(r => r.revision), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 'publishing without the layer releases its old revision');
  assert.deepEqual(await data('DELETE', `${widgetsPath}/${id}`), { deleted: true });
  assert.equal(keysFor(id).length, 0); assert.equal(await CustomWidgets.countDocuments({ _id: id }), 0);
  assert.equal((await data('GET', widgetsPath)).used, 1);
  const stale = structuredClone(state); stale.scenes[0].widgets.push({ ...layer, config: { widgetId: id } });
  assert.equal((await req('PUT', base, stale, 404)).code, 'missing_widget');
  console.log('PASS delete protection for drafts and published overlays, then full cleanup.');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  s3.close();
  process.exit(process.exitCode ?? 0);
}
