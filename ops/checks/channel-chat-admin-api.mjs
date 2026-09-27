import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';
import { adminsIdsKey, resolveUserIdentity } from '/app/dist/utils/permissions/roles.js';

const mongo = await getMongoDBConnection('channel-chat-admin-check');
const redis = await getDragonflyClient('channel-chat-admin-check');
const channelID = '99005501';
const adminID = '99005502';
const identities = [
  ['chat-owner-token', channelID, 'chat_owner'],
  ['chat-admin-token', adminID, 'chat_admin']
];
for (const [token, id, login] of identities) {
  await redis.hSet(`token:${token}`, { id, login, display_name: login });
}
await mongo.connection.db.collection('users').insertMany(identities.map(([, id, login]) => ({
  accounts: [{ type: 'twitch', id, name: login }]
})));

const request = (token, method, path, body) => fetch(`http://127.0.0.1:3000${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const owner = identities[0][0];
const admin = identities[1][0];
const assignment = `/admins/${channelID}/${adminID}/permissions`;
const websiteAccess = () => request(admin, 'GET', `/auth/access/${channelID}?permission=dashboard%3Aview`);
const commandsAccess = () => request(admin, 'GET', `/auth/access/${channelID}?permission=commands%3Aview`);
const chatIdentity = () => resolveUserIdentity(channelID, {
  chatter_user_id: adminID, chatter_user_login: 'chat_admin', badges: []
}, redis);
const sessionChannels = async () => {
  const response = await request(admin, 'GET', '/auth/session');
  assert.equal(response.status, 200, 'admin session is available');
  const payload = await response.json();
  return payload.data.app.administrating.map((entry) => entry.channelID);
};

let response = await request(owner, 'POST', `/admins/${channelID}`, {
  channelName: 'chat_owner', adminName: 'chat_admin', permissions: ['chat:admin']
});
assert.equal(response.status, 201, JSON.stringify(await response.json()));
let row = await AdminSchema.findOne({ channelID, adminID }).lean();
assert.deepEqual(row.permissions, ['chat:admin'], 'chat-only stays free of website grants');
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 1, 'chat-only gets the chat role');
assert.equal((await chatIdentity()).tags.has('admin'), true, 'chat-only has elevated Twitch chat identity');
assert.equal((await websiteAccess()).status, 403, 'chat-only cannot enter the dashboard');
assert.equal((await commandsAccess()).status, 403, 'chat-only cannot open website commands');
assert.equal((await request(admin, 'POST', `/commands/${channelID}`, {})).status, 403, 'chat-only cannot write website commands');
assert.equal((await sessionChannels()).includes(channelID), false, 'chat-only channel stays out of website switcher');

response = await request(owner, 'PUT', assignment, { permissions: ['commands:view'] });
assert.equal(response.status, 200, JSON.stringify(await response.json()));
row = await AdminSchema.findOne({ channelID, adminID }).lean();
assert.deepEqual(row.permissions, ['dashboard:view', 'commands:view'], 'website grant includes dashboard access');
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 0, 'website-only loses chat role');
assert.equal((await chatIdentity()).tags.has('admin'), false, 'website-only has no elevated Twitch chat identity');
assert.equal((await websiteAccess()).status, 200, 'website-only can enter dashboard');
assert.equal((await commandsAccess()).status, 200, 'website-only can view granted website feature');
assert.equal((await sessionChannels()).includes(channelID), true, 'website-only channel appears in website switcher');

response = await request(owner, 'PUT', assignment, { permissions: ['commands:view', 'chat:admin'] });
assert.equal(response.status, 200, JSON.stringify(await response.json()));
assert.equal((await websiteAccess()).status, 200, 'mixed grant retains website access');
assert.equal((await chatIdentity()).tags.has('admin'), true, 'mixed grant restores chat role');

response = await request(owner, 'PUT', assignment, { permissions: ['*'] });
assert.equal(response.status, 200, JSON.stringify(await response.json()));
assert.equal((await websiteAccess()).status, 200, 'Full access retains website access');
assert.equal((await chatIdentity()).tags.has('admin'), true, 'Full access retains chat role');

console.log('PASS api: chat-only, website-only, mixed, and Full grants stay separate across API, session switcher, and chat identity');
process.exit(0);
