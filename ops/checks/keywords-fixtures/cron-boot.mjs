// Only dependency worker processes are replaced; the real supervisor boots,
// and the behavior check executes the shared AST/command code against test DBs.
import { registerHooks } from 'node:module';
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
  setInterval(() => {}, 1000);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      import { EventEmitter } from 'node:events';
      export const spawn = () => { const child = new EventEmitter(); child.pid = 1; child.kill = () => true; return child; };
    `) };
    return nextResolve(specifier, context);
  } });
}
