// Actual candidate HTTP/WebSocket runtime; disposable databases and mocked Piper only.
import assert from 'node:assert/strict';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { Studio } = await import('/app/dist/overlays/store.js');
const mongo = await getMongoDBConnection('tts-text-check'), redis = await getDragonflyClient('tts-text-check');
const channel = '990391', token = 'tts-text-owner-fixture', root = '/overlay-studio/' + channel;
await Studio.init();
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'free' });
await redis.hSet('token:' + token, { id: channel, login: 'ttstextfixture', display_name: 'Fixture' });
async function request(method, path, body, expected = 200) {
  const res = await fetch('http://127.0.0.1:3000' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await res.json(); assert.equal(res.status, expected, JSON.stringify(envelope)); return envelope.data;
}
let state = await request('GET', root);
assert.equal(state.scenes[0].widgets.find(w => w.kind === 'tts').showTtsText, undefined);
for (const invalid of [null, 'false', 0, {}, []]) {
  const draft = structuredClone(state); draft.scenes[0].widgets.find(w => w.kind === 'tts').showTtsText = invalid; await request('PUT', root, draft, 400);
}
for (const kind of ['trigger', 'clip', 'alert']) {
  const draft = structuredClone(state); draft.scenes[0].widgets.find(w => w.kind === kind).showTtsText = false; await request('PUT', root, draft, 400);
}
const nested = structuredClone(state); nested.designs[0].events.follow.widgets[0].showTtsText = true; await request('PUT', root, nested, 400);
const original = structuredClone(state.scenes[0]), tts = original.widgets.find(w => w.kind === 'tts');
state.scenes = ['off', 'on', 'legacy'].map(id => ({ ...structuredClone(original), id, name: id, widgets: [{ ...tts, ...(id === 'legacy' ? {} : { showTtsText: id === 'on' }) }] }));
state = await request('PUT', root, state);
for (const scene of state.scenes) state = await request('POST', `${root}/scenes/${scene.id}/publish`, { revision: state.revision });
async function until(predicate, label) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error(label); }
const clients = [];
for (const scene of state.scenes) {
  const ns = '/overlay-studio/' + scene.publicId, messages = [], ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  ws.addEventListener('message', e => { const raw = String(e.data); if (raw.startsWith('0')) ws.send(`40${ns},${JSON.stringify({ clientId: crypto.randomUUID() })}`); else if (raw === '2') ws.send('3'); else if (raw.startsWith(`42${ns},`)) messages.push(JSON.parse(raw.slice(raw.indexOf(',') + 1))); });
  await until(() => messages.some(m => m[0] === 'overlay-state'), 'source connects');
  ws.send(`42${ns},${JSON.stringify(['overlay-health', { revision: scene.revision, issue: null }])}`);
  clients.push({ scene, ws, ns, messages });
}
const frozen = structuredClone(state.scenes[0].published);
state.scenes[0].widgets[0].showTtsText = true; state = await request('PUT', root, state);
assert.deepEqual((await request('GET', '/overlay-studio/public/' + state.scenes[0].publicId)).snapshot, frozen);
for (const client of clients) {
  await request('POST', root + '/test', { kind: 'tts', destination: 'obs', sceneId: client.scene.id, confirmed: true });
  await until(() => client.messages.some(m => m[0] === 'overlay-event'), 'TTS delivered with text setting ' + client.scene.id);
  const event = client.messages.find(m => m[0] === 'overlay-event')[1];
  const full = await request('GET', `/overlay-studio/public/${client.scene.publicId}/events/${event.id}`);
  assert.equal(full.snapshot.widgets[0].showTtsText, client.scene.id === 'legacy' ? undefined : client.scene.id === 'on');
  assert.equal(full.media.type, 'audio'); assert(full.text.length > 0);
  const media = await fetch('http://127.0.0.1:3000' + full.media.url); assert.equal(media.status, 200);
  assert.equal(Buffer.from(await media.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  client.ws.send(`42${client.ns},${JSON.stringify(['overlay-ended', event.id])}`);
  await new Promise(r => setTimeout(r, 3100));
}
const diagnostics = await request('GET', root + '/connections');
for (const scene of diagnostics.scenes) { assert(scene.receives.includes('tts')); assert(scene.sources.some(s => s.connected && s.status === 'ready')); }
for (const client of clients) client.ws.close();
await mongo.connection.close(); redis.destroy();
console.log('PASS TTS text API: strict TTS-only boolean validation, legacy/default-off, saved/published on/off, draft isolation, real WebSocket delivery and WAV retrieval, connected/ready TTS diagnostics with captions off.');
process.exit(0);
