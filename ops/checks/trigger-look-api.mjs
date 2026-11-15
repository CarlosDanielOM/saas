// Trigger looks against the real candidate API: disposable Mongo/Redis and local Socket.IO clients only.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { TriggerSchema } = await import('/app/dist/schemas/trigger.schema.js');
const { MediaAssetSchema } = await import('/app/dist/schemas/media_asset.schema.js');
const { UserMediaLibraryItemSchema } = await import('/app/dist/schemas/user_media_library_item.schema.js');
const { Studio } = await import('/app/dist/overlays/store.js');
const mongo = await getMongoDBConnection('trigger-look-check'), redis = await getDragonflyClient('trigger-look-check');
const channel = '990301', foreign = '990302', token = 'look-owner-fixture', foreignToken = 'look-foreign-fixture';
const triggerA = 'a1'.repeat(12), triggerB = 'b2'.repeat(12), triggerC = 'c3'.repeat(12), triggerF = 'f4'.repeat(12);
await Studio.init();
const ownerUser = await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel, name: 'lookfixture' }], plan_tier: 'pro' });
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: foreign, name: 'otherfixture' }], plan_tier: 'pro' });
await redis.hSet(`token:${token}`, { id: channel, login: 'lookfixture', display_name: 'Fixture' });
await redis.hSet(`token:${foreignToken}`, { id: foreign, login: 'otherfixture', display_name: 'Other' });

// Raw library fixtures. Public assets: a successful library delete never reaches S3.
const now = new Date();
const assetDoc = (key, mediaType, mimeType, extra = {}) => ({ ownerUserID: String(ownerUser.insertedId), ownerChannelID: channel, ownerChannelName: 'lookfixture',
  uploadedByUserID: String(ownerUser.insertedId), originalName: key, displayName: key, fileName: key, extension: key.split('.').pop(), mimeType, mediaType, bytes: 100,
  bucket: 'fixture', s3Key: `fixture/trigger-look/${key}`, storageUrl: `https://fixture.invalid/${key}`, proxyPath: null, scope: 'public', marketplaceStatus: 'not_listed',
  libraryCount: 1, triggerReferenceCount: 0, alertReferenceCount: 0, extensionReferenceCount: 0, deletedAt: null, createdAt: now, updatedAt: now, ...extra });
const assets = { gif: assetDoc('party.gif', 'gif', 'image/gif'), png: assetDoc('logo.png', 'image', 'image/png'), video: assetDoc('clip.mp4', 'video', 'video/mp4'),
  audio: assetDoc('boom.mp3', 'audio', 'audio/mpeg'), spare: assetDoc('spare.mp3', 'audio', 'audio/mpeg'), gone: assetDoc('gone.png', 'image', 'image/png', { deletedAt: now }),
  inactive: assetDoc('old.png', 'image', 'image/png'), foreign: assetDoc('foreign.png', 'image', 'image/png', { ownerChannelID: foreign }) };
const assetIds = Object.fromEntries(Object.entries((await MediaAssetSchema.collection.insertMany(Object.values(assets))).insertedIds).map(([i, id]) => [Object.keys(assets)[i], id]));
const itemDoc = (key, extra = {}) => ({ channelID: channel, channelName: 'lookfixture', addedByUserID: String(ownerUser.insertedId), assetID: assetIds[key], relationType: 'owner_upload',
  localAlias: null, quotaBytesCharged: 0, assetScope: 'public', mediaType: assets[key].mediaType, isActive: true, deletedAt: null, createdAt: now, updatedAt: now, ...extra });
const itemKeys = ['gif', 'png', 'video', 'audio', 'spare', 'gone', 'inactive', 'foreign'];
const items = Object.fromEntries(Object.entries((await UserMediaLibraryItemSchema.collection.insertMany(itemKeys.map(key =>
  itemDoc(key, key === 'inactive' ? { isActive: false, deletedAt: now } : key === 'foreign' ? { channelID: foreign } : {})))).insertedIds).map(([i, id]) => [itemKeys[i], String(id)]));
// Playback links are signed: HMAC-SHA256 over `media:<id>` with the candidate's SECRET_KEY, base64url, 22 characters.
assert(process.env.SECRET_KEY, 'the candidate signs media links (SECRET_KEY set in the test env)');
const signed = id => `https://api.domdimabot.com/media/${id}?k=${createHmac('sha256', process.env.SECRET_KEY).update(`media:${id}`).digest('base64url').slice(0, 22)}`;
const playback = key => signed(String(assetIds[key]));
// Library items for the save/delete race (one per round).
const RACE_ROUNDS = 6;
const raceAssets = (await MediaAssetSchema.collection.insertMany(Array.from({ length: RACE_ROUNDS }, (_, i) => assetDoc(`race${i}.mp3`, 'audio', 'audio/mpeg')))).insertedIds;
const raceItems = Object.values((await UserMediaLibraryItemSchema.collection.insertMany(Object.values(raceAssets).map(assetID => ({ ...itemDoc('audio'), assetID })))).insertedIds).map(String);
await TriggerSchema.create([
  { _id: triggerA, name: 'Airhorn', channel: 'lookfixture', channelID: channel, file: 'https://fixture.invalid/airhorn.png', mediaType: 'image/png', volume: 100 },
  { _id: triggerB, name: 'Plain', channel: 'lookfixture', channelID: channel, file: 'https://fixture.invalid/plain.png', mediaType: 'image/png' },
  { _id: triggerC, name: 'Big', channel: 'lookfixture', channelID: channel, file: 'https://fixture.invalid/big.png', mediaType: 'image/png' },
  { _id: triggerF, name: 'Foreign', channel: 'otherfixture', channelID: foreign, file: 'https://fixture.invalid/f.png', mediaType: 'image/png' }
]);

const base = 'http://127.0.0.1:3000';
async function call(method, path, body, expected = 200, auth = token) {
  const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const data = async (...args) => (await call(...args)).data;
const lookPath = id => `/triggers/${channel}/${id}/look`;
const object = (id, kind, extra = {}) => ({ id, kind, x: 10, y: 10, width: 200, height: 120, visible: true, locked: false, ...extra });
const sound = (id, mediaId, extra = {}) => ({ id, mediaId, volume: .8, delay: 0, fadeIn: 0, fadeOut: 0, ...extra });
const body = (layout, revision = 0, size = { width: 800, height: 450 }) => ({ ...size, revision, layout: { duration: 5, widgets: [], ...layout } });
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Empty state, list without looks.
assert.deepEqual(await data('GET', lookPath(triggerA)), { look: null, volume: 100, revision: 0 });
await call('GET', lookPath(triggerF), undefined, 404);
await call('GET', lookPath('nope'), undefined, 404);
await call('GET', `/triggers/${foreign}/${triggerF}/look`, undefined, 403);
assert(!has((await call('GET', `/triggers/${channel}?id=${triggerA}`)).data[0], 'look'), 'triggers without a look have no look key');

// Validation: trigger-media mode, references, limits, revisions. A rejected save never stores anything.
const reject = async (payload, status, code) => { const result = await call('PUT', lookPath(triggerA), payload, status); assert.equal(result.code, code, JSON.stringify(result)); };
await reject(body({ widgets: [object('pic', 'image', { assetId: String(assetIds.png) })] }), 400, 'invalid_look');
await reject(body({ sounds: [{ ...sound('s', items.audio), assetId: String(assetIds.audio) }] }), 400, 'invalid_look');
await reject(body({ widgets: [object('pic', 'image', { mediaId: items.foreign })] }), 400, 'look_media_unavailable');
await reject(body({ widgets: [object('pic', 'image', { mediaId: items.inactive })] }), 400, 'look_media_unavailable');
await reject(body({ widgets: [object('pic', 'image', { mediaId: items.gone })] }), 400, 'look_media_unavailable');
await reject(body({ widgets: [object('pic', 'image', { mediaId: 'f'.repeat(24) })] }), 400, 'look_media_unavailable');
await reject(body({ widgets: [object('clip', 'video', { mediaId: items.audio })] }), 400, 'look_media_kind');
await reject(body({ widgets: [object('pic', 'image', { mediaId: items.video })] }), 400, 'look_media_kind');
await reject(body({ sounds: [sound('s', items.png)] }), 400, 'look_media_kind');
await reject(body({ sounds: Array.from({ length: 11 }, (_, i) => sound('s' + i, items.audio)) }), 400, 'invalid_look');
await reject(body({ sounds: [sound('s', items.audio), sound('s', items.spare)] }), 400, 'invalid_look');
await reject(body({ widgets: [object('t', 'text', { text: '$(nosuchfunction)' })] }), 400, 'invalid_look');
await reject(body({ widgets: [object('x', 'tts')] }), 400, 'invalid_look');
await reject(body({ widgets: [object('pic', 'image', { mediaId: items.png, volume: .5 })] }), 400, 'invalid_look');
await reject(body({}, 0, { width: 50, height: 450 }), 400, 'invalid_look');
await reject({ ...body({}), revision: -1 }, 400, 'invalid_look');
await reject({ ...body({}), revision: '0' }, 400, 'invalid_look');
await reject(body({}, 3), 409, 'look_conflict');
// Size: keyframes make large but valid objects. ~150 kB is accepted, more than 256 kB serialized is refused (400),
// and a body above the route's own parser limit is refused by the parser (413).
const points = Array.from({ length: 24 }, (_, i) => ({ offset: i / 23, value: i === 0 || i === 23 ? 0 : Number((i / 37).toFixed(15)), easing: 'smooth' }));
const tracks = ['x', 'y', 'scale', 'rotation', 'opacity'].map(property => ({ property, points }));
const heavy = i => object('heavy' + i, 'text', { text: 'Thanks $(user)! ' + 'x'.repeat(1400), motion: { enter: 'fade', exit: 'fade', loop: 'none', delay: 0, enterDuration: .5, exitDuration: .5, loopDuration: 2 },
  keyframes: { enter: { tracks }, loop: { tracks }, exit: { tracks } } });
const sized = min => { const widgets = []; while (JSON.stringify(body({ widgets })).length < min) widgets.push(heavy(widgets.length)); return body({ widgets }); };
const large = sized(150_000), tooLarge = sized(270_000), huge = sized(340_000);
assert(JSON.stringify(large).length < 200_000 && JSON.stringify(tooLarge).length < 320 * 1024, 'fixture sizes');
const bigSaved = await data('PUT', lookPath(triggerC), large);
assert.equal(bigSaved.look.revision, 1); assert.equal(bigSaved.revision, 1); assert.equal(bigSaved.look.layout.widgets.length, large.layout.widgets.length);
assert.equal((await call('PUT', lookPath(triggerC), { ...tooLarge, revision: 1 }, 400)).code, 'look_too_large');
await call('PUT', lookPath(triggerC), { ...huge, revision: 1 }, 413);
await data('DELETE', lookPath(triggerC) + '?revision=1');
assert.deepEqual(await data('GET', lookPath(triggerA)), { look: null, volume: 100, revision: 0 }, 'rejected saves store nothing (the counter does not move)');
console.log('PASS look validation: assetId refused, foreign/inactive/deleted/missing media and kind mismatches refused, sound limits and ids, text templates, design-only kinds, A2 placement, canvas, revision type and conflicts, 150 kB accepted, >256 kB refused (400), parser limit (413)');

// Save, read back, conflicts, summary.
const layout = {
  duration: 6,
  widgets: [object('party', 'image', { mediaId: items.gif, mediaUrl: 'https://evil.invalid/x.gif', unavailable: true }), object('logo', 'image', { mediaId: items.png }),
    object('clip', 'video', { mediaId: items.video, volume: .5, loop: false }), object('silent', 'video', { mediaId: items.video, volume: 0 }),
    object('title', 'text', { text: '$(user) sent a trigger', motion: { enter: 'zoom', exit: 'fade', loop: 'pulse', delay: .2, enterDuration: .4, exitDuration: .4, loopDuration: 1, end: 5 } }),
    object('box', 'shape', { color: '#112233' })],
  sounds: [sound('boom', items.audio, { url: 'https://evil.invalid/a.mp3', end: 3 }), sound('tail', items.spare, { delay: 1, volume: .5 })],
  sound: sound('legacy', items.audio)
};
let saved = await data('PUT', lookPath(triggerA), { width: 900, height: 500, revision: 0, layout });
assert.equal(saved.volume, 100); assert.equal(saved.look.revision, 1); assert.equal(saved.revision, 1); assert.equal(saved.look.width, 900);
assert.deepEqual(saved.look.mediaIds, [items.gif, items.png, items.video, items.audio, items.spare]);
const editorObjects = Object.fromEntries(saved.look.layout.widgets.map(w => [w.id, w]));
assert.equal(editorObjects.party.mediaUrl, playback('gif')); assert.equal(editorObjects.party.mediaType, 'gif'); assert(!has(editorObjects.party, 'unavailable'));
assert.equal(editorObjects.logo.mediaType, 'image'); assert.equal(editorObjects.clip.mediaType, 'video'); assert.equal(editorObjects.clip.volume, .5); assert.equal(editorObjects.clip.loop, false);
assert.equal(editorObjects.silent.volume, 0);
assert.deepEqual(saved.look.layout.sounds, [{ ...sound('boom', items.audio, { end: 3 }), url: playback('audio'), mediaType: 'audio' }, { ...sound('tail', items.spare, { delay: 1, volume: .5 }), url: playback('spare'), mediaType: 'audio' }]);
assert(!has(saved.look.layout, 'sound'), 'looks are sounds-only');
const storedDoc = await TriggerSchema.findById(triggerA).lean();
assert(!has(storedDoc.look.layout.widgets[0], 'mediaUrl') && !has(storedDoc.look.layout.sounds[0], 'url'), 'playback URLs are never stored');
assert(storedDoc.look.updatedAt instanceof Date);
await reject({ width: 900, height: 500, revision: 0, layout }, 409, 'look_conflict');
saved = await data('PUT', lookPath(triggerA), { width: 900, height: 500, revision: 1, layout: saved.look.layout });
assert.equal(saved.look.revision, 2); assert.equal(saved.revision, 2); assert.deepEqual(saved.look.mediaIds, [items.gif, items.png, items.video, items.audio, items.spare], 'editor form round-trips');
await reject({ width: 900, height: 500, revision: 1, layout }, 409, 'look_conflict');
assert.deepEqual(await data('GET', lookPath(triggerA)), saved);
const listed = (await call('GET', `/triggers/${channel}`)).data;
const summaryA = listed.find(t => t._id === triggerA).look;
assert.deepEqual(summaryA, { revision: 2, width: 900, height: 500, updatedAt: saved.look.updatedAt, mediaIds: [items.gif, items.png, items.video, items.audio, items.spare], objectCount: 6, soundCount: 2 });
assert(!has(listed.find(t => t._id === triggerB), 'look'));
const patched = (await call('PATCH', `/triggers/${channel}/${triggerA}`, { volume: 50 })).data;
assert.deepEqual(patched.look, summaryA, 'update responses carry the summary only'); assert.equal(patched.volume, 50);
console.log('PASS look save/read: editor form (resolved, signed URLs, media types, A2 fields), sounds-only, no stored URLs, conditional revisions (409), list/update summaries with mediaIds');

// Render route (editor preview of text objects): a sample viewer, `user` or Luna.
assert.deepEqual(await data('POST', `/triggers/${channel}/look/render`, { texts: ['$(user) sent a trigger', 'plain', 7] }), ['Luna sent a trigger', 'plain', '']);
assert.deepEqual(await data('POST', `/triggers/${channel}/look/render`, { texts: ['$(user) sent a trigger'], user: ' Ada ' }), ['Ada sent a trigger']);
assert.deepEqual(await data('POST', `/triggers/${channel}/look/render`, { texts: ['$(user)'], user: 'x'.repeat(100) }), ['x'.repeat(64)], 'user is cut to 64 characters');
assert.deepEqual(await data('POST', `/triggers/${channel}/look/render`, { texts: ['$(user)'], user: { name: 'Ada' } }), ['Luna'], 'a non-string user is ignored');
await call('POST', `/triggers/${channel}/look/render`, { texts: Array(101).fill('x') }, 400);
await call('POST', `/triggers/${channel}/look/render`, { texts: ['$(nosuchfunction)'] }, 400);
await call('POST', `/triggers/${channel}/look/render`, { texts: ['x'] }, 403, foreignToken);
await call('PUT', lookPath(triggerA), { ...saved.look, revision: 2 }, 403, foreignToken);

// Library item delete is refused while a look uses the item (same 400 as today's in-use).
const inUse = await call('DELETE', `/triggers/library/${channel}/${items.spare}`, undefined, 400);
assert.equal(inUse.message, 'Media is in use by one or more triggers');

// Delivery: a published overlay with a trigger widget, the Studio peer and an old trigger page.
const studio = '/overlay-studio/' + channel;
let state = await data('GET', studio);
state = await data('POST', `${studio}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
const scene = state.scenes[0];
async function until(predicate, message) { for (let i = 0; i < 160; i++) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 30)); } throw new Error(message); }
function socket(ns, auth) {
  const messages = [], ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
  ws.addEventListener('message', event => { const raw = String(event.data); if (raw.startsWith('0')) ws.send(`40${ns},${JSON.stringify(auth)}`); else if (raw === '2') ws.send('3'); else if (raw.startsWith(`42${ns},`)) messages.push(JSON.parse(raw.slice(raw.indexOf(',') + 1))); else if (raw.startsWith(`40${ns},`)) messages.push(['connected']); });
  return { ws, messages, ns };
}
const peer = socket('/overlay-studio/' + scene.publicId, { clientId: crypto.randomUUID() });
await until(() => peer.messages.some(m => m[0] === 'overlay-state'), 'Studio peer ready');
const oldPage = socket(`/overlays/triggers/${channel}`, {});
await until(() => oldPage.messages.some(m => m[0] === 'connected'), 'old trigger page connected');
const events = () => peer.messages.filter(m => m[0] === 'overlay-event').map(m => m[1]);
const detail = id => data('GET', `/overlay-studio/public/${scene.publicId}/events/${id}`, undefined, 200, '');
const ack = id => peer.ws.send(`42${peer.ns},${JSON.stringify(['overlay-ended', id])}`);
// Look data in a request body is never trusted, and the old page gets exactly what was sent.
const sendBody = { url: 'https://fixture.invalid/airhorn.png', mediaType: 'image/png', volume: 50, name: 'Body name', triggerId: triggerA, hasLook: false, look: { width: 1, height: 1, layout: { duration: 1, widgets: [] } } };
await call('POST', `/triggers/${channel}/send`, sendBody);
const first = await until(() => events()[0], 'look event');
assert.equal(first.hasLook, true, 'the server marks the event from the stored trigger'); assert.equal(first.triggerId, triggerA); assert(!has(first, 'look'));
await until(() => oldPage.messages.some(m => m[0] === 'trigger'), 'old page trigger');
assert.deepEqual(oldPage.messages.find(m => m[0] === 'trigger')[1], sendBody, 'the old trigger page payload is unchanged');
let full = await detail(first.id);
assert.deepEqual(full.media, { type: 'image', url: sendBody.url, title: 'Airhorn', volume: .5 }, 'media stays exactly as today');
assert.equal(full.look.width, 900); assert.equal(full.look.height, 500); assert(!has(full.look, 'revision') && !has(full.look, 'mediaIds'));
const played = Object.fromEntries(full.look.layout.widgets.map(w => [w.id, w]));
assert.equal(played.party.mediaUrl, playback('gif')); assert.equal(played.logo.mediaUrl, playback('png')); assert.equal(played.clip.mediaUrl, playback('video'));
assert.equal(played.clip.volume, .25, 'master volume 50 scales timed videos'); assert.equal(played.silent.volume, 0); assert(has(played.silent, 'volume'), 'a silent timed video keeps volume');
assert.equal(played.title.text, 'Viewer sent a trigger', 'text templates are rendered'); assert.equal(played.title.motion.end, 5);
for (const w of full.look.layout.widgets) assert(!has(w, 'mediaType') && !has(w, 'unavailable'));
assert.deepEqual(full.look.layout.sounds.map(s => [s.id, s.url, s.volume]), [['boom', playback('audio'), .4], ['tail', playback('spare'), .25]], 'master volume scales every sound');
// A trigger without a look, and a send without trigger identity, carry no marker and no look.
await call('POST', `/triggers/${channel}/send`, { ...sendBody, triggerId: triggerB });
await call('POST', `/triggers/${channel}/send`, { url: sendBody.url, mediaType: 'image/png', hasLook: true });
await until(() => events().length === 3, 'plain events');
for (const event of events().slice(1)) { assert(!has(event, 'hasLook')); const plain = await detail(event.id); assert(!has(plain, 'look')); assert.equal(plain.media.url, sendBody.url); }
// Resolution happens per request: an item that became unavailable drops its object; volume edits apply.
await UserMediaLibraryItemSchema.updateOne({ _id: items.gif }, { $set: { isActive: false, deletedAt: new Date() } });
await MediaAssetSchema.collection.updateOne({ _id: assetIds.spare }, { $set: { deletedAt: new Date() } });
full = await detail(first.id);
assert.deepEqual(full.look.layout.widgets.map(w => w.id), ['logo', 'clip', 'silent', 'title', 'box'], 'the unavailable object is dropped');
assert.deepEqual(full.look.layout.sounds.map(s => s.id), ['boom'], 'the unavailable sound is dropped');
const editor = await data('GET', lookPath(triggerA));
assert.equal(editor.look.layout.widgets.find(w => w.id === 'party').unavailable, true); assert.equal(editor.look.layout.sounds.find(s => s.id === 'tail').unavailable, true);
await reject({ width: 900, height: 500, revision: 2, layout: editor.look.layout }, 400, 'look_media_unavailable');
// A stale editor whose old layout uses a removed file gets the conflict, not a media error.
await reject({ width: 900, height: 500, revision: 1, layout: editor.look.layout }, 409, 'look_conflict');
await MediaAssetSchema.collection.updateOne({ _id: assetIds.spare }, { $set: { deletedAt: null } });
// Deleting the look (wrong revision first) falls back to media for an event already sent.
assert.equal((await call('DELETE', lookPath(triggerA) + '?revision=1', undefined, 409)).code, 'look_conflict');
await call('DELETE', lookPath(triggerA) + '?revision=x', undefined, 400);
assert.deepEqual(await data('DELETE', lookPath(triggerA) + '?revision=2'), { look: null, volume: 50, revision: 3 }, 'a delete moves the counter');
full = await detail(first.id); assert(!has(full, 'look'), 'a deleted look falls back'); assert.equal(full.media.url, sendBody.url);
await call('DELETE', lookPath(triggerA) + '?revision=0', undefined, 409);
assert.deepEqual(await data('GET', lookPath(triggerA)), { look: null, volume: 50, revision: 3 }, 'the counter never goes back after a delete');
// Stale tabs after delete + recreate: the counter keeps going, so a tab from before is still refused.
const staleTab = await data('PUT', lookPath(triggerB), body({ sounds: [sound('boom', items.audio)] }, 0));
assert.equal(staleTab.revision, 1);
assert.equal((await data('DELETE', lookPath(triggerB) + '?revision=1')).revision, 2);
const recreated = await data('PUT', lookPath(triggerB), body({ widgets: [object('logo', 'image', { mediaId: items.png })] }, 2));
assert.equal(recreated.revision, 3); assert.equal(recreated.look.revision, 3);
assert.equal((await call('PUT', lookPath(triggerB), body({ sounds: [sound('boom', items.audio)] }, 1), 409)).code, 'look_conflict', 'stale PUT after delete + recreate');
assert.equal((await call('DELETE', lookPath(triggerB) + '?revision=1', undefined, 409)).code, 'look_conflict', 'stale DELETE after delete + recreate');
assert.deepEqual((await data('GET', lookPath(triggerB))).look.layout.widgets.map(w => w.id), ['logo'], 'the recreated look is untouched');
assert.deepEqual(await data('DELETE', lookPath(triggerB) + '?revision=3'), { look: null, volume: 100, revision: 4 });
assert(!has((await call('GET', `/triggers/${channel}?id=${triggerA}`)).data[0], 'look'));
for (const event of events()) ack(event.id);
// Not referenced any more: the library item delete goes through now.
await call('DELETE', `/triggers/library/${channel}/${items.spare}`);
// Save vs library delete of the same item, at the same time: never both (a saved look pointing at a deleted item).
async function attempt(method, path, payload) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, json: await response.json() };
}
let raceSaves = 0, raceDeletes = 0;
for (const [round, item] of raceItems.entries()) {
  const { revision } = await data('GET', lookPath(triggerC));
  const save = attempt('PUT', lookPath(triggerC), body({ sounds: [sound('race', item)] }, revision));
  const remove = attempt('DELETE', `/triggers/library/${channel}/${item}`);
  const [saveResult, removeResult] = round % 2 ? (await Promise.all([remove, save])).reverse() : await Promise.all([save, remove]);
  assert(!(saveResult.status === 200 && removeResult.status === 200), `round ${round}: save and delete both succeeded`);
  const active = await UserMediaLibraryItemSchema.exists({ _id: item, isActive: true });
  if (saveResult.status === 200) {
    raceSaves++; assert.equal(removeResult.status, 400); assert(active, 'a saved look keeps its item');
    await data('DELETE', lookPath(triggerC) + `?revision=${saveResult.json.data.revision}`);
  } else {
    raceDeletes++; assert.equal(saveResult.json.code, 'look_media_unavailable', JSON.stringify(saveResult.json)); assert.equal(removeResult.status, 200); assert(!active);
  }
}
assert.equal(raceSaves + raceDeletes, RACE_ROUNDS);
console.log(`PASS save/delete race: ${RACE_ROUNDS} rounds, never both (${raceSaves} saves won, ${raceDeletes} deletes won)`);
console.log('PASS delivery: server-side marker (body look ignored), unchanged old-page payload and media, resolved look with URLs/master volume/rendered text, no look without one, per-request resolution drops unavailable media, deleted look falls back, library delete after removal');

// A deleted trigger falls back too (no 500).
const audioOnly = { width: 640, height: 360, revision: 0, layout: { duration: 4, widgets: [object('logo', 'image', { mediaId: items.png })], sounds: [sound('boom', items.audio)] } };
await data('PUT', lookPath(triggerA), { ...audioOnly, revision: (await data('GET', lookPath(triggerA))).revision });
await call('POST', `/triggers/${channel}/send`, { ...sendBody, triggerId: triggerA });
const doomed = await until(() => events()[3], 'event before delete');
assert.equal(doomed.hasLook, true); assert.equal((await detail(doomed.id)).look.layout.sounds[0].volume, .4);
await TriggerSchema.deleteOne({ _id: triggerA });
full = await detail(doomed.id); assert(!has(full, 'look')); assert.equal(full.media.title, 'Airhorn');
ack(doomed.id);
await TriggerSchema.create({ _id: triggerA, name: 'Airhorn', channel: 'lookfixture', channelID: channel, file: 'https://fixture.invalid/airhorn.png', mediaType: 'image/png', volume: 0 });
await data('PUT', lookPath(triggerA), audioOnly);

// Studio tests: an explicit trigger, the look in previews, the marker for OBS tests.
const test = async (payload, expected = 200) => { await redis.del('overlay:test:' + channel); return data('POST', `${studio}/test`, payload, expected); };
let preview = await test({ kind: 'trigger', destination: 'preview', triggerId: triggerA });
assert.equal(preview.triggerId, triggerA); assert.equal(preview.media.volume, 0);
assert.equal(preview.look.width, 640); assert.equal(preview.look.layout.widgets[0].mediaUrl, playback('png'));
assert.equal(preview.look.layout.sounds[0].volume, 0, 'trigger volume 0 silences the look');
preview = await test({ kind: 'trigger', destination: 'preview', triggerId: triggerB });
assert.equal(preview.triggerId, triggerB); assert(!has(preview, 'look'));
await test({ kind: 'trigger', destination: 'preview', triggerId: triggerA, triggerIds: [triggerB] }, 404);
await test({ kind: 'trigger', destination: 'preview', triggerId: triggerF }, 404);
await test({ kind: 'trigger', destination: 'preview', triggerId: 'bad' }, 400);
const before = events().length;
const sent = await test({ kind: 'trigger', destination: 'obs', confirmed: true, sceneId: scene.id, triggerId: triggerA });
assert.equal(sent.clients, 1);
const obsTest = await until(() => events()[before], 'OBS test event');
assert.equal(obsTest.triggerId, triggerA); assert.equal(obsTest.hasLook, true);
assert.equal((await detail(obsTest.id)).look.width, 640);
ack(obsTest.id);
await redis.del('overlay:test:' + channel);
console.log('PASS deleted trigger falls back; Studio tests honour triggerId within the filter, previews return the resolved look, OBS tests carry the marker');

// Who fired it: `$(user)` in a look's text is the send's sanitised firedBy, kept with the pending delivery; nobody known is Viewer.
const triggerD = 'd5'.repeat(12), triggerE = 'e6'.repeat(12);
await TriggerSchema.create([
  { _id: triggerD, name: 'Greeter', channel: 'lookfixture', channelID: channel, file: 'https://fixture.invalid/greeter.png', mediaType: 'image/png', volume: 100 },
  { _id: triggerE, name: 'Library', channel: 'lookfixture', channelID: channel, file: 'clip.mp4', mediaType: 'video/mp4', volume: 80, libraryItemID: items.video, assetID: assetIds.png }
]);
await data('PUT', lookPath(triggerD), body({ widgets: [object('hi', 'text', { text: '$(user) fired it' })] }));
const viewerId = crypto.randomUUID();
let viewerPeer = socket('/overlay-studio/' + scene.publicId, { clientId: viewerId });
await until(() => viewerPeer.messages.some(m => m[0] === 'overlay-state'), 'second Studio peer ready');
const viewerEvents = () => viewerPeer.messages.filter(m => m[0] === 'overlay-event').map(m => m[1]);
const greeterBody = { url: 'https://fixture.invalid/greeter.png', mediaType: 'image/png', volume: 100, name: 'Greeter', triggerId: triggerD };
const fire = async extra => {
  const count = viewerEvents().length, pageCount = oldPage.messages.filter(m => m[0] === 'trigger').length;
  await call('POST', `/triggers/${channel}/send`, { ...greeterBody, ...extra });
  const event = await until(() => viewerEvents()[count], 'greeter event');
  await until(() => oldPage.messages.filter(m => m[0] === 'trigger').length > pageCount, 'old page greeter');
  return { event, page: oldPage.messages.filter(m => m[0] === 'trigger').at(-1)[1] };
};
const greeting = async event => { const shown = await detail(event.id); assert(!has(shown, 'raw'), 'event data is never exposed as such'); assert.deepEqual(shown.layouts, {}); return shown.look.layout.widgets.find(w => w.id === 'hi').text; };
const named = await fire({ firedBy: { id: '42', login: 'ada', name: 'Ada' } });
assert.equal(named.event.hasLook, true); assert(!has(named.event, 'raw'));
assert.equal(await greeting(named.event), 'Ada fired it');
assert.deepEqual(named.page, { ...greeterBody, firedBy: { id: '42', login: 'ada', name: 'Ada' } }, 'the old page gets the caller body (legacy trigger: caller url kept)');
assert.equal((await detail(named.event.id)).media.url, greeterBody.url, 'a legacy trigger without an asset keeps the caller url');
const stored = await mongo.connection.db.collection('overlay_deliveries').findOne({ _id: named.event.id });
assert.deepEqual(stored.raw, { user_id: '42', user_login: 'ada', user_name: 'Ada' }, 'stored with the pending delivery');
assert.equal(await greeting((await fire({})).event), 'Viewer fired it');
assert.equal(await greeting((await fire({ firedBy: { login: ' ada ' } })).event), 'ada fired it');
const hostile = [
  [{ name: { first: 'Ada' }, login: ['ada'], id: 42 }, 'Viewer fired it'],
  ['Ada', 'Viewer fired it'], [['Ada'], 'Viewer fired it'], [null, 'Viewer fired it'], [7, 'Viewer fired it'],
  [{ name: 'x'.repeat(5000), id: '9'.repeat(5000) }, `${'x'.repeat(64)} fired it`],
  [{ name: 'A\u0000d\u0007a\n\u202E' }, 'Ada fired it'],
  [{ name: '<img src=x onerror=alert(1)>' }, '<img src=x onerror=alert(1)> fired it'],
  [{ name: '$(touser)' }, '$(touser) fired it'],
  [{ name: '   ', login: '\u0001' }, 'Viewer fired it']
];
for (const [firedBy, expected] of hostile) assert.equal(await greeting((await fire({ firedBy })).event), expected, JSON.stringify(firedBy).slice(0, 80));
// A trigger without a look keeps no event data (custom widgets and plain playback are unchanged).
await call('POST', `/triggers/${channel}/send`, { ...greeterBody, triggerId: triggerB, firedBy: { name: 'Ada' } });
const plainSent = await until(() => viewerEvents().find(e => e.triggerId === triggerB), 'plain trigger event');
assert.equal((await mongo.connection.db.collection('overlay_deliveries').findOne({ _id: plainSent.id })).raw, undefined, 'no look: no event data stored');
// Reconnect with the same client: the pending delivery comes back and still shows the name.
viewerPeer.ws.close();
await new Promise(r => setTimeout(r, 300));
viewerPeer = socket('/overlay-studio/' + scene.publicId, { clientId: viewerId });
const resumedState = await until(() => viewerPeer.messages.find(m => m[0] === 'overlay-state'), 'reconnected Studio peer');
assert(resumedState[1].pendingIds.includes(named.event.id), 'the pending delivery survives the reconnect');
await until(() => viewerEvents().some(e => e.id === named.event.id), 'replayed event');
assert.equal(await greeting(named.event), 'Ada fired it', 'same text after the reconnect');
console.log('PASS who fired it: firedBy renders in the look text, Viewer without it, hostile values sanitised or ignored (never an error), stored with the delivery, survives a reconnect, no data without a look');

// Studio tests use a sample viewer (`user`, default Luna), in previews and in OBS.
let greeterPreview = await test({ kind: 'trigger', destination: 'preview', triggerId: triggerD });
assert.equal(greeterPreview.look.layout.widgets[0].text, 'Luna fired it');
greeterPreview = await test({ kind: 'trigger', destination: 'preview', triggerId: triggerD, user: 'Ada' });
assert.equal(greeterPreview.look.layout.widgets[0].text, 'Ada fired it');
const beforeObs = viewerEvents().length;
await test({ kind: 'trigger', destination: 'obs', confirmed: true, sceneId: scene.id, triggerId: triggerD, user: 'Ada' });
const obsGreeting = await until(() => viewerEvents().slice(beforeObs).find(e => e.triggerId === triggerD), 'OBS greeter test');
assert.equal(await greeting(obsGreeting), 'Ada fired it');
const beforeDefault = viewerEvents().length;
await test({ kind: 'trigger', destination: 'obs', confirmed: true, sceneId: scene.id, triggerId: triggerD });
assert.equal(await greeting(await until(() => viewerEvents().slice(beforeDefault).find(e => e.triggerId === triggerD), 'OBS default test')), 'Luna fired it');
await redis.del('overlay:test:' + channel);
console.log('PASS Studio tests: preview and OBS looks show the sample viewer (Luna) and honour user');

// A known trigger plays its own file: the server-built signed URL and MIME type reach both the Studio event and the old page.
const pagesBefore = oldPage.messages.filter(m => m[0] === 'trigger').length;
const bogus = { url: 'https://evil.invalid/x.png', mediaType: 'image/png', volume: 80, name: 'Body name', triggerId: triggerE };
await call('POST', `/triggers/${channel}/send`, bogus);
const libraryEvent = await until(() => viewerEvents().find(e => e.triggerId === triggerE), 'library trigger event');
assert.deepEqual(libraryEvent.media, { type: 'video', url: playback('video'), title: 'Library', volume: .8 }, 'library item first, signed, its MIME type');
assert.deepEqual((await detail(libraryEvent.id)).media, libraryEvent.media);
await until(() => oldPage.messages.filter(m => m[0] === 'trigger').length > pagesBefore, 'old page library trigger');
assert.deepEqual(oldPage.messages.filter(m => m[0] === 'trigger').at(-1)[1], { ...bogus, url: playback('video'), mediaType: 'video/mp4' }, 'the old page gets the server URL too');
// Library item gone: the trigger's own asset; then nothing resolvable: the caller's values.
await UserMediaLibraryItemSchema.updateOne({ _id: items.video }, { $set: { isActive: false, deletedAt: new Date() } });
await call('POST', `/triggers/${channel}/send`, bogus);
const assetEvent = await until(() => viewerEvents().filter(e => e.triggerId === triggerE)[1], 'asset trigger event');
assert.deepEqual([assetEvent.media.type, assetEvent.media.url], ['image', playback('png')]);
await TriggerSchema.updateOne({ _id: triggerE }, { $unset: { assetID: '', libraryItemID: '' } });
await call('POST', `/triggers/${channel}/send`, bogus);
const legacyEvent = await until(() => viewerEvents().filter(e => e.triggerId === triggerE)[2], 'legacy trigger event');
assert.equal(legacyEvent.media.url, bogus.url, 'no resolvable asset: the caller url as today');
await until(() => oldPage.messages.filter(m => m[0] === 'trigger').length >= pagesBefore + 3, 'old page legacy');
assert.deepEqual(oldPage.messages.filter(m => m[0] === 'trigger').at(-1)[1], bogus);
console.log('PASS /send resolves the trigger file server-side: signed URL + MIME for the Studio event and the old page, asset fallback, legacy caller values');

for (const event of [...events(), ...viewerEvents()]) { ack(event.id); viewerPeer.ws.send(`42${viewerPeer.ns},${JSON.stringify(['overlay-ended', event.id])}`); }
viewerPeer.ws.close();
peer.ws.close(); oldPage.ws.close();
await mongo.connection.close(); redis.destroy();
process.exit(0);
