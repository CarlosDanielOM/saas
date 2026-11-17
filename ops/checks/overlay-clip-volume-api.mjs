// Clip layer volume on the real candidate API; all writes target the helper's disposable Mongo/Redis.
// Run: scripts/saas-ops verify api-<run> --dependency mongo --dependency redis
//   --test-env ops/checks/overlay-fixtures/test-env.json --fixtures ops/checks/overlay-fixtures --check ops/checks/overlay-clip-volume-api.mjs
import assert from 'node:assert/strict';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { Studio, token: publicToken } = await import('/app/dist/overlays/store.js');
const { makeScene } = await import('/app/dist/overlays/model.js');
const { legacyStarterDesign } = await import('/app/dist/overlays/default-alerts-migration.js');
const mongo = await getMongoDBConnection('clip-volume-check'), redis = await getDragonflyClient('clip-volume-check');
const channel = '990293', token = 'clip-volume-owner-fixture', root = `/overlay-studio/${channel}`;
await Studio.init();
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'free' });
// A studio made before clip volume existed: its clip layer has no `volume` key.
{ const scene = makeScene('main', 'My overlay', 'starter'); scene.publicId = publicToken();
  await Studio.create({ _id: channel, schemaVersion: 1, revision: 0, scenes: [scene], designs: [legacyStarterDesign()] }); }
await redis.hSet(`token:${token}`, { id: channel, login: 'clipvolumefixture', display_name: 'Fixture' });
async function request(method, path, body, status = 200) {
  const response = await fetch('http://127.0.0.1:3000' + path, { method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify({ writer: 2, ...body }) }) });
  const envelope = await response.json(); assert.equal(response.status, status, JSON.stringify(envelope)); return envelope.data;
}
const clipOf = value => value.scenes[0].widgets.find(w => w.kind === 'clip');
/** The clip layer of a published OBS copy (widgets at the top level). */
const publishedClip = copy => copy.widgets.find(w => w.kind === 'clip');
let state = await request('GET', root);
assert.equal(Object.hasOwn(clipOf(state), 'volume'), false, 'existing clip layers stay at full volume without a migration');

// Bad values, looping, and volume on other scene layers are refused (a 400, never silently dropped).
for (const volume of [1.01, -0.1, '0.5', null, true, {}]) {
  const draft = structuredClone(state); clipOf(draft).volume = volume; await request('PUT', root, draft, 400);
}
{ const draft = structuredClone(state); Object.assign(clipOf(draft), { volume: 0.5, loop: false }); await request('PUT', root, draft, 400); }
for (const kind of ['tts', 'trigger', 'alert']) {
  const draft = structuredClone(state); draft.scenes[0].widgets.find(w => w.kind === kind).volume = 0.5; await request('PUT', root, draft, 400);
}

// Saved, reloaded, and kept exactly (0 = silent, 1 = full).
for (const volume of [0, 0.35, 1]) {
  const draft = structuredClone(state); clipOf(draft).volume = volume; state = await request('PUT', root, draft);
  assert.equal(clipOf(state).volume, volume); assert.equal(clipOf(await request('GET', root)).volume, volume);
}
const draft = structuredClone(state); clipOf(draft).volume = 0.4; state = await request('PUT', root, draft);
const sceneId = state.scenes[0].id, publicId = state.scenes[0].publicId;

// OBS reads the published copy; a later draft edit does not reach it until the next publish.
state = await request('POST', `${root}/scenes/${sceneId}/publish`, { revision: state.revision });
assert.equal(publishedClip(state.scenes[0].published).volume, 0.4);
const frozen = structuredClone(state.scenes[0].published);
{ const next = structuredClone(state); clipOf(next).volume = 0.9; state = await request('PUT', root, next); }
const live = await request('GET', `/overlay-studio/public/${publicId}`);
assert.deepEqual(live.snapshot, frozen, 'the OBS copy keeps the published volume');
assert.equal(publishedClip(live.snapshot).volume, 0.4);
state = await request('POST', `${root}/scenes/${sceneId}/publish`, { revision: state.revision });
assert.equal(publishedClip((await request('GET', `/overlay-studio/public/${publicId}`)).snapshot).volume, 0.9);

// Removing the key returns to full volume (absent again, not stored as null).
{ const next = structuredClone(state); delete clipOf(next).volume; state = await request('PUT', root, next); }
assert.equal(Object.hasOwn(clipOf(state), 'volume'), false);
await mongo.connection.close(); redis.destroy();
console.log('PASS clip volume API: legacy layers have none, strict 0–1 clip-only validation, save/reload, frozen publish, OBS copy, removal.');
process.exit(0);
