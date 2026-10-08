import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';

// Boot the real cron supervisor and domain-event worker. Unrelated workers
// are stubbed so this release check only runs billing against disposable Mongo.
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (args[0]?.endsWith('/domain_events.worker.js')) {
      const child = realSpawn(command, args, options);
      writeFileSync('/tmp/saas-fixtures/domain-worker-pid', String(child.pid));
      return child;
    }
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; return true; };
    return child;
  };
  syncBuiltinESMExports();
}

// This check never needs provider HTTP access or real billing calls.
globalThis.fetch = async () => { throw new Error('External HTTP is disabled in the referral check'); };
