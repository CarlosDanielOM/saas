'use strict';
// Source oracle for the TTS usage tracker port.
//
// The script evaluates every non-import declaration of the actual
// `src/utils/tts_usage.ts` file. Only the four import boundaries are stubbed:
// the Dragonfly client, `ingestPolarSHEvent`, the logger's `error`, and the
// `AiUsageResourceType` type alias. Each stub records the arguments it receives
// and returns an explicit fixture reply; no Redis, pricing policy, retry logic,
// or TypeScript control flow is reconstructed here. The clock is a fixed Date
// so the source's own local-time expiry formula runs unmodified.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourcePath = path.join(root, 'src/utils/tts_usage.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const pins = {
  source: 'a92eb3d6135d1ba1564112fbb720ac1ac0b9279c7dc465d1677e3281fc08dae7',
  dragonflyBootstrap: '0d08dd4cdb931633473227fb59f043251b7be59a09a034ef6f392e0f64aebe9c',
  polarsh: '5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6'
};
const hashes = {
  source: sha(source),
  dragonflyBootstrap: sha(fs.readFileSync(path.join(root, 'src/utils/databases/dragonfly.database.ts'))),
  polarsh: sha(fs.readFileSync(path.join(root, 'src/utils/polarsh.ts'))),
  package: sha(fs.readFileSync(path.join(root, 'package.json'))),
  lock: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  typescript: sha(fs.readFileSync(require.resolve('typescript'))),
  typescriptPackage: sha(fs.readFileSync(require.resolve('typescript/package.json'))),
  node: sha(fs.readFileSync(process.execPath)),
  oracle: sha(fs.readFileSync(__filename))
};
const nativeFiles = [
  'src/utils/tts_usage.rs',
  'tests/tts_usage_tracking.rs',
  'tests/fixtures/tts_usage_tracking_reference.cjs'
];
const nativeHashes = Object.fromEntries(
  nativeFiles.map(file => [file, sha(fs.readFileSync(path.join(root, file)))])
);
for (const [name, pin] of Object.entries(pins)) assert.equal(hashes[name], pin, name);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');

const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
const imports = ast.statements.filter(ts.isImportDeclaration).map(statement => ({
  module: statement.moduleSpecifier.text,
  typeOnly: Boolean(statement.importClause?.isTypeOnly),
  names: statement.importClause?.namedBindings?.elements.map(element => element.name.text) ?? []
}));
assert.deepEqual(imports, [
  {module: './databases/dragonfly.database.js', typeOnly: false, names: ['getDragonflyClient']},
  {module: './polarsh.js', typeOnly: false, names: ['ingestPolarSHEvent']},
  {module: './logger.js', typeOnly: false, names: ['error']},
  {module: './ai_usage_event.js', typeOnly: true, names: ['AiUsageResourceType']}
]);
const exported = ast.statements
  .filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
  .map(statement => `${ts.SyntaxKind[statement.kind]}:${statement.name?.text ?? ''}`);
assert.deepEqual(exported, [
  'InterfaceDeclaration:TtsUsageTrackOptions',
  'InterfaceDeclaration:TtsUsageResult',
  'FunctionDeclaration:calculateTtsUsage',
  'FunctionDeclaration:trackTtsUsage'
]);
const body = ast.statements.filter(statement => !ts.isImportDeclaration(statement));
const extraction = body.map(statement => statement.getText(ast)).join('\n') + '\n';
for (const name of [
  'TTS_CREDITS_PER_CHARACTER',
  'generateTimeLeftToNextMonthInSeconds',
  'calculateTtsUsage',
  'trackTtsUsage'
]) {
  assert(extraction.includes(name), `extraction must contain ${name}`);
}
const tracking = body.find(statement => statement.name?.text === 'trackTtsUsage');
assert(ts.isFunctionDeclaration(tracking) && tracking.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));

// Signature stubs only; the source declarations above are never rewritten.
const stubs = `
type AiUsageResourceType = string;
interface FixtureCache {
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}
declare function getDragonflyClient(caller: string): Promise<FixtureCache>;
declare function ingestPolarSHEvent(options: any): Promise<{error: boolean, message?: string}>;
declare function error(payload: any, options: any): Promise<void>;
`;
const virtualFile = path.join(root, '__tts_usage_tracking_oracle__.ts');
const typecheckSource = stubs + extraction;
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ['lib.es2022.d.ts']
};
const host = ts.createCompilerHost(options);
const oldRead = host.readFile.bind(host);
const oldExists = host.fileExists.bind(host);
host.readFile = file => (file === virtualFile ? typecheckSource : oldRead(file));
host.fileExists = file => file === virtualFile || oldExists(file);
const program = ts.createProgram([virtualFile], options, host);
assert.deepEqual(
  ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  []
);
const checker = program.getTypeChecker();
const checkedProgramFile = program.getSourceFile(virtualFile);
const signatureOf = name => {
  const declaration = checkedProgramFile.statements.find(statement => statement.name?.text === name);
  return checker.signatureToString(
    checker.getSignatureFromDeclaration(declaration),
    undefined,
    ts.TypeFormatFlags.NoTruncation
  );
};
assert.equal(
  signatureOf('calculateTtsUsage'),
  '(provider: string, characters: number): TtsUsageResult'
);
assert.equal(signatureOf('trackTtsUsage'), '(options: TtsUsageTrackOptions): Promise<TtsUsageResult>');
const transpiled = ts.transpileModule(extraction, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  reportDiagnostics: true
});
assert.deepEqual(transpiled.diagnostics, []);

function bits(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer.toString('hex');
}
function encode(value) {
  if (value === undefined) return {u: 1};
  if (value === null) return {nul: 1};
  if (typeof value === 'number') return {f: bits(value)};
  if (typeof value === 'string') {
    return {s: Array.from({length: value.length}, (_, index) => value.charCodeAt(index))};
  }
  if (typeof value === 'boolean') return {b: value};
  if (Array.isArray(value)) return {a: value.map(encode)};
  if (typeof value === 'object') {
    // Undefined members are absent, exactly as the native Option mapping treats
    // them; declared-but-undefined keys are therefore not recorded.
    return {
      o: Object.keys(value)
        .filter(key => value[key] !== undefined)
        .map(key => [key, encode(value[key])])
    };
  }
  throw new Error(`unsupported fixture value: ${typeof value}`);
}

const cases = [];
async function scenario(id, config) {
  let step = 0;
  const cacheCalls = [];
  const logs = [];
  let billing = null;
  let billingCalls = 0;
  const cache = {
    async hIncrBy(key, field, increment) {
      step += 1;
      cacheCalls.push(['hincrby', key, field, String(increment)]);
      if (config.failStep === step) throw new Error('fixture cache failure');
      return 1;
    },
    async expire(key, seconds) {
      step += 1;
      cacheCalls.push(['expire', key, String(seconds)]);
      if (config.failStep === step) throw new Error('fixture cache failure');
      return 1;
    }
  };
  class FixtureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [config.now]));
    }
    static now() {
      return config.now;
    }
  }
  const context = vm.createContext({
    module: {exports: {}},
    Error,
    Date: FixtureDate,
    Object,
    Math,
    Array,
    String,
    Number,
    JSON,
    Promise,
    getDragonflyClient: async caller => {
      cacheCalls.push(['acquire', caller]);
      if (config.acquireError) throw new Error('fixture acquisition failure');
      return cache;
    },
    ingestPolarSHEvent: async ingestOptions => {
      billingCalls += 1;
      billing = encode(ingestOptions);
      if (config.ingestThrows) throw new Error('fixture ingest throw');
      return config.ingestError
        ? {error: true, message: 'fixture ingestion error'}
        : {error: false};
    },
    error: async (payload, logOptions) => {
      logs.push(encode([payload, logOptions]));
    }
  });
  context.exports = context.module.exports;
  vm.runInContext(transpiled.outputText, context, {filename: 'actual-tts-usage.cjs'});
  const input = {
    channelID: config.channel,
    streamer: config.streamer,
    provider: config.provider,
    characters: config.characters,
    text: config.text,
    requireDurableUsage: config.requireDurableUsage,
    usage: config.usage
  };
  let result = null;
  let thrown = null;
  try {
    result = encode(await context.module.exports.trackTtsUsage(input));
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  cases.push({
    id,
    input: encode(input),
    text: config.text,
    clock: {nowMillis: config.now, local: new Date(config.now).toString()},
    cache: {calls: cacheCalls, failedStep: config.failStep ?? null},
    billing: {
      calls: billingCalls,
      failed: config.ingestError === true || config.ingestThrows === true,
      options: billing
    },
    logs,
    result: thrown === null ? {usage: result} : {thrown}
  });
}

const at = iso => Date.parse(iso);
const customer = name => ({polar_sh_customer_id: name});
const fullUsage = suffix => ({
  entryId: `entry-${suffix}`,
  requestId: `request-${suffix}`,
  source: 'tts',
  resourceType: 'tts_generation',
  resourceId: `resource-${suffix}`
});
const text = 'fixture spoken text that the tracker must never read';

async function generate() {
  await scenario('piper-customer', {
    channel: 'tts-usage-fixture-piper',
    streamer: customer('fixture-customer-piper'),
    provider: 'piper',
    characters: 100,
    text,
    requireDurableUsage: false,
    usage: fullUsage('piper'),
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('kokoro-customer', {
    channel: 'tts-usage-fixture-kokoro',
    streamer: customer('fixture-customer-kokoro'),
    provider: 'kokoro',
    characters: 40,
    text,
    requireDurableUsage: false,
    usage: fullUsage('kokoro'),
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('fish-customer', {
    channel: 'tts-usage-fixture-fish',
    streamer: customer('fixture-customer-fish'),
    provider: 'fish',
    characters: 7,
    text,
    requireDurableUsage: false,
    usage: fullUsage('fish'),
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-no-customer', {
    channel: 'tts-usage-fixture-no-customer',
    streamer: {},
    provider: 'piper',
    characters: 100,
    text,
    requireDurableUsage: false,
    usage: fullUsage('no-customer'),
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('fish-zero-characters', {
    channel: 'tts-usage-fixture-zero',
    streamer: customer('fixture-customer-zero'),
    provider: 'fish',
    characters: 0,
    text,
    requireDurableUsage: false,
    usage: fullUsage('zero'),
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-day-30', {
    channel: 'tts-usage-fixture-day30',
    streamer: customer('fixture-customer-day30'),
    provider: 'piper',
    characters: 50,
    text,
    requireDurableUsage: false,
    usage: fullUsage('day30'),
    now: at('2026-10-30T12:00:00.000Z')
  });
  await scenario('kokoro-day-31', {
    channel: 'tts-usage-fixture-day31',
    streamer: customer('fixture-customer-day31'),
    provider: 'kokoro',
    characters: 15,
    text,
    requireDurableUsage: false,
    usage: fullUsage('day31'),
    now: at('2026-10-31T00:00:00.000Z')
  });
  await scenario('piper-generated-entry-id', {
    channel: 'tts-usage-fixture-generated',
    streamer: customer('fixture-customer-generated'),
    provider: 'piper',
    characters: 60,
    text,
    requireDurableUsage: false,
    usage: {source: 'tts'},
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('kokoro-no-usage-context', {
    channel: 'tts-usage-fixture-no-usage',
    streamer: customer('fixture-customer-no-usage'),
    provider: 'kokoro',
    characters: 20,
    text,
    requireDurableUsage: false,
    usage: undefined,
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-durable-error', {
    channel: 'tts-usage-fixture-durable',
    streamer: customer('fixture-customer-durable'),
    provider: 'piper',
    characters: 100,
    text,
    requireDurableUsage: true,
    usage: fullUsage('durable'),
    ingestError: true,
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-best-effort-error', {
    channel: 'tts-usage-fixture-best-effort',
    streamer: customer('fixture-customer-best-effort'),
    provider: 'piper',
    characters: 100,
    text,
    requireDurableUsage: false,
    usage: fullUsage('best-effort'),
    ingestError: true,
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-expire-failure', {
    channel: 'tts-usage-fixture-expire',
    streamer: customer('fixture-customer-expire'),
    provider: 'piper',
    characters: 100,
    text,
    requireDurableUsage: false,
    usage: fullUsage('expire'),
    failStep: 4,
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-fractional-characters', {
    channel: 'tts-usage-fixture-fractional',
    streamer: customer('fixture-customer-fractional'),
    provider: 'piper',
    characters: 10.5,
    text,
    requireDurableUsage: false,
    usage: fullUsage('fractional'),
    failStep: 1,
    now: at('2026-10-15T06:30:45.000Z')
  });
  await scenario('piper-astral-channel', {
    channel: 'tts-usage-fixture-\u{1f600}',
    streamer: customer('fixture-customer-astral'),
    provider: 'piper',
    characters: 50,
    text,
    requireDurableUsage: false,
    usage: fullUsage('astral'),
    now: at('2026-10-15T06:30:45.000Z')
  });

  const counts = {};
  for (const row of cases) counts[row.cache.failedStep ? 'cache-failure' : 'success'] =
    (counts[row.cache.failedStep ? 'cache-failure' : 'success'] || 0) + 1;
  assert.equal(cases.length, 14);
  return {
    metadata: {
      schema: 1,
      node: process.version,
      v8: process.versions.v8,
      typescript: ts.version,
      timezone: process.env.TZ,
      pins,
      hashes,
      nativeHashes,
      extractionSha256: sha(extraction),
      typecheckSha256: sha(typecheckSource),
      compiledSha256: sha(transpiled.outputText),
      imports,
      exports: [
        {name: 'calculateTtsUsage', signature: signatureOf('calculateTtsUsage')},
        {name: 'trackTtsUsage', signature: signatureOf('trackTtsUsage')}
      ],
      counts,
      total: cases.length,
      generatedEntryId: 'real node:crypto.randomUUID inside the actual source context; normalized by the Rust replay',
      dependencyProvenance: [
        {
          source: 'getDragonflyClient("Messages")',
          native: 'utils::redis::get_redis_client',
          kind: 'existing concrete redis-rs ConnectionManager bootstrap'
        },
        {
          source: 'cacheClient.hIncrBy/expire',
          native: 'redis::cmd("HINCRBY"/"EXPIRE") on the shared ConnectionManager',
          kind: 'concrete cache protocol; JavaScript number text preserved'
        },
        {
          source: 'ingestPolarSHEvent({mode:"batch"})',
          native: 'utils::polar_usage::PolarUsage::ingest',
          kind: 'concrete batch adapter: durable queue, projection, receipt, then Polar HTTP flush'
        },
        {
          source: 'error({...},{channelId,destination:"both"})',
          native: 'utils::logger::Logger with console and redis cache sinks',
          kind: 'existing concrete logger'
        },
        {
          source: 'new Date() local components',
          native: 'libc::localtime_r plus logger::Clock',
          kind: 'native local-wall-clock reader'
        }
      ]
    },
    cases
  };
}

(async () => {
  const [mode, dir, ...extra] = process.argv.slice(2);
  assert(['--write', '--check'].includes(mode) && dir && extra.length === 0, 'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(), 'parent creates the owned oracle output directory');
  const result = await generate();
  const files = [
    ['tts_usage_tracking_reference.json', JSON.stringify(result, null, 2) + '\n'],
    ['tts_usage_tracking_extracted.ts', extraction],
    ['tts_usage_tracking_typecheck.ts', typecheckSource],
    ['tts_usage_tracking_compiled.cjs', transpiled.outputText]
  ];
  for (const [name, body] of files) {
    const output = path.join(fs.realpathSync(dir), name);
    if (mode === '--write') {
      assert(!fs.existsSync(output), `refuse overwrite ${name}`);
      fs.writeFileSync(output, body, {flag: 'wx'});
    } else {
      const actual = fs.readFileSync(output, 'utf8');
      assert(actual.length > 0, `empty ${name}`);
      assert.equal(actual, body, `source/oracle drift ${name}`);
    }
  }
  process.stdout.write(`${mode} ${result.cases.length} source cases\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
