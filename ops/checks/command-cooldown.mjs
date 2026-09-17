import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { createCommand, editCommand } from '/app/dist/commands/command_manager.command.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
await getMongoDBConnection('cooldown-check');
const redis = await getDragonflyClient('cooldown-check');
// Establish readiness of the actual bot entrypoint, without delivering chat messages.
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'bot webhook ready and rejects unsigned events');
for (const [tier, min] of [['free', 5], ['premium', 3], ['pro', 1], ['unknown', 5]]) {
  const channel = `cooldown-${tier}`;
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: tier });
  const created = await createCommand(channel, `-cd=${min} boundary hello`);
  assert.equal(created.error, false, JSON.stringify(created));
  assert.equal(created.command.cooldown, min);
  const invalid = await createCommand(channel, `-cd=${min - 1} rejected hello`);
  assert.equal(invalid.error, true);
  assert.match(invalid.message, new RegExp(`at least ${min} seconds`));
  assert.equal(await CommandsSchema.countDocuments({ channelID: channel, cmd: 'rejected' }), 0);
  assert.equal((await createCommand(channel, '-cd=abc bad hello')).error, true);
  const defaults = await createCommand(channel, 'default hello');
  assert.equal(defaults.command.cooldown, 10, 'omitted cooldown resets per request');
  const edited = await editCommand(channel, `-cd=${min} default changed`, 10);
  assert.equal(edited.error, false, JSON.stringify(edited));
  assert.equal((await CommandsSchema.findOne({ channelID: channel, cmd: 'default' })).cooldown, min);
  assert.equal((await editCommand(channel, `-cd=${min - 1} default`, 10)).error, true);
  assert.equal((await CommandsSchema.findOne({ channelID: channel, cmd: 'default' })).cooldown, min);
}
// --- Tag permission mode: chat-side management rules (TAG_PERMISSION_SYSTEM.md §4.3) ---
{
  const channel = 'cooldown-perms';
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: 'free' });

  // `-ul=` keeps creating level-mode commands.
  const levelMode = await createCommand(channel, '-ul=mod levelhello moderators only');
  assert.equal(levelMode.error, false, JSON.stringify(levelMode));
  assert.equal(levelMode.command.userLevel, 7);
  assert.equal(levelMode.command.userLevelName, 'mod');
  assert.equal(levelMode.command.permissionExpression, null, 'chat creation is level mode only this phase');

  // Seed a tag-mode command directly (dashboard/API owns expressions).
  await CommandsSchema.create({
    channelID: channel, channel, name: 'taghello', cmd: 'taghello', func: 'taghello',
    message: 'sub only hello', userLevel: 1, userLevelName: 'everyone',
    permissionExpression: { role: 'sub' }, enabled: true
  });

  // A sub-level caller cannot manage a tag-restricted command...
  const lowEdit = await editCommand(channel, 'taghello updated body', 2);
  assert.equal(lowEdit.error, true);
  assert.match(lowEdit.message, /moderator permissions to manage a tag-restricted command/i);

  // ...and `-ul=` against a tag-mode command rejects the entire edit.
  const ulEdit = await editCommand(channel, '-ul=mod taghello sub only hello v2', 10);
  assert.equal(ulEdit.error, true);
  assert.match(ulEdit.message, /dashboard permission editor/i);
  assert.equal((await CommandsSchema.findOne({ channelID: channel, cmd: 'taghello' })).permissionExpression.role, 'sub', 'rejected edit applies no changes');

  // Content edits remain allowed for callers at level >= 7.
  const okEdit = await editCommand(channel, 'taghello sub only hello v2', 7);
  assert.equal(okEdit.error, false, JSON.stringify(okEdit));
  assert.equal((await CommandsSchema.findOne({ channelID: channel, cmd: 'taghello' })).message, 'sub only hello v2');

  // Deleting a tag-restricted command also requires level >= 7.
  const { deleteCommand } = await import('/app/dist/commands/command_manager.command.js');
  const lowDelete = await deleteCommand(channel, 'taghello', 2);
  assert.equal(lowDelete.error, true);
  assert.match(lowDelete.message, /moderator permissions to manage a tag-restricted command/i);
  const okDelete = await deleteCommand(channel, 'taghello', 7);
  assert.equal(okDelete.error, false, JSON.stringify(okDelete));
}

console.log('PASS: bot readiness, all tier boundaries, invalid values, persistence, create defaults and edit, tag-mode management rules');
process.exit(0);
