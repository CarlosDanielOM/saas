// Intercept only the actual candidate cron supervisor's spawn import.
//
// stream-activity stays a real native child so the retired entrypoints are
// checked next to a meaningful runtime feature. The other native children are
// inert doubles unless RUST_ONLY_FIXTURE_ENOENT or RUST_ONLY_FIXTURE_NONZERO
// names one of them: ENOENT makes the real supervisor's spawn call throw, and
// NONZERO returns a double that exits 7. Both paths must be retried by the same
// native command; this fixture records the requested command so the check can
// prove no retired TypeScript entrypoint is launched.
import { registerHooks } from 'node:module';
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
    const uri = new URL(process.env.MONGO_URI || '');
    if (uri.hostname !== 'mongo' || !/^\/rust_only_fixture_[a-zA-Z0-9_]+$/.test(uri.pathname)
        || process.env.DRAGONFLY_HOST !== 'redis') {
        throw new Error('Rust-only cron fixture requires isolated Mongo/Redis aliases and a rust_only_fixture_* database');
    }
    globalThis.fetch = async () => { throw new Error('Outbound provider request blocked by rust-only cron fixture'); };
    registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/dist/workers/cron.index.js')) {
            return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
                export * from 'node:child_process';
                import { spawn as actualSpawn } from 'node:child_process';
                import { EventEmitter } from 'node:events';
                import { PassThrough } from 'node:stream';
                import { appendFileSync } from 'node:fs';
                let fakePid = 920000;
                const log = '/tmp/saas-fixtures/rust-only-spawns.jsonl';
                const record = value => appendFileSync(log, JSON.stringify({
                    supervisor: process.pid, at: Date.now(), ...value
                }) + '\\n');
                const NATIVE = {
                    '/usr/local/bin/stream_activity': 'stream-activity',
                    '/usr/local/bin/raid_analytics': 'raid-analytics',
                    '/usr/local/bin/follow_defense_baseline': 'follow-defense-baseline',
                    '/usr/local/bin/roulette_completion': 'roulette-completion',
                    '/usr/local/bin/ai_usage_receipts': 'ai-usage-receipts',
                };
                const inert = (worker, command, args, options, native, extra = {}) => {
                    const child = new EventEmitter();
                    child.pid = fakePid++;
                    child.stdout = new PassThrough(); child.stderr = new PassThrough();
                    child.killed = false; child.exitCode = null; child.signalCode = null;
                    child.kill = () => {
                        child.killed = true;
                        setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); });
                        return true;
                    };
                    record({ event: 'spawn', worker, pid: child.pid, native,
                        command: native ? command : 'inert-fixture-worker', requestedCommand: command,
                        args, uid: options?.uid, gid: options?.gid,
                        envKeys: native ? Object.keys(options?.env || {}).sort() : [], ...extra });
                    queueMicrotask(() => child.emit('spawn'));
                    return child;
                };
                export const spawn = (command, args, options) => {
                    const nativeName = NATIVE[command];
                    const worker = nativeName || options?.env?.CRON_WORKER_NAME;
                    if (!worker) throw new Error('Unexpected supervisor child in rust-only fixture');
                    if (nativeName) {
                        if (!Array.isArray(args) || !args.includes('--telemetry-json')) {
                            throw new Error('Native launch must request bounded telemetry metadata');
                        }
                        if (nativeName === 'stream-activity') {
                            const child = actualSpawn(command, args, options);
                            let pending = '';
                            child.stdout.on('data', chunk => {
                                pending += chunk;
                                if (pending.length > 8192) throw new Error('Oversized native fixture metadata');
                                const lines = pending.split('\\n'); pending = lines.pop();
                                for (const line of lines) if (line.startsWith('stream_activity:')) {
                                    const frame = JSON.parse(line.slice('stream_activity:'.length));
                                    record({ event: 'frame', worker, pid: child.pid, frame });
                                }
                            });
                            child.on('exit', (code, signal) => record({ event: 'exit', worker, pid: child.pid, code, signal }));
                            record({ event: 'spawn', worker, pid: child.pid, native: true, command,
                                requestedCommand: command, args, uid: options?.uid, gid: options?.gid,
                                envKeys: Object.keys(options?.env || {}).sort() });
                            return child;
                        }
                        if (process.env.RUST_ONLY_FIXTURE_ENOENT === worker) {
                            record({ event: 'spawn-failed', worker, native: true, requestedCommand: command,
                                args, code: 'ENOENT', uid: options?.uid, gid: options?.gid });
                            throw Object.assign(new Error('spawn ' + command + ' ENOENT'),
                                { code: 'ENOENT', errno: -2, syscall: 'spawn', path: command });
                        }
                        if (process.env.RUST_ONLY_FIXTURE_NONZERO === worker) {
                            const child = inert(worker, command, args, options, true, { simulated: 'nonzero-exit' });
                            child.once('spawn', () => setTimeout(() => {
                                if (child.exitCode !== null) return;
                                child.exitCode = 7;
                                record({ event: 'exit', worker, pid: child.pid, code: 7, signal: null, simulated: 'nonzero-exit' });
                                child.emit('exit', 7, null);
                                child.emit('close', 7, null);
                            }, 25));
                            return child;
                        }
                    }
                    return inert(worker, command, args, options, false);
                };
            `) };
        }
        return nextResolve(specifier, context);
    } });
}
