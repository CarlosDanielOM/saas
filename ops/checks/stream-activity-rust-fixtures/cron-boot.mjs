// Only the candidate's real cron supervisor is intercepted. The Rust process
// stays real; unrelated workers are inert doubles and never load application code.
import { registerHooks } from 'node:module';
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
    const uri = new URL(process.env.MONGO_URI || '');
    if (uri.hostname !== 'mongo' || !uri.pathname.startsWith('/stream_activity_fixture_') || process.env.DRAGONFLY_HOST !== 'redis') {
        throw new Error('Cron fixture requires isolated mongo/redis aliases and fixture database');
    }
    globalThis.fetch = async () => { throw new Error('Outbound provider request blocked by stream-activity fixture'); };
    registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/dist/workers/cron.index.js')) {
            return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
                export * from 'node:child_process';
                import { spawn as actualSpawn } from 'node:child_process';
                import { EventEmitter } from 'node:events';
                import { PassThrough } from 'node:stream';
                import { appendFileSync } from 'node:fs';
                let fakePid = 900000;
                const record = value => appendFileSync('/tmp/saas-fixtures/spawns.jsonl', JSON.stringify({
                    supervisor: process.pid, scope: process.env.STREAM_ACTIVITY_FIXTURE_SCOPE || 'main', ...value
                }) + '\\n');
                export const spawn = (command, args, options) => {
                    const worker = command === '/usr/local/bin/stream_activity' ? 'stream-activity'
                        : command === '/usr/local/bin/raid_analytics' ? 'raid-analytics' : options?.env?.CRON_WORKER_NAME;
                    let child;
                    if (worker === 'stream-activity') {
                        if (command !== '/usr/local/bin/stream_activity' || !args.includes('--telemetry-json')) {
                            throw new Error('Candidate must supervise native Rust stream activity with metadata protocol');
                        }
                        child = actualSpawn(command, args, options);
                        child.on('exit', (code, signal) => record({ event: 'exit', worker, pid: child.pid, code, signal }));
                    } else {
                        child = new EventEmitter();
                        child.pid = fakePid++;
                        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
                        child.exitCode = null; child.signalCode = null;
                        child.kill = () => {
                            child.killed = true;
                            setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); });
                            return true;
                        };
                        queueMicrotask(() => child.emit('spawn'));
                    }
                    record({ event: 'spawn', worker, pid: child.pid, native: worker === 'stream-activity',
                        command: worker === 'stream-activity' ? command : 'inert-fixture-worker', uid: options?.uid, gid: options?.gid });
                    return child;
                };
            `) };
        }
        return nextResolve(specifier, context);
    } });
}
