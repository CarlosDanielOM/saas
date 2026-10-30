'use strict';
// Prepared-operation benchmark for the pure `src/utils/ai/constants.ts` selectors.
// DEFERRED DRAFT: the actual TypeScript source runs in a VM realm. Switch timed
// calls to a normal CommonJS realm before accepting phase-two comparisons.
// Inputs, decoded arguments, and golden wires are prepared outside timing; inputs, decoded arguments, and golden wires are prepared
// outside the timed region. No application startup, provider call, network,
// database, or external timer is involved.
// Public modes are exactly:
//   --write DIR  write inputs.json + node-report.json into an empty external DIR
//   --check DIR  validate inputs.json and both reports without rerunning timing
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const root = fs.realpathSync(process.env.DIMA_AI_CONSTANTS_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const repoRoot = path.dirname(root);
const sourcePath = path.join(root, 'src/utils/ai/constants.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

const SCOPE = 'prepared pure constant selector and provider lookups; scalar output-length checksum';
const UNIT = 'nanoseconds per full trial';
const WARMUP_PASSES = 20;
const TRIALS = 7;
const CASE_COUNT = 32;
const OPERATIONS = 32 * 1024;
const WORKLOADS = ['select-chat-model', 'select-chat-model-exhausted', 'background-model', 'provider-restriction'];

const pins = {
  source: '7505c5481b8681c83ec57c8b89b856250bdd3970586810e900075d06fb5eb0f4',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  toolchain: 'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  node: '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108',
};
const hashes = {
  source: sha(source),
  package: sha(fs.readFileSync(path.join(root, 'package.json'))),
  lock: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  toolchain: sha(fs.readFileSync(path.join(root, 'rust-toolchain.toml'))),
  typescript: sha(fs.readFileSync(require.resolve('typescript'))),
  typescriptPackage: sha(fs.readFileSync(require.resolve('typescript/package.json'))),
  node: sha(fs.readFileSync(process.execPath)),
  oracle: sha(fs.readFileSync(__filename)),
};
for (const [key, pin] of Object.entries(pins)) assert.equal(hashes[key], pin, key);
assert.deepEqual(
  [process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode],
  ['24.22.1', '13.6.233.17-node.58', '78.3', '17.0'],
);
assert.equal(ts.version, '5.9.3');

const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
assert.equal(ast.statements.length, 16, 'complete source statement count');
assert.deepEqual(ast.statements.filter(ts.isImportDeclaration), [], 'import-free source');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics, []);
const context = { exports: {} };
vm.runInNewContext(compiled.outputText, context, { filename: 'ai_constants_benchmark_source.cjs', timeout: 10000 });
const api = context.exports;
assert.equal(typeof api.selectChatModel, 'function');
assert.equal(typeof api.getBackgroundSummaryModel, 'function');
assert.equal(typeof api.getProviderRestriction, 'function');

const unitList = value => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
const fromUnits = units => String.fromCharCode(...units);
const str = value => ({ kind: 'string', units: unitList(value) });

function streamerFor(input) {
  switch (input.kind) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'missing':
      return {};
    case 'string':
    case 'units':
      return { plan_tier: fromUnits(input.units) };
    case 'planNull':
      return { plan_tier: null };
    case 'planNumber':
      return { plan_tier: 0 };
    case 'planObject':
      return { plan_tier: {} };
    default:
      throw Error(`unknown plan input ${input.kind}`);
  }
}

const planCycle = [
  str('free'),
  str('premium'),
  str('pro'),
  str('PRO'),
  str('Premium'),
  { kind: 'missing' },
  { kind: 'undefined' },
  { kind: 'null' },
  str(''),
  str('pro '),
  str('𝔭𝔯𝔬'),
  { kind: 'planNumber' },
];
const backgroundCycle = [
  str('free'),
  str('premium'),
  str('pro'),
  str('Free'),
  str('PRO'),
  str(''),
  str('premium '),
  str('enterprise'),
  str('𝔭𝔯𝔬'),
  { kind: 'units', units: [0xd800] },
  { kind: 'units', units: [0xd83d, 0xde00] },
  { kind: 'units', units: [0xdc00] },
];
const providerCycle = [
  str('deepseek/deepseek-v4-pro'),
  str('deepseek/deepseek-v4.1-flash'),
  str('google/gemini-2.5-flash-lite'),
  str(''),
  str('DEEPSEEK/DEEPSEEK-V4-PRO'),
  str('deepseek/deepseek-v4-pro '),
  str('𝔡𝔢𝔢𝔭𝔰𝔢𝔢𝔨'),
  str('z-ai/glm-4.5-air'),
];

function inputFor(name, index) {
  const cycle =
    name === 'background-model' ? backgroundCycle : name === 'provider-restriction' ? providerCycle : planCycle;
  return cycle[(index * 7 + 3) % cycle.length];
}
function wireOf(name, value) {
  if (name === 'provider-restriction') return value === undefined ? 'undefined' : `only=${value.only.join(',')}`;
  return value;
}
function scalarOf(name, value) {
  if (name === 'provider-restriction') {
    return value === undefined ? 0 : value.only.reduce((total, provider) => total + provider.length, 0) + 1;
  }
  return value.length;
}
function evaluate(name, argument) {
  if (name === 'provider-restriction') return api.getProviderRestriction(argument);
  if (name === 'background-model') return api.getBackgroundSummaryModel(argument);
  return api.selectChatModel(argument, name === 'select-chat-model-exhausted');
}
function argumentFor(name, input) {
  if (name === 'background-model' || name === 'provider-restriction') return fromUnits(input.units);
  return streamerFor(input);
}

const pools = WORKLOADS.map(name => {
  const records = Array.from({ length: CASE_COUNT }, (_, index) => {
    const input = inputFor(name, index);
    const value = evaluate(name, argumentFor(name, input));
    return {
      id: `${name}-${index}`,
      input,
      wire: wireOf(name, value),
      scalar: scalarOf(name, value),
    };
  });
  return { name, caseCount: CASE_COUNT, operations: OPERATIONS, warmupPasses: WARMUP_PASSES, records };
});

function preflight(pool) {
  for (const record of pool.records) {
    const value = evaluate(pool.name, argumentFor(pool.name, record.input));
    assert.equal(wireOf(pool.name, value), record.wire, `${record.id} wire`);
    assert.equal(scalarOf(pool.name, value), record.scalar, `${record.id} scalar`);
  }
}

const nativeFiles = [
  'src/utils/ai/constants.ts',
  'src/utils/ai/constants.rs',
  'tests/ai_constants.rs',
  'tests/fixtures/ai_constants_reference.cjs',
  'tests/fixtures/ai_constants_benchmark.cjs',
  'tests/ai_constants_benchmark.rs',
  'tests/support/sha256.rs',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'package.json',
  'package-lock.json',
];
const nativeHashes = Object.fromEntries(
  nativeFiles.map(file => [file, sha(fs.readFileSync(path.resolve(root, file)))]),
);

const runtime = {
  node: process.version,
  v8: process.versions.v8,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  typescript: ts.version,
};
const metadata = {
  format: 1,
  scope: SCOPE,
  sampleUnit: UNIT,
  warmupPasses: WARMUP_PASSES,
  trials: TRIALS,
  caseCount: CASE_COUNT,
  operations: OPERATIONS,
  workloadOrder: WORKLOADS,
  runtime,
  pins,
  nativeHashes,
  source: 'src/utils/ai/constants.ts',
  compiledSha256: sha(compiled.outputText),
};
const inputs = { metadata, pools };
const inputBytes = Buffer.from(JSON.stringify(inputs, null, 2) + '\n', 'utf8');
const inputSha = sha(inputBytes);

function expectedChecksum(pool, operations) {
  let sum = 0;
  for (let index = 0; index < operations; index++) sum = (sum + pool.records[index % pool.records.length].scalar) >>> 0;
  return sum;
}

function timed(name, prepared, operations) {
  let sum = 0;
  const length = prepared.length;
  for (let index = 0; index < operations; index++) {
    const value = evaluate(name, prepared[index % length]);
    sum = (sum + scalarOf(name, value)) >>> 0;
  }
  return sum;
}

function validateReport(report, language, poolsToCheck, expectedInputSha) {
  assert.equal(report.format, 1);
  assert.equal(report.language, language);
  assert.equal(report.scope, SCOPE);
  assert.equal(report.sampleUnit, UNIT);
  assert.equal(report.fixtureSha256, expectedInputSha);
  if (language === 'node') assert.deepEqual(report.runtime, runtime);
  else {
    assert.equal(report.runtime.toolchain, '1.99.1');
    assert.match(report.runtime.rustc, /^rustc 1\.99\.1 /);
    assert.equal(report.runtime.profile, 'release');
    assert(report.runtime.arch && report.runtime.os);
  }

  assert.equal(report.pools.length, poolsToCheck.length);
  for (let index = 0; index < poolsToCheck.length; index++) {
    const pool = poolsToCheck[index];
    const result = report.pools[index];
    assert.equal(result.name, pool.name);
    assert.equal(result.caseCount, CASE_COUNT);
    assert.equal(result.operations, pool.operations);
    assert.equal(result.warmupPasses, WARMUP_PASSES);
    assert.equal(result.checksum, expectedChecksum(pool, pool.operations));
    assert.equal(result.trials.length, TRIALS);
    for (const trial of result.trials) {
      assert.equal(trial.checksum, result.checksum);
      assert(Number.isSafeInteger(trial.ns) && trial.ns > 0, 'positive integer sample');
    }
    const sorted = result.trials.map(trial => trial.ns).sort((a, b) => a - b);
    assert.deepEqual([result.min, result.median, result.max], [sorted[0], sorted[3], sorted[6]]);
  }
}

const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dirArg && path.isAbsolute(dirArg) && !extra.length, 'usage: --write DIR | --check DIR');
const dir = fs.realpathSync(dirArg);
assert.equal(dir, path.resolve(dirArg), 'canonical directory required');
assert.equal(fs.statSync(dir).isDirectory(), true);
const workspace = fs.realpathSync(repoRoot);
assert(dir !== workspace && !dir.startsWith(workspace + path.sep), 'directory must be external');

const inputFile = path.join(dir, 'inputs.json');
const nodeFile = path.join(dir, 'node-report.json');
const nativeFile = path.join(dir, 'native-report.json');
function readBytes(file) {
  assert.equal(fs.statSync(file).isFile(), true, `missing file: ${path.basename(file)}`);
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0, `empty file: ${path.basename(file)}`);
  return bytes;
}

if (mode === '--write') {
  assert.deepEqual(fs.readdirSync(dir), [], 'write requires an empty directory');
  // Full golden preflight before any timing: replay every pool record exactly.
  for (const pool of pools) preflight(pool);
  // Prepare decoded arguments once, outside every timed region.
  const prepared = pools.map(pool => pool.records.map(record => argumentFor(pool.name, record.input)));
  fs.writeFileSync(inputFile, inputBytes, { flag: 'wx' });

  const workloads = pools.map((pool, poolIndex) => {
    const warmupOperations = WARMUP_PASSES * CASE_COUNT;
    assert.equal(timed(pool.name, prepared[poolIndex], warmupOperations), expectedChecksum(pool, warmupOperations));
    const checksum = expectedChecksum(pool, pool.operations);
    const trials = Array.from({ length: TRIALS }, () => {
      const start = process.hrtime.bigint();
      const value = timed(pool.name, prepared[poolIndex], pool.operations);
      const ns = Number(process.hrtime.bigint() - start);
      return { ns, checksum: value };
    });
    for (const trial of trials) assert.equal(trial.checksum, checksum);
    const sorted = trials.map(trial => trial.ns).sort((a, b) => a - b);
    return {
      name: pool.name,
      caseCount: CASE_COUNT,
      operations: pool.operations,
      warmupPasses: WARMUP_PASSES,
      checksum,
      trials,
      min: sorted[0],
      median: sorted[3],
      max: sorted[6],
    };
  });
  const report = {
    format: 1,
    language: 'node',
    runtime,
    scope: SCOPE,
    sampleUnit: UNIT,
    fixtureSha256: inputSha,
    pools: workloads,
  };
  validateReport(report, 'node', pools, inputSha);
  const reportBytes = Buffer.from(JSON.stringify(report) + '\n', 'utf8');
  fs.writeFileSync(nodeFile, reportBytes, { flag: 'wx' });
  console.log(JSON.stringify({ mode, inputSha256: inputSha, nodeReportSha256: sha(reportBytes) }));
} else {
  assert.deepEqual(fs.readdirSync(dir).sort(), ['inputs.json', 'native-report.json', 'node-report.json'], 'exact fixture directory');
  const stored = readBytes(inputFile);
  const storedSha = sha(stored);
  if (process.env.DIMA_AI_CONSTANTS_BENCH_INPUT_SHA256) {
    assert.equal(storedSha, process.env.DIMA_AI_CONSTANTS_BENCH_INPUT_SHA256, 'independent input SHA');
  }
  const storedInputs = JSON.parse(stored.toString('utf8'));
  assert.deepEqual(storedInputs.metadata, metadata, 'input metadata drift');
  assert.deepEqual(
    storedInputs.pools.map(pool => pool.name),
    WORKLOADS,
    'workload order',
  );
  assert.equal(storedInputs.pools.length, pools.length);
  for (let index = 0; index < pools.length; index++) {
    assert.deepEqual(storedInputs.pools[index], pools[index], `${pools[index].name} records`);
  }
  for (const pool of pools) preflight(pool);

  const nodeReport = JSON.parse(readBytes(nodeFile).toString('utf8'));
  const nativeReport = JSON.parse(readBytes(nativeFile).toString('utf8'));
  validateReport(nodeReport, 'node', pools, storedSha);
  validateReport(nativeReport, 'rust', pools, storedSha);
  console.log(
    JSON.stringify({
      mode,
      inputSha256: storedSha,
      nodeReportSha256: sha(readBytes(nodeFile)),
      nativeReportSha256: sha(readBytes(nativeFile)),
    }),
  );
}
