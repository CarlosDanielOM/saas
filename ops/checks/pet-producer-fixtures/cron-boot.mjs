// The normal cron supervisor owns startup/readiness, while its unrelated workers stay inert.
// The check invokes the real registered chat-announcements-v1 dispatch/drain functions itself.
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
