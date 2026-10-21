import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

// Run the real supervisor and the active roulette-actions worker within the
// candidate's resource limit. Roulette completion is native-only since the
// 2026-10-21 retirement; the native binary is allowed to run for real when this
// fixture is used against a cron candidate. Unrelated workers are stubbed; all
// data/providers are fixtures.
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (command === '/usr/local/bin/roulette_completion'
      || args[0]?.endsWith('/roulette-actions.worker.js')) {
      return realSpawn(command, args, options);
    }
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; return true; };
    return child;
  };
  syncBuiltinESMExports();
}
