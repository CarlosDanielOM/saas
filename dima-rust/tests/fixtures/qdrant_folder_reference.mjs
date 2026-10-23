// Source oracle only: no module imports that initialize databases/providers.
// Run: node dima-rust/tests/fixtures/qdrant_folder_reference.mjs [--check]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from '../../../dimabot/node_modules/typescript/lib/typescript.js';

const root = new URL('../../../dimabot/src/utils/', import.meta.url);
const sources = {};
async function reference(path, names, dependencies = {}) {
  const source = await readFile(new URL(path, root), 'utf8');
  sources[path] = createHash('sha256').update(source).digest('hex');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const stripped = ast.statements.filter(s => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s))
    .map(s => s.getText(ast).replace(/^export\s+/, '')).join('\n');
  const js = ts.transpileModule(stripped, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(`${js}\n({${names.join(',')}})`, { createHash, ...dependencies }, { timeout: 1000 });
}
const ids = await reference('qdrant/qdrant_point_id.ts', ['generateQdrantPointId', 'qdrantPointBelongsToMemory']);
const relevance = await reference('ai/memory/memory_relevance.ts', ['isPassiveMemoryRelevant', 'PASSIVE_CANDIDATE_SCORE']);
const semantic = await reference('qdrant/functions/chat_logs/retrieve_chat_context.qdrant.ts', ['getSemanticMemoryLimitForTier', 'dedupeAndSort', 'parseSemanticMemory']);
const memory = await reference('qdrant/functions/memory/retrieve_memory_context.qdrant.ts', ['parsePoint']);
const window = await reference('qdrant/functions/chat_logs/retrieve_chat_window.qdrant.ts', ['parsePoint']);
const sync = await reference('qdrant/functions/memory/sync_memory.qdrant.ts', ['buildEmbeddingInput']);
const chatSchema = await reference('qdrant/collections/twitch/message.qdrant.collection.ts', ['TwitchChatLogsQdrantCollection']);
const memorySchema = await reference('qdrant/collections/twitch/memory.qdrant.collection.ts', ['TwitchChannelMemoriesQdrantCollection']);
const cases = [];
function add(operation, input, expected) {
  cases.push(JSON.parse(JSON.stringify({ operation, input, expected })));
}
for (const input of [
  ['channel', 'user', 0], ['123', '456', 1720000000000], ['', '', 0],
  ['canal:uno', 'usér😀', 42], ['a', 'b', -1], ['a', 'b', 1.5],
  ['a', 'b', 9007199254740991], ['a', 'b', 1e21],
]) add('point_id', input, ids.generateQdrantPointId(...input));
for (const payload of [null, {}, { memory_id: 'm', channel_id: 'c' }, { memory_id: 'm', channel_id: 'other' }, { memory_id: 42, channel_id: 7 }, { memory_id: 0, channel_id: false }]) {
  for (const [memoryID, channelID] of [['m', 'c'], ['42', '7'], ['', '']]) {
    add('memory_owner', { payload, memoryID, channelID }, ids.qdrantPointBelongsToMemory(payload, memoryID, channelID));
  }
}
for (const [query, summary] of [
  ['remember this channel', 'remember channel'], ['dragon lore', 'our dragon mascot'],
  ['CAFÉ recital', 'café nocturno'], ['猫猫猫猫', '猫猫猫猫'], ['abcd_123', 'ABCD_123'],
  ['play chess', 'play music'], ['İSTANBUL', 'istanbul'], ['𐐀𐐀', '𐐨𐐨'],
]) for (const score of [0.44, 0.45, 0.55, 0.72]) {
  add('passive_relevant', { query, summary, score }, relevance.isPassiveMemoryRelevant(query, summary, score));
}
for (const tier of ['free', 'premium', 'pro', 'PRO', '', 'unknown']) {
  add('semantic_limit', { tier }, semantic.getSemanticMemoryLimitForTier(tier));
}
const points = [
  { id: 1, score: .9, payload: { channel_id: 'c', message: 'same message', timestamp: 10, username: 'first' } },
  { id: 2, score: .99, payload: { channel_id: 'c', message: 'same message', timestamp: 20, username: 'later' } },
  { id: 3, score: .9, payload: { channel_id: 'c', message: 'different message', timestamp: 30 } },
  { id: 4, score: .99, payload: { channel_id: 'other', message: 'wrong channel', timestamp: 30 } },
  { id: 5, score: .8, payload: { channel_id: 'c', message: 'hi', timestamp: 30 } },
  { id: 6, score: .8, payload: { channel_id: 'c', message: '😀a', timestamp: 30 } },
  { id: 7, score: .7, payload: { channel_id: 'c', message: '\ufeffhello\ufeff', timestamp: 40 } },
  { id: 8, distance: .69, payload: { channel_id: 'c', message: 'fallback result', timestamp: '50' } },
  { id: 9, payload: {} },
];
for (const threshold of [.75, .69, 1]) for (const limit of [1, 3, 15]) {
  add('semantic_select', { channelID: 'c', points, threshold, limit }, semantic.dedupeAndSort('c', points, threshold, limit));
}
for (const point of [
  {}, { id: 0, payload: {} },
  { id: 1, score: .7, payload: { channel_id: 'c', content: ' hello ', updated_at: 123 } },
  { id: 2, distance: .6, payload: { channel_id: 'c', memory_id: 'm', content: '\ufeffhello\ufeff', confidence: '0.8', subject_username: 'name' } },
  { id: 3, score: '.8', payload: { channel_id: 'c', memory_id: 'm', content: 'hi', status: '', risk: '', summary: '' } },
]) add('memory_parse', { point }, memory.parsePoint(point));
for (const point of [
  {}, { payload: { channel_id: 'c', message: 'hi', timestamp: 0 } },
  { payload: { channel_id: ' c ', message: ' hello ', timestamp: '12.9' } },
  { payload: { channel_id: 'c', message: '\u0085', timestamp: true, username: 0, user_id: false } },
  { payload: { channel_id: 'c', message: '\ufeff', timestamp: 10 } },
]) add('window_parse', { point }, window.parsePoint(point));
for (const [summary, content] of [['sum', 'body'], ['', 'body'], [' summary ', ' body '], ['\ufeff', '\u0085'], ['', '']]) {
  add('embedding_input', { summary, content }, sync.buildEmbeddingInput(summary, content));
}
add('collection', { kind: 'chat' }, chatSchema.TwitchChatLogsQdrantCollection);
add('collection', { kind: 'memory' }, memorySchema.TwitchChannelMemoriesQdrantCollection);
// Track the entire folder, including startup and queue wrappers exercised by
// the Rust behavior suites rather than these pure reference cases.
for (const file of (await readdir(new URL('qdrant/', root), { recursive: true })).sort()) {
  if (!file.endsWith('.ts')) continue;
  const path = `qdrant/${file}`;
  sources[path] = createHash('sha256').update(await readFile(new URL(path, root))).digest('hex');
}
const output = { sources, cases };
const destination = new URL('qdrant_folder_reference.json', import.meta.url);
if (process.argv.includes('--check')) assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), output);
else await writeFile(destination, JSON.stringify(output, null, 2) + '\n');
console.log(`${cases.length} Qdrant source-reference cases ${process.argv.includes('--check') ? 'matched' : 'generated'}`);
