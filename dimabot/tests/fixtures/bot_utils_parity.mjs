// Regenerate with: node --import ./dimabot/node_modules/tsx/dist/loader.mjs dimabot/tests/fixtures/bot_utils_parity.mjs
// These imports are pure helpers. Stateful modules are read as text and only
// the named pure functions are evaluated, without initializing any service.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const {resolveSource} = createRequire(import.meta.url)('./ai_usage_source_resolver.cjs');
const fixtureRoot = fileURLToPath(new URL('../..', import.meta.url));
const usageSource = () => resolveSource(fixtureRoot, 'src/utils/ai_usage_event.ts').path;

const sourceRoot = new URL('../../src/utils/', import.meta.url);
const sources = new Map();
async function source(name) {
  const text = await readFile(name === 'ai_usage_event' ? usageSource() : new URL(`${name}.ts`, sourceRoot), 'utf8');
  sources.set(`${name}.ts`, createHash('sha256').update(text).digest('hex'));
  return text;
}
async function pureModule(name) {
  await source(name);
  return import(name === 'ai_usage_event' ? pathToFileURL(usageSource()) : new URL(`${name}.ts`, sourceRoot));
}
async function functionsFrom(name, names) {
  const input = await source(name);
  const ast = ts.createSourceFile(`${name}.ts`, input, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && names.includes(statement.name?.text));
  if (selected.length !== names.length) throw new Error(`Missing source functions: ${name}`);
  const text = selected.map(statement => statement.getText(ast).replace(/^export\s+/, '')).join('\n');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(`${js}\n({${names.join(',')}})`, { URL, encodeURIComponent });
}
const cooldown = await pureModule('command_cooldown');
const keywords = await pureModule('keywords');
const chat = await pureModule('chat_notification_defaults');
const catalog = await pureModule('chat_event_catalog');
const usage = await pureModule('ai_usage_event');
const classification = await pureModule('ai_usage_classification');
const condition = await pureModule('eventsub_condition');
const breaker = await pureModule('eventsub_reconciliation_policy');
const raids = await pureModule('raid_direction');
const serialized = await functionsFrom('eventsub', ['sortValueDeep', 'serializeCondition']);
const stable = await functionsFrom('eventsub_reconciliation', ['stableCondition']);
const journal = await functionsFrom('domain_events', ['normalizeRequired', 'buildDomainEventKey', 'toEnvelope']);
const consumer = await functionsFrom('domain_event_consumer', ['toEnvelope']);
const cases = [];
const json = value => JSON.parse(JSON.stringify(value));
function add(operation, input, run) {
  try { cases.push({ operation, input, expected: json(run()) }); }
  catch (error) { cases.push({ operation, input, error: error.message }); }
}
for (const plan of [null, 'free', 'premium', 'pro', 'PRO', 'unknown']) {
  add('minimum_cooldown', { plan }, () => cooldown.getMinimumCommandCooldown(plan));
}
for (const text of ['  Hello   WORLD  ', 'cafe\u0301', 'ΟΣ', 'İ', 'uno\u00a0dos', '\ufeffhello\ufeff', '\u0085hello\u0085', '𐐀  A', 'a\u2028b']) {
  add('normalize_keyword', { text }, () => keywords.normalizeKeyword(text));
}
for (const [text, matchMode] of [['hello', 'start'], ['  CAFÉ  ', 'anywhere'], ['cafe\u0301', 'exact'], ['hello!', 'start'], ['', 'start'], ['hi', 'bad'], ['a'.repeat(61), 'start'], ['𐐀'.repeat(30), 'exact'], ['𐐀'.repeat(31), 'exact'], ['a\u0085b', 'start']]) {
  add('validate_keyword', { text, settings: { matchMode } }, () => keywords.validateKeyword(text, { matchMode }));
}
const entries = [
  { id: 'hello', text: 'hello', matchMode: 'anywhere' },
  { id: 'phrase', text: 'hello world', matchMode: 'start' },
  { id: 'accent', text: 'café', matchMode: 'exact' },
  { id: 'number', text: '42', matchMode: 'anywhere' },
];
for (const message of ['HELLO world!', 'say hello?', 'xhello hello_', 'cafe\u0301', '42 hello', 'hello 42', 'hello-world', 'helló hello', '']) {
  add('match_keywords', { entries, message }, () => keywords.matchKeywords(keywords.compileKeywordIndex(entries), message));
}
for (const language of ['en', 'es']) for (const notice of ['watch_streak', 'modiversary', 'unknown']) {
  for (const config of [{}, { message: '', modiversaryMessage: '' }, { watchStreakEnabled: false, modiversaryEnabled: false }, { message: 'custom', modiversaryMessage: 'custom mod' }, { message: chat.WATCH_STREAK_MESSAGES.es, modiversaryMessage: chat.MODIVERSARY_MESSAGES.en }]) {
    add('chat_message', { language, notice, config }, () => chat.resolveChatNotificationMessage(notice, config, language));
  }
}
add('chat_catalog', {}, () => catalog.withBuiltinChatEvents([]));
add('chat_catalog', { existing: [{ type: 'channel.chat.notification', custom: true }, { type: 'custom.event' }] }, () => catalog.withBuiltinChatEvents([{ type: 'channel.chat.notification', custom: true }, { type: 'custom.event' }]));
for (const reason of ['tts_fish', 'tts_kokoro', 'tts_piper', 'messages', 'harness_tools', 'harness_end', 'planner', 'coding_agent', 'stream_summary', 'weekly_summary', 'monthly_summary', 'vod_clip_recommendation', 'Free benefits', '', 'unknown']) {
  const input = { entryId: 'entry-fixed', channelID: '123' };
  add('usage_context', { reason, input }, () => usage.createAiUsageContext(reason, input));
  add('usage_metadata', { reason, input }, () => usage.toPolarUsageMetadata(usage.createAiUsageContext(reason, input)));
}
for (const input of [{ entryKind: 'usage' }, { entryKind: 'adjustment' }, { entryKind: 'adjustment', adjustmentType: 'gifted_credits' }, { entryKind: 'adjustment', source: 'polar_meter_credit' }, { entryKind: 'adjustment', source: 'free_credit_reset' }, { entryKind: 'adjustment', source: 'admin_credit_grant' }, { entryKind: 'adjustment', operation: 'purchase_pack' }, { entryKind: 'adjustment', operation: 'refund' }, { entryKind: 'adjustment', operation: 'correction' }, { entryKind: 'adjustment', reason: 'Free benefits' }]) {
  add('classify_adjustment', input, () => classification.classifyAdjustment(input));
}
for (const subscription of [{ type: 'channel.follow', condition: { broadcaster_user_id: 'user', moderator_user_id: 'moderator' } }, { type: 'user.update', condition: { user_id: 'user' } }, { type: 'channel.raid', condition: { from_broadcaster_user_id: 'user', to_broadcaster_user_id: '' } }, { type: 'channel.raid', condition: { to_broadcaster_user_id: 'user' } }]) {
  add('expected_condition', { subscription, channelID: '123' }, () => condition.buildExpectedEventsubCondition(subscription, '123'));
}
for (const [total, unhealthy, ratio, minimum] of [[0, 0, .25, 5], [20, 5, .25, 5], [19, 5, .25, 5], [10, 4, .25, 5], [10, 5, 2, 0], [10, 1, -1, 0]]) {
  add('circuit_breaker', { total, unhealthy, ratio, minimum }, () => breaker.shouldTripEventsubCircuitBreaker(total, unhealthy, ratio, minimum));
}
for (const input of [{}, { from_broadcaster_user_id: '123' }, { to_broadcaster_user_id: '123' }, { from_broadcaster_user_id: '123', to_broadcaster_user_id: '456' }, { from_broadcaster_user_id: '' }]) {
  add('raid_direction', input, () => raids.raidDirection(input));
}
// The shared Rust canonicalizer accepts legal flat string conditions. Null
// fields are filtered before conversion, as both source comparators do.
for (const input of [{ z: '', b: '2', a: '1', c: null }, { user_id: 'moderator', broadcaster_user_id: '123', unused: '' }]) {
  add('serialize_condition', input, () => serialized.serializeCondition(input));
  add('stable_condition', input, () => stable.stableCondition(input));
}
for (const input of [{ _id: 'objectid', eventKey: 'source:id:type', source: 'test', type: 'test.event', unknown: 'omit', metadata: null }, { _id: 'objectid', ownerUserId: null, occurredAt: '2026-10-22T00:00:00.000Z', payload: { nested: true } }]) {
  add('domain_envelope', input, () => {
    const expected = json(journal.toEnvelope(input));
    if (JSON.stringify(expected) !== JSON.stringify(json(consumer.toEnvelope(input)))) throw new Error('Source envelope functions disagree');
    return expected;
  });
}
for (const [source, sourceEventId, type] of [['twitch', 'id:with/slash', 'event type'], [' a ', '!*\'()é', 'x'], ['', 'id', 'type']]) {
  add('domain_event_key', { source, sourceEventId, type }, () => journal.buildDomainEventKey(source, sourceEventId, type));
}
const output = { sources: Object.fromEntries([...sources].sort()), cases };
await writeFile(new URL('bot_utils_parity.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(`Generated ${cases.length} source-backed parity cases from ${sources.size} TypeScript files.`);
