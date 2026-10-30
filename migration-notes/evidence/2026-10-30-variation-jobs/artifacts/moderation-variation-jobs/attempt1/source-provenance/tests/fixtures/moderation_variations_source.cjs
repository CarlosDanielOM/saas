'use strict';
// Actual TypeScript source oracle. The advanced loader validates the private Node
// 24 RE2 SDK and loads the real advanced implementation and its dependencies.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const lib=require('./moderation_advanced_source.cjs');
assert.equal(process.env.DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256,'94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb');
assert.equal(process.env.DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256,'e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664');
assert.equal(process.env.DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256,'4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c');
assert.equal(lib.re2Runtime.kind,'node24-fixture');
const readerPin=process.env.DIMA_VARIATIONS_BENCH_LOADER_SHA256;
assert(/^[0-9a-f]{64}$/.test(readerPin||''),'DIMA_VARIATIONS_BENCH_LOADER_SHA256 must be independently supplied');
assert.equal(lib.sha(fs.readFileSync(__filename)),readerPin,'reader');
const pins={
 'src/utils/moderation/variations.ts':'f7a21881289f63a50de733df232570c00f851333d5762ef39e1258915287580e',
 'src/utils/ai/openrouter/app_attribution.util.ts':'0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c',
 'tests/fixtures/moderation_advanced_source.cjs':'5263edb4c997171c2e172e9d4c47093126a0d6146ff37ad432dac100865b52c2',
};
for(const [file,hash] of Object.entries(pins))assert.equal(lib.sha(lib.read(file)),hash,file);
const local=Module.createRequire(path.join(lib.root,'package.json')),ts=local('typescript');
const files=['src/utils/moderation/normalize.ts','src/utils/ai/openrouter/app_attribution.util.ts','src/utils/moderation/variations.ts'];
const imports=[[],[],[['node:crypto',false],['../ai/openrouter/app_attribution.util.js',false],['re2',false],['./normalize.js',false],['./advanced.js',false]]];
const outputs={},compiled={},evidence={};
for(const [i,file] of files.entries()){
 const source=lib.read(file).toString('utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
 assert.deepEqual(ast.parseDiagnostics,[]);
 assert.deepEqual(ast.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]),imports[i]);
 evidence[file]={imports:imports[i],exports:ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast).split('\n')[0]}))};
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});
 assert.deepEqual(result.diagnostics,[]);outputs[file]=result.outputText;compiled[file]=lib.sha(result.outputText);
}
const typeNames=evidence[files[2]].exports.filter(x=>x.kind==='TypeAliasDeclaration'||x.kind==='InterfaceDeclaration').map(x=>x.text.match(/export (?:type|interface) (\w+)/)[1]);
assert.deepEqual(typeNames,['VariationMode','GeneratedVariation','VariationOverride','ModerationVariations']);
function realm(){
 const mods={},advanced=lib.realm();
 for(const file of files){
  const mod=new Module(path.join(lib.root,file),module);mod.filename=path.join(lib.root,file);
  mod.require=id=>{
   if(id==='node:crypto')return require('node:crypto');
   if(id==='re2')return lib.RE2;
   if(id==='./normalize.js')return mods[files[0]];
   if(id==='../ai/openrouter/app_attribution.util.js')return mods[files[1]];
   if(id==='./advanced.js')return advanced.api;
   throw new Error(`unexpected import ${id} in ${file}`);
  };
  mod._compile(outputs[file],mod.filename);mods[file]=mod.exports;
 }
 const api=mods[files[2]];
 assert.deepEqual(Object.keys(api).sort(),['VARIATION_MODEL','VARIATION_VERSION','buildVariation','compileRuleVariations','generateMuseVariations','museVariationRequest','rulePatterns','validateVariations','variationAllowSpaces','variationKey','variationMode','variationOverrides','variationTerm','variationTerms','withVariationSpacing'].sort());
 return api;
}
module.exports={...lib,realm,variationPins:pins,variationCompiled:compiled,variationEvidence:evidence,typeNames,typescriptVersion:ts.version};
