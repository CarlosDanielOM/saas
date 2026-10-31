// Actual-source oracle for the fired-timer context rebuild.
//
// Run from any directory with dimabot's installed TypeScript. Every statement
// below is extracted verbatim from the real sources; only application
// boundaries are stubbed (the Twitch directory, function registration, the
// evaluator and message delivery). The extraction proves the oracle is the
// source's own precedence rules, not a re-statement of them:
//
//   src/handlers/special_parser.userlevel.ts  resolveAuthoredAstUserLevel
//   src/handlers/special_parser.handler.ts    extraction, scope normalization,
//                                             createSpecialExecutionContext
//   src/utils/ast_parser/evaluator.ts         createExecutionContext (defaults)
//   src/utils/ast_parser/timer.ts             snapshotTimerContext
//   src/utils/ast_timer_runtime.ts            executeAstTimerJob
//
// The Rust test `native_context_rebuild_matches_the_actual_source_oracle`
// replays every `saved` object through the native rebuild and compares the
// captured context field by field, with the `<undefined>` marker preserving
// keys that JSON drops.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));

function declarations(file, names) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = parsed.statements.find(n =>
      (ts.isFunctionDeclaration(n) && n.name?.text === name) ||
      (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)));
    assert.ok(node, `missing ${name} in ${file}`);
    return node.getText(parsed).replace(/^export\s+/, '');
  }).join('\n');
}

const userLevel = declarations('src/handlers/special_parser.userlevel.ts', [
  'MODERATOR_BADGE_IDS', 'inferUserLevelFromBadges', 'hasChatChatterIdentity', 'resolveAuthoredAstUserLevel'
]);
const handler = declarations('src/handlers/special_parser.handler.ts', [
  'extractUserInfo', 'extractBroadcasterInfo', 'extractNumericFields',
  'normalizeScopeName', 'normalizeScopeNames', 'createSpecialExecutionContext'
]);
const evaluator = declarations('src/utils/ast_parser/evaluator.ts', ['createExecutionContext']);
const timer = declarations('src/utils/ast_parser/timer.ts', ['snapshotTimerContext']);
const execute = declarations('src/utils/ast_timer_runtime.ts', ['executeAstTimerJob']);

const source = ts.transpileModule(
  `${userLevel}\n${handler}\n${evaluator}\n${timer}\n${execute}\nmodule.exports = { snapshotTimerContext, executeAstTimerJob };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

let account = null;
let fail = false;
let captured;
const lookups = [];
const directory = {
  getTwitchAccountById: async id => {
    lookups.push(id);
    // The source catch block returns null after logging; the stub keeps only
    // the null-return half because its logger is an application boundary.
    return fail ? null : account;
  }
};
const modules = {
  '../handlers/special_parser.handler.js': {
    createSpecialExecutionContext: (...args) => context.createSpecialExecutionContext(...args)
  },
  './ast_parser/evaluator.js': {
    evaluate: async (_body, ctx) => {
      captured = ctx;
      return { value: '', context: ctx };
    }
  },
  './ast_command_delivery.js': { deliverAstMessage: async () => ({ error: false }) }
};
const context = vm.createContext({
  module: { exports: {} },
  require: key => {
    assert.ok(Object.hasOwn(modules, key), `unmocked import ${key}`);
    return modules[key];
  },
  TwitchStreamers: directory,
  registerAllFunctions() {}
});
vm.runInContext(source, context);

const FIELDS = [
  'streamer', 'userId', 'userLogin', 'userDisplayName', 'userPlan', 'userLevel',
  'enforceFunctionPermissions', 'authorization', 'argument', 'count', 'eventData',
  'eventsubData', 'extraContext', 'platform', 'scopeType', 'scopeName',
  'scopeAliases', 'commandName', 'commandId'
];

function summarize(ctx) {
  const out = {};
  for (const key of FIELDS) out[key] = ctx[key] === undefined ? '<undefined>' : ctx[key];
  return out;
}

async function run(saved) {
  captured = undefined;
  lookups.length = 0;
  await context.module.exports.executeAstTimerJob({
    version: 1, id: 'oracle', dueAt: 0, expiresAt: 0,
    body: { type: 'root', children: [] }, context: saved
  });
  assert.ok(captured, 'executeAstTimerJob must reach the evaluator');
  assert.deepEqual(lookups, [saved.broadcasterId], 'lookup uses the saved broadcaster');
  return summarize(captured);
}

const cases = [];
async function capture(name, savedInput, options = {}) {
  account = options.account === undefined ? null : options.account;
  fail = Boolean(options.lookupFails);
  // The cache stores the payload as JSON: undefined-valued keys are already
  // gone before executeAstTimerJob sees them.
  const saved = JSON.parse(JSON.stringify(savedInput));
  cases.push({ name, saved, account, lookupFails: fail, expected: await run(saved) });
}

const base = () => ({
  broadcasterId: 'chan', userId: 'saved-id', userLogin: 'saved-login', userDisplayName: 'saved-name',
  userPlan: 'premium', userLevel: 5, enforceFunctionPermissions: true,
  authorization: { origin: 'authored', identity: { level: 5, tags: [] } },
  argument: 'hello', count: 2, eventData: {}, eventsubData: {}, extraContext: {},
  platform: 'twitch', scopeType: 'command', scopeName: 'cmd', scopeAliases: [],
  commandName: 'cmd', commandId: 'cid', commandRefBudget: { remaining: 50 },
  commandRefDepth: 0, visitedCommands: [], commandResponses: [],
  variables: [], arrays: [], loopVars: [], timerDepth: 1
});

function expected(name) {
  const found = cases.find(entry => entry.name === name);
  assert.ok(found, `missing oracle case ${name}`);
  return found.expected;
}

(async () => {
  // 1. A live directory account supplies the streamer and the `userPlan`
  //    fallback; a saved `extraContext` replaces the derived object wholesale.
  {
    const saved = base();
    delete saved.userPlan;
    saved.eventData = { user_name: 'event-name', viewers: 12 };
    saved.extraContext = { userName: 'explicit' };
    await capture('live_streamer_and_saved_extra_wins_wholesale', saved, {
      account: { id: 'live-id', name: 'live-name', plan_tier: 'pro' }
    });
    const value = expected('live_streamer_and_saved_extra_wins_wholesale');
    assert.deepEqual(value.streamer, { id: 'live-id', name: 'live-name' });
    assert.equal(value.userPlan, 'pro');
    assert.deepEqual(value.extraContext, { userName: 'explicit' });
    assert.deepEqual(value.eventData, saved.eventData);
  }

  // 2. A failing lookup is null-on-error and the plan fallback is 'free'.
  {
    const saved = base();
    delete saved.userPlan;
    await capture('directory_failure_returns_null_streamer_and_free_plan', saved, { lookupFails: true });
    const value = expected('directory_failure_returns_null_streamer_and_free_plan');
    assert.equal(value.streamer, null);
    assert.equal(value.userPlan, 'free');
  }

  // 3. Missing scope keys derive from the eventsub name, normalized.
  {
    const saved = base();
    delete saved.scopeType;
    delete saved.scopeName;
    delete saved.commandName;
    saved.eventsubData = { name: 'Channel Points' };
    saved.eventData = { reward: { title: 'Ignored' } };
    await capture('missing_scope_fields_use_eventsub_name', saved);
    const value = expected('missing_scope_fields_use_eventsub_name');
    assert.equal(value.scopeType, 'command');
    assert.equal(value.scopeName, 'Channel_Points');
    assert.equal(value.commandName, 'Channel_Points');
  }

  // 4. The reward title is the last scope fallback.
  {
    const saved = base();
    delete saved.scopeType;
    delete saved.scopeName;
    delete saved.commandName;
    saved.eventsubData = {};
    saved.eventData = { reward: { title: 'Hydrate' } };
    await capture('reward_title_is_the_last_scope_fallback', saved);
    const value = expected('reward_title_is_the_last_scope_fallback');
    assert.equal(value.scopeName, 'Hydrate');
    assert.equal(value.commandName, 'Hydrate');
  }

  // 5. A present scopeName overlays raw; the derived commandName is normalized.
  {
    const saved = base();
    saved.scopeName = 'my command';
    delete saved.commandName;
    await capture('explicit_scope_name_is_raw_but_command_name_is_normalized', saved);
    const value = expected('explicit_scope_name_is_raw_but_command_name_is_normalized');
    assert.equal(value.scopeName, 'my command');
    assert.equal(value.commandName, 'my_command');
  }

  // 6. A present empty scopeName stays empty while commandName still derives.
  {
    const saved = base();
    saved.scopeName = '';
    delete saved.commandName;
    saved.eventsubData = { name: 'Sub' };
    await capture('empty_scope_name_stays_empty_while_command_name_derives', saved);
    const value = expected('empty_scope_name_stays_empty_while_command_name_derives');
    assert.equal(value.scopeName, '');
    assert.equal(value.commandName, 'Sub');
  }

  // 7. Missing identity keys fall back to the saved event.
  {
    const saved = base();
    delete saved.userId;
    delete saved.userLogin;
    delete saved.userDisplayName;
    delete saved.extraContext;
    saved.eventData = { user_id: 'evt-id', user_login: 'evt-login', user_name: 'Evt Name' };
    await capture('missing_identity_fields_fall_back_to_saved_event', saved);
    const value = expected('missing_identity_fields_fall_back_to_saved_event');
    assert.equal(value.userId, 'evt-id');
    assert.equal(value.userLogin, 'evt-login');
    assert.equal(value.userDisplayName, 'Evt Name');
    assert.equal(value.extraContext.userID, 'evt-id');
    assert.equal(value.extraContext.userName, 'Evt Name');
  }

  // 8. Saved identity wins and is injected into the extraction, ahead of the
  //    saved event's own user_* fields.
  {
    const saved = base();
    delete saved.extraContext;
    saved.eventData = { user_id: 'evt-id', user_login: 'evt-login', user_name: 'Evt Name' };
    await capture('saved_identity_wins_and_is_injected_into_extraction', saved);
    const value = expected('saved_identity_wins_and_is_injected_into_extraction');
    assert.equal(value.userId, 'saved-id');
    assert.equal(value.userLogin, 'saved-login');
    assert.equal(value.extraContext.userID, 'saved-id');
    assert.equal(value.extraContext.userLogin, 'saved-login');
    assert.equal(value.extraContext.userName, 'saved-name');
  }

  // 9. A missing eventData becomes the injected identity object.
  {
    const saved = base();
    delete saved.eventData;
    delete saved.extraContext;
    await capture('missing_event_data_yields_the_injected_identity_object', saved);
    const value = expected('missing_event_data_yields_the_injected_identity_object');
    assert.deepEqual(value.eventData, {
      chatter_user_id: 'saved-id',
      chatter_user_login: 'saved-login',
      chatter_user_name: 'saved-name'
    });
    assert.equal(value.extraContext.userID, 'saved-id');
  }

  // 10. A missing eventsubData is `{}` and the scope default is 'default'.
  {
    const saved = base();
    delete saved.eventsubData;
    delete saved.scopeName;
    delete saved.commandName;
    await capture('absent_eventsub_data_is_an_empty_object', saved);
    const value = expected('absent_eventsub_data_is_an_empty_object');
    assert.deepEqual(value.eventsubData, {});
    assert.equal(value.scopeName, 'default');
    assert.equal(value.commandName, 'default');
  }

  // 11. A present null extraContext is kept; it is not the missing-key default.
  {
    const saved = base();
    saved.extraContext = null;
    await capture('null_extra_context_is_not_replaced_by_the_derived_base', saved);
    assert.equal(expected('null_extra_context_is_not_replaced_by_the_derived_base').extraContext, null);
  }

  // 12. An absent identity has no chatter identity, so the authored default is
  //     broadcaster level 10 with a matching authorization.
  {
    const saved = base();
    delete saved.userId;
    delete saved.userLogin;
    delete saved.userDisplayName;
    delete saved.eventData;
    delete saved.extraContext;
    delete saved.authorization;
    delete saved.userLevel;
    delete saved.enforceFunctionPermissions;
    await capture('absent_identity_authorization_is_the_broadcaster_default', saved);
    const value = expected('absent_identity_authorization_is_the_broadcaster_default');
    assert.equal(value.userId, '');
    assert.equal(value.userDisplayName, '');
    assert.equal(value.userLevel, 10);
    assert.equal(value.enforceFunctionPermissions, false);
    assert.deepEqual(value.authorization, { origin: 'authored', identity: { level: 10, tags: ['broadcaster'] } });
  }

  // 13. A moderator badge lifts the inferred level when the snapshot has none.
  {
    const saved = base();
    delete saved.userLevel;
    delete saved.authorization;
    saved.eventData = { badges: [{ set_id: 'moderator' }] };
    await capture('moderator_badge_lifts_a_missing_saved_level', saved);
    const value = expected('moderator_badge_lifts_a_missing_saved_level');
    assert.equal(value.userLevel, 7);
    assert.deepEqual(value.authorization, { origin: 'authored', identity: { level: 7, tags: [] } });
  }

  // 14. Saved authorization and permissions overlay the authored base raw.
  {
    const saved = base();
    saved.authorization = { origin: 'manual', identity: { level: 42, tags: ['custom'] } };
    saved.enforceFunctionPermissions = false;
    await capture('saved_authorization_and_permissions_overlay', saved);
    const value = expected('saved_authorization_and_permissions_overlay');
    assert.deepEqual(value.authorization, saved.authorization);
    assert.equal(value.enforceFunctionPermissions, false);
  }

  // 15. A real snapshot round trip restores every carried field.
  {
    const live = context.createExecutionContext({
      broadcasterId: 'chan', userId: 'u-1', userLogin: 'login', userDisplayName: 'Name',
      userPlan: 'premium', userLevel: 5, enforceFunctionPermissions: true,
      authorization: { origin: 'authored', identity: { level: 5, tags: [] } },
      argument: 'arg', count: 4,
      eventData: { user_id: 'u-1', user_login: 'login', user_name: 'Name' },
      eventsubData: { name: 'Points' }, extraContext: { custom: 'value' },
      platform: 'twitch', scopeType: 'event', scopeName: 'redeem', scopeAliases: ['alias'],
      commandName: 'redeem', commandId: 'cid', commandRefBudget: { remaining: 7 },
      commandRefDepth: 2, visitedCommands: ['c1', 'c1'], timerDepth: 3,
      variables: new Map([['v', '1']]),
      arrays: new Map([['a', ['x']]]),
      loopVars: new Map([['i', '0']]),
      commandResponses: [{ text: 'r' }]
    });
    const snapshot = context.snapshotTimerContext(live);
    await capture('real_snapshot_round_trip', snapshot, {
      account: { id: 'live-id', name: 'live-name', plan_tier: 'free' }
    });
    const value = expected('real_snapshot_round_trip');
    assert.equal(value.userId, 'u-1');
    assert.equal(value.userDisplayName, 'Name');
    assert.equal(value.userPlan, 'premium');
    assert.equal(value.userLevel, 5);
    assert.equal(value.argument, 'arg');
    assert.equal(value.count, 4);
    assert.equal(value.scopeType, 'event');
    assert.equal(value.scopeName, 'redeem');
    assert.equal(value.commandName, 'redeem');
    assert.deepEqual(value.extraContext, { custom: 'value' });
  }

  // 16. A real snapshot drops the undefined optionals, so the base half has to
  //     recreate them; present snapshot defaults still win over the plan tier.
  {
    const live = context.createExecutionContext({
      broadcasterId: 'chan', userId: 'u-2', userLogin: 'login2', userDisplayName: 'Name2'
    });
    const snapshot = context.snapshotTimerContext(live);
    await capture('real_snapshot_missing_optional_fields', snapshot, {
      account: { id: 'live-id', name: 'live-name', plan_tier: 'premium' }
    });
    const value = expected('real_snapshot_missing_optional_fields');
    assert.equal(value.argument, '<undefined>');
    assert.deepEqual(value.eventsubData, {});
    assert.equal(value.userPlan, 'free');
    assert.equal(value.userLevel, 1);
    assert.equal(value.scopeName, '');
    assert.equal(value.commandName, '');
    assert.deepEqual(value.authorization, { origin: 'authored', identity: { level: 1, tags: [] } });
    assert.deepEqual(value.eventData, {
      chatter_user_id: 'u-2',
      chatter_user_login: 'login2',
      chatter_user_name: 'Name2'
    });
    assert.equal(value.extraContext.userID, 'u-2');
  }

  process.stdout.write(JSON.stringify({ cases }) + '\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
