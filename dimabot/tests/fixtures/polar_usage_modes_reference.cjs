'use strict';
// Author-only oracle for ingest modes and grantPolarAiCredits.
// The parent runs it with the pinned Node toolchain. It does not open a network.
const {sourcePath: fixturePath, resolveSource} = require('./ai_usage_source_resolver.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {eventsIngestToJSON} = require('@polar-sh/sdk/models/components/eventsingest.js');

assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');

const [mode, dir, ...extra] = process.argv.slice(2);
assert.ok(['--write', '--check'].includes(mode) && dir && extra.length === 0);
assert.ok(fs.statSync(dir).isDirectory());
const namespace = process.env.KEYWORD_FIXTURE_NAMESPACE;
assert.match(namespace ?? '', /^keyword-fixture-[a-f0-9]{12}:$/);
const root = path.resolve(__dirname, '../..');
const file = 'src/utils/polarsh.ts';
const source = fs.readFileSync(fixturePath(root, file), 'utf8');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const runtimeHashes = {
  node: hash(fs.readFileSync(process.execPath)),
  typescript: hash(fs.readFileSync(require.resolve('typescript'))),
  typescriptPackage: hash(fs.readFileSync(require.resolve('typescript/package.json'))),
};
assert.equal(runtimeHashes.node, '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
assert.equal(runtimeHashes.typescript, '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
assert.equal(runtimeHashes.typescriptPackage, '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6');
const artifactDir = fs.realpathSync(dir);
const repoDir = fs.realpathSync(root);
assert.ok(artifactDir !== repoDir && !artifactDir.startsWith(repoDir + path.sep));
assert.deepEqual(fs.readdirSync(artifactDir), mode === '--write' ? [] : ['polar-usage-modes.json']);
assert.equal(hash(source), '5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec');

const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = [
  'getPolarShClient',
  'ingestPolarSHEvent',
  'grantPolarAiCredits',
  'isIngestComplete',
  'projectAcceptedUsage',
];
const declarations = names.map((name) => {
  const matches = ast.statements.filter((node) => node.name?.text === name);
  assert.equal(matches.length, 1, name);
  const text = matches[0].getText(ast);
  return {name, text, sha256: hash(text)};
});
const eventSource = resolveSource(root, 'src/utils/ai_usage_event.ts');
const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.getText(ast));
const body = ast.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(ast));
const js = ts.transpileModule(imports.concat(body).join('\n'), {
  fileName: file,
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;

const calls = [];
const env = {};
const redis = {lock: null, lists: {}, receipts: []};
let state = {};
const cache = {
  async set(key, value, options) {
    calls.push(['set', key, options ?? null]);
    if (redis.lock) return null;
    redis.lock = value;
    return 'OK';
  },
  async get(key) {
    calls.push(['get', key]);
    return key.startsWith('locks:') ? redis.lock : null;
  },
  async del(key) {
    calls.push(['del', key]);
    if (key.startsWith('locks:')) redis.lock = null;
    return 1;
  },
  async type() {
    calls.push(['type']);
    return 'none';
  },
  async rPush(key, value) {
    calls.push(['rPush', key]);
    if (key === 'cron:ai-usage-receipts:queue') {
      if (state.failReceipt) throw Error('fixture-receipt-failure');
      redis.receipts.push(value);
      return redis.receipts.length;
    }
    redis.lists[key] ??= [];
    redis.lists[key].push(...(Array.isArray(value) ? value : [value]));
    return redis.lists[key].length;
  },
  async lRange(key) {
    calls.push(['lRange', key]);
    return redis.lists[key] ?? [];
  },
  async lTrim(key) {
    calls.push(['lTrim', key]);
    redis.lists[key] = [];
  },
};
const mocked = {
  '@polar-sh/sdk': {
    Polar: class {
      constructor(options) {
        if (!options || !options.accessToken) throw Error('missing token');
        calls.push(['polar-init']);
        this.events = {
          ingest: async (body) => {
            calls.push(['ingest', body]);
            if (state.ingestThrow) throw Error(state.ingestThrow);
            return state.ingestResult ?? {inserted: body.events.length, duplicates: 0};
          },
        };
      }
    },
  },
  'node:crypto': {randomUUID: () => 'fixture-lock-uuid'},
  './databases/dragonfly.database.js': {
    getDragonflyClient: async (caller) => {
      calls.push(['dragonfly', caller]);
      if (state.failRedis) throw Error('fixture-redis-down');
      return cache;
    },
  },
  './logger.js': {
    info: async (data, options) => {
      calls.push(['info', data, options ?? null]);
    },
    error: async (data, options) => {
      calls.push(['error', data, options ?? null]);
    },
  },
  './billing.js': {
    recordAiCreditUsage: async (channel, credits, externalId) => {
      calls.push(['project', channel ?? null, credits, externalId]);
    },
  },
  './posthog_events.js': {
    trackAiUsageRecorded: (payload) => {
      calls.push(['track', payload]);
      if (state.failTrack) throw Error('fixture-track-failure');
    },
  },
  './ai_usage_ledger.js': require('./ai_usage_producer_source.cjs').loadSource('vm').producer,
  './ai_usage_event.js': require('./ai_usage_producer_source.cjs').loadSource('vm').event,
};
const mod = {exports: {}};
vm.runInNewContext(js, {
  module: mod,
  exports: mod.exports,
  require: (name) => {
    assert.ok(mocked[name], `unexpected import ${name}`);
    return mocked[name];
  },
  process: {env},
  console,
  Error,
  Date,
  setTimeout: (fn) => fn(),
}, {filename: file, timeout: 10000});

const emoji = '😀'.repeat(48);
const audio = {
  customerId: 'customer',
  channelID: 'channel-immediate',
  externalId: 'entry-audio',
  cost: 0.5,
  reason: 'tts_piper',
  _cost: 1,
  characters: 100,
  usage: {},
};
const cases = [
  {id: 'factory-missing-token', kind: 'factory', compare: 'source', oat: false, failRedis: true, calls: ['missing', 'missing']},
  {id: 'factory-first-caller', kind: 'factory', compare: 'source', oat: true, failRedis: true, caller: 'ingestPolarSHEvent immediate mode', again: 'grantPolarAiCredits'},
  {id: 'immediate-audio', kind: 'immediate', compare: 'event', options: {...audio, mode: 'immediate'}},
  {id: 'immediate-llm', kind: 'immediate', compare: 'event', options: {...audio, mode: 'immediate', externalId: 'entry-llm', _cost: undefined, characters: undefined, llm: {model: 'openai/gpt-4o:latest', usage: {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12}}}},
  {id: 'immediate-plain', kind: 'immediate', compare: 'event', options: {...audio, mode: 'immediate', externalId: 'entry-plain', _cost: undefined, characters: undefined, cost: 0.25}},
  {id: 'immediate-no-channel', kind: 'immediate', compare: 'event', options: {...audio, mode: 'immediate', channelID: undefined, externalId: 'entry-no-channel'}},
  {id: 'immediate-missing-customer', kind: 'immediate', compare: 'reject', options: {...audio, mode: 'immediate', customerId: ''}},
  {id: 'immediate-incomplete', kind: 'immediate', compare: 'source', options: {...audio, mode: 'immediate', externalId: 'entry-incomplete'}, ingestResult: {inserted: 0, duplicates: 0}},
  {id: 'immediate-http', kind: 'immediate', compare: 'source', options: {...audio, mode: 'immediate', externalId: 'entry-http'}, ingestThrow: 'Polar API error 500: nope'},
  {id: 'immediate-loose-invalid', kind: 'immediate', compare: 'source', adapter: 'sdk-invalid', options: {...audio, mode: 'immediate', externalId: 'entry-loose'}, ingestResult: {inserted: 'x', duplicates: null}},
  {id: 'default-batch', kind: 'immediate', compare: 'event', options: {...audio, externalId: 'entry-default-batch', channelID: 'channel-batch'}},
  {id: 'grant-floor', kind: 'grant', compare: 'event', options: {customerId: 'customer', channelID: 'channel-grant', credits: 1.9, reason: 'manual', externalId: 'grant-floor'}},
  {id: 'grant-two', kind: 'grant', compare: 'event', options: {customerId: 'customer', channelID: 'channel-grant', credits: 2.2, reason: 'manual', externalId: 'grant-two', source: ' ops ', adminLogin: 'root'}},
  {id: 'grant-default-source', kind: 'grant', compare: 'event', options: {customerId: 'customer', credits: 3, reason: 'manual', externalId: 'grant-default', source: ''}},
  {id: 'grant-whitespace-source', kind: 'grant', compare: 'event', options: {customerId: 'customer', credits: 4, reason: 'manual', externalId: 'grant-space', source: '   '}},
  {id: 'grant-utf16-source', kind: 'grant', compare: 'event', options: {customerId: 'customer', credits: 5, reason: 'manual', externalId: 'grant-utf16', source: `${emoji}Z`}},
  {id: 'grant-long-source', kind: 'grant', compare: 'event', options: {customerId: 'customer', credits: 6, reason: 'manual', externalId: 'grant-long', source: `${'a'.repeat(100)}`}},
  {id: 'grant-empty-admin', kind: 'grant', compare: 'event', options: {customerId: 'customer', credits: 7, reason: 'manual', externalId: 'grant-admin', adminLogin: ''}},
  {id: 'grant-no-channel', kind: 'grant', compare: 'event', options: {customerId: 'customer', credits: 8, reason: 'manual', externalId: 'grant-no-channel', source: 'support'}},
  {id: 'grant-missing-customer', kind: 'grant', compare: 'reject', options: {customerId: '', credits: 1, reason: 'manual'}},
  {id: 'grant-zero', kind: 'grant', compare: 'reject', options: {customerId: 'customer', credits: 0, reason: 'manual'}},
  {id: 'grant-fraction', kind: 'grant', compare: 'reject', options: {customerId: 'customer', credits: 0.9, reason: 'manual'}},
  {id: 'grant-negative', kind: 'grant', compare: 'reject', options: {customerId: 'customer', credits: -1.2, reason: 'manual'}},
  {id: 'grant-nan', kind: 'grant', compare: 'reject', options: {customerId: 'customer', credits: 'NaN', reason: 'manual'}},
  {id: 'grant-infinity', kind: 'grant', compare: 'reject', options: {customerId: 'customer', credits: 'Infinity', reason: 'manual'}},
  {id: 'grant-incomplete', kind: 'grant', compare: 'source', options: {customerId: 'customer', channelID: 'channel-grant', credits: 2, reason: 'manual', externalId: 'grant-incomplete'}, ingestResult: {inserted: 0, duplicates: 0}},
  {id: 'grant-track-failure', kind: 'grant', compare: 'source', failTrack: true, options: {customerId: 'customer', channelID: 'channel-grant', credits: 2, reason: 'manual', externalId: 'grant-track'}},
  {id: 'grant-receipt-failure', kind: 'grant', compare: 'source', failReceipt: true, options: {customerId: 'customer', channelID: 'channel-grant', credits: 2, reason: 'manual', externalId: 'grant-receipt'}},
  {id: 'grant-redis-failure', kind: 'grant', compare: 'source', failRedis: true, options: {customerId: 'customer', channelID: 'channel-grant', credits: 2, reason: 'manual', externalId: 'grant-redis'}},
];
assert.ok(cases.length >= 20 && cases.length <= 35);

function materialize(options) {
  const copy = {...options};
  if (copy.credits === 'NaN') copy.credits = Number.NaN;
  if (copy.credits === 'Infinity') copy.credits = Number.POSITIVE_INFINITY;
  if (copy.credits === '-Infinity') copy.credits = Number.NEGATIVE_INFINITY;
  return copy;
}
function tags(list) {
  return list.map((call) => call[0]);
}
function reset(spec) {
  calls.length = 0;
  redis.lock = null;
  redis.lists = {};
  redis.receipts = [];
  state = {
    failRedis: !!spec.failRedis,
    failTrack: !!spec.failTrack,
    failReceipt: !!spec.failReceipt,
    ingestThrow: spec.ingestThrow ?? null,
    ingestResult: spec.ingestResult ?? null,
  };
  if (spec.oat === false) delete env.POLARSH_OAT;
  else env.POLARSH_OAT = 'fixture-oat';
}

(async () => {
  const outputs = [];
  for (const spec of cases) {
    reset(spec);
    let result;
    if (spec.kind === 'factory') {
      const seen = [];
      const attempt = async (caller) => {
        try {
          await mod.exports.getPolarShClient(caller);
          seen.push('ok');
        } catch (error) {
          seen.push(error instanceof Error ? error.message : String(error));
        }
      };
      if (spec.id === 'factory-missing-token') {
        await attempt('first');
        await attempt('second');
        assert.deepEqual(seen, ['POLARSH_OAT is not set', 'POLARSH_OAT is not set']);
        assert.deepEqual(tags(calls), []);
      } else {
        await attempt(spec.caller);
        await attempt(spec.again);
        assert.deepEqual(seen, ['ok', 'ok']);
        assert.equal(calls.filter((call) => call[0] === 'polar-init').length, 1);
        assert.equal(calls.filter((call) => call[0] === 'info').length, 1);
        assert.equal(calls.find((call) => call[0] === 'info')[1].message, `PolarSH client initialized for ${spec.caller}`);
        assert.equal(calls.filter((call) => call[0] === 'dragonfly').length, 0);
      }
      result = {error: spec.id === 'factory-missing-token', message: spec.id === 'factory-missing-token' ? 'POLARSH_OAT is not set' : undefined};
    } else if (spec.kind === 'grant') {
      result = await mod.exports.grantPolarAiCredits(materialize(spec.options));
    } else {
      result = await mod.exports.ingestPolarSHEvent(materialize(spec.options));
    }
    const ingest = calls.find((call) => call[0] === 'ingest');
    const event = ingest ? ingest[1].events[0] : null;
    let sdkBody = null;
    if (ingest) sdkBody = eventsIngestToJSON(ingest[1]);
    outputs.push({
      id: spec.id,
      kind: spec.kind,
      compare: spec.compare,
      adapter: spec.adapter ?? null,
      input: spec.options ?? null,
      result,
      eventJson: event ? JSON.stringify(event) : null,
      sdkBody,
      calls: tags(calls),
      logged: calls.filter((call) => call[0] === 'error').map((call) => call[1].function),
      projected: calls.some((call) => call[0] === 'project'),
      receipt: calls.some((call) => call[0] === 'rPush' && call[1] === 'cron:ai-usage-receipts:queue'),
      tracked: calls.some((call) => call[0] === 'track'),
    });
  }
  const byId = (id) => outputs.find((item) => item.id === id);
  assert.equal(byId('immediate-audio').calls[0], 'dragonfly');
  assert.ok(byId('immediate-audio').calls.indexOf('dragonfly') < byId('immediate-audio').calls.indexOf('ingest'));
  assert.ok(byId('immediate-audio').calls.indexOf('ingest') < byId('immediate-audio').calls.indexOf('project'));
  assert.equal(byId('immediate-audio').projected, true);
  assert.equal(byId('immediate-audio').receipt, true);
  assert.equal(byId('immediate-audio').tracked, true);
  assert.equal(byId('immediate-audio').calls.includes('set'), false);
  assert.equal(byId('immediate-no-channel').receipt, false);
  assert.equal(byId('immediate-no-channel').projected, true);
  assert.equal(byId('immediate-missing-customer').calls.includes('dragonfly'), false);
  assert.equal(byId('immediate-missing-customer').result.message, 'customerId is required');
  assert.equal(byId('immediate-incomplete').result.message, 'PolarSH ingest incomplete');
  assert.equal(byId('immediate-incomplete').result.details.inserted, 0);
  assert.equal(byId('immediate-incomplete').logged.length, 0);
  assert.equal(byId('immediate-incomplete').projected, false);
  assert.equal(byId('immediate-http').result.message, 'Polar API error 500: nope');
  assert.equal(byId('immediate-http').logged[0], 'ingestPolarSHEvent');
  assert.equal(byId('immediate-http').result.details, undefined);
  assert.equal(byId('immediate-loose-invalid').result.details.inserted, 'x');
  assert.equal(byId('default-batch').calls.includes('set'), true);
  assert.equal(byId('grant-floor').result.error, false);
  assert.equal(byId('grant-floor').calls.includes('project'), false);
  assert.ok(byId('grant-floor').calls.indexOf('track') < byId('grant-floor').calls.indexOf('dragonfly'));
  assert.equal(byId('grant-no-channel').calls.includes('dragonfly'), false);
  assert.equal(byId('grant-no-channel').receipt, false);
  assert.equal(byId('grant-incomplete').result.message, 'PolarSH grant credits ingest incomplete');
  assert.equal(byId('grant-incomplete').logged.length, 0);
  assert.equal(byId('grant-incomplete').tracked, false);
  assert.equal(byId('grant-track-failure').result.error, false);
  assert.equal(byId('grant-track-failure').receipt, true);
  assert.equal(byId('grant-receipt-failure').result.error, false);
  assert.deepEqual(byId('grant-receipt-failure').logged, ['grantPolarAiCredits.receipt']);
  assert.equal(byId('grant-redis-failure').result.error, false);
  assert.deepEqual(byId('grant-redis-failure').logged, ['grantPolarAiCredits.receipt']);
  for (const id of ['grant-zero', 'grant-fraction', 'grant-negative', 'grant-nan', 'grant-infinity']) {
    assert.equal(byId(id).result.message, 'credits must be a positive number', id);
    assert.equal(byId(id).calls.includes('ingest'), false, id);
  }
  const reader = fs.readFileSync(__filename);
  const payload = JSON.stringify({
    version: 1,
    namespace,
    node: process.version,
    v8: process.versions.v8,
    typescript: ts.version,
    sourceHash: hash(source),
    readerHash: hash(reader),
    eventSource,
    runtimeHashes,
    declarations,
    cases: outputs,
  }, null, 2) + '\n';
  const out = path.join(dir, 'polar-usage-modes.json');
  if (mode === '--write') fs.writeFileSync(out, payload, {flag: 'wx'});
  else assert.equal(fs.readFileSync(out, 'utf8'), payload);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
