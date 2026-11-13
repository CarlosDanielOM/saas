// Run the real timer consumer and roulette completion worker; unrelated
// supervisor children are inert fixtures within the candidate's memory cap.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
  const mongo = new URL(process.env.MONGO_URI || '');
  assert.equal(mongo.hostname, 'mongo');
  assert.match(mongo.pathname, /^\/saas_ops_/);
  assert.equal(process.env.DRAGONFLY_HOST, 'redis');
}
globalThis.__shoutoutCronSpawn = (command, args, options) => {
  const entry = String(args?.[0] ?? '');
  const timer = entry.endsWith('/timer.worker.js');
  const completion = entry.endsWith('/roulette_completion.worker.js');
  if (timer || completion) {
    const child = spawn(command, timer ? ['/tmp/saas-fixtures/timer-child.mjs', ...args.slice(1)] : args, options);
    appendFileSync('/tmp/saas-fixtures/cron.jsonl', JSON.stringify({
      worker: options?.env?.CRON_WORKER_NAME, actualTypescript: true, pid: child.pid, command, args,
    }) + '\n');
    return child;
  }
  const child = new EventEmitter();
  Object.assign(child, { pid: 0, exitCode: null, signalCode: null, kill: () => true });
  return child;
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process' && context.parentURL?.endsWith('/workers/cron.index.js')) {
    const source = 'export const spawn = (...args) => globalThis.__shoutoutCronSpawn(...args);';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
