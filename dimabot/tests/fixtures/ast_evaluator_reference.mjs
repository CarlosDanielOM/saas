// Source-parity oracle only. No services, function barrels, env, clock or IO handlers.
// node dimabot/tests/fixtures/ast_evaluator_reference.mjs [--check]
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import ts from '../../node_modules/typescript/lib/typescript.js';

const repo = new URL('../../../', import.meta.url);
const output = new URL('ast_evaluator_cases.json', import.meta.url);
const base = 'dimabot/src/utils/ast_parser/';
const modules = ['types', 'evaluator', 'parser', 'tokenizer', 'registry', 'render', 'timer', 'effects'].map(n => `${base}${n}.ts`);
const builtinPaths = ['count','delay'].map(n => `${base}functions/${n}.functions.ts`);
const rolesPath = 'dimabot/src/utils/permissions/roles.ts';
const testNames = ['arrays', 'loop', 'ternary', 'permission_gate', 'permission_gate_authored', 'user_scope', 'user_scope_cache', 'persistent_delete', 'command_references', 'timer', 'syntax_errors', 'parens'];
const usedTests = testNames.map(n => `${base}${n}.test.ts`);
const sha256 = text => createHash('sha256').update(text).digest('hex');
// Populated from the reviewed TypeScript sources, never from Rust results.
const EXPECTED_SOURCE_HASHES = {
  "dimabot/src/utils/ast_parser/types.ts": "5049d49cbab203daa16d3430f7d0fca25841a21b8d6d8e0ae58633134394f35f",
  "dimabot/src/utils/ast_parser/evaluator.ts": "495aa21379c8b3db36cd4e1c7ce262d1f071014aba1ad6328a66b1de6fd7b4c0",
  "dimabot/src/utils/ast_parser/parser.ts": "be2d5d8f44695fff0186cc672fdd4a3b9454860fafd2aaf2016efbcf0a0e2294",
  "dimabot/src/utils/ast_parser/tokenizer.ts": "31573e058312acda39169f9679624f83cc238ae5c5d0a5d4572369f8b526bdc9",
  "dimabot/src/utils/ast_parser/registry.ts": "ccab7267cd2f00afb19bd5057ffc9674aea48577c56884e59da85bc36d8abe93",
  "dimabot/src/utils/ast_parser/render.ts": "b2fa411ec05dbb790a89185b9f81e834d4b0546338081801bd486c2eea3987aa",
  "dimabot/src/utils/ast_parser/timer.ts": "e526adf5867bab0ae77b03366143596b55b77dcf98efbd3849bc6585f053792b",
  "dimabot/src/utils/ast_parser/effects.ts": "34a56b45cb579eeeb06ad2fcdf6a2b006acb0ae4b6cbe229950be6c777c5693d",
  "dimabot/src/utils/ast_parser/functions/count.functions.ts": "ad08170f29a9e3d9d7f6f48bea721370eb52d96f58c46d29b7746a210f363117",
  "dimabot/src/utils/ast_parser/functions/delay.functions.ts": "145392681f0ed04544aabe5914df3d4653a4f51ea16683d68253823e5e36fb25",
  "dimabot/src/utils/permissions/roles.ts": "9469ce3029c6aedce85cc7a6ad3c180adf097051ef6d5c1aa0cac68b7396df20",
  "dimabot/src/utils/ast_parser/arrays.test.ts": "8cf050b9ca6a7850ef5d84521f6085b50e2234d30818b05ccd3a42a88a7a085e",
  "dimabot/src/utils/ast_parser/loop.test.ts": "50a38829133044574c0b9e33d5ca5a58571f73a7299a46120f619d553fd3658b",
  "dimabot/src/utils/ast_parser/ternary.test.ts": "d8ad0eaa4054f1f7147bf460c9266bd92aba7b1d65835b68186982d5a052c1b6",
  "dimabot/src/utils/ast_parser/permission_gate.test.ts": "c76f81930603df3c485988a0de6abbf84150c467aabad6863437ea5edc166e0d",
  "dimabot/src/utils/ast_parser/permission_gate_authored.test.ts": "753416c5ca82cf0c6a093e3190e781f62c7122df0f1cd58b6906ad255cd80a9f",
  "dimabot/src/utils/ast_parser/user_scope.test.ts": "8016b9b640fa94c5cb6a4e53d7be8f7c4a3890b2c3450e53423b3f5af7bc2249",
  "dimabot/src/utils/ast_parser/user_scope_cache.test.ts": "e68328f178c7c47214215432d6645069d3ea739a0b6abb62add65854006dc47c",
  "dimabot/src/utils/ast_parser/persistent_delete.test.ts": "42af22ea9181a0e154d7b949ee380bd95af4cbd3c6b358a26175563a4f845ecc",
  "dimabot/src/utils/ast_parser/command_references.test.ts": "e9e86eeafbc0e68072e7249a3f9f7c505eb076d76c844c60e98d6ad44506c3f3",
  "dimabot/src/utils/ast_parser/timer.test.ts": "3840ea98d0bd4665ae7ac4ea336f52e0f18f4c51f6dd2a487051aceaed24cbed",
  "dimabot/src/utils/ast_parser/syntax_errors.test.ts": "9e035dd4a514f4b2ae48f638a79aeac2ff6dc7e5874d7797b6dc1b6c26e6d34c",
  "dimabot/src/utils/ast_parser/parens.test.ts": "3095ae6216ee315413d3d0db486fc48171772d6b20b9cb3364f32ffa92d6c33b"
};
const roleSelections = ['ROLE_TAGS', 'ROLE_TAG_SET', 'BROADCASTER_USER_LEVEL', 'isRoleTag', 'createUserIdentity', 'createBroadcasterIdentity', 'parseUserIdentity'];

// Additive prepared-source bridge: callers may supply narrowly selected extra
// modules/tests. Baseline hashes/selection and the old corpus remain independent.
export async function buildSourceBundle(options = {}) {
  const texts = {}, hashes = {}, code = {};
  for (const path of [...modules, ...builtinPaths, rolesPath, ...usedTests]) {
    texts[path] = await readFile(new URL(path, repo), 'utf8');
    hashes[path] = sha256(texts[path]);
  }
  if (Object.keys(EXPECTED_SOURCE_HASHES).length) assert.deepEqual(hashes, EXPECTED_SOURCE_HASHES, 'source hash drift: review source parity before updating guards');
  for (const path of [...(options.extraModules ?? []), ...(options.extraSources ?? [])]) {
    assert(!Object.hasOwn(texts,path), `duplicate source bridge path: ${path}`);
    texts[path] = await readFile(new URL(path,repo),'utf8');
    hashes[path] = sha256(texts[path]);
  }
  for (const path of [...modules, ...builtinPaths, rolesPath, ...(options.extraModules ?? [])]) {
    let text = texts[path];
    if (options.transformSource) text = options.transformSource(path,text);
    if (path === rolesPath) {
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const found = [];
      text = ast.statements.filter(s => {
        const names = ts.isFunctionDeclaration(s) ? [s.name?.text] : ts.isVariableStatement(s) ? s.declarationList.declarations.map(d => d.name.getText(ast)) : [];
        if (!names.length || !names.every(n => roleSelections.includes(n))) return false;
        found.push(...names); return true;
      }).map(s => s.getText(ast)).join('\n');
      assert.deepEqual(found.sort(), [...roleSelections].sort(), 'pure role declaration drift');
    }
    if (path === `${base}functions/delay.functions.ts`) {
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const wanted = ['breakHandler','continueHandler'], found = [];
      text = ast.statements.filter(statement => {
        if (!ts.isVariableStatement(statement)) return false;
        const names = statement.declarationList.declarations.map(d => d.name.getText(ast));
        if (!names.length || !names.every(n => wanted.includes(n))) return false;
        found.push(...names); return true;
      }).map(statement => statement.getText(ast)).join('\n');
      assert.deepEqual(found.sort(),wanted.sort(),'pure loop-exit handler selection drift');
      text += '\nexport {breakHandler,continueHandler};';
    }
    const transpiled = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.equal((transpiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, path);
    code[path] = transpiled.outputText;
    if (path === `${base}functions/delay.functions.ts`) assert(!/delayHandler|setTimeout|registerDelayFunctions/.test(code[path]),'only pure loop-exit handlers may execute');
  }
  assert.match(texts[`${base}types.ts`], /'root'.*'forLoop'/);
  assert.match(texts[`${base}evaluator.ts`], /depth >= 5 \|\| visited.has\(key\) \|\| context.commandRefBudget.remaining <= 0/);
  assert.match(texts[`${base}timer.test.ts`], /cache snapshot preserves identity/);
  assert.match(texts[`${base}user_scope_cache.test.ts`], /twitch:channel:variable:score:id:caller-id/);
  return { code, hashes };
}

const sourceBundle = () => buildSourceBundle();

// Self-contained runtime shared by ordinary generator and serialized offline loader.
// Only actual source is transpiled. Host adapters below are deterministic test fakes.
function runtimeFactory(code, vm, contextBuiltins = false, options = {}) {
  let builtinOracle, pureOracle;
  const base = 'dimabot/src/utils/ast_parser/';
  let active;
  const moduleCache = new Map();
  function decodeKey(key) {
    if (typeof key === 'string') return key;
    if (key && typeof key === 'object' && Object.keys(key).length === 1 && Array.isArray(key.utf16) && key.utf16.every(unit => Number.isInteger(unit) && unit >= 0 && unit <= 65535)) return String.fromCharCode(...key.utf16);
    throw new TypeError('Invalid fixture string-key transport');
  }
  function transportKey(key) {
    const encoded = typed(key);
    return encoded.utf16 ? {utf16:encoded.utf16} : key;
  }
  function decode(value) {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && Object.keys(value).length === 1 && '$object' in value) return Object.fromEntries(value.$object.map(([k,v])=>[decodeKey(k),decode(v)]));
    if (!Array.isArray(value) && Object.keys(value).length === 1 && '$utf16' in value) return String.fromCharCode(...value.$utf16);
    if (!Array.isArray(value) && Object.keys(value).length === 1 && '$value' in value) {
      switch (value.$value) {
        case 'undefined': return undefined;
        case 'NaN': return NaN;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        case '-0': return -0;
        case 'function': return function fixtureFunction() {};
        default: throw new Error('Unknown typed input marker');
      }
    }
    if (Array.isArray(value)) return value.map(decode);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  function typed(value) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null' };
    const type = typeof value;
    if (type === 'number') return { type, value: Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : value };
    if (type === 'function') return { type, name: value.name };
    if (type === 'string') {
      const units = Array.from({length:value.length},(_,i)=>value.charCodeAt(i));
      if (units.some((u,i)=>u>=0xD800&&u<=0xDBFF ? !(units[i+1]>=0xDC00&&units[i+1]<=0xDFFF) : u>=0xDC00&&u<=0xDFFF && !(units[i-1]>=0xD800&&units[i-1]<=0xDBFF))) return {type,utf16:units};
      return {type,value};
    }
    if (type === 'boolean') return { type, value };
    if (Array.isArray(value)) return { type: 'array', value: Array.from(value, typed) };
    if (Object.prototype.toString.call(value) === '[object Set]') return { type: 'array', value: [...value].map(typed) };
    if (Object.prototype.toString.call(value) === '[object Map]') return { type: 'array', value: [...value].map(typed) };
    return { type: 'object', value: Object.keys(value).map(k => [transportKey(k), typed(value[k])]) };
  }
  const event = (name, ...args) => {
    active.events.push([name, ...args]);
    if (active.throwOn === name) throw new Error(`fixture host failure: ${name}`);
  };
  // Test hash is deliberately not a cryptographic authority implementation.
  // effects.ts control flow is actual; digest fake is labeled in every event.
  const fakeCrypto = { createHash(algorithm) {
    let input = '';
    return { update(text) { input += text; return this; }, digest(format) {
      event('deterministic fake host event: effect hash', algorithm, input, format);
      return `fixture-hash:${input}`;
    } };
  } };
  const math = Object.create(Math);
  math.random = () => {
    active.seed = (Math.imul(active.seed, 1664525) + 1013904223) >>> 0;
    const value = active.seed / 4294967296;
    event('random', value); return value;
  };
  const sandbox = vm.createContext({
    Math: math,
    Date: Object.freeze({ parse: text => text === '2026-01-01T00:00:00.000Z' ? 1767225600000 : NaN }),
    console: { error: (message, detail) => event('console.error', message, detail?.channelID, detail?.error?.message) },
    process: undefined, fetch: undefined, setTimeout: undefined, setInterval: undefined
  });
  function resolve(path, name) {
    if (!name.startsWith('.')) return name;
    const parts = path.split('/'); parts.pop();
    for (const part of name.replace(/\.js$/, '.ts').split('/')) {
      if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);
    }
    return parts.join('/');
  }
  const redis = {};
  for (const method of ['get', 'exists', 'set', 'expire', 'del']) redis[method] = async (...args) => {
    event(`cache.${method}`, ...args);
    const [key, value] = args;
    switch (method) {
      case 'get': return active.cache.has(key) ? active.cache.get(key) : null;
      case 'exists': return active.cache.has(key) ? 1 : 0;
      case 'set': active.cache.set(key, value); return 'OK';
      case 'expire': return active.cache.has(key) ? 1 : 0;
      case 'del': return active.cache.delete(key) ? 1 : 0;
    }
  };
  function load(path) {
    if (path === 'node:crypto') return fakeCrypto;
    if (path === 'dimabot/src/utils/databases/dragonfly.database.ts') return { getDragonflyClient: async () => { event('cache.client'); return redis; } };
    if (!Object.hasOwn(code, path)) throw new Error(`Forbidden source import: ${path}`);
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    const module = { exports: {} }; moduleCache.set(path, module);
    const compiled = new vm.Script(`(function(exports,require,module){${code[path]}\n})`, { filename: path });
    compiled.runInContext(sandbox, { timeout: 2000 })(module.exports, name => load(resolve(path, name)), module);
    return module.exports;
  }
  const api = load(`${base}evaluator.ts`);
  const parser = load(`${base}parser.ts`);
  const render = load(`${base}render.ts`);
  const timer = load(`${base}timer.ts`);
  const effects = load(`${base}effects.ts`);
  // Preserve actual timer.ts while injecting its explicit scheduler argument.
  // Dynamic import('./timer.js') in transpiled evaluator resolves this wrapper.
  const evaluateTimerSource = timer.evaluateTimer;
  timer.evaluateTimer = (node, context) => evaluateTimerSource(node, context, async (seconds, body, ctx) => {
    const snapshot = timer.snapshotTimerContext(ctx);
    const capture = { seconds, body, snapshot, context: ctx,
      identity: { budgetCopied: snapshot.commandRefBudget !== ctx.commandRefBudget,
        responsesShared: snapshot.commandResponses === ctx.commandResponses,
        variableEntriesCopied: snapshot.variables !== ctx.variables,
        effectStripped: ctx.effectContext === undefined,
        callbacksOmitted: !Object.hasOwn(snapshot, 'loadChannelVariable'),
        commandVariablesOmitted: !Object.hasOwn(snapshot, 'commandVariables') } };
    active.timers.push(capture);
    event('timer.schedule', seconds, body, snapshot, capture.identity);
    if (active.schedulerThrows) throw new Error('fixture scheduler failure');
  });
  function install(name, handler, minUserLevel) {
    api.registerFunction(name, async (args, ctx) => { event('handler', name, args); return handler(args, ctx); },
      minUserLevel === undefined ? undefined : { description: 'deterministic fixture', syntax: name, category: 'fixture', examples: [], minUserLevel });
  }
  install('fixture.echo', args => args.map(v => String(v ?? '')).join('|'));
  install('fixture.value', args => args.length ? args[0] : active.returnValue);
  install('fixture.count', (_args, ctx) => { ctx.count++; ctx.countModified = true; return String(ctx.count); });
  install('fixture.write', (args, ctx) => { ctx.variables.set(String(args[0]), args[1]); return args[1]; });
  install('fixture.throw', () => { throw new TypeError('fixture handler throw'); });
  install('fixture.gated7', () => 'ran-7', 7);
  install('fixture.gated8', () => 'ran-8', 8);
  if (contextBuiltins) {
    load(`${base}functions/count.functions.ts`).registerCountFunctions();
    const exits = load(`${base}functions/delay.functions.ts`);
    api.registerFunction('break',exits.breakHandler);
    api.registerFunction('continue',exits.continueHandler);
  } else {
    install('break', (_args, ctx) => { if (ctx.loopDepth > 0) ctx.loopExit = 'break'; return ''; });
    install('continue', (_args, ctx) => { if (ctx.loopDepth > 0) ctx.loopExit = 'continue'; return ''; });
  }
  if (options.pureBuiltins) for (const registration of options.registrations ?? []) {
    load(registration.path)[registration.exportName]();
  }
  for (const override of options.functionOverrides ?? []) {
    const handler = api.getFunctionHandler(override.handler);
    if (!handler) throw new Error(`Unknown fixture override handler: ${override.handler}`);
    api.registerFunction(override.name,handler,override.metadata);
  }
  install('fixture.effect', (_args, ctx) => {
    const value = effects.nextPetAction(ctx.effectContext, ctx.broadcasterId);
    event('deterministic fake host event: effect action', value); return value;
  });
  const mapFields = ['variables', 'arrays', 'loopVars', 'commandVariables', 'userCommandVariables'];
  const scalarFields = ['broadcasterId', 'userId', 'userLogin', 'userDisplayName', 'userPlan', 'userLevel', 'enforceFunctionPermissions', 'authorization', 'argument', 'count', 'countModified', 'eventData', 'eventsubData', 'extraContext', 'streamer', 'platform', 'scopeType', 'scopeName', 'scopeAliases', 'commandName', 'commandId', 'loopExit', 'loopDepth', 'timerDepth', 'commandRefDepth'];
  function fresh(input) {
    const overrides = decode(input.context ?? {});
    for (const field of mapFields) if (Object.hasOwn(overrides, field)) overrides[field] = new Map(overrides[field].map(([key,value])=>[decodeKey(key),value]));
    if (Object.hasOwn(overrides, 'visitedCommands')) overrides.visitedCommands = new Set(overrides.visitedCommands);
    const spec = decode(input.host ?? {});
    const host = { events: [], timers: [], cache: new Map((spec.cache ?? []).map(([key,value])=>[decodeKey(key),value])), db: new Map((spec.db ?? []).map(([key,value])=>[decodeKey(key),value])), dbUser: new Map((spec.dbUser ?? []).map(([key,value])=>[decodeKey(key),value])), seed: (spec.randomSeed ?? 1) >>> 0, schedulerThrows: spec.schedulerThrows ?? false, returnValue: spec.returnValue, throwOn: spec.throwOn };
    active = host;
    const ctx = api.createExecutionContext({ broadcasterId: '123', userId: '456', userLogin: 'caller', userDisplayName: 'Caller', ...overrides });
    if (overrides.effect) {
      delete ctx.effect;
      const authority = effects.createTwitchEffectContext({ channelId: ctx.broadcasterId, origin: { id: 'fixture-event', kind: 'chat-command', occurredAt: '2026-01-01T00:00:00.000Z' }, actor: { userId: '456', displayName: 'Caller' } });
      ctx.effectContext = effects.scopeAstEffectContext(authority, ctx.broadcasterId, 'fixture-config');
    }
    ctx.loadChannelVariable = async name => { event('db.load', name); return host.db.has(name) ? host.db.get(name) : ''; };
    ctx.saveChannelVariable = async (name, value) => { event('db.save', name, value); host.db.set(name, value); };
    ctx.deleteChannelVariable = async name => { event('db.delete', name); host.db.delete(name); };
    const userKey = (name, target) => `${name}:${target ?? ctx.userLogin}`;
    ctx.loadUserVariable = async (name, target) => { event('dbUser.load', name, target); const key = userKey(name, target); return host.dbUser.has(key) ? host.dbUser.get(key) : ''; };
    ctx.saveUserVariable = async (name, value, target) => { event('dbUser.save', name, value, target); host.dbUser.set(userKey(name, target), value); };
    ctx.deleteUserVariable = async (name, target) => { event('dbUser.delete', name, target); host.dbUser.delete(userKey(name, target)); };
    ctx.saveResponses = async () => { event('responses.save', [...ctx.commandResponses]); };
    return { ctx, host };
  }
  function compile(input) {
    const operation = input.operation ?? 'evaluate';
    if (operation === 'parseEvaluate') {
      const parsed = parser.parse(input.text);
      return { operation, ast: parsed.ast, parseError: parsed.error };
    }
    if (operation === 'preparedRender') return { operation, segments: render.scanSourceSegments(input.text).map(s => s.kind === 'expr' ? { ...s, parsed: parser.parse(s.source) } : s) };
    return { operation, ast: decode(input.ast) };
  }
  function prepareBenchmark(definition) {
    const input = definition.input ?? definition;
    if (input.contextBuiltins && !contextBuiltins) {
      builtinOracle ??= runtimeFactory(code,vm,true,options);
      return builtinOracle.prepareBenchmark(definition);
    }
    if (input.pureBuiltins && !options.pureBuiltins) {
      pureOracle ??= runtimeFactory(code,vm,contextBuiltins,{...options,pureBuiltins:true});
      return pureOracle.prepareBenchmark(definition);
    }
    const prepared = compile(input);
    const sample = fresh(input).ctx;
    const baseline = Object.fromEntries(scalarFields.map(k => [k, JSON.stringify(typed(sample[k]))]));
    return async function run() {
      const { ctx, host } = fresh(input);
      let result, error, parseError;
      try {
        if (prepared.operation === 'parseEvaluate' && prepared.parseError) parseError = prepared.parseError;
        else if (prepared.operation === 'render') {
          const rendered = await render.renderAstWithSourceReference(input.text, ctx);
          result = { value: rendered.parsedText, context: rendered.context };
        } else if (prepared.operation === 'preparedRender') {
          // Assembly from actual scanner/parser/evaluator primitives. It mirrors
          // render.ts joining/error policy; this is explicitly not the unchanged renderer.
          let text = '', context = ctx;
          for (const segment of prepared.segments) {
            if (segment.kind === 'text') text += segment.text;
            else if (segment.kind === 'unclosed') { text += '[Parse error: Unclosed expression]'; break; }
            else if (segment.parsed.error) text += `[Parse error: ${segment.parsed.error}]`;
            else { const next = await api.evaluate(segment.parsed.ast, context); context = next.context; text += String(next.value ?? ''); }
          }
          result = { value: text, context };
        } else if (prepared.operation === 'timer') result = await timer.evaluateTimer(prepared.ast, ctx);
        else if (prepared.operation === 'snapshot') result = { value: timer.snapshotTimerContext(ctx), context: ctx };
        else result = await api.evaluate(prepared.ast, ctx);
      } catch (caught) { error = { name: caught.name, message: caught.message }; }
      return { result, error, parseError, initialContext: ctx, baseline, host, normalizeObservation };
    };
  }
  function contextObservation(ctx, raw) {
    const initial = raw.initialContext;
    return {
      scalarDeltas: scalarFields.filter(k => JSON.stringify(typed(ctx[k])) !== raw.baseline[k]).map(k => [k, typed(ctx[k])]),
      maps: Object.fromEntries(mapFields.map(k => [k, [...(ctx[k] ?? [])].map(([key, value]) => [transportKey(key), typed(value)])])),
      commandResponses: typed(ctx.commandResponses),
      commandReferences: typed(ctx.commandReferences.map(ref => ({
        ...ref, effectContext: ref.effectContext ? { authority: 'isolated-source-synthetic' } : undefined
      }))),
      budget: typed(ctx.commandRefBudget), visitedCommands: typed([...(ctx.visitedCommands ?? [])]),
      identity: { sameContext: ctx === initial, sameLoopVars: ctx.loopVars === initial.loopVars,
        sameVariables: ctx.variables === initial.variables, sameBudget: ctx.commandRefBudget === initial.commandRefBudget,
        referenceBudgetsShared: Array.from(ctx.commandReferences, ref => ref.state.commandRefBudget === ctx.commandRefBudget) }
    };
  }
  function normalizeObservation(raw) {
    const ctx = raw.result?.context ?? raw.initialContext;
    return {
      ...(raw.error ? { outcome: 'thrown', error: raw.error } : raw.parseError ? { outcome: 'parse-error', error: raw.parseError } : { outcome: 'returned', value: typed(raw.result.value) }),
      context: contextObservation(ctx, raw), initialContext: contextObservation(raw.initialContext, raw),
      host: { events: raw.host.events.map(typed), cache: [...raw.host.cache].map(([k,v]) => [transportKey(k),typed(v)]), db: [...raw.host.db].map(([k,v]) => [transportKey(k),typed(v)]), dbUser: [...raw.host.dbUser].map(([k,v]) => [transportKey(k),typed(v)]),
        timers: raw.host.timers.map(t => typed({ seconds: t.seconds, body: t.body, snapshot: t.snapshot, identity: t.identity,
          after: { snapshotBudget: t.snapshot.commandRefBudget.remaining, callerBudget: ctx.commandRefBudget.remaining,
            snapshotVariables: t.snapshot.variables, snapshotResponses: t.snapshot.commandResponses } })) }
    };
  }
  return { getRegistryMetadata: () => api.getAllRegisteredFunctions().map(({name,metadata})=>({name,metadata})), prepareBenchmark, normalizeObservation, execute: async input => normalizeObservation(await prepareBenchmark({input})()) };
}

// The pure corpus serializes this SAME factory, including typed/context/host
// observation logic; no duplicated evaluator, loader or normalization semantics.
export function createPreparedSourceOracle(code, options = {}) { return runtimeFactory(code,vm,false,options); }
export function preparedSourceLoaderTransport(code, options = {}) {
  return `async function createSourceOracle(){const vm=await import('node:vm');return (${runtimeFactory.toString()})(${JSON.stringify(code)},vm,false,${JSON.stringify(options)});}`;
}

export async function createSourceOracle() { return runtimeFactory((await sourceBundle()).code, vm); }
export async function sourceLoaderTransport() {
  const bundle = await sourceBundle();
  return `async function createSourceOracle(){const vm=await import('node:vm');return (${runtimeFactory.toString()})(${JSON.stringify(bundle.code)},vm);}`;
}
export async function prepareBenchmark(definition, oracle) { return (oracle ?? await createSourceOracle()).prepareBenchmark(definition); }
// Pure normalizer from a loader is exported as a convenience without loading TS.
export function normalizeObservation(raw) { return raw.normalizeObservation(raw); }

const lit = value => ({ type: 'literal', value });
const fn = (name, ...args) => ({ type: 'function', name, args });
const root = (...children) => ({ type: 'root', children });
const get = (storage, name = 'items', accessor, userSelector) => ({ type: 'getVar', name, storage, ...(accessor ? { accessor } : {}), ...(userSelector ? { userSelector } : {}) });
const set = (storage, value, name = 'items', accessor, userSelector) => ({ type: 'setVar', name, storage, value, ...(accessor ? { accessor } : {}), ...(userSelector ? { userSelector } : {}) });
const exists = (storage, name = 'items', accessor, userSelector) => ({ ...get(storage, name, accessor, userSelector), type: 'exists' });
const del = (storage, name = 'items', accessor, userSelector) => ({ ...get(storage, name, accessor, userSelector), type: 'deleteVar' });
const binary = (operator, left, right) => ({ type: 'binary', operator, left, right });
const loopVar = name => ({ type: 'loopVar', name });
const assign = (name, operator, value) => ({ type: 'loopAssign', name, operator, ...(value ? { value } : {}) });
const array = (...items) => ({ type: 'arrayLiteral', items });
const index = value => ({ type: 'index', index: lit(value) });
const template = (...nodes) => ({ type: 'template', segments: nodes.map(node => typeof node === 'string' ? { type: 'text', value: node } : { type: 'expr', node }) });
const range = (n, body, name = 'i') => ({ type: 'forLoop', mode: 'range', loopVar: name, init: assign(name, '=', lit('0')), condition: binary('<', loopVar(name), lit(String(n))), update: assign(name, '++'), body });
const foreach = (iterable, body) => ({ type: 'forLoop', mode: 'foreach', loopVar: 'item', iterable, body });
const ref = (commandName, ...args) => ({ type: 'commandRef', commandName, args });
const special = name => ({ $value: name });
const typedNode = () => fn('fixture.value');
const timerNode = duration => fn('timer', duration, lit('body'), fn('fixture.count'), ref('later'));

function caseDefinitions() {
  const cases = [];
  const add = (category, input, name = '', extra = {}) => cases.push({ id: `${category}-${String(cases.length).padStart(4, '0')}${name ? `-${name}` : ''}`, category, input, ...extra });
  const evaluate = (category, ast, context = {}, host = {}, name = '', extra = {}) => add(category, { operation: 'evaluate', ast, context, host }, name, extra);
  const atoms = ['', ' ', '0', '-0', '1', '-1', '2', '1.5', '.5', '5abc', '0x10', '1e3', '+5', 'null', 'undefined', 'NaN', 'Infinity', '-Infinity', 'true', 'false', ' FALSE ', '01', '-2.1234567', '9007199254740993', '1e309', 'a', 'A', '😀', '\uE000', 'İ', 'ß', '\u00a0', '\uFEFF', '1.'];
  const ops = ['+', '-', '*', '/', '%', '==', '!=', '>=', '<=', '>', '<', '=', '~=', '<>'];
  for (const op of ops) for (let i = 0; i < atoms.length; i++) for (const offset of [0, 1, 7]) {
    evaluate('coercion', binary(op, lit(atoms[i]), lit(atoms[(i + offset) % atoms.length])), {}, {}, `${ops.indexOf(op)}-${i}-${offset}`);
  }
  for (const value of atoms) for (const op of ['+', '-']) evaluate('unary', { type: 'unary', operator: op, argument: lit(value) });
  const typedValues = [special('undefined'), null, true, false, 0, 1, 2, special('NaN'), special('Infinity'), special('-Infinity'), special('-0'), [], [null, 1, '😀'], { $object: [['b',1],['10',10],['2',2],['a','z']] }, special('function')];
  for (const value of typedValues) {
    const boundary = value?.$value === 'function' ? { domain: 'source-only-function-boundary', limitation: 'Rust plain-data JsValue excludes function values; source result retained without semantic change.' } : {};
    for (const shape of ['raw', 'root', 'template', 'set', 'array', 'truthy', 'numeric', 'compare']) {
      const node = typedNode(value);
      const ast = shape === 'raw' ? node : shape === 'root' ? root(lit('a'), node, lit('b')) : shape === 'template' ? template('a', node, 'b') : shape === 'set' ? root(set('memory', node, 'v'), get('memory', 'v')) : shape === 'array' ? array(node) : shape === 'truthy' ? { type: 'ternary', test: node, consequent: lit('yes'), alternate: lit('no') } : shape === 'numeric' ? binary('+', node, lit('1')) : binary('==', node, lit('false'));
      evaluate('typed-values', ast, {}, {returnValue:value}, shape, boundary);
    }
  }
  for (const value of atoms) evaluate('truthiness', { type: 'ternary', test: lit(value), consequent: set('memory', lit('yes'), 'branch'), alternate: set('memory', lit('no'), 'branch') });
  for (const current of ['0o1706467650045030172466317145567324','0b1111000110100110111110101000000100101000011000001111010100110110011001111001100101101110111011010100','0o567133026574060215763335351160072','0x20000000000001','0b100000000000000000000000000000000000000000000000000001']) evaluate('number-radix-rounding',assign('i','+=',lit('0')),{loopVars:[['i',current]]});
  for (const current of atoms.slice(0, 25)) for (const operator of ['=', '+=', '-=', '*=', '/=', '%=', '++', '--']) evaluate('loop-assignment', root(assign('i', operator, lit('1')), loopVar('i')), { loopVars: [['i', current]] });
  for (const [left, right] of [['😀','\uE000'], ['𐀀','\uFFFF'], ['A','a'], ['İ','i\u0307'], ['é','e\u0301'], ['ß','SS'], ['𐐀','𐐨'], ['\u0000',''], ['\r\n','\n']]) {
    for (const op of ['==','<','>','~=']) evaluate('utf16-order', binary(op, lit(left), lit(right)));
  }
  evaluate('object-stringify-order',get('memory','items',{type:'array'}),{variables:[['items','[{"b":1,"10":10,"2":2,"a":3},{"z":1,"a":2}]']]});
  for (const units of [[0xD800], [0xDC00], [65,0xD800,66], [0xD83D,0xDE00], [0xD800,0xD800]]) {
    for (const operation of ['get','index','array','template']) {
      const read = get('memory','edge');
      const ast = operation === 'get' ? read : operation === 'template' ? template('<',read,'>') : operation === 'array' ? array(read) : { ...array(read), accessor: index('0') };
      evaluate('utf16-boundary', ast, { variables: [['edge', { $utf16: units }]] });
    }
  }
  const values = ['["a","b","c"]', '[1,null,true,{"b":2,"10":10,"2":2,"a":1},["x"]]', '[]', 'not-json', '{"b":2,"10":10,"2":2,"a":1}', 'null', 'false', '"text"', '0', '', '["😀","é","\\ud800"]'];
  const accessors = [undefined, {type:'array'}, index('0'), index('-1'), index('-9'), index('1.9'), index('1e2'), index('0x1'), index('nope'), {type:'length'}, {type:'random'}];
  for (const storage of ['memory','cache','cacheUser','db','dbUser']) for (const value of values) for (const accessor of accessors) {
    const context = storage === 'memory' ? { variables: [['items', value]] } : {};
    const host = storage === 'cache' ? { cache: [['twitch:123:variable:items',value]] } : storage === 'cacheUser' ? {cache:[['twitch:123:variable:items:login:caller',value]]} : storage === 'db' ? { db: [['items',value]] } : storage === 'dbUser' ? {dbUser:[['items:caller',value]]} : {};
    evaluate('storage-read', get(storage,'items',accessor), context, host);
    if ([undefined,'index','length'].includes(accessor?.type)) evaluate('storage-exists', exists(storage,'items',accessor), context, host);
  }
  for (const storage of ['memory','cache','cacheUser','db','dbUser']) for (const userPlan of ['free','premium','pro']) for (const accessor of [undefined,{type:'append'},{type:'setIndex',index:lit('-1')}]) {
    evaluate('storage-write', root(get(storage), set(storage, array(lit('x'),lit('😀')), 'items', accessor), get(storage), exists(storage)), {userPlan,variables:[['items','["a","b"]']]}, {db:[['items','["a","b"]']],dbUser:[['items:caller','["a","b"]']],cache:[['twitch:123:variable:items','["a","b"]'],['twitch:123:variable:items:id:456','["a","b"]']]});
  }
  for (const storage of ['memory','cache','cacheUser','db','dbUser']) for (const userPlan of ['free','pro']) for (const accessor of [undefined,{type:'clear'},{type:'remove',index:lit('-1')},{type:'remove',index:lit('bad')}]) {
    evaluate('storage-delete', root(get(storage),del(storage,'items',accessor),get(storage),exists(storage)), {userPlan,variables:[['items','["a","b"]']]}, {db:[['items','["a","b"]']],dbUser:[['items:caller','["a","b"]']],cache:[['twitch:123:variable:items','["a","b"]'],['twitch:123:variable:items:id:456','["a","b"]'],['twitch:123:variable:items:login:caller','["x","y"]']]});
  }
  for (const [throwOn,ast] of [
    ['cache.get',get('cache')], ['cache.exists',exists('cache')], ['cache.set',set('cache',lit('v'))], ['cache.expire',set('cache',lit('v'))], ['cache.del',del('cache')],
    ['db.load',get('db')], ['db.save',set('db',lit('v'))], ['db.delete',del('db')], ['db.save',del('db','items',{type:'remove',index:lit('0')})],
    ['dbUser.load',get('dbUser')], ['dbUser.save',set('dbUser',lit('v'))], ['dbUser.delete',del('dbUser')], ['responses.save',set('memory',lit('v'),'responses',{type:'append'})]
  ]) evaluate('host-failure',root(ast,lit('after')),{userPlan:'pro'},{throwOn,db:[['items','[1,2]']]});
  for (const storage of ['db','dbUser']) for (const value of ['',null,special('undefined'),'[1,2,3]']) evaluate('variable-cache', root(get(storage),get(storage,'items',{type:'length'}),exists(storage),get(storage,'items',{type:'length'})), {}, storage === 'db' ? {db:[['items',value]]} : {dbUser:[['items:caller',value]]});
  for (const storage of ['cacheUser','dbUser']) for (const selector of ['', 'caller',' CALLER ','@caller','alice',' @Alice ','@@BoB']) {
    evaluate('user-selector', root(set(storage,lit('value'),'items',undefined,lit(selector)),get(storage,'items',undefined,lit(selector)),del(storage,'items',undefined,lit(selector)),exists(storage,'items',undefined,lit(selector))), {userPlan:'pro'});
  }
  for (const context of [{userId:'',userLogin:''},{userId:'',userLogin:' CALLER '},{userId:'456',userLogin:''},{userId:'456',userLogin:'caller'}]) evaluate('user-cache-keys', root(set('cacheUser',lit('v')),get('cacheUser'),del('cacheUser'),get('cacheUser')),context);
  for (const storage of ['memory','cache','cacheUser','db','dbUser']) {
    const prefix = {memory:'',cache:'#',cacheUser:'##',db:'*',dbUser:'**'}[storage];
    evaluate('prefix-strip',root(set(storage,lit('v'),`${prefix}key`),get(storage,`${prefix}key`),exists(storage,`${prefix}key`),del(storage,`${prefix}key`)),{userPlan:'pro'});
    evaluate('decoded-invalidation',root(set(storage,lit('[1,2]')),get(storage,'items',{type:'length'}),set(storage,lit('3'),'items',{type:'append'}),get(storage,'items',{type:'length'}),del(storage,'items',{type:'remove',index:lit('0')}),get(storage,'items',{type:'array'}),set(storage,lit('{"x":1}')),get(storage,'items',{type:'length'})),{userPlan:'pro'});
  }
  evaluate('legacy-array-map',root(get('memory'),del('memory','items',{type:'remove',index:lit('0')}),get('memory'),del('memory'),get('memory')),{arrays:[['items',['a','b']]]});
  for (const commandResponses of [[],['a','😀','c']]) for (const accessor of accessors) evaluate('responses-read',root(get('memory','responses',accessor),exists('memory','responses',accessor)),{commandResponses});
  evaluate('responses-write',root(set('memory',array(lit('x'),lit('y')),'responses',{type:'append'}),set('memory',lit('z'),'responses',{type:'setIndex',index:lit('-1')}),get('memory','responses')),{commandResponses:['a']});
  for (const value of values) evaluate('foreach-interpretation',foreach(lit(value),[set('memory',loopVar('item'),'out',{type:'append'})]));
  for (const userPlan of ['free','premium','pro']) {
    for (const n of [0,1,3,26,51,101]) evaluate('loop-caps',root(range(n,[fn('fixture.count')]),loopVar('i')),{userPlan,loopVars:[['i','outer'],['seed','kept']]});
    for (let depth = 0; depth <= 5; depth++) evaluate('loop-depth',range(2,[fn('fixture.count')]),{userPlan,loopDepth:depth});
    for (const exit of ['break','continue']) evaluate('loop-exit',range(5,[set('memory',loopVar('i'),'before',{type:'append'}),{type:'ternary',test:binary('==',loopVar('i'),lit('2')),consequent:fn(exit),alternate:lit('')},set('memory',loopVar('i'),'after',{type:'append'})]),{userPlan});
  }
  evaluate('nested-scopes',root(range(3,[set('memory',loopVar('i'),'outer',{type:'append'}),range(2,[set('memory',loopVar('i'),'inner',{type:'append'})]),set('memory',loopVar('i'),'restored',{type:'append'})]),loopVar('i')),{userPlan:'pro',loopVars:[['i','seed']]});
  evaluate('loop-seeded100',range(5,[...Array.from({length:20},(_,i)=>lit(`body${i}`)),fn('fixture.count')]),{userPlan:'pro',loopVars:Array.from({length:100},(_,i)=>[`seed${i}`,String(i)])});
  // Source threading inconsistency: only shared mutations survive getVar's discarded child context.
  const scalarIndex = range(1,[fn('fixture.count'),set('memory',lit('shared'),'mutation')]);
  for (const name of ['items','responses']) for (const kind of ['get','exists','setIndex','remove']) {
    const accessor = {type:kind === 'setIndex' ? 'setIndex' : kind === 'remove' ? 'remove' : 'index',index:scalarIndex};
    const node = kind === 'get' ? get('memory',name,accessor) : kind === 'exists' ? exists('memory',name,accessor) : kind === 'setIndex' ? set('memory',lit('z'),name,accessor) : del('memory',name,accessor);
    evaluate('index-context-threading',node,{variables:[['items','["a"]']],commandResponses:['a']});
  }
  for (const userLevel of [0,1,7,8,10,special('NaN')]) for (const enforceFunctionPermissions of [true,false]) for (const name of ['fixture.gated7','fixture.gated8','missing']) evaluate('permission-order',fn(name,set('memory',lit('yes'),'argument-write'),fn('fixture.count')),{userLevel,enforceFunctionPermissions});
  evaluate('handler-order',fn('fixture.echo',fn('fixture.count'),set('memory',lit('x'),'v'),get('memory','v'),fn('fixture.count')));
  evaluate('source-throw',root(set('memory',lit('before'),'v'),fn('fixture.throw',fn('fixture.count')),set('memory',lit('after'),'v')));
  for (const duration of ['0','-1','1','1.5','604800','604801','Infinity','NaN','1e2',' 3 ','5abc','']) evaluate('timer-bounds',timerNode(lit(duration)),{effect:true});
  for (const context of [{timerDepth:5},{platform:'kick'},{broadcasterId:''},{timerDepth:4},{variables:[['seconds','300']],effect:true}]) evaluate('timer-context',timerNode(get('memory','seconds')),context);
  evaluate('timer-usage',fn('timer',lit('1')));
  for (const seconds of ['3','0','604800']) add('direct-timer',{operation:'timer',ast:timerNode(lit(seconds)),context:{effect:true}});
  evaluate('timer-scheduler-throw',timerNode(lit('3')),{effect:true},{schedulerThrows:true});
  evaluate('timer-duration-only',timerNode(root(fn('fixture.effect'),fn('fixture.count'),lit('3'))),{effect:true});
  evaluate('timer-snapshot-sharing',root(timerNode(lit('3')),set('memory',lit('later'),'v'),set('memory',lit('later'),'responses',{type:'append'}),ref('budget-decrement')),{variables:[['v','before']],commandResponses:['before'],effect:true,authorization:{origin:'authored'},enforceFunctionPermissions:false});
  add('snapshot',{operation:'snapshot',context:{variables:[['v','before']],arrays:[['legacy',['x']]],loopVars:[['i','2']],commandVariables:[['secret','omit']],userCommandVariables:[['secret','omit']],effect:true,authorization:{origin:'llm',identity:{level:1,tags:['sub']}},commandRefBudget:{remaining:7},visitedCommands:['123:a']}});
  for (const commandRefDepth of [0,4,5]) for (const remaining of [0,1,2]) for (const visitedCommands of [[],['123:target']]) evaluate('commandref-guards',ref(' TARGET ',set('memory',lit('must-only-run-after-initial-guard'),'arg'),fn('fixture.count')),{commandRefDepth,commandRefBudget:{remaining},visitedCommands});
  for (const origin of ['chat','llm','authored']) for (const enforceFunctionPermissions of [true,false]) for (const effect of [true,false]) evaluate('commandref-authorization',root(ref('A',fn('fixture.effect')),ref('A',lit('two')),fn('fixture.effect')),{effect,enforceFunctionPermissions,authorization:{origin,identity:{level:7.8,tags:['mod','INVALID'],userId:'1234',login:'UPPER'}},eventData:{badges:[{set_id:'broadcaster'}],custom:'retained'},commandRefBudget:{remaining:2}});
  for (const userLevel of [-100,1.9,11,special('NaN')]) evaluate('commandref-fallback',ref('go'),{userLevel,eventData:{badges:[{set_id:'broadcaster'}]}});
  evaluate('commandref-inner-budget',ref('outer',ref('inner'),set('memory',lit('arg-still-runs'),'arg')),{commandRefBudget:{remaining:1}});
  evaluate('commandref-identity-fallback',ref('go'),{userId:'',userLogin:'',userDisplayName:'',authorization:{origin:'llm',identity:{level:2,tags:['sub'],userId:'bad!',login:'bad!'}}});
  evaluate('custom', {type:'custom',customType:'fixture-kind',data:{x:1}});
  evaluate('unknown-tag', {type:'fixture-unknown'}, {}, {}, '', {domain:'source-only-invalid-ast-boundary',limitation:'Unknown tag exercises source default; Rust AstNode rejects undeclared tags.'});
  const sourceFacts = [
    ['range-source','*(for #i = 0; #i < 3; #i++ { %(out[] #i) }) %(out[])','["0","1","2"]'],
    ['continue-source','*(for #i = 0; #i < 5; #i++ { *(#i == 2 ? $(continue) : "") %(out[] #i) }) %(out[])','["0","1","3","4"]'],
    ['break-source','*(for #i = 0; #i < 6; #i++ { *(#i == 3 ? $(break) : "") %(out[] #i) }) %(out[])','["0","1","2"]'],
    ['literal-array','%[1,2,3]','1,2,3'],
    ['decimal','*(1.5 + 2.25)','3.75'],
    ['prefix-not-number','*(5abc == 5 ? "yes" : "no")','no'],
    ['empty-consequent','%(sumiso 17) *(^(sumiso) ? : %(sumiso 42)) %(sumiso)','17']
  ];
  for (const [name,text,expected] of sourceFacts) add('source-invariant',{operation:'parseEvaluate',text},name,{invariant:{type:'string',value:expected}});
  const texts = ['plain  text\n😀','a%(v x)b%(v)c','$(fixture.echo a b)','%(v x) %(v)','*(1 + 2)','%[a,b][0]','*(1 ? "" : %(v x))','literal \\$(escaped)','before $(missing after','*(1 + )','%[a,b','$(timer 3 body $(fixture.count))','a$(fixture.value)b','a\t b  c','😀%(v é)🙂%(v)'];
  for (const text of texts) for (const operation of ['parseEvaluate','render','preparedRender']) add('render-versus-root',{operation,text});
  appendBuiltinCases(cases);
  appendRepeatedPrefixCases(cases);
  appendUtf16BoundaryCases(cases);
  return cases;
}

// Additional source-backed optional context builtins. Original case names and
// expectations above remain frozen; these cases use a distinct actual registry.
function appendBuiltinCases(cases) {
  const add = (category, ast, context = {}, host = {}, name = '') => cases.push({
    id: `${category}-${String(cases.length).padStart(4,'0')}${name ? `-${name}` : ''}`,
    category, input: {operation:'evaluate',contextBuiltins:true,ast,context,host}
  });
  const increments = ['', '0', '+3', '++1+2', '+-+5', '5abc', '-2.9', '0x10', 'Infinity', '  +4  ', 'nope', '1e3'];
  for (const argument of ['', '7', '-3']) for (const increment of increments) {
    add('builtin-count',fn('count',lit(increment)),{count:10,argument},{},`string-${increments.indexOf(increment)}`);
  }
  const values = [special('undefined'),null,false,true,0,special('-0'),2,special('NaN'),special('Infinity'),[],[2,3],{ $object:[['z',1],['a',2]] }];
  for (const argument of ['', '7', '-3']) for (let i=0;i<values.length;i++) {
    add('builtin-count-typed',fn('count',fn('fixture.value')),{count:10,argument},{returnValue:values[i]},String(i));
  }
  for (const argument of [undefined,'','0','+3','++1+2','-4','5abc','nope']) {
    add('builtin-count-fallback',fn('count'),{count:10,...(argument===undefined?{}:{argument})});
  }
  add('builtin-count-extra-args',fn('count',lit('2'),set('memory',lit('executed'),'unused-argument')),{count:10,argument:'7'});
  for (const count of [0,5,-3,special('-0'),1.5]) add('builtin-scount',fn('scount',set('memory',lit('argument-executed'),'scount-arg')),{count,argument:'99'});
  add('builtin-counter-sequence',root(fn('count',lit('+3')),fn('scount'),fn('count'),fn('scount'),fn('count',lit('-2'))),{count:4,argument:'5'});
  add('builtin-counter-scopes',root(range(3,[fn('scount')]),fn('count',lit('0'))),{count:4});
  const bitsValues = [special('undefined'),null,false,true,0,3.5,special('-0'),special('NaN'),special('Infinity'),'42','😀',[],[1,null,'x'],{$object:[['z',1],['a',2]]},{$utf16:[0xD800]}];
  add('builtin-bits-missing',fn('bits'));
  add('builtin-bits-no-property',fn('bits'),{extraContext:{other:77}});
  for (let i=0;i<bitsValues.length;i++) add('builtin-bits-typed',fn('bits',set('memory',lit('argument-executed'),'bits-arg')),{extraContext:{bits:bitsValues[i]}},{},String(i));
  for (const exit of ['break','continue']) {
    for (const loopDepth of [undefined,0,1]) add('builtin-exit-outside',root(fn(exit),set('memory',lit('root-continues'),'after-exit')),{...(loopDepth===undefined?{}:{loopDepth})},{},`${exit}-${loopDepth??'default'}`);
    add('builtin-exit-args',fn(exit,set('memory',lit('before-exit'),'exit-arg')),{},{},exit);
    add('builtin-exit-loop',range(5,[set('memory',loopVar('i'),'before',{type:'append'}),{type:'ternary',test:binary('==',loopVar('i'),lit('2')),consequent:fn(exit),alternate:lit('')},set('memory',loopVar('i'),'after',{type:'append'})]),{},{},exit);
    add('builtin-exit-nested',range(2,[range(3,[set('memory',loopVar('j'),'inner',{type:'append'}),fn(exit),set('memory',lit('unreached'),'bad')],'j'),set('memory',loopVar('i'),'outer',{type:'append'})]),{userPlan:'pro'},{},exit);
  }
}

function appendRepeatedPrefixCases(cases) {
  const cache = ['score','##score','####score','######score'].flatMap(name => [
    [`twitch:123:variable:${name}`,`global:${name}`],
    [`twitch:123:variable:${name}:login:caller`,`user:${name}`]
  ]);
  for (const storage of ['cache','cacheUser']) for (const name of ['##score','####score','######score']) {
    for (const operation of ['get','set','exists','delete']) {
      const ast = operation === 'get' ? get(storage,name) : operation === 'set' ? set(storage,lit('prefix-value'),name) : operation === 'exists' ? exists(storage,name) : del(storage,name);
      cases.push({id:`prefix-repeat-regression-${String(cases.length).padStart(4,'0')}-${storage}-${operation}`,category:'prefix-repeat-regression',input:{operation:'evaluate',ast,context:{},host:{cache}}});
    }
  }
}

function appendUtf16BoundaryCases(cases) {
  const add = (category, ast, context = {}, host = {}, name = '') => cases.push({
    id:`${category}-${String(cases.length).padStart(4,'0')}${name?`-${name}`:''}`,
    category,input:{operation:'evaluate',ast,context,host}
  });
  const selector = () => fn('fixture.value');
  const selectors = [
    ['high',{$utf16:[55296]}], ['low',{$utf16:[56320]}], ['emoji','😀']
  ];
  for (const [name,returnValue] of selectors) {
    add('dbuser-utf16-selector',get('dbUser','items',undefined,selector()),{},{returnValue},`${name}-read-miss`);
    add('dbuser-utf16-selector',exists('dbUser','items',undefined,selector()),{},{returnValue},`${name}-exists-miss`);
    add('dbuser-utf16-selector',set('dbUser',lit('saved'),'items',undefined,selector()),{userPlan:'premium'},{returnValue},`${name}-set`);
    add('dbuser-utf16-selector',del('dbUser','items',undefined,selector()),{},{returnValue},`${name}-delete`);
    add('dbuser-utf16-selector',root(set('dbUser',lit('saved'),'items',undefined,selector()),get('dbUser','items',undefined,selector()),exists('dbUser','items',undefined,selector())),{userPlan:'premium'},{returnValue},`${name}-save-read-memo`);
    // Host storage input keys use transport markers only for malformed UTF16.
    const key = name === 'emoji' ? 'items:😀' : {utf16:[105,116,101,109,115,58,name==='high'?55296:56320]};
    add('dbuser-utf16-selector',get('dbUser','items',undefined,selector()),{},{returnValue,dbUser:[[key,'seeded']]},`${name}-read-hit`);
    const memoKey = name === 'emoji' ? 'login:😀:items' : {utf16:[108,111,103,105,110,58,name==='high'?55296:56320,58,105,116,101,109,115]};
    add('dbuser-utf16-selector',get('dbUser','items',undefined,selector()),{userCommandVariables:[[memoKey,'memo-seeded']]},{returnValue},`${name}-read-hit-memo`);
  }
  // Source callbacks trim only; the raw memo key independently normalizes @ and case.
  for (const [name,unit] of [['high',55296],['low',56320]]) {
    add('dbuser-utf16-memo-normalization',root(set('dbUser',lit('saved'),'items',undefined,selector()),get('dbUser','items',undefined,get('memory','selector'))),{userPlan:'premium',variables:[['selector',{$utf16:[unit]}]]},{returnValue:{$utf16:[32,64,unit,32]}},name);
  }
  const events = [
    ['array',['a','b']], ['array-shallow',[{$object:[['z',1],['a',2]]},['x']]],
    ['string','ab'], ['astral','😀'], ['high',{$utf16:[55296]}], ['low',{$utf16:[56320]}],
    ['number',42], ['boolean',true], ['false',false], ['null',null], ['undefined',special('undefined')],
    ['object-overlap',{$object:[['chatter_user_login','old'],['z',1],['2','integer'],['chatter_user_id','old-id'],['a',2],['chatter_user_name','old-name']]}],
    ['object-key-utf16',{$object:[[{utf16:[55296]},'high-key'],['z',1],[{utf16:[56320]},'low-key'],['chatter_user_id','old-id']]}]
  ];
  for (const [name,eventData] of events) add('commandref-generic-eventdata',ref('go',lit('arg')),{eventData},{},name);
}

function benchmarkDefinitions() {
  const defs = [];
  const add = (id, description, input) => defs.push({ id, description, input, costs: {
    prepare: 'Load/transpile source and prepare AST or scanner/parser segments once, outside timing.',
    evaluate: 'Fresh context, fake host stores, trace and seeded RNG per operation; actual source evaluation. No normalization, output serialization or checksum.',
    compile: input.operation === 'render' ? 'Full actual renderer scanning/parsing each operation (compile+render).' : input.operation === 'preparedRender' ? 'Actual scanSourceSegments + parse during preparation; source-primitives assembly during evaluate.' : 'No parse/compile in timed operation.'
  } });
  add('literals100','100 root literals',{operation:'evaluate',ast:root(...Array.from({length:100},(_,i)=>lit(`v${i}`)))});
  for (const n of [100,500]) add(`arithmetic${n}`,`${n} arithmetic nodes`,{operation:'evaluate',ast:root(...Array.from({length:n},(_,i)=>binary('+',lit(String(i)),lit('1.5'))))});
  add('template100','100 interpolation segments',{operation:'evaluate',ast:template(...Array.from({length:100},(_,i)=>binary('*',lit(String(i)),lit('2'))))});
  add('prepared-render40','Prepared actual scanner/parser primitives, 40 expressions',{operation:'preparedRender',text:Array.from({length:40},(_,i)=>`part${i}:*(1 + 2)`).join(' ')});
  add('full-render40','Actual renderer compile+render, 40 expressions',{operation:'render',text:Array.from({length:40},(_,i)=>`part${i}:*(1 + 2)`).join(' ')});
  add('loop-small','5 loop iterations, count handler',{operation:'evaluate',ast:range(5,[fn('fixture.count')])});
  add('loop-nested','3x4 nested loops, count handler',{operation:'evaluate',ast:range(3,[range(4,[fn('fixture.count')],'j')]),context:{userPlan:'pro'}});
  add('loop-seeded100-manybody','100 preseeded loop bindings, 5 iterations, 20 literals + count',{operation:'evaluate',ast:range(5,[...Array.from({length:20},(_,i)=>lit(String(i))),fn('fixture.count')]),context:{userPlan:'pro',loopVars:Array.from({length:100},(_,i)=>[`seed${i}`,String(i)])}});
  for (const storage of ['memory','db']) for (const kind of ['length','index']) add(`array-${storage}-${kind}100`,`100 repeated ${storage} array ${kind} accesses`,{operation:'evaluate',ast:root(...Array.from({length:100},()=>get(storage,'items',kind === 'index' ? index('1') : {type:'length'}))),context:storage === 'memory' ? {variables:[['items','[1,2,3,4]']]} : {},host:storage === 'db' ? {db:[['items','[1,2,3,4]']]} : {}});
  add('sequential-handlers50','50 sequential deterministic fake handlers, no sleeps',{operation:'evaluate',ast:root(...Array.from({length:50},()=>fn('fixture.echo',fn('fixture.count'))))});
  add('array-write-invalidate','20 append/read pairs, same request memo invalidation',{operation:'evaluate',ast:root(set('memory',lit('[]')),...Array.from({length:20},()=>[set('memory',lit('x'),'items',{type:'append'}),get('memory','items',{type:'length'})]).flat())});
  add('foreach10','10 foreach values and memory appends',{operation:'evaluate',ast:foreach(array(...Array.from({length:10},(_,i)=>lit(String(i)))),[set('memory',loopVar('item'),'out',{type:'append'})])});
  return defs;
}

export async function buildCorpus() {
  const bundle = await sourceBundle();
  const oracle = runtimeFactory(bundle.code, vm);
  const definitions = caseDefinitions();
  assert.ok(definitions.length >= 1000 && definitions.length <= 4000, `bounded corpus: ${definitions.length}`);
  const cases = [];
  for (const definition of definitions) {
    const source = await oracle.execute(definition.input);
    if (definition.invariant) assert.deepEqual(source.value, definition.invariant, `source test invariant ${definition.id}`);
    cases.push({...definition,source});
  }
  const benchmarks = [];
  for (const definition of benchmarkDefinitions()) {
    const run = oracle.prepareBenchmark(definition);
    const source = oracle.normalizeObservation(await run());
    assert.equal(source.outcome,'returned',definition.id);
    assert.deepEqual(oracle.normalizeObservation(await run()),source,`fresh benchmark repeat ${definition.id}`);
    benchmarks.push({...definition,source});
  }
  // Source invariants independent of Rust expectations.
  const named = category => cases.filter(c=>c.category===category);
  assert.equal(named('source-throw')[0].source.outcome,'thrown');
  assert.equal(named('source-throw')[0].source.error.name,'TypeError');
  assert.equal(named('loop-seeded100')[0].source.context.maps.loopVars.length,100);
  assert.equal(named('loop-seeded100')[0].source.context.identity.sameLoopVars,true);
  const number = value => ({type:'number',value});
  const countDelta = observation => observation.scalarDeltas.find(([key])=>key==='count')?.[1];
  const threading = named('index-context-threading');
  assert.equal(countDelta(threading[0].source.context),undefined,'getVar must discard loop scalar context');
  assert.deepEqual(countDelta(threading[1].source.context),number(1),'exists must retain loop scalar context');
  assert.deepEqual(countDelta(threading[2].source.context),number(1),'setIndex must retain loop scalar context');
  for (const c of threading) assert(c.source.context.maps.variables.some(([key])=>key==='mutation'),'index shared-map writes survive');
  const dbMiss = named('variable-cache').find(c=>c.input.ast.children[0].storage==='db'&&c.input.host.db[0][1]==='');
  assert.equal(dbMiss.source.host.events.length,4,'source does not memoize raw DB misses');
  const dbHit = named('variable-cache').find(c=>c.input.ast.children[0].storage==='db'&&c.input.host.db[0][1]==='[1,2,3]');
  assert.equal(dbHit.source.host.events.length,1,'source memoizes nonempty raw DB hit');
  const denied = named('permission-order').find(c=>c.input.ast.name==='fixture.gated7'&&c.input.context.userLevel===1&&c.input.context.enforceFunctionPermissions);
  assert.equal(denied.source.context.maps.variables[0][0],'argument-write','function args run before denial');
  assert.match(denied.source.value.value,/permission denied/);
  const objectString = named('object-stringify-order')[0];
  assert.equal(objectString.source.value.value,'[{"2":2,"10":10,"b":1,"a":3},{"z":1,"a":2}]','JSON integer keys sort; other property order retained');
  for (const c of named('timer-bounds')) assert(!c.source.host.events.some(e=>e.value[0]?.value==='handler'&&e.value[1]?.value==='fixture.count'),'timer body must remain lazy');

  for (const c of named('commandref-guards')) {
    const ctx = c.input.context;
    if (ctx.commandRefDepth >= 5 || ctx.commandRefBudget.remaining <= 0 || ctx.visitedCommands.includes('123:target')) {
      assert.deepEqual(c.source.context.maps.variables,[],`guard arguments must not run: ${c.id}`);
      assert.deepEqual(c.source.host.events,[],`guard host arguments must not run: ${c.id}`);
    }
  }
  for (const c of named('permission-order').filter(c=>c.input.ast.name==='missing')) assert.equal(c.source.context.maps.variables[0][0],'argument-write');
  for (const c of named('builtin-exit-outside')) {
    const exit = c.input.ast.children[0].name;
    assert.deepEqual(c.source.context.scalarDeltas.find(([key])=>key==='loopExit')?.[1],{type:'string',value:exit},'actual source exit handler unconditionally sets flag');
    assert(c.source.context.maps.variables.some(([key])=>key==='after-exit'),'root keeps evaluating after loop exit flag');
    assert(!c.source.host.events.some(e=>e.value[0]?.value==='handler'),'actual builtin must have no fake handler event');
  }
  for (const c of cases.filter(c=>c.input.contextBuiltins)) assert(!c.source.host.events.some(e=>e.value[0]?.value==='handler'&&['count','scount','bits','break','continue'].includes(e.value[1]?.value)),'actual builtin must not emit fake handler events');
  const fallback = named('builtin-count').find(c=>c.input.context.argument==='7'&&c.input.ast.args[0].value==='');
  assert.deepEqual(fallback.source.value,{type:'string',value:'17'},'count empty string falls back to context argument');
  const plusStripping = named('builtin-count').find(c=>c.input.ast.args[0].value==='++1+2');
  assert.deepEqual(plusStripping.source.value,{type:'string',value:'22'},'count strips every plus character');
  const emptyArray = named('builtin-count-typed').find(c=>c.input.context.argument==='7'&&Array.isArray(c.input.host.returnValue)&&c.input.host.returnValue.length===0);
  assert.deepEqual(emptyArray.source.value,{type:'string',value:'10'},'empty array is truthy and must not fall back');
  assert.equal(sha256(JSON.stringify({cases:cases.slice(0,3386),benchmarks})),'d688c5e2b4bb038f9319b7194ab6a780911952f6b450adaafb4b8b4076c62327','original 3386 source facts and16 benchmarks must remain unchanged');
  for (const c of named('dbuser-utf16-selector')) {
    if (c.id.endsWith('-read-miss')) {
      assert.deepEqual(c.source.value,{type:'string',value:''},'source missing DbUser read is empty text');
      const load = c.source.host.events.find(e=>e.value[0]?.value==='dbUser.load');
      const marker = c.input.host.returnValue.$utf16;
      assert.deepEqual(load.value[2],marker?{type:'string',utf16:marker}:{type:'string',value:c.input.host.returnValue},'callback retains exact UTF16 selector');
    }
    if (c.id.endsWith('-save-read-memo')) {
      assert.deepEqual(c.source.value,{type:'string',value:'saved true'},'premium save populates source memo');
      assert(!c.source.host.events.some(e=>e.value[0]?.value==='dbUser.load'),'memoized read does not call DB');
    }
  }
  for (const c of named('dbuser-utf16-memo-normalization')) {
    assert.deepEqual(c.source.value,{type:'string',value:'saved'});
    assert(!c.source.host.events.some(e=>e.value[0]?.value==='dbUser.load'),'normalized UTF16 memo key hits across raw selector variants');
    assert(c.source.context.maps.userCommandVariables[0][0].utf16,'unpaired memo key uses lossless key transport');
  }
  const referenceData = c => c.source.context.commandReferences.value[0].value.find(([key])=>key==='eventData')[1];
  const emojiSpread = referenceData(named('commandref-generic-eventdata').find(c=>c.id.endsWith('-astral')));
  assert.deepEqual(emojiSpread.value.slice(0,2),[['0',{type:'string',utf16:[55357]}],['1',{type:'string',utf16:[56832]}]],'string spread enumerates UTF16 units, not code points');
  const keySpread = referenceData(named('commandref-generic-eventdata').find(c=>c.id.endsWith('-object-key-utf16')));
  assert.deepEqual(keySpread.value[0][0],{utf16:[55296]},'object property key stays lossless');
  assert.deepEqual(keySpread.value[2][0],{utf16:[56320]},'low-surrogate object key stays lossless');
  assert.equal(sha256(JSON.stringify({cases:cases.slice(0,3527),benchmarks})),'ee10b6069889ca3f77a8d877e47f7edafdf42e3d447a73bd9e1aaf3d8ab22482','all original 3527 source facts and16 benchmarks must remain unchanged');
  const tags = new Set();
  function visit(value) { if (!value || typeof value !== 'object') return; if (value.type && typeof value.type === 'string') tags.add(value.type); for (const v of Object.values(value)) visit(v); }
  cases.forEach(c=>visit(c.input.ast));
  const declaredTags = ['root','setVar','getVar','deleteVar','function','literal','custom','exists','binary','unary','ternary','template','arrayLiteral','commandRef','loopVar','loopAssign','forLoop'];
  for (const tag of declaredTags) assert(tags.has(tag),`missing AST tag ${tag}`);
  const categoryCounts = {};
  for (const c of cases) categoryCounts[c.category] = (categoryCounts[c.category] ?? 0) + 1;
  const manifestHash = sha256(JSON.stringify({cases,benchmarks}));
  return { schemaVersion:1, profile:'source-parity', sourceHashes:bundle.hashes, manifestHash,
    coverage: { caseCount:cases.length, benchmarkCount:benchmarks.length, declaredAstTags:declaredTags, additionalDispatchCategory:'unknown/default', categoryCounts,
      sourceOnlyBoundaries:cases.filter(c=>c.domain).map(c=>({id:c.id,domain:c.domain,limitation:c.limitation})),
      limitations:['Function values and unknown AST tags are explicit source-only API boundary cases.','Effect authority uses isolated actual effects.ts with deterministic fake date parsing/hash; no real ingress authorization, admission, or effect delivery tested.','No production services, network, environment, clocks or timer bodies execute.','Benchmarks are definitions and untimed expectations only; no performance claim.'],
      valueEncoding:'Typed ordered values; unpaired UTF16 strings use utf16 code-unit array. Unpaired map/object entry keys use {utf16:[u16...]}; well-formed keys remain exact strings. Serialized storage strings retained byte-exact, JS property order retained.' }, cases, benchmarks };
}

async function main() {
  assert(process.argv.slice(2).every(v=>v==='--check'),'usage: ast_evaluator_reference.mjs [--check]');
  const manifest = await buildCorpus();
  const bytes = JSON.stringify(manifest)+'\n';
  if (process.argv.includes('--check')) assert.equal(await readFile(output,'utf8'),bytes,'fixture drift; review source before regeneration');
  else await writeFile(output,bytes);
  console.log(JSON.stringify({mode:process.argv.includes('--check')?'checked':'generated',cases:manifest.cases.length,benchmarks:manifest.benchmarks.length,manifestHash:manifest.manifestHash,artifactSha256:sha256(bytes),bytes:Buffer.byteLength(bytes)}));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
