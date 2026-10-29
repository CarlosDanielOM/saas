'use strict';
// Typecheck and execute the complete source AST with only its type import replaced.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {resolveModerationSource, overlaySource} = require('./moderation_source_resolver.cjs');
const root = fs.realpathSync(process.env.DIMA_EMOTE_SPAM_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
assert.equal(fs.realpathSync(local.resolve('typescript')), fs.realpathSync(path.join(root, 'node_modules/typescript/lib/typescript.js')));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const resolved = resolveModerationSource(root, 'src/utils/moderation/rules/emote_spam.rule.ts');
const read = file => file === 'src/utils/moderation/rules/emote_spam.rule.ts' ? resolved.bytes : fs.readFileSync(path.join(root, file));
const files = {
  source: 'src/utils/moderation/rules/emote_spam.rule.ts',
  schema: 'src/schemas/channel_moderation_settings.schema.ts',
  package: 'package.json', lock: 'package-lock.json', toolchain: 'rust-toolchain.toml',
  typescript: 'node_modules/typescript/lib/typescript.js',
  typescriptPackage: 'node_modules/typescript/package.json',
};
const pins = {
  source: '24e7c603569d1063642575372de1066e4f5d5d5de46c88e15e450a549c17f12f',
  schema: 'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  toolchain: 'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
};
const hashes = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha(read(file))]));
for (const [key, pin] of Object.entries(pins)) assert.equal(hashes[key], pin, key);
hashes.node = sha(fs.readFileSync(process.execPath));
hashes.oracle = sha(fs.readFileSync(__filename));
hashes.resolver = sha(fs.readFileSync(require.resolve('./moderation_source_resolver.cjs')));
assert.equal(hashes.node, '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const source = read(files.source).toString();
const ast = ts.createSourceFile(files.source, source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []);
assert.equal(ast.statements.length, 3);
const [imp, result, fn] = ast.statements;
assert(ts.isImportDeclaration(imp) && imp.importClause.isTypeOnly);
assert.equal(imp.moduleSpecifier.text, '../../../schemas/channel_moderation_settings.schema.js');
assert.deepEqual(imp.importClause.namedBindings.elements.map(e => e.name.text), ['IModerationRule']);
assert(ts.isInterfaceDeclaration(result) && result.name.text === 'EmoteSpamEvaluationResult');
assert(ts.isFunctionDeclaration(fn) && fn.name.text === 'evaluateEmoteSpamRule');
for (const statement of [result, fn]) assert(statement.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
const schema = ts.createSourceFile(files.schema, read(files.schema).toString(), ts.ScriptTarget.ES2022, true);
assert.deepEqual(schema.parseDiagnostics, []);
const rule = schema.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === 'IModerationRule');
const fields = rule.members.filter(m => m.name?.getText(schema) === 'maxEmoteCount');
assert.equal(fields.length, 1);
assert(ts.isPropertySignature(fields[0]) && !fields[0].questionToken && fields[0].type.kind === ts.SyntaxKind.NumberKeyword);
const field = fields[0].getText(schema);
// Typecheck the complete actual file at its original virtual filename; only
// the erased schema import is represented by the selected actual field.
const declaration = `export interface IModerationRule { ${field} }\n`;
const sourceName = resolved.virtualPath;
const schemaName = path.join(root, files.schema);
const options = {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ['lib.es2022.d.ts']};
const host = overlaySource(ts.createCompilerHost(options), ts, resolved), readFile = host.readFile.bind(host);
host.readFile = file => path.resolve(file) === schemaName ? declaration : readFile(file);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (file, languageVersion, ...rest) => path.resolve(file) === schemaName
  ? ts.createSourceFile(file, declaration, languageVersion, true, ts.ScriptKind.TS)
  : getSourceFile(file, languageVersion, ...rest);
const program = ts.createProgram([sourceName], options, host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
const sf = program.getSourceFile(sourceName), checker = program.getTypeChecker();
const declarationFn = sf.statements.find(s => ts.isFunctionDeclaration(s) && s.name.text === 'evaluateEmoteSpamRule');
const signature = checker.signatureToString(checker.getSignatureFromDeclaration(declarationFn), undefined, ts.TypeFormatFlags.NoTruncation);
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
assert.deepEqual(compiled.diagnostics, []);
const context = {exports: {}};
vm.runInNewContext(compiled.outputText, context);
assert.deepEqual(Object.keys(context.exports), ['evaluateEmoteSpamRule']);
const evaluate = context.exports.evaluateEmoteSpamRule;
const fromBits = bits => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt('0x' + bits)); return b.readDoubleBE(); };
const toBits = value => { const b = Buffer.alloc(8); b.writeDoubleBE(value); return b.readBigUInt64BE().toString(16).padStart(16, '0'); };
const numbers = ['0000000000000000','8000000000000000','0000000000000001','8000000000000001','0010000000000000','3eb0c6f7a0b5ed8d','3ff0000000000000','3ff0000000000001','4024000000000000','4026000000000000','4340000000000000','4340000000000001','444b1ae4d6e2ef50','7fefffffffffffff','7ff0000000000000','fff0000000000000','7ff8000000000000','fff8000000000000'];
const cases = [];
function add(id, limitBits, countBits, kind = 'number') {
  const input = kind === 'missing' ? {} : {emoteCount: kind === 'null' ? null : fromBits(countBits)};
  const value = evaluate({maxEmoteCount: fromBits(limitBits)}, input);
  cases.push({id, limitBits, countBits: kind === 'number' ? countBits : null, kind, triggered: value.triggered, resultBits: toBits(value.emoteCount), wire: JSON.stringify(value)});
}
for (const limit of numbers) for (const count of numbers) add(`${limit}-${count}`, limit, count);
for (const limit of numbers) for (const kind of ['missing', 'null']) add(`${limit}-${kind}`, limit, null, kind);
const nativeFiles = ['src/utils/moderation/emote_spam.rs', 'tests/moderation_emote_spam.rs', 'src/utils/json_number.rs', 'src/utils/js_compat.rs'];
const nativeHashes = Object.fromEntries(nativeFiles.map(file => [file, sha(read(file))]));
const output = JSON.stringify({metadata: {schema: 1, sourceResolution: {path:resolved.relativePath, virtualPath:'dimabot/src/utils/moderation/rules/emote_spam.rule.ts', sha256:sha(resolved.bytes), resolverSha256:hashes.resolver}, compiledSha:sha(compiled.outputText), node: process.version, v8: process.versions.v8, typescript: ts.version, hashes, nativeHashes, import: imp.getText(ast), field, signature, exports: ['EmoteSpamEvaluationResult', 'evaluateEmoteSpamRule'], total: cases.length}, cases}, null, 2) + '\n';
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dir && !extra.length, 'usage: --write DIR | --check DIR');
const real = fs.realpathSync(dir), repo = fs.realpathSync(path.join(root, '..'));
assert(real !== repo && !real.startsWith(repo + path.sep), 'directory must be external');
const file = path.join(real, 'moderation_emote_spam_reference.json');
if (mode === '--write') { assert.equal(fs.readdirSync(real).length, 0, 'write requires empty directory'); fs.writeFileSync(file, output, {flag: 'wx'}); }
else { assert.deepEqual(fs.readdirSync(real), [path.basename(file)]); assert.equal(fs.readFileSync(file, 'utf8'), output, 'fixture drift'); }
