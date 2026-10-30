'use strict';
// Execute the complete, unmodified TypeScript source for `src/utils/ai/constants.ts`.
// No application startup, provider call, network, database, or timer is used.
// Public modes are exactly --write DIR (exclusive, empty directory) and
// --check DIR (byte-exact, non-empty).
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

const expectedExports = [
  'MODELS',
  'selectChatModel',
  'BACKGROUND_MODELS',
  'getBackgroundSummaryModel',
  'BACKGROUND_MODEL_FALLBACK',
  'MODEL_PROVIDER_RESTRICTIONS',
  'getProviderRestriction',
  'TOKEN_LIMITS',
  'CODING_MODELS',
  'MINIMAX_MODEL',
  'MINIMAX_BASE_URL',
  'MINIMAX_COST_PER_M_INPUT',
  'MINIMAX_COST_PER_M_OUTPUT',
  'DEFAULT_TIMEOUT_MS',
  'EMBEDDING_MODELS',
  'EMBEDDING_DIMENSIONS',
];

const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
const nameOf = statement =>
  ts.isFunctionDeclaration(statement)
    ? statement.name.text
    : statement.declarationList.declarations[0].name.text;
assert.equal(ast.statements.length, expectedExports.length, 'top-level statement count');
assert.deepEqual(ast.statements.map(nameOf), expectedExports, 'declaration order');
for (const statement of ast.statements) {
  assert(
    statement.modifiers && statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    `exported: ${nameOf(statement)}`,
  );
}
// Direct and transitive dependency audit: the source must remain import-free.
(function audit(node) {
  if (
    ts.isImportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    node.kind === ts.SyntaxKind.ImportKeyword
  ) {
    throw Error('unexpected dependency import');
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') {
    throw Error('unexpected dependency require');
  }
  ts.forEachChild(node, audit);
})(ast);

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ['lib.es2022.d.ts'],
};
const program = ts.createProgram([sourcePath], options);
assert.deepEqual(
  ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  [],
  'typecheck diagnostics',
);
const checker = program.getTypeChecker();
const typedAst = program.getSourceFile(sourcePath);
const declarationOf = name => {
  const found = typedAst.statements.filter(statement => nameOf(statement) === name);
  assert.equal(found.length, 1, name);
  return found[0];
};
const signatureOf = name => {
  const node = declarationOf(name);
  assert(ts.isFunctionDeclaration(node), name);
  const signature = checker.getSignatureFromDeclaration(node);
  assert(signature, `signature: ${name}`);
  return checker.signatureToString(signature, undefined, ts.TypeFormatFlags.NoTruncation);
};
const typeOf = name => {
  const node = declarationOf(name);
  const declaration = ts.isVariableStatement(node) ? node.declarationList.declarations[0] : node;
  return checker.typeToString(checker.getTypeAtLocation(declaration.name), undefined, ts.TypeFormatFlags.NoTruncation);
};

const signatures = {
  selectChatModel: signatureOf('selectChatModel'),
  getBackgroundSummaryModel: signatureOf('getBackgroundSummaryModel'),
  getProviderRestriction: signatureOf('getProviderRestriction'),
};
assert.match(signatures.selectChatModel, /plan_tier\?: string/);
assert.match(signatures.selectChatModel, /null \| undefined/);
assert.match(signatures.selectChatModel, /isExhausted\?: boolean/);
assert.match(signatures.selectChatModel, /: string$/);
assert.match(signatures.getBackgroundSummaryModel, /planTier: string \| undefined/);
assert.match(signatures.getBackgroundSummaryModel, /: string$/);
assert.match(signatures.getProviderRestriction, /model: string/);
assert.match(signatures.getProviderRestriction, /readonly string\[\]/);
assert.match(signatures.getProviderRestriction, /undefined/);

const declaredTypes = {
  MODELS: typeOf('MODELS'),
  selectChatModel: signatures.selectChatModel,
  BACKGROUND_MODELS: typeOf('BACKGROUND_MODELS'),
  getBackgroundSummaryModel: signatures.getBackgroundSummaryModel,
  BACKGROUND_MODEL_FALLBACK: typeOf('BACKGROUND_MODEL_FALLBACK'),
  MODEL_PROVIDER_RESTRICTIONS: typeOf('MODEL_PROVIDER_RESTRICTIONS'),
  getProviderRestriction: signatures.getProviderRestriction,
  TOKEN_LIMITS: typeOf('TOKEN_LIMITS'),
  CODING_MODELS: typeOf('CODING_MODELS'),
  MINIMAX_MODEL: typeOf('MINIMAX_MODEL'),
  MINIMAX_BASE_URL: typeOf('MINIMAX_BASE_URL'),
  MINIMAX_COST_PER_M_INPUT: typeOf('MINIMAX_COST_PER_M_INPUT'),
  MINIMAX_COST_PER_M_OUTPUT: typeOf('MINIMAX_COST_PER_M_OUTPUT'),
  DEFAULT_TIMEOUT_MS: typeOf('DEFAULT_TIMEOUT_MS'),
  EMBEDDING_MODELS: typeOf('EMBEDDING_MODELS'),
  EMBEDDING_DIMENSIONS: typeOf('EMBEDDING_DIMENSIONS'),
};
assert.match(declaredTypes.MODELS, /readonly free/);
assert.match(declaredTypes.MODELS, /exhausted/);
assert.match(declaredTypes.BACKGROUND_MODELS, /readonly free/);
assert.match(declaredTypes.CODING_MODELS, /readonly pro/);
assert.match(declaredTypes.MODEL_PROVIDER_RESTRICTIONS, /readonly string\[\]/);
assert.match(declaredTypes.TOKEN_LIMITS, /readonly default: 25000/);
assert.match(declaredTypes.MINIMAX_COST_PER_M_INPUT, /0\.6/);
assert.match(declaredTypes.MINIMAX_COST_PER_M_OUTPUT, /2\.4/);
assert.match(declaredTypes.DEFAULT_TIMEOUT_MS, /8000/);
assert.match(declaredTypes.EMBEDDING_DIMENSIONS, /Record<string, number>/);

const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics, []);
const context = { exports: {} };
vm.runInNewContext(compiled.outputText, context, { filename: 'ai_constants_source.cjs', timeout: 10000 });
const api = context.exports;
assert.deepEqual(Object.keys(api).sort(), [...expectedExports].sort(), 'runtime export surface');

const unitList = value => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
const fromUnits = units => String.fromCharCode(...units);
const str = value => ({ kind: 'string', units: unitList(value) });
const bits = number => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(number);
  return buffer.toString('hex');
};

const tables = {
  MODELS: { keys: Object.keys(api.MODELS), values: Object.values(api.MODELS) },
  BACKGROUND_MODELS: { keys: Object.keys(api.BACKGROUND_MODELS), values: Object.values(api.BACKGROUND_MODELS) },
  CODING_MODELS: { keys: Object.keys(api.CODING_MODELS), values: Object.values(api.CODING_MODELS) },
  TOKEN_LIMITS: {
    keys: Object.keys(api.TOKEN_LIMITS),
    values: Object.values(api.TOKEN_LIMITS),
    bits: Object.fromEntries(Object.entries(api.TOKEN_LIMITS).map(([key, value]) => [key, bits(value)])),
  },
  EMBEDDING_MODELS: { keys: Object.keys(api.EMBEDDING_MODELS), values: Object.values(api.EMBEDDING_MODELS) },
  EMBEDDING_DIMENSIONS: {
    keys: Object.keys(api.EMBEDDING_DIMENSIONS),
    values: Object.values(api.EMBEDDING_DIMENSIONS),
    bits: Object.fromEntries(Object.entries(api.EMBEDDING_DIMENSIONS).map(([key, value]) => [key, bits(value)])),
  },
  MODEL_PROVIDER_RESTRICTIONS: {
    keys: Object.keys(api.MODEL_PROVIDER_RESTRICTIONS),
    only: Object.fromEntries(
      Object.entries(api.MODEL_PROVIDER_RESTRICTIONS).map(([key, value]) => [key, Array.from(value.only)]),
    ),
  },
};

const tablesJson = JSON.stringify({
  MODELS: api.MODELS,
  BACKGROUND_MODELS: api.BACKGROUND_MODELS,
  BACKGROUND_MODEL_FALLBACK: api.BACKGROUND_MODEL_FALLBACK,
  MODEL_PROVIDER_RESTRICTIONS: api.MODEL_PROVIDER_RESTRICTIONS,
  TOKEN_LIMITS: api.TOKEN_LIMITS,
  CODING_MODELS: api.CODING_MODELS,
  MINIMAX_MODEL: api.MINIMAX_MODEL,
  MINIMAX_BASE_URL: api.MINIMAX_BASE_URL,
  MINIMAX_COST_PER_M_INPUT: api.MINIMAX_COST_PER_M_INPUT,
  MINIMAX_COST_PER_M_OUTPUT: api.MINIMAX_COST_PER_M_OUTPUT,
  DEFAULT_TIMEOUT_MS: api.DEFAULT_TIMEOUT_MS,
  EMBEDDING_MODELS: api.EMBEDDING_MODELS,
  EMBEDDING_DIMENSIONS: api.EMBEDDING_DIMENSIONS,
});

const scalars = {
  MINIMAX_MODEL: api.MINIMAX_MODEL,
  MINIMAX_BASE_URL: api.MINIMAX_BASE_URL,
  MINIMAX_COST_PER_M_INPUT: api.MINIMAX_COST_PER_M_INPUT,
  MINIMAX_COST_PER_M_INPUT_BITS: bits(api.MINIMAX_COST_PER_M_INPUT),
  MINIMAX_COST_PER_M_OUTPUT: api.MINIMAX_COST_PER_M_OUTPUT,
  MINIMAX_COST_PER_M_OUTPUT_BITS: bits(api.MINIMAX_COST_PER_M_OUTPUT),
  DEFAULT_TIMEOUT_MS: api.DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS_BITS: bits(api.DEFAULT_TIMEOUT_MS),
  BACKGROUND_MODEL_FALLBACK: api.BACKGROUND_MODEL_FALLBACK,
};

function streamerFor(input) {
  switch (input.kind) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'missing':
      return {};
    case 'string':
      return { plan_tier: fromUnits(input.units) };
    case 'units':
      return { plan_tier: fromUnits(input.units) };
    case 'planNull':
      return { plan_tier: null };
    case 'planNumber':
      return { plan_tier: 0 };
    case 'planBoolean':
      return { plan_tier: true };
    case 'planObject':
      return { plan_tier: {} };
    case 'planArray':
      return { plan_tier: ['pro'] };
    default:
      throw Error(`unknown plan input ${input.kind}`);
  }
}

const planInputs = [
  { kind: 'undefined' },
  { kind: 'null' },
  { kind: 'missing' },
  str('free'),
  str('premium'),
  str('pro'),
  str('exhausted'),
  str('Free'),
  str('PRO'),
  str('Premium'),
  str(''),
  str(' pro'),
  str('pro '),
  str('𝔭𝔯𝔬'),
  str('enterprise'),
  str('deepseek/deepseek-v4-pro'),
  { kind: 'units', units: [0xd800] },
  { kind: 'units', units: [0xdc00] },
  { kind: 'units', units: [0xd83d, 0xde00] },
  { kind: 'planNull' },
  { kind: 'planNumber' },
  { kind: 'planBoolean' },
  { kind: 'planObject' },
  { kind: 'planArray' },
];

const selectChatModel = [];
for (const input of planInputs) {
  for (const mode of ['default', 'false', 'true']) {
    const streamer = streamerFor(input);
    const expected =
      mode === 'default' ? api.selectChatModel(streamer) : api.selectChatModel(streamer, mode === 'true');
    selectChatModel.push({ input, mode, expected });
  }
}

const backgroundInputs = [
  { kind: 'undefined' },
  { kind: 'null' },
  str('free'),
  str('premium'),
  str('pro'),
  str('Free'),
  str('PRO'),
  str(''),
  str('pro '),
  str('premium '),
  str('enterprise'),
  str('𝔭𝔯𝔬'),
  { kind: 'units', units: [0xd800] },
  { kind: 'units', units: [0xd83d, 0xde00] },
];
const getBackgroundSummaryModel = backgroundInputs.map(input => {
  const expected =
    input.kind === 'undefined'
      ? api.getBackgroundSummaryModel()
      : input.kind === 'null'
        ? api.getBackgroundSummaryModel(null)
        : api.getBackgroundSummaryModel(fromUnits(input.units));
  return { input, expected };
});

const providerKeys = [
  ['own-entry', 'deepseek/deepseek-v4-pro'],
  ['chat-model', 'deepseek/deepseek-v4.1-flash'],
  ['exhausted-chat', 'meta/muse-spark-1.3-contributor'],
  ['background-free', 'meta/muse-spark-1.2-contributor'],
  ['coding-pro', 'google/gemini-2.5-flash-lite'],
  ['coding-free', 'z-ai/glm-4.5-air:nitro'],
  ['coding-exhausted', 'z-ai/glm-4.5-air'],
  ['minimax', 'MiniMax-M2.7-highspeed'],
  ['empty', ''],
  ['trailing-space', 'deepseek/deepseek-v4-pro '],
  ['leading-space', ' deepseek/deepseek-v4-pro'],
  ['uppercase', 'DEEPSEEK/DEEPSEEK-V4-PRO'],
  ['suffix-slash', 'deepseek/deepseek-v4-pro/'],
  ['unicode', '𝔡𝔢𝔢𝔭𝔰𝔢𝔢𝔨'],
  ['then', 'then'],
].map(([id, value]) => ({ id, input: str(value) }));
providerKeys.push({ id: 'lone-high', input: { kind: 'units', units: [0xd800] } });
providerKeys.push({ id: 'lone-low', input: { kind: 'units', units: [0xdc00] } });
for (const key of [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
  '__defineSetter__',
  '__lookupSetter__',
]) {
  providerKeys.push({ id: `prototype-${key.replace(/_/g, '-')}`, input: str(key) });
}

const providerTablePrototype = Object.getPrototypeOf(api.MODEL_PROVIDER_RESTRICTIONS);
const getProviderRestriction = providerKeys.map(({ id, input }) => {
  const model = fromUnits(input.units);
  const result = api.getProviderRestriction(model);
  const hasOwn = Object.hasOwn(api.MODEL_PROVIDER_RESTRICTIONS, model);
  let resultKind;
  if (result === undefined) resultKind = 'undefined';
  else if (result && Array.isArray(result.only)) resultKind = 'restriction';
  else if (typeof result === 'function') resultKind = 'function';
  else resultKind = 'object';
  return {
    id,
    input,
    hasOwn,
    resultKind,
    only: resultKind === 'restriction' ? Array.from(result.only) : null,
    functionName: resultKind === 'function' ? result.name : null,
    isObjectPrototype: result === providerTablePrototype,
  };
});

const boundaries = [
  {
    id: 'prototype-chain',
    detail:
      'MODEL_PROVIDER_RESTRICTIONS is a plain object literal; the source lookup returns inherited Object.prototype objects/functions for "__proto__", "constructor", "toString" and similar keys. The typed Rust boundary returns None for these because the inherited values do not satisfy the declared { only: readonly string[] } | undefined type.',
    evidence: 'getProviderRestriction records with hasOwn=false',
  },
  {
    id: 'runtime-mutability',
    detail:
      'as const and Readonly<Record<...>> are compile-time only; the runtime tables are mutable. No source path mutates them, and the native port exposes immutable statics.',
    evidence: `isFrozen=${JSON.stringify([
      Object.isFrozen(api.MODELS),
      Object.isFrozen(api.BACKGROUND_MODELS),
      Object.isFrozen(api.CODING_MODELS),
      Object.isFrozen(api.TOKEN_LIMITS),
      Object.isFrozen(api.MODEL_PROVIDER_RESTRICTIONS),
      Object.isFrozen(api.EMBEDDING_MODELS),
      Object.isFrozen(api.EMBEDDING_DIMENSIONS),
    ])}`,
  },
  {
    id: 'non-boolean-exhausted',
    detail:
      'isExhausted is declared boolean. JavaScript truthiness of non-boolean arguments is outside the declared typed contract and is not replayed by the native port.',
    evidence: 'selectChatModel signature',
  },
  {
    id: 'lone-surrogate-keys',
    detail:
      'Lone-surrogate strings cannot be Rust &str. They are replayed as UTF-16 code units; such a string can never equal an ASCII key, so it resolves exactly as the source lookup does.',
    evidence: 'lone-high/lone-low records',
  },
];

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

const metadata = {
  schema: 1,
  node: process.version,
  v8: process.versions.v8,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  typescript: ts.version,
  source: 'src/utils/ai/constants.ts',
  sourceSha256: pins.source,
  pins,
  hashes,
  nativeHashes,
  imports: ast.statements.filter(ts.isImportDeclaration).map(statement => statement.moduleSpecifier.text),
  statements: ast.statements.length,
  exports: expectedExports,
  exportTypes: Object.fromEntries(expectedExports.map(name => [name, typeof api[name]])),
  functionLengths: {
    selectChatModel: api.selectChatModel.length,
    getBackgroundSummaryModel: api.getBackgroundSummaryModel.length,
    getProviderRestriction: api.getProviderRestriction.length,
  },
  signatures,
  declaredTypes,
  total: selectChatModel.length + getBackgroundSummaryModel.length + getProviderRestriction.length,
};

const output =
  JSON.stringify(
    {
      metadata,
      tables,
      tablesJson,
      scalars,
      selectChatModel,
      getBackgroundSummaryModel,
      getProviderRestriction,
      boundaries,
    },
    null,
    2,
  ) + '\n';

const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dir && !extra.length, 'usage: --write DIR | --check DIR');
const real = fs.realpathSync(dir);
const workspace = fs.realpathSync(repoRoot);
assert(real !== workspace && !real.startsWith(workspace + path.sep), 'directory must be external');
const file = path.join(real, 'ai_constants_reference.json');
if (mode === '--write') {
  assert.equal(fs.readdirSync(real).length, 0, 'write requires an empty directory');
  fs.writeFileSync(file, output, { flag: 'wx' });
  console.log(JSON.stringify({ mode, file: path.basename(file), bytes: Buffer.byteLength(output) }));
} else {
  assert.deepEqual(fs.readdirSync(real), [path.basename(file)], 'exact fixture directory');
  const existing = fs.readFileSync(file, 'utf8');
  assert(existing.length > 0, 'fixture must not be empty');
  assert.equal(existing, output, 'fixture drift');
  console.log(JSON.stringify({ mode, file: path.basename(file), bytes: Buffer.byteLength(existing) }));
}
