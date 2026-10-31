'use strict';
// AUTHOR ONLY. Executes the actual slice-4a TypeScript sources against the
// pinned installed Mongoose with every collection call replaced by a recorder.
// The recorded filter/update/options documents are the exact documents the
// source hands to the driver; the recorded outputs are JSON.stringify of the
// source's own result. No database is touched: connect/createConnection/openUri
// and every socket, DNS, HTTP and fetch entry point are replaced with a
// throwing guard, so this file cannot reach a live service, credential or
// network. Only the driver boundary is doubled; everything else is real source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode), 'usage: --write <dir> | --check <dir>');
assert(typeof directory === 'string' && path.isAbsolute(directory) && !extra.length, 'absolute directory only');

const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const repo = fs.realpathSync(path.join(root, '..'));
const output = fs.realpathSync(directory);
assert(fs.statSync(output).isDirectory(), 'output must be an existing directory');
assert(output !== repo && !output.startsWith(repo + path.sep), 'external directory only');
if (mode === '--write') assert.deepEqual(fs.readdirSync(output), [], 'exclusive empty output directory');

const NAME = 'stream-timeline-data-reference.json';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file));
const text = file => read(file).toString('utf8');

// ---------------------------------------------------------------------------
// Pinned inputs
// ---------------------------------------------------------------------------
const PINS = {
  'src/utils/stream_activity.ts': '8f4ee872e777eb41979052d3be838c5ad353fd8ce45af18478d4e9d699e97a09',
  'src/utils/stream_timeline.ts': '3ba05d66bc26438c507501706e1d7633c4cd1c8bc3b74322cf353c07632f060d',
  'src/schemas/stream_activity.schema.ts': 'd45de640b797491417845f1918b2ef7cb3d67ddb3836e1c8685f87322a9fb287',
  'src/schemas/stream_timeline.schema.ts': 'd677d8e525466b4e30df8341176ca40a09490adb9e315c17a71c8de1541ba347',
  'src/schemas/stream_session.schema.ts': 'd0394d2fb7ba43b1a90758d4fa1ac4849ea15f6410c9a18e28e687f97ad81026',
  'src/schemas/stream_viewer_snapshot.schema.ts': '8e03cbb6c859709405f4c02d4ed57fb8f6ee81a0af3241b3a6dc3d846344f862',
  'src/schemas/domain_event.schema.ts': 'b73e7918e8cb43dc8bff85b8bab082a875de9b61b45852f7f8acf34ace593d25',
  'package.json': 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json': 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'rust-toolchain.toml': 'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  'node_modules/typescript/lib/typescript.js': '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/typescript/package.json': '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/mongoose/package.json': '5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba'
};
for (const [file, digest] of Object.entries(PINS)) assert.equal(sha(read(file)), digest, `pinned input ${file}`);

assert.equal(process.version, 'v24.22.1', 'pinned Node runtime');
assert.equal(process.versions.v8, '13.6.233.17-node.58', 'pinned V8');
assert.equal(sha(fs.readFileSync(process.execPath)), '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108', 'pinned Node executable');

const req = createRequire(path.join(root, 'package.json'));
const ts = req('typescript');
assert.equal(ts.version, '5.9.3', 'pinned TypeScript');

function packageOf(name, resolver) {
  const entry = resolver.resolve(name);
  let folder = path.dirname(entry);
  while (!fs.existsSync(path.join(folder, 'package.json'))) {
    const parent = path.dirname(folder);
    assert.notEqual(parent, folder, `package root for ${name}`);
    folder = parent;
  }
  const file = path.join(folder, 'package.json');
  return { file, relative: path.relative(root, file), data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const typeScriptPackage = packageOf('typescript', req);
const mongoosePackage = packageOf('mongoose', req);
assert.equal(mongoosePackage.data.version, '8.24.2', 'pinned Mongoose');

// ---------------------------------------------------------------------------
// Offline guards
// ---------------------------------------------------------------------------
const violations = [];
const forbidden = () => {
  violations.push('network');
  throw new Error('offline oracle forbids network');
};
require('node:net').Socket.prototype.connect = forbidden;
for (const key of ['connect', 'createConnection']) require('node:net')[key] = forbidden;
require('node:tls').connect = forbidden;
for (const name of ['node:http', 'node:https']) for (const key of ['request', 'get']) require(name)[key] = forbidden;
for (const name of ['node:dns', 'node:dns/promises']) for (const key of Object.keys(require(name))) if (/^(lookup|resolve|reverse)/.test(key)) require(name)[key] = forbidden;
globalThis.fetch = forbidden;

const pkg = req('mongoose');
const instance = new pkg.Mongoose();
instance.set('autoCreate', false);
instance.set('autoIndex', false);
instance.set('bufferCommands', false);
for (const owner of [pkg, instance]) {
  owner.connect = forbidden;
  owner.createConnection = forbidden;
  owner.Connection.prototype.openUri = forbidden;
}
instance.mongo.MongoClient.connect = forbidden;
instance.mongo.MongoClient.prototype.connect = forbidden;
const BSON = instance.mongo.BSON;
const NativeDate = Date;

// The driver's own BSON options: undefined is not silently dropped.
const mongooseRequire = createRequire(req.resolve('mongoose'));
const driverEntry = mongooseRequire.resolve('mongodb');
const { resolveBSONOptions } = mongooseRequire(path.join(path.dirname(driverEntry), 'bson.js'));
const driverBsonOptions = resolveBSONOptions({});
assert.equal(driverBsonOptions.ignoreUndefined, false, 'driver default keeps undefined distinct');
const bsonPackage = packageOf('bson', mongooseRequire);
assert.equal(bsonPackage.data.version, '6.10.4', 'pinned BSON writer');

// ---------------------------------------------------------------------------
// Pinned clock
// ---------------------------------------------------------------------------
let appNow = 0;
let middlewareNow = 0;
class FixtureDate extends NativeDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(appNow);
  }
  static now() {
    return appNow;
  }
  static [Symbol.hasInstance](value) {
    return value instanceof NativeDate;
  }
}
// Mongoose clone() branches on constructor.name; keep the native Date contract.
Object.defineProperty(FixtureDate, 'name', { value: 'Date' });
instance.now = () => new NativeDate(middlewareNow);

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------
const FILES = {
  activity: 'src/schemas/stream_activity.schema.ts',
  session: 'src/schemas/stream_session.schema.ts',
  snapshot: 'src/schemas/stream_viewer_snapshot.schema.ts',
  timeline: 'src/schemas/stream_timeline.schema.ts',
  domain: 'src/schemas/domain_event.schema.ts',
  activitySource: 'src/utils/stream_activity.ts',
  timelineSource: 'src/utils/stream_timeline.ts'
};
const IMPORTS = {
  [FILES.activitySource]: {
    '../schemas/stream_activity.schema.js': FILES.activity,
    '../schemas/stream_session.schema.js': FILES.session
  },
  [FILES.timelineSource]: {
    '../schemas/stream_session.schema.js': FILES.session,
    '../schemas/stream_viewer_snapshot.schema.js': FILES.snapshot,
    '../schemas/stream_timeline.schema.js': FILES.timeline,
    '../schemas/domain_event.schema.js': FILES.domain,
    './stream_activity.js': FILES.activitySource
  }
};
const loaded = new Map();
const compiledHashes = {};
function compile(file) {
  const compiled = ts.transpileModule(text(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
  });
  assert.deepEqual(compiled.diagnostics ?? [], [], `${file}: transpile diagnostics`);
  compiledHashes[file] = sha(compiled.outputText);
  return compiled.outputText;
}
function load(file) {
  if (loaded.has(file)) return loaded.get(file);
  const module = { exports: {} };
  const imports = IMPORTS[file] ?? {};
  const requireShim = id => {
    if (id === 'mongoose') {
      return { Schema: instance.Schema, model: instance.model.bind(instance), Types: instance.Types };
    }
    if (id.startsWith('node:')) return require(id);
    assert(Object.hasOwn(imports, id), `${file}: unexpected import ${id}`);
    return load(imports[id]);
  };
  const script = new vm.Script(`(function (exports, require, module, Date) {${compile(file)}\n})`, { filename: file });
  script.runInThisContext()(module.exports, requireShim, module, FixtureDate);
  loaded.set(file, module.exports);
  return module.exports;
}

const modules = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, load(file)]));
const models = {
  activity: modules.activity.StreamActivitySchema,
  aggregate: modules.activity.StreamActivityAggregateSchema,
  state: modules.activity.StreamActivityStateSchema,
  session: modules.session.StreamSessionSchema,
  snapshot: modules.snapshot.StreamViewerSnapshotSchema,
  participant: modules.timeline.StreamParticipantSchema,
  marker: modules.timeline.StreamMarkerSchema,
  domain: modules.domain.DomainEventSchema
};
assert.equal(models.activity.collection.collectionName, 'stream_activities');
assert.equal(models.aggregate.collection.collectionName, 'stream_activity_aggregates');
assert.equal(models.session.collection.collectionName, 'streamsessions');
assert.equal(models.snapshot.collection.collectionName, 'streamviewersnapshots');
assert.equal(models.participant.collection.collectionName, 'stream_participants');
assert.equal(models.marker.collection.collectionName, 'stream_markers');
assert.equal(models.domain.collection.collectionName, 'domain_events');
assert.equal(models.session.schema.path('updated_at').instance, 'Date', 'session timestamps are enabled');
assert.equal(models.session.schema.path('created_at').instance, 'Date', 'session timestamps are enabled');

const streamActivity = modules.activitySource;
const streamTimeline = modules.timelineSource;

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------
let calls = [];
let expectedRoles = [];
let expectedSites = {};
let results = {};

// Roles are derived from the cast filter, never from call order: Mongoose may
// schedule the five read queries independently. Ordering that matters (receipt
// before coverage, marker before activity) is asserted from `calls` instead.
const ROLE_BY_TARGET = {
  stream_activity_aggregates: (method, filter) => {
    if (method === 'findOne') return 'aggregate.summary';
    if (filter.scope === 'chart') return 'aggregate.series';
    if (filter.kind === 'command') return 'aggregate.commands';
    if (filter.kind === 'emote') return 'aggregate.emotes';
    return 'aggregate.unknown';
  },
  stream_activities: method => (method === 'findOne' ? 'activity.pending' : 'activity.updateOne'),
  streamsessions: method => (method === 'findOne' ? 'session.findOne' : method === 'find' ? 'stream.find' : 'session.updateOne'),
  stream_participants: method => (method === 'find' ? 'participant.find' : 'participant.updateOne'),
  stream_markers: method => (method === 'find' ? 'marker.find' : 'marker.updateOne'),
  streamviewersnapshots: () => 'snapshot.find',
  domain_events: () => 'raid.find'
};
function roleFor(target, method, filter) {
  const resolve = ROLE_BY_TARGET[target];
  assert(resolve, `unmapped collection ${target}`);
  const role = resolve(method, filter ?? {});
  assert.notEqual(role, 'aggregate.unknown', `unclassified aggregate query on ${target}`);
  const site = `${target}.${method}`;
  if (expectedSites[role]) assert.equal(expectedSites[role], site, `role ${role} site`);
  return role;
}
function expectRoles(entries) {
  expectedRoles = [];
  expectedSites = {};
  for (const entry of entries) {
    const index = entry.indexOf('@');
    const role = index > 0 ? entry.slice(0, index) : entry;
    expectedRoles.push(role);
    if (index > 0) expectedSites[role] = entry.slice(index + 1);
  }
}

function assertNoUndefined(value, where) {
  if (value === undefined) throw new Error(`undefined value at ${where}`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${where}[${index}]`));
    return;
  }
  if (value && typeof value === 'object' && !(value instanceof NativeDate)
    && typeof value._bsontype !== 'string' && !Buffer.isBuffer(value)) {
    for (const key of Object.keys(value)) assertNoUndefined(value[key], `${where}.${key}`);
  }
}
function hexDocument(value, where) {
  assertNoUndefined(value, where);
  return BSON.serialize(value, driverBsonOptions).toString('hex');
}
function without(value, ...keys) {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
function reply(role) {
  const configured = results[role];
  if (configured && configured.throws) throw configured.throws;
  return configured;
}
function installStubs() {
  for (const model of Object.values(models)) {
    const collection = model.collection;
    const target = collection.collectionName;
    collection.updateOne = async (filter, update, options) => {
      const role = roleFor(target, 'updateOne', filter);
      calls.push({
        role,
        target,
        method: 'updateOne',
        filterHex: hexDocument(filter, `${role}.filter`),
        updateHex: hexDocument(update, `${role}.update`),
        optionsHex: hexDocument(options ?? {}, `${role}.options`)
      });
      reply(role);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    };
    collection.findOne = async (filter, options) => {
      const role = roleFor(target, 'findOne', filter);
      const configured = reply(role);
      const document = configured?.document ?? null;
      calls.push({
        role,
        target,
        method: 'findOne',
        filterHex: hexDocument(filter, `${role}.filter`),
        optionsHex: hexDocument(options ?? {}, `${role}.options`),
        docHex: document === null ? null : hexDocument(document, `${role}.document`)
      });
      return document;
    };
    collection.find = (filter, options) => {
      const role = roleFor(target, 'find', filter);
      const configured = reply(role);
      const documents = configured?.documents ?? [];
      calls.push({
        role,
        target,
        method: 'find',
        filterHex: hexDocument(filter, `${role}.filter`),
        optionsHex: hexDocument(options ?? {}, `${role}.options`),
        docsHex: documents.map((document, index) => hexDocument(document, `${role}.documents[${index}]`))
      });
      return { toArray: async () => documents };
    };
  }
}

// ---------------------------------------------------------------------------
// Recorded values
// ---------------------------------------------------------------------------
function describe(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return { $javascriptNumber: '-0' };
    if (!Number.isFinite(value)) return { $javascriptNumber: String(value) };
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof NativeDate) return value.toISOString();
  if (typeof value === 'object' && typeof value._bsontype === 'string') return String(value);
  if (Array.isArray(value)) return value.map(describe);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const item = describe(value[key]);
      if (item !== null || value[key] === null) out[key] = item;
    }
    return out;
  }
  return String(value);
}

const NOW = 1_800_000_000_000;
const RETENTION = 90 * 86_400_000;
const SESSION_ID = '507f1f77bcf86cd799439011';
const CHANNEL = 'channel-1';
const STARTED = NOW - 1_500;

const cases = [];

async function main() {
  async function scenario(name, kind, subject, options) {
    const { run, roles = [], configured = {}, now = NOW, middlewareNow: stamp = now, input = null } = options;
    assert(!cases.some(entry => entry.name === name), `duplicate case ${name}`);
    appNow = now;
    middlewareNow = stamp;
    calls = [];
    expectRoles(roles);
    results = configured;
    installStubs();
    let outcome;
    let value;
    try {
      value = await run();
      outcome = { status: 'resolved' };
    } catch (error) {
      outcome = {
        status: 'rejected',
        error: {
          name: error && typeof error.name === 'string' ? error.name : null,
          code: error && typeof error.code === 'number' ? error.code : null,
          message: String((error && error.message) || '').slice(0, 200)
        }
      };
    }
    assert.deepEqual(calls.map(call => call.role).sort(), expectedRoles.slice().sort(), `${name}: recorded calls`);
    cases.push({
      name,
      kind,
      now,
      middlewareNow: stamp,
      input: describe(input),
      subject,
      calls,
      outcome,
      output: value === undefined || value === null ? null : JSON.stringify(value)
    });
  }

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------
  const sessionDoc = () => ({ _id: new BSON.ObjectId(SESSION_ID), started_at: new NativeDate(STARTED) });
  const sessionSubject = () => hexDocument(sessionDoc(), 'subject.session');
  const failure = (name, code, message) => {
    const error = new Error(message);
    error.name = name;
    if (code !== undefined) error.code = code;
    return error;
  };
  const capture = (patch = {}) => ({
    channelID: CHANNEL,
    eventID: 'event-1',
    kind: 'message',
    occurredAt: new NativeDate(NOW),
    session: sessionDoc(),
    ...patch
  });
  const captureSubject = input => ({
    sessionHex: input.session ? hexDocument(input.session, 'subject.session') : sessionSubject(),
    occurredAtMs: input.occurredAt.getTime(),
    now: NOW
  });

  // --- capture -------------------------------------------------------------
  const captureCases = [
    ['capture-message', capture({ actor: 'actor-1', actorLabel: 'Actor One', emotes: [{ key: 'twitch:25', label: 'Kappa', count: 2 }] })],
    ['capture-command-error', capture({ eventID: 'event-2', kind: 'command', actor: 'actor-1', actorLabel: 'Actor One', key: 'ping', label: '!ping', outcome: 'error' })],
    ['capture-defaults-omitted-optionals', capture({ channelID: 'channel-2', eventID: 'event-3', kind: 'follow' })],
    ['capture-negative-zero-value', capture({ eventID: 'event-4', kind: 'bits', value: -0 })],
    ['capture-fraction-value', capture({ eventID: 'event-5', kind: 'raid', value: 2.5 })],
    ['capture-utf16-bounds', capture({
      eventID: 'event-6',
      actor: 'a'.repeat(60) + '😀bbbb',
      actorLabel: 'b'.repeat(80),
      key: 'k'.repeat(120),
      label: 'l'.repeat(120)
    })],
    ['capture-future-boundary', capture({ eventID: 'event-7', occurredAt: new NativeDate(NOW + 60_000) })]
  ];
  for (const [name, input] of captureCases) {
    await scenario(name, 'capture', captureSubject(input), {
      input,
      roles: [`activity.updateOne@stream_activities.updateOne`],
      run: () => streamActivity.captureStreamActivity(input)
    });
  }

  await scenario('capture-duplicate-11000-swallowed', 'capture', captureSubject(capture()), {
    input: capture({ eventID: 'event-8' }),
    roles: [`activity.updateOne@stream_activities.updateOne`],
    configured: { 'activity.updateOne': { throws: failure('MongoServerError', 11000, 'E11000 duplicate key error') } },
    run: () => streamActivity.captureStreamActivity(capture({ eventID: 'event-8' }))
  });

  await scenario('capture-duplicate-message-only-rejected', 'capture', captureSubject(capture()), {
    input: capture({ eventID: 'event-9' }),
    roles: [`activity.updateOne@stream_activities.updateOne`],
    configured: { 'activity.updateOne': { throws: failure('MongoServerError', undefined, 'E11000 duplicate key error collection: db.stream_activities') } },
    run: () => streamActivity.captureStreamActivity(capture({ eventID: 'event-9' }))
  });

  await scenario('capture-other-code-rejected', 'capture', captureSubject(capture()), {
    input: capture({ eventID: 'event-10' }),
    roles: [`activity.updateOne@stream_activities.updateOne`],
    configured: { 'activity.updateOne': { throws: failure('MongoServerError', 121, 'Document failed validation') } },
    run: () => streamActivity.captureStreamActivity(capture({ eventID: 'event-10' }))
  });

  const skipped = [
    ['capture-empty-event-id', capture({ eventID: '' })],
    ['capture-empty-channel', capture({ channelID: '' })],
    ['capture-stale', capture({ occurredAt: new NativeDate(NOW - RETENTION - 1) })],
    ['capture-future-past-window', capture({ occurredAt: new NativeDate(NOW + 60_001) })],
    ['capture-session-before-start', capture({ session: { _id: new BSON.ObjectId(SESSION_ID), started_at: new NativeDate(NOW + 1) } })]
  ];
  for (const [name, input] of skipped) {
    await scenario(name, 'capture', captureSubject(input), {
      input,
      roles: [],
      run: () => streamActivity.captureStreamActivity(input)
    });
  }

  await scenario('capture-session-lookup', 'capture', captureSubject(capture()), {
    input: capture({ eventID: 'event-11', session: undefined }),
    roles: [`session.findOne@streamsessions.findOne`, `activity.updateOne@stream_activities.updateOne`],
    configured: { 'session.findOne': { document: sessionDoc() } },
    run: () => streamActivity.captureStreamActivity(capture({ eventID: 'event-11', session: undefined }))
  });

  await scenario('capture-session-lookup-missing', 'capture', captureSubject(capture()), {
    input: capture({ eventID: 'event-12', session: undefined }),
    roles: [`session.findOne@streamsessions.findOne`],
    configured: { 'session.findOne': { document: null } },
    run: () => streamActivity.captureStreamActivity(capture({ eventID: 'event-12', session: undefined }))
  });

  await scenario('capture-session-lookup-before-start', 'capture', captureSubject(capture()), {
    input: capture({ eventID: 'event-13', session: undefined }),
    roles: [`session.findOne@streamsessions.findOne`],
    configured: { 'session.findOne': { document: { _id: new BSON.ObjectId(SESSION_ID), started_at: new NativeDate(NOW + 1) } } },
    run: () => streamActivity.captureStreamActivity(capture({ eventID: 'event-13', session: undefined }))
  });

  // --- participant receipts -------------------------------------------------
  const participantSubject = (patch = {}) => ({
    channelId: CHANNEL,
    sessionHex: sessionSubject(),
    sessionIdHex: SESSION_ID,
    startedMs: STARTED,
    atMs: NOW,
    now: NOW,
    middlewareNow: NOW + 11,
    userId: 'user-1',
    ...patch
  });
  const participant = (patch = {}) => ({
    channelID: CHANNEL,
    sessionID: new BSON.ObjectId(SESSION_ID),
    startedAt: new NativeDate(STARTED),
    userID: 'user-1',
    at: new NativeDate(NOW),
    ...patch
  });
  const runParticipant = input => streamTimeline.recordTimelineParticipant(input.channelID, input.sessionID, input.startedAt, input.userID, input.at);

  await scenario('participant-receipt', 'participant', participantSubject(), {
    input: participant(),
    middlewareNow: NOW + 11,
    roles: [`participant.updateOne@stream_participants.updateOne`, `session.updateOne@streamsessions.updateOne`],
    run: () => runParticipant(participant())
  });

  await scenario('participant-bot-account-skipped', 'participant', participantSubject({ userId: '698614112' }), {
    input: participant({ userID: '698614112' }),
    roles: [],
    run: () => runParticipant(participant({ userID: '698614112' }))
  });

  await scenario('participant-empty-user-skipped', 'participant', participantSubject({ userId: '' }), {
    input: participant({ userID: '' }),
    roles: [],
    run: () => runParticipant(participant({ userID: '' }))
  });

  await scenario('participant-before-start-skipped', 'participant', participantSubject({ atMs: STARTED - 1 }), {
    input: participant({ at: new NativeDate(STARTED - 1) }),
    roles: [],
    run: () => runParticipant(participant({ at: new NativeDate(STARTED - 1) }))
  });

  await scenario('participant-duplicate-11000-still-publishes-coverage', 'participant', participantSubject(), {
    input: participant(),
    middlewareNow: NOW + 11,
    roles: [`participant.updateOne@stream_participants.updateOne`, `session.updateOne@streamsessions.updateOne`],
    configured: { 'participant.updateOne': { throws: failure('MongoServerError', 11000, 'E11000 duplicate key error') } },
    run: () => runParticipant(participant())
  });

  await scenario('participant-other-error-stops-coverage', 'participant', participantSubject(), {
    input: participant(),
    roles: [`participant.updateOne@stream_participants.updateOne`],
    configured: { 'participant.updateOne': { throws: failure('MongoServerError', 121, 'Document failed validation') } },
    run: () => runParticipant(participant())
  });

  // --- markers --------------------------------------------------------------
  const momentSubject = (patch = {}) => ({ channelId: CHANNEL, sessionHex: sessionSubject(), sessionIdHex: SESSION_ID, atMs: NOW, now: NOW, ...patch });

  await scenario('moment-marker', 'moment', momentSubject(), {
    input: { channelID: CHANNEL, eventID: 'event-moment', kind: 'follow', atMs: NOW, label: 'New follower', value: 1 },
    roles: [`session.findOne@streamsessions.findOne`, `marker.updateOne@stream_markers.updateOne`, `activity.updateOne@stream_activities.updateOne`],
    configured: { 'session.findOne': { document: sessionDoc() } },
    run: () => streamTimeline.recordTimelineMoment({ channelID: CHANNEL, eventID: 'event-moment', kind: 'follow', at: new NativeDate(NOW), label: 'New follower', value: 1 })
  });

  await scenario('moment-marker-without-value', 'moment', momentSubject(), {
    input: { channelID: CHANNEL, eventID: 'event-moment-2', kind: 'raid', atMs: NOW, label: 'Raid', value: null },
    roles: [`session.findOne@streamsessions.findOne`, `marker.updateOne@stream_markers.updateOne`, `activity.updateOne@stream_activities.updateOne`],
    configured: { 'session.findOne': { document: sessionDoc() } },
    run: () => streamTimeline.recordTimelineMoment({ channelID: CHANNEL, eventID: 'event-moment-2', kind: 'raid', at: new NativeDate(NOW), label: 'Raid' })
  });

  const redemption = {
    id: 'redemption-1',
    broadcaster_user_id: CHANNEL,
    redeemed_at: new NativeDate(NOW).toISOString(),
    reward: { id: 'reward-1', title: 'Hydrate', cost: 500 },
    status: 'fulfilled'
  };
  const redemptionSubject = (patch = {}) => ({ channelId: CHANNEL, sessionHex: sessionSubject(), sessionIdHex: SESSION_ID, redeemedAt: redemption.redeemed_at, now: NOW, ...patch });

  await scenario('redemption-marker-and-activity', 'redemption', redemptionSubject(), {
    input: redemption,
    roles: [
      `session.findOne@streamsessions.findOne`,
      `marker.updateOne@stream_markers.updateOne`,
      `session.findOne@streamsessions.findOne`,
      `activity.updateOne@stream_activities.updateOne`
    ],
    configured: { 'session.findOne': { document: sessionDoc() } },
    run: () => streamTimeline.recordTimelineRedemption(redemption)
  });

  await scenario('redemption-without-session', 'redemption', redemptionSubject(), {
    input: redemption,
    roles: [`session.findOne@streamsessions.findOne`],
    configured: { 'session.findOne': { document: null } },
    run: () => streamTimeline.recordTimelineRedemption(redemption)
  });

  await scenario('redemption-empty-id-skipped', 'redemption', redemptionSubject(), {
    input: { ...redemption, id: '' },
    roles: [],
    run: () => streamTimeline.recordTimelineRedemption({ ...redemption, id: '' })
  });

  await scenario('redemption-invalid-date-skipped', 'redemption', redemptionSubject({ redeemedAt: 'not-a-date' }), {
    input: { ...redemption, redeemed_at: 'not-a-date' },
    roles: [],
    run: () => streamTimeline.recordTimelineRedemption({ ...redemption, redeemed_at: 'not-a-date' })
  });

  // --- activity reads -------------------------------------------------------
  const readSubject = (patch = {}) => ({ channelId: CHANNEL, sessionIdHex: SESSION_ID, tier: 'free', now: NOW, ...patch });
  const aggregate = (patch = {}) => ({
    _id: 'aggregate-1',
    channelID: CHANNEL,
    session_id: new BSON.ObjectId(SESSION_ID),
    scope: 'summary',
    kind: '',
    bucket: -1,
    expiresAt: new NativeDate(NOW + RETENTION),
    ...patch
  });
  const summary = (patch = {}) => aggregate({
    messages: 12,
    commands: 3,
    emotes: 4,
    emoteMessages: 2,
    redemptions: 1,
    follows: 1,
    subs: 0,
    bits: 250,
    raids: 0,
    firstAt: new NativeDate(STARTED),
    messageStartedAt: new NativeDate(STARTED + 300),
    updatedAt: new NativeDate(NOW - 1_000),
    ...patch
  });
  const command = (patch = {}) => aggregate({ _id: 'command-1', scope: 'rank', kind: 'command', key: 'ping', label: '!ping', count: 3, failures: 1, ...patch });
  const emote = (patch = {}) => aggregate({ _id: 'emote-1', scope: 'rank', kind: 'emote', key: 'twitch:25', label: 'Kappa', count: 5, messages: 2, ...patch });
  const series = (patch = {}) => aggregate({ _id: 'chart-1', scope: 'chart', bucket: 2, commands: 2, emotes: 1, messages: 7, chatters: 4, ...patch });

  const readRoles = [
    `aggregate.summary@stream_activity_aggregates.findOne`,
    `aggregate.commands@stream_activity_aggregates.find`,
    `aggregate.emotes@stream_activity_aggregates.find`,
    `aggregate.series@stream_activity_aggregates.find`,
    `activity.pending@stream_activities.findOne`
  ];

  await scenario('activity-free', 'read', readSubject(), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'free' },
    roles: readRoles,
    configured: {
      'aggregate.summary': { document: summary() },
      'aggregate.commands': { documents: [command()] },
      'aggregate.emotes': { documents: [emote()] },
      'aggregate.series': { documents: [series()] },
      'activity.pending': { document: { _id: 'activity-1' } }
    },
    run: () => streamActivity.getStreamActivity(CHANNEL, new BSON.ObjectId(SESSION_ID), 'free')
  });

  await scenario('activity-pro', 'read', readSubject({ tier: 'pro' }), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'pro' },
    roles: readRoles,
    configured: {
      'aggregate.summary': { document: summary() },
      'aggregate.commands': { documents: [command(), command({ _id: 'command-2', key: 'roll', label: '!roll', count: 1, failures: 0 })] },
      'aggregate.emotes': { documents: [emote()] },
      'aggregate.series': { documents: [series(), series({ _id: 'chart-2', bucket: 0, commands: 1, emotes: 0, messages: 3, chatters: 2 })] },
      'activity.pending': { document: null }
    },
    run: () => streamActivity.getStreamActivity(CHANNEL, new BSON.ObjectId(SESSION_ID), 'pro')
  });

  await scenario('activity-empty', 'read', readSubject(), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'free' },
    roles: readRoles,
    configured: {
      'aggregate.summary': { document: null },
      'aggregate.commands': { documents: [] },
      'aggregate.emotes': { documents: [] },
      'aggregate.series': { documents: [] },
      'activity.pending': { document: null }
    },
    run: () => streamActivity.getStreamActivity(CHANNEL, new BSON.ObjectId(SESSION_ID), 'free')
  });

  await scenario('activity-partial-summary', 'read', readSubject({ tier: 'premium' }), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'premium' },
    roles: readRoles,
    configured: {
      'aggregate.summary': { document: aggregate({ messages: 4, commands: 0 }) },
      'aggregate.commands': { documents: [without(command(), 'failures')] },
      'aggregate.emotes': { documents: [] },
      'aggregate.series': { documents: [without(series(), 'commands', 'messages')] },
      'activity.pending': { document: null }
    },
    run: () => streamActivity.getStreamActivity(CHANNEL, new BSON.ObjectId(SESSION_ID), 'premium')
  });

  // --- timeline reads -------------------------------------------------------
  const snapshot = (patch = {}) => ({
    _id: new BSON.ObjectId('507f1f77bcf86cd799439021'),
    channelID: CHANNEL,
    session_id: new BSON.ObjectId(SESSION_ID),
    stream_id: 'stream-1',
    captured_at: new NativeDate(STARTED + 600),
    viewers: 120,
    title: 'Title A',
    game_name: 'Game A',
    messages: 10,
    commands: 2,
    ...patch
  });
  const raid = () => ({
    _id: new BSON.ObjectId('507f1f77bcf86cd799439031'),
    eventKey: 'raid-1',
    source: 'twitch-eventsub',
    type: 'channel.raid.received',
    channelID: CHANNEL,
    occurredAt: new NativeDate(STARTED + 700),
    expiresAt: new NativeDate(NOW + RETENTION),
    payload: { event: { from_broadcaster_user_name: 'RaidLeader', from_broadcaster_user_login: 'raidleader', viewers: 42 } }
  });
  const marker = (patch = {}) => ({
    _id: new BSON.ObjectId('507f1f77bcf86cd799439041'),
    channelID: CHANNEL,
    session_id: new BSON.ObjectId(SESSION_ID),
    key: 'redemption:redemption-1',
    kind: 'redemption',
    label: 'Hydrate',
    occurredAt: new NativeDate(STARTED + 800),
    expiresAt: new NativeDate(NOW + RETENTION),
    rewardID: 'reward-1',
    cost: 500,
    status: 'fulfilled',
    ...patch
  });
  const timelineSession = () => ({
    _id: new BSON.ObjectId(SESSION_ID),
    channelID: CHANNEL,
    channel: 'Fixture Streamer',
    stream_id: 'stream-1',
    started_at: new NativeDate(STARTED),
    ended_at: new NativeDate(STARTED + 900_000),
    status: 'offline',
    chat_tracking_started_at: new NativeDate(STARTED),
    peak_viewers: 150,
    messages: 40,
    commands: 9
  });
  const timelineSubject = (patch = {}) => ({
    channelId: CHANNEL,
    sessionIdHex: SESSION_ID,
    sessionHex: hexDocument(timelineSession(), 'subject.session'),
    startedMs: STARTED,
    endedMs: STARTED + 900_000,
    tier: 'pro',
    now: NOW,
    ...patch
  });
  const timelineRoles = [
    `session.findOne@streamsessions.findOne`,
    ...readRoles,
    `snapshot.find@streamviewersnapshots.find`,
    `raid.find@domain_events.find`,
    `marker.find@stream_markers.find`,
    `participant.find@stream_participants.find`
  ];
  const timelineConfigured = {
    'session.findOne': { document: timelineSession() },
    'aggregate.summary': { document: without(summary(), 'messageStartedAt') },
    'aggregate.commands': { documents: [command()] },
    'aggregate.emotes': { documents: [emote()] },
    'aggregate.series': { documents: [series()] },
    'activity.pending': { document: null },
    'snapshot.find': {
      documents: [
        snapshot(),
        snapshot({ _id: new BSON.ObjectId('507f1f77bcf86cd799439022'), captured_at: new NativeDate(STARTED + 1_200), viewers: 160, title: 'Title B', game_name: 'Game B', messages: 30, commands: 5 })
      ]
    },
    'raid.find': { documents: [raid()] },
    'marker.find': {
      documents: [
        marker(),
        without(marker({ _id: new BSON.ObjectId('507f1f77bcf86cd799439042'), key: 'event:raid-1', kind: 'raid', label: 'Raid!', value: 7, occurredAt: new NativeDate(STARTED + 700) }), 'rewardID', 'cost', 'status')
      ]
    },
    'participant.find': { documents: [{ bucket: 0 }, { bucket: 1 }, { bucket: 1 }] }
  };

  await scenario('timeline-full', 'timeline', timelineSubject(), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'pro' },
    roles: timelineRoles,
    configured: timelineConfigured,
    run: () => streamTimeline.getStreamTimeline(CHANNEL, SESSION_ID, 'pro')
  });

  await scenario('timeline-projected-chatters', 'timeline', timelineSubject(), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'pro', projectedChatters: true },
    roles: timelineRoles.filter(role => !role.startsWith('participant.find')),
    configured: {
      ...timelineConfigured,
      'aggregate.summary': { document: summary({ messageStartedAt: new NativeDate(STARTED + 150) }) },
      'aggregate.series': { documents: [series({ chatters: 3 }), series({ _id: 'chart-2', bucket: 1, chatters: 5 })] }
    },
    run: () => streamTimeline.getStreamTimeline(CHANNEL, SESSION_ID, 'pro')
  });

  await scenario('timeline-marker-cursor', 'timeline', timelineSubject({ tier: 'free' }), {
    input: { channelID: CHANNEL, sessionID: SESSION_ID, tier: 'free', markers: 101 },
    roles: timelineRoles,
    configured: {
      ...timelineConfigured,
      'marker.find': {
        documents: Array.from({ length: 101 }, (_, index) => without(marker({
          _id: new BSON.ObjectId(`507f1f77bcf86cd7994391${String(index).padStart(2, '0')}`),
          key: `event:${index}`,
          kind: 'follow',
          label: `Follower ${index}`,
          occurredAt: new NativeDate(NOW + index * 1_000)
        }), 'rewardID', 'cost', 'status'))
      }
    },
    run: () => streamTimeline.getStreamTimeline(CHANNEL, SESSION_ID, 'free')
  });

  // --- session listing and lookup ------------------------------------------
  const streamRow = (patch = {}) => ({
    _id: new BSON.ObjectId('507f1f77bcf86cd799439011'),
    channelID: CHANNEL,
    started_at: new NativeDate(STARTED),
    ended_at: new NativeDate(STARTED + 900_000),
    status: 'offline',
    peak_viewers: 150,
    messages: 40,
    ...patch
  });

  await scenario('streams-page-2', 'streams', { channelId: CHANNEL, page: 2, now: NOW, rows: 21 }, {
    input: { channelID: CHANNEL, page: 2 },
    roles: [`stream.find@streamsessions.find`],
    configured: {
      'stream.find': {
        documents: Array.from({ length: 21 }, (_, index) => streamRow({
          _id: new BSON.ObjectId(`507f1f77bcf86cd7994392${String(index).padStart(2, '0')}`),
          started_at: new NativeDate(STARTED - index * 60_000)
        }))
      }
    },
    run: () => streamTimeline.listTimelineStreams(CHANNEL, 2)
  });

  await scenario('session-lookup', 'session', { channelId: CHANNEL, sessionIdHex: SESSION_ID, now: NOW }, {
    input: { channelID: CHANNEL, sessionID: SESSION_ID },
    roles: [`session.findOne@streamsessions.findOne`],
    configured: { 'session.findOne': { document: timelineSession() } },
    run: () => streamTimeline.getTimelineSession(CHANNEL, SESSION_ID)
  });
}

function metadata() {
  assert(cases.length >= 30, 'case inventory must not shrink');
  assert.equal(new Set(cases.map(entry => entry.name)).size, cases.length, 'unique case names');
  assert.deepEqual(violations, [], 'offline guards untouched');
  const hashes = Object.fromEntries(Object.keys(PINS).map(file => [file, sha(read(file))]));
  hashes['tests/fixtures/stream-timeline-data-reference.cjs'] = sha(fs.readFileSync(__filename));
  return {
    format: 1,
    purpose: 'Recorded slice-4a source documents and outputs. The native data layer is compared against these; it is never generated from them.',
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
    typescript: ts.version,
    mongoose: mongoosePackage.data.version,
    bson: bsonPackage.data.version,
    nodeSha256: sha(fs.readFileSync(process.execPath)),
    driverBsonOptions,
    driverUndefinedProbeHex: BSON.serialize({ value: undefined }, driverBsonOptions).toString('hex'),
    boundary: 'Only collection.updateOne/findOne/find are substituted. Source code, schemas, Mongoose casting, setDefaultsOnInsert, timestamps and output construction are the real source. Object key order inside update/query documents is not semantically meaningful to MongoDB; the native comparison canonicalises it.',
    hashes,
    compiledSha256: compiledHashes,
    packages: {
      typescript: { version: typeScriptPackage.data.version, package: typeScriptPackage.relative, packageSha256: sha(fs.readFileSync(typeScriptPackage.file)) },
      mongoose: { version: mongoosePackage.data.version, package: mongoosePackage.relative, packageSha256: sha(fs.readFileSync(mongoosePackage.file)) },
      bson: { version: bsonPackage.data.version, package: bsonPackage.relative, packageSha256: sha(fs.readFileSync(bsonPackage.file)) }
    },
    caseCount: cases.length
  };
}

main().then(() => {
  const data = JSON.stringify({ metadata: metadata(), cases }, null, 2) + '\n';
  assert(!/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(data), 'fixture must not contain escaped lone surrogates');
  if (mode === '--check') assert.deepEqual(fs.readdirSync(output).sort(), [NAME], 'exclusive exact fixture set');
  const target = path.join(output, NAME);
  if (mode === '--write') fs.writeFileSync(target, data, { flag: 'wx' });
  else assert.equal(fs.readFileSync(target, 'utf8'), data);
  console.log(`${NAME} sha256=${sha(data)} cases=${cases.length}`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
