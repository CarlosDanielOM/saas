// saas-ops behavior check for api/bot/cron with disposable Mongo/Redis.
// Fixtures contain moderation.mjs, command-permissions.mjs, mocked providers,
// and permission-expressions.json; SAAS_TAG_RUNTIME selects the live command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const runtime = process.env.SAAS_TAG_RUNTIME;
assert.ok(['api', 'bot', 'cron'].includes(runtime));
fs.mkdirSync('/ops/fixtures', { recursive: true });
fs.copyFileSync('/tmp/saas-fixtures/permission-expressions.json', '/ops/fixtures/permission-expressions.json');

function run(args) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 120_000, env: process.env
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, `Check failed: ${result.error || result.signal || args.join(' ')}`);
}

run(['--experimental-test-module-mocks', '--test',
  '/app/dist/utils/permissions/expression.test.js',
  '/app/dist/utils/permissions/roles.test.js',
  '/app/dist/utils/permissions/role_cache.test.js',
  '/app/dist/utils/permissions/error_rate_limit.test.js',
  '/app/dist/handlers/moderation.handler.test.js',
  '/app/dist/utils/moderation/spam.test.js',
  '/app/dist/utils/ast_parser/command_references.test.js'
]);
run(['/tmp/saas-fixtures/moderation.mjs']);
if (runtime === 'api') run(['/tmp/saas-fixtures/command-permissions.mjs']);

if (runtime === 'bot') {
  const response = await fetch('http://127.0.0.1:3333/eventsub', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 403, 'real bot rejects unsigned EventSub requests');
}

const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { CommandsSchema } = await import('/app/dist/schemas/commands.schema.js');
const { createUserIdentity } = await import('/app/dist/utils/permissions/index.js');
const { commandHandler } = await import('/app/dist/handlers/commands.handler.js');
const { handleKeywords } = await import('/app/dist/handlers/keywords.handler.js');
const { refreshKeywordIndex } = await import('/app/dist/utils/keyword_cache.js');
const { renderTimerMessage } = await import('/app/dist/utils/timer_runtime.js');
const { parseSpecialCommands } = await import('/app/dist/handlers/special_parser.handler.js');
const { deliverAstMessage } = await import('/app/dist/utils/ast_command_delivery.js');

await getMongoDBConnection('tag-access-runtime');
const redis = await getDragonflyClient('tag-access-runtime');
const channel = 'tag-runtime-channel';
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: 'pro' });
await redis.set('app:twitch:token', 'fixture-token');
const expression = { and: [
  { or: [{ role: 'vip' }, { role: 'mod' }, { user: { id: '12345', login: 'user123' } }] },
  { not: { or: [{ role: 'everyone' }, { role: 'sub' }, { user: { id: '22222', login: 'blocked' } }] } }
] };
await CommandsSchema.create({ channelID: channel, channel, cmd: 'tagged', name: 'Tagged',
  message: 'Allowed $(upper hello)', cooldown: 0, userLevel: 10, permissionExpression: expression });
const keyword = await CommandsSchema.create({ channelID: channel, channel, cmd: 'tagged', name: 'Tagged keyword',
  message: '$(scount)', cooldown: 1, userLevel: 10, permissionExpression: expression,
  activation: 'keyword', keywordSettings: { matchMode: 'exact' } });
await refreshKeywordIndex(channel, String(keyword._id));
const cases = [
  { name: 'viewer', id: '33333', level: 1, tags: [], allowed: false },
  { name: 'vip', id: '44444', level: 5, tags: ['vip'], allowed: true },
  { name: 'mod', id: '55555', level: 7, tags: ['mod'], allowed: true },
  { name: 'sub-vip', id: '66666', level: 5, tags: ['vip', 'sub'], allowed: false },
  { name: 'renamed-account', id: '12345', level: 2, tags: ['sub'], allowed: true },
  { name: 'blocked-account', id: '22222', level: 7, tags: ['mod'], allowed: false }
];
for (const identityCase of cases) {
  const identity = createUserIdentity(identityCase.level, identityCase.tags, identityCase.id, identityCase.name);
  const event = { chatter_user_id: identityCase.id, chatter_user_login: identityCase.name,
    chatter_user_name: identityCase.name, message_id: `tag-${identityCase.name}`, badges: [],
    message: { text: 'tagged', fragments: [] } };
  const result = await commandHandler(channel, event, 'tagged', '', { origin: 'chat', identity });
  assert.equal(!result.error, identityCase.allowed, `command policy: ${identityCase.name}`);
  if (identityCase.allowed) assert.equal(result.message, 'Allowed HELLO');
  else assert.equal(result.status, 403);
  await redis.del(`command:execution:cooldown:${channel}:keyword:${keyword._id}`);
  const before = (await CommandsSchema.findById(keyword._id)).count ?? 0;
  await handleKeywords(channel, event, identity);
  assert.equal((await CommandsSchema.findById(keyword._id)).count ?? 0,
    before + Number(identityCase.allowed), `keyword policy: ${identityCase.name}`);
}
if (runtime === 'cron') {
  const rendered = await renderTimerMessage({ channelID: channel, streamerName: channel, timerName: 'tagged-timer',
    message: 'Scheduled #(tagged)', planTier: 'pro', parse: parseSpecialCommands });
  const messages = [];
  await deliverAstMessage(channel, rendered, true, {
    send: async (_channel, message) => { messages.push(message); return { error: false }; },
    execute: async request => commandHandler(request.channelID, request.eventData,
      request.commandName, request.argument, request.authorization, request.state)
  });
  assert.deepEqual(messages, ['Scheduled', 'Allowed HELLO'], 'authored timer keeps trusted nested command execution');
}
console.log(`PASS ${runtime}: tag/account precedence, saved command and keyword authorization, moderation and runtime readiness`);
process.exit(0);
