// Shared actual-source loader. Requiring this module never processes CLI arguments.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const {resolveTtsSource} = require('./tts_source_resolver.cjs');
const root = path.resolve(__dirname, '../..');
const archive = path.resolve(root, '../archives/dimabot-typescript/2026-10-28');
const petDir = path.resolve(root, '../migration-notes/evidence/2026-10-29-tts-tag-types/external-source-api-bc6455f1979f/dimabot/src/pets');
function one(logical) {
  const found = [path.join(root, logical), path.join(archive, logical)].filter(p => fs.existsSync(p));
  if (found.length !== 1 || !fs.statSync(found[0]).isFile()) throw Error(`expected exactly one source for ${logical}`);
  return found[0];
}
function loadSources() {
  if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || ts.version !== '5.9.3') throw Error('wrong oracle toolchain');
  const files = {
    normalizer:resolveTtsSource(root,'src/utils/tts/normalize_tts_message.util.ts'),
    expressive:resolveTtsSource(root,'src/utils/tts/expressive_tts_tags.util.ts'),
    pet:path.join(petDir,'speech_text.ts'), petTest:path.join(petDir,'speech_text.test.ts'),
    creditFallback:one('src/utils/tts/tts_credit_fallback.util.ts'),
    schema:one('src/schemas/channel_tts_settings.schema.ts'),
    voices:resolveTtsSource(root,'src/utils/tts/kokoro_voices.util.ts'),
    resolver:path.join(__dirname,'tts_source_resolver.cjs'), loader:__filename,
    oracle:path.join(__dirname,'tts_lossless_reference.cjs'),
    package:path.join(root,'package.json'), lock:path.join(root,'package-lock.json'),
    typescript:require.resolve('typescript'), typescriptPackage:require.resolve('typescript/package.json'), node:process.execPath,
  };
  const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const hashes = Object.fromEntries(Object.entries(files).map(([key,file]) => [key,sha(file)]));
  if (hashes.pet !== '9a5c1923ef1ceb3e1c454dab4803a589289c04cf1eb954aa3720ca2c163a6561') throw Error('unexpected captured pet helper');
  const sourcePaths = Object.fromEntries(Object.entries(files).map(([key,file]) => [key,path.relative(root,file)]));
  const source = Object.fromEntries(['normalizer','expressive','pet','petTest','creditFallback','schema','voices'].map(k => [k,fs.readFileSync(files[k],'utf8')]));
  const asts = Object.fromEntries(Object.entries(source).map(([k,s]) => [k,ts.createSourceFile(files[k],s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)]));
  function audit(ast) {
    const interfaces = {}, aliases = {}, imports = [], reexports = [], functions = {}, returns = {};
    for (const s of ast.statements) {
      if (ts.isInterfaceDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) interfaces[s.name.text] = s.members.map(m => ({name:m.name.getText(ast),optional:!!m.questionToken,type:m.type?.getText(ast)}));
      if (ts.isTypeAliasDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) aliases[s.name.text] = s.type.getText(ast);
      if (ts.isImportDeclaration(s)) imports.push({module:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,bindings:s.importClause?.getText(ast)});
      if (ts.isExportDeclaration(s)) reexports.push({module:s.moduleSpecifier?.text,typeOnly:s.isTypeOnly,names:s.exportClause?.getText(ast)});
      if (ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) { functions[s.name.text] = s.parameters.map(p => ({name:p.name.getText(ast),type:p.type?.getText(ast),default:p.initializer?.getText(ast)})); returns[s.name.text] = s.type?.getText(ast) ?? null; }
    }
    return {interfaces,aliases,imports,reexports,functions,returns};
  }
  const decl = asts.schema.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []).filter(d => d.name.getText(asts.schema) === 'DEFAULT_TTS_SETTINGS');
  if (decl.length !== 1 || !decl[0].initializer) throw Error('schema default declaration changed');
  source.schemaDefault = `import { DEFAULT_KOKORO_VOICES } from '../utils/tts/kokoro_voices.util.js';\nimport { normalizeExpressiveTtsTags } from '../utils/tts/expressive_tts_tags.util.js';\nexport const DEFAULT_TTS_SETTINGS = ${decl[0].initializer.getText(asts.schema)};`;
  const imports = {
    './expressive_tts_tags.util.js':'expressive', '../utils/tts/expressive_tts_tags.util.js':'expressive',
    '../utils/tts/normalize_tts_message.util.js':'normalizer', './kokoro_voices.util.js':'voices',
    '../utils/tts/kokoro_voices.util.js':'voices', '../../schemas/channel_tts_settings.schema.js':'schemaDefault',
  };
  const cache = {};
  function load(key) {
    if (cache[key]) return cache[key];
    const exports = {}; cache[key] = exports;
    const code = ts.transpileModule(source[key],{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const localRequire = spec => { if (!imports[spec]) throw Error(`forbidden runtime import ${spec} in ${key}`); return load(imports[spec]); };
    vm.runInNewContext(`(function(exports,require){${code}\n})`,{}, {filename:files[key] || key})(exports,localRequire);
    return exports;
  }
  const normalizer = load('normalizer'), pet = load('pet'), expressive = load('expressive'), creditFallback = load('creditFallback');
  const metadata = {exports:{normalizer:Object.keys(normalizer).sort(),pet:Object.keys(pet).sort(),expressive:Object.keys(expressive).sort(),creditFallback:Object.keys(creditFallback).sort()}, ast:{normalizer:audit(asts.normalizer),pet:audit(asts.pet),schema:audit(asts.schema)}};
  return {normalizer,pet,expressive,creditFallback,metadata,provenance:{node:process.version,v8:process.versions.v8,typescript:ts.version,hashes,sourcePaths,loader:'actual TypeScript; schema default selected from its AST; runtime imports allowlisted'}};
}
module.exports = {loadSources};
