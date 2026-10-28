// node --experimental-vm-modules tts_credit_fallback_reference.mjs --write|--check DISPOSABLE_DIR
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw new Error('unexpected Node/V8 runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const [mode, arg, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !arg || extra.length) throw new Error('usage: --write|--check DISPOSABLE_DIR');
const files = {helper:'src/utils/tts/tts_credit_fallback.util.ts', schema:'src/schemas/channel_tts_settings.schema.ts', filter:'src/utils/tts/expressive_tts_tags.util.ts', voices:'src/utils/tts/kokoro_voices.util.ts'};
const archiveRoot = path.resolve(root, '../archives/dimabot-typescript/2026-10-28');
const exists = async file => {
 try { await fs.access(file); return true; }
 catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const helperPaths = [path.join(root, files.helper), path.join(archiveRoot, files.helper)];
const helperPresence = await Promise.all(helperPaths.map(exists));
if (helperPresence.filter(Boolean).length !== 1) throw new Error('credit fallback helper must exist at exactly one source or archive path');
const resolvedPaths = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, key === 'helper' ? helperPaths[helperPresence.indexOf(true)] : path.join(root, file)]));
const sourcePaths = Object.fromEntries(Object.entries(resolvedPaths).map(([key, file]) => [files[key], path.relative(root, file)]));
const sources = Object.fromEntries(await Promise.all(Object.entries(resolvedPaths).map(async ([key, file]) => [key, await fs.readFile(file,'utf8')])));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const hashes = Object.fromEntries(Object.entries(files).map(([key,file]) => [file,hash(sources[key])]));
for (const file of ['package.json','package-lock.json','node_modules/typescript/package.json']) hashes[file] = hash(await fs.readFile(path.join(root,file)));
hashes['node_modules/typescript/lib/typescript.js'] = hash(await fs.readFile(require.resolve('typescript')));
hashes['node-executable'] = hash(await fs.readFile(process.execPath));
hashes['tests/fixtures/tts_credit_fallback_reference.mjs'] = hash(await fs.readFile(fileURLToPath(import.meta.url)));
const compile = source => ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
// Evaluate the actual schema initializer with its actual pure dependencies. Parsing
// selects the declaration AST; no schema constructor, Mongoose import or DB runs.
const ast = ts.createSourceFile(files.schema,sources.schema,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const declarations = ast.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []).filter(d => d.name.getText(ast) === 'DEFAULT_TTS_SETTINGS');
if (declarations.length !== 1 || !declarations[0].initializer) throw new Error('schema default declaration changed');
const schemaSource = `import { DEFAULT_KOKORO_VOICES } from '../utils/tts/kokoro_voices.util.js';\nimport { normalizeExpressiveTtsTags } from '../utils/tts/expressive_tts_tags.util.js';\nexport const DEFAULT_TTS_SETTINGS = ${declarations[0].initializer.getText(ast)};`;
const modules = {filter:new vm.SourceTextModule(compile(sources.filter)), voices:new vm.SourceTextModule(compile(sources.voices)), schema:new vm.SourceTextModule(compile(schemaSource)), helper:new vm.SourceTextModule(compile(sources.helper))};
const imports = {'../../schemas/channel_tts_settings.schema.js':modules.schema, './expressive_tts_tags.util.js':modules.filter, './kokoro_voices.util.js':modules.voices, '../utils/tts/kokoro_voices.util.js':modules.voices, '../utils/tts/expressive_tts_tags.util.js':modules.filter};
await modules.helper.link(spec => { if (!imports[spec]) throw new Error(`forbidden import ${spec}`); return imports[spec]; });
await modules.helper.evaluate();
const cases = [];
const units = s => Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const base = {mode:'clone',text:' [happy] Hi <sad> 😀\ud800 x [a\udc00b] ',provider:'fish',model:'model',language:'en',voice:'fish',cloneName:'clone',piperFallbackVoice:'',kokoroFallbackVoice:'', extra:{nested:[1,'context']}};
function add(name, patch, status, tier) {
 const input = {...base,...patch};
 const output = modules.helper.namespace.resolveTtsForCreditStatus(input,status,tier);
 const snap = value => ({...value,text:undefined,voice:undefined,piperFallbackVoice:undefined,kokoroFallbackVoice:undefined,textUnits:units(value.text),voiceUnits:units(value.voice),piperFallbackUnits:value.piperFallbackVoice === undefined ? null : units(value.piperFallbackVoice),kokoroFallbackUnits:value.kokoroFallbackVoice === undefined ? null : units(value.kokoroFallbackVoice)});
 cases.push({name,status,tier:tier ?? null,input:snap(input),output:snap(output),same:input === output,outputJson:JSON.stringify(output)});
}
for (const provider of ['piper','fish','kokoro']) for (const status of ['available','exhausted','unavailable']) for (const tier of [undefined,'premium','pro','free','Premium']) for (const language of ['en','es']) for (const mode of ['speak','ai','clone']) add(`${provider}-${status}-${tier}-${language}-${mode}`,{provider,language,mode},status,tier);
for (const [name,patch,status,tier] of [
 ['kokoro-current',{provider:'kokoro',voice:' AF_BELLA ',kokoroFallbackVoice:'ef_dora'},'exhausted','pro'],
 ['kokoro-fallback',{voice:'af_bella',kokoroFallbackVoice:' AM_MICHAEL '},'exhausted','premium'],
 ['kokoro-invalid',{provider:'kokoro',voice:'\ud800',kokoroFallbackVoice:'\udc00'},'exhausted','pro'],
 ['piper-whitespace',{piperFallbackVoice:'  \ud800  '},'unavailable','pro'],
 ['no-fallbacks',{piperFallbackVoice:undefined,kokoroFallbackVoice:undefined},'exhausted','pro'],
 ['boundaries',{text:' \ud800  <happy>  \udc00 [x\ud800y] z '},'unavailable',undefined],
]) add(name,patch,status,tier);
const doc = JSON.stringify({schema:1,provenance:{node:process.version,v8:process.versions.v8,installedTypeScript:ts.version,hashes,sourcePaths,loader:'actual source modules and AST-selected schema initializer; forbidden other imports'},cases},null,2)+'\n';
const target = path.join(path.resolve(arg),'tts-credit-fallback-reference.json');
if (mode === '--write') { await fs.mkdir(path.resolve(arg),{recursive:true}); await fs.writeFile(target,doc); }
else if (await fs.readFile(target,'utf8') !== doc) throw new Error('source fixture differs');
process.stdout.write(JSON.stringify({cases:cases.length})+'\n');
