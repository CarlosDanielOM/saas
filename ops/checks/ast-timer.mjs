// Candidate entrypoint runs normally, with disposable databases and provider mocks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createClient } from '/app/node_modules/redis/dist/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { TriggerSchema } from '/app/dist/schemas/trigger.schema.js';
import { MediaAssetSchema } from '/app/dist/schemas/media_asset.schema.js';
import { AstVariablesSchema } from '/app/dist/schemas/ast_variables.schema.js';
import { parseSpecialCommands, createSpecialExecutionContext } from '/app/dist/handlers/special_parser.handler.js';
import { parse } from '/app/dist/utils/ast_parser/parser.js';
import { evaluate } from '/app/dist/utils/ast_parser/evaluator.js';
import { snapshotTimerContext, TIMER_GRACE_MS } from '/app/dist/utils/ast_parser/timer.js';
import { AstTimerScheduler, AST_TIMER_INDEX } from '/app/dist/utils/ast_timer_runtime.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(50); }
  assert.fail(message);
}
const mongo = await getMongoDBConnection('ast-timer-check');
const redis = await getDragonflyClient('ast-timer-check');
let scheduler;
if (process.env.SAAS_TARGET === 'bot') {
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:3333/eventsub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).status === 403; } catch { return false; }
  }, 'actual bot webhook must be ready');
} else {
  // API/cron produce the same cached jobs; use the bot's real scheduler to consume them.
  scheduler = new AstTimerScheduler(redis);
  await scheduler.start();
}

const channelID = '998701';
await redis.hSet(`accounts:twitch:${channelID}:data`, {
  id: channelID, name: 'timerfixture', plan_tier: 'premium', has_permissions: 'true',
  access_token: 'dummy-streamer', refresh_token: 'dummy-refresh',
  expires_at: String(Math.floor(Date.now() / 1000) + 3600)
});
await redis.set('app:twitch:token', 'dummy-app', { EX: 3600 });
const asset = await MediaAssetSchema.create({
  ownerUserID: 'fixture', ownerChannelID: channelID, ownerChannelName: 'timerfixture', uploadedByUserID: 'fixture',
  originalName: 'hurray.mp3', displayName: 'hurray', fileName: 'hurray.mp3', extension: 'mp3', mimeType: 'audio/mpeg',
  mediaType: 'audio', scope: 'private', bytes: 123, bucket: 'test', s3Key: 'test/hurray.mp3', storageUrl: 'https://example.test/hurray.mp3'
});
await TriggerSchema.create({ name: 'hurray', channel: 'timerfixture', channelID, file: 'hurray.mp3',
  mediaType: 'audio', isEnabled: true, volume: 50, assetID: asset._id });
const context = { channelID, scopeType: 'command', scopeName: 'notalk', eventData: {
  chatter_user_id: 'viewer-id', chatter_user_login: 'viewer', chatter_user_name: 'Viewer'
} };
const render = async text => (await parseSpecialCommands(text, context)).parsedText;
const effects = async () => (await redis.lRange('test:ast-timer:effects', 0, -1)).map(JSON.parse);

const scheduledAt = Date.now();
assert.equal(await render('Streamer cannot talk for 5 minutes $(timer 2 5 minutes over $(trigger.send hurray))'),
  'Streamer cannot talk for 5 minutes ');
assert.equal((await effects()).length, 0, 'no nested trigger during initial evaluation');
const [jobID] = await redis.zRange(AST_TIMER_INDEX, 0, -1);
assert.ok(jobID);
const saved = JSON.parse(await redis.get(`ast:timers:job:${jobID}`));
assert.equal(saved.expiresAt - saved.dueAt, TIMER_GRACE_MS);
assert.ok(await redis.pTTL(`ast:timers:job:${jobID}`) > TIMER_GRACE_MS, 'expiry includes duration and grace');
await until(async () => (await effects()).length >= 2, 'delayed trigger and chat must execute');
const firstEffects = await effects();
assert.equal(firstEffects[0].kind, 'trigger');
assert.equal(firstEffects[1].kind, 'chat');
assert.equal(firstEffects[1].body.message, '5 minutes over');
assert.ok(firstEffects.every(effect => effect.at >= saved.dueAt && effect.at >= scheduledAt + 2000));
assert.equal(await redis.exists(`ast:timers:job:${jobID}`), 0);
assert.equal(await redis.zCard(AST_TIMER_INDEX), 0);

// Context and DB callback recovery: capture memory now; persistent data loads later.
await render('%(name original) $(timer 1 %(name) $(user) %(**score 17)) %(name changed)');
await until(async () => (await effects()).length >= 3, 'context timer fires');
assert.equal((await effects())[2].body.message, 'original Viewer');
assert.equal(await render('%(**score)'), '17', 'restored user-scoped DB write persists');

// Literal user arguments must not be re-parsed as a deferred program.
await parseSpecialCommands('$(timer 1 &t)', { ...context, argument: '$(trigger.send hurray)', literalArguments: true });
await until(async () => (await effects()).length >= 4, 'literal argument timer fires');
assert.equal((await effects())[3].kind, 'chat');
assert.equal((await effects())[3].body.message, '$(trigger.send hurray)');

// LLM identity retains permissions after the serialized context is rehydrated.
const untrusted = await createSpecialExecutionContext(context);
untrusted.enforceFunctionPermissions = true;
untrusted.userLevel = 1;
untrusted.authorization = { origin: 'llm', identity: { level: 1, tags: [] } };
await evaluate(parse('$(timer 1 $(trigger.send hurray))').ast, untrusted);
await until(async () => (await effects()).length >= 5, 'restricted timer fires with denial');
assert.equal((await effects())[4].kind, 'chat');
assert.match((await effects())[4].body.message, /permission denied/i);

// Action-only bodies stay silent; repeated uses create independent jobs.
await render('$(timer 1 $(trigger.send hurray))');
await until(async () => (await effects()).length >= 6, 'action-only timer fires');
assert.equal((await effects())[5].kind, 'trigger');
await render('$(timer 2 repeated)');
await render('$(timer 2 repeated)');
assert.equal(await redis.zCard(AST_TIMER_INDEX), 2);
await until(async () => (await effects()).length >= 8, 'both repeated timers fire');
assert.deepEqual((await effects()).slice(6).map(effect => [effect.kind, effect.body.message]),
  [['chat', 'repeated'], ['chat', 'repeated']]);

const beforeInvalid = (await effects()).length;
for (const input of ['$(timer)', '$(timer 300)', '$(timer -1 $(trigger.send hurray))',
  '$(timer 0 $(trigger.send hurray))', '$(timer invalid $(trigger.send hurray))', '$(timer 604801 hi)']) {
  assert.match(await render(input), /^timer:/);
}
assert.equal((await effects()).length, beforeInvalid);
assert.equal(await redis.zCard(AST_TIMER_INDEX), 0);

// Separate Redis DB holds restart fixtures; the actual main bot cannot claim these.
const recoveryRedis = createClient({ url: 'redis://redis:6379/1' });
await recoveryRedis.connect();
const snapshot = snapshotTimerContext(await createSpecialExecutionContext(context));
async function insertJob(id, dueAt, expiresAt = dueAt + TIMER_GRACE_MS) {
  const job = { version: 1, id, dueAt, expiresAt, context: snapshot, body: parse('recovered').ast };
  await recoveryRedis.set(`ast:timers:job:${id}`, JSON.stringify(job), { PXAT: expiresAt });
  await recoveryRedis.zAdd(AST_TIMER_INDEX, { value: id, score: dueAt });
  await recoveryRedis.zAdd(`ast:timers:channel:${channelID}`, { value: id, score: expiresAt });
}
const children = new Set();
async function consumer() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createClient } from '/app/node_modules/redis/dist/index.js';
    import { AstTimerScheduler } from '/app/dist/utils/ast_timer_runtime.js';
    const redis = createClient({url:'redis://redis:6379/1'}); await redis.connect();
    const scheduler = new AstTimerScheduler(redis, async job => { await redis.rPush('test:executions', job.id); });
    await scheduler.start(); console.log('READY');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  await until(() => logs.includes('READY'), `recovery consumer starts: ${logs}`);
  return child;
}
async function kill(child) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; children.delete(child); }
try {
  await insertJob('restart', Date.now() + 1500);
  const first = await consumer();
  await kill(first);
  await delay(1600);
  assert.equal(await recoveryRedis.lLen('test:executions'), 0, 'no consumer during downtime');
  const second = await consumer();
  await until(async () => await recoveryRedis.lLen('test:executions') === 1, 'overdue timer recovers after process restart');
  assert.deepEqual(await recoveryRedis.lRange('test:executions', 0, -1), ['restart']);
  const overlap = await consumer();
  await insertJob('overlap', Date.now() + 1000);
  await until(async () => await recoveryRedis.lLen('test:executions') === 2, 'overlapping consumers process timer');
  await delay(2200);
  assert.deepEqual(await recoveryRedis.lRange('test:executions', 0, -1), ['restart', 'overlap']);
  await kill(second); await kill(overlap);

  await insertJob('stale', Date.now() - TIMER_GRACE_MS - 100);
  await delay(100);
  const recovered = await consumer();
  await delay(2200);
  assert.equal(await recoveryRedis.exists('ast:timers:job:stale'), 0);
  assert.equal(await recoveryRedis.zCard(AST_TIMER_INDEX), 0, 'expired index entries cleaned');
  assert.equal(await recoveryRedis.lLen('test:executions'), 2, 'stale action never fires');
  await kill(recovered);
} finally {
  for (const child of children) child.kill('SIGKILL');
  await recoveryRedis.quit();
}

// Per-channel capacity rejects excess timers without running their bodies.
for (let i = 0; i < 100; i++) assert.equal(await render('$(timer 300 later)'), '');
assert.match(await render('$(timer 300 $(trigger.send hurray))'), /could not schedule/);
assert.equal((await effects()).length, beforeInvalid);
assert.equal(await redis.zCard(`ast:timers:channel:${channelID}`), 100);

scheduler?.stop();
await mongo.connection.close();
await redis.quit();
console.log(`PASS ${process.env.SAAS_TARGET}: lazy timer, chat/trigger execution, context and permissions, TTL, restart recovery, duplicate claims, stale expiry, invalid input and capacity`);
process.exit(0);
