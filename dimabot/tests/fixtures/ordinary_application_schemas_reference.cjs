#!/usr/bin/env node
'use strict';
// Actual-source oracle for six live Mongoose models. Disconnected instance only.
// Parent: --write DIR | --check DIR. Children: --tz-child with DIMA_ORDINARY_SCHEMA_TZ_CHILD=1.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { resolveSource } = require('./model_schema_source.cjs');

const NODE_PIN = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const ZONES = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Apia'];
const INSTANTS = [1900000000000, 1704067200000, 1706745600000, 1710054000000, 1711846800000, 1712415600000, 1325239200000, 1704067199999];
const NOW = 1900000000000;
const EARLIER = 1700000000000;
const ID = '507f1f77bcf86cd799439011';
const SOURCES = [
  ['temporary_moderator', 'src/schemas/temporary_moderator.schema.ts', 'TemporaryModeratorSchema'],
  ['vip', 'src/schemas/vip.schema.ts', 'VipSchema'],
  ['titleConfig', 'src/schemas/title_config.schema.ts', 'TitleConfigSchema'],
  ['TriggerFile', 'src/schemas/trigger_file.schema.ts', 'TriggerFileSchema'],
  ['eventsub', 'src/schemas/eventsub.schema.ts', 'default'],
  ['site_analytics', 'src/schemas/site_analytics.schema.ts', 'SiteAnalyticsSchema'],
];
const NATIVE_FILES = [
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
  'tests/support/model_schema_source.rs',
  'tests/fixtures/model_schema_source.cjs',
  'tests/fixtures/ordinary_application_schemas_reference.cjs',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
];
const PACKAGE_FILES = [
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
const SAVE_PATH = {
  temporary_moderator: 'username',
  vip: 'username',
  titleConfig: 'channel',
  TriggerFile: 'name',
  eventsub: 'message',
  site_analytics: 'registeredUsers',
};

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const realDate = Date;
let current = NOW;

class FixtureDate extends realDate {
  constructor(...args) {
    super(...(args.length ? args : [current]));
  }
  static now() {
    return current;
  }
}
Object.defineProperty(FixtureDate, 'name', { value: 'Date' });

function assertPins(root) {
  assert.equal(process.env.DIMA_ORDINARY_SCHEMA_NODE_SHA256, NODE_PIN);
  assert.equal(sha(fs.readFileSync(process.execPath)), NODE_PIN);
  assert.deepEqual(
    [process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode],
    ['24.22.1', '13.6.233.17-node.58', '78.3', '17.0'],
  );
  const requireFrom = createRequire(path.join(root, 'package.json'));
  const ts = requireFrom('typescript');
  const mongoose = requireFrom('mongoose');
  const bsonPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(requireFrom.resolve('bson')), '..', 'package.json'), 'utf8'));
  assert.equal(ts.version, '5.9.3');
  assert.equal(mongoose.version, '8.24.2');
  assert.equal(bsonPackage.version, '6.10.4');
  return { ts, mongoose, bson: requireFrom('bson'), requireFrom };
}

function hasExport(statement, ts) {
  return !!(statement.modifiers && statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function astEvidence(ts, filename, source) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(tree.parseDiagnostics, []);
  const imports = tree.statements.filter(ts.isImportDeclaration).map((statement) => ({
    module: statement.moduleSpecifier.text,
    typeOnly: !!(statement.importClause && statement.importClause.isTypeOnly),
    text: statement.getText(tree),
  }));
  assert.deepEqual(imports.map((item) => item.module), ['mongoose']);
  const exports = [];
  for (const statement of tree.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && hasExport(statement, ts)) {
      exports.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && hasExport(statement, ts)) {
      for (const declaration of statement.declarationList.declarations) exports.push(declaration.name.getText(tree));
    }
    if (ts.isExportAssignment(statement)) exports.push('default');
  }
  const interfaces = tree.statements
    .filter((statement) => ts.isInterfaceDeclaration(statement) && hasExport(statement, ts))
    .map((statement) => statement.getText(tree));
  return { imports, exports, interfaces };
}

function describePath(schemaPath) {
  const fallback = schemaPath.options ? schemaPath.options.default : undefined;
  let encoded = null;
  if (typeof fallback === 'function') encoded = String(fallback);
  else if (fallback !== undefined) encoded = fallback;
  const enumValues = schemaPath.enumValues && schemaPath.enumValues.length
    ? schemaPath.enumValues
    : schemaPath.caster && schemaPath.caster.enumValues && schemaPath.caster.enumValues.length
      ? schemaPath.caster.enumValues
      : null;
  return {
    instance: schemaPath.instance,
    required: schemaPath.isRequired === true || !!(schemaPath.options && schemaPath.options.required === true),
    hasDefault: fallback !== undefined,
    default: encoded,
    enum: enumValues,
    index: schemaPath.options && schemaPath.options.index !== undefined ? schemaPath.options.index : false,
    unique: !!(schemaPath.options && schemaPath.options.unique === true),
    caster: schemaPath.caster ? schemaPath.caster.instance : null,
  };
}

function indexView(model) {
  return model.schema.indexes().map(([keys, options]) => ({
    keys,
    keyOrder: Object.keys(keys),
    unique: options.unique === true,
    sparse: options.sparse === true,
    ttl: options.expireAfterSeconds == null ? null : options.expireAfterSeconds,
    partial: options.partialFilterExpression || null,
  }));
}

function expand(value, Types) {
  if (Array.isArray(value)) return value.map((item) => expand(item, Types));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$oid === 'string') return new Types.ObjectId(value.$oid);
    if (keys.length === 1 && typeof value.$date === 'number') return new realDate(value.$date);
    if (keys.length === 1 && value.$double === '-0') return -0;
    if (keys.length === 1 && typeof value.$double === 'number') return value.$double;
    return Object.fromEntries(keys.map((key) => [key, expand(value[key], Types)]));
  }
  return value;
}

function presence(value) {
  if (Array.isArray(value)) return value.map(presence);
  if (value && typeof value === 'object' && !value._bsontype && !(value instanceof realDate)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, presence(child)]));
  }
  return true;
}

function normalize(value, present) {
  if (value instanceof realDate) return { $date: value.getTime() };
  if (value && value._bsontype === 'ObjectId') {
    return { $oid: present === undefined ? 'generated' : value.toHexString() };
  }
  if (Object.is(value, -0)) return { $double: '-0' };
  if (Array.isArray(value)) {
    return value.map((child, index) => normalize(child, Array.isArray(present) ? present[index] : undefined));
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return Object.fromEntries(keys.map((key) => [key, normalize(value[key], present && typeof present === 'object' ? present[key] : undefined)]));
  }
  return value;
}

function bsonTypes(bson, plain) {
  const decoded = bson.deserialize(bson.serialize(plain), { promoteValues: false });
  const out = {};
  const walk = (value, keyPath) => {
    if (value == null || value instanceof realDate) return;
    if (value._bsontype === 'Int32' || value._bsontype === 'Double' || value._bsontype === 'Long' || value._bsontype === 'ObjectId') {
      out[keyPath] = value._bsontype;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, keyPath ? `${keyPath}.${index}` : String(index)));
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) walk(value[key], keyPath ? `${keyPath}.${key}` : key);
    }
  };
  walk(decoded, '');
  delete out[''];
  return out;
}

function errorsOf(error) {
  return Object.keys(error.errors).map((key) => ({
    path: key,
    kind: error.errors[key].name === 'CastError' ? 'cast' : error.errors[key].kind,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(`${left.path}\0${left.kind}`),
    Buffer.from(`${right.path}\0${right.kind}`),
  ));
}

function execPre(model, document) {
  return new Promise((resolve, reject) => {
    model.schema.s.hooks.execPre('save', document, [], (error) => error ? reject(error) : resolve());
  });
}

function compileAll(root, tools) {
  const { ts, mongoose, bson } = tools;
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
  const evidence = {};
  const compiled = {};
  for (const [name, file, exportName] of SOURCES) {
    const source = resolveSource(root, file).bytes.toString('utf8');
    evidence[name] = astEvidence(ts, file, source);
    const javascript = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      reportDiagnostics: true,
    });
    assert.deepEqual((javascript.diagnostics || []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
    compiled[file] = sha(javascript.outputText);
    const exportsObject = {};
    const requireSafe = (id) => {
      assert.equal(id, 'mongoose');
      return localMongoose;
    };
    new vm.Script(`(function(exports,require,module,__filename,__dirname,Date){\n${javascript.outputText}\n})`, { filename: file })
      .runInThisContext()(exportsObject, requireSafe, { exports: exportsObject }, file, path.dirname(file), FixtureDate);
    const model = exportName === 'default' ? exportsObject.default : exportsObject[exportName];
    assert.equal(typeof model, 'function', name);
    assert.ok(model.schema, name);
    assert.equal(model.modelName, name);
    models[name] = model;
  }
  return { models, evidence, compiled, bson, Types: instance.Types };
}

function calendarCase(models, instant) {
  current = instant;
  const vip = new models.vip({
    username: 'viewer',
    userID: 'user',
    channel: 'channel',
    channelID: 'channel-id',
    duration: 1,
    expireDate: { day: 1, month: 0, year: 2030 },
    expireTimestamp: new realDate(instant),
  });
  const trigger = new models.TriggerFile({
    name: 'clip',
    fileName: 'clip.mp4',
    fileSize: 1,
    fileType: 'video/mp4',
    fileUrl: 'https://example.invalid/clip.mp4',
    channel: 'channel',
    channelID: 'channel-id',
  });
  assert.equal(vip.validateSync(), undefined);
  assert.equal(trigger.validateSync(), undefined);
  const vipDate = vip.get('date');
  const triggerDate = trigger.get('date');
  assert.equal(vip.get('createdAt').getTime(), instant);
  assert.equal(trigger.get('createdAt').getTime(), instant);
  return {
    instant,
    vip: { day: vipDate.day, month: vipDate.month, year: vipDate.year },
    trigger: { day: triggerDate.day, month: triggerDate.month, year: triggerDate.year },
    createdAt: instant,
  };
}

async function runCase(bundle, modelName, operation, input, now) {
  current = now;
  const expanded = expand(input, bundle.Types);
  const present = presence(expanded);
  let document;
  try {
    document = new bundle.models[modelName](expanded);
  } catch (error) {
    return {
      thrown: {
        name: (error && error.name) || 'Error',
        message: String((error && error.message) || error),
      },
    };
  }
  const failure = document.validateSync();
  if (failure) return { errors: errorsOf(failure) };
  if (operation === 'insert' || operation === 'save') {
    if (operation === 'save') {
      document.isNew = false;
      document.markModified(SAVE_PATH[modelName]);
    }
    await execPre(bundle.models[modelName], document);
    if (operation === 'insert') document.__v = 0;
  }
  const plain = document.toObject({ minimize: true, depopulate: true, flattenMaps: true });
  return { document: normalize(plain, present), types: bsonTypes(bundle.bson, plain) };
}

async function buildCases(bundle) {
  const cases = [];
  const add = (model, operation, input, now = NOW) => {
    cases.push({ model, operation, now, input });
  };
  const temp = {
    channelID: 'channel-id',
    channel: 'channel',
    userID: 'user',
    username: 'viewer',
    durationDays: 3,
    expireTimestamp: { $date: NOW },
  };
  add('temporary_moderator', 'construct', temp);
  add('temporary_moderator', 'construct', { ...temp, username: 'Árbol 東京 😀' });
  add('temporary_moderator', 'construct', { ...temp, durationDays: '12', expireTimestamp: NOW });
  add('temporary_moderator', 'construct', { ...temp, createdAt: { $date: EARLIER } });
  add('temporary_moderator', 'construct', { ...temp, extra: 'discard' });
  add('temporary_moderator', 'construct', { ...temp, channelID: null });
  add('temporary_moderator', 'construct', {});
  add('temporary_moderator', 'construct', { ...temp, channelID: '' });
  add('temporary_moderator', 'construct', { ...temp, durationDays: '' });
  add('temporary_moderator', 'construct', { ...temp, expireTimestamp: 'bad' });
  add('temporary_moderator', 'construct', { ...temp, _id: ID });
  add('temporary_moderator', 'construct', { ...temp, _id: null });
  add('temporary_moderator', 'construct', temp, EARLIER);
  add('temporary_moderator', 'insert', temp);
  add('temporary_moderator', 'save', temp);

  const vip = {
    username: 'viewer',
    userID: 'user',
    channel: 'channel',
    channelID: 'channel-id',
    duration: 7,
    date: { day: 2, month: 1, year: 2030 },
    expireDate: { day: 3, month: 2, year: 2031 },
    expireTimestamp: { $date: NOW },
  };
  add('vip', 'construct', vip);
  add('vip', 'construct', { ...vip, username: 'Árbol 東京 😀' });
  add('vip', 'construct', { ...vip, vip: false });
  add('vip', 'construct', { ...vip, vip: 'yes', duration: '3' });
  add('vip', 'construct', { ...vip, expireDate: undefined });
  add('vip', 'construct', { ...vip, expireDate: {} });
  add('vip', 'construct', { ...vip, expireDate: { day: '2', month: '3', year: '4' } });
  add('vip', 'construct', { ...vip, username: null });
  add('vip', 'construct', { ...vip, date: null });
  add('vip', 'construct', { ...vip, extra: 1 });
  add('vip', 'insert', vip);
  add('vip', 'save', vip);

  const title = { channelID: 'channel-id', channel: 'channel' };
  add('titleConfig', 'construct', title);
  add('titleConfig', 'construct', { ...title, pretitle: 'Árbol', posttitle: '東京 😀' });
  add('titleConfig', 'construct', { ...title, active: false });
  add('titleConfig', 'construct', { ...title, active: 'yes' });
  add('titleConfig', 'construct', { ...title, active: 'maybe' });
  add('titleConfig', 'construct', { ...title, channelID: '' });
  add('titleConfig', 'construct', { ...title, pretitle: null });
  add('titleConfig', 'construct', { ...title, extra: true });
  add('titleConfig', 'insert', title);
  add('titleConfig', 'save', title);

  const trigger = {
    name: 'clip',
    fileName: 'clip.mp4',
    fileSize: 12,
    fileType: 'video/mp4',
    fileUrl: 'https://example.invalid/clip.mp4',
    channel: 'channel',
    channelID: 'channel-id',
    date: { day: 4, month: 5, year: 2030 },
  };
  add('TriggerFile', 'construct', trigger);
  add('TriggerFile', 'construct', { ...trigger, name: 'Árbol 東京 😀' });
  add('TriggerFile', 'construct', { ...trigger, fileSize: '12' });
  add('TriggerFile', 'construct', { ...trigger, fileSize: 2147483647 });
  add('TriggerFile', 'construct', { ...trigger, fileSize: 2147483648 });
  add('TriggerFile', 'construct', { ...trigger, fileSize: 1.5 });
  add('TriggerFile', 'construct', { ...trigger, fileSize: { $double: '-0' } });
  add('TriggerFile', 'construct', { ...trigger, createdAt: { $date: EARLIER } });
  add('TriggerFile', 'construct', {});
  add('TriggerFile', 'construct', { ...trigger, fileUrl: null });
  add('TriggerFile', 'insert', trigger);
  add('TriggerFile', 'save', trigger);

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
  add('eventsub', 'construct', eventsub);
  add('eventsub', 'construct', { ...eventsub, condition: {}, transport: {} });
  add('eventsub', 'construct', {
    ...eventsub,
    cheerTiers: [{ id: 'tier', name: 'cheer', message: 'Árbol 東京 😀', min_amount: 1, max_amount: 10 }, {}],
  });
  add('eventsub', 'construct', { ...eventsub, message: 'Árbol 東京 😀', enabled: false, endEnabled: true, todayFollows: true });
  add('eventsub', 'construct', {
    ...eventsub,
    condition: { broadcaster_user_id: 'broadcaster', extra: 'kept', empty: {} },
  });
  add('eventsub', 'construct', { ...eventsub, remote_missing_since: { $date: EARLIER }, cost: '2' });
  add('eventsub', 'construct', { ...eventsub, id: null });
  add('eventsub', 'construct', { ...eventsub, cheerTiers: null });
  add('eventsub', 'construct', { ...eventsub, transport: 'webhook' });
  add('eventsub', 'insert', eventsub);
  add('eventsub', 'save', eventsub);

  add('site_analytics', 'construct', {});
  add('site_analytics', 'construct', { singletonKey: 'other', registeredUsers: 4, liveUsers: '5' });
  add('site_analytics', 'construct', {
    liveChannels: [{
      channelID: 'channel-id',
      channel: 'channel',
      streamId: 'stream',
      title: 'Árbol 東京 😀',
      gameName: 'game',
      viewers: 9,
      profileImageUrl: 'https://example.invalid/a.png',
      startedAt: '2030-03-17T00:00:00Z',
      fetchedAt: '2030-03-17T00:00:01Z',
      botPlatforms: ['twitch', 'kick'],
      planTier: 'pro',
    }],
  });
  add('site_analytics', 'construct', { liveChannels: [{ botPlatforms: 'twitch', viewers: '4', planTier: 'premium' }] });
  add('site_analytics', 'construct', { liveChannels: [{ botPlatforms: ['youtube'] }] });
  add('site_analytics', 'construct', { liveChannels: [{ planTier: 'diamond' }] });
  add('site_analytics', 'construct', { liveChannels: [{ streamId: null }] });
  add('site_analytics', 'construct', { liveChannels: null });
  add('site_analytics', 'construct', { extra: 1 });
  add('site_analytics', 'insert', {});
  add('site_analytics', 'insert', { created_at: { $date: EARLIER } });
  add('site_analytics', 'insert', { created_at: null });
  add('site_analytics', 'save', { registeredUsers: 4, created_at: { $date: EARLIER } });
  for (const item of cases) {
    item.expected = await runCase(bundle, item.model, item.operation, item.input, item.now);
  }
  return cases;
}

function arrayIndependent(models) {
  current = NOW;
  const input = {
    id: 'sub-1',
    status: 'enabled',
    type: 'channel.follow',
    version: '1',
    condition: { broadcaster_user_id: 'broadcaster' },
    created_at: 'stamp',
    transport: { method: 'webhook', callback: 'https://example.invalid/hook' },
    cost: 0,
    channel: 'channel',
    channelID: 'channel-id',
  };
  const first = new models.eventsub(input);
  const second = new models.eventsub(input);
  first.cheerTiers.push({ id: 'x' });
  const siteA = new models.site_analytics({});
  const siteB = new models.site_analytics({});
  siteA.liveChannels.push({ channelID: 'x' });
  return second.cheerTiers.length === 0 && siteB.liveChannels.length === 0 && first.cheerTiers !== second.cheerTiers;
}

function sourceRoot() {
  const rootArg = process.env.DIMA_ORDINARY_SCHEMA_SOURCE_ROOT;
  assert(rootArg && path.isAbsolute(rootArg));
  const root = fs.realpathSync(rootArg);
  assert.equal(root, rootArg);
  return root;
}

if (process.argv[2] === '--tz-child') {
  assert.equal(process.env.DIMA_ORDINARY_SCHEMA_TZ_CHILD, '1');
  assert(ZONES.includes(process.env.TZ), process.env.TZ);
  const root = sourceRoot();
  const tools = assertPins(root);
  const bundle = compileAll(root, tools);
  const vipMonth = String(bundle.models.vip.schema.path('date.month').options.default);
  const triggerMonth = String(bundle.models.TriggerFile.schema.path('date.month').options.default);
  assert.match(vipMonth, /getMonth\(\)/);
  assert.doesNotMatch(vipMonth, /getMonth\(\)\s*\+\s*1/);
  assert.match(triggerMonth, /getMonth\(\)\s*\+\s*1/);
  process.stdout.write(JSON.stringify({
    tz: process.env.TZ,
    cases: INSTANTS.map((instant) => calendarCase(bundle.models, instant)),
  }));
  process.exit(0);
}

(async () => {
assert.notEqual(process.env.DIMA_ORDINARY_SCHEMA_TZ_CHILD, '1');
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dirArg && extra.length === 0 && path.isAbsolute(dirArg));
const dir = fs.realpathSync(dirArg);
assert.equal(dir, dirArg);
const root = sourceRoot();
const workspace = path.dirname(root);
assert(dir !== root && !dir.startsWith(root + path.sep));
assert(dir !== workspace && !dir.startsWith(workspace + path.sep));
const artifact = 'ordinary-application-schemas-reference.json';
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [artifact]);
if (mode === '--check') assert(fs.lstatSync(path.join(dir, artifact)).isFile());
const tools = assertPins(root);
const bundle = compileAll(root, tools);
const vipSource = resolveSource(root, 'src/schemas/vip.schema.ts').bytes.toString('utf8');
const triggerSource = resolveSource(root, 'src/schemas/trigger_file.schema.ts').bytes.toString('utf8');
const monthExcerpts = {
  vip: 'month: { type: Number, default: () => new Date().getMonth() }',
  TriggerFile: 'month: { type: Number, default: () => new Date().getMonth() + 1 }',
};
assert(vipSource.includes(monthExcerpts.vip));
assert(triggerSource.includes(monthExcerpts.TriggerFile));
assert.equal(arrayIndependent(bundle.models), true);
for (const indexes of Object.values(Object.fromEntries(SOURCES.map(([name]) => [name, indexView(bundle.models[name])])))) {
  assert(indexes.every((index) => index.ttl == null));
}
const calendarCases = {};
for (const zone of ZONES) {
  const child = spawnSync(process.execPath, [__filename, '--tz-child'], {
    env: { ...process.env, TZ: zone, DIMA_ORDINARY_SCHEMA_TZ_CHILD: '1' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.tz, zone);
  assert.equal(parsed.cases.length, INSTANTS.length);
  for (const item of parsed.cases) {
    assert.equal(item.trigger.month, item.vip.month + 1);
    assert.equal(item.trigger.day, item.vip.day);
    assert.equal(item.trigger.year, item.vip.year);
    assert.equal(item.createdAt, item.instant);
  }
  calendarCases[zone] = parsed.cases;
}
const read = (file) => SOURCES.some(([,source])=>source===file) ? resolveSource(root,file).bytes : fs.readFileSync(path.join(root, file));
const sourceSha256 = {};
for (const file of [
  ...SOURCES.map(([, file]) => file),
  ...NATIVE_FILES,
  ...PACKAGE_FILES,
]) sourceSha256[file] = sha(read(file));
const output = {
  format: 1,
  versions: {
    node: process.versions.node,
    v8: process.versions.v8,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
    typescript: tools.ts.version,
    mongoose: tools.mongoose.version,
    bson: '6.10.4',
  },
  nodeExecutableSha256: NODE_PIN,
  sourceSha256,
  sourceProvenance: Object.fromEntries(SOURCES.map(([, file]) => [file, resolveSource(root, file).provenance])),
  compiledSha256: bundle.compiled,
  zones: ZONES,
  instants: INSTANTS,
  monthExcerpts,
  monthDefaults: {
    vip: String(bundle.models.vip.schema.path('date.month').options.default),
    TriggerFile: String(bundle.models.TriggerFile.schema.path('date.month').options.default),
  },
  arrayIndependent: true,
  models: Object.fromEntries(SOURCES.map(([name]) => [name, bundle.models[name].modelName])),
  collections: Object.fromEntries(SOURCES.map(([name]) => [name, bundle.models[name].collection.name])),
  exports: Object.fromEntries(SOURCES.map(([name]) => [name, bundle.evidence[name].exports])),
  typeEvidence: bundle.evidence,
  paths: Object.fromEntries(SOURCES.map(([name]) => [name, Object.fromEntries(Object.entries(bundle.models[name].schema.paths).map(([key, schemaPath]) => [key, describePath(schemaPath)]))])),
  indexes: Object.fromEntries(SOURCES.map(([name]) => [name, indexView(bundle.models[name])])),
  timestamps: Object.fromEntries(SOURCES.map(([name]) => [name, bundle.models[name].schema.options.timestamps || false])),
  calendarCases,
  cases: await buildCases(bundle),
  wire: (() => {
    const boundary = { text: '\ud800x\udc00', nested: { n: 1, fraction: 1.5, wide: 2147483648, maxInt: 2147483647 }, negativeZero: -0 };
    const encoded = bundle.bson.serialize(boundary);
    const decoded = bundle.bson.deserialize(encoded, { promoteValues: false });
    return {
      hex: encoded.toString('hex'),
      text: decoded.text,
      types: {
        n: decoded.nested.n._bsontype,
        fraction: decoded.nested.fraction._bsontype,
        wide: decoded.nested.wide._bsontype,
        maxInt: decoded.nested.maxInt._bsontype,
        negativeZero: decoded.negativeZero._bsontype,
      },
    };
  })(),
};
const body = `${JSON.stringify(output, null, 2)}\n`;
const target = path.join(dir, artifact);
if (mode === '--write') fs.writeFileSync(target, body, { flag: 'wx' });
else assert.equal(fs.readFileSync(target, 'utf8'), body);
console.log(`${artifact} sha256=${sha(body)} cases=${output.cases.length}`);

})().catch(error => { console.error(error); process.exitCode = 1; });
