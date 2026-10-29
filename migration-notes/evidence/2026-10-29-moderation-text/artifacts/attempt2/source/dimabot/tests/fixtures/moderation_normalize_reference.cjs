#!/usr/bin/env node
'use strict';
// Execute the unchanged TypeScript pure module with the pinned Node/TS stack.
// Generate a single fixture outside the source tree; --check reproduces bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_MODERATION_NORMALIZE_NODE_SHA256, pin);
assert.equal(digest(fs.readFileSync(process.execPath)), pin);
assert.deepEqual([process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode],
  ['24.22.1', '13.6.233.17-node.58', '78.3', '17.0']);
const rootArg = process.env.DIMA_MODERATION_NORMALIZE_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg));
const root = fs.realpathSync(rootArg);
assert.equal(rootArg, root);
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dirArg && !extra.length);
assert(path.isAbsolute(dirArg));
const dir = fs.realpathSync(dirArg);
assert.equal(dir, dirArg);
assert(fs.statSync(dir).isDirectory() && dir !== root && !dir.startsWith(root + path.sep));
const name = 'moderation-normalize-reference.json';
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [name]);
if (mode === '--check') assert(fs.lstatSync(path.join(dir, name)).isFile());
const read = relative => fs.readFileSync(path.join(root, relative));
const localRequire = createRequire(path.join(root, 'package.json'));
const ts = localRequire('typescript');
assert.equal(ts.version, '5.9.3');
const source = read('src/utils/moderation/normalize.ts');
const sf = ts.createSourceFile('normalize.ts', source.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const expected = String.raw`
export function foldText(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&');
}`;
const reference = ts.createSourceFile('expected.ts', expected, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(sf.parseDiagnostics.length, 0);
assert.equal(reference.parseDiagnostics.length, 0);
function structure(node) {
  const children = [];
  ts.forEachChild(node, child => { children.push(structure(child)); });
  return {kind: node.kind, text: node.kind !== ts.SyntaxKind.SourceFile && typeof node.text === 'string' ? node.text : null, children};
}
assert.deepEqual(structure(sf), structure(reference), 'entire source, including types and exports, changed');
assert.equal(sf.statements.length, 2);
assert.deepEqual(sf.statements.map(s => s.name.text), ['foldText', 'escapeRegExp']);
assert(sf.statements.every(s => ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)));
const compiled = ts.transpileModule(source.toString('utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}});
const sandbox = {exports: {}};
vm.runInNewContext(compiled.outputText, sandbox, {filename: 'normalize.ts'});
assert.deepEqual(Object.keys(sandbox.exports).sort(), ['escapeRegExp', 'foldText']);
const {foldText, escapeRegExp} = sandbox.exports;
assert.equal(foldText('CAFÉ'), 'cafe');
assert.equal(escapeRegExp('a.b[c]'), 'a\\.b\\[c\\]');
const units = text => Array.from({length: text.length}, (_, i) => text.charCodeAt(i));
const inputs = [];
for (let cp = 0; cp < 128; cp++) inputs.push(String.fromCharCode(cp));
const metas = '.*+?^${}()|[]\\';
for (const meta of metas) inputs.push(meta, meta + 'x', 'x' + meta, 'x' + meta + 'y', meta.repeat(4), 'A' + meta + '\ud800' + meta + '\udc00');
inputs.push('', metas, metas + metas, 'unescaped /,-_!\n\0', 'Café İ Å', 'A\u0345Σ', '\u0345Σ',
  'AΣ\u0345A', '\ud800', '\udc00', '\ud801\u0301\udc00', '\ud800.😀[\udc00',
  'A\u0301\u1ade\u0327Σ', 'a\u2028\u2029b', 'AΣ' + '\u0345'.repeat(10000) + 'A',
  'A' + 'Σ\u0345'.repeat(10000) + '!');
const cases = inputs.map(input => {
  const fold = foldText(input), escaped = escapeRegExp(input);
  return {input: units(input), fold: units(fold), foldJson: JSON.stringify(fold), escape: units(escaped), escapeJson: JSON.stringify(escaped)};
});
const nullish = [null, undefined].map((input, index) => {
  const output = foldText(input);
  return {kind: index === 0 ? 'null' : 'undefined', fold: units(output), foldJson: JSON.stringify(output)};
});
const files = [
  'src/utils/moderation/normalize.ts', 'src/utils/moderation/normalize.rs',
  'src/utils/js_unicode.rs', 'src/utils/js_unicode_data.rs', 'src/utils/js_string.rs',
  'src/utils/js_compat.rs', 'tests/moderation_normalize.rs', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json',
];
const sourceSha256 = Object.fromEntries(files.map(file => [file, digest(read(file))]));
sourceSha256['typescript-resolved-js'] = digest(fs.readFileSync(localRequire.resolve('typescript')));
sourceSha256['typescript-package.json'] = digest(fs.readFileSync(localRequire.resolve('typescript/package.json')));
sourceSha256['oracle-script'] = digest(fs.readFileSync(__filename));
sourceSha256['normalize-canonical-declarations'] = digest(ts.createPrinter({removeComments: true, newLine: ts.NewLineKind.LineFeed}).printFile(sf));
const output = JSON.stringify({
  format: 1, implementation: 'actual-typescript',
  versions: {node: process.versions.node, v8: process.versions.v8, icu: process.versions.icu, unicode: process.versions.unicode, typescript: ts.version},
  nodeExecutableSha256: pin, sourceSha256, cases, nullish,
}, null, 2) + '\n';
const target = path.join(dir, name);
if (mode === '--write') fs.writeFileSync(target, output, {flag: 'wx'});
else assert.equal(fs.readFileSync(target, 'utf8'), output);
console.log(`${name} sha256=${digest(output)} stringCases=${cases.length} nullishCases=${nullish.length}`);
