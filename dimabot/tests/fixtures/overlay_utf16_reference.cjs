'use strict';
// Authoring-only source probe. Run in the coordinator's isolated pinned Node fixture phase.
// It transpiles the real local TS parser, evaluator, and overlay consumer; no network/database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const [mode, directory, ...rest] = process.argv.slice(2);
assert.equal(mode, '--write'); assert(directory && !rest.length);
assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER, 'dimabot-migration');
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const output = fs.realpathSync(directory);
assert(!output.startsWith(path.dirname(root) + path.sep));
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const loaded = new Map(), hashes = {};
const forbidden = () => { throw Error('external I/O forbidden in overlay UTF-16 probe'); };
function load(file) {
  file = path.resolve(file);
  assert(file === path.join(root, 'src/overlays/ast.ts') || file.startsWith(path.join(root, 'src/utils/ast_parser') + path.sep), `unexpected source: ${file}`);
  if (loaded.has(file)) return loaded.get(file).exports;
  const module = {exports:{}}; loaded.set(file, module);
  const source = fs.readFileSync(file, 'utf8');
  hashes[path.relative(root, file)] = crypto.createHash('sha256').update(source).digest('hex');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  function local(name) {
    if (name.endsWith('/databases/dragonfly.database.js')) return {getDragonflyClient:forbidden};
    if (name.endsWith('/functions/chats/index.js')) return {};
    assert(name.startsWith('.'), `external module forbidden: ${name}`);
    return load(path.resolve(path.dirname(file), name.replace(/\.js$/, '.ts')));
  }
  vm.runInNewContext(code, {module, exports:module.exports, require:local, console, Buffer, setTimeout, clearTimeout}, {filename:file});
  return module.exports;
}
const ast = load(path.join(root, 'src/overlays/ast.ts'));
const units = s => Array.from({length:s.length}, (_, i) => s.charCodeAt(i).toString(16).padStart(4,'0'));
const inputs = [
  ['lone-high', '\ud800'], ['lone-low', '\udc00'], ['mixed-literals', 'A\ud800B\udc00C'],
  ['pair-and-lone', 'A\ud83d\ude00\ud800Z'],
  ['quoted-interpolation', '"A\ud800${upper(\'x\')}\udc00Z"'],
  ['scanner-before-braces', '"\ud800${1}\udc00"'],
  ['scanner-unclosed-expression', '"\ud800${1\udc00"'],
  ['disallowed-function', '"\ud800${unknown()}\udc00"'],
  ['limit-2000', 'x'.repeat(1999)+'\ud800'], ['limit-2001', 'x'.repeat(2000)+'\ud800'],
];
async function main() {
  const cases = [];
  for (const [name, input] of inputs) {
    const item = {name, inputUnits:units(input)};
    try {
      const tree = ast.parseTemplate(input);
      item.ast = tree;
      // JSON stringification escapes lone surrogates and restores exact units on parse.
      const persisted = JSON.parse(JSON.stringify({text:input})).text;
      item.jsonRoundTripUnits = units(persisted);
      item.renderUnits = units(await ast.renderTemplate(persisted, 'fixture-channel', {user_name:'Luna'}));
    } catch (e) { item.error = String(e && e.message || e); }
    cases.push(item);
  }
  fs.writeFileSync(path.join(output, 'overlay-utf16-reference.json'), JSON.stringify({sources:hashes,cases},null,2)+'\n', {flag:'wx'});
}
main().catch(e => { console.error(e); process.exitCode=1; });
