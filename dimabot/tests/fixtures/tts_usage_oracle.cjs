// Actual-source pure calculation oracle. Tracking imports throw if invoked.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function load({commonJsRealm = false} = {}) {
  if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || ts.version !== '5.9.3') throw Error('wrong oracle toolchain');
  const files = {source:path.join(root,'src/utils/tts_usage.ts'),oracle:__filename,package:path.join(root,'package.json'),lock:path.join(root,'package-lock.json'),typescript:require.resolve('typescript'),typescriptPackage:require.resolve('typescript/package.json'),node:process.execPath};
  const text = fs.readFileSync(files.source,'utf8');
  const ast = ts.createSourceFile(files.source,text,ts.ScriptTarget.Latest,true);
  const iface = ast.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === 'TtsUsageResult');
  const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'calculateTtsUsage');
  const decl = ast.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []).find(d => d.name.getText(ast) === 'TTS_CREDITS_PER_CHARACTER');
  if (!iface || !fn || !decl?.initializer || !iface.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword) || !fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) throw Error('source AST contract changed');
  const evidence = {interface:iface.getText(ast),functionSignature:fn.getText(ast).slice(0,fn.getText(ast).indexOf('{')).trim(),pricingInitializer:decl.initializer.getText(ast)};
  const code = ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  const stub = () => { throw Error('tracking runtime import invoked'); };
  const requireStub = spec => { if (!['./databases/dragonfly.database.js','./polarsh.js','./logger.js'].includes(spec)) throw Error(`unexpected import ${spec}`); return new Proxy({}, {get:()=>stub}); };
  if (commonJsRealm) new Function('exports','require',code)(exports,requireStub);
  else vm.runInNewContext(`(function(exports,require){${code}\n})`,{}, {filename:files.source})(exports,requireStub);
  return {calculate:exports.calculateTtsUsage, metadata:{schema:1,executionRealm:commonJsRealm ? 'node-commonjs-realm' : 'isolated-vm',node:process.version,v8:process.versions.v8,typescript:ts.version,hashes:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,sha(v)])),evidence}};
}
const bits = n => {const b=Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex');};
const fields = r => [r.characters,r.creditsConsumed,r.polarshCost,r.costUsd].map(bits);
const units = s => Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const fromUnits = a => String.fromCharCode(...a);
function cases(calculate) {
  const providers=['','piper','kokoro','fish','other','PIPER',' fish ','😀','\ud800','\udc00','constructor','__defineGetter__','__defineSetter__','hasOwnProperty','__lookupGetter__','__lookupSetter__','isPrototypeOf','propertyIsEnumerable','toString','valueOf','__proto__','toLocaleString'];
  // Adjacent representable values, including both signs and overflow boundaries.
  const next = (n, up) => {
    if (Number.isNaN(n) || (up && n === Infinity) || (!up && n === -Infinity)) return n;
    if (n === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    const b=Buffer.alloc(8); b.writeDoubleBE(n); let u=b.readBigUInt64BE();
    u += (n > 0) === up ? 1n : -1n; b.writeBigUInt64BE(u); return b.readDoubleBE();
  };
  const centers=[0,Number.MIN_VALUE,0.5,1,15,50,100,500,2**52,2**53,Number.MAX_VALUE,1e308];
  const numbers=[0,-0,Number.NaN,Infinity,-Infinity,1/3,-1/3];
  for (const center of centers) for (const sign of [1,-1]) { const n=center*sign; numbers.push(next(n,false),n,next(n,true)); }
  return providers.flatMap(p=>numbers.map(n=>{const r=calculate(p,n); return {provider:units(p),characters:bits(n),fields:fields(r),wire:JSON.stringify(r)};}));
}
if (require.main === module) {
  const [mode,dir,...extra]=process.argv.slice(2); if (!['--write','--check'].includes(mode)||!dir||extra.length) throw Error('usage: --write DIR | --check DIR');
  const {calculate,metadata}=load(), output=JSON.stringify({metadata,cases:cases(calculate)},null,2)+'\n', file=path.join(dir,'tts-usage-pricing.json');
  if(mode==='--write') {if(!fs.statSync(dir).isDirectory()) throw Error('parent-owned directory required'); fs.writeFileSync(file,output,{flag:'wx'});} else if(fs.readFileSync(file,'utf8')!==output) throw Error('oracle mismatch');
}
module.exports={load,bits,fields,units,fromUnits};
