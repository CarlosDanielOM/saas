// Dima default alerts (2026-11-15): new studios, the public overlay library, gifted subs and the migration of untouched
// starters. Run only with saas-ops disposable databases:
//   scripts/saas-ops verify api-<run> --check ops/checks/default-alerts-api.mjs --dependency mongo --dependency redis \
//     --test-env ops/checks/overlay-fixtures/test-env.json --fixtures ops/checks/overlay-fixtures
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
await getMongoDBConnection('default-alerts-check');
const redis = await getDragonflyClient('default-alerts-check');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { Studio, token: publicToken } = await import('/app/dist/overlays/store.js');
const { makeScene, selectAlertLayout } = await import('/app/dist/overlays/model.js');
const { renderLayout, sampleEvent } = await import('/app/dist/overlays/ast.js');
const { legacyStarterDesign } = await import('/app/dist/overlays/default-alerts-migration.js');
const { buildPublished } = await import('/app/dist/overlays/publish.js');

const en = '990501', es = '990502', legacy = '990503', edited = '990504';
for (const [id, language] of [[en, 'en'], [es, 'es'], [legacy, 'es'], [edited, 'en']]) {
  await Users.collection.insertOne({ accounts: [{ type: 'twitch', id }], plan_tier: 'free', language });
  await redis.hSet('token:defaults-' + id, { id, login: 'fixture', display_name: 'Fixture' });
}
async function req(method, path, body, status = 200, id = en) {
  const r = await fetch('http://127.0.0.1:3000' + path, { method, headers: { ...(id ? { Authorization: 'Bearer defaults-' + id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(r.status, status, `${method} ${path}: ${r.status === status ? '' : await r.text()}`);
  return r;
}
const data = async (...args) => (await (await req(...args)).json()).data;
const texts = layout => Object.fromEntries(layout.widgets.filter(w => w.kind === 'text').map(w => [w.id, w.text]));

// 1. New studios start with the Dima defaults in the owner's language.
let state = await data('GET', '/overlay-studio/' + en);
let design = state.designs[0];
assert.equal(design.id, 'starter'); assert.equal(design.name, 'My alerts'); assert.deepEqual([design.width, design.height], [800, 240]);
assert.deepEqual(texts(design.events.follow), { kicker: 'New follower', name: '$(user)' });
assert.deepEqual(texts(design.events.raid), { kicker: 'Raid incoming', name: '$(raid.channel)', amount: '$(raid.viewers)', unit: 'viewers' });
const gift = design.variants.sub[0];
assert.equal(gift.gift, true); assert.equal(gift.tier, undefined); assert.equal(gift.name, 'Gifted subs');
assert.deepEqual(texts(gift.layout), { kicker: 'Gifted subs', name: '$(user)', amount: '$(gift.count)', unit: 'subs' });
for (const kind of ['follow', 'bits', 'sub', 'raid']) {
  const layout = design.events[kind];
  assert.equal(layout.widgets.find(w => w.id === 'badge').library, `dima-${kind}-badge`);
  assert.equal(layout.sounds[0].library, `dima-${kind}-sound`); assert.equal(layout.sound.library, `dima-${kind}-sound`, 'legacy mirror');
  assert(layout.widgets.every(w => w.mediaUrl === undefined && w.assetId === undefined), 'stored drafts keep library ids only');
}
const esState = await data('GET', '/overlay-studio/' + es, undefined, 200, es);
assert.equal(esState.designs[0].name, 'Mis alertas');
assert.equal(texts(esState.designs[0].events.follow).kicker, 'Nuevo seguidor');
assert.equal(esState.designs[0].variants.sub[0].name, 'Suscripciones regaladas');
assert.equal(texts(esState.designs[0].variants.sub[0].layout).unit, 'subs');

// 2. Library files are ours: nothing in the streamer's asset library, no storage used.
const library = await data('GET', '/asset-library/' + en);
assert.equal(library.usedBytes, 0); assert.deepEqual(library.assets, []);

// 3. A Studio save keeps the design as it is; publishing gives OBS the file URLs.
const saved = await data('PUT', '/overlay-studio/' + en, { ...state, writer: 2 });
assert.deepEqual(saved.designs[0].events, design.events); assert.deepEqual(saved.designs[0].variants, design.variants);
state = await data('POST', `/overlay-studio/${en}/scenes/main/publish`, { revision: saved.revision });
const scene = state.scenes.find(s => s.id === 'main');
assert.equal(scene.published.designs[0].events.follow.widgets.find(w => w.id === 'badge').mediaUrl, undefined, 'the stored published copy keeps ids only');
const served = (await data('GET', '/overlay-studio/public/' + scene.publicId, undefined, 200, '')).snapshot.designs[0];
assert.equal(served.events.follow.widgets.find(w => w.id === 'badge').mediaUrl, '/overlay-library/v1/badge-follow.webp');
assert.equal(served.events.follow.sounds[0].url, '/overlay-library/v1/sound-follow.mp3');
assert.equal(served.events.follow.sound.url, '/overlay-library/v1/sound-follow.mp3');
assert.equal(served.variants.sub[0].layout.widgets.find(w => w.id === 'confetti-1').mediaUrl, '/overlay-library/v1/confetti1-gift.webp');
assert.equal(served.events.raid.widgets.find(w => w.id === 'wind-1').mediaUrl, '/overlay-library/v1/wind-raid.webp');
// The served copy saved back (an editor that sends what it got) stores ids again.
const roundTrip = structuredClone(state); roundTrip.designs = [served];
const back = await data('PUT', '/overlay-studio/' + en, { ...roundTrip, writer: 2 });
assert.deepEqual(back.designs[0].events, design.events);
state = back;

// 4. Bad library references are refused.
for (const edit of [
  d => { d.events.follow.widgets.find(w => w.id === 'badge').library = 'dima-follow-nope'; },
  d => { d.events.follow.widgets.find(w => w.id === 'badge').library = 'dima-follow-sound'; },
  d => { d.events.follow.widgets.find(w => w.id === 'name').library = 'dima-follow-badge'; },
  d => { d.events.follow.sounds[0].library = 'dima-follow-card'; },
  d => { d.events.follow.sounds[0].library = '../../etc/passwd'; },
  d => { d.events.follow.widgets.find(w => w.id === 'badge').library = 'constructor'; }
]) { const copy = structuredClone(state); edit(copy.designs[0]); await req('PUT', '/overlay-studio/' + en, { ...copy, writer: 2 }, 400); }
const sceneLibrary = structuredClone(state);
sceneLibrary.scenes[0].widgets.push({ id: 'scene-pic', kind: 'image', library: 'dima-follow-badge', x: 0, y: 0, width: 100, height: 100, visible: true, locked: false });
await req('PUT', '/overlay-studio/' + en, { ...sceneLibrary, writer: 2 }, 400);

// 5. Objects can be as small as 5 px.
const tiny = structuredClone(state); Object.assign(tiny.designs[0].events.follow.widgets.find(w => w.id === 'kicker'), { width: 5, height: 5 });
state = await data('PUT', '/overlay-studio/' + en, { ...tiny, writer: 2 });
const tooTiny = structuredClone(state); Object.assign(tooTiny.designs[0].events.follow.widgets.find(w => w.id === 'kicker'), { height: 4 });
await req('PUT', '/overlay-studio/' + en, { ...tooTiny, writer: 2 }, 400);

// 6. Gifted subs: the gift look plays for gifts, $(gift.count) prints the subs; previews and OBS tests accept tier `gift`.
assert.deepEqual(await data('POST', `/overlay-studio/${en}/preview`, { kind: 'sub', tier: 'gift', amount: 5, user: 'Ada', texts: ['$(gift.count)', '$(user)'] }), ['5', 'Ada']);
assert.deepEqual(await data('POST', `/overlay-studio/${en}/preview`, { kind: 'sub', tier: '1000', amount: 5, texts: ['$(gift.count)'] }), ['0']);
const giftLayout = selectAlertLayout(design, 'sub', sampleEvent('sub', 'Ada', 5, 'gift'));
assert.equal(giftLayout, design.variants.sub[0].layout);
assert.equal(selectAlertLayout(design, 'sub', sampleEvent('sub', 'Ada', 3, '2000')), design.events.sub);
assert.deepEqual(texts(await renderLayout(giftLayout, en, { user_name: 'Ada', user_login: 'ada', total: 10, tier: '1000', is_anonymous: false })), { kicker: 'Gifted subs', name: 'Ada', amount: '10', unit: 'subs' });
// A real gift payload (channel.subscription.gift) has `total`; a resub never does.
assert.equal(selectAlertLayout(design, 'sub', { user_name: 'Ada', tier: '1000', cumulative_months: 4, streak_months: 2 }), design.events.sub);

// 7. Migration: only untouched old starters change, in the owner's language; it is safe to run twice.
const plainScene = () => { const s = makeScene('main', 'My overlay', 'starter'); s.publicId = publicToken(); return s; };
const old = plainScene(); old.revision = 2; old.published = buildPublished(old, [legacyStarterDesign()], new Map());
await Studio.create({ _id: legacy, schemaVersion: 1, revision: 5, scenes: [old], designs: [legacyStarterDesign()] });
const custom = legacyStarterDesign(); custom.events.follow.widgets[1].text = 'Hi $(user)';
await Studio.create({ _id: edited, schemaVersion: 1, revision: 3, scenes: [plainScene()], designs: [custom] });
const before = { en: await Studio.findById(en).lean(), edited: await Studio.findById(edited).lean() };
const run = (...args) => execFileSync('node', ['/app/dist/scripts/migrate_default_alerts.script.js', ...args], { encoding: 'utf8', env: process.env });
const dry = run();
assert.match(dry, new RegExp(`would update ${legacy} lang=es designs=starter published=main`)); assert.match(dry, /would update 1 studio\(s\); 3 left as they are/);
assert.equal((await Studio.findById(legacy).lean()).revision, 5, 'a dry run writes nothing');
assert.match(run('--apply'), /updated 1 studio\(s\); 3 left as they are/);
const migrated = await Studio.findById(legacy).lean();
assert.equal(migrated.revision, 6); assert.equal(migrated.designs[0].revision, 2); assert.equal(migrated.designs[0].name, 'My alerts');
assert.equal(texts(migrated.designs[0].events.follow).kicker, 'Nuevo seguidor');
assert.equal(migrated.scenes[0].revision, 3); assert.equal(migrated.scenes[0].published.designs[0].variants.sub[0].gift, true);
const live = (await data('GET', '/overlay-studio/public/' + old.publicId, undefined, 200, '')).snapshot.designs[0];
assert.equal(live.events.raid.sounds[0].url, '/overlay-library/v1/sound-raid.mp3');
assert.equal((await data('GET', `/overlay-studio/${legacy}/live`, undefined, 200, legacy)).live.main, true, 'draft and OBS copy stay in step');
assert.deepEqual(await Studio.findById(edited).lean(), before.edited, 'an edited design is never touched');
assert.deepEqual(await Studio.findById(en).lean(), before.en, 'studios already on the defaults are not touched');
assert.match(run('--apply'), /updated 0 studio\(s\); 4 left as they are/);
console.log('default alerts API check passed');
process.exit(0);
