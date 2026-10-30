'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
// Strictly check and execute the complete, pinned actual TypeScript source.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module'), assert = require('node:assert/strict');
const root = fs.realpathSync(process.env.DIMA_LINKS_SOURCE_ROOT || path.join(__dirname,'../..'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = name => fs.readFileSync(leaf.sourcePath(root, name));
const pins = {
 'src/utils/moderation/rules/links.rule.ts':'802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0',
 'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
 'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
 'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
 'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
 'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
};
for (const [name,digest] of Object.entries(pins)) assert.equal(sha(read(name)),digest,name);
const nodePin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_LINKS_NODE_SHA256,nodePin);
assert.equal(sha(fs.readFileSync(process.execPath)),nodePin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local=Module.createRequire(path.join(root,'package.json')), ts=local('typescript');
assert.equal(ts.version,'5.9.3');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
const sourceName=path.join(root,'src/utils/moderation/rules/links.rule.ts'), schemaName=path.join(root,'src/schemas/channel_moderation_settings.schema.ts');
const source=read('src/utils/moderation/rules/links.rule.ts').toString('utf8');
const ast=ts.createSourceFile(sourceName,source,ts.ScriptTarget.ES2022,true);
const schema=ts.createSourceFile(schemaName,read('src/schemas/channel_moderation_settings.schema.ts').toString('utf8'),ts.ScriptTarget.ES2022,true);
assert.deepEqual(ast.parseDiagnostics,[]); assert.deepEqual(schema.parseDiagnostics,[]);
assert.equal(ast.statements.length,6);
const [imp,result,regexp,extract,allow,evaluate]=ast.statements;
assert(ts.isImportDeclaration(imp) && imp.importClause.isTypeOnly && !imp.importClause.name);
assert.equal(imp.moduleSpecifier.text,'../../../schemas/channel_moderation_settings.schema.js');
assert.deepEqual(imp.importClause.namedBindings.elements.map(e=>e.name.text),['IModerationRule']);
assert(ts.isInterfaceDeclaration(result) && result.name.text==='LinksEvaluationResult');
assert(ts.isVariableStatement(regexp) && regexp.declarationList.declarations.length===1);
assert.equal(regexp.declarationList.declarations[0].name.text,'URL_PATTERN');
assert.equal(regexp.declarationList.declarations[0].initializer.kind,ts.SyntaxKind.RegularExpressionLiteral);
assert.deepEqual([extract,allow,evaluate].map(s=>s.name.text),['extractHostname','isAllowlisted','evaluateLinksRule']);
assert([extract,allow,evaluate].every(ts.isFunctionDeclaration));
const schemaRule=schema.statements.find(s=>ts.isInterfaceDeclaration(s)&&s.name.text==='IModerationRule');
const fields=schemaRule.members.filter(m=>m.name?.getText(schema)==='allowlistDomains');
assert.equal(fields.length,1); const field=fields[0];
assert(ts.isPropertySignature(field) && !field.questionToken && field.type.getText(schema)==='string[]');
const declaration=`export interface IModerationRule { ${field.getText(schema)} }\n`;
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const host=leaf.overlaySource(ts.createCompilerHost(options), ts, root, ["src/utils/moderation/rules/links.rule.ts"]), readFile=host.readFile.bind(host);
host.readFile=file=>path.resolve(file)===schemaName?declaration:readFile(file);
const program=ts.createProgram([sourceName],options,host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.deepEqual(compiled.diagnostics,[]);
const runtime=new Module(sourceName,module); runtime.filename=sourceName;runtime.paths=Module._nodeModulePaths(path.dirname(sourceName));
runtime.require=name=>{throw Error(`unexpected runtime require ${name}`);};
runtime._compile(compiled.outputText,sourceName);
assert.deepEqual(Object.keys(runtime.exports),['evaluateLinksRule']);
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const str=u=>String.fromCharCode(...u);
const cases=[];
function add(id,text,domains){
 const textKind=text===undefined?'missing':text===null?'null':'string';
 const allowKind=domains===undefined?'missing':domains===null?'null':'array';
 const input=textKind==='missing'?{}:{text};
 const rule=allowKind==='missing'?{}:{allowlistDomains:domains};
 const value=runtime.exports.evaluateLinksRule(rule,input);
 cases.push({id,textKind,text:textKind==='string'?units(text):null,allowKind,domains:allowKind==='array'?domains.map(units):null,triggered:value.triggered,urls:value.urls.map(units),blocked:value.blockedUrl===null?null:units(value.blockedUrl),wire:JSON.stringify(value)});
}
const texts=[
 '', 'a.com a.com b.org', 'example.com,foo.bar!', 'foo.a.bb.cc.zz', 'a.abc123.xyz trailing a.ab-foo',
 'WWW.EXAMPLE.COM/Path?Q#Frag', 'HTTP://USER:PASS@EXAMPLE.COM:80/path', 'https://[::1]:80/p http://[::ffff:192.0.2.1]:80',
 'http://no-dot http://. foo..com x_.ab _x.-bc.abc a.b.a.bbb',
 'http://foo.com?q=x#x www.foo.com#fragment a.com?q foo.bar#baz',
 'foo.com/path?next=OTHER.XYZ www.example.com, http://a.b/',
 'https://ΟΣ.ΤΣ/Α https://ΟΣ.ΤΣ/1 https://ΟΣ.ΤΣ#Α',
 'https://İ.Σ/path https://K.COM/Σ www.𐐀.𐐨/a',
 str([104,116,116,112,58,47,47,0xd800,46,65,47,0xdc00]),
 str([65,46,66,67,0xd800,46,65,66,32,0xdc00]),
 'hTTp://a.com\u00a0www.b.net\u0085tail a.xyz\u2028b.org\ufeffc.tv',
 'http:// https:// www. www. http://. www..',
 'aaaa'.repeat(1000)+' '+('a.'.repeat(400))+'a.x',
 'http://😀.com/path😀', 'ＷＷＷ.KK / ſſ.com', 'http://a.com/x\nB.io',
];
const lists=[[],['twitch.tv'],['EXAMPLE.COM'],[''],['.com'],['COM'],['example.com.'],['ΟΣ.ΤΣ'],[str([0xd800,46,97])],['x.y','x.y']];
for(const [i,text] of texts.entries()) for(const [j,list] of lists.entries()) add(`named-${i}-${j}`,text,list);
for(const [kind,text] of [['missing',undefined],['null',null]]) for(const [key,list] of [['missing',undefined],['null',null],['empty',[]]]) add(`nullish-${kind}-${key}`,text,list);
for(const [key,list] of [['missing',undefined],['null',null]]) add(`allow-${key}`,'a.com a.com b.net',list);
// Each ASCII code unit is exercised at protocol, hostname, path and allowlist boundaries.
for(let cp=0;cp<128;cp++) {
 const c=String.fromCharCode(cp);
 add(`ascii-prefix-${cp}`,`http://A.${c}bc/x`,[]);
 add(`ascii-plain-${cp}`,`a${c}.com x.${c}ab/z`,[]);
 add(`ascii-allow-${cp}`,`http://x.${c}/A`,[c,`x.${c}`]);
}
for(const cp of [0x85,0xa0,0x1680,0x180e,0x2000,0x200a,0x200b,0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff,0xd800,0xdc00]) {
 const c=String.fromCharCode(cp);
 add(`unit-${cp}`,`http://A.${c}BC/a${c}www.x.io`,[c,`a.${c}bc`]);
}
// Exhaust a compact alphabet at lengths 1–4 and combine suffixes; source
// supplies every expected value, including overlap and greedy backtracking.
const alphabet=['a','B','0','_','-','.','/','?',':',' '];
let counter=0;
function enumerate(prefix,depth){
 if(depth===0){for(const suffix of ['','.ab','.aB-c.xy','/a.io']) add(`generated-${counter++}`,prefix+suffix,[]);return;}
 for(const c of alphabet) enumerate(prefix+c,depth-1);
}
for(let length=1;length<=4;length++) enumerate('',length);
const files=['src/utils/moderation/links_rule.rs','src/utils/js_string.rs','src/utils/js_compat.rs','src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','tests/moderation_links.rs','tests/fixtures/moderation_links_reference.cjs'];
const hashes=Object.fromEntries(files.map(name=>[name,sha(read(name))]));
const metadata={format:1,sourceProvenance:leaf.provenance(root,["src/utils/moderation/rules/links.rule.ts"]),versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version},nodeSha:nodePin,pins,hashes,compiledSha:sha(compiled.outputText),schemaField:field.getText(schema),total:cases.length};
const output=JSON.stringify({metadata,cases},null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&extra.length===0,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(root,'..'));
assert(real!==workspace&&!real.startsWith(workspace+path.sep),'output outside workspace required');
assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:['moderation_links_reference.json']);
const dest=path.join(real,'moderation_links_reference.json');
if(mode==='--write') fs.writeFileSync(dest,output,{flag:'wx'}); else assert.equal(fs.readFileSync(dest,'utf8'),output);
