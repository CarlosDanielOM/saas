// Run only inside the task-owned fixture container: node ... <owned-directory>.
// Executes only the two specified TypeScript sources and allowlisted imports.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('typescript');
const dir = process.argv[2];
if (!dir || !path.isAbsolute(dir)) throw new Error('absolute fixture directory required');
fs.mkdirSync(dir, { recursive: true });
const root = path.resolve(__dirname, '../..');
function sourcePath(name) {
 const live = path.join(root, name);
 return !fs.existsSync(live) && name.startsWith('src/')
  ? path.resolve(root, '../archives/dimabot-typescript/2026-10-28', name) : live;
}
function source(name) {
  const filename = sourcePath(`src/utils/tts/${name}.util.ts`);
  let text = fs.readFileSync(filename, 'utf8');
  // This utility's sole createRequire call imports exactly mp3-duration.
  text = text.replace("createRequire(import.meta.url)('mp3-duration')", "require('mp3-duration')");
  const compiled = ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  const allowed = new Set(['node:fs/promises', 'node:module', 'node:path', 'mp3-duration']);
  const module = {exports: {}};
  const restricted = (id) => { if (!allowed.has(id)) throw Error(`unexpected import ${id}`); return require(id); };
  vm.runInNewContext(`(function(exports,require,module){${compiled}\n})`, {Buffer})(module.exports, restricted, module);
  return module.exports;
}
function wav(rate, length) {
 const b = Buffer.alloc(44); b.write('RIFF',0); b.write('WAVE',8); b.write('data',36); b.writeUInt32LE(rate,28); b.writeUInt32LE(length,40); return b;
}
function mp3(n) { const f = Buffer.alloc(417); Buffer.from([255,251,144,100]).copy(f); return Buffer.concat(Array(n).fill(f)); }
// Fixed bitrate index 9: MPEG 1 L1/L2/L3 = 288/160/128 kbps;
// MPEG 2/2.5 L1/L2/L3 = 144/80/80 kbps. Vary version, layer,
// sample rate and padding using correctly sized header-only synthetic frames.
function mpeg(version, layer, rateIndex, padding, count) {
 const rates = {3:[44100,48000,32000],2:[22050,24000,16000],0:[11025,12000,8000]};
 const bitrate = version === 3 ? ({3:288,2:160,1:128})[layer] : ({3:144,2:80,1:80})[layer];
 const samples = layer === 3 ? 384 : layer === 1 && version !== 3 ? 576 : 1152;
 const length = Math.trunc(samples * bitrate * 125 / rates[version][rateIndex] + padding * (layer === 3 ? 4 : 1));
 const frame = Buffer.alloc(length); frame.set([0xff,0xe1 | (version << 3) | (layer << 1), 0x90 | (rateIndex << 2) | (padding << 1),0]);
 return Buffer.concat(Array(count).fill(frame));
}
(async () => {
 const api = source('tts_playback_timeout');
 const frames = mp3(100);
 const id3 = Buffer.concat([Buffer.from('49443304001000000000','hex'), Buffer.alloc(10), frames]);
 const incomplete = Buffer.concat([mp3(2), Buffer.from([255,251,144,100,0,0,0,0,0,0])]);
 const asciiHigh = wav(44100,44100); for (const i of [0,1,2,3,8,9,10,11,36,37,38,39]) asciiHigh[i] |= 0x80;
 const invalidWav = wav(100,100); invalidWav.write('LIST',36);
 const invalidId3 = Buffer.concat([Buffer.from('49443304000080000000','hex'), frames]);
 const files = {'normal.wav': wav(44100,66150), 'long.WAV': wav(32000,2880001), 'ascii-high.wav': asciiHigh,
  'bad.wav': Buffer.from('RIFF'), 'zero-rate.wav': wav(0,100), 'invalid-wav.wav': invalidWav,
  'normal.mp3': frames, 'id3-footer.mp3': id3, 'invalid-id3.mp3': invalidId3,
  'id3v1.mp3': Buffer.concat([frames,Buffer.from('TAG'),Buffer.alloc(125)]),
  'invalid-sync.mp3': Buffer.concat([Buffer.alloc(103,0xff),frames]),
  'incomplete.mp3': incomplete, 'tiny.mp3': Buffer.alloc(99), 'other.ogg': frames};
 for (const version of [0,2,3]) for (const layer of [1,2,3]) for (const rate of [0,1,2])
  files[`mpeg-${version}-${layer}-${rate}.mp3`] = mpeg(version, layer, rate, rate % 2, 8);
 // Free and reserved bitrate indices map to zero bitrate in mp3-duration.
 // Sparse headers keep every candidate independently visible to its scanner.
 for (const layer of [1,3]) for (const bitrateIndex of [0,15]) for (const padding of [0,1]) {
  const bytes = Buffer.alloc(128);
  for (let offset = 0; offset < 112; offset += 16)
   bytes.set([0xff,0xe1 | (3 << 3) | (layer << 1), (bitrateIndex << 4) | (padding << 1),0],offset);
  files[`mpeg-1-layerbits${layer}-bitrate${bitrateIndex}-padding${padding}.mp3`] = bytes;
 }
 // npm's published MIT-licensed test fixtures are copied only into the owned
 // disposable fixture directory; include the accompanying license.
 const packageDir = path.dirname(require.resolve('mp3-duration'));
 files['npm-cbr.mp3'] = fs.readFileSync(path.join(packageDir,'tests/demo - cbr.mp3'));
 files['npm-vbr.mp3'] = fs.readFileSync(path.join(packageDir,'tests/demo - vbr.mp3'));
 fs.copyFileSync(path.join(packageDir,'LICENSE'),path.join(dir,'mp3-duration-LICENSE'));
 const cases = [];
 for (const [name, bytes] of Object.entries(files)) { const file = path.join(dir,name); fs.writeFileSync(file,bytes); cases.push({name, duration: await api.getAudioFileDurationMs(file), timeout: await api.getTtsPlaybackTimeoutMs(file)}); }
 const missing = path.join(dir, 'missing.wav');
 assert.ok(!fs.existsSync(missing), 'fixture directory must not contain missing.wav');
 cases.push({name:'missing.wav', duration:await api.getAudioFileDurationMs(missing), timeout:await api.getTtsPlaybackTimeoutMs(missing)});
 fs.writeFileSync(path.join(dir,'tts_session_playback_cases.json'), JSON.stringify(cases));
 const tracked = ['src/utils/tts/tts_session.util.ts', 'src/utils/tts/tts_playback_timeout.util.ts', 'node_modules/mp3-duration/index.js', 'node_modules/mp3-duration/package.json'];
 const sourceHashes = Object.fromEntries(tracked.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(sourcePath(name))).digest('hex')]));
 const fixtureHashes = Object.fromEntries(cases.filter(c => fs.existsSync(path.join(dir,c.name))).map(c => [c.name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,c.name))).digest('hex')]));
 fs.writeFileSync(path.join(dir,'tts_session_playback_sources.json'), JSON.stringify({sourceHashes,fixtureHashes},null,2)+'\n');
 if (process.env.DIMA_RUST_TEST_RESOURCE_OWNER !== 'dimabot-migration') return;
 const url = new URL(process.env.DIMA_TEST_REDIS_URL || '');
 assert.equal(url.protocol,'redis:'); assert.ok(['keyword-redis','redis','localhost','127.0.0.1','[::1]'].includes(url.hostname)); assert.equal(url.username,''); assert.equal(url.password,'');
 const {createClient} = require('redis'); const client = createClient({url:url.href, socket:{connectTimeout:3000,reconnectStrategy:false}}); await client.connect();
 const session = source('tts_session'); const channel = `tts-oracle-${crypto.randomUUID()}`; const prefix = `twitch:${channel}:tts:`;
 try {
  await session.enqueueTtsSession(client,channel,'a',2,JSON.stringify({speechID:'a'}));
  assert.equal((await session.popTtsSession(client,channel)).session,null);
  await session.enqueueTtsSession(client,channel,'peeked',20,'{}');
  let crossed = false;
  const competing = {zRange: async (...args) => { const ids = await client.zRange(...args); if (!crossed) { crossed = true; await session.enqueueTtsSession(client,channel,'minimum',1,'{}'); } return ids; }, eval: client.eval.bind(client)};
  assert.equal((await session.popTtsSession(competing,channel)).value,'minimum');
  await client.set(prefix+'processing','active'); await client.set(prefix+'queue:data:active','{}');
  const delayed = {eval: async (script, options) => { const result = await client.eval(script,options); if (script.includes('DIMA032_RESET')) { await session.enqueueTtsSession(client,channel,'peeked',1,'{}'); await session.enqueueTtsSession(client,channel,'late',2,'{}'); } return result; }};
  await session.resetTtsSession(delayed,channel,'new',[]);
  assert.equal(await client.get(prefix+'queue:data:active'),null);
  const item = await session.popTtsSession(client,channel); assert.equal(item.value,'peeked'); assert.equal(item.session,'new'); assert.equal(JSON.parse(item.payload).queueSession,'new');
  assert.equal((await session.popTtsSession(client,channel)).value,'late');
  let attempts = 0;
  assert.equal(await session.popTtsSession({zRange: async () => ['old'], eval: async () => { attempts++; return ['retry']; }},channel),null);
  assert.equal(attempts,8);
 } finally { const keys = await client.keys(prefix+'*'); if(keys.length) await client.del(keys); await client.quit(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
