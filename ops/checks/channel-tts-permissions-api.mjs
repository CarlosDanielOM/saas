import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';

const mongo = await getMongoDBConnection('channel-tts-permission-check');
const redis = await getDragonflyClient('channel-tts-permission-check');
const channelID = '99006601';
const adminID = '99006602';
const identities = [
  ['tts-owner-token', channelID, 'tts_owner'],
  ['tts-admin-token', adminID, 'tts_admin']
];
for (const [token, id, login] of identities) {
  await redis.hSet(`token:${token}`, { id, login, display_name: login });
}
await mongo.connection.db.collection('users').insertMany(identities.map(([, id, login]) => ({
  accounts: [{ type: 'twitch', id, name: login }]
})));
await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: 'tts_owner', plan_tier: 'free' });

const request = (token, method, path, body) => fetch(`http://127.0.0.1:3000${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const owner = identities[0][0];
const admin = identities[1][0];
const assignment = `/admins/${channelID}/${adminID}/permissions`;
const getTts = () => request(admin, 'GET', `/speech/settings/${channelID}`);
const getFavorites = () => request(admin, 'GET', `/speech/favorites/${channelID}`);
const saveTts = (settings) => request(admin, 'PUT', `/speech/settings/${channelID}`, settings);
const saveFavorite = () => request(admin, 'POST', `/speech/favorites/${channelID}`, { id: 'invalid' });
const previewVoice = () => request(admin, 'POST', `/speech/preview-session/${channelID}`, {});
const hasGrant = (permission) => request(admin, 'GET', `/auth/access/${channelID}?permission=${encodeURIComponent(permission)}`);

let response = await request(owner, 'POST', `/admins/${channelID}`, {
  channelName: 'tts_owner', adminName: 'tts_admin', permissions: ['settings:manage']
});
assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
assert.equal((await hasGrant('settings:view')).status, 200, 'Bot Settings grant remains active');
assert.equal((await hasGrant('tts:view')).status, 403, 'Bot Settings no longer grants TTS');
assert.equal((await getTts()).status, 403, 'Bot Settings cannot read TTS settings');
assert.equal((await getFavorites()).status, 403, 'Bot Settings cannot read TTS favorites');
assert.equal((await saveTts({})).status, 403, 'Bot Settings cannot change TTS settings');
assert.equal((await previewVoice()).status, 403, 'Bot Settings cannot request TTS previews');

response = await request(owner, 'PUT', assignment, { permissions: ['tts:view'] });
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
let row = await AdminSchema.findOne({ channelID, adminID }).lean();
assert.deepEqual(row.permissions, ['dashboard:view', 'tts:view']);
assert.equal((await hasGrant('settings:view')).status, 403, 'TTS View does not grant Bot Settings');
response = await getTts();
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
let payload = await response.json();
assert.equal(payload.data.role, 'admin', 'TTS View is read-only');
const settings = payload.data.settings;
assert.equal((await getFavorites()).status, 200, 'TTS View can read favorites');
assert.equal((await saveTts(settings)).status, 403, 'TTS View cannot update settings');
assert.equal((await saveFavorite()).status, 403, 'TTS View cannot change favorites');
assert.equal((await previewVoice()).status, 403, 'TTS View cannot request previews');

response = await request(owner, 'PUT', assignment, { permissions: ['tts:manage'] });
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
row = await AdminSchema.findOne({ channelID, adminID }).lean();
assert.deepEqual(row.permissions, ['dashboard:view', 'tts:manage', 'tts:view'], 'TTS Manage includes View');
response = await getTts();
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
payload = await response.json();
assert.equal(payload.data.role, 'manager');
response = await saveTts(payload.data.settings);
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
assert.equal((await saveFavorite()).status, 400, 'TTS Manage reaches favorite validation');

response = await request(owner, 'PUT', assignment, { permissions: ['*'] });
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
response = await getTts();
assert.equal(response.status, 200);
assert.equal((await response.json()).data.role, 'manager', 'Full access retains TTS Manage');
response = await request(owner, 'GET', `/speech/settings/${channelID}`);
assert.equal(response.status, 200);
assert.equal((await response.json()).data.role, 'owner', 'broadcaster retains TTS access');

console.log('PASS api: Bot Settings and TTS grants are independent; TTS View is read-only; TTS Manage and Full can edit');
process.exit(0);
