'use strict';
// In-memory transpilation of complete application modules; real RE2 addon.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module'), assert = require('node:assert/strict');
const root = fs.realpathSync(process.env.DIMA_ADVANCED_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const read = p => fs.readFileSync(path.join(root,p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  'src/utils/moderation/advanced.ts':'e88c52a8662a1531bdca981129e91f9cfe3b84c2543f11d38584652aede8a4d7',
  'src/utils/moderation/rules/blacklist.rule.ts':'8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff',
  'src/utils/moderation/normalize.ts':'07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab',
  'src/utils/moderation/spam_categories.ts':'29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088',
  'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
  'tsconfig.json':'f2496ca26ef40f04270544ce5034eb71d272baedbbab7455c8efba229c5d93f9',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/re2/package.json':'3bc12f3e008781cd558c278365bcc3373aaf6ff0aed18e645f3a8e53e6d5c0db',
  'node_modules/re2/re2.js':'651cf5db625c7f828ccef28a4eaccefb3dbcd9ce600e25966987443181a7f83a',
  'node_modules/re2/build/Release/re2.node':'408c383a2c1b485e3c579e5a431acb0732a8f210304a37dc52bbe296cf17a563',
  'node_modules/re2/lib/wrapped_re2.h':'e4b3f23eb963f07d765d8e7ea3ebc650be81e02b782aeceda0fd2c72435e2f28',
  'node_modules/re2/lib/new.cc':'dcee6f77b7cd82af66f94a66bfb757a5266273fd954e68f97f6e3a5a423a8317',
  'node_modules/re2/lib/pattern.cc':'ed747fc232e06031ff23cc1941d605a92ee9b851b3a15e20755e6000b789d462',
  'node_modules/re2/lib/exec.cc':'c6ddf96bfd12833ca1f056232a7dcda306da73af039584b315d66d492485ab18',
  'node_modules/re2/lib/util.cc':'cf3bd850db64f9bea8a05026c685544245893bda28e691d08586b510d6460d5e',
};
for (const [p,h] of Object.entries(pins)) assert.equal(sha(read(p)),h,p);
const nodeSha='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)),nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode,process.versions.modules],['24.22.1','13.6.233.17-node.58','78.3','17.0','137']);
const local=Module.createRequire(path.join(root,'package.json')), ts=local('typescript');
assert.equal(ts.version,'5.9.3');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
assert.equal(JSON.parse(read('node_modules/re2/package.json')).version,'1.27.0');
assert.equal(fs.realpathSync(local.resolve('re2')),fs.realpathSync(path.join(root,'node_modules/re2/re2.js')));
assert.equal(typeof crypto.randomUUID,'function');
const fixtureSetting=process.env.DIMA_ADVANCED_RE2_FIXTURE_ROOT;
const digestEnv=name=>{const value=process.env[name];assert(/^[0-9a-f]{64}$/.test(value||''),`${name} must be an independently supplied SHA-256`);return value;};
let RE2, re2Runtime;
if(fixtureSetting!==undefined){
  assert(path.isAbsolute(fixtureSetting),'fixture root must be absolute');
  const fixture=fs.realpathSync(fixtureSetting), installed=fs.realpathSync(path.join(root,'node_modules/re2'));
  assert.notEqual(fixture,installed,'fixture must be a separate package');
  const binarySha=digestEnv('DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256');
  const manifestSha=digestEnv('DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256');
  const provenanceSha=digestEnv('DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256');
  const manifestBytes=fs.readFileSync(path.join(path.dirname(fixture),'source-manifest.json'));
  const provenanceBytes=fs.readFileSync(path.join(path.dirname(fixture),'build-provenance.json'));
  assert.equal(sha(manifestBytes),manifestSha,'fixture source manifest');
  assert.equal(sha(provenanceBytes),provenanceSha,'fixture build provenance');
  const manifest=JSON.parse(manifestBytes), provenance=JSON.parse(provenanceBytes);
  assert(manifest && typeof manifest==='object' && !Array.isArray(manifest));
  // Require exactly the complete regular-file set in both source trees outside
  // build/. Reject symlinks and undeclared SDK files, including extra JS.
  function sourceFiles(base){
    const found=[];
    function walk(relative){
      for(const entry of fs.readdirSync(path.join(base,relative),{withFileTypes:true})){
        const name=relative ? `${relative}/${entry.name}` : entry.name;
        if(name==='build')continue;
        assert(!entry.isSymbolicLink(),`symlink in SDK: ${name}`);
        if(entry.isDirectory())walk(name);
        else {assert(entry.isFile(),`non-regular SDK file: ${name}`);found.push(name);}
      }
    }
    walk('');return found.sort();
  }
  const names=Object.keys(manifest).sort();
  assert(names.length>0,'empty source manifest');
  assert.deepEqual(sourceFiles(installed),names,'installed RE2 source set');
  assert.deepEqual(sourceFiles(fixture),names,'fixture RE2 source set');
  for(const name of names){
    assert(/^[0-9a-f]{64}$/.test(manifest[name]),`invalid digest: ${name}`);
    assert.equal(sha(fs.readFileSync(path.join(installed,name))),manifest[name],`installed ${name}`);
    assert.equal(sha(fs.readFileSync(path.join(fixture,name))),manifest[name],`fixture ${name}`);
  }
  assert.equal(provenance.format,1);
  assert.deepEqual(provenance.node,{version:'24.22.1',abi:'137',binarySha256:nodeSha});
  assert.equal(provenance.sourceManifestSha256,manifestSha);
  assert.equal(provenance.binary.relativePath,'build/Release/re2.node');
  assert.equal(provenance.binary.sha256,binarySha);
  const binaryBytes=fs.readFileSync(path.join(fixture,provenance.binary.relativePath));
  assert.equal(binaryBytes.length,provenance.binary.bytes);
  assert.equal(sha(binaryBytes),binarySha,'fixture addon');
  assert(provenance.build && Array.isArray(provenance.build.command) && provenance.build.command.length>0 && provenance.build.command.every(x=>typeof x==='string'));
  assert.equal(provenance.build.jobs,2);
  assert(provenance.build.headers && typeof provenance.build.headers==='object' && !Array.isArray(provenance.build.headers));
  const headers=Object.entries(provenance.build.headers);assert(headers.length>0);
  for(const [name,digest] of headers)assert(name && /^[0-9a-f]{64}$/.test(digest),`invalid header evidence: ${name}`);
  for(const name of ['compiler','make','python'])assert(typeof provenance.build.tools?.[name]==='string' && provenance.build.tools[name].length>0,`missing build tool: ${name}`);
  assert.equal(provenance.image,'sha256:a001f865dc47694124ef59a1f71cdf80e6214f64613f4e5b4d891088f71dca82','Node build image');
  const fixtureRequire=Module.createRequire(path.join(fixture,'package.json'));
  assert.equal(fs.realpathSync(fixtureRequire.resolve(path.join(fixture,'re2.js'))),path.join(fixture,'re2.js'));
  RE2=fixtureRequire(path.join(fixture,'re2.js')); // actual freshly built addon, no engine substitute
  re2Runtime={kind:'node24-fixture',abi:process.versions.modules,installedBinarySha256:pins['node_modules/re2/build/Release/re2.node'],loadedBinarySha256:binarySha,sourceManifestSha256:manifestSha,sourceFileCount:names.length,buildProvenanceSha256:provenanceSha,buildProvenance:provenance};
}else{
  for(const name of ['DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256','DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256','DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256'])assert.equal(process.env[name],undefined,`${name} requires fixture root`);
  RE2=local('re2'); // strict installed default; never silently fall back
  re2Runtime={kind:'installed',abi:process.versions.modules,installedBinarySha256:pins['node_modules/re2/build/Release/re2.node'],loadedBinarySha256:pins['node_modules/re2/build/Release/re2.node']};
}
const files=['src/utils/moderation/normalize.ts','src/utils/moderation/rules/blacklist.rule.ts','src/utils/moderation/advanced.ts'];
const expectedImports=[[],[['../../../schemas/channel_moderation_settings.schema.js',true],['../normalize.js',false]],[['./spam_categories.js',true],['node:crypto',false],['re2',false],['./rules/blacklist.rule.js',false],['./normalize.js',false]]];
const outputs={}, compiled={}, evidence={};
files.forEach((file,i)=>{
  const source=read(file).toString('utf8'), ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
  assert.deepEqual(ast.parseDiagnostics,[]);
  const imports=ast.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]);
  assert.deepEqual(imports,expectedImports[i]);
  evidence[file]={imports,exports:ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast).split('\n')[0]}))};
  const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});
  assert.deepEqual(result.diagnostics,[]); outputs[file]=result.outputText; compiled[file]=sha(result.outputText);
});
function realm({uuidQueue=null,observe=false}={}) {
  const draws=[], constructions=[];
  const re2=observe ? new Proxy(RE2,{construct(target,args){
    const event={source:args[0],flags:args[1]}; constructions.push(event);
    try { return Reflect.construct(target,args,target); } catch(e) { event.error={name:e.name,message:e.message}; throw e; }
  }}) : RE2;
  const sourceCrypto=uuidQueue===null ? crypto : {...crypto,randomUUID(){
    const value=uuidQueue[draws.length]; draws.push(value === undefined ? null : value);
    if(value===undefined) throw new Error('fixture UUID queue exhausted'); return value;
  }};
  const mods={};
  for(const file of files){
    const mod=new Module(path.join(root,file),module); mod.filename=path.join(root,file);
    mod.require=id=>{
      if(id==='node:crypto') return sourceCrypto;
      if(id==='re2') return re2;
      if(id==='../normalize.js'||id==='./normalize.js') return mods[files[0]];
      if(id==='./rules/blacklist.rule.js') return mods[files[1]];
      throw new Error(`unexpected runtime import ${id} in ${file}`);
    };
    mod._compile(outputs[file],mod.filename); mods[file]=mod.exports;
  }
  assert.deepEqual(Object.keys(mods[files[2]]).sort(),['ALLOW_THRESHOLD','DECISION_POLICY_VERSION','MODERATION_RETENTION_DAYS','MODERATION_VISIBLE_DAYS','SEMANTIC_DEADLINE_MS','SEMANTIC_MODEL','emptySemanticPolicy','findBlacklistMatches','paidModeration','parseAdvancedRule']);
  return {api:mods[files[2]],draws,constructions};
}
const provenanceFiles=['src/utils/re2_compat.rs','src/utils/js_string.rs','src/utils/lossless_json.rs','src/server/routes/moderation.route.ts','src/handlers/moderation.handler.ts','tests/fixtures/moderation_advanced_source.cjs','tests/fixtures/moderation_advanced_reference.cjs'];
module.exports={root,read,sha,pins,nodeSha,compiled,evidence,realm,RE2,re2Runtime,provenance:()=>Object.fromEntries(provenanceFiles.map(p=>[p,sha(read(p))]))};
