'use strict';
// Load the complete pinned source. The only substituted module is its type-only
// schema import, reconstructed from the real schema's picked fields and alias.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {resolveModerationSource, overlaySource} = require('./moderation_source_resolver.cjs');
const root = fs.realpathSync(process.env.DIMA_CAPS_SOURCE_ROOT || path.join(__dirname, '../..'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const pins = {
  'src/utils/moderation/rules/caps.rule.ts': '62f7fe37760cbf5640544cab646a639d06b42883532657634a00e25488888797',
  'src/schemas/channel_moderation_settings.schema.ts': 'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
  'package.json': 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json': 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'rust-toolchain.toml': 'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  'node_modules/typescript/package.json': '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/typescript/lib/typescript.js': '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'tests/fixtures/moderation_caps_unicode_prepare.cjs': '73a1d0fab391ed8460397bd41f489928057f8971c0d5cc871b55e2ffb71474f5',
};
const resolved = resolveModerationSource(root, 'src/utils/moderation/rules/caps.rule.ts');
const read = name => name === 'src/utils/moderation/rules/caps.rule.ts' ? resolved.bytes : fs.readFileSync(path.join(root, name));
for (const [name, digest] of Object.entries(pins)) assert.equal(sha(read(name)), digest, name);
const nodePin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_CAPS_NODE_SHA256, nodePin, 'explicit Node SHA required');
assert.equal(sha(fs.readFileSync(process.execPath)), nodePin);
assert.deepEqual([process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode], ['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
assert.equal(ts.version, '5.9.3');
assert.equal(fs.realpathSync(local.resolve('typescript')), fs.realpathSync(path.join(root, 'node_modules/typescript/lib/typescript.js')));
const sourceName = resolved.virtualPath;
const schemaName = path.join(root, 'src/schemas/channel_moderation_settings.schema.ts');
const source = read('src/utils/moderation/rules/caps.rule.ts').toString('utf8');
const ast = ts.createSourceFile(sourceName, source, ts.ScriptTarget.ES2022, true);
const schema = ts.createSourceFile(schemaName, read('src/schemas/channel_moderation_settings.schema.ts').toString('utf8'), ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []); assert.deepEqual(schema.parseDiagnostics, []);
assert.deepEqual(ast.statements.map(s => ts.SyntaxKind[s.kind]), ['ImportDeclaration','InterfaceDeclaration','InterfaceDeclaration','FirstStatement','FirstStatement','FunctionDeclaration','FunctionDeclaration']);
const imp = ast.statements[0];
assert(imp.importClause.isTypeOnly && !imp.importClause.name);
assert.equal(imp.moduleSpecifier.text, '../../../schemas/channel_moderation_settings.schema.js');
assert.deepEqual(imp.importClause.namedBindings.elements.map(e => e.name.text), ['IModerationRule']);
assert.deepEqual(ast.statements.slice(1,3).map(s => s.name.text), ['CapsEvaluationInput','CapsEvaluationResult']);
assert.deepEqual(ast.statements.slice(5).map(s => s.name.text), ['stripEmoteTexts','evaluateCapsRule']);
const rule = schema.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === 'IModerationRule');
const alias = schema.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === 'CapsThresholdMode');
assert(alias && rule);
assert.equal(alias.type.getText(schema), "'count' | 'percentage'");
const names = ['capsThresholdMode','minCapsCount','maxCapsPercentage','minMessageLength'];
const fields = names.map(name => {
  const found = rule.members.filter(m => m.name?.getText(schema) === name);
  assert.equal(found.length, 1); const f = found[0]; assert(ts.isPropertySignature(f) && !f.questionToken);
  assert.equal(f.type.getText(schema), name === 'capsThresholdMode' ? 'CapsThresholdMode' : 'number'); return f.getText(schema);
});
const declaration = `${alias.getText(schema)}\nexport interface IModerationRule { ${fields.join('\n')} }\n`;
const options = {target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, moduleResolution:ts.ModuleResolutionKind.Node10, strict:true, noEmit:true, skipLibCheck:true, types:[], lib:['lib.es2022.d.ts']};
const host = overlaySource(ts.createCompilerHost(options), ts, resolved), readFile = host.readFile.bind(host);
host.readFile = file => path.resolve(file) === schemaName ? declaration : readFile(file);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (file, languageVersion, ...rest) => path.resolve(file) === schemaName
  ? ts.createSourceFile(file, declaration, languageVersion, true, ts.ScriptKind.TS)
  : getSourceFile(file, languageVersion, ...rest);
const program = ts.createProgram([sourceName], options, host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}, reportDiagnostics:true});
assert.deepEqual(compiled.diagnostics, []);
// Both realms execute the same complete transpiled source. No runtime imports
// exist: fail immediately if source or transpilation ever introduces one.
const denyRequire = name => { throw new Error(`unexpected runtime require: ${name}`); };
const compiledSha = sha(compiled.outputText);
const runtime = new Module(sourceName, module); runtime.filename = sourceName; runtime.paths = Module._nodeModulePaths(path.dirname(sourceName));
runtime.require = denyRequire;
runtime._compile(compiled.outputText, sourceName);
const sandbox = {exports:{}, require:denyRequire};
vm.runInNewContext(compiled.outputText, sandbox, {filename:sourceName, timeout:1000});
for (const value of [runtime.exports, sandbox.exports]) assert.deepEqual(Object.keys(value).sort(), ['evaluateCapsRule','stripEmoteTexts']);
const nativeTable = 'src/utils/moderation/caps_unicode_data.rs';
assert.equal(sha(read(nativeTable)), 'f47a1f1595777a04f8f97a688a7ca663b949936a1c92758a83b6860abdd4c344', 'native table changed');
const unicodeDir = process.env.DIMA_CAPS_UNICODE_DIR;
assert(unicodeDir && path.isAbsolute(unicodeDir));
const unicodeBytes = fs.readFileSync(path.join(unicodeDir, 'unicode-reference.json'));
const unicodeSha = process.env.DIMA_CAPS_UNICODE_REFERENCE_SHA256;
assert(/^[a-f0-9]{64}$/.test(unicodeSha || ''), 'explicit Unicode reference SHA required');
assert.equal(sha(unicodeBytes), unicodeSha);
const unicode = JSON.parse(unicodeBytes);
assert.equal(unicode.sha256.native_generated_file, sha(read(nativeTable)));
assert.equal(unicode.sha256.inputs['src/utils/moderation/rules/caps.rule.ts'], pins['src/utils/moderation/rules/caps.rule.ts']);
assert.equal(unicode.sha256.script, pins['tests/fixtures/moderation_caps_unicode_prepare.cjs']);
assert.deepEqual(unicode.source_resolution, {path:resolved.relativePath, virtual_path:'dimabot/src/utils/moderation/rules/caps.rule.ts', sha256:sha(resolved.bytes), resolver_sha256:sha(read('tests/fixtures/moderation_source_resolver.cjs'))});
const files = ['tests/fixtures/moderation_source_resolver.cjs','src/utils/moderation/caps.rs',nativeTable,'src/utils/js_string.rs','src/utils/js_compat.rs','src/utils/json_number.rs','tests/moderation_caps.rs','tests/fixtures/moderation_caps_source.cjs','tests/fixtures/moderation_caps_reference.cjs','tests/moderation_caps_benchmark.rs','tests/fixtures/moderation_caps_benchmark.cjs'];
const hashes = Object.fromEntries(files.map(file => [file, sha(read(file))]));
hashes[resolved.relativePath] = sha(resolved.bytes);
module.exports = {root, sha, read, pins, hashes, unicode, unicodeSha, sourceResolution: {path:resolved.relativePath, virtualPath:'dimabot/src/utils/moderation/rules/caps.rule.ts', sha256:sha(resolved.bytes), resolverSha256:sha(read('tests/fixtures/moderation_source_resolver.cjs'))}, exports:runtime.exports, commonJsExports:runtime.exports, vmExports:sandbox.exports, compiledSha, nodePin, fields, alias:alias.getText(schema)};
