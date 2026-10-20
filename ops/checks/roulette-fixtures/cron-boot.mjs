import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

// Run the real supervisor and both roulette workers within the candidate's
// resource limit. Unrelated workers are stubbed; all data/providers are fixtures.
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (args[0]?.endsWith('/roulette.worker.js') || args[0]?.endsWith('/roulette-actions.worker.js')) {
      return realSpawn(command, args, options);
    }
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; return true; };
    return child;
  };
  syncBuiltinESMExports();
}
