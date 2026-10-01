// The actual API process, disposable databases, and local Socket.IO clients only.
import assert from 'node:assert/strict';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { TriggerSchema } = await import('/app/dist/schemas/trigger.schema.js');
const { Studio } = await import('/app/dist/overlays/store.js');
const mongo = await getMongoDBConnection('overlay-trigger-filter-check'), redis = await getDragonflyClient('overlay-trigger-filter-check');
const channel = '990191', other = '990192', token = 'filter-owner-fixture', triggerA = '1'.repeat(24), triggerB = '2'.repeat(24), foreign = '3'.repeat(24);
await Studio.init();
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'pro' });
await redis.hSet(`token:${token}`, { id: channel, login: 'filterfixture', display_name: 'Fixture' });
await TriggerSchema.create([
  { _id: triggerA, name: 'Airhorn', channel: 'filterfixture', channelID: channel, file: 'airhorn.png', mediaType: 'image/png' },
  { _id: triggerB, name: 'Confetti', channel: 'filterfixture', channelID: channel, file: 'confetti.png', mediaType: 'image/png' },
  { _id: foreign, name: 'Foreign', channel: 'other', channelID: other, file: 'foreign.png', mediaType: 'image/png' }
]);
const base = 'http://127.0.0.1:3000';
async function request(method, path, body, expected = 200, authenticated = true) {
  const result = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await result.json(); assert.equal(result.status, expected, JSON.stringify(envelope)); return envelope.data;
}
const studio = '/overlay-studio/' + channel;
let state = await request('GET', studio);
const original = structuredClone(state.scenes[0]);
const placement = original.widgets.find(w => w.kind === 'trigger');
for (const invalid of [null, 'all', [12], ['bad'], [triggerA, triggerA], Array(1001).fill(triggerA)]) {
  const candidate = structuredClone(state); candidate.scenes[0].widgets.find(w => w.kind === 'trigger').triggerIds = invalid;
  await request('PUT', studio, candidate, 400);
}
const misplaced = structuredClone(state); misplaced.scenes[0].widgets.find(w => w.kind === 'clip').triggerIds = [triggerA]; await request('PUT', studio, misplaced, 400);
state.scenes = ['all', 'a', 'b', 'none'].map((id, i) => ({ ...structuredClone(original), id, name: id, publicId: i ? '' : original.publicId,
  widgets: [{ ...placement, ...(id === 'all' ? {} : { triggerIds: id === 'none' ? [] : [id === 'a' ? triggerA : triggerB] }) }], published: undefined }));
state = await request('PUT', studio, state);
assert.equal(state.scenes[0].widgets[0].triggerIds, undefined);
assert.deepEqual(state.scenes[3].widgets[0].triggerIds, []);
for (const scene of state.scenes) state = await request('POST', `${studio}/scenes/${scene.id}/publish`, { revision: state.revision });
const sceneA = state.scenes.find(s => s.id === 'a'), frozen = structuredClone(sceneA.published);
sceneA.widgets[0].triggerIds = [triggerB]; state = await request('PUT', studio, state);
assert.deepEqual((await request('GET', '/overlay-studio/public/' + sceneA.publicId, undefined, 200, false)).snapshot, frozen, 'draft edits do not change published filters');
async function until(predicate, message) { for (let i = 0; i < 140; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error(message); }
async function connect(publicId) {
  const ns = '/overlay-studio/' + publicId, messages = [], clientId = crypto.randomUUID();
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
  ws.addEventListener('message', event => { const raw = String(event.data); if (raw.startsWith('0')) ws.send(`40${ns},${JSON.stringify({ clientId })}`); else if (raw === '2') ws.send('3'); else if (raw.startsWith(`42${ns},`)) messages.push(JSON.parse(raw.slice(raw.indexOf(',') + 1))); });
  await until(() => messages.some(m => m[0] === 'overlay-state'), 'Socket.IO ready');
  return { ws, publicId, events: () => messages.filter(m => m[0] === 'overlay-event').map(m => m[1]), ack: id => ws.send(`42${ns},${JSON.stringify(['overlay-ended', id])}`) };
}
const clients = Object.fromEntries(await Promise.all(state.scenes.map(async scene => [scene.id, await connect(scene.publicId)])));
const anotherA = await connect(sceneA.publicId);
const payload = { url: 'https://fixture.invalid/trigger.png', mediaType: 'image/png', volume: 0, name: 'Untrusted name' };
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: 'bad' }, 400);
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: foreign }, 404);
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: '4'.repeat(24) }, 404);
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: triggerA });
await until(() => clients.a.events().length === 1 && clients.all.events().length === 1 && anotherA.events().length === 1, 'A goes to A and all, including duplicate sources');
await new Promise(r => setTimeout(r, 150)); assert.equal(clients.b.events().length, 0); assert.equal(clients.none.events().length, 0);
const event = clients.a.events()[0]; assert.equal(event.triggerId, triggerA);
const full = await request('GET', `/overlay-studio/public/${clients.a.publicId}/events/${event.id}`, undefined, 200, false);
assert.equal(full.triggerId, triggerA); assert.equal(full.media.title, 'Airhorn'); assert.equal(full.media.volume, 0); assert.deepEqual(full.snapshot.widgets[0].triggerIds, [triggerA]);
await request('GET', `/overlay-studio/public/${clients.b.publicId}/events/${event.id}`, undefined, 404, false);
for (const client of [clients.a, clients.all, anotherA]) client.ack(event.id);
await TriggerSchema.updateOne({ _id: triggerA }, { $set: { name: 'Renamed horn' } });
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: triggerA });
await until(() => clients.a.events().length === 2, 'rename preserves identity');
assert.equal(clients.a.events()[1].triggerId, triggerA); assert.equal(clients.a.events()[1].media.title, 'Renamed horn');
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: triggerB });
await until(() => clients.b.events().length === 1 && clients.all.events().length === 3, 'B goes to B and all');
await request('POST', `/triggers/${channel}/send`, payload);
await until(() => clients.all.events().length === 4, 'legacy payload still reaches all');
await new Promise(r => setTimeout(r, 150)); assert.equal(clients.a.events().length, 2); assert.equal(clients.b.events().length, 1); assert.equal(clients.none.events().length, 0);
assert.equal(clients.all.events()[3].triggerId, undefined, 'unidentified tests never match selected widgets');
const diagnostics = await request('GET', studio + '/connections');
assert(!diagnostics.scenes.find(s => s.id === 'none').receives.includes('trigger'));
assert(diagnostics.scenes.find(s => s.id === 'a').receives.includes('trigger'));
state = await request('POST', `${studio}/scenes/a/publish`, { revision: state.revision });
await until(async () => { const d = await request('GET', studio + '/connections'); return d.scenes.find(s => s.id === 'a').sources.every(s => s.status === 'loading'); }, 'published update');
// Wait for the poll to refresh this peer's published filter, rather than its draft.
await new Promise(r => setTimeout(r, 1200));
await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: triggerB });
await until(() => clients.a.events().length === 3, 'new publication receives B');
assert.equal(clients.a.events()[2].triggerId, triggerB);
await TriggerSchema.deleteOne({ _id: triggerB }); await request('POST', `/triggers/${channel}/send`, { ...payload, triggerId: triggerB }, 404);
// Deleted selections remain explicit; they never broaden into all triggers.
state = await request('PUT', studio, state); assert.deepEqual(state.scenes.find(s => s.id === 'b').widgets[0].triggerIds, [triggerB]);
for (const client of [...Object.values(clients), anotherA]) client.ws.close();
await mongo.connection.close(); redis.destroy();
console.log('PASS trigger filters API: strict schema, saved/published selections, channel-scoped identity, renamed/deleted triggers, all/selected/none routing, multiple sources, zero volume, legacy sends and diagnostics.');
process.exit(0);
