// Execute in a private Node 24 process with no credentials or network access.
// --write DIR creates fish-sdk-protocol.json; --check DIR checks it byte-for-byte.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FishAudioClient } from 'fish-audio';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58' || process.versions.icu !== '78.3' || process.versions.tz !== '2026e') throw new Error('unexpected Node/V8/ICU/tz runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, directory] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !directory) throw new Error('usage: fish_sdk_oracle.mjs --write|--check DIR');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const units = s => Array.from({length: s.length}, (_, i) => s.charCodeAt(i));
async function files(dir) {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, dir), {withFileTypes:true})) {
    const p = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(p));
    else if (entry.isFile() && (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('package.json'))) result.push(p);
  }
  return result;
}
const sources = [
  'tests/fixtures/fish_sdk_oracle.mjs', 'package.json', 'package-lock.json',
  ...await files('node_modules/fish-audio/dist/esm'),
  ...await files('node_modules/@msgpack/msgpack/dist.esm'),
  'node_modules/fish-audio/package.json', 'node_modules/@msgpack/msgpack/package.json',
].sort();
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p, hash(await fs.readFile(path.join(root,p)))])));
const provenance = {node:process.version, versions:process.versions, sourceHashes};
const reference = '7b5626abdaa044babfc3829ec15acf31';
const inputs = [
  ['basic', 'hello', reference], ['nul', 'a\0b', reference],
  ['emoji', 'x😀y', reference], ['high-alone', '\ud800', reference],
  ['low-alone', '\udc00', reference], ['high-before-ascii', '\ud800x', reference],
  ['cue-repeat', '[happy] [happy]  [whisper]\t[end]', reference],
  ['unicode-reference', 'hola', 'voz-🎙️-é'],
  ...[49,50,51].flatMap(n => [
    [`units-${n}-high`, 'a'.repeat(n-1)+'\ud800', reference],
    [`units-${n}-pair`, 'a'.repeat(n-2)+'😀', reference],
    [`reference-${n}-high`, 'reference boundary', 'a'.repeat(n-1)+'\ud800'],
    [`reference-${n}-pair`, 'reference boundary', 'a'.repeat(n-2)+'😀'],
  ]),
  ...[31,32,255,256,65535,65536].map(n => [`ascii-bytes-${n}`, 'a'.repeat(n), reference]),
];
let currentCalls = [];
let responseSpec = {status:200, body:new Uint8Array([1,2,3])};
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://api.fish.audio/v1/tts') throw new Error('blocked unexpected fetch URL');
  options.signal?.throwIfAborted();
  const bytes = Buffer.from(options.body);
  currentCalls.push({url:String(url), method:options.method, headers:Object.fromEntries(new Headers(options.headers)), body:{length:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64'),hex:bytes.toString('hex')}});
  const body = typeof responseSpec.body === 'string' ? Buffer.from(responseSpec.body) : responseSpec.body;
  return new Response(body, {status:responseSpec.status, headers:responseSpec.headers});
};
const client = new FishAudioClient({apiKey:'fixture-key'});
async function run(name, text, ref, spec, maxRetries=0) {
  currentCalls = []; responseSpec = spec;
  let outcome;
  try {
    const options = {timeoutInSeconds:20}; if (maxRetries !== null) options.maxRetries = maxRetries;
    const stream = await client.textToSpeech.convert({text,reference_id:ref,format:'mp3'}, 's2.1-pro', options);
    outcome = {audioBase64:Buffer.from(await new Response(stream).arrayBuffer()).toString('base64')};
  } catch (e) {
    // Retain arbitrary JS string code units inside a JSON string literal,
    // including lone surrogates that ordinary UTF-8 fixture readers reject.
    outcome = {name:e.name, message:e.message, statusCode:e.statusCode ?? null, body:e.body === undefined ? {present:false} : {present:true,json:JSON.stringify(e.body)}};
  }
  return {name,textUnits:units(text),referenceUnits:units(ref),request:currentCalls[0] ?? null, calls:currentCalls.length,outcome};
}
const cases = [];
for (const [name,text,ref] of inputs) cases.push(await run(name,text,ref,{status:200,body:new Uint8Array([1,2,3])}));
for (const [name, status, body, headers] of [
  ['error-json',400,'{"error":"bad","count":2}',{'content-type':'application/json'}],
  ['error-json-ordered',400,'{"z":1,"2":"two","1":"one","a":{"y":3,"x":4}}',{'content-type':'application/json'}],
  ['error-json-duplicate-keys',400,'{"z":1,"2":"first","a":2,"2":"last","z":3,"1":"one"}',{'content-type':'application/json'}],
  ['error-json-binary64',400,'{"overflow":1e1000,"negativeOverflow":-1e1000,"tiny":1e-320,"underflow":1e-400,"largeInteger":9007199254740993,"rounded":1.234567890123456789,"small":1e-7,"large":1e21,"negativeZero":-0}',{'content-type':'application/json'}],
  ['error-json-surrogates',400,String.raw`{"high":"\ud800","low":"\udc00","pair":"\ud83d\ude00"}`,{'content-type':'application/json'}],
  ['error-json-null',400,'null',{'content-type':'application/json'}],
  ['error-json-empty',400,'',{'content-type':'application/json'}],
  ['error-json-malformed',400,'{bad',{'content-type':'application/json'}],
  ['error-no-type-malformed',400,'{bad',{}],
  ['error-text-empty',400,'',{'content-type':'text/plain'}],
  ['error-422',422,'{"detail":"bad"}',{'content-type':'application/json'}],
  ['error-429',429,'rate',{'content-type':'text/plain'}],
  ['error-500',500,'upstream',{'content-type':'text/plain'}],
]) cases.push(await run(name,'error',reference,{status,body,headers}));
// Deterministic clock for retry scheduling only, in this private process. The
// SDK's 20-second per-request timer is inert; the fake fetch returns immediately.
const originalTimer = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
const originalNow = Date.now, originalRandom = Math.random;
const retryCases = [];
try {
  let delays = [];
  globalThis.setTimeout = (callback, ms) => { if (ms !== 20000) { delays.push(ms); queueMicrotask(callback); } return {}; };
  globalThis.clearTimeout = () => {};
  Date.now = () => 1_700_000_000_000; Math.random = () => 0.5;
  for (const [name,status,headers] of [
    ['default-408',408,{}], ['default-429',429,{}], ['default-500',500,{}],
    ['retry-after-seconds',429,{'retry-after':'7'}],
    ['retry-after-date',429,{'retry-after':'Tue, 14 Nov 2023 22:13:30 GMT'}],
    ['rate-reset',429,{'x-ratelimit-reset':'1700000010'}],
    ['retry-cap',429,{'retry-after':'600'}],
  ]) {
    delays = [];
    const result = await run(name,'retry',reference,{status,body:'failure',headers},null);
    retryCases.push({name,calls:result.calls,delays,outcome:result.outcome});
  }
} finally { globalThis.setTimeout = originalTimer; globalThis.clearTimeout = originalClear; Date.now = originalNow; Math.random = originalRandom; }
// Observe the actual SDK while an externally aborted caller is in its 60 s
// retry sleep. Fake timers never fire until explicitly released; no real wait.
let pendingBackoff;
try {
  const timers = [];
  globalThis.setTimeout = (callback, ms) => { const timer = {callback,ms,cleared:false}; timers.push(timer); return timer; };
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
  currentCalls = [];
  responseSpec = {status:429,body:'rate',headers:{'retry-after':'60'}};
  const controller = new AbortController();
  let settled = false, outcome;
  const pending = client.textToSpeech.convert({text:'abort during sleep',reference_id:reference,format:'mp3'},'s2.1-pro', {timeoutInSeconds:20,abortSignal:controller.signal})
    .then(() => { settled = true; outcome = {kind:'success'}; }, e => { settled = true; outcome = {kind:'error',name:e.name,message:e.message}; });
  for (let i=0; i<200 && !timers.some(t => t.ms === 60000); i++) await Promise.resolve();
  const backoff = timers.find(t => t.ms === 60000 && !t.cleared);
  if (!backoff) throw new Error('SDK did not schedule expected 60-second retry');
  const requestTimersCleared = timers.filter(t => t.ms === 20000).every(t => t.cleared);
  controller.abort();
  for (let i=0; i<100; i++) await Promise.resolve();
  const settledWhileBackoffPending = settled;
  backoff.callback();
  await pending;
  if (!requestTimersCleared || settledWhileBackoffPending || currentCalls.length !== 1 || outcome?.kind !== 'error' || outcome.message !== 'The user aborted a request') {
    throw new Error('unexpected SDK pending-backoff cancellation behavior');
  }
  pendingBackoff = {backoffMs:backoff.ms,requestTimersCleared,settledWhileBackoffPending,callsCompleted:currentCalls.length,outcome};
} finally { globalThis.setTimeout = originalTimer; globalThis.clearTimeout = originalClear; }
const document = JSON.stringify({schema:1,provenance,cases,retryCases,pendingBackoff},null,2)+'\n';
const target = path.join(directory,'fish-sdk-protocol.json');
if (mode === '--write') { await fs.mkdir(directory,{recursive:true}); await fs.writeFile(target,document); }
else if (await fs.readFile(target,'utf8') !== document) throw new Error('protocol fixture differs');
process.stdout.write(JSON.stringify({schema:1,cases:cases.length,retryCases:retryCases.length,pendingBackoff:true,sourceSha256:sourceHashes['tests/fixtures/fish_sdk_oracle.mjs']})+'\n');
