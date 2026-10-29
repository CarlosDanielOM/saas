'use strict';

// Enumerate the actual pinned caps-rule regex objects, not a replacement regex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const {resolveModerationSource} = require('./moderation_source_resolver.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceRoot = path.resolve(process.env.DIMA_CAPS_SOURCE_ROOT || path.join(__dirname, '../..'));
const sourceReal = fs.realpathSync(sourceRoot);
const resolved = resolveModerationSource(sourceReal, 'src/utils/moderation/rules/caps.rule.ts');
const pin = (name, expected) => {
    const bytes = name === 'src/utils/moderation/rules/caps.rule.ts' ? resolved.bytes : fs.readFileSync(path.join(sourceReal, name));
    assert.equal(sha(bytes), expected, `SHA-256 mismatch: ${name}`);
    return bytes;
};
const pins = {
    'src/utils/moderation/rules/caps.rule.ts': '62f7fe37760cbf5640544cab646a639d06b42883532657634a00e25488888797',
    'src/schemas/channel_moderation_settings.schema.ts': 'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
    'package.json': 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
    'package-lock.json': 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
    'rust-toolchain.toml': 'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
    'node_modules/typescript/package.json': '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
    'node_modules/typescript/lib/typescript.js': '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
};
const files = Object.fromEntries(Object.entries(pins).map(([name, digest]) => [name, pin(name, digest)]));
const expectedNode = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_CAPS_NODE_SHA256, expectedNode, 'explicit Node SHA-256 required');
assert.equal(sha(fs.readFileSync(process.execPath)), expectedNode, 'Node binary mismatch');
assert.equal(process.versions.node, '24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
const localRequire = createRequire(path.join(sourceReal, 'package.json'));
const ts = localRequire('typescript');
assert.equal(fs.realpathSync(localRequire.resolve('typescript')), fs.realpathSync(path.join(sourceReal, 'node_modules/typescript/lib/typescript.js')));
assert.equal(ts.version, '5.9.3');

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
assert.ok(args[0] === '--write' || args[0] === '--check', 'invalid mode');
assert.ok(path.isAbsolute(args[1]), 'output directory must be absolute');
const out = fs.realpathSync(args[1]);
assert.ok(fs.statSync(out).isDirectory(), 'output must be an existing directory');
const workspace = path.dirname(sourceReal);
assert.ok(out !== workspace && !out.startsWith(workspace + path.sep), 'output must be outside source workspace');
const names = ['caps_unicode_data.rs', 'unicode-reference.json'];
const existing = fs.readdirSync(out).sort();
assert.deepEqual(existing, args[0] === '--write' ? [] : [...names].sort(), 'unexpected output directory contents');

const sourceBytes = files['src/utils/moderation/rules/caps.rule.ts'];
const source = sourceBytes.toString('utf8');
assert.deepEqual(Buffer.from(source), sourceBytes, 'source must be UTF-8');
const ast = ts.createSourceFile('caps.rule.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(ast.parseDiagnostics.length, 0);
assert.deepEqual(ast.statements.map(s => ts.SyntaxKind[s.kind]), [
    'ImportDeclaration', 'InterfaceDeclaration', 'InterfaceDeclaration', 'FirstStatement', 'FirstStatement', 'FunctionDeclaration', 'FunctionDeclaration',
]);
const imp = ast.statements[0];
assert.ok(imp.importClause.isTypeOnly && !imp.importClause.name);
assert.equal(imp.moduleSpecifier.text, '../../../schemas/channel_moderation_settings.schema.js');
assert.deepEqual(imp.importClause.namedBindings.elements.map(e => e.name.text), ['IModerationRule']);
assert.deepEqual(ast.statements.slice(1, 3).map(s => s.name.text), ['CapsEvaluationInput', 'CapsEvaluationResult']);
assert.deepEqual(ast.statements.slice(5).map(s => s.name.text), ['stripEmoteTexts', 'evaluateCapsRule']);
for (const s of [...ast.statements.slice(1, 3), ...ast.statements.slice(5)]) {
    assert.ok(s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}
const declPins = {
    UPPERCASE_LETTER: { start: 326, end: 361, sha256: '0a23e25af0c1d621664bb11e18a5fb9d7c9413d5aea97e6da5d4c994f4e38ee5' },
    LETTER: { start: 362, end: 386, sha256: 'b53eeb66846294fd8d3fadc76571d47b82bde9e7a4b0d91915842775bc087c94' },
};
for (const [i, name] of ['UPPERCASE_LETTER', 'LETTER'].entries()) {
    const statement = ast.statements[i + 3];
    assert.equal(statement.declarationList.flags & ts.NodeFlags.Const, ts.NodeFlags.Const);
    assert.equal(statement.declarationList.declarations.length, 1);
    const declaration = statement.declarationList.declarations[0];
    assert.equal(declaration.name.text, name);
    assert.equal(declaration.initializer.kind, ts.SyntaxKind.RegularExpressionLiteral);
    const start = Buffer.byteLength(source.slice(0, statement.getStart(ast)));
    const end = Buffer.byteLength(source.slice(0, statement.end));
    const evidence = declPins[name];
    assert.equal(start, evidence.start); assert.equal(end, evidence.end);
    assert.equal(sha(sourceBytes.subarray(start, end)), evidence.sha256);
}
const appended = `${source}\nexport { LETTER, UPPERCASE_LETTER };\n`;
const compiled = ts.transpileModule(appended, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0);
const sandbox = { exports: {} };
vm.runInNewContext(compiled.outputText, sandbox, { timeout: 1000, filename: 'caps.rule.js' });
assert.deepEqual(Object.keys(sandbox.exports).sort(), ['LETTER', 'UPPERCASE_LETTER', 'evaluateCapsRule', 'stripEmoteTexts'].sort());
const { LETTER, UPPERCASE_LETTER } = sandbox.exports;
for (const re of [LETTER, UPPERCASE_LETTER]) {
    assert.equal(Object.prototype.toString.call(re), '[object RegExp]');
    assert.equal(re.flags, 'u');
}

const letterRanges = [], uppercaseRanges = [];
let letterCount = 0, uppercaseCount = 0;
function add(ranges, cp) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1 === cp) last[1] = cp;
    else ranges.push([cp, cp]);
}
for (let cp = 0; cp <= 0x10ffff; cp++) {
    const char = String.fromCodePoint(cp); // Includes lone surrogate code points.
    const letter = LETTER.test(char), upper = UPPERCASE_LETTER.test(char);
    assert.ok(!upper || letter, `Lu outside L at ${cp.toString(16)}`);
    if (letter) { letterCount++; add(letterRanges, cp); }
    if (upper) { uppercaseCount++; add(uppercaseRanges, cp); }
}
const formatRanges = (name, ranges) => `pub(crate) static ${name}: &[(u32, u32)] = &[\n` +
    ranges.map(([a, b]) => `    (0x${a.toString(16).toUpperCase()}, 0x${b.toString(16).toUpperCase()}),\n`).join('') + '];\n';
const rust = `// Unicode classification facts derived by enumerating the pinned caps.rule.ts regexes.\n` +
    `// Node ${process.versions.node}; V8 ${process.versions.v8}; Unicode ${process.versions.unicode}; ICU ${process.versions.icu}.\n` +
    `// caps.rule.ts SHA-256: ${pins['src/utils/moderation/rules/caps.rule.ts']}\n\n` +
    formatRanges('LETTER_RANGES', letterRanges) + '\n' + formatRanges('UPPERCASE_RANGES', uppercaseRanges);
const reference = {
    format: 1,
    versions: { node: process.versions.node, v8: process.versions.v8, icu: process.versions.icu, unicode: process.versions.unicode, typescript: ts.version },
    sha256: { node_binary: expectedNode, inputs: pins, script: sha(fs.readFileSync(__filename)), transpiled_module: sha(compiled.outputText), native_generated_file: sha(rust) },
    source_resolution: { path: resolved.relativePath, virtual_path: 'dimabot/src/utils/moderation/rules/caps.rule.ts', sha256: sha(resolved.bytes), resolver_sha256: sha(fs.readFileSync(require.resolve('./moderation_source_resolver.cjs'))) },
    ast_declarations: declPins,
    LETTER: { count: letterCount, range_count: letterRanges.length, ranges: letterRanges },
    UPPERCASE_LETTER: { count: uppercaseCount, range_count: uppercaseRanges.length, ranges: uppercaseRanges },
};
const outputs = [rust, JSON.stringify(reference, null, 2) + '\n'];
for (const [i, name] of names.entries()) {
    const target = path.join(out, name);
    if (args[0] === '--write') fs.writeFileSync(target, outputs[i], { flag: 'wx' });
    else {
        assert.ok(fs.lstatSync(target).isFile(), `not a regular file: ${name}`);
        assert.deepEqual(fs.readFileSync(target), Buffer.from(outputs[i]), `output mismatch: ${name}`);
    }
}
console.log(`${args[0]}: L=${letterCount} (${letterRanges.length} ranges), Lu=${uppercaseCount} (${uppercaseRanges.length} ranges)`);
