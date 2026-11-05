// Exact-image behavior check. Stage shoutout-ast-fixtures/*, native-cron-fixture.mjs
// and shoutout-ast-production.mjs (as production-smoke.mjs). Use disposable
// Mongo/Redis; all provider traffic is intercepted by the preload.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { ensureReservedCommands } from '/app/dist/server/services/command_defaults.service.js';
import { commandHandler } from '/app/dist/handlers/commands.handler.js';
import { createUserIdentity } from '/app/dist/utils/permissions/index.js';
import { parseAndEvaluate, getFunctionMetadata } from '/app/dist/utils/ast_parser/index.js';
import { renderTimerMessage } from '/app/dist/utils/timer_runtime.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';
import { deliverAstMessage } from '/app/dist/utils/ast_command_delivery.js';

const root = '/tmp/saas-fixtures';
const calls = () => { try { return readFileSync(`${root}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const control = data => writeFileSync(`${root}/control.json`, JSON.stringify(data));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.env.SAAS_TARGET !== 'cron') {
  const bot = process.env.SAAS_TARGET === 'bot';
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(bot ? 'http://127.0.0.1:3333/eventsub' : 'http://127.0.0.1:3000/config/site/analytics',
      bot ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {})).status === (bot ? 403 : 200); } catch {}
    if (!ready) await delay(100);
  }
  assert.ok(ready, 'normal service entrypoint readiness');
} else {
  let rows = [];
  for (let i = 0; i < 60; i++) {
    try { rows = readFileSync(`${root}/cron.jsonl`, 'utf8').trim().split('\n').map(JSON.parse); } catch {}
    if (rows.some(row => row.worker === 'timer' && row.actualTypescript) && rows.some(row => row.native && row.worker === 'roulette-completion')) break;
    await delay(100);
  }
  assert.ok(rows.some(row => row.worker === 'timer' && row.actualTypescript), 'normal cron starts real timer consumer');
  assert.ok(rows.some(row => row.native && row.worker === 'roulette-completion'), 'normal cron starts native owner/child');
}

await getMongoDBConnection('shoutout-ast-check');
const redis = await getDragonflyClient('shoutout-ast-check');
await redis.set('app:twitch:token', 'fixture-app', { EX: 3600 });
await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'fixture-bot',
  expires_at: String(Math.floor(Date.now() / 1000) + 3600) });
const defaults = JSON.parse(readFileSync('/app/src/config/commands/reservedcommands.json', 'utf8')).commands;
const definition = defaults.find(command => command.func === 'shoutout');
assert.equal(definition.reserved, false);
assert.match(definition.message, /\$\(announcement purple/);
assert.match(definition.message, /\$\(shoutout/);
assert.match(definition.message, /\$\(show\.clip/);

let sequence = 0;
async function setup(settings = {}) {
  const channelID = `9001${++sequence}`;
  control(settings);
  await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: 'fixturehost', plan_tier: 'pro', chat_enabled: 'true' });
  await redis.set(`twitch:${channelID}:clips:connected`, '1');
  await ensureReservedCommands(channelID, 'fixturehost');
  const command = await CommandsSchema.findOne({ channelID, func: 'shoutout' }).lean();
  assert.equal(command.reserved, false);
  assert.equal(command.message, definition.message);
  assert.equal(command.userLevel, 7);
  await ensureReservedCommands(channelID, 'fixturehost');
  assert.equal(await CommandsSchema.countDocuments({ channelID, func: 'shoutout' }), 1, 'default seeding is idempotent');
  await CommandsSchema.updateOne({ _id: command._id }, { cooldown: 0 });
  return channelID;
}
const event = { chatter_user_id: '900999', chatter_user_login: 'viewer', chatter_user_name: 'Viewer', badges: [], message: { text: '!so friendlystreamer' } };
const invoke = (channelID, argument, level = 7) => commandHandler(channelID, event, 'so', argument,
  { origin: 'chat', identity: createUserIdentity(level, level >= 7 ? ['mod'] : []) });
const pathCalls = (start, path) => calls().slice(start).filter(call => call.path === `/helix/${path}`);

const normal = await setup();
let start = calls().length;
const result = await invoke(normal, '@FriendlyStreamer');
assert.equal(result.error, false);
assert.equal(result.message.trim(), '', 'successful side effects produce no duplicate chat response');
const announcement = pathCalls(start, 'chat/announcements');
assert.equal(announcement.length, 1);
assert.equal(announcement[0].body.color, 'purple');
assert.match(announcement[0].body.message, /FriendlyStreamer.*https:\/\/twitch.tv\/friendlystreamer.*Fixture Game/);
assert.equal(announcement[0].query.moderator_id, '698614112');
const native = pathCalls(start, 'chat/shoutouts');
assert.equal(native.length, 1);
assert.equal(native[0].query.to_broadcaster_id, '900200');
assert.equal(native[0].query.moderator_id, '698614112');
assert.equal(pathCalls(start, 'users').length, 1, 'lookups reused within one execution');
assert.equal(await redis.zCard(`twitch:${normal}:clips:queue`), 1, 'real clip path queues playback');
console.log('PASS seeded editable default, normalized target, shared lookup, announcement/native/clip with bot identity');

for (const failure of ['fail', 'throw']) {
  const channel = await setup({ announcement: failure });
  start = calls().length;
  const fallback = await invoke(channel, 'friendlystreamer');
  assert.equal(fallback.error, false);
  assert.match(fallback.message, /Check out FriendlyStreamer/);
  assert.doesNotMatch(fallback.message, /announcement:|Forbidden|network failure/);
  assert.equal(pathCalls(start, 'chat/messages').length, 0, 'handler returns text for ordinary delivery');
  await deliverAstMessage(channel, { parsedText: fallback.message });
  assert.equal(pathCalls(start, 'chat/messages').length, 1, 'fallback delivered exactly once');
  assert.equal(pathCalls(start, 'chat/shoutouts').length, 1);
  assert.equal(await redis.zCard(`twitch:${channel}:clips:queue`), 1);
}
console.log('PASS announcement rejection/network failure returns original text, delivered once; other actions continue');

const limited = await setup({ shoutout: 'cooldown' });
start = calls().length;
await invoke(limited, 'friendlystreamer');
assert.equal(pathCalls(start, 'chat/announcements').length, 1);
assert.equal(pathCalls(start, 'chat/shoutouts').length, 1);
assert.equal(await redis.zCard(`twitch:${limited}:clips:queue`), 1, 'native cooldown does not prevent clip');
await redis.del('twitch:900200:clips');
const empty = await setup({ noClips: true });
await invoke(empty, 'friendlystreamer');
assert.equal(await redis.zCard(`twitch:${empty}:clips:queue`), 0, 'no clips is harmless');
await redis.del('twitch:900200:clips');
console.log('PASS native cooldown and missing clips do not prevent other actions');

for (const argument of ['', 'unknownstreamer', 'friendlystreamer extra', '$(chat.send injected)']) {
  const channel = await setup();
  start = calls().length;
  const invalid = await invoke(channel, argument);
  assert.equal(invalid.error, false);
  assert.match(invalid.message, /valid user|Usage:|not found/i);
  assert.equal(pathCalls(start, 'chat/announcements').length, 0);
  assert.equal(pathCalls(start, 'chat/shoutouts').length, 0);
  assert.equal(pathCalls(start, 'chat/messages').length, 0);
  assert.equal(await redis.zCard(`twitch:${channel}:clips:queue`), 0);
}
console.log('PASS missing, unknown, multiword and AST-injection inputs have no side effects');

const gated = await setup();
start = calls().length;
assert.equal((await invoke(gated, 'friendlystreamer', 1)).status, 403);
assert.equal(calls().length, start);
await CommandsSchema.updateOne({ channelID: gated, func: 'shoutout' }, { userLevel: 1 });
const Commands = (await import('/app/dist/classes/command.class.js')).default;
await Commands.invalidateCache(gated, 'so');
assert.equal((await invoke(gated, 'friendlystreamer', 1)).error, false);
assert.equal(pathCalls(start, 'chat/shoutouts').length, 1, 'command level overrides action metadata');
for (const name of ['announcement', 'shoutout', 'show.clip']) {
  assert.equal(getFunctionMetadata(name).minUserLevel, 7);
  start = calls().length;
  const denied = await parseAndEvaluate(`$(${name} friendlystreamer)`, { broadcasterId: gated, userLevel: 1, enforceFunctionPermissions: true });
  assert.match(String(denied.result), /permission|level|denied/i);
  assert.equal(calls().length, start);
}
console.log('PASS command policy authoritative; direct AI actions require moderator');

if (process.env.SAAS_TARGET === 'bot') {
  const dispatch = await setup();
  const { editCommand } = await import('/app/dist/commands/command_manager.command.js');
  const edited = await editCommand(dispatch, '-cd=10 so Custom SO &t', 10);
  assert.equal(edited.error, false, `converted default is editable: ${JSON.stringify(edited)}`);
  await CommandsSchema.updateOne({ channelID: dispatch, func: 'shoutout' }, { userLevel: 1 });
  await Commands.invalidateCache(dispatch, 'so');
  const { messageHandler } = await import('/app/dist/handlers/message.handler.js');
  start = calls().length;
  await messageHandler(dispatch, { ...event, message_id: 'shoutout-dispatch-fixture',
    broadcaster_user_id: dispatch, broadcaster_user_login: 'fixturehost', broadcaster_user_name: 'FixtureHost' });
  const chat = pathCalls(start, 'chat/messages');
  assert.equal(chat.length, 1, 'real message router delivers edited AST response once');
  assert.equal(chat[0].body.message, 'Custom SO friendlystreamer');
  assert.equal(pathCalls(start, 'chat/announcements').length, 0, 'nonreserved func=shoutout bypasses legacy bundle');
  assert.equal(pathCalls(start, 'chat/shoutouts').length, 0);
  console.log('PASS real chat dispatch uses edited nonreserved !so body, with no legacy effects');
}

const scheduled = await setup();
const timer = await renderTimerMessage({ channelID: scheduled, streamerName: 'fixturehost', timerName: 'shoutout',
  message: '$(announcement green Timer hello) $(shoutout friendlystreamer) $(show.clip friendlystreamer)',
  planTier: 'pro', parse: parseSpecialCommands });
assert.equal(timer.parsedText, '');
assert.equal(await redis.zCard(`twitch:${scheduled}:clips:queue`), 1);
console.log('PASS scheduled authored AST uses new actions through timer render path');

if (process.env.SAAS_TARGET === 'cron') {
  const winnerChannel = await setup();
  const { executeWinnerAction } = await import('/app/dist/roulette/actions.js');
  await executeWinnerAction(winnerChannel, { rouletteId: 'fixture-roulette', drawId: 'fixture-draw',
    itemId: 'fixture-item', label: 'Fixture winner', actor: { userId: '900999', userLogin: 'viewer', userDisplayName: 'Viewer' },
    source: '$(announcement purple Winner hello) $(shoutout friendlystreamer) $(show.clip friendlystreamer)' });
  assert.equal(await redis.zCard(`twitch:${winnerChannel}:clips:queue`), 1);
  console.log('PASS roulette winner action executes new AST functions with authored permissions');
}

const legacy = { channelID: 'migration-fixture', channel: 'Legacy', cmd: 'renamedso', func: 'shoutout',
  message: '', reserved: true, enabled: false, cooldown: 31, userLevel: 1,
  permissionExpression: { op: 'tag', tag: 'vip' }, count: 14 };
const inserted = await CommandsSchema.collection.insertOne(legacy);
await redis.set('migration-fixture:commands:renamedso', JSON.stringify(legacy));
const migrate = args => execFileSync(process.execPath, ['dist/scripts/migrate_shoutout_defaults.script.js', ...args],
  { cwd: '/app', encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_OPTIONS: '' } });
assert.match(migrate([]), /Matched 1/);
assert.equal((await CommandsSchema.collection.findOne({ _id: inserted.insertedId })).reserved, true, 'dry run is read only');
assert.match(migrate(['--apply', '--backup', `${root}/migration-backup.ejson`]), /Converted 1/);
const migrated = await CommandsSchema.collection.findOne({ _id: inserted.insertedId });
assert.equal(migrated.reserved, false);
assert.equal(migrated.message, definition.message);
for (const key of ['cmd', 'enabled', 'cooldown', 'userLevel', 'permissionExpression', 'count']) assert.deepEqual(migrated[key], legacy[key]);
assert.equal(await redis.exists('migration-fixture:commands:renamedso'), 0);
const backup = JSON.parse(readFileSync(`${root}/migration-backup.ejson`, 'utf8'));
assert.equal(backup[0]._id.$oid, String(inserted.insertedId));
assert.equal(backup[0].reserved, true);
assert.match(migrate([]), /Matched 0/, 'migration is idempotent');
console.log('PASS real migration dry run, BSON backup, metadata preservation, cache invalidation and idempotence');

const suites = [
  'dist/utils/ast_parser/shoutout_actions.test.js',
  'dist/utils/ast_parser/channel_actions.test.js',
  'dist/utils/ast_parser/permission_gate_authored.test.js',
  'dist/utils/ast_parser/command_references.test.js',
  'dist/utils/ast_parser/simulate.test.js',
  'dist/scripts/migrate_shoutout_defaults.test.js',
];
for (const file of readdirSync('/app/dist/utils', { recursive: true }).filter(file => /shoutout.*\.test\.js$/.test(String(file)))) {
  const path = `dist/utils/${file}`;
  if (!suites.includes(path)) suites.push(path);
}
if (process.env.SAAS_TARGET === 'cron') {
  for (const file of readdirSync('/app/dist/utils/ast_parser', { recursive: true }).filter(file => String(file).endsWith('.test.js'))) {
    const path = `dist/utils/ast_parser/${file}`;
    if (!suites.includes(path)) suites.push(path);
  }
  suites.push('dist/utils/timer_runtime.test.js');
}
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit', '--test-concurrency=2', ...suites],
  { cwd: '/app', stdio: 'inherit', timeout: 90000, env: { ...process.env, NODE_OPTIONS: '' } });
const catalog = JSON.parse(readFileSync('/app/src/utils/ai/ast_catalog/ast-catalog.json', 'utf8'));
for (const name of ['announcement', 'shoutout', 'show.clip']) assert.ok(catalog.entries.some(entry => entry.name === name || entry.aliases?.includes(name)));
if (process.env.SAAS_TARGET === 'cron') execFileSync(process.execPath, [`${root}/production-smoke.mjs`],
  { cwd: '/app', stdio: 'inherit', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '' } });
console.log(`PASS ${process.env.SAAS_TARGET}: exact-image shoutout integration and focused regression suites`);
process.exit(0);
