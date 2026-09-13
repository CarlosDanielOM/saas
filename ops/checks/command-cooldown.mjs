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
console.log('PASS: bot readiness, all tier boundaries, invalid values, persistence, create defaults and edit');
process.exit(0);
