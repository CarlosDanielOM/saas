'use strict';
// Run only in the isolated driver: DIMA_FILE_ROUTES_TMP must be a precreated,
// canonical task-owned empty directory with a `.dimabot-migration-owner` marker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = fs.realpathSync(process.env.DIMA_FILE_ROUTES_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const scratch = process.env.DIMA_FILE_ROUTES_TMP;
assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER, 'dimabot-migration');
assert(scratch && scratch.startsWith('/tmp/') && fs.realpathSync(scratch) === scratch);
assert(root === '/source/dimabot' || root.startsWith('/tmp/'));
assert(fs.lstatSync(path.join(scratch, '.dimabot-migration-owner')).isFile());
assert(!scratch.startsWith(path.dirname(root) + path.sep));
assert.equal(fs.readFileSync(path.join(scratch, '.dimabot-migration-owner'), 'utf8'), 'dimabot-migration\n');
assert.deepEqual(fs.readdirSync(scratch), ['.dimabot-migration-owner']);
assert.equal(process.version, 'v24.22.1');
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const express = local('express');
assert.equal(ts.version, '5.9.3');
assert.equal(local('express/package.json').version, '4.22.2');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pins = {
  'src/utils/fs.ts': 'a4011f419c21a8aab4e019982e14842ad749616cee9c605b774d15e463432e4e',
  'src/server/routes/file.route.ts': '379b363be6866a6355723c16a29a82af4aa4da0cf35c0a9b0a3211a4902d156b',
  'src/server/routes/admin-tools.route.ts': 'f23b6f31b54ba1b5ab0d125db8f1a7679882335210797149942c3a6b821aa3ff',
};
for (const [file, digest] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(path.join(root, file))), digest);
assert.equal(process.versions.v8, '13.6.233.17-node.58');
const nodeSha256 = sha(fs.readFileSync(process.execPath));
const typescriptSha256 = sha(fs.readFileSync(local.resolve('typescript')));
assert.equal(nodeSha256, '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
assert.equal(typescriptSha256, '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
function sourceAst(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const fsAst = sourceAst('src/utils/fs.ts');
const readFile = fsAst.statements.filter(s => ts.isFunctionDeclaration(s) && s.name?.text === 'readFile');
assert.equal(readFile.length, 1);
assert(readFile[0].modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
assert(readFile[0].modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
assert.equal(readFile[0].parameters[0].type.getText(fsAst), 'string');
assert.equal(readFile[0].type.getText(fsAst), 'Promise<string>');
function routeArguments(file, route) {
  const ast = sourceAst(file); const matches = [];
  function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'router.get' && n.arguments[0]?.text === route) matches.push(n.arguments);
    ts.forEachChild(n, visit);
  }
  visit(ast); assert.equal(matches.length, 1); return {ast, args: matches[0]};
}
const clipAst = routeArguments('src/server/routes/file.route.ts', '/clip/:channelID');
assert.equal(clipAst.args.length, 2);
const adminAst = routeArguments('src/server/routes/admin-tools.route.ts', '/read-file');
assert.equal(adminAst.args.length, 4);
assert.equal(adminAst.args[1].getText(adminAst.ast), 'authMiddleware as any');
assert.equal(adminAst.args[2].getText(adminAst.ast), 'workspaceOwnerMiddleware');
const sourceAstProof = {readFile:true, clip:true, adminAuthOrder:true};
const nativeFiles = ['Cargo.toml', 'src/lib.rs', 'src/utils/mod.rs', 'src/utils/fs.rs', 'src/server/routes/file.route.rs', 'src/server/routes/admin-tools.route.rs', 'tests/file_routes.rs', 'tests/support/api_auth_support.rs', 'src/middleware/auth.middleware.rs', 'src/middleware/workspace-owner.middleware.rs'];
const native = Object.fromEntries(nativeFiles.map(name => [name, sha(fs.readFileSync(path.join(root, name)))]));

function load(file, transform, dependencies) {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  source = transform(source);
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}}).outputText;
  const mod = new Module(path.join(root, file), module);
  mod.filename = path.join(root, file);
  mod.paths = Module._nodeModulePaths(root);
  mod.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : local(name);
  // A source-local __dirname must be scoped inside the CommonJS wrapper.
  mod._compile(`{\n${js}\n}`, mod.filename);
  return mod.exports;
}
const read = load('src/utils/fs.ts', x => x, {});
const route = load('src/server/routes/file.route.ts', x => x.replace('getDirname(import.meta.url)', JSON.stringify(scratch)), {'../../utils/pollyfills.js': {getDirname: () => scratch}});
const allow = path.join(scratch, 'allowed');
const admin = load('src/server/routes/admin-tools.route.ts', x => x.replace("['/home/cdom/saas/dimabot', '/home/cdom/saas/admin']", JSON.stringify([allow])), {
  '../../middleware/auth.middleware.js': {authMiddleware: (req, res, next) => next()},
  '../../middleware/workspace-owner.middleware.js': {workspaceOwnerMiddleware: (req, res, next) => next()},
  '../../utils/fs.js': read,
});
(async () => {
  fs.mkdirSync(path.join(scratch, 'public/downloads'), {recursive:true});
  fs.mkdirSync(allow);
  fs.writeFileSync(path.join(scratch, 'public/downloads/demo-clip.mp4'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(allow, 'text'), Buffer.from([65, 255, 66]));
  fs.writeFileSync(path.join(allow, 'large'), Buffer.alloc(1048577));
  fs.writeFileSync(path.join(allow, 'limit'), Buffer.alloc(1048576, 120));
  fs.writeFileSync(path.join(allow, 'é.txt'), '雪');
  fs.writeFileSync(path.join(allow, 'empty'), '');
  fs.mkdirSync(allow + '-sibling');
  fs.writeFileSync(path.join(allow + '-sibling', 'text'), 'sibling');
  fs.writeFileSync(path.join(scratch, 'outside'), 'traversal');
  fs.symlinkSync(path.join(scratch, 'outside'), path.join(allow, 'link'));
  fs.writeFileSync(path.join(scratch, 'public/downloads/empty-clip.mp4'), '');
  const app = express(); app.use('/video', route.fileRoute); app.use('/admin', admin.adminToolsRoute);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cases = [];
    async function record(name, url, headers = {}) {
      const response = await fetch(base + url, {headers});
      const bytes = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get('content-type') || '';
      cases.push({name, status:response.status, body:type.includes('json') ? JSON.parse(bytes) : bytes.toString('hex'), headers:{'content-length':response.headers.get('content-length'), 'content-range':response.headers.get('content-range'), 'accept-ranges':response.headers.get('accept-ranges'), 'content-type':type}});
    }
    await record('clip_missing', '/video/clip/missing');
    await record('clip_full', '/video/clip/demo');
    await record('clip_empty', '/video/clip/empty');
    for (const [name, range] of [['clip_first','bytes=0-0'], ['clip_middle','bytes=2-5'], ['clip_open','bytes=7-'], ['clip_last','bytes=9-9'], ['clip_outside','bytes=10-']]) await record(name, '/video/clip/demo', {range});
    await record('admin_no_path', '/admin/read-file');
    await record('admin_denied', '/admin/read-file?path=' + encodeURIComponent(path.join(scratch, 'denied')));
    for (const name of ['text','large','missing','limit','é.txt','empty','link']) await record('admin_' + name, '/admin/read-file?path=' + encodeURIComponent(path.join(allow, name)));
    await record('admin_directory', '/admin/read-file?path=' + encodeURIComponent(allow));
    await record('admin_prefix', '/admin/read-file?path=' + encodeURIComponent(path.join(allow + '-sibling', 'text')));
    await record('admin_traversal', '/admin/read-file?path=' + encodeURIComponent(allow + '/../outside'));
    assert.equal(cases.length, 20);
    const output = {v8:process.versions.v8, nodeSha256, typescriptSha256, sourceAst:sourceAstProof, native, node:process.version, typescript:ts.version, express:local('express/package.json').version, source:pins, script:sha(fs.readFileSync(__filename)), scratch, cases};
    const out = process.env.DIMA_FILE_ROUTES_OUTPUT;
    assert(out && path.isAbsolute(out) && path.dirname(out) === scratch);
    fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n', {flag:'wx'});
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
