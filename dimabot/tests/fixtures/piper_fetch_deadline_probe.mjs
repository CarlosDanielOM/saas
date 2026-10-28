// Disposable Node process only: node --experimental-vm-modules this-file.mjs
// This probes Node fetch and the actual TS reader, not the full Piper service.
// All HTTP traffic is confined to an ephemeral 127.0.0.1 listener.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

if (process.versions.node !== '24.22.1' || process.versions.v8 !== '13.6.233.17-node.58') throw new Error('unexpected Node/V8 runtime');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const sourcePath = 'src/utils/tts/tts_deadline.util.ts';
const source = await fs.readFile(path.join(root, sourcePath), 'utf8');
const module = new vm.SourceTextModule(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText, { identifier: sourcePath });
await module.link(specifier => { throw new Error(`unexpected source import: ${specifier}`); });
await module.evaluate();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHashes = { [sourcePath]: sha(source), 'tests/fixtures/piper_fetch_deadline_probe.mjs': sha(await fs.readFile(fileURLToPath(import.meta.url))) };
for (const p of ['package.json', 'package-lock.json', 'node_modules/typescript/package.json']) sourceHashes[p] = sha(await fs.readFile(path.join(root, p)));

const sockets = new Set();
const timers = new Set();
const schedule = (fn, ms) => {
  const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
  timers.add(timer);
};
const server = http.createServer((req, res) => {
  if (req.url !== '/deadline' && req.url !== '/control') { res.writeHead(404); res.end(); return; }
  const deadline = req.url === '/deadline';
  schedule(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.flushHeaders();
    schedule(() => { if (!res.destroyed) res.end(Buffer.from([1, 2, 3])); }, deadline ? 120 : 20);
  }, deadline ? 70 : 20);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
let outerTimer;
async function probe(name) {
  const start = performance.now();
  const original = AbortSignal.timeout(150);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/${name}`, { signal: original });
  const headersMs = performance.now() - start;
  const later = AbortSignal.timeout(150);
  let bytes, failure;
  try { bytes = await module.namespace.readAudioStream(response.body, later); }
  catch (error) { failure = { name: error?.name ?? 'unknown', message: String(error?.message ?? error) }; }
  const elapsedMs = performance.now() - start;
  const result = { headersMs: Math.round(headersMs), elapsedMs: Math.round(elapsedMs), originalAborted: original.aborted, readerSignalAborted: later.aborted, bodyHex: bytes?.toString('hex') ?? null, failure: failure ?? null };
  if (name === 'deadline') {
    if (!failure || !original.aborted || later.aborted || bytes || headersMs >= 150 || elapsedMs >= 1000) throw new Error(`deadline assertion failed: ${JSON.stringify(result)}`);
    return { ...result, category: 'original-fetch-deadline-rejected-body' };
  }
  if (failure || original.aborted || later.aborted || bytes?.toString('hex') !== '010203' || elapsedMs >= 1000) throw new Error(`control assertion failed: ${JSON.stringify(result)}`);
  return { ...result, category: 'body-completed-before-original-deadline' };
}
try {
  await listen();
  const timeout = new Promise((_, reject) => { outerTimer = setTimeout(() => reject(new Error('probe exceeded outer deadline')), 1500); });
  const results = await Promise.race([(async () => [await probe('deadline'), await probe('control')])(), timeout]);
  process.stdout.write(JSON.stringify({ schema: 1, provenance: { node: process.version, v8: process.versions.v8, typescript: ts.version, sourceHashes }, timingMs: { fetchDeadline: 150, laterReaderDeadline: 150, deadlineHeaders: 70, deadlineBodyAfterHeaders: 120, controlHeaders: 20, controlBodyAfterHeaders: 20, outerLimit: 1500 }, results }) + '\n');
} finally {
  clearTimeout(outerTimer);
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
