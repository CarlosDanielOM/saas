// Private disposable Node fixture: --experimental-vm-modules --write|--check ABSOLUTE_DIR
// This oracle executes the application TS; the Fish SDK transport is deliberately mocked.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw Error('unexpected Node/V8');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const {resolveTtsSource} = require('./tests/fixtures/tts_source_resolver.cjs');
const ts = require('typescript');
if (ts.version !== '5.9.3') throw Error('unexpected TypeScript');
const [mode, dir, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dir || !path.isAbsolute(dir) || extra.length) throw Error('usage: --write|--check ABSOLUTE_DIR');
const files = {
  piper: 'src/server/services/tts/piper_tts.service.ts',
  kokoro: 'src/server/services/tts/kokoro_tts.service.ts',
  fish: 'src/server/services/tts/fish_tts.service.ts',
  catalog: 'src/server/services/tts/fish_voice_catalog.service.ts',
  deadline: 'src/utils/tts/tts_deadline.util.ts',
  tags: 'src/utils/tts/expressive_tts_tags.util.ts',
  voices: 'src/utils/tts/kokoro_voices.util.ts',
  attribution: 'src/utils/ai/openrouter/app_attribution.util.ts',
  polyfills: 'src/utils/pollyfills.ts',
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const resolvedPaths = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, /src\/utils\/tts\/(expressive_tts_tags|kokoro_voices)\.util\.ts$/.test(p) ? resolveTtsSource(root, p) : path.join(root, p)]));
const sourcePaths = Object.fromEntries(Object.entries(files).map(([k, p]) => [p, path.relative(root, resolvedPaths[k])]));
const sources = Object.fromEntries(await Promise.all(Object.entries(resolvedPaths).map(async ([k, p]) => [k, await fs.readFile(p, 'utf8')])));
const hashes = Object.fromEntries(Object.entries(files).map(([k, p]) => [p, sha(sources[k])]));
for (const p of ['tests/fixtures/tts_runtime_dynamic_reference.mjs', 'tests/fixtures/tts_source_resolver.cjs', 'package.json', 'package-lock.json', 'node_modules/typescript/package.json']) hashes[p] = sha(await fs.readFile(path.join(root, p)));
hashes['typescript-implementation'] = sha(await fs.readFile(require.resolve('typescript')));
hashes['node-executable'] = sha(await fs.readFile(process.execPath));
const compiled = Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText]));
const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const input = { text: 'Hello chat!', voice: 'af_heart', channelID: 'channel 1', speechID: 'id+1', outputPath: '/fixture/private/output', privateOutput: false };

async function run(name) {
  const values = { OPENROUTER_API_KEY: ' primary-key ', FISH_AUDIO_API_KEY: ' old-fish-key ', PUBLIC_API_URL: 'http://old.test', PIPER_HTTP_URL: 'http://before.test', PIPER_PYTHON_BIN: 'old-python', PIPER_DATA_DIR: 'old-data' };
  const reads = [], requests = [], processes = [], writes = [], mkdirs = [], sdk = [];
  const env = new Proxy(values, { get(target, key) { if (typeof key === 'string') reads.push(key); return target[key]; } });
  const fixturePath = p => { if (typeof p !== 'string' || !p.startsWith('/fixture/')) throw Error(`blocked path ${p}`); };
  const fakeFs = {
    async mkdir(p) {
      fixturePath(p); mkdirs.push(p);
      if (name.startsWith('piper-')) {
        values.PIPER_HTTP_URL = name === 'piper-cli' ? '///' : ' ///';
        values.PIPER_PYTHON_BIN = ' literal python ';
        values.PIPER_DATA_DIR = '  fixture-data  ';
      }
    },
    async writeFile(p, data) { fixturePath(p); writes.push({ path: p, hex: Buffer.from(data).toString('hex') }); },
    async stat(p) { fixturePath(p); return { size: 3 }; },
    async rm(p) { fixturePath(p); },
  };
  const stream = (changeUrl = false) => new ReadableStream({ start(controller) { if (changeUrl) values.PUBLIC_API_URL = 'http://new.test///'; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
  class FishAudioClient {
    constructor({ apiKey }) { sdk.push({ apiKey }); this.textToSpeech = { convert: async (args, backend, options) => { sdk[0].convert = { args, backend, timeoutInSeconds: options.timeoutInSeconds }; return stream(true); } }; }
  }
  const spawn = (command, args) => {
    processes.push({ command, args });
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const fetch = async (url, options = {}) => {
    const target = String(url);
    if (!(target === 'https://openrouter.ai/api/v1/audio/speech' || target === ' /synthesize' || target.startsWith('https://api.fish.audio/model/'))) throw Error(`blocked fetch ${target}`);
    requests.push({ url: target, method: options.method ?? 'GET', authorization: new Headers(options.headers).get('authorization'), body: options.body ? JSON.parse(options.body) : null });
    if (target.startsWith('https://api.fish.audio/model/')) {
      const voiceId = target.slice(target.lastIndexOf('/') + 1);
      return new Response(JSON.stringify({ _id: voiceId, title: 'Fixture', type: 'tts', visibility: 'public' }), { status: 200 });
    }
    if (name.startsWith('fish-')) { values.FISH_AUDIO_API_KEY = ' fresh-fish-key '; return new Response('', { status: 400 }); }
    if (name === 'piper-http') return new Response('fixture failure', { status: 400 });
    return new Response(stream(true), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const context = vm.createContext({ process: { env }, Buffer, AbortController, AbortSignal, URLSearchParams, ReadableStream, setTimeout, clearTimeout, fetch });
  const synthetic = entries => new vm.SyntheticModule(Object.keys(entries), function () { for (const [k, v] of Object.entries(entries)) this.setExport(k, v); }, { context });
  const modules = Object.fromEntries(Object.entries(compiled).map(([k, code]) => [k, new vm.SourceTextModule(code, { context, identifier: files[k], initializeImportMeta(meta) { meta.url = 'file:///fixture/dist/server/services/tts/source.js'; } })]));
  const imports = {
    'fs/promises': synthetic({ default: fakeFs }), 'node:fs/promises': synthetic({ default: fakeFs }),
    path: synthetic({ default: path, dirname: path.dirname }), 'node:path': synthetic({ default: path }),
    url: synthetic({ fileURLToPath }), child_process: synthetic({ spawn }), 'fish-audio': synthetic({ FishAudioClient }),
    '../../../utils/pollyfills.js': modules.polyfills, '../../../utils/tts/tts_deadline.util.js': modules.deadline,
    '../../../utils/tts/expressive_tts_tags.util.js': modules.tags, '../../../utils/tts/kokoro_voices.util.js': modules.voices,
    '../../../utils/ai/openrouter/app_attribution.util.js': modules.attribution,
    './piper_tts.service.js': modules.piper, './fish_tts.service.js': modules.fish,
  };
  const entry = name.startsWith('fish-') ? modules.fish : name.startsWith('piper-') ? modules.piper : name.startsWith('kokoro-') ? modules.kokoro : modules.catalog;
  await entry.link(spec => { if (!imports[spec]) throw Error(`blocked import ${spec}`); return imports[spec]; });
  await entry.evaluate();
  let outcome;
  if (name === 'catalog-sequence') {
    const first = await entry.namespace.getFishVoice(id);
    delete values.FISH_AUDIO_API_KEY;
    const hit = await entry.namespace.getFishVoice(id);
    values.FISH_AUDIO_API_KEY = ' catalog-next ';
    const miss = await entry.namespace.getFishVoice(otherId);
    outcome = [first, hit, miss];
  } else {
    if (name === 'kokoro-missing') delete values.OPENROUTER_API_KEY;
    const req = { ...input, voice: name.startsWith('fish-') ? 'voice' : input.voice, singleAttempt: name === 'fish-single', privateOutput: name === 'piper-cli' };
    const service = name.startsWith('fish-') ? entry.namespace.fishTtsService : name.startsWith('kokoro-') ? entry.namespace.kokoroTtsService : entry.namespace.piperTtsService;
    outcome = await service.synthesize(req);
  }
  return JSON.parse(JSON.stringify({ name, reads, requests, processes, writes, mkdirs, sdk, outcome }));
}
const cases = [];
for (const name of ['fish-fallback', 'fish-single', 'kokoro-success', 'kokoro-missing', 'piper-cli', 'piper-http', 'catalog-sequence']) cases.push(await run(name));
const output = JSON.stringify({ schema: 1, provenance: { node: process.versions.node, v8: process.versions.v8, typescript: ts.version, hashes, sourcePaths, mocks: 'per-case isolated environment and VM; fake fixture-only filesystem, spawn and allowlisted fetch; synthetic Fish SDK constructor/convert and controlled audio stream (SDK transport not exercised)', projection: 'environment read names, fixture request bodies/auth, SDK constructor and convert, output and file operations; no timestamps' }, cases }, null, 2) + '\n';
const target = path.join(dir, 'tts_runtime_dynamic_reference.json');
if (mode === '--write') { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(target, output); }
else { const actual = await fs.readFile(target, 'utf8'); if (!actual || actual !== output) throw Error('dynamic fixture missing, empty or differs'); }
