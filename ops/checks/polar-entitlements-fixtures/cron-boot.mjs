// Isolated cron process boundary: preserve the packaged dispatcher and Polar
// plan consumer. Unchanged workers become inert OS children so the disposable
// MongoDB does not receive every production worker's startup connection pool.
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const journal = '/tmp/polar-cron-processes.jsonl';
const entry = process.argv[1] || '';
const supervisor = entry.endsWith('/dist/workers/cron.index.js');
const domainWorker = entry.endsWith('/dist/workers/domain_events.worker.js');
const consumer = process.argv.find(arg => arg.startsWith('--consumer='))?.slice('--consumer='.length);
const dispatcher = domainWorker && !consumer;
const planConsumer = domainWorker && consumer === 'polar-plan-v1';
const api = entry.endsWith('/dist/server/index.js');
function record(data) {
  appendFileSync(journal, JSON.stringify({ ...data, observerPid: process.pid }) + '\n');
}
if (supervisor || dispatcher || planConsumer || api) {
  const role = supervisor ? 'cron-supervisor' : dispatcher ? 'cron-dispatcher' : planConsumer ? 'cron-plan-consumer' : 'api-runtime';
  process.env.POLAR_ENTITLEMENTS_ROLE = role;
  record({ type: 'boot', role, pid: process.pid, ppid: process.ppid, argv: process.argv, ipc: Boolean(process.send) });
}

if (supervisor || dispatcher) {
  const uri = new URL(process.env.MONGO_URI || '');
  assert.equal(uri.hostname, 'mongo');
  assert.match(uri.pathname, /^\/saas_ops_polar_entitlements_[a-z0-9_]+$/);
  assert.equal(process.env.DRAGONFLY_HOST, 'redis');
  assert.equal(process.env.DRAGONFLY_PORT, '6379');
  // Do not load provider preloads in unrelated inert processes. They do no work
  // and retain real PID/signal/IPC lifecycle for the unchanged supervisors.
  const inert = `
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    process.on('disconnect', () => process.exit(0));
    const poll = () => { if (process.connected) process.send({ type: 'polling' }, () => {}); };
    process.on('message', poll); poll(); setInterval(poll, 1000);
  `;
  const original = childProcess;
  const boundary = { ...original };
  boundary.spawn = (command, args, options) => {
    if (!supervisor) return original.spawn(command, args, options);
    const real = (command === process.execPath && args?.[0]?.endsWith('/dist/workers/domain_events.worker.js')
      && options?.env?.CRON_WORKER_NAME === 'domain-events');
    const child = real ? original.spawn(command, args, options)
      : original.spawn(process.execPath, ['-e', inert], { ...options, env: { ...options?.env, NODE_OPTIONS: '' } });
    record({ type: 'spawn', real, pid: child.pid, ppid: process.pid, command, args, worker: options?.env?.CRON_WORKER_NAME || 'native-index' });
    return child;
  };
  boundary.fork = (modulePath, args, options) => {
    if (!dispatcher) return original.fork(modulePath, args, options);
    const id = args?.find(arg => arg.startsWith('--consumer='))?.slice('--consumer='.length);
    const real = id === 'polar-plan-v1';
    const child = real ? original.fork(modulePath, args, options)
      : original.spawn(process.execPath, ['-e', inert], { ...options, env: { ...process.env, NODE_OPTIONS: '' } });
    record({ type: 'fork', real, pid: child.pid, ppid: process.pid, modulePath: String(modulePath), args, consumer: id });
    if (real) child.on('message', message => {
      // Observe the actual child's lease report; never inject or modify IPC.
      if (message?.type === 'claimed') record({ type: 'claimed', pid: child.pid, ppid: process.pid, consumer: id, lease: message.lease });
    });
    return child;
  };
  // Capture the real builtin before registering this ESM-only boundary, and
  // forward every other export unchanged (including promisified exec helpers).
  globalThis.__polarCronChildProcessBoundary = boundary;
  const exports = Object.keys(original).filter(key => key !== 'default')
    .map(key => `export const ${key} = boundary[${JSON.stringify(key)}];`).join('\n');
  const url = 'data:text/javascript,' + encodeURIComponent(`
    const boundary = globalThis.__polarCronChildProcessBoundary;
    export default boundary; ${exports}
  `);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' || specifier === 'child_process') return { shortCircuit: true, url };
    return nextResolve(specifier, context);
  } });
}
