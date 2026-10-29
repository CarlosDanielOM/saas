'use strict';
// Run ONLY in the parent's pinned, isolated snapshot. No external SDK capture.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && !extra.length, 'use --write NEW_DIR or --check EXISTING_DIR');
const dir = path.resolve(directory);
if (mode === '--write') fs.mkdirSync(dir); // Exclusive destination; never replace evidence.
else assert(fs.statSync(dir).isDirectory());
const root = path.resolve(__dirname, '../..');
const sdk = process.env.POSTHOG_RS_SOURCE || '/root/.local/state/rust-full-migration-20261028-lu443ytp/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/posthog-rs-0.27.0';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sourcePath = path.join(root, 'src/utils/posthog_events.ts');
const usagePath = path.join(root, 'src/utils/ai_usage_event.ts');
const runtimeImports = [];
const expectedExports = ['identifyStreamer', 'trackCommand', 'trackTts', 'trackAiUsageRecorded', 'trackAiOperation', 'shutdownPosthog'];
function ast(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = sf.statements.filter(s => ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  return {
    exports: functions.map(s => s.name.text),
    signatures: functions.map(s => s.getText(sf).slice(0, s.body.pos - s.getStart(sf))),
    interfaces: sf.statements.filter(ts.isInterfaceDeclaration).map(s => s.getText(sf)),
    imports: sf.statements.filter(ts.isImportDeclaration).map(s => ({
      module: s.moduleSpecifier.text, text: s.getText(sf), typeOnly: !!s.importClause?.isTypeOnly,
      bindings: s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
        ? s.importClause.namedBindings.elements.map(e => ({name: e.name.text, typeOnly: !!e.isTypeOnly})) : [],
    })),
  };
}
const sourceAst = ast(sourcePath);
assert.deepEqual(sourceAst.exports, expectedExports);
assert.equal(sourceAst.imports.length, 2);
assert(sourceAst.imports[1].bindings.some(b => b.name === 'AiUsageContext' && b.typeOnly));
// Full strict checking of the real two source files against the installed pinned
// packages. No source substitutions or ambient any declarations are accepted.
const program = ts.createProgram([sourcePath, usagePath], {
  module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: true,
  esModuleInterop: true, types: ['node'],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: p => p, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));
function load(file, imports) {
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}, reportDiagnostics: true,
  });
  assert.equal(result.diagnostics.length, 0);
  const module = {exports: {}};
  new Function('require', 'module', 'exports', result.outputText)(name => {
    runtimeImports.push({file: path.relative(root, file), module: name});
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name === 'node:crypto') return require(name); // Real context implementation.
    throw Error(`unexpected runtime import ${name}`);
  }, module, module.exports);
  return module.exports;
}
const usage = load(usagePath, {});
const records = [];
const sessions = new Map();
function session(id) {
  const calls = [];
  const shutdownGates = [];
  class PostHog {
    constructor(key, options) { calls.push({kind: 'constructor', key, options}); }
    identify(value) { calls.push({kind: 'identify', value}); }
    capture(value) { calls.push({kind: 'capture', value}); }
    async shutdown() {
      calls.push({kind: 'shutdown-start'});
      await new Promise(resolve => shutdownGates.push(resolve));
      calls.push({kind: 'shutdown-end'});
    }
  }
  const api = load(sourcePath, {'posthog-node': {PostHog}, './ai_usage_event.js': usage});
  assert.deepEqual(Object.keys(api), expectedExports);
  const constructor = calls.shift();
  sessions.set(id, {api, calls, constructor, shutdownGates});
}
function bits(n) { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); }
function encode(v) {
  if (v === undefined) return {$undefined: true};
  if (typeof v === 'number') return {$numberBits: bits(v)};
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, encode(v)]));
  return v;
}
async function invoke(id, method, args, options = {}) {
  const instance = options.instance || 'process-a';
  if (!sessions.has(instance)) session(instance);
  const s = sessions.get(instance), before = s.calls.length;
  let exception = null;
  try {
    if (method === 'shutdownPosthog') {
      let settled = false;
      const result = s.api[method](...args).then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(settled, false, 'wrapper must await SDK shutdown');
      assert.equal(s.shutdownGates.length, 1);
      s.shutdownGates.shift()();
      await result;
      assert.equal(settled, true);
    } else await s.api[method](...args);
  } catch (e) { exception = e.name; }
  const calls = s.calls.slice(before);
  records.push({id, method, instance, handle: options.handle || 'original',
    contract: options.reject ? 'outside' : options.native ? 'native-context' : 'plain-json',
    reject: options.reject || null, args: encode(args), native: options.native ? encode(options.native) : null,
    raw: encode(calls), wire: JSON.stringify(calls), exception});
}
const command = {channelID: 'channel', channelName: 'name', command: '!hi', status: 'success', userID: 'user', username: 'viewer'};
const tts = {channelID: 'channel', channelName: 'name', source: 'ast', ttsType: 'fish', characters: 17, message: 'hello', status: 'success', userID: 'user', username: 'viewer'};
const context = {schemaVersion: 1, pricingVersion: 'legacy-polar-math-v1', entryId: 'entry', requestId: 'request', entryKind: 'usage', category: 'tts', operation: 'synthesize', source: 'tts_queue', provider: 'fish'};
const recorded = {context, credits: 3.25, reason: 'tts_fish'};
const operation = {requestId: 'request', channelID: 'channel', category: 'tts', operation: 'synthesize', source: 'tts_queue', lifecycle: 'queued'};
const variants = [undefined, null, '', 'text', '😀', '\ud800', '\udc00', 'x\ud800y', false, true, 0, -0, NaN, Infinity, -Infinity,
  -2.75, 9007199254740992, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, {}, [], {'\ud800': ['\udc00', -0, NaN]}];
(async () => {
  // Every property is independently mutated. Optional undefined is captured in
  // tagged inputs, then exercised in the actual TS expression (not synthesized).
  for (const [method, base, optional, required] of [
    ['trackCommand', command, ['userID', 'username', 'arguments', 'errorMessage'], ['channelID', 'channelName', 'command', 'status']],
    ['trackTts', tts, ['mode', 'provider', 'userID', 'username', 'errorMessage'], ['channelID', 'channelName', 'source', 'ttsType', 'characters', 'message', 'status']],
    ['trackAiUsageRecorded', recorded, ['polarCostAmount', 'inputTokens', 'outputTokens', 'totalTokens'], ['credits', 'reason']],
    ['trackAiOperation', operation, ['requestedProvider', 'actualProvider', 'fallbackReason', 'errorCode', 'resourceType', 'resourceId', 'latencyMs'], ['requestId', 'channelID', 'category', 'operation', 'source', 'lifecycle']],
  ]) {
    await invoke(`${method}/baseline`, method, [base]);
    for (const field of optional) for (let n = 0; n < variants.length; n++) {
      await invoke(`${method}/${field}/${n}`, method, [{...base, [field]: variants[n]}]);
    }
    for (const field of required) {
      const isStringBoundary = field === 'channelID' || (method === 'trackAiOperation' && ['requestId', 'operation', 'lifecycle'].includes(field));
      for (const value of isStringBoundary ? ['', '😀', '\ud800', 'a\udc00b'] : ['value', '', null, false, 0, -0, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, '\ud800']) {
        await invoke(`${method}/required/${field}/${records.length}`, method, [{...base, [field]: value}]);
      }
      const missing = {...base}; delete missing[field];
      await invoke(`${method}/missing/${field}`, method, [missing], {reject: field});
      if (isStringBoundary) await invoke(`${method}/invalid/${field}`, method, [{...base, [field]: 42}], {reject: field});
    }
  }
  for (const field of ['parentRequestId', 'model', 'channelID', 'quantity', 'unit', 'resourceType', 'resourceId']) {
    for (let n = 0; n < variants.length; n++) {
      const value = variants[n];
      // Truthy non-string channel IDs are outside the explicit distinct-ID contract.
      const reject = field === 'channelID' && value && typeof value !== 'string' ? 'channelID' : null;
      await invoke(`usage-context/${field}/${n}`, 'trackAiUsageRecorded', [{...recorded, context: {...context, [field]: value}}], {reject});
    }
  }
  for (const field of Object.keys(context)) {
    const missing = {...context}; delete missing[field];
    await invoke(`usage-context/missing/${field}`, 'trackAiUsageRecorded', [{...recorded, context: missing}], {reject: field});
    for (const value of ['', '😀\ud800', null, false, -0, NaN]) {
      const reject = field === 'requestId' && typeof value !== 'string' ? field : null;
      await invoke(`usage-context/required/${field}/${records.length}`, 'trackAiUsageRecorded', [{...recorded, context: {...context, [field]: value}}], {reject});
    }
  }
  for (const [method, reject] of [['trackCommand', 'channelID'], ['trackTts', 'channelID'],
    ['trackAiUsageRecorded', 'context'], ['trackAiOperation', 'requestId']]) {
    await invoke(`${method}/null-parameter`, method, [null], {reject});
  }
  await invoke('usage/missing-context', 'trackAiUsageRecorded', [{credits: 1, reason: 'x'}], {reject: 'context'});
  for (const context of [null, false, 0, 'invalid', []]) {
    await invoke(`usage/invalid-context/${records.length}`, 'trackAiUsageRecorded', [{...recorded, context}], {reject: 'context'});
  }
  // Real native-context producer cases: all classifications, optional fields,
  // trimming, finite filtering, enum values, empty channel, and numeric limits.
  const reasons = ['tts_fish', 'tts_kokoro', 'tts_piper', 'messages', 'harness_tools', 'harness_end', 'planner', 'coding_agent', 'stream_summary', 'weekly_summary', 'monthly_summary', 'vod_clip_recommendation', 'Free benefits', '', 'custom😀'];
  for (let i = 0; i < reasons.length; i++) for (const quantity of [undefined, 0, -0, -1.25, NaN, Infinity, 9007199254740992]) {
    const input = {entryId: ' entry ', requestId: ' request ', quantity,
      ...(i % 2 ? {parentRequestId: ' parent ', model: ' model😀 ', channelID: ' channel ', unit: 'tokens', resourceType: 'llm_generation', resourceId: ' resource ', operation: ' custom ', source: ' source ', provider: ' provider '} : {channelID: ' \ufeff ', model: ' '})};
    if (i === 2) Object.assign(input, {entryKind: 'adjustment', category: 'credit_adjustment', unit: 'minutes', resourceType: 'vod_analysis'});
    const c = usage.createAiUsageContext(reasons[i], input);
    const p = {context: c, credits: quantity ?? 0, reason: reasons[i], polarCostAmount: -0, inputTokens: quantity, outputTokens: 0, totalTokens: Infinity};
    await invoke(`native/${i}/${records.length}`, 'trackAiUsageRecorded', [p], {native: {reason: reasons[i], input}});
  }
  for (const unit of ['characters', 'tokens', 'minutes']) for (const resourceType of ['speech', 'voice_preview', 'llm_generation', 'vod_analysis']) {
    const input = {entryId: 'explicit', requestId: 'r', parentRequestId: '', model: '\ufeff', channelID: '',
      operation: '', provider: '', source: '', resourceId: '', quantity: Number.MIN_VALUE, unit, resourceType};
    await invoke(`native/enums/${unit}/${resourceType}`, 'trackAiUsageRecorded', [{
      context: usage.createAiUsageContext('messages', input), credits: -Number.MIN_VALUE, reason: 'messages',
    }], {native: {reason: 'messages', input}});
  }
  // Public native DTOs can also be assembled without the normalizing factory.
  // Unlike createAiUsageContext, the tracking wrapper must retain their fields.
  for (const quantity of [-0, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE]) {
    const c = {...context, parentRequestId: '', model: '', channelID: '', quantity,
      unit: 'characters', resourceType: 'voice_preview', resourceId: '', operation: '', source: '', provider: ''};
    await invoke(`native/direct/${records.length}`, 'trackAiUsageRecorded', [{
      context: c, credits: quantity, reason: '', polarCostAmount: quantity, inputTokens: quantity,
    }], {native: {direct: true}});
  }
  for (const [id, name] of [['', 'name'], ['c', ''], ['c', 'name'], ['c', 'name'], ['c', 'renamed'], ['c', 'name'], ['😀', 'astral'], ['\ud800', '\udc00'], ['\ud800', '\udc00'], ['\ud800', 'renamed\ud800']]) {
    await invoke(`identify/${records.length}`, 'identifyStreamer', [id, name], {handle: records.length % 2 ? 'clone' : 'original'});
  }
  await invoke('restart-first', 'identifyStreamer', ['c', 'name'], {instance: 'process-b'});
  await invoke('restart-dedup', 'identifyStreamer', ['c', 'name'], {instance: 'process-b', handle: 'clone'});
  await invoke('shutdown/first', 'shutdownPosthog', []);
  await invoke('shutdown/repeated', 'shutdownPosthog', [], {handle: 'clone'});
  // The mock proves wrapper forwarding and await order only; real SDK tests
  // establish closed-client behavior. It deliberately does not fake SDK drops.
  await invoke('shutdown/post-capture', 'trackCommand', [command]);
  await invoke('shutdown/second-instance', 'shutdownPosthog', [], {instance: 'process-b'});
  assert(records.length >= 300);
  const files = ['src/utils/posthog_events.ts', 'src/utils/ai_usage_event.ts', 'package.json', 'package-lock.json', 'Cargo.lock',
    'src/utils/posthog_events.rs', 'src/utils/ai_usage.rs', 'src/utils/js_string.rs', 'src/utils/js_compat.rs', 'src/utils/lossless_json.rs', 'src/utils/json_number.rs',
    'src/utils/posthog_tracking.rs', 'src/utils/posthog_lossless.rs', 'tests/posthog_tracking.rs', 'tests/fixtures/posthog_tracking_reference.cjs'];
  const callerFiles = ['src/classes/twitch_streamers.class.ts', 'src/handlers/message.handler.ts',
    'src/utils/ast_parser/functions/tts.functions.ts', 'src/utils/polarsh.ts', 'src/handlers/tts_queue.handler.ts'];
  const callers = callerFiles.map(file => {
    const text = read(file), sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const calls = [];
    function visit(n) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && expectedExports.includes(n.expression.text)) {
        calls.push({name: n.expression.text, text: n.getText(sf)});
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    assert(calls.length > 0, `caller trace ${file}`);
    return {file, sha256: sha(text), imports: ast(path.join(root, file)).imports, calls};
  });
  const sources = Object.fromEntries(files.map(p => [p, read(p)]));
  const sdkPins = {
    'Cargo.toml': '7c2898b66160da1b4d971d1ab62921c05817d9d7cb45c9366312a917728a7da7',
    'src/event.rs': '5a4112ea152b483a2dc25195bd56901ece4e6da363dd0904babe48776ceae312',
    'src/client/async_client.rs': '0c2bb5560eff1a281dd4b1986a40256a3fbb0c3eea3847751a06d6a3c00fbd72',
    'src/client/transport.rs': '2f1cbce6b0ac5bd33c76cfc43957f22651640ff626224c9e1753603a4caf059b',
    'src/lib.rs': 'bdd3347d2600557fbb05f15a06647f5495a54eba3f8f9579aefa084ff9883242',
    'src/client/mod.rs': 'e2dd52f1e691fb9cd1451fac307cc4a54e5c4632a621892283dedb91ec07a577',
    'src/client/retry.rs': '563cbf0a7979dcf9879af89bf2e2642eef6c543fcb5d506615c6a227c20802f0',
    'src/client/v0_capture.rs': 'c4442aef3a7b67d790ec828c2c368d21fba0fe9fe4749d8f987b642ecfa7e5b4',
    'src/client/common.rs': '26b934e180e51f3b12b7ca6693feccee12edeceaa9f916934f6e875b71fb068d',
  };
  for (const [file, expected] of Object.entries(sdkPins)) assert.equal(sha(fs.readFileSync(path.join(sdk, file))), expected, `SDK source ${file}`);
  const packagePins = {};
  for (const name of ['typescript', 'posthog-node', '@posthog/core', '@types/node']) {
    // posthog-node does not export its package.json subpath.
    const p = path.join(root, 'node_modules', name, 'package.json');
    packagePins[name] = {version: JSON.parse(fs.readFileSync(p, 'utf8')).version, sha256: sha(fs.readFileSync(p))};
  }
  assert.equal(packagePins['posthog-node'].version, '5.47.3');
  assert.equal(packagePins.typescript.version, '5.9.3');
  const imports = [...new Map(runtimeImports.map(i => [`${i.file}:${i.module}`, i])).values()];
  assert.deepEqual(imports, [
    {file: 'src/utils/ai_usage_event.ts', module: 'node:crypto'},
    {file: 'src/utils/posthog_events.ts', module: 'posthog-node'},
    {file: 'src/utils/posthog_events.ts', module: './ai_usage_event.js'},
  ]);
  const output = JSON.stringify({metadata: {
    format: 2, node: process.version, v8: process.versions.v8, typescript: ts.version,
    sourceAst, usageAst: ast(usagePath), callers, runtimeImports: imports, strict: {diagnostics: 0, skipLibCheck: true}, packagePins,
    hashes: Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, sha(s)])), sdkPins,
    recordCount: records.length,
    contracts: 'plain-json preserves JSON casts; required absence and nonstring distinct/template IDs rejected natively; source calls still recorded. Native contexts reuse real createAiUsageContext; supplied IDs avoid nondeterministic UUIDs. SDK boundary only mocked.',
  }, sources, constructors: Object.fromEntries([...sessions].map(([k, v]) => [k, v.constructor])), records}, null, 2) + '\n';
  const file = path.join(dir, 'posthog_tracking.json');
  if (mode === '--write') fs.writeFileSync(file, output, {flag: 'wx'});
  else {
    assert.deepEqual(fs.readdirSync(dir), ['posthog_tracking.json'], 'exact fixture directory');
    assert.equal(fs.readFileSync(file, 'utf8'), output, 'all metadata and records must match');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
