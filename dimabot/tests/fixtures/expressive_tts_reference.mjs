// Run only in the isolated, pinned Node environment:
// node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --write|--check DIR
// DIR must be outside the source checkout. Expected values come from actual TS exports.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw new Error('unexpected Node/V8 runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const {resolveTtsSource} = require('./tests/fixtures/tts_source_resolver.cjs');
const ts = require('typescript');
const [mode, dirArg, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dirArg || extra.length) throw new Error('usage: --write|--check DIR');
const dir = path.resolve(dirArg);
const relative = path.relative(root, dir);
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('fixture directory must be outside source checkout');
const files = {
  expressive: 'src/utils/tts/expressive_tts_tags.util.ts',
  kokoro: 'src/utils/tts/kokoro_voices.util.ts',
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const resolvedPaths = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, /src\/utils\/tts\/(expressive_tts_tags|kokoro_voices)\.util\.ts$/.test(p) ? resolveTtsSource(root, p) : path.join(root, p)]));
const sourcePaths = Object.fromEntries(Object.entries(files).map(([k, p]) => [p, path.relative(root, resolvedPaths[k])]));
const sources = Object.fromEntries(await Promise.all(Object.entries(resolvedPaths).map(async ([k, p]) => [k, await fs.readFile(p, 'utf8')])));
const sourceHashes = Object.fromEntries(Object.entries(files).map(([k, p]) => [p, sha(sources[k])]));
sourceHashes['tests/fixtures/expressive_tts_reference.mjs'] = sha(await fs.readFile(fileURLToPath(import.meta.url)));
for (const p of ['tests/fixtures/tts_source_resolver.cjs', 'package.json', 'package-lock.json', 'node_modules/typescript/package.json']) sourceHashes[p] = sha(await fs.readFile(path.join(root, p)));
sourceHashes['node_modules/typescript/lib/typescript.js'] = sha(await fs.readFile(require.resolve('typescript')));
sourceHashes['node-executable'] = sha(await fs.readFile(process.execPath));
const context = vm.createContext({});
async function load(key) {
  const compiled = ts.transpileModule(sources[key], {compilerOptions:{module:ts.ModuleKind.ES2022, target:ts.ScriptTarget.ES2022}}).outputText;
  const module = new vm.SourceTextModule(compiled, {context, identifier:files[key]});
  await module.link(spec => { throw new Error(`unexpected import ${spec}`); });
  await module.evaluate();
  return module.namespace;
}
const ex = await load('expressive');
const ko = await load('kokoro');
const tags = Array.from(ex.EXPRESSIVE_TTS_TAGS);
const groups = Object.entries(ex.EXPRESSIVE_TTS_TAG_GROUPS).map(([name, items]) => ({name, tags:Array.from(items)}));
const voices = Array.from(ko.KOKORO_VOICES);
// Type-only exports disappear at runtime; inspect declarations in the actual TS AST.
const typeExports = ts.createSourceFile(files.expressive, sources.expressive, ts.ScriptTarget.ES2022, true).statements
  .filter(node => ts.isTypeAliasDeclaration(node) && node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword))
  .map(node => node.name.text).sort();
if (tags.length !== 75 || groups.length !== 4 || voices.length !== 54) throw new Error('source catalog size changed; review fixture contract');
const aliases = ['anger','whispering','laughing','crying','sighing','loud','chuckling','gasping','soft tone','crying loudly','in a hurry tone','break','long-break','crowd laughing'];
const units = text => Array.from({length:text.length}, (_, i) => text.charCodeAt(i));
const stringResult = text => ({units:units(text), wire:JSON.stringify(text)});
const cases = [];
const addFilter = (name, text, provider, enabled) => {
  const options = {provider};
  if (enabled !== undefined) options.enabledTags = enabled;
  cases.push({name, op:'filter', inputUnits:units(text), provider, ...(enabled === undefined ? {} : {enabledJson:JSON.stringify(enabled)}), expected:stringResult(ex.filterExpressiveTtsTags(text, options))});
};
const addReinforce = (name, text) => cases.push({name, op:'reinforce', inputUnits:units(text), expected:stringResult(ex.reinforceFishTtsTags(text))});
const addNormalize = (name, inputJson) => {
  const expected = ex.normalizeExpressiveTtsTags(JSON.parse(inputJson));
  cases.push({name, op:'normalize', inputJson, expected, expectedWire:JSON.stringify(expected)});
};
const addVoice = (name, inputJson) => cases.push({name, op:'voice', inputJson, expected:ko.resolveKokoroVoice(JSON.parse(inputJson))});
cases.push({name:'default-options', op:'filter', inputUnits:units(' before [happy] <sad> after '), provider:'piper', expected:stringResult(ex.filterExpressiveTtsTags(' before [happy] <sad> after '))});
const allTrue = Object.fromEntries(tags.map(t => [t, true]));
const allFalse = Object.fromEntries(tags.map(t => [t, false]));
const partial = {happy:true, angry:false, whisper:true, 'long-pause':true, laugh:1, cry:'true', shouting:null};
for (const [i, tag] of [...tags, ...aliases].entries()) {
  for (const provider of ['piper','fish','kokoro']) for (const [setting, enabled] of [['absent',undefined],['true',allTrue],['false',allFalse],['partial',partial]]) {
    addFilter(`catalog-${i}-${provider}-${setting}`, `before <${tag}>[${tag}]</${tag}> after`, provider, enabled);
  }
}
for (const [name, text] of Object.entries({
  angle:' < HAPPY > < / long - pause > <long- pause> <long -pause> < /  whisper > ',
  brackets:'a[unknown]b[[happy]]c[]d[HAPPY]e[happy][sad]f',
  nested:'<happy <sad>> [happy[sad]happy] <not-a-tag> <> <happy_foo> </ happy> <123>',
  mixed:'  [whispering] <ANGER> [long - break] <long - break> [soft tone] [happy]  ',
  casefold:'[K] [ſoft] [HAPPİ] [Σ] <K> <ſoft> [AF_HEART] [HAPPY]',
  controls:'\0[happy]\t[cry]\n<angry>\r\nend',
  surrogateBefore:'\ud800[happy]', surrogateInside:'[ha\ud800ppy] <ha\udc00ppy>',
  surrogateBetween:'[happy]\ud800[happy]', surrogateAfter:'[happy]\udc00',
  surrogateRepeated:'[happy] \ud800 [happy] [happy]', astral:'😀[happy]💜<sad>😀',
  empty:'', justSpaces:' \t\n\ufeff ', repeated:'[happy][happy] [happy] [sad]',
})) for (const provider of ['piper','fish','kokoro']) for (const [setting, enabled] of [['absent',undefined],['all',allTrue],['partial',partial]]) addFilter(`${name}-${provider}-${setting}`, text, provider, enabled);
const whitespace = [0x0009,0x000a,0x000b,0x000c,0x000d,0x0020,0x00a0,0x1680,...Array.from({length:11},(_,i)=>0x2000+i),0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff];
for (const ws of whitespace) {
  const c = String.fromCharCode(ws);
  addFilter(`whitespace-${ws.toString(16)}`, `${c}<${c}/${c}happy${c}>${c}[${c}HAPPY${c}]${c}<long${c}-${c}pause>${c}`, 'fish', allTrue);
  addReinforce(`repeat-whitespace-${ws.toString(16)}`, `[happy]${c}[happy]${c}[sad]`);
}
for (const [i,tag] of tags.entries()) {
  addReinforce(`reinforce-single-${i}`, `x[${tag}]y`);
  addReinforce(`reinforce-repeated-${i}`, `[${tag}] [${tag}] [${tag}]`);
}
for (const [name,text] of Object.entries({unknown:'[unknown] [HAPPY] [happy] [happy] [sad]', embedded:'[[happy]] [happy][sad] [laugh]x[laugh]', loneBefore:'\ud800[happy]', loneInside:'[ha\ud800ppy]', loneBetween:'[happy]\ud800[happy]', loneAfter:'[happy]\udc00', loneRepeat:'[happy] [happy]\ud800[happy]', astral:'😀[happy]😀', whitespace:'[happy]\t[happy]  [sad]\n[sad]', empty:''})) addReinforce(name,text);
for (const [name, value] of Object.entries({null:null, empty:{}, array:[], number:42, string:'x', bool:false, direct:{happy:false,sad:true,angry:0,whisper:'false',cry:null}, legacy:{inline:{happy:false,longPause:false},wrapping:{sad:false,longPause:true}}, precedence:{happy:null,sad:'no',angry:false,inline:{happy:null,sad:false,angry:true,longPause:null},wrapping:{happy:false,sad:false,angry:true,longPause:false}}, masks:{happy:0,sad:'',angry:[],cry:{},inline:{happy:false,sad:false,angry:false,cry:false},wrapping:{happy:false}}, weirdContainers:{inline:'x',wrapping:[false]}, legacyKey:{'long-pause':null,inline:{'long-pause':false,longPause:true},wrapping:{longPause:false}}})) addNormalize(name, JSON.stringify(value));
for (const tag of tags) {
  const key = tag === 'long-pause' ? 'longPause' : tag;
  for (const [kind, value] of [
    ['direct-false', {[tag]:false}],
    ['null-fallback', {[tag]:null, inline:{[key]:null}, wrapping:{[key]:false}}],
    ['nonboolean-mask', {[tag]:0, inline:{[key]:false}}],
    ['lone-mask', {[tag]:'\ud800', inline:{[key]:false}}],
  ]) addNormalize(`catalog-${kind}-${tag}`, JSON.stringify(value));
}
addNormalize('unknown-lone-key-and-duplicate', '{"\\ud800":false,"unknown":false,"happy":true,"happy":false}');
addNormalize('lone-string-masks', '{"happy":"\\ud800","inline":{"happy":false,"sad":"\\udc00"},"wrapping":{"sad":false}}');
for (const voice of voices) for (const [variant, value] of [['exact',voice],['case',voice.toUpperCase()],['trim',` \t${voice}\ufeff`]]) addVoice(`voice-${variant}-${voice}`,JSON.stringify(value));
for (const [name,value] of Object.entries({empty:'',unknown:'af_unknown',partial:'af_',lone:'af_heart\ud800', kelvin:'aK_heart', dotted:'AF_İEART', sigma:'σ', astral:'😀', null:null, number:123, false:false, object:{voice:'af_heart'}, array:['af_heart']})) addVoice(`voice-${name}`,JSON.stringify(value));
for (const ws of whitespace) addVoice(`voice-whitespace-${ws.toString(16)}`, JSON.stringify(`${String.fromCharCode(ws)}AF_HEART${String.fromCharCode(ws)}`));
for (const value of ['af_Kore', '\u0085af_heart', '\u180eaf_heart', '\u200baf_heart']) addVoice(`voice-casefold-boundary-${cases.length}`,JSON.stringify(value));
const document = {schema:1, provenance:{node:process.version, v8:process.versions.v8, sourceHashes, sourcePaths, boundary:'actual transpiled TypeScript in isolated VM; JSON.parse values without executable hooks/prototypes; typed providers and arbitrary UTF-16 text'}, metadata:{expressiveExports:Object.keys(ex).sort(), kokoroExports:Object.keys(ko).sort(), groups, tags, typeExports, voices, defaults:ko.DEFAULT_KOKORO_VOICES, aliases}, cases};
const output = JSON.stringify(document,null,2)+'\n';
const target = path.join(dir,'expressive-tts-reference.json');
if (mode === '--write') { await fs.mkdir(dir,{recursive:true}); await fs.writeFile(target,output); }
else if (await fs.readFile(target,'utf8') !== output) throw new Error('actual-source fixture differs');
process.stdout.write(JSON.stringify({schema:1,cases:cases.length,sourceSha256:sourceHashes['tests/fixtures/expressive_tts_reference.mjs']})+'\n');
