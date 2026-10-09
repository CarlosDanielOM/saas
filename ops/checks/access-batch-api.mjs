/**
 * API check: GET /auth/access/:channelID?permissions=a,b,c resolves every permission for one
 * channel in a single request (owner, scoped admin, legacy wildcard, outsider), validates the
 * list, and leaves the single ?permission= form unchanged.
 * Run with --dependency mongo --dependency redis --fixtures ops/checks/access-batch-fixtures
 * --test-env ops/checks/access-batch-fixtures/test-env.json.
 */
import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';

const mongo = await getMongoDBConnection('access-batch-check');
const redis = await getDragonflyClient('access-batch-check');
const channelID = '99002101';
const scopedID = '99002102';
const wildcardID = '99002103';
const outsiderID = '99002104';
const tokens = [
  ['owner-access-batch-token', channelID, 'access_batch_owner'],
  ['scoped-access-batch-token', scopedID, 'access_batch_scoped'],
  ['wildcard-access-batch-token', wildcardID, 'access_batch_wildcard'],
  ['outsider-access-batch-token', outsiderID, 'access_batch_outsider']
];
for (const [token, id, login] of tokens) {
  await redis.hSet(`token:${token}`, { id, login, display_name: login });
}
await mongo.connection.db.collection('users').insertMany(tokens.map(([, id, login]) => ({
  accounts: [{ type: 'twitch', id, name: login }]
})));
await AdminSchema.create([
  { channelID, adminID: scopedID, channelName: 'access_batch_owner', adminName: 'access_batch_scoped', actived: true, role: 'channel', permissions: ['dashboard:view', 'commands:view'] },
  { channelID, adminID: wildcardID, channelName: 'access_batch_owner', adminName: 'access_batch_wildcard', actived: true, role: 'channel', permissions: ['*'] }
]);

const PERMS = 'dashboard:view,commands:view,settings:view';
const get = async (token, query) => {
  const res = await fetch(`http://127.0.0.1:3000/auth/access/${channelID}?${query}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return { status: res.status, body: await res.json() };
};

let r = await get(tokens[0][0], `permissions=${PERMS}`);
assert.equal(r.status, 200);
assert.deepEqual(r.body.data.permissions, { 'dashboard:view': true, 'commands:view': true, 'settings:view': true });
assert.equal(r.body.data.role, 'owner');
assert.equal(r.body.data.allowed, true);

r = await get(tokens[1][0], `permissions=${PERMS}`);
assert.equal(r.status, 200);
assert.deepEqual(r.body.data.permissions, { 'dashboard:view': true, 'commands:view': true, 'settings:view': false });
assert.equal(r.body.data.role, 'admin');
assert.equal(r.body.data.allowed, false, 'allowed means every requested permission');

r = await get(tokens[2][0], `permissions=${PERMS}`);
assert.deepEqual(r.body.data.permissions, { 'dashboard:view': true, 'commands:view': true, 'settings:view': true }, 'wildcard grants all');

r = await get(tokens[3][0], `permissions=${PERMS}`);
assert.equal(r.status, 200);
assert.deepEqual(r.body.data.permissions, { 'dashboard:view': false, 'commands:view': false, 'settings:view': false });
assert.equal(r.body.data.role, 'none');

assert.equal((await get(tokens[0][0], 'permissions=')).status, 400, 'empty list rejected');
assert.equal((await get(tokens[0][0], 'permissions=dashboard:view,$where')).status, 400, 'invalid names rejected');
assert.equal((await fetch(`http://127.0.0.1:3000/auth/access/${channelID}?permissions=${PERMS}`)).status, 401, 'auth required');

// Single-permission form unchanged.
r = await get(tokens[1][0], 'permission=settings:view');
assert.equal(r.status, 403);
assert.equal(r.body.data.allowed, false);
r = await get(tokens[1][0], 'permission=commands:view');
assert.equal(r.status, 200);
assert.equal(r.body.data.allowed, true);
assert.equal(r.body.data.permissions, undefined);

await mongo.disconnect?.();
console.log('PASS batch access: owner/scoped/wildcard/outsider decisions, validation, auth, single form unchanged');
process.exit(0);
