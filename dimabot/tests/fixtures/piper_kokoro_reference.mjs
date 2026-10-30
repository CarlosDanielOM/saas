// Run only in a disposable, explicitly supplied fixture directory.
// node --experimental-vm-modules piper_kokoro_reference.mjs --write|--check DIR
// The application sources are transpiled once into same-realm VM modules. Neither
// network access nor a real Piper process is permitted by this harness.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw new Error('unexpected Node/V8 runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const {resolveTtsSource} = require('./tests/fixtures/tts_source_resolver.cjs');
// Retired OpenRouter app-attribution helper: one allowlisted archive reader.
const attribution = require('./tests/fixtures/openrouter_attribution_source.cjs').resolveSource(root);
const [mode, dirArg, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dirArg || extra.length) throw new Error('usage: --write|--check DIR');
const dir = path.resolve(dirArg);
// All application writes are beneath this fixture-owned directory. Never point it
// at production or a shared directory. Case names are fixed by this script.
const sourceDir = path.join(dir, 'source/server/services/tts');
const publicRoot = path.join(dir, 'source/server/routes/public/speech');
const privateRoot = path.join(dir, 'private');
const files = {
  piper: 'src/server/services/tts/piper_tts.service.ts',
  kokoro: 'src/server/services/tts/kokoro_tts.service.ts',
  voices: 'src/utils/tts/kokoro_voices.util.ts',
  deadline: 'src/utils/tts/tts_deadline.util.ts',
  attribution: 'src/utils/ai/openrouter/app_attribution.util.ts',
  interface: 'src/server/services/tts/tts_provider.interface.ts',
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const resolvedPaths = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, /src\/utils\/tts\/(expressive_tts_tags|kokoro_voices)\.util\.ts$/.test(p) ? resolveTtsSource(root, p) : p === attribution.logical ? attribution.path : path.join(root, p)]));
const sourcePaths = Object.fromEntries(Object.entries(files).map(([k, p]) => [p, path.relative(root, resolvedPaths[k])]));
const sources = Object.fromEntries(await Promise.all(Object.entries(resolvedPaths).map(async ([k, p]) => [k, await fs.readFile(p, 'utf8')])));
const sourceHashes = Object.fromEntries(Object.entries(files).map(([k, p]) => [p, sha(sources[k])]));
sourceHashes['tests/fixtures/piper_kokoro_reference.mjs'] = sha(await fs.readFile(fileURLToPath(import.meta.url)));
for (const p of ['tests/fixtures/tts_source_resolver.cjs', 'tests/fixtures/openrouter_attribution_source.cjs', 'package.json', 'package-lock.json', 'node_modules/typescript/package.json']) sourceHashes[p] = sha(await fs.readFile(path.join(root, p)));
const synthetic = entries => new vm.SyntheticModule(Object.keys(entries), function () { for (const [k, v] of Object.entries(entries)) this.setExport(k, v); });
const modules = {};
for (const [k, source] of Object.entries(sources)) modules[k] = new vm.SourceTextModule(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText, { identifier: files[k], initializeImportMeta(meta) { meta.url = 'file:///fixture/source.js'; } });
let processes = [], processSpec;
function spawn(command, args, options) {
  if (!processSpec) throw new Error('unexpected fixture spawn');
  const spec = processSpec;
  processSpec = null;
  const record = { command, args: [...args], stdinHex: null, stdout: 'ignored', signal: options.signal ? { aborted: options.signal.aborted } : null, timeoutMs: options.timeout, stdio: options.stdio, stderrHex: Buffer.from(spec.stderr ?? '').toString('hex'), event: spec.event };
  processes.push(record);
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(async () => {
    try {
      if (spec.stderr) child.stderr.emit('data', Buffer.from(spec.stderr));
      if (spec.event === 'error') child.emit('error', new Error(spec.message));
      else {
        if (spec.event === 'success') await fs.writeFile(args[args.indexOf('-f') + 1], Buffer.from(spec.audioHex, 'hex'));
        child.emit('close', spec.event === 'success' ? 0 : spec.code);
      }
    } catch (error) { child.emit('error', error); }
  });
  return child;
}
const imports = {
  'fs/promises': synthetic({ default: fs }), 'node:fs/promises': synthetic({ default: fs }),
  'path': synthetic({ default: path }), 'node:path': synthetic({ default: path }),
  'child_process': synthetic({ spawn }),
  '../../../utils/pollyfills.js': synthetic({ getDirname: () => sourceDir }),
  '../../../utils/tts/tts_deadline.util.js': modules.deadline,
  '../../../utils/tts/kokoro_voices.util.js': modules.voices,
  '../../../utils/ai/openrouter/app_attribution.util.js': modules.attribution,
};
const linker = specifier => { if (!imports[specifier]) throw new Error(`blocked import ${specifier}`); return imports[specifier]; };
await modules.piper.link(linker);
await modules.piper.evaluate();
imports['./piper_tts.service.js'] = modules.piper;
await modules.kokoro.link(linker);
await modules.kokoro.evaluate();

let requests = [], replies = [];
const allowedUrls = new Set(['https://openrouter.ai/api/v1/audio/speech', 'https://piper.fixture/synthesize', ' https://piper.fixture/// /synthesize']);
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!allowedUrls.has(target)) throw new Error(`blocked unexpected fetch URL: ${target}`);
  const spec = replies.shift();
  if (!spec) throw new Error('unexpected extra fixture request');
  const record = { url: target, method: options.method, headers: Object.fromEntries(new Headers(options.headers)), body: options.body, bodyCancelled: false };
  requests.push(record);
  let body = null;
  if (spec.bodyHex !== null) {
    let sent = false;
    body = new ReadableStream({
      pull(controller) { if (!sent) { sent = true; controller.enqueue(Buffer.from(spec.bodyHex, 'hex')); } else controller.close(); },
      cancel() { record.bodyCancelled = true; },
    }, { highWaterMark: 0 });
  }
  return new Response(body, { status: spec.status, headers: spec.headers });
};
const audio = { status: 200, headers: { 'content-type': 'audio/mpeg' }, bodyHex: '010203' };
const response = (status, bodyHex, type = 'text/plain') => ({ status, headers: { 'content-type': type }, bodyHex });
const fixtures = [
  { name: 'kokoro-private', provider: 'kokoro', responses: [audio] },
  { name: 'kokoro-public', provider: 'kokoro', privateOutput: false, channelID: 'a b', speechID: 'x?#', responses: [audio] },
  { name: 'kokoro-voice-case', provider: 'kokoro', voice: '  AF_Heart  ', responses: [audio] },
  { name: 'kokoro-missing-key', provider: 'kokoro', key: false },
  { name: 'kokoro-invalid-voice', provider: 'kokoro', voice: 'not-a-voice' },
  { name: 'kokoro-empty-text', provider: 'kokoro', text: ' \n\t' },
  { name: 'kokoro-preabort', provider: 'kokoro', preabort: true },
  { name: 'kokoro-status', provider: 'kokoro', responses: [response(403, '70726976617465')] },
  { name: 'kokoro-mime', provider: 'kokoro', responses: [response(200, '01')] },
  { name: 'kokoro-mime-case', provider: 'kokoro', responses: [response(200, '0102', 'Audio/MPEG; charset=binary')] },
  { name: 'kokoro-empty', provider: 'kokoro', responses: [response(200, '', 'audio/mpeg')] },
  { name: 'kokoro-bodyless', provider: 'kokoro', responses: [response(204, null, 'audio/mpeg')] },
  { name: 'kokoro-byte-limit', provider: 'kokoro', maxAudioBytes: 2, responses: [audio] },
  { name: 'kokoro-utf16', provider: 'kokoro', text: '😀\ud800x\udc00', responses: [audio] },
  { name: 'piper-http-private', provider: 'piper', http: 'https://piper.fixture///', responses: [audio] },
  { name: 'piper-http-public', provider: 'piper', privateOutput: false, channelID: 'a b', speechID: 'x?#', http: 'https://piper.fixture/', responses: [audio] },
  { name: 'piper-http-whitespace', provider: 'piper', http: ' https://piper.fixture/// ', responses: [audio] },
  { name: 'piper-http-status-public', provider: 'piper', privateOutput: false, http: 'https://piper.fixture', responses: [response(400, '757073747265616d2064657461696c73')] },
  { name: 'piper-http-status-private', provider: 'piper', http: 'https://piper.fixture', responses: [response(400, '757073747265616d2064657461696c73')] },
  { name: 'piper-http-status-empty', provider: 'piper', http: 'https://piper.fixture', responses: [response(500, '')] },
  { name: 'piper-http-empty', provider: 'piper', http: 'https://piper.fixture', responses: [response(200, '')] },
  { name: 'piper-http-bodyless', provider: 'piper', http: 'https://piper.fixture', responses: [response(204, null)] },
  { name: 'piper-http-byte-limit', provider: 'piper', http: 'https://piper.fixture', maxAudioBytes: 2, responses: [audio] },
  { name: 'piper-http-no-mime-guard', provider: 'piper', http: 'https://piper.fixture', responses: [response(200, 'aabb')] },
  { name: 'piper-http-preabort', provider: 'piper', http: 'https://piper.fixture', preabort: true },
  { name: 'piper-http-utf16', provider: 'piper', http: 'https://piper.fixture', text: '😀\ud800x\udc00', voice: '\ud800voice', responses: [audio] },
  { name: 'piper-cli-private', provider: 'piper', bin: 'fixture-python', dataDir: '  /fixture/models  ', cli: { event: 'success', audioHex: '00010203' } },
  { name: 'piper-cli-public', provider: 'piper', privateOutput: false, cli: { event: 'success', audioHex: 'aabb' } },
  { name: 'piper-cli-whitespace-http', provider: 'piper', http: '  ', dataDir: '  ', cli: { event: 'success', audioHex: '01' } },
  { name: 'piper-cli-error', provider: 'piper', cli: { event: 'error', message: 'fixture spawn failed' } },
  { name: 'piper-cli-exit', provider: 'piper', cli: { event: 'close', code: 7 } },
  { name: 'piper-cli-stderr-tail', provider: 'piper', cli: { event: 'close', code: 1, stderr: 'x'.repeat(4100) + ' tail  ' } },
  { name: 'piper-cli-oversize', provider: 'piper', maxAudioBytes: 2, cli: { event: 'success', audioHex: '010203' } },
  { name: 'piper-cli-max-zero', provider: 'piper', maxAudioBytes: 0, cli: { event: 'success', audioHex: '010203' } },
];
const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const normalize = value => typeof value === 'string' ? value.replaceAll(dir, '<fixture-dir>') : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
const envNames = ['OPENROUTER_API_KEY', 'PIPER_HTTP_URL', 'PIPER_PYTHON_BIN', 'PIPER_DATA_DIR', 'PUBLIC_API_URL', 'NODE_ENV'];
const previous = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
const cases = [];
try {
  process.env.PUBLIC_API_URL = 'https://fixture.invalid/base///';
  process.env.NODE_ENV = 'test';
  for (const f of fixtures) {
    for (const key of ['OPENROUTER_API_KEY', 'PIPER_HTTP_URL', 'PIPER_PYTHON_BIN', 'PIPER_DATA_DIR']) delete process.env[key];
    if (f.key !== false) process.env.OPENROUTER_API_KEY = ' fixture-key ';
    if (f.http !== undefined) process.env.PIPER_HTTP_URL = f.http;
    if (f.bin !== undefined) process.env.PIPER_PYTHON_BIN = f.bin;
    if (f.dataDir !== undefined) process.env.PIPER_DATA_DIR = f.dataDir;
    requests = []; processes = []; replies = [...(f.responses ?? [])]; processSpec = f.cli ? { ...f.cli } : null;
    const controller = new AbortController();
    if (f.preabort) controller.abort(new Error('fixture abort'));
    const input = { text: f.text ?? 'Hello 😀', voice: f.voice ?? 'af_heart', channelID: f.channelID ?? f.name, speechID: f.speechID ?? f.name, outputPath: path.join(privateRoot, `${f.name}.audio`), privateOutput: f.privateOutput !== false, maxAudioBytes: f.maxAudioBytes, signal: f.preabort ? controller.signal : undefined };
    const actualPath = input.privateOutput ? input.outputPath : path.join(publicRoot, input.channelID, `${input.speechID}.${f.provider === 'kokoro' ? 'mp3' : 'wav'}`);
    // Only remove a known per-case output, including on reruns after interruption.
    await fs.rm(actualPath, { force: true });
    const result = await (f.provider === 'kokoro' ? modules.kokoro.namespace.kokoroTtsService : modules.piper.namespace.piperTtsService).synthesize(input);
    if (replies.length || processSpec) throw new Error(`unused fixture response/process: ${f.name}`);
    let output = null;
    try { output = await fs.readFile(actualPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fixtureInput = normalize({ ...input, text: undefined, voice: undefined, signal: undefined, preabort: !!f.preabort });
    fixtureInput.textUnits = units(input.text); fixtureInput.voiceUnits = units(input.voice);
    cases.push({ name: f.name, provider: f.provider, input: fixtureInput, configuration: { key: f.key !== false, http: f.http ?? null, bin: f.bin ?? null, dataDir: f.dataDir ?? null, publicApiUrl: process.env.PUBLIC_API_URL, nodeEnv: process.env.NODE_ENV }, responses: f.responses ?? [], requests: normalize(requests), processes: normalize(processes), outcomeJson: JSON.stringify(normalize(result)), files: output === null ? [] : [{ path: normalize(actualPath), hex: output.toString('hex') }] });
    await fs.rm(actualPath, { force: true });
  }
  // encodeURIComponent rejects lone surrogates; the native String boundary must
  // document this JavaScript-only case rather than silently replacing the unit.
  const publicPathCases = [['a b', 'x?#'], ['😀', 'a/b'], ['\ud800', 'x']].map(([channel, speech]) => {
    const input = { channelUnits: units(channel), speechUnits: units(speech) };
    try { return { ...input, result: modules.piper.namespace.buildPublicPath(channel, speech) }; }
    catch (error) { return { ...input, error: { name: error.name, message: error.message } }; }
  });
  const doc = JSON.stringify({ schema: 1, provenance: { node: process.version, versions: process.versions, sourceHashes, sourcePaths, attribution: { logical: attribution.logical, sha256: attribution.sha256, provenance: attribution.provenance }, injection: 'same-realm transpiled source; controlled fetch and spawn; fixture-only paths and keys' }, cases, publicPathCases }, null, 2) + '\n';
  const target = path.join(dir, 'piper-kokoro-reference.json');
  if (mode === '--write') { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(target, doc); }
  else if (await fs.readFile(target, 'utf8') !== doc) throw new Error('application fixture differs');
  process.stdout.write(JSON.stringify({ schema: 1, cases: cases.length, publicPathCases: publicPathCases.length, sourceSha256: sourceHashes['tests/fixtures/piper_kokoro_reference.mjs'] }) + '\n');
} finally {
  for (const key of envNames) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
}
