'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module'), assert = require('node:assert/strict');
const root = fs.realpathSync(process.env.DIMA_SPAM_CATEGORIES_SOURCE_ROOT || path.join(__dirname, '../..'));
const read = f => fs.readFileSync(leaf.sourcePath(root, f));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  'src/utils/moderation/spam_categories.ts':'29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
};
for (const [file, digest] of Object.entries(pins)) assert.equal(sha(read(file)), digest, file);
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_SPAM_CATEGORIES_NODE_SHA256, nodeSha); assert.equal(sha(fs.readFileSync(process.execPath)), nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local = Module.createRequire(path.join(root, 'package.json')), ts = local('typescript');
assert.equal(ts.version,'5.9.3'); assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
const filename = path.join(root,'src/utils/moderation/spam_categories.ts'), source = read('src/utils/moderation/spam_categories.ts').toString('utf8');
const ast = ts.createSourceFile(filename,source,ts.ScriptTarget.ES2022,true);
assert.deepEqual(ast.parseDiagnostics, []);
assert.equal(ast.statements.length, 11);
assert.deepEqual(ast.statements.filter(ts.isTypeAliasDeclaration).map(s => [s.name.text,s.type.getText(ast)]), [['SpamCategory','typeof SPAM_CATEGORIES[number]'],['SpamExemptTag','typeof SPAM_EXEMPT_TAGS[number]']]);
const iface = ast.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === 'SpamProtection'); assert(iface);
assert.deepEqual(iface.members.map(f => [f.name.getText(ast),!!f.questionToken,f.type.getText(ast)]), [['enabled',false,'boolean'],['reviewAllMessages',false,'boolean'],['categories',true,'SpamCategory[]'],['thresholdPercent',true,'number'],['exemptTags',true,'SpamExemptTag[]']]);
assert(ast.statements.every(s => !ts.isImportDeclaration(s)));
const exported = ast.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)); assert.equal(exported.length,11);
const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
const program = ts.createProgram([filename], options, leaf.overlaySource(ts.createCompilerHost(options), ts, root, ['src/utils/moderation/spam_categories.ts'])); assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const compiled = ts.transpileModule(source,{compilerOptions:options,reportDiagnostics:true}); assert.deepEqual(compiled.diagnostics,[]);
const runtime = new Module(filename,module); runtime.filename=filename; runtime.require = name => { throw Error(`unexpected runtime import ${name}`); }; runtime._compile(compiled.outputText,filename);
const lib = runtime.exports;
assert.deepEqual(Object.keys(lib).sort(),['DEFAULT_SPAM_CATEGORIES','DEFAULT_SPAM_EXEMPT_TAGS','DEFAULT_SPAM_THRESHOLD','SPAM_CATEGORIES','SPAM_CATEGORY_POLICIES','SPAM_CLASSIFIER_MODEL','SPAM_EXEMPT_TAGS','categoryQuestions'].sort());
assert.deepEqual(lib.SPAM_CATEGORIES,['spam','ads','self_promotion','profanity','insults']);
assert.deepEqual(lib.DEFAULT_SPAM_CATEGORIES,['spam','ads','self_promotion']); assert.equal(lib.DEFAULT_SPAM_THRESHOLD,85); assert.equal(lib.SPAM_CLASSIFIER_MODEL,'typesafe/jev-1.13');
assert.deepEqual(lib.SPAM_EXEMPT_TAGS,['vip','mod','sub','founder','editor','admin']); assert.deepEqual(lib.DEFAULT_SPAM_EXEMPT_TAGS,['mod','editor','admin']);
assert.deepEqual(Object.keys(lib.SPAM_CATEGORY_POLICIES),lib.SPAM_CATEGORIES);
// Copies made by the settings schema and spam helper have independent mutable arrays.
for (const defaults of [lib.DEFAULT_SPAM_CATEGORIES,lib.DEFAULT_SPAM_EXEMPT_TAGS]) { const a=[...defaults], b=[...defaults]; a.push('sentinel'); assert.deepEqual(b,defaults); assert(!defaults.includes('sentinel')); }
const inputs=[];
function permutations(prefix, remaining) { inputs.push(prefix); for (let i=0;i<remaining.length;i++) permutations([...prefix,remaining[i]],remaining.filter((_,j)=>j!==i)); }
permutations([],lib.SPAM_CATEGORIES); assert.equal(inputs.length,326);
for (const a of lib.SPAM_CATEGORIES) for (const b of lib.SPAM_CATEGORIES) inputs.push([a,b,a], [a,a,b,b]);
const cases=[]; for (const categories of inputs) for (const invitation of [false,true]) cases.push({categories,invitation,wire:JSON.stringify(lib.categoryQuestions(categories,invitation))});
const nativeFiles=['src/utils/moderation/spam_categories.rs','src/utils/js_string.rs','tests/moderation_spam_categories.rs','tests/fixtures/moderation_spam_categories_reference.cjs'];
const hashes=Object.fromEntries(nativeFiles.map(f=>[f,sha(read(f))]));
const metadata={format:1,sourceProvenance:leaf.provenance(root,["src/utils/moderation/spam_categories.ts"]),versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version},nodeSha,pins,hashes,compiledSha:sha(compiled.outputText),aliases:ast.statements.filter(ts.isTypeAliasDeclaration).map(s=>s.getText(ast)),interface:iface.getText(ast),constants:{categories:lib.SPAM_CATEGORIES,defaults:lib.DEFAULT_SPAM_CATEGORIES,threshold:lib.DEFAULT_SPAM_THRESHOLD,model:lib.SPAM_CLASSIFIER_MODEL,tags:lib.SPAM_EXEMPT_TAGS,defaultTags:lib.DEFAULT_SPAM_EXEMPT_TAGS,policies:lib.SPAM_CATEGORY_POLICIES},total:cases.length};
const output=JSON.stringify({metadata,cases},null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && extra.length===0,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
const real=fs.realpathSync(dir), workspace=fs.realpathSync(path.join(root,'..')); assert(real!==workspace && !real.startsWith(workspace+path.sep));
const file=path.join(real,'moderation_spam_categories_reference.json'); assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:['moderation_spam_categories_reference.json']);
if(mode==='--write') fs.writeFileSync(file,output,{flag:'wx'}); else assert.equal(fs.readFileSync(file,'utf8'),output);
