// Read-only post-release smoke. Copy into an affected container and run with
// Node. Optional argument: the migration's EJSON backup copied into that container.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EJSON } from '/app/node_modules/bson/lib/bson.node.mjs';
import { simulateCommand } from '/app/dist/utils/ast_parser/simulate.js';
import { getFunctionMetadata } from '/app/dist/utils/ast_parser/index.js';

const definition = JSON.parse(readFileSync('/app/src/config/commands/reservedcommands.json', 'utf8')).commands.find(command => command.func === 'shoutout');
assert.equal(definition.reserved, false);
// Simulator supplies sample reads and records every action without executing it.
globalThis.fetch = async () => { throw new Error('Production smoke must not call external providers'); };
const result = await simulateCommand({ body: definition.message, runs: [{ argument: 'friendlystreamer', role: 'mod' }] });
assert.deepEqual(result.runs[0].actions.map(action => action.function), ['announcement', 'shoutout', 'show.clip']);
assert.deepEqual(result.runs[0].problems, []);
for (const name of ['announcement', 'shoutout', 'show.clip']) assert.equal(getFunctionMetadata(name).minUserLevel, 7);
console.log('PASS deployed AST/default catalog: simulated announcement, native shoutout and clip; no external effects');

if (process.argv[2]) {
  const { default: mongoose } = await import('/app/node_modules/mongoose/index.js');
  await mongoose.connect(process.env.MONGO_URI);
  const collection = mongoose.connection.collection('commands');
  const originals = EJSON.parse(readFileSync(process.argv[2], 'utf8'), { relaxed: false });
  for (const before of originals) {
    const after = await collection.findOne({ _id: before._id });
    assert.ok(after, 'existing command identity preserved');
    assert.equal(after.reserved, false);
    assert.equal(after.message, definition.message);
    const stable = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['reserved', 'message'].includes(key)));
    assert.equal(EJSON.stringify(stable(after)), EJSON.stringify(stable(before)), 'all other fields preserved');
  }
  assert.equal(await collection.countDocuments({ func: 'shoutout', reserved: true, activation: { $ne: 'keyword' } }), 0);
  console.log(`PASS live migration: ${originals.length} commands converted; all other stored fields preserved`);
  await mongoose.disconnect();
}
process.exit(0);
