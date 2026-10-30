'use strict';
// Entire unchanged source modules, transpiled in memory; no application mocks.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module'), assert = require('node:assert/strict');
const root = fs.realpathSync(process.env.DIMA_BLACKLIST_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const read = p => fs.readFileSync(path.join(root, p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  'src/utils/moderation/rules/blacklist.rule.ts': '8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff',
  'src/utils/moderation/normalize.ts': '07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab',
  'rust-toolchain.toml': 'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  'node_modules/typescript/lib/typescript.js': '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675'
};
for (const [p,h] of Object.entries(pins)) assert.equal(sha(read(p)),h,p);
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)),nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local = Module.createRequire(path.join(root,'package.json')), ts = local('typescript');
assert.equal(ts.version,'5.9.3');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
const files = ['src/utils/moderation/normalize.ts','src/utils/moderation/rules/blacklist.rule.ts'];
const compiled = {}, evidence = {}, exportsByFile = {};
for (const file of files) {
  const source = read(file).toString('utf8');
  const ast = ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
  assert.deepEqual(ast.parseDiagnostics,[]);
  evidence[file] = {
    imports: ast.statements.filter(ts.isImportDeclaration).map(s => ({path:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,text:s.getText(ast)})),
    declarations: ast.statements.filter(s => (ts.isFunctionDeclaration(s)||ts.isInterfaceDeclaration(s)) && s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],name:s.name.text,signature:ts.isFunctionDeclaration(s)?source.slice(s.getStart(ast),s.body.getStart(ast)).trim():s.getText(ast)}))
  };
  const expected = file.endsWith('normalize.ts') ? [] : [['../../../schemas/channel_moderation_settings.schema.js',true],['../normalize.js',false]];
  assert.deepEqual(evidence[file].imports.map(x=>[x.path,x.typeOnly]),expected);
  const out = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
  assert.deepEqual(out.diagnostics,[]); compiled[file]=sha(out.outputText);
  const mod = new Module(path.join(root,file),module); mod.filename=path.join(root,file);
  mod.require = id => { assert.equal(id,'../normalize.js'); return exportsByFile[files[0]]; };
  mod._compile(out.outputText,mod.filename); exportsByFile[file]=mod.exports;
}
assert.deepEqual(Object.keys(exportsByFile[files[0]]).sort(),['escapeRegExp','foldText']);
assert.deepEqual(Object.keys(exportsByFile[files[1]]).sort(),['compileBlacklistPattern','evaluateBlacklistRule']);
const normalize = exportsByFile[files[0]], api = exportsByFile[files[1]];
const units = s => s == null ? null : Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
function exec(pattern, text) {
  if (!pattern) return null;
  const m=pattern.exec(text ?? '');
  return m ? {start:m.index,end:m.index+m[0].length,match:units(m[0])} : null;
}
function snapshot(c) {
  const p=api.compileBlacklistPattern(c.terms), folded=normalize.foldText(c.text);
  const e=api.evaluateBlacklistRule({terms:c.terms},{text:c.text},p);
  return {name:c.name,terms:c.terms == null ? null : c.terms.map(units),text:units(c.text),compiled:p?{source:units(p.source),flags:p.flags}:null,foldedText:units(folded),execFolded:exec(p,folded),execRaw:exec(p,c.text),evaluation:{triggered:e.triggered,matchedText:units(e.matchedText)}};
}
const cases = [
 ['case', ['badword'], 'you said a BADWORD there'], ['inside', ['ass'], 'that is a classic move'], ['whole', ['ass'], 'you are an ass'],
 ['accent-term',['café'],'meet at the cafe'], ['accent-text',['cafe'],'meet at the CAFÉ'],
 ['phrase',['buy followers now'],'BUY  FOLLOWERS   NOW cheap'], ['phrase-no',['buy followers now'],'buy followers tomorrow'],
 ['empty',[], 'anything'], ['undefined',undefined,'anything'], ['null-terms',null,null], ['blank',['  ',''],'anything'],
 ['meta',['free.money'],'get free.money here'], ['meta-no',['free.money'],'get freexmoney here'], ['boundary',['ñoño'],'di Nono'], ['boundary-no',['ñoño'],'añonimo'],
 ['stable-ties',['cat','dog','cat'],'DOG cat'], ['long-first',['cat','cat dog'],'cat dog'], ['spaces-priority',['a          b','a b c'],'a b c'],
 ['greedy',['a b'],'a \t\n  b'], ['line-slash',['a\nb','x/y'],'x/y a\nb'], ['all-meta',['.*+?^${}()|[]\\/'],' .*+?^${}()|[]\\/ '],
 ['mark-boundary',['x'],'\u0345x'], ['sigma',['σ'],'ς'], ['long-s',['s'],'ſ'], ['kelvin',['k'],'K'], ['mark-fold',['ι'],'\u0345'],
 ['astral-boundary',['x'],'𐐀x'], ['astral-number',['x'],'x𝟘'], ['astral-term',['😀'],'!😀!'],
 ['high',['\ud800'],'!\ud800!'], ['low',['\udc00'],'!\udc00!'], ['pair',['\ud800\udc00'],'!\ud800\udc00!'], ['adjacent',['\ud800'],'\ud800\udc00'],
 ['text-null',['x'],null], ['term-mark',['\u0345'],'ι'], ['cyrillic-tje',['x'],'\u{1C89}x'], ['ol-onal-number',['x'],'x\u{1E5F1}'],
 ['unicode17-tolong-letter',['x'],'\u{11DB0}x'], ['unicode17-tolong-number',['x'],'x\u{11DE1}'], ['unicode17-tolong-term',['\u{11DB0}'],'!\u{11DB0}!']
].map(([name,terms,text])=>({name,terms,text}));
// Exercise every ECMAScript whitespace class and nearby non-whitespace points.
for (const cp of [0x0009,0x000a,0x000b,0x000c,0x000d,0x0020,0x00a0,0x1680,
  ...Array.from({length:11},(_,i)=>0x2000+i),0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff,
  0x0085,0x180e,0x200b]) {
  const space=String.fromCodePoint(cp);
  cases.push({name:`space-${cp.toString(16)}`,terms:['a b'],text:'!a'+space+'b!'});
}
// Cross-product varies actual boundaries and search position, not duplicated counts.
for (const term of ['cat','café','σ','a b','😀','\ud800']) for (const left of ['', 'a', '9', '_', '😀', '\udc00']) for (const right of ['', 'z', '0', '!', '\ud800']) {
  cases.push({name:`edge-${cases.length}`,terms:[term],text:left+term+right});
}
// ASCII-only differential coverage also exercises the native accelerated path.
// Expected offsets and alternative ordering always come from the real JS RegExp.
for (const terms of [
  ['x'], ['x','x y'], ['x y','x'], ['x     y','x y z'],
  ['x y z','x     y'], ['x!','x'], ['x','x!'], ['!x','x'],
  ['[x]','x'], ['x_y','x'], ['.','..'], ['..','.'],
  ['a+b','a'], ['a','a+b'], ['x/y','x'], ['\\x','x']
]) for (const prefix of ['', '!', '_', 'a', '9', '\n']) for (const text of [
  'x', 'x y', 'x y z', 'x yz x', 'x!x', '!x', '[x]', 'x_y',
  '...x', 'a+b a', 'x/y', '\\x', 'x\t \r\n\v\fy z', 'x! x y'
]) {
  cases.push({name:`ascii-ordered-${cases.length}`,terms,text:prefix+text});
}
function reference() {
  const nativeFiles=['src/utils/moderation/blacklist.rs','src/utils/moderation/normalize.rs','src/utils/moderation/caps_unicode_data.rs','src/utils/js_string.rs','src/utils/js_regexp_unicode.rs','src/utils/js_regexp_unicode_data.rs','src/utils/js_compat.rs','src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','tests/support/sha256.rs','tests/js_regexp_unicode.rs','tests/fixtures/js_regexp_unicode_prepare.cjs','tests/fixtures/unicode-17.0.0/CaseFolding.txt','tests/fixtures/unicode-17.0.0/LICENSE.txt','tests/fixtures/unicode-17.0.0/source-manifest.json','tests/moderation_blacklist.rs','tests/moderation_blacklist_benchmark.rs','tests/fixtures/moderation_blacklist_reference.cjs','tests/fixtures/moderation_blacklist_benchmark.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
  const hashes=Object.fromEntries(nativeFiles.map(p=>[p,sha(read(p))]));
  return {metadata:{format:1,pins,compiled,evidence,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version},nodeSha,hashes},cases:cases.map(snapshot)};
}
if (require.main===module) {
  const [mode,dir,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&extra.length===0);
  const real=fs.realpathSync(dir), workspace=fs.realpathSync(path.join(root,'..'));
  assert(real!==workspace&&!real.startsWith(workspace+path.sep));
  const file=path.join(real,'moderation-blacklist-reference.json');
  assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(file)]);
  const output=JSON.stringify(reference(),null,2)+'\n';
  if(mode==='--write') fs.writeFileSync(file,output,{flag:'wx'}); else assert.equal(fs.readFileSync(file,'utf8'),output);
  console.log(JSON.stringify({mode,sha256:sha(output),cases:cases.length}));
}
module.exports={api,normalize,units,snapshot,reference,sha,root};
