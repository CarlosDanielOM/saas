// Regenerate/check without a TS loader or application imports:
//   node dima-rust/tests/fixtures/permission_core_reference.mjs [--check]
//
// The authoritative source is dimabot/src/utils/permissions/{expression,index,roles}.ts.
// Only the pure declarations the permission core needs are copied from the
// actual files, imports are dropped, and the result runs in an isolated VM.
// No Dragonfly/Mongo/HTTP/env/clock/network module is ever imported or started.
// Source and shared-fixture SHA-256 hashes are recorded for drift detection.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from '../../../dimabot/node_modules/typescript/lib/typescript.js';

const sourceRoot = new URL('../../../dimabot/src/utils/permissions/', import.meta.url);
const sharedFixtureUrl = new URL('../../../ops/fixtures/permission-expressions.json', import.meta.url);
const outputUrl = new URL('permission_core_cases.json', import.meta.url);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Only these declarations are extracted. Everything else in the source files
// (cache clients, async role resolution, re-exports, error throttling) stays out.
const SELECTIONS = {
  'roles.ts': [
    'ROLE_TAGS',
    'ROLE_TAG_SET',
    'MODERATOR_BADGE_IDS',
    'BROADCASTER_USER_LEVEL',
    'isRoleTag',
    'createUserIdentity',
    'createBroadcasterIdentity',
    'createDefaultIdentity',
    'serializeUserIdentity',
    'parseUserIdentity',
    'badgeSetIds',
    'deriveBadgeLevel',
    'deriveBadgeTags'
  ],
  'expression.ts': [
    'MAX_EXPRESSION_DEPTH',
    'MAX_EXPRESSION_NODES',
    'DISCRIMINATOR_KEYS',
    'DISCRIMINATOR_SET',
    'validateNode',
    'validateExpression',
    'inspectExpression',
    'evaluateExpression',
    'evaluateNode',
    'countExpressionNodes'
  ],
  'index.ts': [
    'flatLeaves',
    'flatAccessDecision',
    'evaluateAccessExpression',
    'parseLegacyLevel',
    'isExpressionAllowed',
    'commandAllowed',
    'ruleExempt'
  ]
};

const sources = {};
const chunks = [];
for (const [file, wanted] of Object.entries(SELECTIONS)) {
  const input = await readFile(new URL(file, sourceRoot), 'utf8');
  sources[file] = sha256(input);
  const ast = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
  const selected = new Set(wanted);
  const found = new Set();
  const statements = ast.statements.filter((statement) => {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return false;
    const names = ts.isFunctionDeclaration(statement)
      ? (statement.name ? [statement.name.text] : [])
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((declaration) => declaration.name.getText(ast))
        : [];
    if (names.length === 0 || names.some((name) => !selected.has(name))) return false;
    names.forEach((name) => found.add(name));
    return true;
  });
  assert.deepEqual(
    [...found].sort(),
    [...selected].sort(),
    `declaration selection drift in ${file}`
  );
  chunks.push(`// ---- ${file} ----\n${statements.map((statement) => statement.getText(ast)).join('\n')}`);
}

const transpiled = ts.transpileModule(chunks.join('\n'), {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0, `extracted declarations do not compile: ${errors.map((e) => e.messageText).join('; ')}`);
const context = vm.createContext({ exports: {} });
new vm.Script(transpiled.outputText, { filename: 'permissions.isolated.js' }).runInContext(context, { timeout: 1000 });
const permissions = context.exports;
const exportedSymbols = [
  'ROLE_TAGS', 'MODERATOR_BADGE_IDS', 'BROADCASTER_USER_LEVEL', 'isRoleTag',
  'createUserIdentity', 'createBroadcasterIdentity', 'createDefaultIdentity',
  'serializeUserIdentity', 'parseUserIdentity', 'deriveBadgeLevel', 'deriveBadgeTags',
  'MAX_EXPRESSION_DEPTH', 'MAX_EXPRESSION_NODES', 'validateExpression',
  'inspectExpression', 'evaluateExpression', 'countExpressionNodes',
  'isExpressionAllowed', 'commandAllowed', 'ruleExempt'
];
for (const name of exportedSymbols) {
  assert.ok(permissions[name] !== undefined, `missing extracted symbol ${name}`);
}

const sharedFixtureText = await readFile(sharedFixtureUrl, 'utf8');
const sharedFixture = JSON.parse(sharedFixtureText);

const json = (value) => JSON.parse(JSON.stringify(value));
const cases = [];
const seenNames = new Set();
function uniqueName(label) {
  if (!seenNames.has(label)) {
    seenNames.add(label);
    return label;
  }
  let suffix = 2;
  while (seenNames.has(`${label}~${suffix}`)) suffix += 1;
  const name = `${label}~${suffix}`;
  seenNames.add(name);
  return name;
}
function addCase(operation, label, input, expectations) {
  cases.push({ name: uniqueName(label), operation, input: json(input), ...expectations });
}

// ---------------------------------------------------------------------------
// Identities: reuse the shared fixture set, then extend it with mixes that
// exercise every role, named-account precedence, and unresolved identities.
// ---------------------------------------------------------------------------
const identitySpecs = {
  ...sharedFixture.identities,
  editor_admin: { level: 9, tags: ['everyone', 'editor', 'admin'] },
  login_only: { level: 1, tags: ['everyone'], login: 'someone' },
  level10_no_tag: { level: 10, tags: ['everyone'] },
  broadcaster_tag_level1: { level: 1, tags: ['everyone', 'broadcaster'] },
  mod_named: { level: 7, tags: ['everyone', 'mod'], userId: '12345', login: 'renamed' },
  excluded_named_mod: { level: 7, tags: ['everyone', 'mod'], userId: '67890', login: 'badactor' },
  vip_sub: { level: 5, tags: ['everyone', 'vip', 'sub'] },
  vip_named: { level: 5, tags: ['everyone', 'vip'], userId: '55555', login: 'other' },
  vip_sub_named: { level: 5, tags: ['everyone', 'vip', 'sub'], userId: '44444', login: 'other' },
  sub_named: { level: 2, tags: ['everyone', 'sub'], userId: '33333', login: 'other' },
  founder_mod: { level: 7, tags: ['everyone', 'founder', 'mod', 'sub'] },
  admin_sub: { level: 9, tags: ['everyone', 'admin', 'sub'] }
};
const buildIdentity = (spec) => permissions.createUserIdentity(spec.level, spec.tags, spec.userId, spec.login);
const identityPayload = (spec) => json(permissions.serializeUserIdentity(buildIdentity(spec)));
const identities = Object.fromEntries(Object.entries(identitySpecs).map(([name, spec]) => [name, buildIdentity(spec)]));
const identityInputs = Object.fromEntries(Object.entries(identitySpecs).map(([name, spec]) => [name, identityPayload(spec)]));

// ---------------------------------------------------------------------------
// Expressions: reuse every shared valid/invalid case, then add source-level
// coverage for role/level/user leaves, malformed shapes, and flat access forms.
// ---------------------------------------------------------------------------
const validExpressions = [
  ...sharedFixture.valid.map(({ name, expression }) => ({ name: `shared-valid:${name}`, expression })),
  { name: 'role-everyone', expression: { role: 'everyone' } },
  { name: 'role-sub', expression: { role: 'sub' } },
  { name: 'role-vip', expression: { role: 'vip' } },
  { name: 'role-founder', expression: { role: 'founder' } },
  { name: 'role-mod', expression: { role: 'mod' } },
  { name: 'role-editor', expression: { role: 'editor' } },
  { name: 'role-admin', expression: { role: 'admin' } },
  { name: 'role-broadcaster', expression: { role: 'broadcaster' } },
  { name: 'level-1', expression: { level: 1 } },
  { name: 'level-2', expression: { level: 2 } },
  { name: 'level-5', expression: { level: 5 } },
  { name: 'level-6', expression: { level: 6 } },
  { name: 'level-7', expression: { level: 7 } },
  { name: 'level-8', expression: { level: 8 } },
  { name: 'level-9', expression: { level: 9 } },
  { name: 'level-10', expression: { level: 10 } },
  { name: 'user-lowercase', expression: { user: { id: '12345', login: 'user123' } } },
  { name: 'user-uppercase-sanitized', expression: { user: { id: '12345', login: 'USER123' } } },
  { name: 'not-mod', expression: { not: { role: 'mod' } } },
  { name: 'not-everyone', expression: { not: { role: 'everyone' } } },
  { name: 'not-user', expression: { not: { user: { id: '12345', login: 'user123' } } } },
  { name: 'not-level-7', expression: { not: { level: 7 } } },
  { name: 'not-and-sub-vip', expression: { not: { and: [{ role: 'sub' }, { role: 'vip' }] } } },
  { name: 'not-or-mod-admin', expression: { not: { or: [{ role: 'mod' }, { role: 'admin' }] } } },
  { name: 'or-mod-user', expression: { or: [{ role: 'mod' }, { user: { id: '12345', login: 'user123' } }] } },
  { name: 'or-vip-founder-user', expression: { or: [{ role: 'vip' }, { role: 'founder' }, { user: { id: '12345', login: 'user123' } }] } },
  { name: 'and-everyone-not-user', expression: { and: [{ role: 'everyone' }, { not: { user: { id: '12345', login: 'user123' } } }] } },
  { name: 'and-user-not-everyone', expression: { and: [{ user: { id: '12345', login: 'user123' } }, { not: { role: 'everyone' } }] } },
  { name: 'and-vip-not-user', expression: { and: [{ role: 'vip' }, { not: { user: { id: '12345', login: 'user123' } } }] } },
  { name: 'or-everyone-not-user', expression: { or: [{ role: 'everyone' }, { not: { user: { id: '12345', login: 'user123' } } }] } },
  { name: 'and-everyone-not-or-sub-vip', expression: { and: [{ role: 'everyone' }, { not: { or: [{ role: 'sub' }, { role: 'vip' }] } }] } },
  { name: 'and-or-vip-mod-not-everyone', expression: { and: [{ or: [{ role: 'vip' }, { role: 'mod' }] }, { not: { role: 'everyone' } }] } },
  { name: 'and-or-sub-vip-not-founder', expression: { and: [{ or: [{ role: 'sub' }, { role: 'vip' }] }, { not: { role: 'founder' } }] } },
  { name: 'or-not-user-mod', expression: { or: [{ not: { user: { id: '12345', login: 'user123' } } }, { role: 'mod' }] } },
  { name: 'and-mod-not-everyone', expression: { and: [{ role: 'mod' }, { not: { role: 'everyone' } }] } },
  {
    name: 'and-or-vip-mod-not-or-everyone-sub-user',
    expression: {
      and: [
        { or: [{ role: 'vip' }, { role: 'mod' }, { user: { id: '12345', login: 'user123' } }] },
        { not: { or: [{ role: 'everyone' }, { role: 'sub' }, { user: { id: '67890', login: 'badactor' } }] } }
      ]
    }
  },
  { name: 'and-everyone-not-and-sub-vip', expression: { and: [{ role: 'everyone' }, { not: { and: [{ role: 'sub' }, { role: 'vip' }] } }] } },
  { name: 'and-single-child-or', expression: { and: [{ or: [{ role: 'vip' }] }] } },
  { name: 'or-repeated-leaves', expression: { or: [{ role: 'sub' }, { role: 'sub' }, { level: 2 }] } },
  { name: 'depth-4-not-chain', expression: { and: [{ or: [{ not: { role: 'sub' } }] }] } },
  {
    name: 'nodes-25',
    expression: {
      or: [
        { and: [{ role: 'sub' }, { role: 'vip' }, { role: 'founder' }, { role: 'mod' }] },
        { and: [{ role: 'editor' }, { role: 'admin' }, { level: 7 }, { level: 8 }] },
        { and: [{ or: [{ role: 'sub' }, { role: 'vip' }] }, { not: { role: 'mod' } }] },
        { and: [{ level: 2 }, { level: 5 }, { level: 6 }, { role: 'everyone' }] },
        { or: [{ role: 'vip' }, { level: 9 }] }
      ]
    }
  }
];

const invalidExpressions = [
  ...sharedFixture.invalid.map(({ name, expression }) => ({ name: `shared-invalid:${name}`, expression })),
  { name: 'root-array', expression: [{ role: 'mod' }] },
  { name: 'root-string', expression: 'mod' },
  { name: 'root-number', expression: 7 },
  { name: 'root-null', expression: null },
  { name: 'root-boolean', expression: true },
  { name: 'empty-object', expression: {} },
  { name: 'unknown-only-field', expression: { extra: true } },
  { name: 'two-operators', expression: { role: 'mod', level: 7 } },
  { name: 'role-plus-unknown', expression: { role: 'mod', extra: true } },
  { name: 'role-null', expression: { role: null } },
  { name: 'role-number', expression: { role: 7 } },
  { name: 'role-case-sensitive', expression: { role: 'Mod' } },
  { name: 'role-trailing-space', expression: { role: 'mod ' } },
  { name: 'role-subscriber-alias', expression: { role: 'subscriber' } },
  { name: 'level-string', expression: { level: '7' } },
  { name: 'level-null', expression: { level: null } },
  { name: 'level-zero', expression: { level: 0 } },
  { name: 'level-eleven', expression: { level: 11 } },
  { name: 'level-fraction', expression: { level: 1.5 } },
  { name: 'level-negative', expression: { level: -1 } },
  { name: 'level-boolean', expression: { level: true } },
  { name: 'not-null', expression: { not: null } },
  { name: 'not-array', expression: { not: [{ role: 'mod' }] } },
  { name: 'not-empty-object', expression: { not: {} } },
  { name: 'and-object', expression: { and: { role: 'mod' } } },
  { name: 'and-empty', expression: { and: [] } },
  { name: 'or-string', expression: { or: 'mod' } },
  { name: 'or-empty', expression: { or: [] } },
  { name: 'nested-invalid-child', expression: { and: [{ role: 'sub' }, { role: 'vip', x: 1 }] } },
  { name: 'user-missing-login', expression: { user: { id: '12345' } } },
  { name: 'user-missing-id', expression: { user: { login: 'user123' } } },
  { name: 'user-extra-key', expression: { user: { id: '12345', login: 'user123', extra: 1 } } },
  { name: 'user-id-21-digits', expression: { user: { id: '123456789012345678901', login: 'user123' } } },
  { name: 'user-id-fullwidth', expression: { user: { id: '１２３', login: 'user123' } } },
  { name: 'user-id-empty', expression: { user: { id: '', login: 'user123' } } },
  { name: 'user-login-hyphen', expression: { user: { id: '12345', login: 'bad-login' } } },
  { name: 'user-login-space', expression: { user: { id: '12345', login: 'bad login' } } },
  { name: 'user-login-26', expression: { user: { id: '12345', login: 'a'.repeat(26) } } },
  { name: 'user-login-empty', expression: { user: { id: '12345', login: '' } } },
  { name: 'user-array', expression: { user: ['12345', 'user123'] } },
  { name: 'depth-5', expression: { and: [{ or: [{ and: [{ not: { role: 'sub' } }] }] }] } },
  {
    name: 'nodes-26',
    expression: {
      or: [
        { and: [{ role: 'sub' }, { role: 'vip' }, { role: 'founder' }, { role: 'mod' }] },
        { and: [{ role: 'editor' }, { role: 'admin' }, { level: 7 }, { level: 8 }] },
        { and: [{ or: [{ role: 'sub' }, { role: 'vip' }] }, { not: { role: 'mod' } }] },
        { and: [{ level: 2 }, { level: 5 }, { level: 6 }, { role: 'everyone' }] },
        { or: [{ role: 'vip' }, { role: 'founder' }, { level: 9 }, { level: 10 }] },
        { or: [{ role: 'vip' }, { level: 9 }] }
      ]
    }
  }
];

for (const { name, expression } of validExpressions) {
  const result = permissions.validateExpression(expression);
  assert.equal(result.ok, true, `expected valid source tree: ${name}`);
  addCase('validate', `validate:${name}`, { expression }, {
    accepted: true,
    sanitized: json(result.value),
    nodeCount: permissions.countExpressionNodes(expression)
  });
}
for (const { name, expression } of invalidExpressions) {
  const result = permissions.validateExpression(expression);
  assert.equal(result.ok, false, `expected invalid source tree: ${name}`);
  addCase('validate', `validate:${name}`, { expression }, {
    accepted: false,
    error: result.error
  });
}

// ---------------------------------------------------------------------------
// Raw Boolean evaluation (ValidatedExpression::evaluate). Only valid trees:
// malformed raw evaluation is not part of the promised API.
// ---------------------------------------------------------------------------
for (const { name, expression } of validExpressions) {
  for (const [identityName, identity] of Object.entries(identities)) {
    addCase('evaluate', `evaluate:${name}:${identityName}`, {
      expression,
      identity: identityInputs[identityName]
    }, { expected: permissions.evaluateExpression(expression, identity) });
  }
}
for (const [index, evaluation] of sharedFixture.evaluations.entries()) {
  const identityName = evaluation.identity;
  const identity = identities[identityName];
  assert.ok(identity, `shared evaluation identity ${identityName} is missing`);
  const expected = permissions.evaluateExpression(evaluation.expression, identity);
  assert.equal(expected, evaluation.expected, `shared fixture evaluation drifted at index ${index}`);
  addCase('evaluate', `shared-evaluation[${index}]:${identityName}`, {
    expression: evaluation.expression,
    identity: identityInputs[identityName]
  }, { expected });
}

// ---------------------------------------------------------------------------
// Compiled access decisions and the command/rule wrappers. Flat allow/exclude
// precedence, Everyone defaults, named accounts, and invalid-config fail-closed
// behavior all flow through the actual source functions.
// ---------------------------------------------------------------------------
function sourceMode(expression) {
  return permissions.inspectExpression(expression).mode;
}
function assertWrappersAgree(label, command, rule, identity) {
  const fromCommand = permissions.commandAllowed(command, identity);
  const fromRule = permissions.ruleExempt(rule, identity);
  assert.equal(fromCommand, fromRule, `source command/rule wrappers disagree: ${label}`);
  return fromCommand;
}
for (const { name, expression } of validExpressions) {
  for (const [identityName, identity] of Object.entries(identities)) {
    const input = { expression, identity: identityInputs[identityName] };
    const expected = assertWrappersAgree(
      `${name}:${identityName}`,
      { permissionExpression: expression },
      { exemptExpression: expression },
      identity
    );
    addCase('access', `access:${name}:${identityName}`, input, {
      expected,
      expectedMode: sourceMode(expression)
    });
  }
}
for (const { name, expression } of invalidExpressions) {
  // JSON null is "absent" for access decisions (legacy mode); only genuinely
  // present, non-null invalid trees must fail closed.
  if (sourceMode(expression) !== 'invalid') continue;
  for (const identityName of ['viewer', 'mod', 'admin', 'broadcaster']) {
    const identity = identities[identityName];
    const input = { expression, legacy: 1, identity: identityInputs[identityName] };
    const expected = assertWrappersAgree(
      `invalid:${name}:${identityName}`,
      { permissionExpression: expression, userLevel: 1 },
      { exemptExpression: expression, exemptUserLevel: 1 },
      identity
    );
    assert.equal(expected, false, `invalid configuration must fail closed: ${name}`);
    addCase('access', `access:invalid:${name}:${identityName}`, input, {
      expected,
      expectedMode: sourceMode(expression)
    });
  }
}
// A stored numeric level must stay inert while a valid or invalid expression is present.
for (const [label, expression] of [
  ['valid-mod', { role: 'mod' }],
  ['valid-everyone', { role: 'everyone' }],
  ['invalid-role', { role: 'supermod' }]
]) {
  for (const legacy of [1, 7, 10]) {
    for (const [identityName, identity] of Object.entries(identities)) {
      if (!['viewer', 'vip', 'mod', 'admin', 'broadcaster'].includes(identityName)) continue;
      const expected = assertWrappersAgree(
        `${label}:${legacy}:${identityName}`,
        { permissionExpression: expression, userLevel: legacy },
        { exemptExpression: expression, exemptUserLevel: legacy },
        identity
      );
      addCase('access', `access:inert-level:${label}:${legacy}:${identityName}`, {
        expression,
        legacy,
        identity: identityInputs[identityName]
      }, { expected, expectedMode: sourceMode(expression) });
    }
  }
}
// Absent and explicit-null expressions select the legacy numeric gate.
for (const [label, input] of [
  ['absent-expression', {}],
  ['null-expression', { expression: null }]
]) {
  for (const legacy of [
    0, 1, 5, 7, 9, 10, 11, -1, 2.5, '7', ' 7 ', '7abc', 'abc', '',
    true, false, [7], [], {},
    '0x10', '9e2', ' -2.7', '\ufeff\u2028+8suffix', '\u00858',
    '-0tail', '9'.repeat(400), [1e21], [-2e21], [1e20], [2e-7],
    [1e-6], [-0], [[" 7.8"], 9], [null, 9], [8, 9]
  ]) {
    for (const identityName of ['viewer', 'vip', 'mod', 'editor', 'admin', 'broadcaster', 'level10_no_tag']) {
      const identity = identities[identityName];
      const expression = Object.hasOwn(input, 'expression') ? input.expression : undefined;
      const command = Object.hasOwn(input, 'expression')
        ? { permissionExpression: expression, userLevel: legacy }
        : { userLevel: legacy };
      const rule = Object.hasOwn(input, 'expression')
        ? { exemptExpression: expression, exemptUserLevel: legacy }
        : { exemptUserLevel: legacy };
      const expected = assertWrappersAgree(
        `${label}:${String(legacy)}:${identityName}`,
        command,
        rule,
        identity
      );
      addCase('access', `access:${label}:${JSON.stringify(legacy)}:${identityName}`, {
        ...(Object.hasOwn(input, 'expression') ? { expression: input.expression } : {}),
        legacy,
        identity: identityInputs[identityName]
      }, { expected, expectedMode: 'level' });
    }
  }
}
// Requirement: absent/null level fields still gate on 0, and empty configs allow.
for (const [label, input] of [
  ['absent-legacy', { expression: { role: 'mod' } }],
  ['null-legacy', { expression: { role: 'mod' }, legacy: null }]
]) {
  for (const identityName of ['viewer', 'mod', 'broadcaster']) {
    const identity = identities[identityName];
    const expected = assertWrappersAgree(
      label,
      Object.hasOwn(input, 'legacy')
        ? { permissionExpression: input.expression, userLevel: null }
        : { permissionExpression: input.expression },
      Object.hasOwn(input, 'legacy')
        ? { exemptExpression: input.expression, exemptUserLevel: null }
        : { exemptExpression: input.expression },
      identity
    );
    addCase('access', `access:${label}:${identityName}`, {
      ...input,
      identity: identityInputs[identityName]
    }, { expected, expectedMode: 'tags' });
  }
}

// Raw command/rule configuration values follow JavaScript truthiness.
// Account IDs remain exact strings, including leading zeros and 20-digit IDs
// that exceed u64. Keep these focused instead of expanding every identity pair.
for (const [policyId, actualId] of [
  ['00042', '00042'], ['00042', '42'],
  ['99999999999999999999', '99999999999999999999'],
  ['99999999999999999999', '99999999999999999998']
]) {
  const expression = { user: { id: policyId, login: 'UNCHANGED' } };
  const identity = permissions.createUserIdentity(1, [], actualId, 'renamed');
  const serializedIdentity = json(permissions.serializeUserIdentity(identity));
  const name = `exact-account:${policyId}:${actualId}`;
  const validated = permissions.validateExpression(expression);
  assert.equal(validated.ok, true);
  addCase('validate', `validate:${name}`, { expression }, {
    accepted: true, sanitized: json(validated.value),
    nodeCount: permissions.countExpressionNodes(expression)
  });
  addCase('evaluate', `evaluate:${name}`, { expression, identity: serializedIdentity }, {
    expected: permissions.evaluateExpression(validated.value, identity)
  });
  addCase('access', `access:${name}`, { expression, identity: serializedIdentity }, {
    expected: assertWrappersAgree(name, { permissionExpression: expression },
      { exemptExpression: expression }, identity), expectedMode: 'tags'
  });
}

const rawConfigValues = [
  ['absent', undefined],
  ['null', null],
  ['false', false],
  ['true', true],
  ['zero', 0],
  ['one', 1],
  ['empty-string', ''],
  ['string', 'mod'],
  ['empty-array', []],
  ['array', [{ role: 'mod' }]],
  ['empty-object', {}]
];
for (const [label, value] of rawConfigValues) {
  for (const identityName of ['viewer', 'mod', 'broadcaster']) {
    const identity = identities[identityName];
    const command = value === undefined ? undefined : value;
    const expected = permissions.commandAllowed(command, identity);
    assert.equal(expected, permissions.ruleExempt(command, identity), `raw config wrappers disagree: ${label}`);
    addCase('config', `config:${label}:${identityName}`, {
      ...(value === undefined ? {} : { command: value }),
      identity: identityInputs[identityName]
    }, { expected });
  }
}
// Empty command/rule objects keep the legacy 0 gate (everyone allowed).
for (const identityName of ['viewer', 'mod', 'broadcaster']) {
  const identity = identities[identityName];
  const expected = permissions.commandAllowed({}, identity);
  assert.equal(expected, permissions.ruleExempt({}, identity));
  addCase('config', `config:empty-object-explicit:${identityName}`, {
    command: {},
    identity: identityInputs[identityName]
  }, { expected });
}

// ---------------------------------------------------------------------------
// Identity serialization / parsing, badges, and the role enum.
// ---------------------------------------------------------------------------
const serializationSpecs = [
  ['viewer', { level: 1, tags: [] }],
  ['vip', { level: 5, tags: ['vip'] }],
  ['named', { level: 7, tags: ['mod', 'sub'], userId: '12345', login: 'User123' }],
  ['duplicate-tags', { level: 7, tags: ['sub', 'mod', 'sub', 'mod'], login: 'MIXED_Case' }],
  ['empty-id-login', { level: 0, tags: ['everyone'], userId: '', login: '' }],
  ['raw-level-no-clamp', { level: 10.5, tags: [], userId: '', login: 'x' }],
  ['negative-level', { level: -3, tags: ['broadcaster', 'everyone'] }],
  ['everyone-not-first', { level: 6, tags: ['founder', 'sub', 'everyone'] }],
  ['fractional-level', { level: 2.5, tags: ['sub'], login: 'VIEWER' }],
  ['unicode-login-lowercase', { level: 1, tags: [], login: 'İ_USER' }]
];
for (const [label, spec] of serializationSpecs) {
  const serialized = json(permissions.serializeUserIdentity(
    permissions.createUserIdentity(spec.level, spec.tags, spec.userId, spec.login)
  ));
  addCase('serialize_identity', `serialize:${label}`, spec, { expected: serialized });
}

const parseRaws = [
  ['absent', undefined, 3],
  ['null', null, 3],
  ['string-root', 'mod', 3],
  ['number-root', 7, 3],
  ['boolean-root', true, 3],
  ['array-root', [], 3],
  ['array-root-with-values', [1, 2], 3],
  ['empty-object', {}, 1],
  ['level-string', { level: 'nine' }, 3],
  ['level-string-numeric', { level: '7' }, 4],
  ['level-null', { level: null }, 3],
  ['level-zero', { level: 0 }, 2],
  ['level-99', { level: 99 }, 2],
  ['level-negative', { level: -5 }, 2],
  ['level-fraction-high', { level: 10.9 }, 2],
  ['level-fraction-low', { level: 0.5 }, 2],
  ['level-negative-fraction', { level: -0.5 }, 2],
  ['level-huge', { level: 1e21 }, 2],
  ['tags-string', { level: 3, tags: 'sub' }, 1],
  ['tags-mixed', { level: 5, tags: ['vip', 'nope', 'mod', 7, 'sub'] }, 1],
  ['tags-duplicates', { level: 7, tags: ['vip', 'vip', 'everyone'] }, 1],
  ['tags-everyone-first', { level: 2, tags: ['everyone', 'sub'] }, 1],
  ['userId-valid', { level: 7, userId: '12345' }, 1],
  ['userId-21-digits', { level: 7, userId: '123456789012345678901' }, 1],
  ['userId-non-digit', { level: 7, userId: 'abc' }, 1],
  ['userId-number', { level: 7, userId: 12345 }, 1],
  ['userId-empty', { level: 7, userId: '' }, 1],
  ['login-uppercase', { level: 7, login: 'USER_Name' }, 1],
  ['login-space', { level: 7, login: 'bad login' }, 1],
  ['login-single', { level: 7, login: 'a' }, 1],
  ['login-25', { level: 7, login: 'a'.repeat(25) }, 1],
  ['login-26', { level: 7, login: 'a'.repeat(26) }, 1],
  ['login-empty', { level: 7, login: '' }, 1],
  ['login-hyphen', { level: 7, login: 'bad-login' }, 1],
  ['full', { level: 7, tags: ['mod', 'sub'], userId: '12345', login: 'User123' }, 1],
  ['broadcaster-tag', { level: 1, tags: ['broadcaster'] }, 1]
];
for (const [label, raw, fallbackLevel] of parseRaws) {
  const actual = permissions.parseUserIdentity(raw, fallbackLevel);
  addCase('parse_identity', `parse:${label}`, {
    ...(raw === undefined ? {} : { raw }),
    fallbackLevel
  }, { expected: json(permissions.serializeUserIdentity(actual)) });
}

const badgeCases = [
  ['absent', undefined],
  ['null', null],
  ['empty', []],
  ['subscriber', [{ set_id: 'subscriber' }]],
  ['vip', [{ set_id: 'vip' }]],
  ['founder', [{ set_id: 'founder' }]],
  ['moderator', [{ set_id: 'moderator' }]],
  ['lead-moderator', [{ set_id: 'lead_moderator' }]],
  ['founder-then-subscriber', [{ set_id: 'founder' }, { set_id: 'subscriber' }]],
  ['subscriber-then-founder', [{ set_id: 'subscriber' }, { set_id: 'founder' }]],
  ['moderator-vip-subscriber', [{ set_id: 'moderator' }, { set_id: 'vip' }, { set_id: 'subscriber' }]],
  ['unknown', [{ set_id: 'partner' }]],
  ['broadcaster-badge', [{ set_id: 'broadcaster' }]],
  ['id-fallback', [{ id: 'vip' }]],
  ['null-set-id-id-fallback', [{ set_id: null, id: 'subscriber' }]],
  ['null-set-id-no-id', [{ set_id: null }]],
  ['empty-set-id', [{ set_id: '' }]],
  ['numeric-set-id', [{ set_id: 0 }]],
  ['boolean-set-id', [{ set_id: false }]],
  ['string-entry', ['vip']],
  ['number-entry', [5]],
  ['null-entry', [null]],
  ['nested-array-entry', [[{ set_id: 'vip' }]]],
  ['info-only', [{ id: 'ignored', info: '2' }]],
  ['all-badges', [
    { set_id: 'broadcaster' }, { set_id: 'moderator' }, { set_id: 'vip' },
    { set_id: 'founder' }, { set_id: 'subscriber' }
  ]],
  ['exponent-set-id', [{ set_id: 1e21 }]],
  ['tiny-set-id', [{ set_id: 1.5e-7 }]],
  ['array-set-id', [{ set_id: ['subscriber'] }]],
  ['object-set-id', [{ set_id: {} }]]
];
for (const [label, badges] of badgeCases) {
  addCase('badge_level', `badge-level:${label}`, {
    ...(badges === undefined ? {} : { badges })
  }, { expected: permissions.deriveBadgeLevel(badges) });
  addCase('badge_tags', `badge-tags:${label}`, {
    ...(badges === undefined ? {} : { badges })
  }, { expected: [...permissions.deriveBadgeTags(badges)] });
}

const roleValues = [
  ...permissions.ROLE_TAGS,
  'Broadcaster',
  'MOD',
  'subscriber',
  '',
  'mod ',
  'no'
];
for (const value of roleValues) {
  addCase('role_tag', `role-tag:${JSON.stringify(value)}`, { value }, {
    accepted: permissions.isRoleTag(value)
  });
}
for (const value of [null, 7, true, { role: 'mod' }]) {
  addCase('role_tag', `role-tag:${JSON.stringify(value)}-non-string`, { value }, { accepted: false });
}

const inspectInputs = [
  ['absent', undefined],
  ['null', null],
  ['role-everyone', { role: 'everyone' }],
  ['level-7', { level: 7 }],
  ['user-uppercase', { user: { id: '12345', login: 'USER123' } }],
  ['advanced', { or: [{ role: 'sub' }, { and: [{ role: 'vip' }, { not: { role: 'mod' } }] }] }],
  ['invalid-role', { role: 'supermod' }],
  ['invalid-empty', {}],
  ['invalid-array', [{ role: 'mod' }]],
  ['invalid-string', 'mod'],
  ['invalid-depth', { and: [{ or: [{ and: [{ not: { role: 'sub' } }] }] }] }],
  ['invalid-user', { user: { id: '12345', login: 'bad login' } }],
  ['valid-depth-4', { and: [{ or: [{ not: { role: 'sub' } }] }] }]
];
for (const [label, expression] of inspectInputs) {
  const input = expression === undefined ? {} : { expression };
  addCase('inspect', `inspect:${label}`, input, {
    expectedMode: permissions.inspectExpression(expression).mode
  });
}

const operationCounts = {};
for (const item of cases) operationCounts[item.operation] = (operationCounts[item.operation] ?? 0) + 1;
const corpusHash = sha256(JSON.stringify(cases));
const output = {
  schemaVersion: 1,
  description: 'Source-backed parity cases for dima_rust::utils::permissions. Generated from the actual TypeScript permission core; do not hand-edit.',
  identityContract: 'Identities are serialized createUserIdentity results. Rust rebuilds them with UserIdentity::new, so tag order and undefined-field omission are part of the comparison.',
  extraction: 'Only pure declarations are transpiled; imports, service setup, async role-cache access, and re-exports are excluded.',
  sources: Object.fromEntries(Object.entries(sources).sort()),
  fixtures: {
    'ops/fixtures/permission-expressions.json': sha256(sharedFixtureText)
  },
  counts: { cases: cases.length, ...Object.fromEntries(Object.entries(operationCounts).sort()) },
  corpusHash,
  cases
};

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes('--check')) {
  assert.equal(await readFile(outputUrl, 'utf8'), serialized, 'Fixture/source drift: regenerate permission_core_cases.json');
  console.log(`Checked ${cases.length} actual-source permission cases (${corpusHash.slice(0, 12)}) against ${Object.keys(sources).length} hashed TS sources.`);
} else {
  await writeFile(outputUrl, serialized);
  console.log(`Generated ${cases.length} actual-source permission cases (${corpusHash.slice(0, 12)}) from ${Object.keys(sources).length} hashed TS sources: ${JSON.stringify(operationCounts)}`);
}
