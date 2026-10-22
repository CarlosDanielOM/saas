// Test-only process boundary: preserve the packaged cron -> dispatcher -> chat
// consumer path. Only unrelated workers/native index/consumers become inert OS
// children. No production module, registry, admission or event gate is mocked.
import * as childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const journal = '/tmp/pet-cron-processes.jsonl';
const entry = process.argv[1] || '';
const supervisor = entry.endsWith('/dist/workers/cron.index.js');
const domainWorker = entry.endsWith('/dist/workers/domain_events.worker.js');
const consumer = process.argv.find(arg => arg.startsWith('--consumer='))?.slice('--consumer='.length);
const dispatcher = domainWorker && !consumer;
const chatConsumer = domainWorker && consumer === 'chat-announcements-v1';
const api = entry.endsWith('/dist/server/index.js');
function record(data) {
  appendFileSync(journal, JSON.stringify({ ...data, observerPid: process.pid }) + '\n');
}
if (supervisor || dispatcher || chatConsumer || api) {
  const role = supervisor ? 'cron-supervisor' : dispatcher ? 'cron-dispatcher' : chatConsumer ? 'cron-chat-consumer' : 'api-runtime';
  process.env.PET_PRODUCER_ROLE = role;
  record({ type: 'boot', role, pid: process.pid, ppid: process.ppid, argv: process.argv, ipc: Boolean(process.send) });
}

if (supervisor || dispatcher) {
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
    const real = command === process.execPath && args?.[0]?.endsWith('/dist/workers/domain_events.worker.js')
      && options?.env?.CRON_WORKER_NAME === 'domain-events';
    const child = real ? original.spawn(command, args, options)
      : original.spawn(process.execPath, ['-e', inert], { ...options, env: { ...options?.env, NODE_OPTIONS: '' } });
    record({ type: 'spawn', real, pid: child.pid, ppid: process.pid, command, args, worker: options?.env?.CRON_WORKER_NAME || 'native-index' });
    return child;
  };
  boundary.fork = (modulePath, args, options) => {
    if (!dispatcher) return original.fork(modulePath, args, options);
    const id = args?.find(arg => arg.startsWith('--consumer='))?.slice('--consumer='.length);
    const real = id === 'chat-announcements-v1';
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
  globalThis.__petCronChildProcessBoundary = boundary;
  const exports = Object.keys(original).filter(key => key !== 'default')
    .map(key => `export const ${key} = boundary[${JSON.stringify(key)}];`).join('\n');
  const url = 'data:text/javascript,' + encodeURIComponent(`
    const boundary = globalThis.__petCronChildProcessBoundary;
    export default boundary; ${exports}
  `);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' || specifier === 'child_process') return { shortCircuit: true, url };
    return nextResolve(specifier, context);
  } });
}
