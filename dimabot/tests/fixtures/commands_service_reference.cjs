'use strict';
// Source oracle for the native `Commands` CRUD/cache service.
//
// It evaluates the complete non-import bodies of the real
// `src/classes/command.class.ts`, the real `src/utils/command_cooldown_write.ts`,
// and the byte-exact retired `src/utils/command_cooldown.ts`. The retired helper
// is supplied by the parent as a temporary, disposable copy outside the source
// tree (`COMMANDS_SERVICE_ARCHIVED_COOLDOWN`); it is never restored into
// `dimabot/src` or committed as a parallel policy fixture. Only the storage
// model, the Dragonfly client, the streamer directory and the logger are
// boundary doubles. The cooldown policy, grandfathering, reserved/zero-slot
// rules, cache keys and response shapes are the source's own code.
//
// Usage: node commands_service_reference.cjs --write DIR | --check DIR
// DIR is a parent-owned artifact directory. The retired helper path comes from
// COMMANDS_SERVICE_ARCHIVED_COOLDOWN (absolute, outside the source tree).
// The parent runs this only with --check against the committed reference JSON.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pins = {
  commandClass: '60d7d36129e28605d18273013fdc1b277f363aadced7fafe68f9bd0d4226371c',
  cooldownWrite: 'efbcf9f1a83b32022b521a46c109acb13b0e4da68cb26970e3d2c15a21d39586',
  cooldownArchive: 'a884a2dfb8072ba1b0419bb3fd90380257c834f8526dd7309ffa67f6489e3a2b'
};
const files = {
  commandClass: path.join(root, 'src/classes/command.class.ts'),
  cooldownWrite: path.join(root, 'src/utils/command_cooldown_write.ts'),
  cooldownArchive: process.env.COMMANDS_SERVICE_ARCHIVED_COOLDOWN
};
assert(
  typeof files.cooldownArchive === 'string' && path.isAbsolute(files.cooldownArchive),
  'COMMANDS_SERVICE_ARCHIVED_COOLDOWN must be an absolute task-owned path'
);
assert(
  !files.cooldownArchive.startsWith(root + path.sep),
  'the retired helper must stay outside the live source tree'
);
const sources = Object.fromEntries(
  Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')])
);
for (const [name, pin] of Object.entries(pins)) {
  assert.equal(sha(sources[name]), pin, `${name} source pin`);
}
assert.equal(ts.version, '5.9.3');

const selectedFields = [
  'name', 'cmd', 'activation', 'keywordSettings', 'func', 'message', 'authoring',
  'responses', 'variables', 'type', 'platform', 'reserved', 'description', 'cooldown',
  'count', 'userLevelName', 'userLevel', 'permissions', 'enabled', 'paused', 'channel',
  'channelID', 'premiumRequired', 'premiumLevelRequired'
];
const selectDoc = value => {
  const output = {};
  for (const field of selectedFields) {
    if (Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined) {
      output[field] = value[field];
    }
  }
  return output;
};
const docKey = value =>
  `${value.cmd ?? ''}|${value.activation ?? ''}|${value.message ?? ''}`;

function parseModule(name, expectedImports) {
  const file = files[name];
  const ast = ts.createSourceFile(file, sources[name], ts.ScriptTarget.ES2022, true);
  assert.deepEqual(ast.parseDiagnostics, [], `${name} parse`);
  const imports = ast.statements
    .filter(ts.isImportDeclaration)
    .map(statement => {
      const clause = statement.importClause;
      const names = clause?.name ? [{name: clause.name.text, typeOnly: false}] : [];
      names.push(
        ...(clause?.namedBindings?.elements ?? []).map(element => ({
          name: element.name.text,
          typeOnly: Boolean(element.isTypeOnly)
        }))
      );
      return {
        module: statement.moduleSpecifier.text,
        typeOnly: Boolean(clause?.isTypeOnly),
        names
      };
    });
  assert.deepEqual(imports, expectedImports, `${name} imports`);
  const body = ast.statements.filter(statement => !ts.isImportDeclaration(statement));
  return {ast, body, text: body.map(statement => statement.getText(ast)).join('\n') + '\n'};
}

const commandModule = parseModule('commandClass', [
  {
    module: '../schemas/commands.schema.js',
    typeOnly: false,
    names: [{name: 'CommandsSchema', typeOnly: false}, {name: 'ICommands', typeOnly: true}]
  },
  {
    module: '../utils/databases/dragonfly.database.js',
    typeOnly: false,
    names: [{name: 'getDragonflyClient', typeOnly: false}]
  },
  {
    module: '../interfaces/commands/command.response.interface.js',
    typeOnly: true,
    names: [
      {name: 'ICommandCreateResponse', typeOnly: false},
      {name: 'ICommandDeleteResponse', typeOnly: false},
      {name: 'ICommandGetResponse', typeOnly: false},
      {name: 'ICommandUpdateResponse', typeOnly: false},
      {name: 'ICommandExistsResponse', typeOnly: false}
    ]
  },
  {
    module: '../utils/command_cooldown_write.js',
    typeOnly: false,
    names: [
      {name: 'writeCommandWithCooldown', typeOnly: false},
      {name: 'CommandCooldownError', typeOnly: false}
    ]
  },
  {
    module: '../utils/logger.js',
    typeOnly: false,
    names: [{name: 'error', typeOnly: false}]
  }
]);
const writeModule = parseModule('cooldownWrite', [
  {
    module: 'node:crypto',
    typeOnly: false,
    names: [{name: 'randomUUID', typeOnly: false}]
  },
  {
    module: '../schemas/commands.schema.js',
    typeOnly: false,
    names: [{name: 'CommandsSchema', typeOnly: false}]
  },
  {
    module: '../classes/twitch_streamers.class.js',
    typeOnly: false,
    names: [{name: 'TwitchStreamers', typeOnly: false}]
  },
  {
    module: './databases/dragonfly.database.js',
    typeOnly: false,
    names: [{name: 'getDragonflyClient', typeOnly: false}]
  },
  {
    module: './command_cooldown.js',
    typeOnly: false,
    names: [{name: 'getMinimumCommandCooldown', typeOnly: false}]
  }
]);
const archiveModule = parseModule('cooldownArchive', []);

const extraction = [archiveModule.text, writeModule.text, commandModule.text].join('\n');
for (const name of [
  'getMinimumCommandCooldown',
  'CommandCooldownError',
  'writeCommandWithCooldown',
  'validateKeywordCooldown',
  'class Commands',
  'export default new Commands()'
]) {
  assert(extraction.includes(name), `extraction must contain ${name}`);
}

const stubs = `
type ICommands = any;
type ICommandCreateResponse = any;
type ICommandDeleteResponse = any;
type ICommandGetResponse = any;
type ICommandUpdateResponse = any;
type ICommandExistsResponse = any;
declare const CommandsSchema: any;
declare const TwitchStreamers: any;
declare function getDragonflyClient(caller: string): Promise<any>;
declare function error(payload: any, options: any): Promise<void>;
declare function randomUUID(): string;
`;
const virtualFile = path.join(root, '__commands_service_oracle__.ts');
const typecheckSource = stubs + extraction;
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ['lib.es2022.d.ts']
};
const host = ts.createCompilerHost(compilerOptions);
const oldRead = host.readFile.bind(host);
const oldExists = host.fileExists.bind(host);
host.readFile = file => (file === virtualFile ? typecheckSource : oldRead(file));
host.fileExists = file => file === virtualFile || oldExists(file);
const program = ts.createProgram([virtualFile], compilerOptions, host);
assert.deepEqual(
  ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  []
);
const transpiled = ts.transpileModule(extraction, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  reportDiagnostics: true
});
assert.deepEqual(transpiled.diagnostics, []);
const compiled = transpiled.outputText;

function makeStorage(fail) {
  const docs = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  let generated = 0;
  const matches = (document, filter) => Object.entries(filter).every(([key, expected]) => {
    if (expected === undefined) return true; // Mongoose omits undefined query paths.
    const actual = document[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) return actual !== expected.$ne;
    }
    return actual === expected;
  });
  class FakeDoc {
    constructor(data) {
      Object.defineProperty(this, '__storage', {value: storage});
      Object.assign(this, data);
    }
    async save() {
      if (fail.save) throw new Error('fixture save failure');
      return storage.write(this);
    }
    async deleteOne() {
      if (fail.deleteOne) throw new Error('fixture delete failure');
      return storage.remove(this._id);
    }
    updateOne(update) {
      // Mongoose returns a thenable Query; the class awaits it in the count and
      // availability paths and calls `.exec()` in the cooldown-write path.
      const run = async () => {
        if (fail.updateOne) throw new Error('fixture update failure');
        return storage.update(this._id, update);
      };
      return {
        exec: run,
        then: (resolve, reject) => run().then(resolve, reject),
        catch: reject => run().catch(reject)
      };
    }
  }
  const storage = {
    write(document) {
      const data = clone({...document});
      if (data._id === undefined) data._id = `generated-${++generated}`;
      docs.set(data._id, data);
      return new FakeDoc(data);
    },
    remove(id) {
      const removed = docs.delete(id);
      return {deletedCount: removed ? 1 : 0};
    },
    update(id, update) {
      const target = docs.get(id);
      if (!target) return {matchedCount: 0, modifiedCount: 0};
      for (const [key, value] of Object.entries(update)) {
        if (key === '$set') Object.assign(target, value);
        else if (key === '$unset') for (const field of Object.keys(value)) delete target[field];
        else if (key === '$inc') for (const [field, amount] of Object.entries(value)) {
          target[field] = (target[field] ?? 0) + amount;
        } else target[key] = value;
      }
      return {matchedCount: 1, modifiedCount: 1};
    },
    findOne(filter) {
      if (fail.findOne) throw new Error('fixture find failure');
      for (const document of docs.values()) {
        if (matches(document, filter)) return new FakeDoc(clone(document));
      }
      return null;
    },
    exists(filter) {
      return this.findOne(filter) !== null;
    },
    list() {
      return [...docs.values()].map(clone);
    }
  };
  class CommandsSchema {
    constructor(data) {
      return new FakeDoc(clone(data));
    }
    static findOne(filter) {
      return storage.findOne(filter);
    }
    static exists(filter) {
      return storage.exists(filter);
    }
  }
  return {storage, CommandsSchema, remove: id => docs.delete(id)};
}

function makeCache(fail, seed) {
  const values = new Map(seed);
  const ttl = new Map();
  const calls = [];
  const client = {
    async get(key) {
      calls.push(['get', key]);
      if (fail.cacheGet) throw new Error('fixture cache get failure');
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value, options) {
      calls.push(['set', key, options?.EX ?? null]);
      if (fail.cacheSet) throw new Error('fixture cache set failure');
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      if (options?.EX) ttl.set(key, options.EX);
      return 'OK';
    },
    async del(key) {
      calls.push(['del', key]);
      if (fail.cacheDel) throw new Error('fixture cache del failure');
      ttl.delete(key);
      return values.delete(key) ? 1 : 0;
    },
    async eval(script, {keys, arguments: args}) {
      calls.push(['eval', keys[0]]);
      if (fail.cacheEval) throw new Error('fixture cache eval failure');
      if (values.get(keys[0]) === args[0]) {
        ttl.delete(keys[0]);
        values.delete(keys[0]);
        return 1;
      }
      return 0;
    }
  };
  return {client, values, ttl, calls};
}

function normalizeResponse(response) {
  const output = {error: response.error};
  for (const key of ['created', 'deleted']) {
    if (response[key] !== undefined) output[key] = response[key];
  }
  if (response.command !== undefined) output.command = selectDoc(response.command);
  output.message = response.message;
  output.status = response.status;
  output.type = response.type;
  return output;
}

const base = (channel, overrides = {}) => ({
  name: 'demo',
  cmd: 'demo',
  activation: 'command',
  func: 'demo',
  message: 'demo message',
  type: 'command',
  platform: 'twitch',
  reserved: false,
  description: 'No description provided.',
  cooldown: 20,
  count: 0,
  userLevelName: 'everyone',
  userLevel: 0,
  enabled: true,
  paused: false,
  channel,
  channelID: channel,
  premiumRequired: false,
  premiumLevelRequired: 0,
  responses: [],
  variables: {},
  ...overrides
});

const cases = [];
const add = (name, channel, values) => cases.push({id: name, channel, ...values});

add('create_and_cache', 'cmd-svc-01', {
  plan: 'pro',
  steps: [{method: 'createCommand', args: ['cmd-svc-01', base('cmd-svc-01', {cmd: 'hello', name: 'hello', func: 'hello', message: 'Hi', cooldown: 10})]}]
});
add('create_duplicate', 'cmd-svc-02', {
  plan: 'pro',
  docs: [base('cmd-svc-02', {_id: '000000000000000000000002', cmd: 'dup'})],
  steps: [{method: 'createCommand', args: ['cmd-svc-02', base('cmd-svc-02', {cmd: 'dup'})]}]
});
add('create_keyword_duplicate_ignored', 'cmd-svc-03', {
  plan: 'pro',
  docs: [base('cmd-svc-03', {_id: '000000000000000000000003', cmd: 'kw', activation: 'keyword'})],
  steps: [{method: 'createCommand', args: ['cmd-svc-03', base('cmd-svc-03', {cmd: 'kw', message: 'editable'})]}]
});
add('create_invalid_cooldown', 'cmd-svc-04', {
  plan: 'premium',
  steps: [{method: 'createCommand', args: ['cmd-svc-04', base('cmd-svc-04', {cmd: 'bad', cooldown: 2})]}]
});
add('create_zero_conflict', 'cmd-svc-05', {
  plan: 'pro',
  docs: [base('cmd-svc-05', {_id: '000000000000000000000005', cmd: 'taken', cooldown: 0})],
  steps: [{method: 'createCommand', args: ['cmd-svc-05', base('cmd-svc-05', {cmd: 'other', cooldown: 0})]}]
});
add('create_zero_reserved_excluded', 'cmd-svc-06', {
  plan: 'pro',
  docs: [base('cmd-svc-06', {_id: '000000000000000000000006', cmd: 'reserved', cooldown: 0, reserved: true})],
  steps: [{method: 'createCommand', args: ['cmd-svc-06', base('cmd-svc-06', {cmd: 'editable', cooldown: 0})]}]
});
add('create_zero_lease_busy', 'cmd-svc-07', {
  plan: 'pro',
  cache: [['command-cooldown-write:cmd-svc-07', 'held-token']],
  steps: [{method: 'createCommand', args: ['cmd-svc-07', base('cmd-svc-07', {cmd: 'blocked', cooldown: 0})]}]
});
add('get_cold_warm_missing', 'cmd-svc-08', {
  plan: 'free',
  docs: [base('cmd-svc-08', {_id: '000000000000000000000008', cmd: 'read', cooldown: 5})],
  steps: [
    {method: 'getCommandFromDB', args: ['cmd-svc-08', 'read']},
    {method: 'getCommandFromDB', args: ['cmd-svc-08', 'read']},
    {method: 'getCommandFromDB', args: ['cmd-svc-08', 'missing']}
  ]
});
add('get_invalid_cache', 'cmd-svc-09', {
  plan: 'free',
  docs: [base('cmd-svc-09', {_id: '000000000000000000000009', cmd: 'broken'})],
  cache: [['cmd-svc-09:commands:broken', '{not json']],
  steps: [{method: 'getCommandFromDB', args: ['cmd-svc-09', 'broken']}]
});
add('get_cache_failure_no_fallback', 'cmd-svc-10', {
  plan: 'free',
  docs: [base('cmd-svc-10', {_id: '000000000000000000000010', cmd: 'cachefail'})],
  fail: {cacheGet: true},
  native: false,
  steps: [{method: 'getCommandFromDB', args: ['cmd-svc-10', 'cachefail']}]
});
add('reserved_shared_cache', 'cmd-svc-11', {
  plan: 'free',
  docs: [base('cmd-svc-11', {_id: '000000000000000000000011', cmd: 'res', reserved: true})],
  steps: [
    {method: 'getReservedCommandFromDB', args: ['cmd-svc-11', 'res']},
    {method: 'getReservedCommandFromDB', args: ['cmd-svc-11', 'res']},
    {method: 'getCommandFromDB', args: ['cmd-svc-11', 'res']},
    {method: 'checkIfReservedCommandExists', args: ['cmd-svc-11', 'res']}
  ]
});
add('exists_cold_warm_missing', 'cmd-svc-12', {
  plan: 'free',
  docs: [base('cmd-svc-12', {_id: '000000000000000000000012', cmd: 'exists'})],
  steps: [
    {method: 'checkIfCommandExists', args: ['cmd-svc-12', 'exists']},
    {method: 'checkIfCommandExists', args: ['cmd-svc-12', 'exists']},
    {method: 'checkIfCommandExists', args: ['cmd-svc-12', 'nope']}
  ]
});
add('delete_invalidates', 'cmd-svc-13', {
  plan: 'free',
  docs: [base('cmd-svc-13', {_id: '000000000000000000000013', cmd: 'remove'})],
  steps: [
    {method: 'getCommandFromDB', args: ['cmd-svc-13', 'remove']},
    {method: 'deleteCommand', args: ['cmd-svc-13', 'remove']},
    {method: 'deleteCommand', args: ['cmd-svc-13', 'remove']}
  ]
});
add('delete_invalidation_failure_keeps_success', 'cmd-svc-14', {
  plan: 'free',
  docs: [base('cmd-svc-14', {_id: '000000000000000000000014', cmd: 'remove'})],
  fail: {cacheDel: true},
  native: false,
  steps: [{method: 'deleteCommand', args: ['cmd-svc-14', 'remove']}]
});
add('update_invalidates', 'cmd-svc-15', {
  plan: 'free',
  docs: [base('cmd-svc-15', {_id: '000000000000000000000015', cmd: 'edit', cooldown: 5})],
  steps: [
    {method: 'getCommandFromDB', args: ['cmd-svc-15', 'edit']},
    {method: 'updateCommandInDB', args: ['cmd-svc-15', 'edit', {message: 'edited'}]},
    {method: 'getCommandFromDB', args: ['cmd-svc-15', 'edit']}
  ]
});
add('update_invalid_cooldown', 'cmd-svc-16', {
  plan: 'pro',
  docs: [base('cmd-svc-16', {_id: '000000000000000000000016', cmd: 'edit', cooldown: 5})],
  steps: [{method: 'updateCommandInDB', args: ['cmd-svc-16', 'edit', {cooldown: 0.5}]}]
});
add('update_reserved_zero', 'cmd-svc-17', {
  plan: 'pro',
  docs: [base('cmd-svc-17', {_id: '000000000000000000000017', cmd: 'reserved', cooldown: 5, reserved: true})],
  steps: [{method: 'updateCommandInDB', args: ['cmd-svc-17', 'reserved', {cooldown: 0}]}]
});
add('update_zero_own_exclusion', 'cmd-svc-18', {
  plan: 'pro',
  docs: [base('cmd-svc-18', {_id: '000000000000000000000018', cmd: 'zero', cooldown: 0})],
  steps: [{method: 'updateCommandInDB', args: ['cmd-svc-18', 'zero', {cooldown: 0, message: 'still zero'}]}]
});
add('update_zero_conflict', 'cmd-svc-19', {
  plan: 'pro',
  docs: [
    base('cmd-svc-19', {_id: '000000000000000000000019', cmd: 'edit', cooldown: 5}),
    base('cmd-svc-19', {_id: '000000000000000000000020', cmd: 'other', cooldown: 0})
  ],
  steps: [{method: 'updateCommandInDB', args: ['cmd-svc-19', 'edit', {cooldown: 0}]}]
});
add('update_grandfathers_unchanged', 'cmd-svc-20', {
  plan: null,
  docs: [base('cmd-svc-20', {_id: '000000000000000000000021', cmd: 'old', cooldown: 1})],
  steps: [{method: 'updateCommandInDB', args: ['cmd-svc-20', 'old', {cooldown: 1, message: 'grandfathered'}]}]
});
add('update_count', 'cmd-svc-21', {
  plan: 'free',
  docs: [base('cmd-svc-21', {_id: '000000000000000000000022', cmd: 'count'})],
  steps: [
    {method: 'getCommandFromDB', args: ['cmd-svc-21', 'count']},
    {method: 'updateCountableCommandInDB', args: ['cmd-svc-21', 'count', 7]}
  ]
});
add('update_availability', 'cmd-svc-22', {
  plan: 'free',
  docs: [base('cmd-svc-22', {_id: '000000000000000000000023', cmd: 'toggle'})],
  steps: [
    {method: 'getCommandFromDB', args: ['cmd-svc-22', 'toggle']},
    {method: 'updateCommandAvailability', args: ['cmd-svc-22', 'toggle', false]}
  ]
});
add('create_save_failure', 'cmd-svc-23', {
  plan: 'pro',
  fail: {save: true},
  native: false,
  steps: [{method: 'createCommand', args: ['cmd-svc-23', base('cmd-svc-23', {cmd: 'broken'})]}]
});
add('create_find_failure', 'cmd-svc-24', {
  plan: 'pro',
  fail: {findOne: true},
  native: false,
  steps: [{method: 'createCommand', args: ['cmd-svc-24', base('cmd-svc-24', {cmd: 'broken'})]}]
});
add('create_cache_failure', 'cmd-svc-25', {
  plan: 'pro',
  fail: {cacheSet: true},
  native: false,
  steps: [{method: 'createCommand', args: ['cmd-svc-25', base('cmd-svc-25', {cmd: 'cached'})]}]
});
add('update_storage_failure', 'cmd-svc-26', {
  plan: 'free',
  docs: [base('cmd-svc-26', {_id: '000000000000000000000026', cmd: 'edit'})],
  fail: {updateOne: true},
  native: false,
  steps: [{method: 'updateCommandInDB', args: ['cmd-svc-26', 'edit', {message: 'nope'}]}]
});
add('delete_storage_failure', 'cmd-svc-27', {
  plan: 'free',
  docs: [base('cmd-svc-27', {_id: '000000000000000000000027', cmd: 'remove'})],
  fail: {deleteOne: true},
  native: false,
  steps: [{method: 'deleteCommand', args: ['cmd-svc-27', 'remove']}]
});

async function runCase(item) {
  const storage = makeStorage(item.fail ?? {});
  for (const document of item.docs ?? []) storage.storage.write(document);
  const cache = makeCache(item.fail ?? {}, item.cache ?? []);
  const logs = [];
  let planLookups = 0;
  const sandbox = {
    exports: {},
    module: {exports: {}},
    randomUUID: crypto.randomUUID,
    CommandsSchema: storage.CommandsSchema,
    TwitchStreamers: {
      async getTwitchAccountById(id) {
        planLookups += 1;
        return item.plan === null || item.plan === undefined ? null : {plan_tier: item.plan, id};
      }
    },
    getDragonflyClient: async () => cache.client,
    error: async (payload, options) => {
      logs.push({
        function: payload.function,
        ...(payload.cmd !== undefined ? {cmd: payload.cmd} : {}),
        ...(payload.channelID !== undefined ? {channelID: payload.channelID} : {})
      });
    }
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(compiled, sandbox, {filename: 'commands-service-oracle.cjs'});
  const service = sandbox.module.exports.default;
  assert(service && typeof service.createCommand === 'function', 'real Commands instance');

  const responses = [];
  for (const step of item.steps) {
    const args = JSON.parse(JSON.stringify(step.args));
    let response;
    switch (step.method) {
      case 'createCommand': response = await service.createCommand(args[0], args[1]); break;
      case 'deleteCommand': response = await service.deleteCommand(args[0], args[1]); break;
      case 'getCommandFromDB': response = await service.getCommandFromDB(args[0], args[1]); break;
      case 'getReservedCommandFromDB': response = await service.getReservedCommandFromDB(args[0], args[1]); break;
      case 'checkIfCommandExists': response = await service.checkIfCommandExists(args[0], args[1]); break;
      case 'checkIfReservedCommandExists': response = await service.checkIfReservedCommandExists(args[0], args[1]); break;
      case 'updateCommandInDB': response = await service.updateCommandInDB(args[0], args[1], args[2]); break;
      case 'updateCountableCommandInDB': response = await service.updateCountableCommandInDB(args[0], args[1], args[2]); break;
      case 'updateCommandAvailability': response = await service.updateCommandAvailability(args[0], args[1], args[2]); break;
      default: throw new Error(`unknown source method ${step.method}`);
    }
    responses.push(normalizeResponse(response));
  }
  const docs = storage.storage.list()
    .filter(document => document.channelID === item.channel)
    .map(selectDoc)
    .sort((left, right) => docKey(left).localeCompare(docKey(right)));
  const cacheKeys = [...cache.values.keys()]
    .filter(key => key.startsWith(`${item.channel}:commands:`))
    .sort();
  const lease = cache.values.has(`command-cooldown-write:${item.channel}`) ? 'present' : 'absent';
  return {
    id: item.id,
    channel: item.channel,
    plan: item.plan ?? null,
    inputDocs: item.docs ?? [],
    cache: item.cache ?? [],
    steps: item.steps,
    native: item.native !== false,
    responses,
    docs,
    cacheKeys,
    lease,
    logs,
    planLookups
  };
}

(async () => {
  const [mode, dir, ...extra] = process.argv.slice(2);
  assert(['--write', '--check'].includes(mode) && dir && extra.length === 0, 'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(), 'parent supplies an owned directory');
  const results = [];
  for (const item of cases) results.push(await runCase(item));
  const output = {
    version: 1,
    source: {
      commandClass: pins.commandClass,
      cooldownWrite: pins.cooldownWrite,
      cooldownArchive: pins.cooldownArchive
    },
    cases: results
  };
  const body = JSON.stringify(output, null, 2) + '\n';
  const target = path.join(fs.realpathSync(dir), 'commands_service_reference.json');
  if (mode === '--write') {
    assert(!fs.existsSync(target), `refuse overwrite ${target}`);
    fs.writeFileSync(target, body, {flag: 'wx'});
  } else {
    assert.equal(fs.readFileSync(target, 'utf8'), body, 'source/oracle drift');
  }
  process.stdout.write(`${mode} ${results.length} source cases\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
