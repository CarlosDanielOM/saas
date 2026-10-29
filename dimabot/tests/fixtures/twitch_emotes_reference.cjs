// Actual-source oracle. Run only in the isolated pinned Node fixture environment:
// node twitch_emotes_reference.cjs --write DIR | --check DIR
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const FIXED_NOW_MILLIS = Date.parse('2026-10-29T12:00:00.000Z');
const files = {
  channel: path.join(root, 'src/utils/twitch_emotes.ts'),
  names: path.join(root, 'src/utils/tts/emote_names.util.ts'),
  oracle: __filename, package: path.join(root, 'package.json'),
  lock: path.join(root, 'package-lock.json'), typescript: require.resolve('typescript'),
  typescriptPackage: require.resolve('typescript/package.json'), node: process.execPath,
};
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function provenance() {
  if (process.version !== 'v24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || ts.version !== '5.9.3') throw Error('wrong oracle toolchain');
  return {node:process.version, v8:process.versions.v8, typescript:ts.version,
    paths:Object.fromEntries(Object.entries(files).map(([k,p]) => [k, k === 'node' ? '<node executable>' : path.relative(root,p)])),
    hashes:Object.fromEntries(Object.entries(files).map(([k,p]) => [k,sha(p)])),
    boundaries:'Actual TypeScript modules transpiled with pinned TypeScript; Date, cache connection/get/set, app headers, URL builder and fetch are fixture mocks, not native adapter evidence.'};
}
function harness(spec) {
  const calls = [], values = new Map(Object.entries(spec.cache || {}));
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [spec.now])); } static now() { return spec.now; } }
  const cache = {
    async get(key) { calls.push(['get',key]); if (spec.getFail) throw Error('get'); return values.get(key) ?? null; },
    async set(key,value,options) { calls.push(['set',key,value,options.EX]); if (spec.setFail) throw Error('set'); values.set(key,value); },
  };
  const getDragonflyClient = async () => { if (spec.connectFail) throw Error('connect'); return cache; };
  const getTwitchAppHeader = async () => { calls.push(['header']); if (spec.headerFail) throw Error('header'); return {'Client-Id':'fixture','Authorization':'Bearer fixture'}; };
  const getTwitchHelixUrl = (endpoint, query) => `https://fixture.invalid/${endpoint}${query ? `?${query}` : ''}`;
  const fetch = async url => { calls.push(['fetch',url]); if (spec.gate) await spec.gate; if (spec.fetchFail) throw Error('fetch'); return {ok:spec.ok !== false, json:async () => { if (spec.jsonFail) throw Error('json'); return Object.hasOwn(spec,'body') ? spec.body : {data:[]}; }}; };
  const exportsByName = {};
  function load(name) {
    if (exportsByName[name]) return exportsByName[name];
    const exports = {}; exportsByName[name] = exports;
    const code = ts.transpileModule(fs.readFileSync(files[name],'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const requireLocal = id => {
      if (id.endsWith('dragonfly.database.js')) return {getDragonflyClient};
      if (id.endsWith('header.js')) return {getTwitchAppHeader};
      if (id.endsWith('links.js')) return {getTwitchHelixUrl};
      if (id === '../twitch_emotes.js') return load('channel');
      throw Error(`unexpected import ${id}`);
    };
    vm.runInNewContext(`(function(exports,require){${code}\n})`,{Date:Clock,fetch,AbortSignal,URLSearchParams},{filename:files[name]})(exports,requireLocal);
    return exports;
  }
  return {channel:load('channel'), names:load('names'), calls};
}
async function fixture() {
  const cases = [], now = FIXED_NOW_MILLIS, key = 'twitch:123:emote-catalog:v1';
  async function run(id, spec, operation, argument) {
    const h = harness({now,...spec});
    const result = operation === 'channel' ? await h.channel.getChannelEmoteCatalog(argument) : await h.names.getTtsEmoteNames(argument);
    cases.push({id,spec,operation,argument,result,calls:h.calls});
  }
  for (const id of ['', '123', '1\n', '123\r', '１２', '0'.repeat(30), '0'.repeat(31)]) await run(`channel-id-${JSON.stringify(id)}`,{},'channel',id);
  for (const id of ['abc','a\n','a\r','a\u2028','a\u2029','', 'x'.repeat(64), 'x'.repeat(65), 'é']) await run(`emote-id-${JSON.stringify(id)}`,{body:{data:[{id,name:'name'}]}},'channel','123');
  for (const age of [-1,0,3599999,3600000,86399999,86400000]) {
    const checkedAt = new Date(now-age).toISOString();
    const cache = {[key]:JSON.stringify({emotes:[{id:'x',name:'\ud800'}],checkedAt,retryAt:now+1})};
    await run(`age-${age}`,{cache},'channel','123');
  }
  for (const checkedAt of [null,'','0','12/31/2020',0,true,[],[2020],{},'invalid']) {
    const cache = {[key]:JSON.stringify({emotes:[{id:'x',name:'old'}],checkedAt,retryAt:now+1})};
    await run(`date-${JSON.stringify(checkedAt)}`,{cache},'channel','123');
  }
  for (const [id,row] of Object.entries({
    extra:{emotes:[{id:'ok',name:'cached'.repeat(20),extra:'preserved'}],checkedAt:new Date(now).toISOString(),retryAt:now+1,extra:'ignored'},
    maxCached:{emotes:Array.from({length:2000},(_,i)=>({id:`x${i}`,name:'n'})),checkedAt:new Date(now).toISOString(),retryAt:now+1},
    excessCached:{emotes:Array.from({length:2001},()=>({id:'x',name:'n'})),checkedAt:new Date(now).toISOString(),retryAt:now+1},
    due:{emotes:[{id:'old',name:'old'}],checkedAt:new Date(now-3600000).toISOString(),retryAt:now},
    malformedRetry:{emotes:[],checkedAt:null,retryAt:'123'},
  })) await run(`cached-${id}`,{cache:{[key]:JSON.stringify(row)},body:{data:[{id:'new',name:'new'}]}},'channel','123');
  await run('http-2000',{body:{data:Array.from({length:2000},(_,i)=>({id:`x${i}`,name:'n'}))}},'channel','123');
  for (const [id,spec] of Object.entries({nullBody:{body:null}, primitiveBody:{body:42}, stringBody:{body:'text'}, malformed:{body:{data:[null]}}, oversized:{body:{data:Array.from({length:2001},()=>({id:'x',name:'x'}))}},
    trunc:{body:{data:[{id:'x',name:'a'.repeat(63)+'😀\ud800'}]}}, corrupt:{cache:{[key]:'{'}},
    fetchFail:{fetchFail:true}, headerFail:{headerFail:true}, nonOk:{ok:false}, getFail:{getFail:true}, setFail:{setFail:true}, connectFail:{connectFail:true}})) await run(id,spec,'channel','123');
  for (const [id,age] of [['ready',100],['stale',3600000],['expired',86400000]]) {
    const cache = {[key]:JSON.stringify({emotes:[{id:'prior',name:'prior'}],checkedAt:new Date(now-age).toISOString(),retryAt:now})};
    await run(`failure-previous-${id}`,{cache,ok:false},'channel','123');
  }
  for (const [id,spec,arg] of [['global-empty-cache',{cache:{'twitch:global:tts:emotes':'["","\\ud800"]'}},''],
    ['merge',{body:{data:[{id:'x',name:'a'},{id:'y',name:'\ud800'},{id:'z',name:'a'}]}},'123'],
    ['global-filter-and-order',{body:{data:[{name:'a'},{name:''},{name:'b'},{name:'a'},{name:3},{name:'\ud800'}]}},''],
    ['global-cache-dedup',{cache:{'twitch:global:tts:emotes':'["a","a","b",""]'}},''],
    ['global-corrupt',{cache:{'twitch:global:tts:emotes':'{'},body:{data:[{name:'never'}]}},''],
    ['global-null-body',{body:null},''], ['global-primitive-body',{body:42},''], ['global-null-item',{body:{data:[null]}},''], ['global-get-fail',{getFail:true},''], ['global-set-fail',{setFail:true},'']]) await run(id,spec,'names',arg);
  // The shared promise must be removed after resolution so a later call can
  // retry. Use a held fetch rather than timing or artificial sleeps.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({now,gate,fetchFail:true});
  const first = h.channel.getChannelEmoteCatalog('123');
  const second = h.channel.getChannelEmoteCatalog('123');
  const samePromise = first === second;
  release();
  const results = await Promise.all([first,second]);
  await h.channel.getChannelEmoteCatalog('123');
  cases.push({id:'singleflight-cleanup',samePromise,results,calls:h.calls});
  return {schema:1,fixedNowMillis:FIXED_NOW_MILLIS,provenance:provenance(),cases};
}
async function main() {
  const [mode,dir,...extra] = process.argv.slice(2);
  if (!['--write','--check'].includes(mode) || !dir || extra.length) throw Error('usage: --write DIR | --check DIR');
  const output = JSON.stringify(await fixture(),null,2)+'\n';
  const dest = path.join(dir,'twitch_emotes_cases.json');
  if (mode === '--write') { fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(dest,output); }
  else if (fs.readFileSync(dest,'utf8') !== output) throw Error('fixture differs');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {fixture};
