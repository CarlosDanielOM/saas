// Client versions and the compatibility-code report (overlays/client-versions.ts, overlays/compat.ts) on the actual API.
// saas-ops only (api target), disposable databases:
//   scripts/saas-ops verify api-<run> --dependency mongo --dependency redis \
//     --test-env ops/checks/overlay-fixtures/test-env.json --fixtures ops/checks/overlay-fixtures \
//     --check ops/checks/client-versions-api.mjs
// Covers: an OBS page from before protocols (no protocol/build) and a current one (protocol 1 + build) are recorded and
// shown per source in the Studio's OBS diagnostics (outdated flag); Studio saves record the editor version (writer,
// build); the owner-only report starts as "collecting", turns "needed" while an old page was seen in the last 14 days
// and "removable" after; the overview's attention list counts removable entries; non-owners are refused.
import assert from 'node:assert/strict';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('client-versions-check'); const redis = await getDragonflyClient('client-versions-check');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { ClientVersion } = await import('/app/dist/overlays/client-versions.js');
const { COMPAT_ENTRIES } = await import('/app/dist/overlays/compat.js');
const { OVERLAY_PROTOCOL } = await import('/app/dist/overlays/protocol.js');
const base = 'http://127.0.0.1:3000', owner = '533538623', DAY = 86_400_000;
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: owner }], plan_tier: 'pro', language: 'en' });
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: '700000077' }], plan_tier: 'free' });
await redis.hSet('token:versions-owner', { id: owner, login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:versions-other', { id: '700000077', login: 'other', display_name: 'Other' });
async function call(path, { method = 'GET', body, token = 'versions-owner', status = 200 } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data.data;
}
const rows = async () => (await ClientVersion.find({}).lean()).map(row => row._id).sort();

// A published overlay, then two OBS pages: one from before protocols, one current.
let studio = await call(`/overlay-studio/${owner}`);
studio = await call(`/overlay-studio/${owner}/scenes/${studio.scenes[0].id}/publish`, { method: 'POST', body: { revision: studio.revision } });
const publicId = studio.scenes[0].publicId;
function connect(auth) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket'), messages = [], ns = `/overlay-studio/${publicId}`;
  ws.addEventListener('message', event => { const m = String(event.data); if (m.startsWith('0')) ws.send(`40${ns},${JSON.stringify(auth)}`); else if (m === '2') ws.send('3'); else messages.push(m); });
  const wait = async predicate => { for (let i = 0; i < 160; i++) { if (messages.some(predicate)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Socket timeout: ' + JSON.stringify(messages).slice(0, 400)); };
  return { ws, wait };
}
const old = connect({ clientId: crypto.randomUUID() });
const current = connect({ clientId: crypto.randomUUID(), protocol: OVERLAY_PROTOCOL, build: 'main-CHECK1234' });
await old.wait(m => m.includes('overlay-state')); await current.wait(m => m.includes('overlay-state'));
for (let i = 0; i < 60 && (await rows()).length < 2; i++) await new Promise(r => setTimeout(r, 100));
assert.deepEqual(await rows(), [`overlay|0|before-protocol`, `overlay|${OVERLAY_PROTOCOL}|main-CHECK1234`]);
const sources = (await call(`/overlay-studio/${owner}/connections`)).scenes.find(scene => scene.id === studio.scenes[0].id).sources;
assert.equal(sources.length, 2);
assert.deepEqual(sources.map(s => [s.protocol, s.build, s.outdated]).sort(), [[0, 'before-protocol', true], [OVERLAY_PROTOCOL, 'main-CHECK1234', false]]);
console.log('PASS OBS pages: old and current versions recorded once and shown per source (outdated flag) in the Studio diagnostics.');

// Studio saves: the current editor (writer 2 + build) and an old tab without a writer.
studio = await call(`/overlay-studio/${owner}`);
studio = await call(`/overlay-studio/${owner}`, { method: 'PUT', body: { ...studio, writer: 2, build: 'main-CHECK1234' } });
await call(`/overlay-studio/${owner}`, { method: 'PUT', body: { ...studio } });
for (let i = 0; i < 60 && (await rows()).length < 4; i++) await new Promise(r => setTimeout(r, 100));
assert.deepEqual((await rows()).filter(id => id.startsWith('studio|')), ['studio|0|before-protocol', 'studio|2|main-CHECK1234']);
console.log('PASS Studio saves record the editor version (writer) and the site build.');

// The report: owner only; everything "collecting" on the first day.
await call('/admin-site/client-versions', { token: 'versions-other', status: 403 });
let report = await call('/admin-site/client-versions');
assert.deepEqual(report.current, { overlay: OVERLAY_PROTOCOL, studio: 2 });
assert.equal(report.quietDays, 14);
assert.deepEqual(report.entries.map(e => e.id), COMPAT_ENTRIES.map(e => e.id));
assert.ok(report.entries.every(e => e.state === 'collecting' && e.code.length && e.summary), JSON.stringify(report.entries.map(e => e.state)));
assert.equal(report.versions.find(v => v.build === 'main-CHECK1234' && v.client === 'overlay').connectedNow, 1);
assert.equal(report.versions.find(v => v.build === 'before-protocol' && v.client === 'overlay').outdated, true);
// Tracking began 20 days ago and an old OBS page was seen 2 days ago: needed. (The connected pages' rows are not
// rewritten for 10 minutes, so these backdated rows stand.)
await ClientVersion.updateMany({}, { $set: { firstSeenAt: new Date(Date.now() - 20 * DAY) } });
await ClientVersion.updateOne({ _id: 'overlay|0|before-protocol' }, { $set: { lastSeenAt: new Date(Date.now() - 2 * DAY) } });
await ClientVersion.updateOne({ _id: 'studio|0|before-protocol' }, { $set: { lastSeenAt: new Date(Date.now() - 2 * DAY) } });
report = await call('/admin-site/client-versions');
assert.ok(report.entries.every(e => e.state === 'needed'), JSON.stringify(report.entries.map(e => [e.id, e.state])));
assert.ok(report.entries.every(e => Math.abs(Date.parse(e.removableFrom) - (Date.now() + 12 * DAY)) < 60_000));
// Old OBS pages last seen 15 days ago: the overlay entries can go; the old editor (2 days) still needs its code.
await ClientVersion.updateOne({ _id: 'overlay|0|before-protocol' }, { $set: { lastSeenAt: new Date(Date.now() - 15 * DAY) } });
report = await call('/admin-site/client-versions');
const removable = report.entries.filter(e => e.state === 'removable').map(e => e.id).sort();
assert.deepEqual(removable, COMPAT_ENTRIES.filter(e => e.client === 'overlay').map(e => e.id).sort());
assert.equal(report.entries.find(e => e.client === 'studio').state, 'needed');
const overview = await call('/admin-site/overview');
assert.deepEqual(overview.attention.find(item => item.key === 'compat_removable'), { key: 'compat_removable', count: removable.length });
console.log('PASS report: owner only, collecting → needed → removable per client kind, removable count in the overview attention list.');
old.ws.close(); current.ws.close();
console.log('PASS client versions API');
process.exit(0);
