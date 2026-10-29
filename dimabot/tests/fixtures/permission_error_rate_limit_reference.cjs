'use strict';
// Execute the entire pinned TypeScript module, including all initializers and defaults.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const vm = require('node:vm'), assert = require('node:assert/strict'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => fs.readFileSync(path.join(root, p));
const source = read('src/utils/permissions/error_rate_limit.ts').toString();
const pins = {'src/utils/permissions/error_rate_limit.ts':'4e840093ef500738588ea7990f4303ea18f9368abd4d9e898557af73e08e8d56','package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef','package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7','rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2'};
for (const [p, h] of Object.entries(pins)) assert.equal(digest(read(p)), h, p);
assert.equal(digest(fs.readFileSync(require.resolve('typescript'))), '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
assert.equal(digest(fs.readFileSync(require.resolve('typescript/package.json'))), '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6');
assert.equal(process.version, 'v24.22.1'); assert.equal(process.versions.v8, '13.6.233.17-node.58'); assert.equal(ts.version, '5.9.3');
assert(path.isAbsolute(process.execPath));
assert.match(process.env.PERMISSION_NODE_SHA256 || '', /^[a-f0-9]{64}$/);
assert.equal(digest(fs.readFileSync(process.execPath)), process.env.PERMISSION_NODE_SHA256);
const ast = ts.createSourceFile('error_rate_limit.ts', source, ts.ScriptTarget.ES2022, true);
assert.deepEqual(ast.parseDiagnostics, []); assert.equal(ast.statements.length, 4);
assert(ast.statements.slice(0,3).every(ts.isVariableStatement));
assert(ts.isFunctionDeclaration(ast.statements[3]));
assert.equal(ast.statements[3].name.text, 'shouldLogPermissionError');
assert.equal(ast.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).length, 1);
const virtual = path.join(root, '__permission_error_oracle__.ts');
const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host = ts.createCompilerHost(options), originalRead = host.readFile.bind(host), originalExists = host.fileExists.bind(host);
host.readFile = file => file === virtual ? source : originalRead(file);
host.fileExists = file => file === virtual || originalExists(file);
const program = ts.createProgram([virtual], options, host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
const compiled = ts.transpileModule(source + '\nexports.snapshot = () => Array.from(lastPermissionErrorAt.entries());', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.deepEqual(compiled.diagnostics, []);
function load() { const context = {exports:{}}; vm.runInNewContext(compiled.outputText, context); return context.exports; }
const number = n => {const b=Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex');};
const units = s => Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const operations = [];
function op(key, now, interval) { operations.push({key:units(key), now:number(now), interval:number(interval)}); }
for(let i=0;i<2000;i++) op('key-'+i, 10, 300000);
op('key-0',11,300000); op('key-1',300010,300000); op('new',12,300000);
op('key-0',13,300000); op('key-1',300011,300000);
for (const [key, values] of [
 ['numeric',[0,-0,1,-1,300000,299999,NaN,Infinity,-Infinity,1e100]],
 ['\ud800',[0,0,300000]], ['\udc00',[0,1]], ['😀',[0,1]], ['\ud83d\ude00',[300000]],
]) for (const n of values) for (const interval of [300000,0,-1,NaN,Infinity,-Infinity]) op(key,n,interval);
const m=load(), results=[];
for(const o of operations) { const key=String.fromCharCode(...o.key), n=Buffer.from(o.now,'hex').readDoubleBE(), interval=Buffer.from(o.interval,'hex').readDoubleBE(); results.push(m.shouldLogPermissionError(key,n,interval)); }
const state=Array.from(m.snapshot(), ([k,n])=>({key:units(k),now:number(n)}));
// Exercise both defaults in a fresh actual module with a controlled Date.now.
const context={exports:{},Date:class extends Date {static now(){return 12345;}}}; vm.runInNewContext(compiled.outputText,context);
assert.equal(context.exports.shouldLogPermissionError('default'),true); assert.equal(context.exports.shouldLogPermissionError('default'),false);
const files=['Cargo.toml','Cargo.lock','rust-toolchain.toml','src/lib.rs','src/utils/mod.rs','src/utils/js_compat.rs','src/utils/js_string.rs','src/utils/permissions/index.rs','src/utils/permissions/error_rate_limit.rs','tests/permission_error_rate_limit.rs','tests/fixtures/permission_error_rate_limit_reference.cjs'];
const artifact={metadata:{schema:1,node:process.version,v8:process.versions.v8,typescript:ts.version,node_sha256:process.env.PERMISSION_NODE_SHA256,files:Object.fromEntries(files.map(p=>[p,digest(read(p))]))},operations,results,state};
const output=JSON.stringify(artifact)+'\n';
const [mode,dir]=process.argv.slice(2); assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && process.argv.length===4, 'use --write|--check ABSOLUTE_EXTERNAL_DIR');
const external = fs.realpathSync(dir), repo = fs.realpathSync(path.join(root, '..'));
assert(external !== repo && !external.startsWith(repo+path.sep), 'external directory required');
assert(fs.statSync(external).isDirectory());
if (mode === '--write') assert.deepEqual(fs.readdirSync(external), [], 'exclusive empty output directory');
else assert.deepEqual(fs.readdirSync(external), ['permission_error_rate_limit_reference.json']);
const target=path.join(dir,'permission_error_rate_limit_reference.json');
if(mode==='--write') { fs.writeFileSync(target,output,{flag:'wx'}); } else assert.equal(fs.readFileSync(target,'utf8'),output);
