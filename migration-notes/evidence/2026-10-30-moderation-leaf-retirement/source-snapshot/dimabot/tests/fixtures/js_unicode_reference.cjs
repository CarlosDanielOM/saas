#!/usr/bin/env node
'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
// Pinned source oracle. Only writes one file in an empty external directory;
// --check regenerates and compares exact bytes. No application is started.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_JS_UNICODE_NODE_SHA256, pin);
assert.equal(digest(fs.readFileSync(process.execPath)), pin);
assert.deepEqual([process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode],
  ['24.22.1', '13.6.233.17-node.58', '78.3', '17.0']);
const rootArg = process.env.DIMA_JS_UNICODE_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg));
const root = fs.realpathSync(rootArg);
assert.equal(root, rootArg);
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dirArg && !extra.length);
assert(path.isAbsolute(dirArg));
const dir = fs.realpathSync(dirArg);
assert.equal(dir, dirArg);
assert(fs.statSync(dir).isDirectory() && dir !== root && !dir.startsWith(root + path.sep));
const name = 'js-unicode-source-reference.json';
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [name]);
if (mode === '--check') assert(fs.lstatSync(path.join(dir, name)).isFile());
const read = relative => fs.readFileSync(leaf.sourcePath(root, relative));
const localRequire = createRequire(path.join(root, 'package.json'));
const ts = localRequire('typescript');
assert.equal(ts.version, '5.9.3');
const source = read('src/utils/moderation/normalize.ts');
const sf = ts.createSourceFile('normalize.ts', source.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(sf.parseDiagnostics.length, 0);
const expected = String.raw`
export function foldText(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&');
}`;
const ref = ts.createSourceFile('expected.ts', expected, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(ref.parseDiagnostics.length, 0);
function structure(node) {
  const children = [];
  ts.forEachChild(node, child => { children.push(structure(child)); });
  return { kind: node.kind, text: node.kind !== ts.SyntaxKind.SourceFile && typeof node.text === 'string' ? node.text : null, children };
}
assert.deepEqual(structure(sf), structure(ref), 'normalize.ts program changed');
assert.deepEqual(sf.statements.map(s => s.name.text), ['foldText', 'escapeRegExp']);
const compiled = ts.transpileModule(source.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const sandbox = { exports: {} };
vm.runInNewContext(compiled.outputText, sandbox, { filename: 'normalize.ts' });
assert.deepEqual(Object.keys(sandbox.exports).sort(), ['escapeRegExp', 'foldText']);
const fold = sandbox.exports.foldText;
assert.equal(fold('CAFÉ'), 'cafe');
assert.equal(sandbox.exports.escapeRegExp('a.b[c]'), 'a\\.b\\[c\\]');
const units = s => Array.from({length: s.length}, (_, i) => s.charCodeAt(i));
const scalarFolds = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const input = String.fromCodePoint(cp), output = fold(input);
  if (output !== input) scalarFolds.push([cp, units(output)]);
}
const inputs = [
  '', 'ascii', 'ASCII', 'İ', 'A\u0345Σ', '\u0345Σ', 'AΣ\u0345A',
  '\ud800', '\udc00', '\ud800AΣ\udc00', '\ud800\ud800\udc00\udc00', '\ud801\u0301\udc00',
  'A\u0301\u0327', '\u00c5\u0327\u0301', '\u1100\u1161\u11a8',
  'A\u0301\u1ade\u0327Σ', 'A\u0301\u1adf\u0327Σ',
  'A' + 'Σ\u0345'.repeat(20000) + '!',
  'AΣ' + '\u0345'.repeat(20000) + 'A',
  'AΣ' + '\u0345'.repeat(20000) + '!',
];
for (const cp of [0x1ade, 0x1adf]) assert(!/\p{Assigned}/u.test(String.fromCodePoint(cp)));
const cases = inputs.map(input => ({ input: units(input), lower: units(input.toLowerCase()), fold: units(fold(input)) }));
const files = ['src/utils/moderation/normalize.ts', 'package.json', 'package-lock.json', 'rust-toolchain.toml'];
const sourceSha256 = Object.fromEntries(files.map(f => [f, digest(read(f))]));
sourceSha256['typescript-resolved-js'] = digest(fs.readFileSync(localRequire.resolve('typescript')));
sourceSha256['typescript-package.json'] = digest(fs.readFileSync(localRequire.resolve('typescript/package.json')));
sourceSha256['oracle-script'] = digest(fs.readFileSync(__filename));
sourceSha256['normalize-canonical-declarations'] = digest(ts.createPrinter({removeComments: true, newLine: ts.NewLineKind.LineFeed}).printFile(sf));
const output = JSON.stringify({
  format: 1, implementation: 'actual-typescript',
  versions: {node: process.versions.node, v8: process.versions.v8, icu: process.versions.icu, unicode: process.versions.unicode, typescript: ts.version},
  nodeExecutableSha256: pin, sourceProvenance: leaf.provenance(root,["src/utils/moderation/normalize.ts"]), sourceSha256, scalarFolds, cases,
}, null, 2) + '\n';
const target = path.join(dir, name);
if (mode === '--write') fs.writeFileSync(target, output, {flag: 'wx'});
else assert.equal(fs.readFileSync(target, 'utf8'), output);
console.log(`${name} sha256=${digest(output)} scalarFolds=${scalarFolds.length} cases=${cases.length}`);
