// Keep the real supervisor and timer consumer. Other workers are test doubles:
// their full process set exceeds the disposable container's 3 GiB memory limit.
import { spawn } from 'node:child_process';
import { registerHooks } from 'node:module';
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
    globalThis.saasAiCronSpawn = spawn;
    registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
            import { EventEmitter } from 'node:events';
            export const spawn = (command, args, options) => {
                if (args.some(arg => arg.endsWith('/timer.worker.js'))) {
                    return globalThis.saasAiCronSpawn(command, args, options);
                }
                const child = new EventEmitter();
                child.pid = 1;
                child.kill = () => true;
                return child;
            };
        `) };
        return nextResolve(specifier, context);
    } });
}
