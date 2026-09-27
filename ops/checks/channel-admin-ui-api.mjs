import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';

const mongo = await getMongoDBConnection('channel-admin-ui-api-check');
const redis = await getDragonflyClient('channel-admin-ui-api-check');
const channelID = '99003301';
const adminID = '99003302';
const outsiderID = '99003303';
const identities = [
  ['clip-viewer-token', adminID, 'clipviewer'],
  ['clip-outsider-token', outsiderID, 'clipoutsider'],
  ['clip-owner-token', channelID, 'clipowner']
];
for (const [token, id, login] of identities) {
  await redis.hSet(`token:${token}`, { id, login, display_name: login });
}
await mongo.connection.db.collection('users').insertMany(identities.map(([, id, login]) => ({
  accounts: [{ type: 'twitch', id, name: login }]
})));

const request = (token, body) => fetch('http://127.0.0.1:3000/clip/test', {
  method: 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const body = { channelID, streamer: 'invalid login!' };
await AdminSchema.create({ channelID, channelName: 'clipowner', adminID, adminName: 'clipviewer', permissions: ['clips:view'], actived: true });

assert.equal((await request(null, body)).status, 401, 'clip test requires authentication');
assert.equal((await request('clip-outsider-token', body)).status, 403, 'outsider cannot run a clip test');
assert.equal((await request('clip-viewer-token', body)).status, 403, 'View-only admin cannot run a clip test');

await AdminSchema.updateOne({ channelID, adminID }, { $set: { permissions: ['clips:manage'] } });
assert.equal((await request('clip-viewer-token', body)).status, 400, 'Manage reaches validation before any clip effect');

await AdminSchema.updateOne({ channelID, adminID }, { $set: { permissions: ['*'] } });
assert.equal((await request('clip-viewer-token', body)).status, 400, 'Full access reaches validation before any clip effect');
assert.equal((await request('clip-owner-token', body)).status, 400, 'channel owner retains clip test access');

console.log('PASS api: clip test requires authentication and Clips Manage; View-only is denied, Manage/Full/owner reach validation');
process.exit(0);
