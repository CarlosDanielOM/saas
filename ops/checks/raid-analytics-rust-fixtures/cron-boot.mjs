// Intercept only the actual supervisor's spawn import. Raid Rust stays real;
// every other child, including the native stream projector, remains inert.
import { registerHooks } from 'node:module';
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
    const uri = new URL(process.env.MONGO_URI || '');
    if (uri.hostname !== 'mongo' || !/^\/raid_analytics_fixture_[a-zA-Z0-9_]+$/.test(uri.pathname)
        || process.env.DRAGONFLY_HOST !== 'redis') throw new Error('Raid fixture requires isolated Mongo/Redis aliases');
    globalThis.fetch = async () => { throw new Error('Outbound provider request blocked by raid fixture'); };
    registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/dist/workers/cron.index.js')) {
            return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
                export * from 'node:child_process';
                import { spawn as actualSpawn } from 'node:child_process';
                import { EventEmitter } from 'node:events';
                import { PassThrough } from 'node:stream';
                import { appendFileSync } from 'node:fs';
                let fakePid = 900000;
                const record = value => appendFileSync('/tmp/saas-fixtures/raid-spawns.jsonl', JSON.stringify({
                    supervisor: process.pid, scope: process.env.RAID_ANALYTICS_FIXTURE_SCOPE || 'main',
                    at: Date.now(), ...value
                }) + '\\n');
                export const spawn = (command, args, options) => {
                    const worker = command === '/usr/local/bin/raid_analytics' ? 'raid-analytics'
                        : command === '/usr/local/bin/stream_activity' ? 'stream-activity' : command === '/usr/local/bin/follow_defense_baseline' ? 'follow-defense-baseline' : options?.env?.CRON_WORKER_NAME;
                    if (!worker) throw new Error('Unexpected supervisor child in isolated raid fixture');
                    const native = worker === 'raid-analytics';
                    let child;
                    if (native) {
                        if (command !== '/usr/local/bin/raid_analytics' || !args.includes('--telemetry-json'))
                            throw new Error('Candidate must supervise native raid Rust with metadata protocol');
                        const allowed = new Set(['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
                        if (Object.keys(options?.env || {}).some(key => !allowed.has(key)))
                            throw new Error('Native worker inherited unexpected environment');
                        child = actualSpawn(command, args, options);
                        let pending = '';
                        child.stdout.on('data', chunk => {
                            pending += chunk;
                            if (pending.length > 8192) throw new Error('Oversized native fixture metadata');
                            const lines = pending.split('\\n'); pending = lines.pop();
                            for (const line of lines) if (line.startsWith('raid_analytics:')) {
                                const frame = JSON.parse(line.slice('raid_analytics:'.length));
                                record({ event: 'batch', worker, pid: child.pid, frame });
                            }
                        });
                        child.on('exit', (code, signal) => record({ event: 'exit', worker, pid: child.pid, code, signal }));
                    } else {
                        child = new EventEmitter(); child.pid = fakePid++;
                        child.stdout = new PassThrough(); child.stderr = new PassThrough();
                        child.killed = false; child.exitCode = null; child.signalCode = null;
                        child.kill = () => {
                            child.killed = true;
                            setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); });
                            return true;
                        };
                        queueMicrotask(() => child.emit('spawn'));
                    }
                    record({ event: 'spawn', worker, pid: child.pid, native,
                        command: native ? command : 'inert-fixture-worker', requestedCommand: command, args: native ? args : [],
                        uid: options?.uid, gid: options?.gid });
                    return child;
                };
            `) };
        }
        return nextResolve(specifier, context);
    } });
}
