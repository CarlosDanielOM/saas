'use strict';
const {sourcePath: fixturePath, resolveSource} = require('./ai_usage_source_resolver.cjs');
// Compiles the actual source once into this process's normal CommonJS realm.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
function compile(relative, imports) {
  const file = fixturePath(root, relative);
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = sf.statements.filter(ts.isImportDeclaration).map(x => x.moduleSpecifier.text);
  assert.deepEqual(declarations, relative.endsWith('posthog_events.ts') ? ['posthog-node', './ai_usage_event.js'] : ['node:crypto']);
  const result = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}, reportDiagnostics: true});
  assert.equal(result.diagnostics.length, 0);
  const module = {exports: {}};
  new Function('require', 'module', 'exports', result.outputText)(name => {
    assert(Object.hasOwn(imports, name), `unexpected import ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
// The only crypto export the context module can see throws if nondeterministic IDs are requested.
const usage = compile('src/utils/ai_usage_event.ts', {'node:crypto': {randomUUID() { throw Error('random UUID forbidden'); }}});
let last;
class PostHog {
  constructor() {}
  capture(value) { last = value; }
  identify() { throw Error('identify outside benchmark'); }
  shutdown() { throw Error('shutdown outside benchmark'); }
}
const api = compile('src/utils/posthog_events.ts', {'posthog-node': {PostHog}, './ai_usage_event.js': usage});
module.exports = {root, usage, api, last: () => last};
