// Block commands in the chat bot. Runs inside the saas-ops bot candidate:
//   scripts/saas-ops verify bot-<run> --dependency mongo --dependency redis \
//     --test-env ops/checks/keywords-fixtures/test-env.json \
//     --fixtures ops/checks/keywords-fixtures --check ops/checks/command-blocks-bot.mjs
//
// - a block command (compiled text in `message`) runs through the real handler;
// - !ec refuses reply changes on block commands, even when the cached copy is
//   stale, but still changes -cd / -ul;
// - !ec keeps working on text commands.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import Commands from '/app/dist/classes/command.class.js';
import { createUserIdentity } from '/app/dist/utils/permissions/index.js';
import { commandHandler } from '/app/dist/handlers/commands.handler.js';
import { editCommand } from '/app/dist/commands/command_manager.command.js';

await getMongoDBConnection('command-blocks-bot-check');
const redis = await getDragonflyClient('command-blocks-bot-check');
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'actual bot runtime is up');
await redis.set('app:twitch:token', 'dummy');

const channel = '72000001';
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'blocksbot', plan_tier: 'premium', chat_enabled: 'true' });
const blocks = { v: 1, root: { id: 'r', type: 'root', children: [{ id: 'a', type: 'literal', value: 'Hi ' }, { id: 'b', type: 'function', name: 'user', args: [] }] } };
const block = await CommandsSchema.create({ channelID: channel, channel: 'blocksbot', name: 'Block', cmd: 'blk', func: 'blk',
  message: 'Hi $(user)', authoring: 'blocks', blocks, cooldown: 10, userLevel: 1 });
const text = await CommandsSchema.create({ channelID: channel, channel: 'blocksbot', name: 'Text', cmd: 'txt', func: 'txt',
  message: 'old reply', cooldown: 10, userLevel: 1 });

// The bot runs the compiled text like any command.
const viewer = createUserIdentity(1, []);
const event = { chatter_user_id: '55', chatter_user_login: 'pix', chatter_user_name: 'Pix', message_id: 'm1', badges: [], message: { text: '!blk' } };
const run = await commandHandler(channel, event, 'blk', '', { origin: 'chat', identity: viewer });
assert.equal(run.error, false, JSON.stringify(run));
assert.equal(run.message, 'Hi Pix', JSON.stringify(run));

// Command lookups for chat don't carry the block tree.
const fetched = await Commands.getCommandFromDB(channel, 'blk');
assert.equal(fetched.command.blocks, undefined, 'blocks are not loaded on the chat path');
assert.equal(fetched.command.authoring, 'blocks');

// !ec on a block command: reply refused, settings allowed.
const refused = await editCommand(channel, 'blk something new', 10);
assert.equal(refused.error, true);
assert.match(refused.message, /built with blocks/);
assert.equal((await CommandsSchema.findById(block._id).lean()).message, 'Hi $(user)');
const cooldown = await editCommand(channel, '-cd=30 blk', 10);
assert.equal(cooldown.error, false, JSON.stringify(cooldown));
const afterCd = await CommandsSchema.findById(block._id).select('+blocks').lean();
assert.equal(afterCd.cooldown, 30);
assert.equal(afterCd.message, 'Hi $(user)');
assert.equal(afterCd.authoring, 'blocks');
assert.deepEqual(afterCd.blocks, blocks, 'a settings edit from chat keeps the blocks');
const level = await editCommand(channel, '-ul=vip blk', 10);
assert.equal(level.error, false, JSON.stringify(level));
assert.equal((await CommandsSchema.findById(block._id).lean()).userLevel, 5);

// A stale cached copy (cached while still text) can't be used to overwrite blocks.
await Commands.getCommandFromDB(channel, 'txt');
await CommandsSchema.updateOne({ _id: text._id }, { authoring: 'blocks', blocks, message: 'Hi $(user)' });
const stale = await editCommand(channel, 'txt overwrite', 10);
assert.equal(stale.error, true, 'database wins over the stale cache');
assert.equal((await CommandsSchema.findById(text._id).lean()).message, 'Hi $(user)');

// Text commands still edit from chat.
const plain = await CommandsSchema.create({ channelID: channel, channel: 'blocksbot', name: 'Plain', cmd: 'plain', func: 'plain',
  message: 'before', cooldown: 10, userLevel: 1 });
const edited = await editCommand(channel, 'plain after edit', 10);
assert.equal(edited.error, false, JSON.stringify(edited));
assert.equal((await CommandsSchema.findById(plain._id).lean()).message, 'after edit');

console.log('PASS bot: block command runs, chat lookups skip blocks, !ec refuses reply edits (stale cache too) but keeps -cd/-ul, text !ec unchanged');
process.exit(0);
