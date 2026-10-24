// Command block editor API check. Runs inside the saas-ops api candidate with
// disposable Mongo/Redis:
//   scripts/saas-ops verify api-<run> --dependency mongo --dependency redis \
//     --test-env ops/checks/command-cooldown-fixtures/test-env.json \
//     --fixtures ops/checks/command-cooldown-fixtures --check ops/checks/command-blocks-api.mjs
//
// Covers: import (any channel editor), paid-only block saves, compiled text never
// sent to clients (public list, all-channels list, 409, create/update/delete),
// settings-only edits keep the reply, downgrade lock + switch back to text,
// 10k character cap, 1 MB block bodies, the compiled text rendering like the
// blocks, and `#(cmd)` timer references.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';

const mongo = await getMongoDBConnection('command-blocks-check');
const redis = await getDragonflyClient('command-blocks-check');
const db = mongo.connection.db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const paid = '71000001';
const free = '71000002';
const modID = '71000003';
await db.collection('users').insertMany([
    { accounts: [{ type: 'twitch', id: paid, name: 'blockspaid', actived: true }], plan_tier: 'premium' },
    { accounts: [{ type: 'twitch', id: free, name: 'blocksfree', actived: true }], plan_tier: 'free' }
]);
await db.collection('admins').insertOne({ channelID: paid, adminID: modID, adminName: 'blocksmod', actived: true, permissions: ['commands:manage'] });
for (const [token, id, login] of [['blk-paid', paid, 'blockspaid'], ['blk-free', free, 'blocksfree'], ['blk-mod', modID, 'blocksmod']]) {
    await redis.hSet(`token:${token}`, { id, login, display_name: login });
}
for (const [id, name] of [[paid, 'blockspaid'], [free, 'blocksfree']]) {
    await redis.hSet(`accounts:twitch:${id}:data`, { id, name });
}

let up = false;
for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:3000/commands?limit=1'); up = true; break; } catch { await sleep(500); } }
assert.ok(up, 'api ready');

const call = async (method, path, body, token = 'blk-paid') => {
    const response = await fetch(`http://127.0.0.1:3000${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
};
const base = { name: 'Blocks', func: 'blk', channel: 'blockspaid', cooldown: 10, userLevel: 1, enabled: true };

// --- Import: text → blocks, for paid and free editors alike ---
const source = 'Hello $(user)! Deaths: %(*deaths) :) *(%(*deaths) > 3 ? "ouch ${$(user)}" : fine)';
const imported = await call('POST', `/commands/${paid}/blocks/import`, { text: source });
assert.equal(imported.status, 200, imported.text);
assert.equal(imported.json.advancedCount, 0);
assert.deepEqual(imported.json.root.children.map(c => c.type), ['literal', 'function', 'literal', 'getVar', 'literal', 'ternary']);
assert.equal((await call('POST', `/commands/${free}/blocks/import`, { text: 'hi $(user)' }, 'blk-free')).status, 200, 'free try-out can import');
assert.equal((await call('POST', `/commands/${paid}/blocks/import`, { text: 'x' }, null)).status, 401, 'import needs a login');
assert.equal((await call('POST', `/commands/${paid}/blocks/import`, { text: 'x' }, 'blk-free')).status, 403, 'import needs channel access');
assert.equal((await call('POST', `/commands/${paid}/blocks/import`, { text: 'x'.repeat(10_001) })).json.code, 'too_long');
const mixed = await call('POST', `/commands/${paid}/blocks/import`, { text: 'hi %(pen $(randomuser) extra) bye' });
assert.equal(mixed.json.advancedCount, 1, 'unclear expressions become advanced pieces');

// --- Create a block command (paid) ---
const created = await call('POST', `/commands/${paid}`, { ...base, cmd: 'blk', authoring: 'blocks', blocks: imported.json.root });
assert.equal(created.status, 200, created.text);
assert.equal(created.json.command.authoring, 'blocks');
assert.equal(created.json.command.message, '', 'create response hides the compiled text');
assert.equal(created.json.command.blocks.v, 1);
assert.ok(!created.text.includes('%(*deaths)'), 'no compiled text anywhere in the create response');
const doc = await CommandsSchema.findOne({ channelID: paid, cmd: 'blk' }).select('+blocks').lean();
assert.equal(doc.message, 'Hello $(user)! Deaths: %(*deaths) :) *((%(*deaths) > 3) ? "ouch ${$(user)}" : fine)', 'stored text: same command, tidied');
assert.equal(doc.blocks.root.children.length, 6);
const blkID = String(doc._id);

// The compiled text renders like the original.
const ctx = { channelID: paid, argument: '', userLevel: 1, eventData: { chatter_user_id: '5', chatter_user_login: 'pix', chatter_user_name: 'Pix', badges: [] } };
const rendered = await parseSpecialCommands(doc.message, ctx);
assert.equal(rendered.parsedText, 'Hello Pix! Deaths:  :) fine', JSON.stringify(rendered.parsedText));

// Mods with commands:manage can save blocks for a paid channel.
const byMod = await call('POST', `/commands/${paid}`, { ...base, cmd: 'blkmod', authoring: 'blocks',
    blocks: { id: 'r', type: 'root', children: [{ id: 'a', type: 'literal', value: 'from a mod' }] } }, 'blk-mod');
assert.equal(byMod.status, 200, byMod.text);

// --- No client sees the compiled text ---
const publicList = await call('GET', `/commands/${paid}?limit=100`, null, null);
assert.equal(publicList.status, 200);
const listed = publicList.json.commands.find(c => c.cmd === 'blk');
assert.equal(listed.message, '');
assert.equal(listed.authoring, 'blocks');
assert.equal(listed.blocks.root.children[1].name, 'user', 'viewers get the read-only blocks');
assert.ok(!publicList.text.includes('%(*deaths)'), 'public list never includes the compiled text');
const everyChannel = await call('GET', '/commands?limit=1000', null, null);
const leaked = everyChannel.json.commands.filter(c => String(c.message).includes('%(*deaths)') || 'blocks' in c);
assert.deepEqual(leaked.map(c => ({ cmd: c.cmd, authoring: c.authoring, hasBlocks: 'blocks' in c })), [], 'all-channels list: no text, no blocks');
for (const needle of ['%(*deaths)', '"blocks":']) {
    const at = everyChannel.text.indexOf(needle);
    assert.equal(at, -1, `all-channels list contains ${needle}: …${everyChannel.text.slice(Math.max(0, at - 160), at + 60)}…`);
}
const duplicate = await call('POST', `/commands/${paid}`, { ...base, cmd: 'blk', message: 'dup' });
assert.equal(duplicate.status, 409);
assert.ok(!duplicate.text.includes('%(*deaths)'), '409 hides the text');

// --- Plan gate and validation ---
const freeTry = await call('POST', `/commands/${free}`, { ...base, channel: 'blocksfree', cmd: 'nope', authoring: 'blocks', blocks: imported.json.root }, 'blk-free');
assert.equal(freeTry.status, 403);
assert.equal(freeTry.json.code, 'plan_required');
assert.equal(await CommandsSchema.countDocuments({ channelID: free, cmd: 'nope' }), 0);
const broken = await call('POST', `/commands/${paid}`, { ...base, cmd: 'broken', authoring: 'blocks',
    blocks: { id: 'r', type: 'root', children: [{ id: 'cmp', type: 'binary', operator: '==', left: null, right: { id: 'x', type: 'literal', value: '1' } }] } });
assert.equal(broken.status, 400);
assert.equal(broken.json.code, 'blocks_invalid');
assert.equal(broken.json.blockId, 'cmp', 'the error points at the block');

// --- Settings-only edit keeps the reply; new blocks recompile ---
const settings = await call('PUT', `/commands/${paid}/${blkID}`, { cooldown: 15, message: 'overwrite attempt' });
assert.equal(settings.status, 200, settings.text);
assert.equal((await CommandsSchema.findById(blkID).lean()).message, doc.message, 'message field is ignored for block commands');
assert.equal((await CommandsSchema.findById(blkID).lean()).cooldown, 15);
assert.equal(settings.json.command.message, '');
const rebuilt = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'blocks',
    blocks: { id: 'r', type: 'root', children: [{ id: 'a', type: 'literal', value: 'Hi ' }, { id: 'b', type: 'function', name: 'user', args: [] }] } });
assert.equal(rebuilt.status, 200, rebuilt.text);
assert.equal((await CommandsSchema.findById(blkID).lean()).message, 'Hi $(user)');
assert.equal(rebuilt.json.command.blocks.root.children[0].id, 'a', 'block ids survive a save');

// --- 1 MB bodies: a big tree (over the default 100 kB JSON limit) still saves ---
const many = Array.from({ length: 1400 }, (_, i) => ({ id: `n${String(i).padStart(4, '0')}${'x'.repeat(55)}`, type: 'function', name: 'user', args: [] }));
const big = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'blocks', blocks: { id: 'r', type: 'root', children: many } });
assert.ok(JSON.stringify(many).length > 100_000);
assert.equal(big.status, 200, big.text.slice(0, 300));
const tooBig = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'blocks', blocks: { id: 'r', type: 'root', children: [...many, ...many] } });
assert.equal(tooBig.json.code, 'blocks_invalid', 'over 10k characters of text is refused');

// --- Text commands: 10k cap ---
const longText = await call('POST', `/commands/${paid}`, { ...base, cmd: 'longtext', message: 'a'.repeat(6000) });
assert.equal(longText.status, 200, 'website text commands go past the old 500 limit');
assert.equal(longText.json.command.message.length, 6000, 'text commands still show their text');
const tooLong = await call('POST', `/commands/${paid}`, { ...base, cmd: 'toolong', message: 'a'.repeat(10_001) });
assert.equal(tooLong.json.code, 'too_long');

// --- Downgrade: blocks locked, settings still editable, switch back to text allowed ---
await db.collection('users').updateOne({ 'accounts.id': paid }, { $set: { plan_tier: 'free' } });
const locked = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'blocks', blocks: imported.json.root });
assert.equal(locked.status, 403);
assert.equal(locked.json.code, 'plan_required');
assert.equal((await call('PUT', `/commands/${paid}/${blkID}`, { cooldown: 20 })).status, 200, 'settings stay editable after a downgrade');
const keepBlocks = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'blocks', cooldown: 25, message: '' });
assert.equal(keepBlocks.status, 200, 'the dashboard\'s settings-only save (authoring kept, no blocks) works when locked');
assert.equal((await CommandsSchema.findById(blkID).lean()).cooldown, 25);
const missingText = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'text', message: '  ' });
assert.equal(missingText.json.code, 'missing_message');
const toText = await call('PUT', `/commands/${paid}/${blkID}`, { authoring: 'text', message: 'brand new reply' });
assert.equal(toText.status, 200, toText.text);
const textDoc = await CommandsSchema.findById(blkID).select('+blocks').lean();
assert.equal(textDoc.authoring, 'text');
assert.equal(textDoc.blocks, null);
assert.equal(toText.json.command.message, 'brand new reply');

// --- Delete response hides the text; timers reference block commands by name ---
const modDoc = await CommandsSchema.findOne({ channelID: paid, cmd: 'blkmod' }).lean();
const deleted = await call('DELETE', `/commands/${paid}/${modDoc._id}`);
assert.equal(deleted.status, 200);
assert.equal(deleted.json.command.message, '');
const timerRef = await parseSpecialCommands('#(blk)', { ...ctx, userLevel: 10 });
assert.equal(timerRef.commandReferences?.[0]?.commandName, 'blk', 'a #(cmd) timer runs the command itself');

console.log('PASS api: command blocks import/create/list/update/delete, text never sent, plan gate + downgrade lock, 10k cap, 1 MB bodies, render + timer reference');
process.exit(0);
