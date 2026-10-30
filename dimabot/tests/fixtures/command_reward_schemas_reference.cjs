'use strict';

// Disconnected Mongoose oracle for the live command, reward, and availability
// schemas. It never connects. Parent runs it and writes the JSON outside the
// checkout. Hook output is the pre-castUpdate document.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXED_MS = 1900000000000;
const TOKEN = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '507f1f77bcf86cd799439011';
const ROOT = path.resolve(__dirname, '../..');
const REPO = path.resolve(ROOT, '..');
const SOURCES = [
  'src/schemas/commands.schema.ts',
  'src/schemas/redemption_reward.schema.ts',
  'src/utils/availability/schema.ts',
];
const SOURCE_SHA = {
  'src/schemas/commands.schema.ts': '1a6ed070b37a850b9d358a86b2f97ff0a5e6b977f41ac7b51f2b01e0d9bb7da3',
  'src/schemas/redemption_reward.schema.ts': 'acc13c1d532d1078bbbb3d8260c7815565e63cae003fbad00564930b6b53e5a2',
  'src/utils/availability/schema.ts': '98785af1992534d8d723cd429626d4da268aa8bf41023b3e12b01b2bdc4a2b26',
};
const VERSIONS = {
  node: '24.22.1',
  v8: '13.6.233.17-node.58',
  icu: '78.3',
  unicode: '17.0',
  typescript: '5.9.3',
  mongoose: '8.24.2',
  bson: '6.10.4',
};
const NODE_SHA = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: ${actual} !== ${expected}`);
  }
}

function writePath() {
  const index = process.argv.indexOf('--write');
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error('usage: node command_reward_schemas_reference.cjs --write <absolute path outside the checkout>');
  }
  const requested = process.argv[index + 1];
  if (!path.isAbsolute(requested)) throw new Error('--write must be absolute');
  const parent = fs.realpathSync(path.dirname(requested));
  const canonical = path.join(parent, path.basename(requested));
  if (canonical !== path.resolve(requested)) {
    throw new Error(`--write is not canonical: ${requested} -> ${canonical}`);
  }
  const repo = fs.realpathSync(REPO);
  if (canonical === repo || canonical.startsWith(repo + path.sep)) {
    throw new Error(`refusing to write inside ${repo}`);
  }
  return canonical;
}

function pinEnvironment() {
  assertEqual(process.versions.node, VERSIONS.node, 'node');
  assertEqual(process.versions.v8, VERSIONS.v8, 'v8');
  assertEqual(process.versions.icu, VERSIONS.icu, 'icu');
  assertEqual(process.versions.unicode, VERSIONS.unicode, 'unicode');
  assertEqual(sha256(fs.readFileSync(process.execPath)), NODE_SHA, 'node executable');
  if (!process.env.TZ) throw new Error('TZ must be set so the replay uses the same local calendar');
  const packages = {
    typescript: readJson(path.join(ROOT, 'node_modules/typescript/package.json')).version,
    mongoose: readJson(path.join(ROOT, 'node_modules/mongoose/package.json')).version,
    bson: readJson(path.join(ROOT, 'node_modules/bson/package.json')).version,
  };
  for (const name of ['typescript', 'mongoose', 'bson']) {
    assertEqual(packages[name], VERSIONS[name], name);
  }
}

function sourceHashes() {
  const hashes = {};
  for (const relative of SOURCES) {
    hashes[relative] = sha256(fs.readFileSync(path.join(ROOT, relative)));
    assertEqual(hashes[relative], SOURCE_SHA[relative], relative);
  }
  return hashes;
}

function typecheck(ts) {
  const configPath = path.join(ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  // This checkout is missing the type-only import. The native StoredBlocks
  // definition and index.ts storedBlocks() establish the v/root shape.
  const missing = path.resolve(ROOT, 'src/utils/ast_blocks/types.ts');
  const declaration = 'export interface StoredBlocks { v: number; root: { id: string; type: "root"; children: unknown[] } }';
  const host = ts.createCompilerHost(parsed.options);
  const exists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (file) => path.resolve(file) === missing || exists(file);
  host.readFile = (file) => path.resolve(file) === missing ? declaration : readFile(file);
  host.getSourceFile = (file, languageVersion, ...args) => path.resolve(file) === missing
    ? ts.createSourceFile(file, declaration, languageVersion) : getSourceFile(file, languageVersion, ...args);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
  const wanted = new Set(SOURCES.map((relative) => path.resolve(ROOT, relative)));
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
    return diagnostic.file && wanted.has(path.resolve(diagnostic.file.fileName));
  });
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => ROOT,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    }));
  }
}

function patchClock() {
  const OriginalDate = Date;
  class FixedDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_MS);
      else super(...args);
    }
    static now() {
      return FIXED_MS;
    }
  }
  // Schema paths were compiled against the native Date before freezing time.
  // BSON must continue to recognize those native instances as dates as well.
  Object.defineProperty(FixedDate, Symbol.hasInstance, {
    value: (value) => value instanceof OriginalDate,
  });
  // Mongoose's object clone dispatches by constructor name.
  Object.defineProperty(FixedDate, 'name', { value: 'Date' });
  FixedDate.parse = OriginalDate.parse;
  FixedDate.UTC = OriginalDate.UTC;
  global.Date = FixedDate;
  require('node:crypto').randomUUID = () => TOKEN;
}

function emitSources(ts, temp) {
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  for (const relative of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2024,
        esModuleInterop: true,
      },
      fileName: relative,
    });
    const output = path.join(temp, relative.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, compiled.outputText);
  }
  return {
    commands: path.join(temp, 'src/schemas/commands.schema.js'),
    rewards: path.join(temp, 'src/schemas/redemption_reward.schema.js'),
    availability: path.join(temp, 'src/utils/availability/schema.js'),
  };
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value._bsontype) return value;
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = clone(value[key]);
  return copy;
}

function canonical(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (value instanceof Date) return { $date: value.getTime() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    if (value._bsontype === 'ObjectId') return { $oid: String(value) };
    const copy = {};
    for (const key of Object.keys(value).sort()) copy[key] = normalize(value[key]);
    return copy;
  }
  return value;
}

function pack(BSON, value) {
  return Buffer.from(BSON.serialize({ value })).toString('hex');
}

function objectId(mongoose) {
  return new mongoose.Types.ObjectId(COMMAND_ID);
}

function hiddenPaths(schema) {
  const names = [];
  schema.eachPath((pathname, schemaType) => {
    if (pathname.includes('.')) return;
    if (schemaType.selected === false || schemaType.options?.select === false) names.push(pathname);
  });
  names.sort();
  return names;
}

function versionKeyName(schema) {
  return schema.options.versionKey === true ? '__v' : schema.options.versionKey;
}

function assertNoSubdocId(schema, pathname) {
  const nested = schema.path(pathname);
  if (!nested || !nested.schema || nested.schema.options._id !== false) {
    throw new Error(`${pathname} subdocument _id is not false`);
  }
}

function assertSparseIndex(schema) {
  const indexes = schema.indexes();
  if (indexes.length !== 1) throw new Error(`index count ${indexes.length}`);
  const [keys, options] = indexes[0];
  if (keys['availability.nextAt'] !== 1 || options.sparse !== true) {
    throw new Error(`index ${JSON.stringify(keys)} ${JSON.stringify(options)}`);
  }
  if (options.expireAfterSeconds != null) throw new Error('TTL index was invented');
  return { indexCount: 1, sparse: true, ttl: null };
}

function collectionName(model) {
  const name = model.collection.collectionName;
  if (typeof model.collection.name === 'string' && model.collection.name !== name) {
    throw new Error(`collection .name ${model.collection.name} != collectionName ${name}`);
  }
  return name;
}

function metadata(model, expectedCollection, expectedHidden) {
  const schema = model.schema;
  if (schema.options.timestamps) throw new Error(`${model.modelName} timestamps are set`);
  const hidden = hiddenPaths(schema);
  if (JSON.stringify(hidden) !== JSON.stringify(expectedHidden)) {
    throw new Error(`${model.modelName} hidden ${hidden.join(',')}`);
  }
  assertNoSubdocId(schema, 'availability');
  assertNoSubdocId(schema, 'availabilityLease');
  const name = collectionName(model);
  assertEqual(name, expectedCollection, `${model.modelName} collection`);
  return {
    model: model.modelName,
    collection: name,
    versionKey: versionKeyName(schema),
    hidden,
    ...assertSparseIndex(schema),
  };
}

function toPlain(document) {
  return document.toObject({
    versionKey: false,
    flattenMaps: true,
    minimize: true,
    virtuals: false,
    getters: false,
    id: false,
  });
}

function recordConstruct(BSON, name, modelKey, model, input) {
  const source = clone(input);
  const document = new model(clone(input));
  const error = document.validateSync();
  const record = {
    name,
    model: modelKey,
    inputHex: pack(BSON, source),
    outputHex: null,
    errors: null,
  };
  if (error) {
    if (!error.errors) throw new Error(`${name}: ${error.name}: ${error.message}`);
    const errors = {};
    for (const [key, value] of Object.entries(error.errors)) errors[key] = value.kind;
    record.errors = errors;
    return record;
  }
  if (name === 'command-minimal') {
    const created = document.get('createdAt');
    if (!(created instanceof Date) || created.getTime() !== FIXED_MS) {
      throw new Error('command createdAt did not use the fixed clock');
    }
  }
  const plain = toPlain(document);
  if (name === 'command-minimal' && !(plain.createdAt instanceof Date)) {
    throw new Error('toObject did not retain createdAt as a Date');
  }
  if (Object.prototype.hasOwnProperty.call(plain, '__v') || Object.prototype.hasOwnProperty.call(plain, 'id')) {
    throw new Error(`${name}: toObject kept __v or id`);
  }
  record.outputHex = pack(BSON, plain);
  return record;
}

function execQuery(query) {
  if (!query._queryMiddleware) throw new Error(`missing query middleware for ${query.op}`);
  return new Promise((resolve, reject) => {
    query._queryMiddleware.execPre(query.op, query, [], (error) => error ? reject(error) : resolve());
  });
}

async function runQuery(model, op, update, internalWrite) {
  const argument = update === null ? null : clone(update);
  let query;
  if (op === 'updateOne') query = model.updateOne({ _id: objectId(model.base) }, argument);
  else if (op === 'updateMany') query = model.updateMany({ _id: objectId(model.base) }, argument);
  else if (op === 'findOneAndUpdate') query = model.findOneAndUpdate({ _id: objectId(model.base) }, argument);
  else throw new Error(op);
  if (query.op !== op) throw new Error(`${op} compiled as ${query.op}`);
  if (internalWrite) internalWrite(query);
  if (query.getUpdate() == null) throw new Error(`${op} update is absent after query construction`);
  const before = clone(query.getUpdate());
  await execQuery(query);
  return { before, after: clone(query.getUpdate()) };
}

function installedState(update) {
  if (!update || Array.isArray(update) || !update.$set) return null;
  return update.$set.availability || null;
}

function assertInstalled(name, update, previousEnabled) {
  const state = installedState(update);
  if (!state) throw new Error(`${name}: availability was not installed`);
  assertEqual(state.token, TOKEN, `${name} token`);
  if (!(state.nextAt instanceof Date) || state.nextAt.getTime() !== FIXED_MS) {
    throw new Error(`${name}: nextAt is not the fixed clock`);
  }
  assertEqual(state.pending, true, `${name} pending`);
  assertEqual(state.restoreAt, null, `${name} restoreAt`);
  assertEqual(state.previousEnabled, previousEnabled, `${name} previousEnabled`);
}

function queryRecord(BSON, name, modelKey, field, origin, result) {
  return {
    name,
    model: modelKey,
    field,
    origin,
    beforeHex: pack(BSON, result.before),
    afterHex: pack(BSON, result.after),
    installed: Boolean(installedState(result.after)),
  };
}

function tokenOf(document) {
  const value = document.get('availability');
  if (value == null) return null;
  if (typeof value.get === 'function') return value.get('token') ?? null;
  return value.token ?? null;
}

function statePlain(value) {
  if (value == null) return null;
  const raw = value._doc || value;
  for (const key of ['token', 'previousEnabled', 'restoreAt', 'pending', 'nextAt']) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) throw new Error(`availability missing ${key}`);
  }
  return {
    token: raw.token,
    previousEnabled: raw.previousEnabled,
    restoreAt: raw.restoreAt,
    pending: raw.pending,
    nextAt: raw.nextAt,
  };
}

function execSave(document) {
  return new Promise((resolve, reject) => {
    document.schema.s.hooks.execPre('save', document, [{}], (error) => error ? reject(error) : resolve());
  });
}

async function recordSave(BSON, spec) {
  const document = spec.isNew ? new spec.model(clone(spec.raw)) : spec.model.hydrate(clone(spec.raw));
  if (document.isNew !== spec.isNew) throw new Error(`${spec.name}: isNew ${document.isNew}`);
  if (spec.apply) spec.apply(document);
  const enabledModified = document.isModified(spec.field);
  const assigned = document.get(spec.field);
  const beforeToken = tokenOf(document);
  await execSave(document);
  const afterToken = tokenOf(document);
  const replaced = beforeToken !== afterToken;
  if (spec.isNew && replaced) throw new Error(`${spec.name}: new document replaced availability`);
  if (!spec.isNew && enabledModified !== replaced) {
    throw new Error(`${spec.name}: isModified ${enabledModified} replaced ${replaced}`);
  }
  let availability = null;
  if (replaced) {
    availability = statePlain(document.get('availability'));
    assertEqual(availability.token, TOKEN, `${spec.name} token`);
    if (!(availability.nextAt instanceof Date) || availability.nextAt.getTime() !== FIXED_MS) {
      throw new Error(`${spec.name}: nextAt`);
    }
    assertEqual(availability.previousEnabled, Boolean(assigned), `${spec.name} previousEnabled`);
    assertEqual(availability.pending, true, `${spec.name} pending`);
    assertEqual(availability.restoreAt, null, `${spec.name} restoreAt`);
  }
  const record = {
    name: spec.name,
    model: spec.modelKey,
    field: spec.field,
    isNew: spec.isNew,
    storedPresent: spec.storedPresent,
    assignedHex: pack(BSON, assigned),
    enabledModified,
    replaced,
    availabilityHex: availability ? pack(BSON, availability) : null,
  };
  if (spec.storedPresent) record.storedHex = pack(BSON, spec.storedValue);
  if (spec.note) record.note = spec.note;
  return record;
}

async function main() {
  const destination = writePath();
  pinEnvironment();
  const hashes = sourceHashes();
  const ts = require('typescript');
  typecheck(ts);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-reward-oracle-'));
  try {
    Date.now = () => FIXED_MS;
    const mongoose = require('mongoose');
    mongoose.set('autoCreate', false);
    mongoose.set('autoIndex', false);
    mongoose.set('autoSearchIndex', false);
    const files = emitSources(ts, temp);
    const availability = require(files.availability);
    const commands = require(files.commands).CommandsSchema;
    const rewards = require(files.rewards).RedemptionRewardSchema;
    // Compile schema paths against the native Date constructor first.
    patchClock();
    if (typeof availability.internalWrite !== 'function') throw new Error('internalWrite was not exported');
    if (mongoose.connection.readyState !== 0 || commands.db.readyState !== 0) {
      throw new Error('mongoose connected during schema load');
    }
    const { BSON } = require('bson');
    const commandId = () => new mongoose.Types.ObjectId(COMMAND_ID);
    const rewardInput = (extra) => ({
      _id: commandId(),
      eventsubID: 'e',
      channelID: 'c',
      channel: 'name',
      rewardID: 'r',
      title: 't',
      originalCost: 10,
      cost: 4,
      ...extra,
    });
    const construct = [
      recordConstruct(BSON, 'command-minimal', 'commands', commands, { _id: commandId(), channelID: 'c' }),
      recordConstruct(BSON, 'command-missing-channel', 'commands', commands, {}),
      recordConstruct(BSON, 'command-bad-activation', 'commands', commands, {
        _id: commandId(), channelID: 'c', activation: 'nope',
      }),
      recordConstruct(BSON, 'command-keyword-settings', 'commands', commands, {
        _id: commandId(), channelID: 'c', keywordSettings: {},
      }),
      recordConstruct(BSON, 'command-unknown-field', 'commands', commands, {
        _id: commandId(), channelID: 'c', notAField: 1,
      }),
      recordConstruct(BSON, 'command-responses', 'commands', commands, {
        _id: commandId(), channelID: 'c', responses: [1, 'a'],
      }),
      recordConstruct(BSON, 'reward-minimal', 'rewards', rewards, rewardInput()),
      recordConstruct(BSON, 'reward-missing-title', 'rewards', rewards, {
        _id: commandId(),
        eventsubID: 'e',
        channelID: 'c',
        channel: 'name',
        rewardID: 'r',
        originalCost: 10,
        cost: 4,
      }),
    ];

    const same = { enabled: true };
    const operations = [];
    for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate']) {
      operations.push(await runQuery(commands, op, same));
    }
    if (!operations.every((result) => canonical(result.after) === canonical(operations[0].after))) {
      throw new Error('updateOne, updateMany, and findOneAndUpdate hook outputs differ');
    }
    assertInstalled('same-value', operations[0].after, true);
    const query = [
      queryRecord(BSON, 'same-value-enabled', 'commands', 'enabled', 'ordinary', operations[0]),
    ];
    const cases = [
      ['set-enabled-false', { $set: { enabled: false, message: 'm' } }, false],
      ['set-null-falls-through', { enabled: true, $set: { enabled: null } }, true],
      ['string-false', { enabled: 'false' }, true],
      ['root-null', { enabled: null }, false],
      ['payload-property', { enabled: false, internalAvailabilityWrite: true }, false],
      ['empty-unset', { $unset: { 'availability.token': 1 }, enabled: true }, true],
    ];
    for (const [name, update, previous] of cases) {
      const result = await runQuery(commands, 'updateOne', update);
      assertInstalled(name, result.after, previous);
      query.push(queryRecord(BSON, name, 'commands', 'enabled', 'ordinary', result));
    }
    const nullOnly = await runQuery(commands, 'updateOne', { $set: { enabled: null } });
    if (installedState(nullOnly.after)) throw new Error('null $set enabled installed availability');
    query.push(queryRecord(BSON, 'set-null-only', 'commands', 'enabled', 'ordinary', nullOnly));

    const stripped = await runQuery(commands, 'updateOne', {
      enabled: true,
      availability: { token: 'no' },
      availabilityX: 'keep',
      availabilityLeases: 'keep',
      $set: { 'availability.nextAt': 1, 'availabilityLease.token': 'x', message: 'm' },
      $unset: { 'availability.token': 1, description: 1 },
      $setOnInsert: { availabilityLease: { token: 'z' }, channel: 'c' },
    });
    assertInstalled('strip-dotted', stripped.after, true);
    if (stripped.after.availability || stripped.after.$set['availability.nextAt'] || stripped.after.$unset['availability.token']) {
      throw new Error('availability keys survived the strip');
    }
    if (stripped.after.availabilityX !== 'keep' || stripped.after.$unset.description !== 1) {
      throw new Error('unrelated keys were stripped');
    }
    query.push(queryRecord(BSON, 'strip-dotted', 'commands', 'enabled', 'ordinary', stripped));

    const insertOnly = await runQuery(commands, 'updateOne', {
      $setOnInsert: { enabled: true, availability: { token: 'x' } },
    });
    if (installedState(insertOnly.after) || insertOnly.after.$setOnInsert.availability) {
      throw new Error('$setOnInsert changed availability state');
    }
    query.push(queryRecord(BSON, 'set-on-insert-enabled', 'commands', 'enabled', 'ordinary', insertOnly));

    const pipeline = await runQuery(commands, 'updateOne', [
      { $set: { enabled: true, availability: { token: 'pipe' } } },
    ]);
    if (canonical(pipeline.before) !== canonical(pipeline.after)) throw new Error('pipeline was modified');
    query.push(queryRecord(BSON, 'pipeline', 'commands', 'enabled', 'ordinary', pipeline));

    const absent = await runQuery(commands, 'updateOne', null);
    if (canonical(absent.before) !== canonical(absent.after) || !absent.after._id) {
      throw new Error('null overload did not use the filter as its update');
    }
    query.push(queryRecord(BSON, 'null-update', 'commands', 'enabled', 'ordinary', absent));

    const internal = await runQuery(commands, 'updateOne', {
      enabled: true,
      availability: { token: 'keep' },
    }, availability.internalWrite);
    if (canonical(internal.before) !== canonical(internal.after) || internal.after.availability.token !== 'keep') {
      throw new Error('internal origin did not bypass the hook');
    }
    query.push(queryRecord(BSON, 'internal-bypass', 'commands', 'enabled', 'internal', internal));

    const payload = query.find((item) => item.name === 'payload-property');
    const payloadAfter = BSON.deserialize(Buffer.from(payload.afterHex, 'hex')).value;
    if (payloadAfter.internalAvailabilityWrite !== true) {
      throw new Error('payload marker was removed; the bypass must be the call flag');
    }

    const rewardSame = await runQuery(rewards, 'updateOne', { isEnabled: true });
    assertInstalled('reward-same-value', rewardSame.after, true);
    query.push(queryRecord(BSON, 'reward-same-value', 'rewards', 'isEnabled', 'ordinary', rewardSame));

    const commandRaw = (extra) => ({ _id: commandId(), channelID: 'c', ...extra });
    const save = [];
    save.push(await recordSave(BSON, {
      name: 'new-command',
      modelKey: 'commands',
      model: commands,
      field: 'enabled',
      isNew: true,
      storedPresent: false,
      raw: commandRaw({}),
    }));
    save.push(await recordSave(BSON, {
      name: 'save-same-enabled',
      modelKey: 'commands',
      model: commands,
      field: 'enabled',
      isNew: false,
      storedPresent: true,
      storedValue: true,
      raw: commandRaw({ enabled: true }),
      apply: (document) => document.set('enabled', true),
    }));
    save.push(await recordSave(BSON, {
      name: 'save-missing-enabled',
      modelKey: 'commands',
      model: commands,
      field: 'enabled',
      isNew: false,
      storedPresent: false,
      raw: commandRaw({}),
      apply: (document) => document.set('enabled', true),
    }));
    save.push(await recordSave(BSON, {
      name: 'save-disable',
      modelKey: 'commands',
      model: commands,
      field: 'enabled',
      isNew: false,
      storedPresent: true,
      storedValue: true,
      raw: commandRaw({ enabled: true }),
      apply: (document) => document.set('enabled', false),
    }));
    save.push(await recordSave(BSON, {
      name: 'save-numeric-one',
      modelKey: 'commands',
      model: commands,
      field: 'enabled',
      isNew: false,
      storedPresent: true,
      storedValue: true,
      raw: commandRaw({ enabled: true }),
      apply: (document) => document.set('enabled', 1),
      note: 'set() received numeric 1; assignedHex is the cast document value',
    }));
    save.push(await recordSave(BSON, {
      name: 'save-message-only',
      modelKey: 'commands',
      model: commands,
      field: 'enabled',
      isNew: false,
      storedPresent: true,
      storedValue: true,
      raw: commandRaw({ enabled: true, message: 'a' }),
      apply: (document) => document.set('message', 'b'),
    }));
    save.push(await recordSave(BSON, {
      name: 'reward-same',
      modelKey: 'rewards',
      model: rewards,
      field: 'isEnabled',
      isNew: false,
      storedPresent: true,
      storedValue: true,
      raw: rewardInput({ isEnabled: true }),
      apply: (document) => document.set('isEnabled', true),
    }));
    save.push(await recordSave(BSON, {
      name: 'reward-disable',
      modelKey: 'rewards',
      model: rewards,
      field: 'isEnabled',
      isNew: false,
      storedPresent: true,
      storedValue: true,
      raw: rewardInput({ isEnabled: true }),
      apply: (document) => document.set('isEnabled', false),
    }));

    if (commands.db.readyState !== 0) throw new Error('mongoose connected while recording hooks');
    const oracle = {
      nodeSha: NODE_SHA,
      zone: process.env.TZ,
      versions: VERSIONS,
      sourceHashes: hashes,
      typecheckDiagnostics: 0,
      phase: 'pre-update-before-castUpdate',
      operationsMatch: true,
      metadata: {
        commands: metadata(commands, 'commands', ['availability', 'availabilityLease', 'blocks']),
        rewards: metadata(rewards, 'redemptionrewards', ['availability', 'availabilityLease']),
      },
      construct,
      query,
      save,
    };
    assertEqual(oracle.metadata.commands.versionKey, '__v', 'commands versionKey');
    assertEqual(oracle.metadata.rewards.versionKey, '__v', 'rewards versionKey');
    assertNoSubdocId(commands.schema, 'keywordSettings');
    const body = `${JSON.stringify(oracle, null, 2)}\n`;
    fs.writeFileSync(destination, body);
    process.stderr.write(`wrote ${destination}\nsha256 ${sha256(body)}\n`);
  } finally {
    const link = path.join(temp, 'node_modules');
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
