'use strict';
// Actual-TypeScript constant oracle for the retired OpenRouter app-attribution
// helper. Run only in the pinned disposable Node 24.22.1 / TypeScript 5.9.3
// environment, against a private external fixture directory. No application
// bootstrap, database, network or provider access.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), Module = require('node:module');
const resolver = require('./openrouter_attribution_source.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = fs.realpathSync(process.env.DIMA_OPENROUTER_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const repo = path.join(root, '..');
const relative = file => path.relative(repo, file).split(path.sep).join('/');
const NODE_SHA256 = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const NATIVE = 'src/utils/ai/openrouter/app_attribution.util.rs';
const READER = 'tests/fixtures/openrouter_attribution_reference.cjs';
const HELPER = 'tests/fixtures/openrouter_attribution_source.cjs';
assert.deepEqual([process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode], ['24.22.1', '13.6.233.17-node.58', '78.3', '17.0']);
assert.equal(sha(fs.readFileSync(process.execPath)), NODE_SHA256, 'pinned Node executable');
const local = Module.createRequire(path.join(root, 'package.json')), ts = local('typescript');
assert.equal(ts.version, '5.9.3');
const typescriptImplementation = sha(fs.readFileSync(local.resolve('typescript')));
assert.equal(typescriptImplementation, '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675', 'pinned TypeScript implementation');

// The archived source is resolved through the single allowlisted reader; its
// bytes, manifest entry and provenance are all independently pinned.
const source = resolver.resolveSource(root);
assert.equal(source.sha256, resolver.pins[source.logical]);
assert.equal(sha(source.bytes), source.sha256);
const text = source.bytes.toString('utf8');
const ast = ts.createSourceFile(source.logical, text, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
const imports = ast.statements.filter(statement => ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement));
assert.equal(imports.length, 0, 'the constant module imports nothing');
assert.equal(ast.statements.filter(statement => ts.isExportAssignment(statement)).length, 0);
assert.equal(ast.statements.length, 1, 'exactly one statement');
const statement = ast.statements[0];
assert(ts.isVariableStatement(statement), 'the only statement declares the constant');
assert.deepEqual(statement.modifiers.map(modifier => ts.SyntaxKind[modifier.kind]), ['ExportKeyword']);
assert.equal(statement.declarationList.declarations.length, 1);
const declaration = statement.declarationList.declarations[0];
assert.equal(declaration.name.getText(ast), 'OPENROUTER_APP_HEADERS');
assert.equal(declaration.type, undefined, 'the object type is inferred, not annotated');
assert(ts.isAsExpression(declaration.initializer), 'the export is an `as const` assertion');
const asExpression = declaration.initializer;
assert.equal(asExpression.type.getText(ast), 'const');
assert(ts.isObjectLiteralExpression(asExpression.expression));
const properties = asExpression.expression.properties;
assert.equal(properties.length, 4, 'exactly four ordered header fields');
const fields = properties.map((property, index) => {
  assert(ts.isPropertyAssignment(property), 'only literal property assignments');
  assert(ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer), 'string-literal names and values');
  return {
    index,
    name: property.name.text,
    value: property.initializer.text,
    nameKind: ts.SyntaxKind[property.name.kind],
    valueKind: ts.SyntaxKind[property.initializer.kind],
  };
});
assert.deepEqual(fields.map(field => field.name), ['HTTP-Referer', 'X-OpenRouter-Title', 'X-OpenRouter-Description', 'X-OpenRouter-Categories']);
assert.deepEqual(fields.map(field => field.value), [
  'https://domdimabot.com',
  'DomDimaBot',
  'DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.',
  'general-chat, roleplay',
]);
const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, reportDiagnostics: true });
assert.deepEqual(compiled.diagnostics, []);
// Execute the complete module in a plain CommonJS realm that blocks every
// import. Only own enumerable string entries are observed.
function realm() {
  const mod = new Module(path.join(root, source.logical), module);
  mod.filename = path.join(root, source.logical);
  mod.require = id => { throw new Error(`unexpected import ${id}`); };
  mod._compile(compiled.outputText, mod.filename);
  return mod.exports;
}
const api = realm();
assert.deepEqual(Object.keys(api), ['OPENROUTER_APP_HEADERS']);
const value = api.OPENROUTER_APP_HEADERS;
assert.deepEqual(Object.keys(value), fields.map(field => field.name));
assert.deepEqual(Object.values(value), fields.map(field => field.value));
const units = text => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const manifestFile = path.join(repo, resolver.archiveRelative, 'manifest.json');
const manifestBytes = fs.readFileSync(manifestFile), manifest = JSON.parse(manifestBytes.toString('utf8'));
assert(Array.isArray(manifest.files));
assert.equal(source.archiveEntries, manifest.files.length);
const archiveEntries = manifest.files.filter(entry => entry.source === source.logical);
assert.equal(archiveEntries.length, 1, 'exactly one archive entry for the retired helper');
assert.equal(archiveEntries[0].sha256, source.sha256);
assert.equal(source.manifestSha256, sha(manifestBytes));
const provenance = {
  source: {
    logical: source.logical,
    sha256: source.sha256,
    provenance: source.provenance,
    resolvedPath: relative(source.path),
    archiveEntries: source.archiveEntries,
  },
  native: { path: NATIVE, sha256: sha(fs.readFileSync(path.join(root, NATIVE))) },
  toolchain: {
    node: process.versions.node,
    nodeSha256: NODE_SHA256,
    v8: process.versions.v8,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
    typescript: ts.version,
    typescriptImplementationSha256: typescriptImplementation,
  },
  reader: { path: READER, sha256: sha(fs.readFileSync(__filename)) },
  helper: { path: HELPER, sha256: sha(fs.readFileSync(require.resolve('./openrouter_attribution_source.cjs'))) },
  archiveManifest: { path: relative(manifestFile), sha256: sha(manifestBytes), entries: manifest.files.length },
};
const reference = {
  schema: 1,
  provenance,
  module: {
    logical: source.logical,
    statementCount: ast.statements.length,
    imports: imports.map(statement => statement.moduleSpecifier?.text ?? null),
    declaration: declaration.name.getText(ast),
    modifiers: statement.modifiers.map(modifier => ts.SyntaxKind[modifier.kind]),
    asConstType: asExpression.type.getText(ast),
    fields,
  },
  constants: {
    fields: fields.map(field => ({ name: units(field.name), value: units(field.value) })),
    wire: units(JSON.stringify(value)),
  },
  boundary: 'Read-only typed constant contract: every own enumerable string entry, its order and JSON wire form. `as const` is a compile-time literal-type assertion only; object freezing, prototype identity, mutation and property-descriptor behavior are outside this contract. No HTTP client, header policy or provider call is implemented here.',
};
const [mode, dir, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
function external(directory) {
  assert(path.isAbsolute(directory), 'fixture directory must be absolute');
  const real = fs.realpathSync(directory), workspace = fs.realpathSync(repo);
  assert(real !== workspace && !real.startsWith(workspace + path.sep), 'fixture directory must be outside the workspace');
  return real;
}
function readExact(file) {
  let actual;
  try { actual = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') throw Error(`fixture missing: ${file}`);
    throw error;
  }
  if (!actual) throw Error(`fixture empty: ${file}`);
  return actual;
}
if (['--write', '--check'].includes(mode) && dir) {
  const real = external(dir), name = 'openrouter-attribution-reference.json';
  assert.deepEqual(fs.readdirSync(real), mode === '--write' ? [] : [name]);
  const output = JSON.stringify(reference, null, 2) + '\n';
  if (mode === '--write') fs.writeFileSync(path.join(real, name), output, { flag: 'wx' });
  else assert.equal(readExact(path.join(real, name)), output);
  console.log(JSON.stringify({ mode, sha256: sha(Buffer.from(output)), fields: fields.length, archiveEntries: manifest.files.length }));
} else if (mode === '--resolver-negative' && dir) {
  // Authored negative matrix for the shared reader. Each case builds a throwaway
  // tree under the external directory and asserts a specific rejection.
  const real = external(dir), scratch = fs.mkdtempSync(path.join(real, 'resolver-negative-'));
  const bytes = fs.readFileSync(source.path);
  const cases = [];
  try {
    const build = name => {
      const base = path.join(scratch, name), rootDir = path.join(base, 'dimabot');
      const archiveRoot = path.join(base, resolver.archiveRelative);
      const live = path.join(rootDir, source.logical), archived = path.join(archiveRoot, source.logical);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      const manifest = entries => fs.writeFileSync(path.join(archiveRoot, 'manifest.json'), JSON.stringify({ files: entries }));
      const entry = { source: source.logical, sha256: source.sha256 };
      const expect = (label, fn) => cases.push({ case: label, rejected: (() => { try { fn(); return false; } catch { return true; } })() });
      return { rootDir, archiveRoot, live, archived, manifest, entry, expect };
    };
    {
      const tree = build('missing');
      tree.expect('missing source and manifest', () => resolver.resolveSource(tree.rootDir));
      tree.expect('non-allowlisted logical id', () => resolver.resolveSource(tree.rootDir, '../anything'));
      tree.expect('non-baseline expectation', () => resolver.resolveSource(tree.rootDir, source.logical, 'wrong'));
      fs.symlinkSync(source.path, tree.live);
      tree.manifest([tree.entry]);
      tree.expect('symlinked live source', () => resolver.resolveSource(tree.rootDir));
      fs.unlinkSync(tree.live);
      tree.manifest([]);
      fs.writeFileSync(tree.live, bytes);
      assert.equal(resolver.resolveSource(tree.rootDir).provenance, `dimabot/${source.logical}`);
      fs.mkdirSync(tree.archived, { recursive: true });
      tree.expect('ambiguous live and archive', () => resolver.resolveSource(tree.rootDir));
      fs.rmdirSync(tree.archived);
      tree.expect('tampered live source', () => { fs.writeFileSync(tree.live, Buffer.from('tampered')); try { resolver.resolveSource(tree.rootDir); } finally { fs.writeFileSync(tree.live, bytes); } });
      tree.manifest([tree.entry]);
      tree.expect('retired source shadowed by live file', () => resolver.resolveSource(tree.rootDir));
      fs.unlinkSync(tree.live);
    }
    {
      const tree = build('archive');
      fs.writeFileSync(tree.archived, bytes);
      tree.expect('missing manifest file', () => resolver.resolveSource(tree.rootDir));
      tree.manifest([]);
      tree.expect('manifest without the archive entry', () => resolver.resolveSource(tree.rootDir));
      tree.manifest([tree.entry, tree.entry]);
      tree.expect('duplicate manifest entries', () => resolver.resolveSource(tree.rootDir));
      tree.manifest([{ ...tree.entry, sha256: 'bad' }]);
      tree.expect('bad manifest hash', () => resolver.resolveSource(tree.rootDir));
      tree.manifest([{ ...tree.entry, source: 'src/other.ts' }]);
      tree.expect('manifest entry for another source', () => resolver.resolveSource(tree.rootDir));
      fs.writeFileSync(path.join(tree.archiveRoot, 'manifest.json'), '{');
      tree.expect('invalid manifest JSON', () => resolver.resolveSource(tree.rootDir));
      fs.writeFileSync(path.join(tree.archiveRoot, 'manifest.json'), JSON.stringify({ files: {} }));
      tree.expect('non-array manifest files', () => resolver.resolveSource(tree.rootDir));
      tree.manifest([tree.entry]);
      fs.writeFileSync(tree.archived, Buffer.from('tampered'));
      tree.expect('tampered archived source', () => resolver.resolveSource(tree.rootDir));
      fs.unlinkSync(tree.archived);
      fs.mkdirSync(tree.archived);
      tree.expect('non-regular archived source', () => resolver.resolveSource(tree.rootDir));
      fs.rmdirSync(tree.archived);
      fs.symlinkSync(source.path, tree.archived);
      tree.expect('symlinked archived source', () => resolver.resolveSource(tree.rootDir));
      fs.unlinkSync(tree.archived);
      fs.writeFileSync(tree.archived, bytes);
      fs.unlinkSync(path.join(tree.archiveRoot, 'manifest.json'));
      fs.symlinkSync(path.join(real, 'absent-manifest.json'), path.join(tree.archiveRoot, 'manifest.json'));
      tree.expect('symlinked manifest', () => resolver.resolveSource(tree.rootDir));
      fs.unlinkSync(path.join(tree.archiveRoot, 'manifest.json'));
      tree.manifest([tree.entry]);
      assert.equal(resolver.resolveSource(tree.rootDir).path, tree.archived);
    }
    assert(cases.length > 0 && cases.every(item => item.rejected), 'every rejection case must be rejected');
    console.log(JSON.stringify({ mode, cases: cases.length }));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
} else throw Error('usage: --write ABSOLUTE_DIR | --check ABSOLUTE_DIR | --resolver-negative ABSOLUTE_DIR');
