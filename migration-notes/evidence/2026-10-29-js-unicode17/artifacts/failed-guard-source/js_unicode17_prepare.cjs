#!/usr/bin/env node
'use strict';

// Run only with the pinned Node binary and the explicit source root. This reads
// source and SDK bytes, executes the two isolated pure exports, and writes only
// the two named artifacts to an existing, empty external directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_JS_UNICODE_NODE_SHA256, pin, 'explicit Node SHA-256 pin required');
assert.equal(digest(fs.readFileSync(process.execPath)), pin, 'wrong Node executable');
assert.equal(process.versions.node, '24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(process.versions.icu, '78.3');
assert.equal(process.versions.unicode, '17.0');
const rootArg = process.env.DIMA_JS_UNICODE_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg), 'absolute DIMA_JS_UNICODE_SOURCE_ROOT required');
const root = fs.realpathSync(rootArg);
assert.equal(rootArg, root, 'source root must be canonical');
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dirArg && !extra.length, 'usage: --write|--check ABSOLUTE_DIRECTORY');
assert(path.isAbsolute(dirArg), 'output directory must be absolute');
const dir = fs.realpathSync(dirArg);
assert.equal(dirArg, dir, 'output directory must be canonical');
assert(fs.statSync(dir).isDirectory());
assert(dir !== root && !dir.startsWith(root + path.sep), 'output must be external to source root');
const names = ['js_unicode_data.rs', 'unicode17-reference.json'];
const entries = fs.readdirSync(dir).sort();
assert.deepEqual(entries, mode === '--write' ? [] : [...names].sort(), 'output directory contents');
if (mode === '--check') for (const name of names) assert(fs.lstatSync(path.join(dir, name)).isFile(), 'artifact must be a regular file');

const read = relative => fs.readFileSync(path.join(root, relative));
const localRequire = createRequire(path.join(root, 'package.json'));
const tsPath = localRequire.resolve('typescript');
const ts = localRequire('typescript');
assert.equal(ts.version, '5.9.3');
const source = read('src/utils/moderation/normalize.ts');
const sf = ts.createSourceFile('normalize.ts', source.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(sf.parseDiagnostics.length, 0);
assert.equal(sf.statements.length, 2);
assert(sf.statements.every(s => ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)));
assert.deepEqual(sf.statements.map(s => s.name.text), ['foldText', 'escapeRegExp']);
// Comparing canonical TypeScript AST printer output checks the complete program,
// including type annotations, operators, call order, flags and both exports.
const expected = String.raw`
export function foldText(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&');
}`;
const referenceAst = ts.createSourceFile('expected.ts', expected, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(referenceAst.parseDiagnostics.length, 0);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
assert.equal(printer.printFile(sf), printer.printFile(referenceAst), 'normalize.ts program changed');
const regexes = [];
function visit(node) {
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regexes.push(node.getText(sf));
  ts.forEachChild(node, visit);
}
visit(sf);
assert.equal(regexes[0], String.raw`/\p{M}/gu`);
const match = /^\/(.*)\/([a-z]+)$/.exec(regexes[0]);
assert(match && match[2] === 'gu');
const marks = new RegExp(match[1], match[2].replace('g', ''));
const generalMarks = /\p{M}/u;
const compiled = ts.transpileModule(source.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const sandbox = { exports: {} };
vm.runInNewContext(compiled.outputText, sandbox, { filename: 'normalize.ts' });
assert.deepEqual(Object.keys(sandbox.exports).sort(), ['escapeRegExp', 'foldText']);
assert.equal(sandbox.exports.foldText('CAFÉ'), 'cafe');
assert.equal(sandbox.exports.foldText('A\u0345Σ'), 'aς');
assert.equal(sandbox.exports.escapeRegExp('a.b[c]'), 'a\\.b\\[c\\]');

const cased = /\p{Cased}/u, ignorable = /\p{Case_Ignorable}/u, assigned = /\p{Assigned}/u;
const predicates = { cased, caseIgnorable: ignorable, mark: marks, assigned };
const ranges = Object.fromEntries(Object.keys(predicates).map(k => [k, []]));
const counts = Object.fromEntries(Object.keys(predicates).map(k => [k, 0]));
const lower = [], nfd = [], overlap = [];
const codepoints = str => Array.from(str, c => c.codePointAt(0));
const units = str => Array.from({ length: str.length }, (_, i) => str.charCodeAt(i));
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const input = String.fromCodePoint(cp);
  const flags = {};
  for (const [key, re] of Object.entries(predicates)) {
    flags[key] = re.test(input);
    if (flags[key]) {
      counts[key]++;
      const a = ranges[key], last = a[a.length - 1];
      if (last && last[1] === cp - 1) last[1] = cp;
      else a.push([cp, cp]);
    }
  }
  assert.equal(flags.mark, generalMarks.test(input));
  const l = input.toLowerCase(), d = input.normalize('NFD');
  if (l !== input) {
    const target = codepoints(l);
    assert(target.length && target.every(x => x <= 0x10ffff && !(x >= 0xd800 && x <= 0xdfff)), 'invalid lowercase target');
    lower.push([cp, target]);
  }
  if (d !== input) nfd.push([cp, codepoints(d)]);
  if (!flags.assigned) assert.equal(d, input, 'unassigned NFD must be unchanged');
  if (cp >= 0xd800 && cp <= 0xdfff) assert.equal(l, input, 'lone surrogate changed');
  if (flags.cased && flags.caseIgnorable) overlap.push(cp);
}
// Record built-in results, not an invented casing implementation. In the default
// Unicode conversion Final_Sigma is the only locale-independent contextual rule.
// Both sides of sigma include all four surrounding cased/non-cased states, and
// punctuation and lone-surrogate barriers, for each overlapping code point.
const contexts = [];
for (const cp of overlap) for (const side of ['before', 'after']) {
  for (const left of ['A', '!']) for (const right of ['A', '!']) {
    for (const barrier of ['', '!', '\ud800']) {
      const ch = String.fromCodePoint(cp);
      const input = side === 'before' ? left + barrier + ch + 'Σ' + right : left + 'Σ' + ch + barrier + right;
      contexts.push({ cp, side, leftCased: left === 'A', rightCased: right === 'A', barrier: units(barrier), input: units(input), lower: units(input.toLowerCase()) });
    }
  }
}
const rustPairs = (name, rows) => `pub static ${name}: &[(u32, u32)] = &[\n` + rows.map(([a, b]) => `    (0x${a.toString(16)}, 0x${b.toString(16)}),\n`).join('') + '];\n';
let rust = '// Generated by js_unicode17_prepare.cjs from pinned Node; do not edit.\n';
rust += 'pub static LOWERCASE_MAPPINGS: &[(u32, &[u32])] = &[\n' + lower.map(([cp, out]) => `    (0x${cp.toString(16)}, &[${out.map(x => `0x${x.toString(16)}`).join(', ')}]),\n`).join('') + '];\n';
for (const [key, name] of [['cased', 'CASED_RANGES'], ['caseIgnorable', 'CASE_IGNORABLE_RANGES'], ['mark', 'MARK_RANGES'], ['assigned', 'ASSIGNED_RANGES']]) rust += rustPairs(name, ranges[key]);
const files = ['src/utils/moderation/normalize.ts', 'src/utils/ast_parser/evaluator.ts', 'src/utils/ast_parser/evaluator/value.rs', 'package.json', 'package-lock.json', 'rust-toolchain.toml'];
const inputs = Object.fromEntries(files.map(f => [f, digest(read(f))]));
inputs['typescript-resolved-js'] = digest(fs.readFileSync(tsPath));
inputs['typescript-package.json'] = digest(fs.readFileSync(localRequire.resolve('typescript/package.json')));
inputs['generator-script'] = digest(fs.readFileSync(__filename));
inputs['normalize-canonical-declarations'] = digest(printer.printFile(sf));
const result = {
  format: 1,
  versions: { node: process.versions.node, v8: process.versions.v8, icu: process.versions.icu, unicode: process.versions.unicode, typescript: ts.version },
  nodeExecutableSha256: pin, sourceSha256: inputs, generatedRustSha256: digest(rust),
  methods: {
    enumeration: 'String.fromCodePoint for every integer 0..0x10ffff inclusive, including lone surrogate values',
    lowercase: 'single-code-point String.prototype.toLowerCase; identity omitted; outputs encoded as code point arrays',
    properties: 'Node Unicode /u property escapes Cased, Case_Ignorable, Assigned; Mark from actual normalize.ts regex AST with g removed, cross-checked against /\\p{M}/u',
    nfd: 'single-code-point String.prototype.normalize(NFD); identity omitted; outputs encoded as code point arrays, including Hangul',
    contexts: 'actual String.prototype.toLowerCase for every Cased and Case_Ignorable intersection point on either side of Greek capital sigma, each pair of cased/non-cased surroundings and empty, punctuation or lone-surrogate barrier; input/output are UTF-16 code units',
    sourceValidation: 'TypeScript 5.9.3 parses both exports and printer-compares the entire AST against the expected program; actual source transpiled and pure exports sanity checked in an isolated VM',
    rule: 'Unicode Default Case Conversion has Final_Sigma as its only locale-independent contextual mapping; check Case_Ignorable before Cased when scanning context',
  },
  counts: { ...counts, lowercaseMappings: lower.length, nfdMappings: nfd.length, casedIgnorableOverlap: overlap.length, contextualGoldens: contexts.length, ranges: Object.fromEntries(Object.entries(ranges).map(([k, v]) => [k, v.length])) },
  ranges, lowercaseMappings: lower, nfdMappings: nfd, casedIgnorableOverlap: overlap, contextualGoldens: contexts,
};
const artifacts = { 'js_unicode_data.rs': rust, 'unicode17-reference.json': JSON.stringify(result, null, 2) + '\n' };
for (const name of names) {
  const output = path.join(dir, name);
  if (mode === '--write') fs.writeFileSync(output, artifacts[name], { flag: 'wx' });
  else assert.equal(fs.readFileSync(output, 'utf8'), artifacts[name], `${name} differs`);
  console.log(`${name} sha256=${digest(artifacts[name])}`);
}
console.log(JSON.stringify(result.counts));
