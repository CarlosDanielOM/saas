import assert from 'node:assert/strict';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import {
  addAdminToRoleCache,
  adminsIdsKey,
  populateAdminCache,
  resolveUserIdentity
} from '/app/dist/utils/permissions/roles.js';

const redis = await getDragonflyClient('channel-admin-bot-check');
const channelID = '99002201';
const adminID = '99002202';
const adminName = 'permissionadmin';

let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    ready = (await fetch('http://127.0.0.1:3333/eventsub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).status === 403;
  } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'isolated bot webhook ready');

const identity = () => resolveUserIdentity(channelID, {
  chatter_user_id: adminID,
  chatter_user_login: adminName,
  badges: []
}, redis);
const assignment = permissions => ({ adminID, adminName, channelName: 'fixture', permissions, actived: true });

await populateAdminCache(redis, channelID, [assignment(['commands:manage'])]);
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 0);
assert.equal((await identity()).tags.has('admin'), false, 'feature Manage does not elevate the chat role');

await addAdminToRoleCache(redis, channelID, assignment(['chat:admin']));
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 1);
assert.equal((await identity()).tags.has('admin'), true, 'explicit chat role elevates identity');

await addAdminToRoleCache(redis, channelID, assignment(['commands:view']));
assert.equal(await redis.sIsMember(adminsIdsKey(channelID), adminID), 0);
assert.equal((await identity()).tags.has('admin'), false, 'revocation removes chat elevation');

await addAdminToRoleCache(redis, channelID, assignment(['*']));
assert.equal((await identity()).tags.has('admin'), true, 'Full access preserves existing chat admin behavior');

console.log('PASS bot: View/Manage do not grant chat admin; explicit chat permission and Full access do; revocation is immediate');
process.exit(0);
