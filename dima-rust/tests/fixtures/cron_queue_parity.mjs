// No application imports or service initialization. Run with Node only:
// node dima-rust/tests/fixtures/cron_queue_parity.mjs [--check]
// TypeScript is transpiled in memory; VM globals contain only explicit fixtures.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from '../../../dimabot/node_modules/typescript/lib/typescript.js';

const root = new URL('../../../dimabot/src/', import.meta.url);
const sources = {};
async function source(path) {
  const text = await readFile(new URL(path, root), 'utf8');
  sources[path] = createHash('sha256').update(text).digest('hex');
  return { text, ast: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) };
}
function javascript(text) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const queue = await source('utils/cron_jobs_queue.ts');
const queueText = queue.ast.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(queue.ast)).join('\n');
async function functions(path, names) {
  const { ast } = await source(path);
  const selected = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      assert(!selected.has(node.name.text), `Ambiguous function: ${node.name.text}`);
      selected.set(node.name.text, node.getText(ast).replace(/^export\s+/, ''));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(selected.size, names.length, `Missing named functions in ${path}`);
  return vm.runInNewContext(`${javascript([...selected.values()].join('\n'))}\n({${names.join(',')}})`, {});
}
const memory = await functions('workers/stream_memory.worker.ts', ['getJobAttempt', 'withNextAttempt']);
const clips = await functions('utils/ai/clip_recommendations/vod_clip_recommender_policy.ts', ['getClipJobAttempt']);
// Trace-only source hash makes fixture review catch changes to the other BLPOP
// caller too. No worker top-level statement is ever evaluated.
await source('workers/follow_ledger.worker.ts');

const fixedTime = '2026-10-22T12:34:56.789Z';
const fixedUuid = '00000000-0000-4000-8000-000000000001';
function harness(env = null) {
  const state = { uuidCalls: 0, clockCalls: 0, clientCalls: 0, commands: [] };
  let script;
  class FixtureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]));
      if (!args.length) state.clockCalls++;
    }
  }
  const context = {
    exports: {}, module: { exports: {} },
    process: { env: env === null ? {} : { CRON_JOBS_DEDUPE_SECONDS: env } },
    Date: FixtureDate,
    randomUUID: () => { state.uuidCalls++; return fixedUuid; },
    getDragonflyClient: async caller => {
      assert.equal(caller, 'CronJobsQueue');
      state.clientCalls++;
      return {
        eval: async (lua, options) => {
          script = lua;
          state.commands.push({ operation: 'eval', ...options });
          return 1;
        },
        lPush: async (key, payload) => { state.commands.push({ operation: 'lPush', key, payload }); return 1; },
        del: async key => { state.commands.push({ operation: 'del', key }); return 1; },
      };
    },
  };
  context.module.exports = context.exports;
  vm.runInNewContext(`${javascript(queueText)}\nexports.__defaultDedupeSeconds = DEFAULT_DEDUPE_SECONDS;`, context);
  return { api: context.exports, state, script: () => script };
}
const clone = value => JSON.parse(JSON.stringify(value));
const cases = [];
const add = (operation, input, expected) => cases.push({ operation, input, expected: clone(expected) });
const base = { id: 'existing-id', job: 'summary', requestedAt: 'not-a-date' };
for (const payload of [
  '', '{', 'null', '[]', '42', '"summary"', 'false', '{}', '{"job":7}', '{"job":"  "}',
  '{"job":"summary"}',
  JSON.stringify({ ...base, job: ' \ufeff summary\u00a0 ', requestedBy: ' user ', userID: ' 1 ', accountID: '2', channelID: '3', dedupeKey: ' key ', data: { nested: { x: true } }, extra: 42 }),
  JSON.stringify({ ...base, id: '', requestedAt: '', requestedBy: false, userID: 7, accountID: {}, channelID: [], dedupeKey: null }),
  JSON.stringify({ ...base, job: '\u0085summary\u0085' }),
  JSON.stringify({ ...base, data: { text: '['.repeat(1000) + '\\"' + '}'.repeat(1000) } }),
  '{"job":"first","job":"last","data":{"attempt":2}}',
  ...[null, false, 0, 'text', [], [1, { nested: true }], {}, { source: 'stream_offline', sessionID: 's' }].map(data => JSON.stringify({ ...base, data })),
]) {
  const { api, state } = harness();
  const job = api.parseCronQueueJob(payload);
  add('parse', { payload }, { job, uuidCalls: state.uuidCalls, clockCalls: state.clockCalls });
}
// Store deep source outputs as JSON strings so the fixture file itself remains
// within serde_json's unchanged recursion guard. The Rust API deliberately
// surfaces a depth error at 128 containers rather than silently dropping work.
for (const nestedArrays of [125, 126, 256]) {
  let nested = 'leaf';
  for (let index = 0; index < nestedArrays; index++) nested = [nested];
  const payload = JSON.stringify({ ...base, data: { nested } });
  const { api, state } = harness();
  const job = api.parseCronQueueJob(payload);
  assert(job, 'Actual TypeScript must accept the deep migration-boundary fixture');
  add('parse_depth_boundary', { payload, nestedArrays }, {
    sourceAccepted: true,
    serialized: api.serializeCronQueueJob(job),
    uuidCalls: state.uuidCalls,
    clockCalls: state.clockCalls,
  });
}
for (const token of ['', '  ', ' summary:1 ', '\ufefftoken\u2029', '\u0085token\u0085', 'a::b', 'é:\u0000']) {
  add('dedupe_key', { token }, harness().api.getCronJobDedupeKey(token));
}
for (const job of [
  base,
  { ...base, job: '  no-trim  ', requestedBy: '', userID: ' u ', data: null, dedupeKey: '' },
  { ...base, data: { z: 1e-7, a: 1e21, '2': 'two', '1': 'one', nested: [null, { flag: true }] } },
  { ...base, data: [1, 2, { nested: true }] },
]) add('serialize', { job }, harness().api.serializeCronQueueJob(job));

let enqueueScript;
const inputs = [
  {}, { job: null }, { job: ' ' }, { job: 4 }, { job: 'summary' },
  { job: ' summary ', channelID: ' chan ', userID: ' user ', accountID: ' acct ', requestedBy: ' me ', data: { source: 'manual', value: 1 } },
  { job: 'summary', channelID: false, userID: 9, accountID: {}, requestedBy: [], queueKey: ' ', dedupeToken: 7 },
  { job: 'summary', channelID: 'c', data: { source: 'stream_offline', sessionID: ' s ' } },
  { job: 'summary', data: { source: 'stream_offline', sessionID: 's' }, queueKey: ' custom:queue ', dedupeToken: ' custom:token ' },
  ...[null, '', ' ', 7, {}, false].map(sessionID => ({ job: 'summary', data: { source: 'stream_offline', sessionID } })),
  ...[null, [], [1, 2], false, 'text', {}].map(data => ({ job: 'summary', data })),
  ...[null, 0, false, '', -5, 1, 60, 61.5, 120, '120', '0', '  ', 'junk', 'Infinity', '0x80', [], [120], [1, 2], {}].map(dedupeSeconds => ({ job: 'summary', dedupeSeconds })),
];
for (const input of inputs) {
  const { api, state, script } = harness();
  const result = await api.enqueueCronJob(input);
  enqueueScript ||= script();
  if (script()) assert.equal(script(), enqueueScript);
  add('enqueue', { input, env: null }, { result, ...state });
}
for (const env of ['', '0', '12', '1200', '  ', 'bad', 'Infinity', '-1', '0x80']) {
  for (const dedupeSeconds of [undefined, 0, 120]) {
    const input = { job: 'summary', ...(dedupeSeconds === undefined ? {} : { dedupeSeconds }) };
    const { api, state } = harness(env);
    add('enqueue', { input, env }, { result: await api.enqueueCronJob(input), ...state });
  }
}
for (const key of [undefined, '', ' ', ' key ', '\ufeffkey\u2028']) {
  const { api, state } = harness();
  await api.clearCronJobDedupeByKey(key);
  add('clear', { ...(key === undefined ? {} : { key }) }, state);
}
const two53 = 1n << 53n;
const two57 = 1n << 57n;
const maxFinite = (1n << 1024n) - (1n << 971n);
const overflowThreshold = (1n << 1024n) - (1n << 970n);
const radixInputs = [
  '0x200000000000011',
  ...[0n, 1n, 2n, 3n, 5n, 7n, 17n].flatMap(offset => [
    '0x' + (two53 + offset).toString(16),
    '0b' + (two57 + offset).toString(2),
    '0o' + (two57 + offset).toString(8),
  ]),
  ...[maxFinite, overflowThreshold - 1n, overflowThreshold, overflowThreshold + 1n, 1n << 1024n].map(value => '0x' + value.toString(16)),
  '0x' + 'f'.repeat(300),
  '0x' + '0'.repeat(1000) + '1',
  '0x' + 'f'.repeat(300) + 'g',
  '0b' + '1'.repeat(1030) + '2',
];
for (const env of radixInputs) {
  const value = harness(env).api.__defaultDedupeSeconds;
  add('dedupe_default', { env }, {
    value: Number.isFinite(value) ? value : null,
    category: Number.isNaN(value) ? 'nan' : Number.isFinite(value) ? 'finite' : 'infinity',
  });
}
for (const data of [
  undefined, null, {}, [], ['preserve', { nested: true }],
  ...[null, false, true, 0, -1, 0.5, 1.9, 2, 1e100, '', '  ', '2.9', '0x10', '0b11', '0o10', '+0x10', 'Infinity', 'inf', '1e2', '.5', '2e', 'bad', [], [3], [[4]], [null], [1, 2], {}].map(attempt => ({ retained: true, attempt })),
  ...radixInputs.map(attempt => ({ retained: true, attempt })),
]) {
  const job = { ...base, ...(data === undefined ? {} : { data }) };
  assert.equal(memory.getJobAttempt(job), clips.getClipJobAttempt(job), 'Attempt contracts diverged; revisit shared helper');
  add('attempt', { job }, { attempt: memory.getJobAttempt(job), next: memory.withNextAttempt(job) });
}
add('attempt', { job: null }, { attempt: memory.getJobAttempt(null), next: memory.withNextAttempt(null) });

assert(enqueueScript, 'No actual enqueue script captured');
const output = JSON.stringify({ sources, fixedTime, fixedUuid, enqueueScript, cases }, null, 2) + '\n';
const destination = new URL('cron_queue_parity.json', import.meta.url);
if (process.argv.includes('--check')) {
  assert.equal(await readFile(destination, 'utf8'), output, 'Cron queue fixtures are stale');
  console.log(`Verified ${cases.length} source-backed cron queue cases; no network calls.`);
} else {
  await writeFile(destination, output);
  console.log(`Generated ${cases.length} source-backed cron queue cases; no network calls.`);
}
