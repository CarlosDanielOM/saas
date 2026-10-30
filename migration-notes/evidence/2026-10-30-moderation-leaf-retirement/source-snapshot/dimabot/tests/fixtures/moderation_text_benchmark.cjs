'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
// Prepared, source-generated inputs; CommonJS realm is used for all timing.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const Module=require('node:module'),readline=require('node:readline');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=fs.realpathSync(process.env.DIMA_MODERATION_TEXT_SOURCE_ROOT||path.join(__dirname,'../..'));
const pinNode='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_MODERATION_TEXT_NODE_SHA256,pinNode);assert.equal(digest(fs.readFileSync(process.execPath)),pinNode);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const pins={
 'src/utils/moderation/rules/links.rule.ts':'802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0',
 'src/utils/moderation/normalize.ts':'07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab',
 'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
 'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
 'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
 'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
 'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
};
const read=file=>fs.readFileSync(leaf.sourcePath(root, file));
for(const [f,h] of Object.entries(pins))assert.equal(digest(read(f)),h,f);
const local=Module.createRequire(path.join(root,'package.json')),ts=local('typescript');assert.equal(ts.version,'5.9.3');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
const linkName=path.join(root,'src/utils/moderation/rules/links.rule.ts'),normName=path.join(root,'src/utils/moderation/normalize.ts'),schemaName=path.join(root,'src/schemas/channel_moderation_settings.schema.ts');
const link=read('src/utils/moderation/rules/links.rule.ts').toString('utf8'),norm=read('src/utils/moderation/normalize.ts').toString('utf8');
const sf=ts.createSourceFile(linkName,link,ts.ScriptTarget.ES2022,true), ns=ts.createSourceFile(normName,norm,ts.ScriptTarget.ES2022,true),schema=ts.createSourceFile(schemaName,read('src/schemas/channel_moderation_settings.schema.ts').toString('utf8'),ts.ScriptTarget.ES2022,true);
assert.deepEqual(sf.parseDiagnostics,[]);assert.deepEqual(ns.parseDiagnostics,[]);assert.deepEqual(schema.parseDiagnostics,[]);
assert.equal(sf.statements.length,6);assert(ts.isImportDeclaration(sf.statements[0])&&sf.statements[0].importClause.isTypeOnly);
assert.equal(sf.statements[0].moduleSpecifier.text,'../../../schemas/channel_moderation_settings.schema.js');assert.deepEqual(sf.statements[0].importClause.namedBindings.elements.map(e=>e.name.text),['IModerationRule']);
assert.deepEqual(sf.statements.filter(ts.isFunctionDeclaration).map(s=>s.name.text),['extractHostname','isAllowlisted','evaluateLinksRule']);
assert.deepEqual(ns.statements.map(s=>s.name.text),['foldText','escapeRegExp']);assert(ns.statements.every(ts.isFunctionDeclaration));
const rule=schema.statements.find(s=>ts.isInterfaceDeclaration(s)&&s.name.text==='IModerationRule');
const fields=rule.members.filter(m=>m.name?.getText(schema)==='allowlistDomains');assert.equal(fields.length,1);assert(ts.isPropertySignature(fields[0])&&!fields[0].questionToken&&fields[0].type.getText(schema)==='string[]');
const declaration=`export interface IModerationRule { ${fields[0].getText(schema)} }\n`;
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host=leaf.overlaySource(ts.createCompilerHost(options), ts, root, ["src/utils/moderation/rules/links.rule.ts", "src/utils/moderation/normalize.ts"]),readFile=host.readFile.bind(host);host.readFile=f=>path.resolve(f)===schemaName?declaration:readFile(f);
const program=ts.createProgram([linkName,normName],options,host);assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
function load(name,source){const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);const mod=new Module(name,module);mod.filename=name;mod.paths=Module._nodeModulePaths(path.dirname(name));mod.require=x=>{throw Error(`unexpected require ${x}`)};mod._compile(compiled.outputText,name);return {exports:mod.exports,sha:digest(compiled.outputText)};}
const links=load(linkName,link),normal=load(normName,norm);
assert.deepEqual(Object.keys(links.exports),['evaluateLinksRule']);assert.deepEqual(Object.keys(normal.exports).sort(),['escapeRegExp','foldText']);
const nativeFiles=['src/utils/moderation/links_rule.rs','src/utils/moderation/normalize.rs','src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/js_string.rs','src/utils/js_compat.rs','Cargo.toml','Cargo.lock','tests/moderation_text_benchmark.rs','tests/fixtures/moderation_text_benchmark.cjs'];
const nativeHashes=Object.fromEntries(nativeFiles.map(f=>[f,digest(read(f))]));
const versions={node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version};
const compiledSha={links:links.sha,normalize:normal.sha};
const toUnits=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const fromUnits=a=>String.fromCharCode(...a);
const long=(s,n)=>s.repeat(n).slice(0,1000);
const specs={
 'link-common':[
  ['quiet','hello chat how are you?',[]],['one','look https://example.com/path',[]],['allowed','see clips.twitch.tv/c',['twitch.tv']],['two','a.com and b.net',['a.com']],
  ['three','a.org b.org c.org',['b.org']],['www','WWW.EXAMPLE.COM/Clip',['example.com']],['empty','',[]],['unicode','https://ΩΣ.ΤΣ/Α text',['ΩΣ.ΤΣ']]],
 'link-large':[
  ['none',long('a',1000),[]],['dots',long('a.',500)+'x',[]],['greedy',long('label.',165)+'example.com/path',[]],['text',long('ordinary chat words ',56),['example.com']],
  ['two',long('x ',480)+'https://EXAMPLE.COM/A a.net',['example.com']],['unicode',long('αβ γδ ',160)+'https://ΩΣ.ΤΣ/Α',[]],['path','https://example.com/'+long('abcdef',165),['example.com']],['lone',long('abc ',245)+'https://\ud800.A/path\udc00',[]]],
 'fold-text':[
  ['ascii','HELLO world 123'],['empty',''],['accent','Café Ångström İ'],['greek','AΣ\u0345A ΟΣ'],['marks','A\u0301\u1ade\u0327Σ'],['astral','𐐀𐐨 😀 café'],['lone','A\ud800Σ\u0301\udc00'],['clean','simple lowercase chat']],
 'escape-regexp':[
  ['clean','simple lowercase chat'],['all','.*+?^${}()|[]\\'],['mixed','a.b[c](d)+'],['astral','𐐀😀.x'],['lone','\ud800.😀[\udc00'],['empty',''],['slashes','/,-_!\n\0'],['many','a.b?c[d]'.repeat(10)]]
};
function evaluate(kind,p){if(kind.startsWith('link-'))return links.exports.evaluateLinksRule(p.rule,p.input);if(kind==='fold-text')return normal.exports.foldText(p.text);return normal.exports.escapeRegExp(p.text);}
function prepare(){const pools={};for(const [kind,list] of Object.entries(specs)){assert.equal(list.length,8);pools[kind]=list.map(([id,text,domains])=>{const p=kind.startsWith('link-')?{rule:{allowlistDomains:domains},input:{text}}:{text};const result=evaluate(kind,p);return {id,text:toUnits(text),domains:domains?domains.map(toUnits):null,expected:kind.startsWith('link-')?{triggered:result.triggered,urls:result.urls.map(toUnits),blocked:result.blockedUrl===null?null:toUnits(result.blockedUrl)}:{units:toUnits(result)},wire:JSON.stringify(result)};});}
return {metadata:{format:1,sourceProvenance:leaf.provenance(root,["src/utils/moderation/normalize.ts", "src/utils/moderation/rules/links.rule.ts"]),versions,nodeSha:pinNode,pins,nativeHashes,compiledSha,realm:'commonjs'},pools};}
const dirArg=process.env.DIMA_MODERATION_TEXT_BENCH_DIR;assert(dirArg&&path.isAbsolute(dirArg));const dir=fs.realpathSync(dirArg);assert.equal(dir,dirArg);
const workspace=fs.realpathSync(path.join(root,'..'));assert(dir!==workspace&&!dir.startsWith(workspace+path.sep));
const file=path.join(dir,'moderation-text-benchmark-input.json');
const [mode,...extra]=process.argv.slice(2);assert(['--write','--check','--serve'].includes(mode)&&extra.length===0);
if(mode==='--write'||mode==='--check'){
 assert.deepEqual(fs.readdirSync(dir),mode==='--write'?[]:[path.basename(file)]);
 const bytes=JSON.stringify(prepare(),null,2)+'\n';
 if(mode==='--write')fs.writeFileSync(file,bytes,{flag:'wx'});else assert.equal(fs.readFileSync(file,'utf8'),bytes);
 console.log(JSON.stringify({mode,inputSha:digest(bytes),compiledSha,nativeHashes}));
}else{
 const bytes=fs.readFileSync(file),inputSha=digest(bytes);assert.equal(inputSha,process.env.DIMA_MODERATION_TEXT_INPUT_SHA256);
 const data=JSON.parse(bytes);assert.deepEqual(data.metadata,{format:1,versions,nodeSha:pinNode,pins,nativeHashes,compiledSha,realm:'commonjs'});
 const pools={};for(const [kind,rows] of Object.entries(data.pools)){assert(Object.hasOwn(specs,kind)&&rows.length===8);pools[kind]=rows.map(row=>{const text=fromUnits(row.text);const p=kind.startsWith('link-')?{rule:{allowlistDomains:row.domains.map(fromUnits)},input:{text}}:{text};const actual=evaluate(kind,p);assert.equal(JSON.stringify(actual),row.wire,row.id);const expected=kind.startsWith('link-')?{triggered:actual.triggered,urls:actual.urls.map(toUnits),blocked:actual.blockedUrl===null?null:toUnits(actual.blockedUrl)}:{units:toUnits(actual)};assert.deepEqual(expected,row.expected,row.id);return {id:row.id,...p};});}
 assert.deepEqual(Object.keys(pools),Object.keys(specs));
 const reps=Number(process.env.DIMA_MODERATION_TEXT_REPS||1000);assert(Number.isSafeInteger(reps)&&reps>0&&reps<=10000);
 const mix=(h,v)=>Math.imul(h^(v>>>0),16777619)>>>0;
 function run(kind){const pool=pools[kind],total=pool.length*reps,results=new Array(total);const start=process.hrtime.bigint();for(let i=0;i<total;i++)results[i]=evaluate(kind,pool[i%pool.length]);const elapsed=process.hrtime.bigint()-start;let checksum=2166136261;for(const value of results){const wire=JSON.stringify(value);for(let j=0;j<wire.length;j++)checksum=mix(checksum,wire.charCodeAt(j));checksum=mix(checksum,0xffffffff);}return {workload:kind,elapsedNs:elapsed.toString(),total,checksum};}
 console.log(JSON.stringify({ready:true,realm:'commonjs',pools:Object.fromEntries(Object.entries(pools).map(([k,v])=>[k,v.map(p=>p.id)])),reps,inputSha,compiledSha,nativeHashes,nodeSha:pinNode}));
 readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const cmd=JSON.parse(line);if(cmd.command==='quit')process.exit(0);assert(['warmup','run'].includes(cmd.command)&&Object.hasOwn(pools,cmd.workload));console.log(JSON.stringify(run(cmd.workload)));});
}
