import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';
import { adminsIdsKey } from '/app/dist/utils/permissions/roles.js';

const mongo = await getMongoDBConnection('channel-admin-permissions-check');
const redis = await getDragonflyClient('channel-admin-permissions-check');
const channelID = '99001101';
const adminID = '99001102';
const outsiderID = '99001103';
const tokens = [
  ['owner-channel-permissions-token', channelID, 'channel_permission_owner'],
  ['admin-channel-permissions-token', adminID, 'channel_permission_admin'],
  ['outsider-channel-permissions-token', outsiderID, 'channel_permission_outsider']
];

for (const [token, id, login] of tokens) {
  await redis.hSet(`token:${token}`, { id, login, display_name: login });
}
await mongo.connection.db.collection('users').insertMany(tokens.map(([, id, login]) => ({
  accounts: [{ type: 'twitch', id, name: login }]
})));

const request = (token, method, path, body) => fetch(`http://127.0.0.1:3000${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const owner = tokens[0][0];
const admin = tokens[1][0];
const outsider = tokens[2][0];
const assignment = `/admins/${channelID}/${adminID}/permissions`;

assert.equal((await request(owner, 'POST', `/admins/${channelID}`, {
  channelName: tokens[0][2], adminName: tokens[1][2], permissions: ['commands:view']
})).status, 201, 'owner can grant a custom View permission');

let row = await AdminSchema.findOne({ channelID, adminID }).lean();
assert.deepEqual(row.permissions, ['dashboard:view', 'commands:view']);
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 0, 'View does not grant the chat admin tag');
assert.equal((await request(admin, 'POST', `/commands/${channelID}`, {})).status, 403, 'View cannot change commands');
assert.equal((await request(admin, 'PUT', assignment, { permissions: ['*'] })).status, 403, 'channel admin cannot grant themselves Full access');
assert.equal((await request(outsider, 'PUT', assignment, { permissions: ['*'] })).status, 403, 'outsider cannot update permissions');
assert.equal((await request(owner, 'PUT', assignment, { permissions: ['*', 'commands:view'] })).status, 400, 'wildcard cannot be mixed with custom permissions');

let response = await request(owner, 'PUT', assignment, { permissions: ['commands:manage'] });
assert.equal(response.status, 200, JSON.stringify(await response.json()));
row = await AdminSchema.findOne({ channelID, adminID }).lean();
assert.deepEqual(row.permissions, ['dashboard:view', 'commands:manage', 'commands:view']);
assert.equal((await request(admin, 'POST', `/commands/${channelID}`, {})).status, 400, 'Manage reaches command validation');
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 0, 'Manage commands does not grant chat admin');

response = await request(owner, 'PUT', assignment, { permissions: ['*'] });
assert.equal(response.status, 200, JSON.stringify(await response.json()));
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 1, 'Full access grants chat admin');
assert.equal((await request(admin, 'POST', `/commands/${channelID}`, {})).status, 400, 'Full access can manage commands');

response = await request(owner, 'PUT', assignment, { permissions: ['commands:view'] });
assert.equal(response.status, 200, JSON.stringify(await response.json()));
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 0, 'revoking Full access removes chat admin');
assert.equal((await request(admin, 'POST', `/commands/${channelID}`, {})).status, 403, 'revoking Manage blocks command writes');

console.log('PASS channel admins: owner grants View, Manage, and Full; writes and chat role change immediately; invalid and unauthorized updates fail');
process.exit(0);
