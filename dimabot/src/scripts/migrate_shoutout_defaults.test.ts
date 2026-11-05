import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationForShoutout, defaultShoutoutBody } from './migrate_shoutout_defaults.lib.js';
test('migration preserves settings and renamed records and guards authored fields', () => {
 const row = { _id: 'id', func: 'shoutout', reserved: true, cmd: 'renamed', channelID: 'c', message: '', enabled: false, cooldown: 31, userLevel: 1, permissionExpression: { tag: 'vip' } };
 const plan = migrationForShoutout(row)!;
 assert.deepEqual({ ...row, ...plan.update.$set }, { ...row, reserved: false, message: defaultShoutoutBody });
 assert.deepEqual(plan.filter.cmd, { $eq: 'renamed' }); assert.deepEqual(plan.filter.message, { $eq: '' });
 assert.equal(migrationForShoutout({ ...row, reserved: false }), null);
 assert.deepEqual(migrationForShoutout({ ...row, message: 'my custom text' })!.update.$set, { reserved: false });
 assert.deepEqual(migrationForShoutout({ ...row, blocks: { content: 'authored' } })!.update.$set, { reserved: false });
 assert.equal(migrationForShoutout({ ...row, activation: 'keyword' }), null);
});
