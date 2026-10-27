// Execute the real TypeScript logger and telemetry metadata mapper with every
// external sink replaced. No environment files, application startup or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = new URL('../../../', import.meta.url);
const require = createRequire(new URL('dimabot/package.json', root));
const ts = require('typescript');
const paths = ['src/utils/logger.ts', 'src/utils/observability/telemetry.ts'];
const source = Object.fromEntries(paths.map(path => [path, readFileSync(new URL(`dimabot/${path}`, root), 'utf8')]));
const compile = code => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = Object.fromEntries(Object.entries(source).map(([path, code]) => [path, compile(code)]));
const clone = value => JSON.parse(JSON.stringify(value));

function run(input) {
  const writes = [], output = [], exports = [];
  const FakeMath = Object.create(Math);
  FakeMath.random = () => 0.25;
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [input.at])); }
    static now() { return input.at; }
  }
  function load(code, imports) {
    const module = { exports: {} };
    vm.runInNewContext(code, {
      exports: module.exports, module,
      require: name => {
        if (name.startsWith('node:')) return require(name);
        assert.ok(name in imports, `unexpected dependency ${name}`);
        return imports[name];
      },
      Date: FixtureDate, Math: FakeMath,
      process: { argv: ['node', '/fixture/logger.js'], env: {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      console: {
        log: value => output.push({ stream: 'stdout', output: clone(value) }),
        warn: value => output.push({ stream: 'stderr', output: clone(value) }),
        error: value => output.push({ stream: 'stderr', output: clone(value) }),
      },
    });
    return module.exports;
  }
  const telemetry = load(compiled[paths[1]], { redis: { createClient() { throw Error('network forbidden'); } } });
  telemetry.telemetryTesting.enable();
  telemetry.telemetryTesting.reset();
  const logger = load(compiled[paths[0]], {
    './observability/telemetry.js': telemetry,
    './databases/dragonfly.database.js': { getDragonflyClient: async () => ({
      set: async (key, raw) => { writes.push({ keyPrefix: key.slice(0, key.lastIndexOf(':') + 1), entry: JSON.parse(raw) }); },
      expire: async (_key, ttl) => { writes.at(-1).ttlSeconds = ttl; },
    }) },
    '@opentelemetry/api-logs': { logs: { getLogger: () => ({ emit: record => exports.push(clone(record)) }) } },
  });
  return logger[input.level](input.data, input.options).then(result => ({
    writes, console: output, otel: exports,
    metadata: clone(telemetry.telemetryTesting.snapshot().logs),
    result: clone(result),
  }));
}

const cases = [];
const add = (name, level, data, options, at = 1793100600000) => cases.push({ name, input: { at, level, data, ...(options === undefined ? {} : { options }) } });
for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
  add(`${level}-defaults`, level, { function: 'fixture.run', message: 'local diagnostic', status: 200 });
  for (const destination of ['cache', 'console', 'both']) {
    add(`${level}-${destination}`, level, { function: 'fixture.run', attempt: 2 }, { destination, channelId: '1234' });
  }
}
for (const [name, at] of [
  ['epoch', 0], ['before-epoch', -1], ['leap-midnight', Date.parse('2024-02-29T00:00:00Z')],
  ['leap-noon', Date.parse('2024-02-29T12:00:00Z')], ['year-end', Date.parse('2025-12-31T23:59:59Z')],
  ['millisecond-floor', Date.parse('2026-10-27T01:02:03.999Z')],
]) add(`timestamp-${name}`, 'info', {}, { destination: 'cache' }, at);
for (const [name, options] of [
  ['empty-options', {}], ['empty-platform', { platform: '' }], ['custom-platform', { platform: 'kick' }],
  ['empty-channel', { channelId: '' }], ['custom-channel', { channelId: 'owner-123' }],
  ['invalid-metadata-channel', { channelId: 'bad:channel' }],
  ['unicode-options', { platform: 'twitch', channelId: 'ñ😀' }],
]) add(name, 'error', { function: 'fixture.options', status: 503 }, options);
for (const [name, data] of [
  ['null', null], ['string', 'a diagnostic'], ['number', 42], ['bool', false],
  ['array', [1, 'é😀', null]],
  ['allowlist', { function: 'some function()', step: '😀é', status: 503, code: 'E_TEST', errorCode: 'error', operation: 'op', provider: 'provider', attempt: 3, durationMs: 1.25, token: 'fixture-secret', message: 'not metadata', error: 'private' }],
  ['metadata-wrong-types', { function: ['array'], operation: { nested: true }, step: null, status: false, code: 42 }],
  ['metadata-truncation', { function: 'f'.repeat(120), step: '😀'.repeat(70), operation: 'long operation' }],
]) add(`payload-${name}`, 'warn', data);
for (const [name, value] of [
  ['false', false], ['zero', 0], ['empty', ''], ['empty-array', []],
  ['nested-array', ['nested', [null, true, 'é😀']]], ['object', { nested: true }],
  ['small-exponent', 1e-7], ['fixed-small', 1e-6], ['large-fixed', 1e20],
  ['large-exponent', 1e21], ['negative-exponent', -1e-7],
]) add(`metadata-name-${name}`, 'error', { function: value, operation: 'fallback operation' });
for (const item of cases) item.expected = await run(item.input);
const artifact = {
  version: 1,
  sources: Object.fromEntries(Object.entries(source).map(([path, code]) => [path, createHash('sha256').update(code).digest('hex')])),
  cases,
  intentionalDifferences: [
    'One SET EX replaces two cache commands while retaining key prefix, entry and TTL.',
    'Random suffix uses a stronger identifier; exact suffix bytes are not a compatibility contract.',
    'Independent bounded sinks and explicit per-sink results replace cache-first ordering and accidental sink exception propagation.',
    'Filtering is opt-in; compatibility fixtures use all levels and no sampling.',
    'The Rust OTEL adapter normalizes destination/platform attributes and represents JSON null as the string null because native AnyValue has no null variant; core JSON retains null.',
  ],
  sourceOnlyBoundaries: ['JavaScript undefined, functions, cyclic references, BigInt and lone UTF-16 surrogates are outside serde_json::Value.'],
};
const path = fileURLToPath(new URL('logger_parity.json', import.meta.url));
const rendered = JSON.stringify(artifact, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), rendered, 'regenerate logger source fixture');
else writeFileSync(path, rendered);
console.log(`Logger source oracle: ${cases.length} cases; all sinks mocked; ${process.argv.includes('--check') ? 'fixture matches' : 'fixture written'}.`);
