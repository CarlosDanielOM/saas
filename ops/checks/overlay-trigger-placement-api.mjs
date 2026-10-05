// Real candidate API; all writes target the helper's disposable Mongo/Redis.
import assert from 'node:assert/strict';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { Studio } = await import('/app/dist/overlays/store.js');
const mongo = await getMongoDBConnection('placement-check'), redis = await getDragonflyClient('placement-check');
const channel = '990291', token = 'placement-owner-fixture', root = `/overlay-studio/${channel}`;
await Studio.init();
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'free' });
await redis.hSet(`token:${token}`, { id: channel, login: 'placementfixture', display_name: 'Fixture' });
async function request(method, path, body, status = 200) {
  const response = await fetch('http://127.0.0.1:3000' + path, { method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await response.json(); assert.equal(response.status, status, JSON.stringify(envelope)); return envelope.data;
}
let state = await request('GET', root);
const trigger = state.scenes[0].widgets.find(w => w.kind === 'trigger');
assert.equal(trigger.triggerPlacement, undefined, 'old widgets remain fixed without a migration');
for (const invalid of [null, true, 'random', {}, { mode: 'other', margin: 24 }, { mode: 'random' },
  { mode: 'random', margin: '24' }, { mode: 'random', margin: -1 }, { mode: 'random', margin: 501 }]) {
  const draft = structuredClone(state); draft.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement = invalid;
  await request('PUT', root, draft, 400);
}
for (const kind of ['tts', 'clip', 'alert']) {
  const draft = structuredClone(state); draft.scenes[0].widgets.find(w => w.kind === kind).triggerPlacement = { mode: 'random', margin: 24 };
  await request('PUT', root, draft, 400);
}
const nested = structuredClone(state); nested.designs[0].events.follow.widgets[0].triggerPlacement = { mode: 'random', margin: 24 };
await request('PUT', root, nested, 400);
for (const placement of [{ mode: 'fixed', margin: 0 }, { mode: 'random', margin: 24 }, { mode: 'random', margin: 500 }]) {
  const draft = structuredClone(state); draft.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement = { ...placement, ignored: true };
  state = await request('PUT', root, draft);
  assert.deepEqual(state.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement, placement);
}
state.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement = { mode: 'random', margin: 24 };
state = await request('PUT', root, state);
const sceneId = state.scenes[0].id, publicId = state.scenes[0].publicId;
state = await request('POST', `${root}/scenes/${sceneId}/publish`, { revision: state.revision });
const frozen = structuredClone(state.scenes[0].published);
assert.deepEqual(frozen.widgets.find(w => w.kind === 'trigger').triggerPlacement, { mode: 'random', margin: 24 });
state.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement = { mode: 'fixed', margin: 100 };
state = await request('PUT', root, state);
assert.deepEqual((await request('GET', `/overlay-studio/public/${publicId}`)).snapshot, frozen);
const ns = `/overlay-studio/${publicId}`, messages = [];
const socket = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
socket.addEventListener('message', event => {
  const raw = String(event.data);
  if (raw.startsWith('0')) socket.send(`40${ns},${JSON.stringify({ clientId: crypto.randomUUID() })}`);
  else if (raw === '2') socket.send('3');
  else if (raw.startsWith(`42${ns},`)) messages.push(JSON.parse(raw.slice(raw.indexOf(',') + 1)));
});
async function until(predicate) { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Playback socket timed out'); }
await until(() => messages.some(m => m[0] === 'overlay-state'));
await request('POST', `/triggers/${channel}/send`, { url: 'https://fixture.invalid/trigger.png', mediaType: 'image/png', volume: 0 });
await until(() => messages.some(m => m[0] === 'overlay-event'));
const event = messages.find(m => m[0] === 'overlay-event')[1];
const full = await request('GET', `/overlay-studio/public/${publicId}/events/${event.id}`);
assert.deepEqual(full.snapshot, frozen, 'playback uses published placement, not a later draft');
socket.send(`42${ns},${JSON.stringify(['overlay-ended', event.id])}`);
socket.close();
state = await request('POST', `${root}/scenes/${sceneId}/publish`, { revision: state.revision });
assert.deepEqual(state.scenes[0].published.widgets.find(w => w.kind === 'trigger').triggerPlacement, { mode: 'fixed', margin: 100 });
delete state.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement;
state = await request('PUT', root, state);
assert.equal(state.scenes[0].widgets.find(w => w.kind === 'trigger').triggerPlacement, undefined);
await mongo.connection.close(); redis.destroy();
console.log('PASS placement API: strict trigger-only validation, legacy fixed default, normalization, save/reload, immutable publish, real socket delivery with published settings and explicit return to fixed.');
process.exit(0);
