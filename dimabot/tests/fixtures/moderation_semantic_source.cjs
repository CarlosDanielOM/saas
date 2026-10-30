'use strict';
// Complete unchanged semantic.ts, actual paidModeration/SPAM_RULE_ID/categoryQuestions.
// Loading creates disconnected Mongoose models through the audited Spam loader.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module'),vm=require('node:vm');
const spam=require('./moderation_spam_source.cjs'),advanced=require('./moderation_advanced_source.cjs');
const pins={
 'src/utils/moderation/semantic.ts':'8e14987048727194d8e55b48f5c0890a0984c3fd1fa4634488c8758d1a835e25',
 'src/utils/ai/openrouter/app_attribution.util.ts':'0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c',
 'tests/fixtures/moderation_spam_source.cjs':'24173a6f2eb5979c89aa27cf5804c4c2c9f92df02daf7a66d9479e5e52cb7b8a'
};
for(const [file,hash] of Object.entries(pins))assert.equal(spam.sha(spam.read(file)),hash,file);
spam.independent('DIMA_SEMANTIC_LOADER_SHA256',__filename);
const ts=Module.createRequire(path.join(spam.root,'package.json'))('typescript');
const files=['src/utils/ai/openrouter/app_attribution.util.ts','src/utils/moderation/semantic.ts'];
const expectedImports=[[],[
 ['../../schemas/moderation_decision.schema.js',true],['../ai/openrouter/app_attribution.util.js',false],['./spam_categories.js',false],['./advanced.js',false],['./spam.js',false],['./spam_categories.js',false]
]];
const runtimeExports=['SEMANTIC_USD_PER_MILLION_INPUT_TOKENS','SEMANTIC_PRICING_VERSION','FREE_MODERATION_MODEL','semanticPrice','moderationModelForAccount','fallbackResult','parseSemanticResponse','parseSpamResponse','semanticRequest','evaluateSemanticDecision'].sort();
const outputs={},compiled={},evidence={};
for(const [i,file] of files.entries()){
 const source=spam.read(file).toString('utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);assert.deepEqual(ast.parseDiagnostics,[]);
 const imports=ast.statements.filter(ts.isImportDeclaration).map(s=>[s.moduleSpecifier.text,!!s.importClause?.isTypeOnly]);assert.deepEqual(imports,expectedImports[i],file);
 const declarations=ast.statements.filter(s=>ts.isTypeAliasDeclaration(s)||ts.isInterfaceDeclaration(s));
 evidence[file]={imports:ast.statements.filter(ts.isImportDeclaration).map(s=>({module:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,bindings:s.importClause?.getText(ast),named:s.importClause?.namedBindings?.elements?.map(e=>({name:e.name.text,typeOnly:!!e.isTypeOnly}))||[]})),exports:ast.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],text:s.getText(ast)})),typeDeclarations:declarations.map(s=>({name:s.name.text,exported:!!s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),text:s.getText(ast)}))};
 if(i===1)assert.deepEqual(declarations.map(s=>s.name.text),['SemanticResult','SemanticState']);
 const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});assert.deepEqual(out.diagnostics,[]);outputs[file]=out.outputText;compiled[file]=spam.sha(out.outputText);
}
// categoryQuestions is already transpiled by Spam's complete-module loader;
// expose it by compiling the same unchanged module, with no substituted policy.
const categoryFile='src/utils/moderation/spam_categories.ts';
const categorySource=spam.read(categoryFile).toString('utf8');
const categoryOutput=ts.transpileModule(categorySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.deepEqual(categoryOutput.diagnostics,[]);
function realm({kind='cjs',hooks={}}={}){
 assert(['cjs','vm'].includes(kind));const mods={},spamRealm=spam.realm({kind}),advancedRealm=advanced.realm();
 const runtime={Date:class FunctionClock extends Date {static now(){return hooks.now?.()??spam.FIXED_MS;}},fetch:hooks.fetch||(()=>{throw Error('fetch fixture required');}),AbortSignal:hooks.AbortSignal||AbortSignal,process:{env:hooks.env||{}}};
 function load(file,output){
  const mod=new Module(path.join(spam.root,file),module);mod.filename=path.join(spam.root,file);
  mod.require=id=>{
   if(id==='fixture:runtime')return runtime;
   if(id==='../ai/openrouter/app_attribution.util.js')return mods[files[0]];
   if(id==='./spam_categories.js')return mods[categoryFile];
   if(id==='./advanced.js')return advancedRealm.api;
   if(id==='./spam.js')return spamRealm.api;
   throw Error(`unexpected semantic runtime import ${id}`);
  };
  // Function boundaries only. Never inject a replacement Date into schemas.
  const code=(file===files[1]?"const {Date,fetch,AbortSignal,process}=require('fixture:runtime');\n":'')+output;
  if(kind==='cjs')mod._compile(code,mod.filename);else {const wrapper=vm.runInNewContext(Module.wrap(code),{Buffer,console,Error,AbortSignal},{filename:mod.filename});wrapper.call(mod.exports,mod.exports,mod.require,mod,mod.filename,path.dirname(mod.filename));}
  mods[file]=mod.exports;
 }
 load(categoryFile,categoryOutput.outputText);for(const file of files)load(file,outputs[file]);
 assert.deepEqual(Object.keys(mods[files[1]]).sort(),runtimeExports);
 assert.equal(spamRealm.instance.connection.readyState,0);
 return {api:mods[files[1]],categories:mods[categoryFile],attribution:mods[files[0]],spam:spamRealm.api};
}
module.exports={...spam,realm,pins:{...spam.pins,...pins},compiled:{...spam.compiled,...compiled},evidence:{...spam.evidence,...evidence},runtimeExports,typeExports:['SemanticResult'],privateTypes:['SemanticState']};
