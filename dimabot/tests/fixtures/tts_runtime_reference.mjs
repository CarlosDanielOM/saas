// Run only in a disposable directory: node tts_runtime_reference.mjs --write|--check DIR
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw Error('unexpected Node/V8');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
if (ts.version !== '5.9.3') throw Error('unexpected TypeScript');
const [mode, dir, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dir || extra.length) throw Error('usage: --write|--check DIR');
const sourcePath = 'src/server/services/tts/piper_tts.service.ts';
const source = await fs.readFile(path.join(root, sourcePath), 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['getPiperPythonBin', 'getPiperDataDir', 'getPiperHttpUrl', 'getPublicApiUrl', 'buildPublicPath'];
const declarations = names.map(name => {
  const node = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!node) throw Error(`missing ${name}`);
  return node.getText(ast);
}).join('\n');
const code = ts.transpileModule(`${declarations}\nresult = [getPiperPythonBin(), getPiperDataDir(), getPiperHttpUrl(), getPublicApiUrl(), buildPublicPath('a/b ?', 'é+!')];`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const cases = [
  {}, { PIPER_PYTHON_BIN: '', PIPER_DATA_DIR: '', PIPER_HTTP_URL: '', PUBLIC_API_URL: '' },
  { PIPER_PYTHON_BIN: '  ', PIPER_DATA_DIR: '\ufeff x/y \ufeff', PIPER_HTTP_URL: ' https://host///', PUBLIC_API_URL: ' https://api///', NODE_ENV: 'production' },
  { PIPER_DATA_DIR: '\ufeff ', PIPER_HTTP_URL: '\ufeff ', PUBLIC_API_URL: '\ufeff ', NODE_ENV: 'Production' },
  { PIPER_DATA_DIR: '\u0085', PIPER_HTTP_URL: '\u0085/', PUBLIC_API_URL: '///', NODE_ENV: 'production' },
  { PIPER_PYTHON_BIN: '0', PIPER_DATA_DIR: ' 0 ', PIPER_HTTP_URL: '/', PUBLIC_API_URL: '/', NODE_ENV: 'production' },
  { PIPER_PYTHON_BIN: '\n', PIPER_DATA_DIR: 'a/b/../c', PIPER_HTTP_URL: 'https://host/path////', PUBLIC_API_URL: 'https://api/path////' },
  { PIPER_DATA_DIR: '\u00a0\u2028', PIPER_HTTP_URL: '\u00a0\u2028', PUBLIC_API_URL: '\u00a0\u2028', NODE_ENV: 'production' },
  { PUBLIC_API_URL: '', NODE_ENV: 'Production' },
  { PUBLIC_API_URL: '', NODE_ENV: 'production ' },
  { PUBLIC_API_URL: '  https://api/path/  ', PIPER_HTTP_URL: '  https://piper/path/  ' },
  { PUBLIC_API_URL: '?q=1///', PIPER_HTTP_URL: '?q=1///' },
  { PUBLIC_API_URL: '0', PIPER_PYTHON_BIN: 'false', PIPER_DATA_DIR: '0', PIPER_HTTP_URL: '0' },
];
const results = cases.map(env => {
  const context = { process: { env }, result: null, encodeURIComponent };
  vm.runInNewContext(code, context, { timeout: 1000 });
  return { env, result: context.result };
});
const polyfill = await fs.readFile(path.join(root, 'src/utils/pollyfills.ts'), 'utf8');
const polyAst = ts.createSourceFile('pollyfills.ts', polyfill, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = polyAst.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(polyAst) === 'getDirname'));
if (!declaration) throw Error('missing getDirname');
const polyCode = ts.transpileModule(declaration.getText(polyAst).replace(/^export\s+/, '') + '\nresult = getDirname(moduleUrl);', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleFiles = [
  '/fixture/dist/server/services/tts/piper_tts.service.js',
  '/app/a b/server/services/tts/piper_tts.service.js',
  '/tts/piper_tts.service.js',
  '/a/b/tts/piper_tts.service.js',
  '/piper_tts.service.js',
];
const paths = moduleFiles.map(moduleFile => {
  const context = { fileURLToPath, dirname: path.dirname, moduleUrl: pathToFileURL(moduleFile).href, result: null };
  vm.runInNewContext(polyCode, context, { timeout: 1000 });
  return { moduleDir: context.result, publicDir: path.resolve(context.result, '../../routes/public/speech') };
});
const hashes = {};
for (const p of [sourcePath, 'src/utils/pollyfills.ts', 'tests/fixtures/tts_runtime_reference.mjs', 'package.json', 'package-lock.json', 'node_modules/typescript/package.json']) {
  hashes[p] = crypto.createHash('sha256').update(await fs.readFile(path.join(root, p))).digest('hex');
}
const require = createRequire(path.join(root, 'package.json'));
for (const [name, p] of [['node-executable', process.execPath], ['typescript-implementation', require.resolve('typescript')]]) {
  hashes[name] = crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
}
const output = JSON.stringify({ versions: { node: process.versions.node, v8: process.versions.v8, typescript: ts.version }, hashes, paths, cases: results }, null, 2) + '\n';
const target = path.join(path.resolve(dir), 'tts_runtime_reference.json');
if (mode === '--write') { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, output); }
else if (await fs.readFile(target, 'utf8') !== output) throw Error('fixture mismatch');
