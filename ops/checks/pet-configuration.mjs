/** Candidate-only integration check; requires oauth-beta-fixtures and disposable Mongo/Redis. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { PetSettingsSchema } = await import('/app/dist/schemas/pet_settings.schema.js');
const { ChannelAIPersonalitySchema } = await import('/app/dist/schemas/channel_ai_personality.schema.js');
const mongo = await getMongoDBConnection('pet-config-check');
const redis = await getDragonflyClient('pet-config-check');
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/, 'only disposable test data');
const users = mongo.connection.db.collection('users');
const owner = '99003101', other = '99003102';
const inserted = await users.insertMany([
  { name: 'Pet owner', plan_tier: 'premium', accounts: [{ type: 'twitch', id: owner, name: 'pet_owner' }] },
  { name: 'Other owner', plan_tier: 'pro', accounts: [{ type: 'twitch', id: other, name: 'pet_other' }] }
]);
for (const [token, id] of [['pet-owner-token', owner], ['pet-other-token', other]]) {
  await redis.hSet(`token:${token}`, { id, login: id === owner ? 'pet_owner' : 'pet_other', display_name: 'Fixture' });
}
const base = 'http://127.0.0.1:3000';
async function call(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, redirect: 'manual', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: response.status === 302 ? null : await response.json() };
}
const path = `/pets/${owner}/settings`;
const get = () => call(path, { token: 'pet-owner-token' });
const put = (revision, settings) => call(path, { token: 'pet-owner-token', method: 'PUT', body: { revision, settings } });
assert.equal((await call(path)).status, 401);
assert.equal((await call(path, { token: 'pet-other-token' })).status, 403);
assert.equal((await call(path, { token: 'pet-other-token', method: 'PUT', body: {} })).status, 403);
let result = await get();
assert.equal(result.status, 200);
assert.match(result.headers.get('cache-control'), /no-store/);
assert.equal(result.body.data.revision, 0);
assert.equal(result.body.data.runtime.playbackAvailable, false);
assert.equal(await PetSettingsSchema.countDocuments(), 0, 'GET never creates settings');
const imageId = 'abcd00000000000000000001';
await mongo.connection.db.collection('asset_libraries').insertOne({ _id: owner, usedBytes: 1, assets: [
  { id: imageId, name: 'pet.gif', kind: 'image', mime: 'image/gif', bytes: 1, width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }
] });
const settings = result.body.data.settings;
settings.appearance = { kind: 'png', idleAssetId: imageId, talkingAssetId: imageId };
settings.enabled = true; settings.name = 'Luna'; settings.rules = ['No spoilers', 'Be kind'];
const initialSaves = await Promise.all([put(0, settings), put(0, settings)]);
assert.deepEqual(initialSaves.map(item => item.status).sort(), [200, 409], 'concurrent first saves cannot create duplicate configurations');
result = initialSaves.find(item => item.status === 200);
assert.equal(result.status, 200, JSON.stringify(result.body));
assert.equal(result.body.data.revision, 1);
assert.equal(result.body.data.settings.name, 'Luna');
assert.equal(result.body.data.runtime.enabled, true);
assert.equal((await get()).body.data.revision, 1);
assert.equal((await put(0, settings)).status, 409, 'duplicate initial save');
for (const change of [
  s => s.tts.provider = 'unknown', s => s.tts.voice = '../../secret', s => s.tts.language = 'fr',
  s => s.behavior.cooldownSeconds = -1, s => s.behavior.cooldownSeconds = 1.5,
  s => s.behavior.maxReplyLength = 501, s => s.behavior.respondToChat = 'yes',
  s => s.rules = Array(21).fill('x'), s => s.rules = ['x'.repeat(301)], s => s.rules = [''],
  s => s.name = ' ', s => s.personality.prompt = '', s => s.personality.prompt = 'x'.repeat(4001),
  s => s.extra = true, s => s.enabled = 'true', s => s.tts = null
]) {
  const invalid = structuredClone(settings); change(invalid);
  assert.equal((await put(1, invalid)).status, 400, JSON.stringify(invalid).slice(0, 200));
}
assert.equal((await put(-1, settings)).status, 400);
assert.equal((await put('1', settings)).status, 400);
assert.equal((await get()).body.data.revision, 1, 'validation does not write');
let revision = 1;
for (const [provider, language, voice] of [['kokoro','en','af_heart'], ['kokoro','es','ef_dora'],
  ['fish','es','7b5626abdaa044babfc3829ec15acf31'], ['fish','en','0123456789abcdef0123456789abcdef'],
  ['piper','en','en_US-ryan-medium']]) {
  settings.tts = { enabled: true, provider, language, voice };
  result = await put(revision++, settings);
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
const profile = { profileID: 'pet-persona-1', name: 'Co-host', personality: 'A relaxed co-host.',
  personaMode: 'original', personaReference: '', tonePreset: 'balanced',
  voiceProfile: { tone: 'calm', cadence: 'short', style: 'friendly', catchphrases: [] } };
await ChannelAIPersonalitySchema.collection.insertOne({ channelID: owner, profiles: [profile], rules: ['Profile rule'],
  knownUsers: [{ username: 'secret-user' }] });
settings.personality = { source: 'profile', profileId: 'foreign-profile', prompt: '' };
assert.equal((await put(revision, settings)).status, 400, 'foreign or missing profile rejected');
settings.personality.profileId = profile.profileID;
result = await put(revision++, settings);
assert.equal(result.status, 200, JSON.stringify(result.body));
assert.equal(result.body.data.runtime.personality.prompt, profile.personality);
assert.deepEqual(result.body.data.runtime.personality.rules, ['Profile rule', ...settings.rules]);
assert.ok(!JSON.stringify(result.body).includes('secret-user'));
const race = await Promise.all([put(revision, { ...settings, name: 'First tab' }), put(revision, { ...settings, name: 'Second tab' })]);
assert.deepEqual(race.map(item => item.status).sort(), [200, 409]); revision++;
// OAuth permissions are independent of browser credentials and tier eligibility.
const rand = () => randomBytes(32).toString('base64url');
async function mint(scope) {
  const verifier = rand();
  const start = await call('/oauth/authorize?' + new URLSearchParams({ client_id: 'dima-desktop', response_type: 'code',
    redirect_uri: 'http://127.0.0.1:42781/oauth/callback', scope, state: rand(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }));
  assert.equal(start.status, 302, JSON.stringify(start.body));
  const id = new URL(start.headers.get('location')).searchParams.get('request');
  const decision = await call(`/oauth/requests/${id}/decision`, { method: 'POST', token: 'oauth-beta-browser-owner', body: { approve: true } });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  const code = new URL(decision.body.redirect_uri).searchParams.get('code');
  const exchange = await call('/oauth/token', { method: 'POST', body: { client_id: 'dima-desktop', grant_type: 'authorization_code',
    code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:42781/oauth/callback' } });
  assert.equal(exchange.status, 200);
  return exchange.body;
}
const metadata = (await call('/oauth/metadata')).body;
assert.ok(metadata.scopes_supported.includes('pet:read'));
assert.ok(metadata.beta.planned_scopes.includes('pet:interact'));
const narrow = await mint('profile:read desktop:connect');
assert.equal((await call('/v1/me/pet', { token: narrow.access_token })).body.error, 'insufficient_scope');
// Upgrade an existing built-in registry entry without widening existing grants.
const { OAuthClient } = await import('/app/dist/schemas/oauth_client.schema.js');
const { initializeOAuth } = await import('/app/dist/server/oauth/service.js');
await OAuthClient.updateOne({ client_id: 'dima-desktop' }, { $pull: { allowed_scopes: 'pet:read' } });
await initializeOAuth();
assert.ok((await OAuthClient.findOne({ client_id: 'dima-desktop' }).lean()).allowed_scopes.includes('pet:read'));
assert.equal((await call('/v1/me/pet', { token: narrow.access_token })).body.error, 'insufficient_scope', 'existing session scope is unchanged');
const desktop = await mint('pet:read desktop:connect');
result = await call('/v1/me/pet', { token: desktop.access_token });
assert.equal(result.status, 200);
assert.equal(result.body.schemaVersion, 3);
assert.equal(result.body.revision, revision);
assert.equal(result.body.runtime.playbackAvailable, false);
assert.ok(!('profiles' in result.body) && !('voices' in result.body));
assert.ok(!JSON.stringify(result.body).includes('secret-user'));
assert.equal((await call('/v1/me/pet?channelID=' + other, { token: desktop.access_token })).status, 400);
assert.equal((await call('/v1/me/pet', { token: desktop.access_token, method: 'PUT', body: {} })).status, 404);
assert.equal((await call(path, { token: desktop.access_token })).status, 401, 'desktop token cannot use browser settings API');
// A profile removed later disables the effective config instead of silently using a different persona.
await ChannelAIPersonalitySchema.deleteMany({ channelID: owner });
result = await call('/v1/me/pet', { token: desktop.access_token });
assert.equal(result.body.runtime.enabled, false);
assert.deepEqual(result.body.runtime.issues, ['personality_unavailable']);
// Plan changes apply immediately to all resource reads/writes and preserve settings for a later upgrade.
for (const tier of ['free', 'premium', 'pro']) {
  await users.updateOne({ _id: inserted.insertedIds[0] }, { $set: { plan_tier: tier } });
  result = await get();
  assert.equal(result.status, tier === 'free' ? 403 : 200);
  if (tier === 'free') {
    assert.equal(result.body.message, 'plan_required');
    assert.equal((await put(revision, settings)).body.message, 'plan_required');
  }
  result = await call('/v1/me/pet', { token: desktop.access_token });
  assert.equal(result.status, tier === 'free' ? 403 : 200);
  if (tier === 'free') assert.equal(result.body.error, 'plan_required');
}
assert.equal(await PetSettingsSchema.countDocuments(), 1, 'one config per owner; another account is untouched');
assert.equal((await call(`/pets/${other}/settings`, { token: 'pet-other-token' })).body.data.revision, 0);
assert.equal((await call('/v1/desktop/session', { token: desktop.access_token, method: 'DELETE' })).status, 200);
assert.equal((await call('/v1/me/pet', { token: desktop.access_token })).status, 401);
console.log('PASS pet config: persistence, revision races, validation, account isolation, Premium/Pro gating, OAuth consent/scope/revocation, profile resolution (playback not exercised)');
process.exit(0);
