'use strict';
// Source oracle for the native Twitch header helpers.
//
// Evaluates the real, unmodified function bodies of `src/utils/header.ts` and
// `src/utils/notifications.ts`. Only the four header.js import bindings are
// boundary doubles (`TwitchStreamers`, `getAppToken`, `getBotToken`, `debug`);
// `notifyDevelopers` is the actual notifications.ts implementation, and its
// `console.error` sink is recorded. No header control flow, message text, header
// shape or notification format is reconstructed here.
//
// Usage: node twitch_headers_reference.cjs --write DIR | --check DIR
// DIR is a parent-owned artifact directory. The generated JSON is the external
// native replay corpus; it is never committed as a hand-written golden.
//
// Known source nuance recorded in `sourceClientIdBinding`: the app/streamer
// module globals snapshot CLIENT_ID at import time, while the bot and
// streamer-by-id helpers read process.env.CLIENT_ID on every call. Native code
// captures one explicit factory value instead of re-reading the environment;
// that is documented in the migration note and is only observable if the
// process environment changes after import.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const files = {
  header: path.join(root, 'src/utils/header.ts'),
  notifications: path.join(root, 'src/utils/notifications.ts')
};
const pins = {
  header: '2fd03bce05402e6a63bf4a0713c9df714efe7fdd3d46d47fb747a8bc1bce0000',
  notifications: 'c056e285e16d685b23cda5f2af23772e17293a131ce254068b364f93252052a1'
};
const sources = Object.fromEntries(
  Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')])
);
for (const [name, pin] of Object.entries(pins)) {
  assert.equal(sha(sources[name]), pin, `${name} source pin`);
}
assert.equal(process.version, 'v24.22.1');
assert.equal(ts.version, '5.9.3');
// Pinned Node binary, V8 and TypeScript files: the replay runtime cannot drift.
const runtimePins = {
  node: '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108',
  v8: '13.6.233.17-node.58',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6'
};
assert.equal(sha(fs.readFileSync(process.execPath)), runtimePins.node, 'node binary pin');
assert.equal(process.versions.v8, runtimePins.v8, 'v8 pin');
assert.equal(sha(fs.readFileSync(require.resolve('typescript'))), runtimePins.typescript, 'typescript pin');
assert.equal(
  sha(fs.readFileSync(require.resolve('typescript/package.json'))),
  runtimePins.typescriptPackage,
  'typescript package pin'
);

function parse(name, expectedImports, expectedExports) {
  const ast = ts.createSourceFile(files[name], sources[name], ts.ScriptTarget.ES2022, true);
  assert.deepEqual(ast.parseDiagnostics, [], `${name} parse`);
  const imports = ast.statements.filter(ts.isImportDeclaration).map(statement => {
    const clause = statement.importClause;
    const names = [];
    if (clause?.name) names.push(clause.name.text);
    for (const element of clause?.namedBindings?.elements ?? []) names.push(element.name.text);
    return { module: statement.moduleSpecifier.text, names };
  });
  assert.deepEqual(imports, expectedImports, `${name} import boundaries`);
  const exported = [];
  const typeExported = [];
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      const names = statement.exportClause?.elements?.map(e => e.name.text) ?? [];
      (statement.isTypeOnly ? typeExported : exported).push(...names);
      continue;
    }
    if (!statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name?.text) exported.push(declaration.name.text);
      }
      continue;
    }
    if (statement.name) exported.push(statement.name.text);
  }
  assert.deepEqual(exported.sort(), [...expectedExports].sort(), `${name} exports`);
  // Keep every executable declaration with its original body. Type-only
  // declarations and export markers are removed; nothing is rewritten.
  const body = ast.statements
    .filter(statement => !ts.isImportDeclaration(statement))
    .filter(statement => !ts.isInterfaceDeclaration(statement))
    .filter(statement => !ts.isTypeAliasDeclaration(statement))
    .filter(statement => !ts.isExportDeclaration(statement))
    .map(statement => statement.getText(ast).replace(/^export\s+/, ''))
    .join('\n');
  return { body, typeExported };
}

const parsedHeader = parse(
  'header',
  [
    { module: '../classes/twitch_streamers.class.js', names: ['TwitchStreamers'] },
    { module: './tokens.js', names: ['getAppToken', 'getBotToken'] },
    { module: './notifications.js', names: ['notifyDevelopers'] },
    { module: './logger.js', names: ['debug'] }
  ],
  [
    'getTwitchAppHeader',
    'getTwitchBotHeader',
    'getTwitchStreamerHeaderById',
    'TWITCH_BOT_ACCOUNT_ID',
    'getTwitchModeratorHeader',
    'twitchAppHeader',
    'twitchStreamerHeader'
  ]
);
assert.deepEqual(parsedHeader.typeExported, ['TwitchHeaderResult'], 'header type export');
const parsedNotifications = parse('notifications', [], ['notifyDevelopers']);
const headerBody = parsedHeader.body;
const notificationsBody = parsedNotifications.body;
for (const name of ['getTwitchAppHeader', 'getTwitchBotHeader', 'getTwitchStreamerHeaderById', 'getTwitchModeratorHeader']) {
  assert(headerBody.includes(`async function ${name}`) || headerBody.includes(`const ${name} = async`), `${name} body`);
}
assert(notificationsBody.includes('async function notifyDevelopers'));

// Strip TypeScript annotations from the untouched source bodies only; the
// boundary doubles below stay plain JavaScript.
const transpiled = ts.transpileModule(`${notificationsBody}\n${headerBody}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true
});
assert.deepEqual(transpiled.diagnostics ?? [], [], 'source body transpile');
const sourceBody = transpiled.outputText;

// Boundary doubles only. Every value comes from the case's `stub`; every call
// is recorded so the native replay can prove which dependency was used.
const script = `
const debug = async (data, options) => {
  globalThis.__calls.debug.push({ data: JSON.parse(JSON.stringify(data)), options: { destination: options?.destination } });
};
const getAppToken = async platform => {
  globalThis.__calls.tokens.push('app:' + platform);
  return globalThis.__stub.appToken;
};
const getBotToken = async () => {
  globalThis.__calls.tokens.push('bot');
  return globalThis.__stub.botToken;
};
const TwitchStreamers = {
  getTwitchAccountById: async id => {
    globalThis.__calls.directory.push('account:' + id);
    const account = globalThis.__stub.streamer;
    return account ? JSON.parse(JSON.stringify(account)) : null;
  },
  getAccountTokenById: async (id, type) => {
    globalThis.__calls.directory.push('token:' + id + ':' + type);
    return globalThis.__stub.streamerToken;
  }
};
${sourceBody}
globalThis.__api = {
  getTwitchAppHeader, getTwitchBotHeader, getTwitchStreamerHeaderById, getTwitchModeratorHeader,
  TWITCH_BOT_ACCOUNT_ID, twitchAppHeader, twitchStreamerHeader, notifyDevelopers
};
`;

function evaluate(stub, clientId = 'client-id') {
  const calls = { tokens: [], directory: [], debug: [], console: [] };
  const context = {
    __stub: stub,
    __calls: calls,
    console: { error: (...args) => calls.console.push(args.map(String).join(' ')) },
    process: { env: { CLIENT_ID: clientId } }
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { api: context.__api, calls, context };
}
const wire = value => (value === undefined ? { absent: true } : JSON.parse(JSON.stringify(value)));
const state = api => ({
  twitchAppHeader: wire(api.twitchAppHeader),
  twitchStreamerHeader: wire(api.twitchStreamerHeader)
});

async function runCase(id, call, args, stub) {
  const { api, calls } = evaluate(stub);
  const record = { id, call, args, stub };
  try {
    const value = await api[call](...args);
    record.result = { value: wire(value) };
  } catch (error) {
    record.result = { threw: error.message };
  }
  record.calls = calls;
  record.state = state(api);
  return record;
}

async function notifyCase(severity) {
  const { api, calls } = evaluate({});
  await api.notifyDevelopers(`message for ${severity}`, severity);
  return calls.console;
}

async function main() {
  const cases = [
    await runCase('app-success', 'getTwitchAppHeader', [], { appToken: 'app-token' }),
    await runCase('app-missing', 'getTwitchAppHeader', [], { appToken: null }),
    await runCase('bot-success', 'getTwitchBotHeader', [], { botToken: 'bot-token' }),
    await runCase('bot-missing', 'getTwitchBotHeader', [], { botToken: null }),
    await runCase('streamer-success', 'getTwitchStreamerHeaderById', ['111'], {
      streamer: { id: '111', has_permissions: 'true' },
      streamerToken: 'streamer-token-1234567890'
    }),
    await runCase('streamer-missing', 'getTwitchStreamerHeaderById', ['999'], { streamer: null }),
    await runCase('streamer-no-permissions', 'getTwitchStreamerHeaderById', ['222'], {
      streamer: { id: '222', has_permissions: 'false' },
      streamerToken: 'unused-token'
    }),
    await runCase('streamer-empty-token', 'getTwitchStreamerHeaderById', ['333'], {
      streamer: { id: '333', has_permissions: 'true' },
      streamerToken: null
    }),
    await runCase('moderator-uses-bot', 'getTwitchModeratorHeader', ['444', '555'], {
      botToken: 'bot-token',
      streamer: { id: '444', has_permissions: 'true' },
      streamerToken: 'streamer-token-must-not-be-used'
    })
  ];

  const notificationLines = {
    error: await notifyCase('error'),
    warning: await notifyCase('warning'),
    info: await notifyCase('info')
  };
  assert.deepEqual(notificationLines.error, ['[DEV NOTIFICATION - ERROR]: message for error']);
  assert.deepEqual(notificationLines.warning, ['[DEV NOTIFICATION - WARNING]: message for warning']);
  assert.deepEqual(notificationLines.info, ['[DEV NOTIFICATION - INFO]: message for info']);

  // Informational source nuance: see the file header comment. The native replay
  // asserts its own documented contract (one explicit factory value) instead of
  // reproducing per-call environment reads.
  const binding = evaluate({ appToken: 'app-token', botToken: 'bot-token', streamer: { id: '777', has_permissions: 'true' }, streamerToken: 'streamer-token' });
  const moduleLoadClientId = binding.api.twitchAppHeader['Client-Id'];
  binding.context.process.env.CLIENT_ID = 'changed-client';
  const appAfterEnvChange = (await binding.api.getTwitchAppHeader())['Client-Id'];
  const botAfterEnvChange = (await binding.api.getTwitchBotHeader()).header['Client-Id'];
  const streamerAfterEnvChange = (await binding.api.getTwitchStreamerHeaderById('777')).header['Client-Id'];
  assert.equal(appAfterEnvChange, moduleLoadClientId);

  const referenceObject = {
    source: { sha256: { ...pins }, files: ['src/utils/header.ts', 'src/utils/notifications.ts'] },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      typescript: ts.version,
      nodeBinary: runtimePins.node,
      typescriptFile: runtimePins.typescript,
      typescriptPackage: runtimePins.typescriptPackage
    },
    botAccountId: '698614112',
    cases,
    notificationLines,
    sourceClientIdBinding: {
      moduleLoad: moduleLoadClientId,
      appAfterEnvChange,
      botAfterEnvChange,
      streamerAfterEnvChange
    }
  };

  // Recorded calls come from the vm realm; normalize through the artifact's own
  // JSON boundary so --check compares values, not cross-realm prototypes.
  const reference = JSON.parse(JSON.stringify(referenceObject));

  const mode = process.argv[2];
  const directory = process.argv[3];
  assert(mode === '--write' || mode === '--check', 'usage: --write DIR | --check DIR');
  assert(typeof directory === 'string' && path.isAbsolute(directory), 'absolute artifact directory required');
  const artifact = path.join(directory, 'twitch_headers_reference.json');
  if (mode === '--write') {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify(reference, null, 2) + '\n');
    console.log(JSON.stringify({ wrote: artifact, sha256: sha(JSON.stringify(reference)), cases: cases.length }));
  } else {
    const committed = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    assert.deepEqual(reference, committed, 'source replay must match the reference artifact');
    console.log(JSON.stringify({ checked: artifact, cases: cases.length }));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
