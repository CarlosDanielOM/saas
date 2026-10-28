// Run in a disposable directory: node --experimental-vm-modules fish_catalog_reference.mjs --write|--check DIR
// Actual application modules are transpiled once; every case gets a fresh catalog/cache.
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
const [mode, dirArg, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dirArg || extra.length) throw new Error('usage: --write|--check DIR');
const dir = path.resolve(dirArg);
const files = { catalog:'src/server/services/tts/fish_voice_catalog.service.ts', fish:'src/server/services/tts/fish_tts.service.ts' };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k,p]) => [k,await fs.readFile(path.join(root,p),'utf8')])));
const sourceHashes = Object.fromEntries(Object.entries(files).map(([k,p]) => [p,sha(sources[k])]));
sourceHashes['tests/fixtures/fish_catalog_reference.mjs'] = sha(await fs.readFile(fileURLToPath(import.meta.url)));
for (const p of ['package.json','package-lock.json','node_modules/typescript/package.json']) sourceHashes[p] = sha(await fs.readFile(path.join(root,p)));
sourceHashes['node_modules/typescript/lib/typescript.js'] = sha(await fs.readFile(require.resolve('typescript')));
sourceHashes['node-executable'] = sha(await fs.readFile(process.execPath));
const compiled = Object.fromEntries(Object.entries(sources).map(([k,s]) => [k,ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText]));
const synthetic = entries => new vm.SyntheticModule(Object.keys(entries), function () { for (const [k,v] of Object.entries(entries)) this.setExport(k,v); });
const forbidden = () => { throw new Error('forbidden fixture dependency'); };
const imports = {
  'fs/promises':synthetic({default:{mkdir:forbidden,writeFile:forbidden}}), 'path':synthetic({default:{join:forbidden,dirname:forbidden}}),
  'fish-audio':synthetic({FishAudioClient:forbidden}),
  '../../../utils/ai/openrouter/app_attribution.util.js':synthetic({OPENROUTER_APP_HEADERS:{}}),
  '../../../utils/tts/expressive_tts_tags.util.js':synthetic({reinforceFishTtsTags:forbidden}),
  '../../../utils/tts/tts_deadline.util.js':synthetic({readAudioStream:forbidden}),
  './piper_tts.service.js':synthetic({PIPER_PUBLIC_SPEECH_DIR:'forbidden',buildPublicPath:forbidden}),
};
const fish = new vm.SourceTextModule(compiled.fish,{identifier:files.fish});
await fish.link(spec => { if (!imports[spec]) throw new Error(`blocked import ${spec}`); return imports[spec]; });
await fish.evaluate();
async function freshCatalog() {
  const catalog = new vm.SourceTextModule(compiled.catalog,{identifier:files.catalog});
  await catalog.link(spec => { if (spec !== './fish_tts.service.js') throw new Error(`blocked import ${spec}`); return fish; });
  await catalog.evaluate();
  return catalog.namespace;
}
const id = '0123456789abcdef0123456789abcdef';
const voice = overrides => ({_id:id,title:'Fixture',type:'tts',visibility:'public',...overrides});
const defs = [];
const add = (name,operation,input,options={}) => defs.push({name,operation,input,...options});
for (const [name,value] of [['default',null],['empty',''],['alias','gojo'],['alias-space','  gojo  '],['alias-case','Gojo'],['unknown','missing'],['hex-upper',id.toUpperCase()],['hex-space',` ${id} `],['hex-short',id.slice(1)],['hex-bad',`${id.slice(0,31)}g`]]) add(`resolve-${name}`,'resolve',value);
for (const ending of ['\n','\r','\u2028','\u2029','\r\n']) add(`resolve-end-${ending.split('').map(c=>c.charCodeAt(0).toString(16)).join('-')}`,'resolve',id+ending);
for (const [name,value] of Object.entries({defaults:{},trim:{name:'  hello  ',gender:'female',language:'en',license:'licensed',page:'005'},name100:{name:'x'.repeat(100)},name101:{name:'x'.repeat(101)},emoji50:{name:'😀'.repeat(50)},emoji51:{name:'😀'.repeat(51)},lone:{name:'a\ud800'},page1:{page:'1'},page50:{page:'50'},page0:{page:'0'},page51:{page:'51'},pageHuge:{page:'9'.repeat(400)},pageArray:{page:['1']},genderArray:{gender:['female']},genderObject:{gender:{}},nameNumber:{name:1},nameNull:{name:null},pageNull:{page:null},pageDecimal:{page:'1.0'},pageSpace:{page:' 1'},badGender:{gender:'Female'},badLang:{language:'EN'},badLicense:{license:'true'}})) add(`parse-${name}`,'parse',value);
for (const ending of ['\n','\r','\u2028','\u2029','\r\n']) add(`parse-page-end-${ending.charCodeAt(0).toString(16)}-${ending.length}`,'parse',{page:'1'+ending});
for (const [name,value] of Object.entries({null:null,array:[],missing:{},valid:voice({}),upper:voice({_id:id.toUpperCase()}),badId:voice({_id:'abc'}),badTitle:voice({title:3}),wrongType:voice({type:'svc'}),private:voice({visibility:'private'}),dmca:voice({dmca_taken_down:true}),dmcaString:voice({dmca_taken_down:'true'}),failed:voice({state:'failed'}),retired:voice({pvc_release_state:'retired'}),cuts:voice({title:'a'.repeat(199)+'😀z',description:'  '+'b'.repeat(299)+'😀z  ',samples:[{audio:`https://platform.r2.fish.audio/task/${id}.mp3`,text:' '+'c'.repeat(399)+'😀z ' }]}),languages:voice({languages:['en',3,null,'es','EN','en']}),gender:voice({tags:['Male','FEMALE','english','Spanish','Warm','warm','Kind','x','a-b','two words','z'.repeat(24),'z'.repeat(25),'calm','bright','soft','deep','fast','slow']}),coercion:voice({tags:[null,1,true,['calm'],['a','b'],[[],['Calm']],{}, {toString:3}]}),coercionValid:voice({tags:[null,1,true,['calm'],['a','b'],[[],['Calm']],{}]}),cover:voice({cover_image:`coverimage/${id.toUpperCase()}`}),coverBad:voice({cover_image:`coverimage/${id}/../x`}),sample:voice({samples:[null,{audio:'http://bad'},{audio:`https://platform.r2.fish.audio/tasks/2024-01-02/${id}.OPUS`,text:' hi '}] }),sampleBad:voice({samples:[{audio:`https://platform.r2.fish.audio/task/${id}.mp3?x=1`}]}),negativeZero:voice({task_count:-0}),fraction:voice({task_count:19.9}),negative:voice({task_count:-1}),huge:voice({task_count:1e21}),infinity:voice({task_count:Infinity}),nan:voice({task_count:NaN})})) add(`normalize-${name}`,'normalize',value, name === 'infinity' ? {inputRaw:JSON.stringify(voice({task_count:'REPLACE'})).replace('"REPLACE"','1e400')} : name === 'nan' ? {special:'nan'} : name === 'negativeZero' ? {inputRaw:JSON.stringify(voice({task_count:'REPLACE'})).replace('"REPLACE"','-0')} : {});
for (const ending of ['\n','\r','\u2028','\u2029','\r\n']) {
 const label=ending.split('').map(c=>c.charCodeAt(0).toString(16)).join('-');
 for (const [kind,patch] of Object.entries({id:{_id:id+ending},cover:{cover_image:`coverimage/${id}${ending}`},sample:{samples:[{audio:`https://platform.r2.fish.audio/task/${id}.mp3${ending}`}]},style:{tags:['calm'+ending]}})) add(`normalize-${kind}-end-${label}`,'normalize',voice(patch));
}
for (const [name,cover] of Object.entries({prefix:`/coverimage/${id}`,query:`coverimage/${id}?a`,suffix:`coverimage/${id}x`,unicode:`coverimage/${id.slice(0,31)}K`})) add(`cover-${name}`,'normalize',voice({cover_image:cover}));
for (const [name,audio] of Object.entries({http:`http://platform.r2.fish.audio/task/${id}.mp3`,host:`https://platform.r2.fish.audio.evil/task/${id}.mp3`,user:`https://evil@platform.r2.fish.audio/task/${id}.mp3`,fragment:`https://platform.r2.fish.audio/task/${id}.mp3#x`,date:`https://platform.r2.fish.audio/task/9999-99-99/${id}.wav`,badDate:`https://platform.r2.fish.audio/task/24-1-1/${id}.wav`,doubleSlash:`https://platform.r2.fish.audio/task//${id}.mp3`})) add(`sample-${name}`,'normalize',voice({samples:[{audio,text:'sample'}]}));
const success = value => ({status:200,bodyJson:JSON.stringify(value)});
add('get-valid','get',id,{responses:[success(voice({}))]});
add('get-invalid','get','bad');
add('get-id-final-lf','get',id+'\n');
add('get-ineligible','get',id,{responses:[success(voice({visibility:'private'}))]});
add('get-404','get',id,{responses:[{status:404,bodyJson:'{}'}]});
add('get-500','get',id,{responses:[{status:500,bodyJson:'{}'}]});
add('get-missing-key','get',id,{key:false});
add('get-fetch-reject','get',id,{responses:[{transport:'reject'}]});
add('get-invalid-json','get',id,{responses:[{status:200,bodyJson:'{' }]});
add('get-body-reject','get',id,{responses:[{status:200,bodyReject:true}]});
const search = (overrides={}) => ({name:'',gender:'all',language:'all',license:'all',page:1,...overrides});
add('search-filter','search',search({name:'😀\ud800 &+',gender:'female',language:'en',license:'licensed',page:2}),{responses:[success({items:[voice({tags:['female'],languages:['en'],licensed:true}),voice({tags:['male'],languages:['en'],licensed:true}),voice({tags:['female'],languages:['es'],licensed:true}),voice({tags:['female'],languages:['en'],licensed:false}),null],has_more:true,total:100})]});
add('search-unlicensed','search',search({license:'unlicensed'}),{responses:[success({items:[voice({licensed:false}),voice({licensed:true}),voice({})],total:'21'})]});
for (const [name,body] of Object.entries({empty:{items:[]},hasNull:{items:[],has_more:null,total:'21'},hasFalse:{items:[],has_more:false,total:100},hasString:{items:[],has_more:'odd'},hasZero:{items:[],has_more:0},totalArray:{items:[],total:['21']},totalObject:{items:[],total:{}},invalid:{items:{}},null:null})) add(`search-${name}`,'search',search(),{responses:[success(body)]});
add('search-page50','search',search({page:50}),{responses:[success({items:[],has_more:true,total:9999})]});
// Sequence steps are independent calls on one source cache, with a fake millisecond clock.
add('cache-hit-expiry-refresh','sequence',[
 {op:'get',input:id,time:0},{op:'get',input:id,time:1,key:false},{op:'get',input:id,time:59999},{op:'get',input:id,time:60000},{op:'get',input:id,time:60001}
],{responses:[success(voice({title:'first'})),success(voice({title:'second'}))]});
const cacheSteps = Array.from({length:100},(_,i)=>({op:'get',input:i.toString(16).padStart(32,'0'),time:0}));
cacheSteps.push({op:'get',input:'00000000000000000000000000000063',time:60000},{op:'get',input:'00000000000000000000000000000000',time:60001},{op:'get',input:'00000000000000000000000000000063',time:60001});
add('cache-fifo-expired-existing-at-capacity','sequence',cacheSteps,{responses:[...Array.from({length:100},(_,i)=>success(voice({_id:i.toString(16).padStart(32,'0')}))),success(voice({_id:'00000000000000000000000000000063',title:'refreshed'})),success(voice({_id:'00000000000000000000000000000000',title:'refetched'}))]});
const oldFetch = globalThis.fetch, oldNow = Date.now, oldKey = process.env.FISH_AUDIO_API_KEY;
let now = 0, requests = [], replies = [], blocked = false;
Date.now = () => now;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!(target.startsWith('https://api.fish.audio/model/') || target.startsWith('https://api.fish.audio/model?'))) { blocked = true; throw new Error('blocked unexpected fetch URL'); }
  const spec = replies.shift();
  if (!spec) { blocked = true; throw new Error('unexpected fixture request'); }
  const record = {url:target,method:options.method ?? 'GET',headers:Object.fromEntries(new Headers(options.headers)),signalAborted:options.signal?.aborted ?? null,bodyCancelled:false};
  requests.push(record);
  if (spec.transport === 'reject') throw new TypeError('fixture transport rejected');
  const body = new ReadableStream({
    start(controller) { if (spec.bodyReject) controller.error(new Error('fixture body rejected')); else { controller.enqueue(new TextEncoder().encode(spec.bodyJson ?? '')); controller.close(); } },
    cancel() { record.bodyCancelled = true; },
  });
  return new Response(body,{status:spec.status,headers:{'content-type':'application/json'}});
};
const result = async fn => {
  try { return {ok:true,value:await fn()}; }
  catch (error) { return {ok:false,error:{name:error.name,status:error.status,code:error.code,message:error.message}}; }
};
try {
  const cases = [];
  for (const def of defs) {
    const api = await freshCatalog();
    now = 0; requests = []; replies = [...(def.responses ?? [])]; blocked = false;
    if (def.key === false) delete process.env.FISH_AUDIO_API_KEY; else process.env.FISH_AUDIO_API_KEY = ' fixture-key ';
    const inputJson = def.inputRaw ?? JSON.stringify(def.input);
    const input = JSON.parse(inputJson);
    if (def.special === 'nan') input.task_count = NaN;
    let outcome;
    if (def.operation === 'resolve') outcome = await result(() => api.resolveFishVoice(input));
    else if (def.operation === 'parse') outcome = await result(() => api.parseVoiceSearch(input));
    else if (def.operation === 'normalize') outcome = await result(() => api.normalizeFishVoice(input));
    else if (def.operation === 'get') outcome = await result(() => api.getFishVoice(input));
    else if (def.operation === 'search') outcome = await result(() => api.searchFishVoices(input));
    else {
      outcome = [];
      for (const step of input) {
        now = step.time;
        if (step.key === false) delete process.env.FISH_AUDIO_API_KEY; else process.env.FISH_AUDIO_API_KEY = ' fixture-key ';
        outcome.push(await result(() => api.getFishVoice(step.input)));
      }
    }
    if (blocked || replies.length) throw new Error(`unexpected/unused fetch in ${def.name}`);
    cases.push({name:def.name,operation:def.operation,inputJson,...(def.special ? {special:def.special} : {}),configuration:{key:def.key !== false},responses:def.responses ?? [],requests,outcomeJson:JSON.stringify(outcome)});
  }
  const doc = JSON.stringify({schema:1,provenance:{node:process.version,versions:process.versions,sourceHashes,injection:'same-realm transpiled actual catalog and Fish voice constants; blocked external dependencies; controlled fetch, fixture key and fake Date.now'},cases},null,2)+'\n';
  const target = path.join(dir,'fish-catalog-reference.json');
  if (mode === '--write') { await fs.mkdir(dir,{recursive:true}); await fs.writeFile(target,doc); }
  else if (await fs.readFile(target,'utf8') !== doc) throw new Error('application fixture differs');
  process.stdout.write(JSON.stringify({schema:1,cases:cases.length,sourceSha256:sourceHashes['tests/fixtures/fish_catalog_reference.mjs']})+'\n');
} finally {
  globalThis.fetch = oldFetch; Date.now = oldNow;
  if (oldKey === undefined) delete process.env.FISH_AUDIO_API_KEY; else process.env.FISH_AUDIO_API_KEY = oldKey;
}
