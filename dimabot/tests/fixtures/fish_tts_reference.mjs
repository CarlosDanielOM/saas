// Private disposable Node process only; --experimental-vm-modules is required.
// Transpile allowlisted application TS into same-realm modules. No app bootstrapping.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FishAudioClient } from 'fish-audio';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || process.versions.icu !== '78.3' || process.versions.tz !== '2026e') throw new Error('unexpected Node/V8/ICU/tz runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root,'package.json'));
const ts = require('typescript');
const [mode, dirArg] = process.argv.slice(2);
if (!['--write','--check'].includes(mode) || !dirArg) throw new Error('usage: node --experimental-vm-modules fish_tts_reference.mjs --write|--check DIR');
const dir = path.resolve(dirArg);
const publicRoot = path.join(dir,'audio-public');
const privateRoot = path.join(dir,'audio-private');
const files = {
  fish:'src/server/services/tts/fish_tts.service.ts', piper:'src/server/services/tts/piper_tts.service.ts',
  tags:'src/utils/tts/expressive_tts_tags.util.ts', deadline:'src/utils/tts/tts_deadline.util.ts',
  attribution:'src/utils/ai/openrouter/app_attribution.util.ts',
  interface:'src/server/services/tts/tts_provider.interface.ts',
};
const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k,p]) => [k,await fs.readFile(path.join(root,p),'utf8')])));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sourceHashes = Object.fromEntries(Object.entries(files).map(([k,p]) => [p,sha(sources[k])]));
sourceHashes['tests/fixtures/fish_tts_reference.mjs'] = sha(await fs.readFile(fileURLToPath(import.meta.url)));
for (const p of ['package.json','package-lock.json','node_modules/fish-audio/package.json','node_modules/@msgpack/msgpack/package.json','node_modules/typescript/package.json']) sourceHashes[p] = sha(await fs.readFile(path.join(root,p)));
const synthetic = entries => new vm.SyntheticModule(Object.keys(entries), function() { for (const [key,value] of Object.entries(entries)) this.setExport(key,value); });
const modules = {};
for (const [key,source] of Object.entries(sources)) modules[key] = new vm.SourceTextModule(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText,{identifier:files[key],initializeImportMeta(meta) { meta.url = 'file:///fixture/source.js'; }});
const imports = {
  'fs/promises':synthetic({default:fs}), 'path':synthetic({default:path}),
  'child_process':synthetic({spawn:() => {throw new Error('Piper CLI forbidden');}}),
  'fish-audio':synthetic({FishAudioClient}),
  '../../../utils/pollyfills.js':synthetic({getDirname:() => path.join(dir,'piper-source')}),
  '../../../utils/tts/tts_deadline.util.js':modules.deadline,
  '../../../utils/tts/expressive_tts_tags.util.js':modules.tags,
  '../../../utils/ai/openrouter/app_attribution.util.js':modules.attribution,
};
await modules.piper.link(specifier => { if (!imports[specifier]) throw new Error(`blocked import ${specifier}`); return imports[specifier]; });
await modules.piper.evaluate();
// Only the filesystem root is injected; use the actual Piper public URL function.
imports['./piper_tts.service.js'] = synthetic({PIPER_PUBLIC_SPEECH_DIR:publicRoot,buildPublicPath:modules.piper.namespace.buildPublicPath});
await modules.fish.link(specifier => { if (!imports[specifier]) throw new Error(`blocked import ${specifier}`); return imports[specifier]; });
await modules.fish.evaluate();
let calls = [], replies = [];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!['https://api.fish.audio/v1/tts','https://openrouter.ai/api/v1/audio/speech'].includes(target)) throw new Error('blocked unexpected fetch URL');
  const body = typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('base64');
  calls.push({url:target,method:options.method,headers:Object.fromEntries(new Headers(options.headers)),body,bodyEncoding:typeof options.body === 'string' ? 'utf8' : 'base64'});
  const spec = replies.shift(); if (!spec) throw new Error('unexpected extra fixture request');
  return new Response(spec.body, {status:spec.status,headers:spec.headers});
};
const audio = {status:200,body:new Uint8Array([1,2,3]),headers:{'content-type':'audio/mpeg'}};
const bad = {status:400,body:'private upstream details',headers:{'content-type':'text/plain'}};
const fixtures = [
  {name:'primary',text:'Hello [happy] 😀',replies:[audio]},
  {name:'fallback-cues',text:'[happy] hello [whisper] [whisper]  [sad] 😀\ud800',replies:[bad,audio]},
  {name:'single-attempt',text:'hi',singleAttempt:true,replies:[bad]},
  {name:'missing-openrouter',text:'hi',openrouter:false,replies:[audio]},
  {name:'missing-both',text:'hi',openrouter:false,fish:false,replies:[]},
  {name:'primary-mime',text:'hi',singleAttempt:true,replies:[{status:200,body:'x',headers:{'content-type':'text/plain'}}]},
  {name:'primary-empty',text:'hi',singleAttempt:true,replies:[{status:200,body:'',headers:{'content-type':'audio/mpeg'}}]},
  {name:'primary-null',text:'hi',singleAttempt:true,replies:[{status:204,body:null,headers:{'content-type':'audio/mpeg'}}]},
  {name:'fallback-error-json',text:'hi',replies:[bad,{status:400,body:'{"detail":"bad"}',headers:{'content-type':'application/json'}}]},
  {name:'byte-limit',text:'hi',singleAttempt:true,maxAudioBytes:2,replies:[audio]},
  {name:'public-path',text:'hi',privateOutput:false,channelID:'a b',speechID:'x?#',replies:[audio]},
];
const envNames = ['OPENROUTER_API_KEY','FISH_AUDIO_API_KEY','PUBLIC_API_URL','NODE_ENV'];
const previous = Object.fromEntries(envNames.map(k => [k,process.env[k]]));
const cases = [];
try {
  process.env.PUBLIC_API_URL = 'https://fixture.invalid/base///'; process.env.NODE_ENV = 'test';
  await fs.mkdir(privateRoot,{recursive:true});
  for (const f of fixtures) {
    if (f.openrouter === false) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = ' fixture-openrouter-key ';
    if (f.fish === false) delete process.env.FISH_AUDIO_API_KEY; else process.env.FISH_AUDIO_API_KEY = ' fixture-fish-key ';
    calls = []; replies = [...f.replies];
    const input = {text:f.text,voice:'  voice-id  ',channelID:f.channelID ?? 'channel',speechID:f.speechID ?? f.name,outputPath:path.join(privateRoot,`${f.name}.mp3`),privateOutput:f.privateOutput !== false,singleAttempt:f.singleAttempt,maxAudioBytes:f.maxAudioBytes};
    const result = await modules.fish.namespace.fishTtsService.synthesize(input);
    const outputPath = result.outputPath;
    const output = outputPath ? (await fs.readFile(outputPath)).toString('base64') : null;
    const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(dir,'<fixture-dir>'));
    const configuration = {openrouterEnabled:f.openrouter !== false,fishEnabled:f.fish !== false,publicApiUrl:process.env.PUBLIC_API_URL};
    const responses = f.replies.map(reply => ({status:reply.status,headers:reply.headers ?? {},bodyBase64:reply.body === null ? null : Buffer.from(reply.body).toString('base64'),bodyHex:reply.body === null ? null : Buffer.from(reply.body).toString('hex')}));
    const fixtureInput = normalize({...input,text:undefined,voice:undefined});
    fixtureInput.textUnits = Array.from({length:input.text.length},(_,i) => input.text.charCodeAt(i));
    fixtureInput.voiceUnits = Array.from({length:input.voice.length},(_,i) => input.voice.charCodeAt(i));
    cases.push({name:f.name,input:fixtureInput,configuration,responses,requests:calls,outcome:normalize(result),files:output === null ? [] : [{path:outputPath.replace(dir,'<fixture-dir>'),base64:output,hex:Buffer.from(output,'base64').toString('hex')}]});
  }
  const publicPathCases = [['a b','x?#'],['😀','a/b'],['\ud800','x']].map(([channel,speech]) => {
    const input={channelUnits:Array.from({length:channel.length},(_,i)=>channel.charCodeAt(i)),speechUnits:Array.from({length:speech.length},(_,i)=>speech.charCodeAt(i))};
    try {return {...input,result:modules.piper.namespace.buildPublicPath(channel,speech)};} catch (e) {return {...input,error:{name:e.name,message:e.message}};}
  });
  const doc = JSON.stringify({schema:1,provenance:{node:process.version,versions:process.versions,sourceHashes,injection:'same-realm transpiled TS; Piper public root only; controlled fetch; fixture-only keys'},cases,publicPathCases},null,2)+'\n';
  const target = path.join(dir,'fish-tts-reference.json');
  if (mode === '--write') {await fs.mkdir(dir,{recursive:true}); await fs.writeFile(target,doc);}
  else if (await fs.readFile(target,'utf8') !== doc) throw new Error('application fixture differs');
  process.stdout.write(JSON.stringify({schema:1,cases:cases.length,publicPathCases:publicPathCases.length,sourceSha256:sourceHashes['tests/fixtures/fish_tts_reference.mjs']})+'\n');
} finally {
  for (const key of envNames) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
}
