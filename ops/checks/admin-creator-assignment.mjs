// Verifies that a channel owner can manage the creator's channel-level admin
// assignment without changing the creator's separate global access.
import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import {
  CREATOR_TWITCH_USER_ID,
  getGlobalAdminRole
} from '/app/dist/middleware/admin.middleware.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';

const mongo = await getMongoDBConnection('admin-creator-assignment-check');
const redis = await getDragonflyClient('admin-creator-assignment-check');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let apiReady = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await fetch('http://127.0.0.1:3000/');
    apiReady = true;
    break;
  } catch {
    await sleep(500);
  }
}
assert.ok(apiReady, 'api ready');

const channelID = 'creator-assignment-owner';
const channelName = 'creator_assignment_owner';
const creatorName = 'creator_account';
const superAdminID = 'creator-assignment-super';

await mongo.connection.db.collection('users').insertMany([
  { accounts: [{ type: 'twitch', id: channelID, name: channelName }] },
  { accounts: [{ type: 'twitch', id: CREATOR_TWITCH_USER_ID, name: creatorName }] }
]);

await AdminSchema.create({
  channelID: 'global-admin-role',
  channelName: 'global_admin_role',
  adminID: superAdminID,
  adminName: 'global_super',
  role: 'super',
  permissions: ['*'],
  actived: true
});

await redis.hSet('token:creator-assignment-owner-token', {
  id: channelID,
  login: channelName,
  display_name: 'Channel Owner'
});
await redis.hSet('token:creator-assignment-super-token', {
  id: superAdminID,
  login: 'global_super',
  display_name: 'Global Super'
});

const request = (token, method) => fetch(`http://127.0.0.1:3000/admins/${channelID}${method === 'DELETE' ? `/${CREATOR_TWITCH_USER_ID}` : ''}`, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  ...(method === 'POST' ? {
    body: JSON.stringify({ channelName, adminName: creatorName })
  } : {})
});

assert.equal(await getGlobalAdminRole(CREATOR_TWITCH_USER_ID), 'creator');

const blockedGlobalAdd = await request('creator-assignment-super-token', 'POST');
assert.equal(blockedGlobalAdd.status, 403, 'global admins cannot assign the creator on another channel');
assert.equal(
  await AdminSchema.countDocuments({ channelID, adminID: CREATOR_TWITCH_USER_ID }),
  0,
  'blocked global-admin request creates no assignment'
);

const added = await request('creator-assignment-owner-token', 'POST');
assert.equal(added.status, 201, JSON.stringify(await added.json()));

const assignment = await AdminSchema.findOne({
  channelID,
  adminID: CREATOR_TWITCH_USER_ID
}).lean();
assert.ok(assignment, 'channel-level creator assignment persisted');
assert.equal(assignment.role, 'channel');
assert.equal(await getGlobalAdminRole(CREATOR_TWITCH_USER_ID), 'creator');

const removed = await request('creator-assignment-owner-token', 'DELETE');
assert.equal(removed.status, 200, JSON.stringify(await removed.json()));
assert.equal(
  await AdminSchema.countDocuments({ channelID, adminID: CREATOR_TWITCH_USER_ID }),
  0,
  'channel-level creator assignment removed'
);
assert.equal(await getGlobalAdminRole(CREATOR_TWITCH_USER_ID), 'creator');

console.log('PASS api: owner adds/removes creator assignment, global creator access remains, global-admin cross-channel mutation stays blocked');
process.exit(0);
