#!/usr/bin/env node
'use strict';
// Paired prepared-operation benchmark for six ordinary application models.
// --write / --check build the artifact. --serve compiles here, then times a
// clean worker that loads CommonJS through Module._compile. The worker does
// not load TypeScript. This file records no timings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const NODE_PIN = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const NOW = 1900000000000;
const EARLIER = 1700000000000;
const ID = '507f1f77bcf86cd799439011';
const ARTIFACT = 'ordinary-application-schemas-benchmark-input.json';
const OPERATIONS = ['constructValidate', 'constructValidateSerialize'];
const SOURCES = [
  ['temporary_moderator', 'src/schemas/temporary_moderator.schema.ts', 'TemporaryModeratorSchema'],
  ['vip', 'src/schemas/vip.schema.ts', 'VipSchema'],
  ['titleConfig', 'src/schemas/title_config.schema.ts', 'TitleConfigSchema'],
  ['TriggerFile', 'src/schemas/trigger_file.schema.ts', 'TriggerFileSchema'],
  ['eventsub', 'src/schemas/eventsub.schema.ts', 'default'],
  ['site_analytics', 'src/schemas/site_analytics.schema.ts', 'SiteAnalyticsSchema'],
];
const HASH_FILES = [
  'src/schemas/temporary_moderator.schema.ts',
  'src/schemas/vip.schema.ts',
  'src/schemas/title_config.schema.ts',
  'src/schemas/trigger_file.schema.ts',
  'src/schemas/eventsub.schema.ts',
  'src/schemas/site_analytics.schema.ts',
  'src/schemas/schema.rs',
  'src/schemas/ordinary_model_values.rs',
  'src/schemas/temporary_moderator.schema.rs',
  'src/schemas/vip.schema.rs',
  'src/schemas/title_config.schema.rs',
  'src/schemas/trigger_file.schema.rs',
  'src/schemas/eventsub.schema.rs',
  'src/schemas/site_analytics.schema.rs',
  'src/schemas/mod.rs',
  'src/lib.rs',
  'src/utils/js_string.rs',
  'src/utils/bson_compat.rs',
  'src/utils/mongoose_date.rs',
  'src/utils/json_number.rs',
  'tests/ordinary_application_schemas.rs',
  'tests/ordinary_application_schemas_benchmark.rs',
  'tests/fixtures/ordinary_application_schemas_reference.cjs',
  'tests/fixtures/ordinary_application_schemas_benchmark.cjs',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'package.json',
  'package-lock.json',
  'node_modules/mongoose/package.json',
  'node_modules/mongoose/lib/helpers/pluralize.js',
  'node_modules/mongoose/lib/utils.js',
  'node_modules/mongoose/lib/helpers/schema/getIndexes.js',
  'node_modules/mongoose/lib/helpers/timestamps/setDocumentTimestamps.js',
  'node_modules/bson/package.json',
  'node_modules/typescript/package.json',
];

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const realDate = Date;
const current = NOW;

class FixtureDate extends realDate {
  constructor(...args) {
    super(...(args.length ? args : [current]));
  }
  static now() {
    return current;
  }
}
Object.defineProperty(FixtureDate, 'name', { value: 'Date' });
globalThis.__OrdinaryFixtureDate = FixtureDate;

function sourceRoot() {
  const rootArg = process.env.DIMA_ORDINARY_SCHEMAS_BENCH_SOURCE_ROOT;
  assert(rootArg && path.isAbsolute(rootArg));
  const root = fs.realpathSync(rootArg);
  assert.equal(root, rootArg);
  return root;
}

function artifactDir() {
  const dirArg = process.env.DIMA_ORDINARY_SCHEMAS_BENCH_DIR;
  assert(dirArg && path.isAbsolute(dirArg));
  const dir = fs.realpathSync(dirArg);
  assert.equal(dir, dirArg);
  const root = sourceRoot();
  const workspace = path.dirname(root);
  assert(dir !== root && !dir.startsWith(root + path.sep));
  assert(dir !== workspace && !dir.startsWith(workspace + path.sep));
  return dir;
}

function assertRuntime(root) {
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(process.env.DIMA_ORDINARY_SCHEMAS_BENCH_NODE_SHA256, NODE_PIN);
  assert.equal(sha(fs.readFileSync(process.execPath)), NODE_PIN);
  assert.deepEqual(
    [process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode],
    ['24.22.1', '13.6.233.17-node.58', '78.3', '17.0'],
  );
  const requireFrom = createRequire(path.join(root, 'package.json'));
  const mongoose = requireFrom('mongoose');
  const bsonPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(requireFrom.resolve('bson')), '..', 'package.json'), 'utf8'));
  assert.equal(mongoose.version, '8.24.2');
  assert.equal(bsonPackage.version, '6.10.4');
  return { mongoose, requireFrom };
}

function reps() {
  const value = Number(process.env.DIMA_ORDINARY_SCHEMAS_BENCH_REPS || 1000);
  assert(Number.isSafeInteger(value) && value >= 1 && value <= 10000);
  return value;
}

function expand(value, Types) {
  if (Array.isArray(value)) return value.map((item) => expand(item, Types));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$date === 'number') return new realDate(value.$date);
    if (keys.length === 1 && typeof value.$oid === 'string') return new Types.ObjectId(value.$oid);
    return Object.fromEntries(keys.map((key) => [key, expand(value[key], Types)]));
  }
  return value;
}

function canonical(value) {
  if (value instanceof realDate) return { $dateMs: value.getTime() };
  if (value && value._bsontype === 'ObjectId') return { $oid: value.toHexString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return Object.fromEntries(keys.map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function wire(record) {
  return JSON.stringify(canonical(record));
}

function checksum(values) {
  let hash = 2166136261;
  for (const value of values) {
    for (const byte of Buffer.from(value, 'utf8')) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    hash = Math.imul(hash ^ 0xffffffff, 16777619) >>> 0;
  }
  return hash;
}

function loadCompiled(filename, text, localMongoose) {
  const body = String(text).replace(/^\uFEFF?"use strict";\r?\n?/, '');
  const wrapped = `"use strict";\nconst Date = globalThis.__OrdinaryFixtureDate;\n${body}`;
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled.require = (id) => {
    assert.equal(id, 'mongoose');
    return localMongoose;
  };
  compiled._compile(wrapped, filename);
  return compiled.exports;
}

function buildModels(mongoose, texts) {
  const instance = new mongoose.Mongoose();
  instance.set('autoCreate', false);
  instance.set('autoIndex', false);
  instance.now = () => new realDate(current);
  assert.equal(instance.connection.readyState, 0);
  const localMongoose = {
    Schema: instance.Schema,
    model: instance.model.bind(instance),
    Types: instance.Types,
  };
  const models = {};
  for (const [name, file, exportName] of SOURCES) {
    const exportsObject = loadCompiled(path.join(file), texts[file], localMongoose);
    const model = exportName === 'default' ? exportsObject.default : exportsObject[exportName];
    assert.equal(typeof model, 'function', name);
    assert.equal(model.modelName, name);
    models[name] = model;
  }
  return { models, Types: instance.Types };
}

function materialize(model, input) {
  const document = new model(input);
  const error = document.validateSync();
  if (error) throw error;
  return document.toObject({ minimize: true, depopulate: true, flattenMaps: true });
}

function assertUtcDefaults(name, input, plain) {
  if ((name === 'vip' || name === 'TriggerFile') && !Object.hasOwn(input, 'date')) {
    assert.equal(plain.date.day, 17);
    assert.equal(plain.date.year, 2030);
    assert.equal(plain.date.month, name === 'vip' ? 2 : 3);
  }
}

function pools() {
  const temp = {
    channelID: 'channel-id',
    channel: 'channel',
    userID: 'user',
    username: 'viewer',
    durationDays: 3,
    expireTimestamp: { $date: NOW },
  };
  const vip = {
    username: 'viewer',
    userID: 'user',
    channel: 'channel',
    channelID: 'channel-id',
    duration: 7,
    expireDate: { day: 3, month: 2, year: 2031 },
    expireTimestamp: { $date: NOW },
  };
  const vipDate = { day: 2, month: 1, year: 2030 };
  const title = { channelID: 'channel-id', channel: 'channel' };
  const trigger = {
    name: 'clip',
    fileName: 'clip.mp4',
    fileSize: 12,
    fileType: 'video/mp4',
    fileUrl: 'https://example.invalid/clip.mp4',
    channel: 'channel',
    channelID: 'channel-id',
  };
  const triggerDate = { day: 4, month: 5, year: 2030 };
  const eventsub = {
    id: 'sub-1',
    status: 'enabled',
    type: 'channel.follow',
    version: '1',
    condition: { broadcaster_user_id: 'broadcaster' },
    created_at: '2030-03-17T17:46:40Z',
    transport: { method: 'webhook', callback: 'https://example.invalid/hook' },
    cost: 1,
    channel: 'channel',
    channelID: 'channel-id',
  };
  return {
    temporary_moderator: [
      temp,
      { ...temp, username: 'Árbol 東京 😀' },
      { ...temp, durationDays: '12', expireTimestamp: NOW },
      { ...temp, createdAt: { $date: EARLIER } },
    ],
    vip: [
      vip,
      { ...vip, date: vipDate, username: 'Árbol 東京 😀' },
      { ...vip, date: vipDate, vip: false },
      { ...vip, date: vipDate, username: 'Ω' },
    ],
    titleConfig: [
      title,
      { ...title, pretitle: 'Árbol', posttitle: '東京 😀' },
      { ...title, active: false },
      { ...title, active: 'yes', channel: 'Ω' },
    ],
    TriggerFile: [
      trigger,
      { ...trigger, date: triggerDate, name: 'Árbol 東京 😀' },
      { ...trigger, date: triggerDate, fileSize: '12' },
      { ...trigger, date: triggerDate, name: 'Ω' },
    ],
    eventsub: [
      eventsub,
      { ...eventsub, cheerTiers: [{ id: 'tier', name: 'cheer', message: 'hello', min_amount: 1, max_amount: 10 }] },
      { ...eventsub, message: 'Árbol 東京 😀' },
      { ...eventsub, enabled: false, endEnabled: true, todayFollows: true, message: 'Ω' },
    ],
    site_analytics: [
      {},
      { singletonKey: 'other', registeredUsers: 4, liveUsers: '5' },
      {
        liveChannels: [{
          channelID: 'channel-id',
          channel: 'channel',
          streamId: 'stream',
          title: 'Live',
          gameName: 'game',
          viewers: 9,
          profileImageUrl: 'https://example.invalid/a.png',
          startedAt: '2030-03-17T00:00:00Z',
          fetchedAt: '2030-03-17T00:00:01Z',
          botPlatforms: ['twitch', 'kick'],
          planTier: 'pro',
        }],
      },
      {
        liveChannels: [{
          channelID: 'channel-id',
          channel: 'Ω',
          title: 'Árbol 東京 😀',
          viewers: 1,
          botPlatforms: ['twitch', 'kick'],
          planTier: 'premium',
        }],
      },
    ],
  };
}

function preparePools(bundle) {
  const inputPools = pools();
  assert.deepEqual(Object.keys(inputPools), SOURCES.map(([name]) => name));
  const prepared = {};
  for (const [name, list] of Object.entries(inputPools)) {
    assert.equal(list.length, 4, name);
    prepared[name] = list.map((input, index) => {
      const expanded = expand(input, bundle.Types);
      expanded._id = new bundle.Types.ObjectId(ID);
      const plain = materialize(bundle.models[name], expanded);
      assertUtcDefaults(name, input, plain);
      const output = wire({ ok: true, document: canonical(plain) });
      return { id: `${name}-${index}`, input, wire: output, checksum: checksum([output]) };
    });
  }
  return prepared;
}

function compileTexts(ts, root) {
  const texts = {};
  const compiledSha256 = {};
  for (const [, file] of SOURCES) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const javascript = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      reportDiagnostics: true,
    });
    assert.deepEqual((javascript.diagnostics || []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
    texts[file] = javascript.outputText;
    compiledSha256[file] = sha(javascript.outputText);
  }
  return { texts, compiledSha256 };
}

function sourceSha256(root) {
  return Object.fromEntries(HASH_FILES.map((file) => [file, sha(fs.readFileSync(path.join(root, file)))]));
}

function metadata(root, versions, compiledSha256) {
  return {
    format: 1,
    realm: 'commonjs-module',
    nodeSha: NODE_PIN,
    versions,
    tz: 'UTC',
    now: NOW,
    objectId: ID,
    operations: OPERATIONS,
    poolSize: 4,
    sourceSha256: sourceSha256(root),
    compiledSha256,
  };
}

function versionsOf(mongoose) {
  return {
    node: process.versions.node,
    v8: process.versions.v8,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
    typescript: '5.9.3',
    mongoose: mongoose.version,
    bson: '6.10.4',
  };
}

function readyPayload(prepared, meta, inputSha, repetitionCount) {
  return {
    ready: true,
    realm: 'commonjs-module',
    pools: Object.fromEntries(Object.entries(prepared).map(([name, rows]) => [name, rows.map((row) => row.id)])),
    reps: repetitionCount,
    operations: OPERATIONS,
    inputSha,
    nodeSha: NODE_PIN,
    now: NOW,
    objectId: ID,
    tz: 'UTC',
    compiled: meta.compiledSha256,
    nativeHashes: meta.sourceSha256,
  };
}

function serveLoop(bundle, prepared) {
  const repetitionCount = reps();
  const runnable = {};
  for (const [name, rows] of Object.entries(prepared)) {
    runnable[name] = rows.map((row) => {
      const input = expand(row.input, bundle.Types);
      input._id = new bundle.Types.ObjectId(ID);
      const plain = materialize(bundle.models[name], input);
      assertUtcDefaults(name, row.input, plain);
      const output = wire({ ok: true, document: canonical(plain) });
      assert.equal(output, row.wire, row.id);
      assert.equal(checksum([output]), row.checksum, row.id);
      return input;
    });
  }
  function run(name, operation) {
    const pool = runnable[name];
    const total = pool.length * repetitionCount;
    const started = process.hrtime.bigint();
    if (operation === 'constructValidate') {
      const documents = new Array(total);
      for (let index = 0; index < total; index += 1) documents[index] = materialize(bundle.models[name], pool[index % pool.length]);
      const elapsedNs = (process.hrtime.bigint() - started).toString();
      const wires = documents.map((document) => wire({ ok: true, document: canonical(document) }));
      return { workload: name, operation, elapsedNs, total, checksum: checksum(wires) };
    }
    const wires = new Array(total);
    for (let index = 0; index < total; index += 1) {
      const document = materialize(bundle.models[name], pool[index % pool.length]);
      wires[index] = wire({ ok: true, document: canonical(document) });
    }
    const elapsedNs = (process.hrtime.bigint() - started).toString();
    return { workload: name, operation, elapsedNs, total, checksum: checksum(wires) };
  }
  return { repetitionCount, run };
}

function workerMain() {
  const root = sourceRoot();
  const { mongoose } = assertRuntime(root);
  const dir = artifactDir();
  const bytes = fs.readFileSync(path.join(dir, ARTIFACT));
  const inputSha = sha(bytes);
  assert.equal(inputSha, process.env.DIMA_ORDINARY_SCHEMAS_BENCH_INPUT_SHA256);
  const data = JSON.parse(bytes);
  const compiledDir = process.env.DIMA_ORDINARY_SCHEMAS_BENCH_COMPILED;
  assert(compiledDir && path.isAbsolute(compiledDir));
  const texts = {};
  for (const [, file] of SOURCES) {
    const text = fs.readFileSync(path.join(compiledDir, `${path.basename(file, '.ts')}.js`), 'utf8');
    assert.equal(sha(text), data.metadata.compiledSha256[file], file);
    texts[file] = text;
  }
  const bundle = buildModels(mongoose, texts);
  const prepared = data.pools;
  const served = serveLoop(bundle, prepared);
  console.log(JSON.stringify(readyPayload(prepared, data.metadata, inputSha, served.repetitionCount)));
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const command = JSON.parse(line);
    if (command.command === 'quit') process.exit(0);
    assert(command.command === 'warmup' || command.command === 'run');
    assert(Object.hasOwn(prepared, command.workload));
    assert(OPERATIONS.includes(command.operation));
    console.log(JSON.stringify(served.run(command.workload, command.operation)));
  });
  lines.on('close', () => process.exit(0));
}

function parentMain(ts) {
  const mode = process.argv[2];
  assert(['--write', '--check', '--serve'].includes(mode) && process.argv.length === 3);
  const root = sourceRoot();
  const { mongoose } = assertRuntime(root);
  assert.equal(ts.version, '5.9.3');
  const dir = artifactDir();
  const target = path.join(dir, ARTIFACT);
  const { texts, compiledSha256 } = compileTexts(ts, root);
  const meta = metadata(root, versionsOf(mongoose), compiledSha256);
  if (mode === '--write' || mode === '--check') {
    assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [ARTIFACT]);
    const bundle = buildModels(mongoose, texts);
    const body = `${JSON.stringify({ metadata: meta, pools: preparePools(bundle) }, null, 2)}\n`;
    if (mode === '--write') fs.writeFileSync(target, body, { flag: 'wx' });
    else assert.equal(fs.readFileSync(target, 'utf8'), body);
    console.log(`${ARTIFACT} sha256=${sha(body)}`);
    return;
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), [ARTIFACT]);
  const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(existing.metadata.compiledSha256, compiledSha256);
  assert.equal(sha(fs.readFileSync(target)), process.env.DIMA_ORDINARY_SCHEMAS_BENCH_INPUT_SHA256);
  const compiledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-application-schemas-'));
  try {
    for (const [, file] of SOURCES) {
      fs.writeFileSync(path.join(compiledDir, `${path.basename(file, '.ts')}.js`), texts[file], { flag: 'wx' });
    }
    const child = spawnSync(process.execPath, [__filename, '--worker'], {
      stdio: 'inherit',
      env: { ...process.env, DIMA_ORDINARY_SCHEMAS_BENCH_COMPILED: compiledDir },
    });
    assert.equal(child.status, 0);
  } finally {
    fs.rmSync(compiledDir, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') workerMain();
else parentMain(require('typescript'));
