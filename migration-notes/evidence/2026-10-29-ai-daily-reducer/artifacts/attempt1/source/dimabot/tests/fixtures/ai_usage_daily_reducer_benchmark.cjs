'use strict';
// Offline, prepared-operation benchmark. The Rust driver interleaves trials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const ts = require('typescript');
const [mode, directory, ...rest] = process.argv.slice(2);
assert(['--write', '--check', '--serve'].includes(mode) && directory && !rest.length);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const root = fs.realpathSync(path.join(__dirname, '../..'));
const repo = fs.realpathSync(path.join(root, '..'));
const out = fs.realpathSync(directory);
assert(out !== repo && !out.startsWith(repo + path.sep), 'output must be external');
if (mode === '--write') assert.deepEqual(fs.readdirSync(out), [], 'fresh empty directory required');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const nodeExecutableSha256 = sha(fs.readFileSync(fs.realpathSync(process.execPath)));
const source = fs.readFileSync(path.join(root, 'src/utils/ai_usage_ledger.ts'), 'utf8');
assert.equal(sha(source), '3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5');
const ast = ts.createSourceFile('ai_usage_ledger.ts', source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
function declaration(name) {
 const matches = ast.statements.filter(n => n.name?.text === name ||
  ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
 assert.equal(matches.length, 1, name);
 return matches[0];
}
const rebuild = declaration('rebuildUtcDailyAggregates');
assert(ts.isFunctionDeclaration(rebuild));
const statements = rebuild.body.statements;
const rows = statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === 'rows'));
const loops = statements.filter(ts.isForOfStatement);
assert.equal(rows.length, 1); assert.equal(loops.length, 1);
assert.equal(loops[0].expression.getText(ast), 'groups');
const nodes = [declaration('VALID_CATEGORIES'), declaration('safeCategory'), rows[0], loops[0]];
const snippets = nodes.map(n => ({kind: ts.SyntaxKind[n.kind], text: n.getText(ast),
 startByte: Buffer.byteLength(source.slice(0, n.getStart(ast))), endByte: Buffer.byteLength(source.slice(0, n.end)),
 sha256: sha(n.getText(ast))}));
const typeSources = {};
for (const [file, names] of [
 ['src/utils/ai_usage_event.ts', ['AiUsageEntryKind', 'AiUsageCategory', 'AiUsageUnit', 'AiUsageResourceType']],
 ['src/utils/ai_usage_receipts.ts', ['AiUsageReceiptCategory', 'AiUsageTransaction']]
]) {
 const text = fs.readFileSync(path.join(root, file), 'utf8');
 const tree = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
 assert.deepEqual(tree.parseDiagnostics, []);
 const declarations = names.map(name => {
  const found = tree.statements.filter(n => n.name?.text === name);
  assert.equal(found.length, 1, name);
  const node = found[0], snippet = node.getText(tree);
  return {name, kind: ts.SyntaxKind[node.kind], text: snippet, sha256: sha(snippet),
   startByte: Buffer.byteLength(text.slice(0, node.getStart(tree))), endByte: Buffer.byteLength(text.slice(0, node.end))};
 });
 typeSources[file] = {sha256: sha(text), declarations};
}
// Preserve exact source statements and their embedded types; transpilation erases types only.
const extracted = `${snippets[0].text}\n${snippets[1].text}\nfunction reduce(groups: any[]) {\n${snippets[2].text}\n${snippets[3].text}\nreturn rows;\n}\nexports.reduce = reduce;\n`;
const compiled = ts.transpileModule(extracted, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
assert.deepEqual(compiled.diagnostics, []);
const moduleObject = {exports: {}};
new Function('exports', 'module', compiled.outputText)(moduleObject.exports, moduleObject);
const reduce = moduleObject.exports.reduce;
const bits = n => {const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex');};
const number = h => Buffer.from(h, 'hex').readDoubleBE();
const sizes = [1, 30, 90, 366, 3660];
function generate(days) {
 const groups = [];
 // Each date recurs across passes; different unknown categories normalize to the same key.
 const cats = ['tts', 'ai_chat', 'legacy-a', 'legacy-b'];
 for (let pass = 0; pass < cats.length; pass++) for (let i = 0; i < days; i++) {
  const day = new Date(Date.UTC(2015, 0, 1) + ((i * 17) % days) * 86400000).toISOString().slice(0, 10);
  groups.push({date: day, category: cats[pass], spent: bits((i % 11) + pass + 1),
   granted: bits(pass % 2), debited: bits(pass % 3), count: bits((i % 3) + 1),
   expiresAt: 1800000000000 + pass * 86400000});
 }
 return groups;
}
function prepare(input) { return input.map(g => ({_id: {date: g.date, category: g.category},
 spent: number(g.spent), granted: number(g.granted), debited: number(g.debited), count: number(g.count), expiresAt: new Date(g.expiresAt)})); }
function summary(rows) { return [...rows].map(([date, r]) => ({date, spentCredits: r.spentCredits,
 grantedCredits: r.grantedCredits, netConsumedCredits: r.spentCredits + r.debitedCredits - r.grantedCredits,
 transactionCount: r.transactionCount, categories: r.categories, expiresAt: r.expiresAt.getTime()})); }
const inputs = Object.fromEntries(sizes.map(n => [String(n), generate(n)]));
const expected = Object.fromEntries(sizes.map(n => [String(n), summary(reduce(prepare(inputs[n])))]));
const metadata = {source: 'src/utils/ai_usage_ledger.ts', sourceSha256: sha(source), node: process.version,
 v8: process.versions.v8, typescript: ts.version, nodeExecutableSha256, snippets, typeSources, extracted, compiled: compiled.outputText,
 typescriptModuleSha256: sha(fs.readFileSync(require.resolve('typescript'))),
 inputEncoding: 'UTF-8 JSON; numeric inputs are IEEE-754 binary64 big-endian hex; dates/categories ASCII (identical UTF-16 code units)',
 workloads: sizes, passes: 4, warmupOps: 'max(3,min(10000,ceil(100000/groupCount)))',
 timedOps: 'max(1,min(1000,ceil(50000/groupCount)))', trials: 7};
const artifacts = {'inputs.json': JSON.stringify(inputs), 'expected.json': JSON.stringify(expected),
 'source.json': JSON.stringify(metadata)};
for (const [name, data] of Object.entries(artifacts)) {
 const file = path.join(out, name);
 if (mode === '--write') fs.writeFileSync(file, data, {flag: 'wx'});
 else assert.equal(fs.readFileSync(file, 'utf8'), data, name);
}
if (mode === '--serve') {
 const prepared = Object.fromEntries(sizes.map(n => [String(n), prepare(inputs[n])]));
 const initial = sha(fs.readFileSync(path.join(out, 'inputs.json')));
 const preparedInitial = sha(JSON.stringify(prepared));
 let sink = 0;
 const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
 rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.op === 'finish') {
   assert.equal(sha(fs.readFileSync(path.join(out, 'inputs.json'))), initial);
   assert.equal(sha(JSON.stringify(prepared)), preparedInitial);
   process.stdout.write(JSON.stringify({inputSha256: initial, preparedSha256: preparedInitial, nodeExecutableSha256, sink}) + '\n'); rl.close(); return;
  }
  assert(['warmup', 'trial'].includes(request.op) && sizes.includes(request.days));
  const groupCount = prepared[request.days].length;
  const iterations = request.op === 'warmup' ? Math.max(3, Math.min(10000, Math.ceil(100000 / groupCount)))
   : Math.max(1, Math.min(1000, Math.ceil(50000 / groupCount)));
  assert.equal(request.iterations, iterations);
  const results = new Array(iterations);
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) results[i] = reduce(prepared[request.days]);
  const elapsedNs = Number(process.hrtime.bigint() - start);
  let checksum = 0;
  for (const result of results) checksum += result.size;
  sink = (sink + checksum) >>> 0;
  process.stdout.write(JSON.stringify({elapsedNs, iterations, checksum}) + '\n');
 });
}
