'use strict';
// Prepared-operation benchmark: no application, database, or SDK is loaded.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), Module = require('node:module'), vm = require('node:vm');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.deepEqual([process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode], ['24.22.1','13.6.233.17-node.58','78.3','17.0']);
assert.equal(sha(fs.readFileSync(process.execPath)), nodeSha);
const root = fs.realpathSync(path.resolve(__dirname, '../..')), checkout = path.dirname(root);
const local = Module.createRequire(path.join(root, 'package.json')), ts = local('typescript');
assert.equal(ts.version, '5.9.3');
const [mode, dir, ...rest] = process.argv.slice(2);
assert(['--prepare','--run','--check'].includes(mode) && dir && path.isAbsolute(dir) && !rest.length);
assert(fs.lstatSync(dir).isDirectory()); assert.equal(fs.realpathSync(dir), dir);
assert(dir !== checkout && !dir.startsWith(checkout + path.sep));
const names = {input:'fish-alias-input.json', provenance:'fish-alias-provenance.json', node:'fish-alias-node.json', rust:'fish-alias-rust.json'};
const file = k => path.join(dir,names[k]);
function read(k) { const p=file(k); assert(fs.lstatSync(p).isFile()); assert.equal(fs.realpathSync(p),p); return fs.readFileSync(p); }
function write(k,b) { fs.writeFileSync(file(k),b,{flag:'wx'}); }
function select(rel) { const choices=[path.join(root,rel),path.join(checkout,'archives/dimabot-typescript/2026-10-28',rel)]; const present=choices.filter(p=>fs.existsSync(p)); assert.equal(present.length,1,`exactly one source: ${rel}`); return present[0]; }
const sourceFiles=[select('src/schemas/channel_fish_voice_favorites.schema.ts'),select('src/server/services/tts/fish_tts.service.ts')];
function ast(p) { const text=fs.readFileSync(p,'utf8'), tree=ts.createSourceFile(p,text,ts.ScriptTarget.ES2022,true); assert.deepEqual(tree.parseDiagnostics,[]); return {text,tree}; }
const schema=ast(sourceFiles[0]), fish=ast(sourceFiles[1]);
function declaration(a,name,kind) { const found=a.tree.statements.filter(s=>kind(s) && s.name?.text===name); assert.equal(found.length,1,name); return found[0].getText(a.tree); }
const voiceStatements=fish.tree.statements.filter(s=>ts.isVariableStatement(s) && s.declarationList.declarations.some(d=>d.name.getText(fish.tree)==='FISH_VOICES'));
assert.equal(voiceStatements.length,1); assert.equal(voiceStatements[0].declarationList.declarations.length,1);
const extracted=[voiceStatements[0].getText(fish.tree),declaration(schema,'FavoriteAliasError',ts.isClassDeclaration),declaration(schema,'normalizeFavoriteAlias',ts.isFunctionDeclaration),declaration(schema,'makeFavoriteAlias',ts.isFunctionDeclaration)].join('\n');
// Check the exact AST-extracted TypeScript as a standalone module with standard libs.
const virtual=path.join(root,'__fish_alias_benchmark_extract__.ts');
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,types:[],skipLibCheck:true};
const host=ts.createCompilerHost(options), originalGet=host.getSourceFile.bind(host), originalExists=host.fileExists.bind(host), originalRead=host.readFile.bind(host);
host.fileExists=p=>p===virtual||originalExists(p); host.readFile=p=>p===virtual?extracted:originalRead(p);
host.getSourceFile=(p,v,...args)=>p===virtual?ts.createSourceFile(p,extracted,v,true):originalGet(p,v,...args);
const program=ts.createProgram([virtual],options,host); assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const output=ts.transpileModule(extracted,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true}); assert.deepEqual(output.diagnostics,[]);
const m=new Module(path.join(root,'fish-alias-benchmark.cjs'),module); m.filename=path.join(root,'fish-alias-benchmark.cjs'); m.require=()=>{throw Error('unexpected import');}; m._compile(output.outputText,m.filename);
const isolated={exports:{}}; vm.runInNewContext(output.outputText,isolated,{timeout:1000});
const paths=['src/schemas/channel_fish_voice_favorites.schema.rs','src/server/services/tts/fish_tts.rs','src/utils/js_string.rs','src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/js_compat.rs','src/utils/lossless_json.rs','tests/support/sha256.rs','tests/fish_favorite_alias_benchmark.rs','tests/fixtures/fish_favorite_alias_benchmark.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
const hashes=()=>Object.fromEntries(paths.map(p=>[p,sha(fs.readFileSync(path.join(root,p)))]));
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const fromUnits=u=>String.fromCharCode(...u);
const defs=[['normalize-valid',2000],['normalize-invalid',2000],['make-ascii',1000],['make-unicode',1000],['make-collisions',1000]];
function row(name,i) {
 if(name==='normalize-valid') return {op:'normalize',input:{kind:'string',units:units(i%3===0?`  Kelvin_${i}  `:i%3===1?`  Name_${i}  `:`\u00a0VOICE_${i}\u3000`)}};
 if(name==='normalize-invalid') {const a=[{kind:'null'},{kind:'bool',value:true},{kind:'number',value:7},{kind:'string',units:units('gojo')},{kind:'string',units:units('9wrong')},{kind:'string',units:units('é')},{kind:'string',units:units('a'.repeat(41))},{kind:'string',units:[0xd800]}]; return {op:'normalize',input:a[i%a.length]};}
 if(name==='make-ascii') return {op:'make',name:units(`Example Voice ${i}`),used:[]};
 if(name==='make-unicode') return {op:'make',name:units(['Crème Brûlée','Ｆｕｌｌ １２','😀 voice','\ud800X\udc00','Kelvin ﬁ'][i%5]+i),used:[]};
 if(name==='make-collisions') return {op:'make',name:units('voice'),used:Array.from({length:20},(_,j)=>units(j===0?'voice':`voice_${j+1}`))};
 throw Error(name);
}
function decode(c) { if(c.op==='make') return [fromUnits(c.name),c.used.map(fromUnits)]; const v=c.input; return [v.kind==='string'?fromUnits(v.units):v.kind==='null'?null:v.value]; }
function wire(api,c) {try {const value=c.op==='make'?api.makeFavoriteAlias(...decode(c)):api.normalizeFavoriteAlias(...decode(c)); return {ok:true,units:units(value)};} catch(e) {return {ok:false,status:e.status,code:units(e.code),message:units(e.message)};} }
const warmupPasses=20;
const input={format:1,operation:'prepared helper call; scalar output/error lengths and status',warmupPasses,trials:7,workloads:defs.map(([name,passes])=>({name,passes,caseCount:32,pool:Array.from({length:32},(_,i)=>{const c=row(name,i),expected=wire(m.exports,c); assert.deepEqual(wire(isolated.exports,c),expected); return {...c,expected};})}))};
const inputBytes=Buffer.from(JSON.stringify(input)+'\n'), inputSha=sha(inputBytes);
const metadataPath=process.env.DIMA_FISH_ALIAS_RUSTC_PROVENANCE_PATH;
assert(metadataPath && path.isAbsolute(metadataPath) && !metadataPath.startsWith(checkout+path.sep));
assert(fs.lstatSync(metadataPath).isFile()); assert.equal(fs.realpathSync(metadataPath),metadataPath);
const metadataBytes=fs.readFileSync(metadataPath), metadataSha=sha(metadataBytes);
assert.match(process.env.DIMA_FISH_ALIAS_RUSTC_PROVENANCE_SHA256||'',/^[0-9a-f]{64}$/);
assert.equal(process.env.DIMA_FISH_ALIAS_RUSTC_PROVENANCE_SHA256,metadataSha);
const metadata=JSON.parse(metadataBytes); assert.deepEqual(Object.keys(metadata).sort(),['path','schemaVersion','sha256','verbose','version']);
assert.equal(metadata.schemaVersion,1); assert(path.isAbsolute(metadata.path)); assert.match(metadata.sha256,/^[0-9a-f]{64}$/);
assert.equal(metadata.version,'rustc 1.99.1 (58cf8f9c3 2026-10-13)'); assert(metadata.verbose.startsWith(metadata.version+'\n')); assert(metadata.verbose.endsWith('\n'));
const provenance={format:1,rustcMetadataSha256:metadataSha,rustcMetadata:metadata,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version},nodeSha256:nodeSha,inputSha256:inputSha,sourcePaths:sourceFiles,sourceHashes:sourceFiles.map(p=>sha(fs.readFileSync(p))),typescriptHashes:[sha(fs.readFileSync(local.resolve('typescript'))),sha(fs.readFileSync(local.resolve('typescript/package.json')))],extractedSha256:sha(extracted),compiledSha256:sha(output.outputText),hashes:hashes()};
const provenanceBytes=Buffer.from(JSON.stringify(provenance)+'\n'), provenanceSha=sha(provenanceBytes);
function pin(n,v){assert.equal(process.env[n],v,`${n} independent pin required`);}
function validate(){pin('DIMA_FISH_ALIAS_INPUT_SHA256',inputSha);pin('DIMA_FISH_ALIAS_PROVENANCE_SHA256',provenanceSha);assert.deepEqual(read('input'),inputBytes);assert.deepEqual(read('provenance'),provenanceBytes);assert.deepEqual(hashes(),provenance.hashes);assert.deepEqual([sha(fs.readFileSync(local.resolve('typescript'))),sha(fs.readFileSync(local.resolve('typescript/package.json')))],provenance.typescriptHashes);assert.deepEqual(sourceFiles.map(p=>sha(fs.readFileSync(p))),provenance.sourceHashes);assert.deepEqual([select('src/schemas/channel_fish_voice_favorites.schema.ts'),select('src/server/services/tts/fish_tts.service.ts')],sourceFiles);assert(fs.lstatSync(metadataPath).isFile());assert.equal(fs.realpathSync(metadataPath),metadataPath);assert.deepEqual(fs.readFileSync(metadataPath),metadataBytes);}
function scalar(w){return w.ok?w.units.length:w.status+w.code.length+w.message.length;}
function expected(w,p){return (w.pool.reduce((s,c)=>s+scalar(c.expected),0)*p)>>>0;}
function prepare(w){return w.pool.map(c=>({op:c.op,args:decode(c),expected:c.expected}));}
function run(pool,passes){let sum=0; for(let p=0;p<passes;p++) for(const c of pool){try {const v=c.op==='make'?m.exports.makeFavoriteAlias(c.args[0],c.args[1]):m.exports.normalizeFavoriteAlias(c.args[0]);sum=(sum+v.length)>>>0;}catch(e){sum=(sum+e.status+e.code.length+e.message.length)>>>0;}} return sum;}
function reportCheck(r,runtime){assert.equal(r.format,1);assert.equal(r.runtime,runtime);assert.equal(r.inputSha256,inputSha);assert.equal(r.provenanceSha256,provenanceSha);assert.equal(r.workloads.length,defs.length);r.workloads.forEach((x,i)=>{const w=input.workloads[i], operations=w.passes*32;assert.equal(x.name,w.name);assert.equal(x.passes,w.passes);assert.equal(x.caseCount,32);assert.equal(x.operations,operations);assert.equal(x.warmupPasses,warmupPasses);assert.equal(x.checksum,expected(w,w.passes));assert.equal(x.samples.length,7);for(const s of x.samples){assert(Number.isSafeInteger(s.elapsedNs)&&s.elapsedNs>0);assert.equal(s.checksum,x.checksum);assert.equal(s.nsPerOp,s.elapsedNs/operations);}assert.equal(x.medianNsPerOp,[...x.samples].sort((a,b)=>a.elapsedNs-b.elapsedNs)[3].nsPerOp);});}
if(mode==='--prepare'){assert.deepEqual(fs.readdirSync(dir),[]);write('input',inputBytes);write('provenance',provenanceBytes);console.log(JSON.stringify({inputSha256:inputSha,provenanceSha256:provenanceSha}));}
else if(mode==='--run'){validate();assert(!fs.existsSync(file('node')));const pools=input.workloads.map(prepare);for(const w of input.workloads)for(const c of w.pool)assert.deepEqual(wire(m.exports,c),c.expected);const workloads=input.workloads.map((w,i)=>{const pool=pools[i];assert.equal(run(pool,warmupPasses),expected(w,warmupPasses));const operations=w.passes*32,samples=[];for(let n=0;n<7;n++){const start=process.hrtime.bigint(),checksum=run(pool,w.passes),elapsedNs=Number(process.hrtime.bigint()-start);assert.equal(checksum,expected(w,w.passes));samples.push({elapsedNs,nsPerOp:elapsedNs/operations,checksum});}return {name:w.name,passes:w.passes,caseCount:32,operations,warmupPasses,checksum:expected(w,w.passes),samples,medianNsPerOp:[...samples].sort((a,b)=>a.elapsedNs-b.elapsedNs)[3].nsPerOp};});validate();const report={format:1,runtime:'node',inputSha256:inputSha,provenanceSha256:provenanceSha,workloads};reportCheck(report,'node');const bytes=Buffer.from(JSON.stringify(report)+'\n');write('node',bytes);console.log(JSON.stringify({nodeReportSha256:sha(bytes)}));}
else {validate();const n=read('node'),r=read('rust');pin('DIMA_FISH_ALIAS_NODE_SHA256',sha(n));pin('DIMA_FISH_ALIAS_RUST_SHA256',sha(r));reportCheck(JSON.parse(n),'node');reportCheck(JSON.parse(r),'rust-release');assert.deepEqual(fs.readdirSync(dir).sort(),Object.values(names).sort());console.log(JSON.stringify({checked:true,inputSha256:inputSha,provenanceSha256:provenanceSha,nodeReportSha256:sha(n),rustReportSha256:sha(r)}));}
