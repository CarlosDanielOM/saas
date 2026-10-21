// Intercept only the actual supervisor's spawn import. Dashboard activity Rust stays real;
// every other child, including the native stream projector, remains inert.
import { registerHooks } from 'node:module';
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
    const uri = new URL(process.env.MONGO_URI || '');
    if (uri.hostname !== 'mongo' || !/^\/dashboard_activity_fixture_[a-zA-Z0-9_]+$/.test(uri.pathname)
        || process.env.DRAGONFLY_HOST !== 'redis' || process.env.DRAGONFLY_PORT !== '6379') throw new Error('Dashboard activity fixture requires isolated Mongo/Redis aliases');
    globalThis.fetch = async () => { throw new Error('Outbound provider request blocked by dashboard activity fixture'); };
    registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/dist/workers/cron.index.js')) {
            return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
                export * from 'node:child_process';
                import { spawn as actualSpawn } from 'node:child_process';
                import { EventEmitter } from 'node:events';
                import { PassThrough } from 'node:stream';
                import { appendFileSync } from 'node:fs';
                let fakePid = 900000;
                const record = value => appendFileSync('/tmp/saas-fixtures/dashboard-activity-spawns.jsonl', JSON.stringify({
                    supervisor: process.pid, scope: process.env.DASHBOARD_ACTIVITY_FIXTURE_SCOPE || 'main',
                    at: Date.now(), ...value
                }) + '\\n');
                export const spawn = (command, args, options) => {
                    const worker = command === '/usr/local/bin/dashboard_activity' ? 'dashboard-activity' : command === '/usr/local/bin/raid_sessions' ? 'raid-sessions' : command === '/usr/local/bin/raid_analytics' ? 'raid-analytics'
                        : command === '/usr/local/bin/stream_activity' ? 'stream-activity' : command === '/usr/local/bin/follow_defense_baseline' ? 'follow-defense-baseline' : command === '/usr/local/bin/roulette_completion' ? 'roulette-completion' : command === '/usr/local/bin/ai_usage_receipts' ? 'ai-usage-receipts' : options?.env?.CRON_WORKER_NAME;
                    if (!worker) throw new Error('Unexpected supervisor child in isolated dashboard activity fixture');
                    const native = worker === 'dashboard-activity';
                    let child;
                    if (native) {
                        if (command !== '/usr/local/bin/dashboard_activity' || !args.includes('--telemetry-json'))
                            throw new Error('Candidate must supervise native dashboard activity Rust with metadata protocol');
                        const allowed = new Set(['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'DRAGONFLY_HOST', 'DRAGONFLY_PORT', 'CLIENT_ID', 'CLIENT_SECRET', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
                        if (Object.keys(options?.env || {}).some(key => !allowed.has(key)))
                            throw new Error('Native worker inherited unexpected environment');
                        const fault = process.env.DASHBOARD_ACTIVITY_FIXTURE_FAULT;
                        if (fault && !['missing', 'exit'].includes(fault)) throw new Error('Unknown dashboard fixture fault');
                        const actualCommand = fault === 'missing' ? '/tmp/saas-fixtures/absent-dashboard-binary' : fault === 'exit' ? process.execPath : command;
                        const actualArgs = fault === 'exit' ? ['-e', 'process.exit(17)'] : args;
                        child = actualSpawn(actualCommand, actualArgs, options);
                        child.on('error', error => record({ event: 'error', worker, code: error.code }));
                        let pending = '';
                        child.stdout.on('data', chunk => {
                            pending += chunk;
                            if (pending.length > 8192) throw new Error('Oversized native fixture metadata');
                            const lines = pending.split('\\n'); pending = lines.pop();
                            for (const line of lines) if (line.startsWith('dashboard_activity:')) {
                                const frame = JSON.parse(line.slice('dashboard_activity:'.length));
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
                        uid: options?.uid, gid: options?.gid, envKeys: native ? Object.keys(options?.env || {}).sort() : [] });
                    return child;
                };
            `) };
        }
        return nextResolve(specifier, context);
    } });
}
