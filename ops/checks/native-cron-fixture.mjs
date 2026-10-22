// Stage beside cron-boot.mjs in the disposable candidate's /tmp/saas-fixtures.
// No application imports, provider clients, or import-time processes.
import assert from 'node:assert/strict';
import { spawn as actualSpawn, spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';

export const NATIVE = Object.freeze(Object.fromEntries([
    ['dashboard-activity', 'dashboard_activity'], ['raid-analytics', 'raid_analytics'],
    ['stream-activity', 'stream_activity'], ['roulette-completion', 'roulette_completion'],
    ['follow-defense-baseline', 'follow_defense_baseline'], ['raid-sessions', 'raid_sessions'],
    ['ai-usage-receipts', 'ai_usage_receipts'],
].map(([name, binary]) => [name, `/usr/local/bin/${binary}`])));
const COMMON = ['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const REDIS = ['DRAGONFLY_HOST', 'DRAGONFLY_PORT'];
const RECEIPTS = [...REDIS, 'AI_USAGE_RECEIPTS_ENABLED', 'AI_USAGE_RECEIPTS_INTERVAL_MS',
    'AI_USAGE_RECEIPTS_BATCH_SIZE', 'AI_USAGE_RECEIPTS_LOCK_KEY', 'AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS',
    'AI_USAGE_QUEUE_MAX_AGE_SECONDS', 'AI_USAGE_PROCESSING_MAX_AGE_SECONDS', 'AI_USAGE_QUEUE_FAILURE_THRESHOLD'];
const DASHBOARD = [...REDIS, 'CLIENT_ID', 'CLIENT_SECRET', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];
const ENV = Object.fromEntries(Object.keys(NATIVE).map(name => [name, new Set([...COMMON,
    ...(name === 'dashboard-activity' ? DASHBOARD : name === 'ai-usage-receipts' ? RECEIPTS
        : ['raid-sessions', 'follow-defense-baseline'].includes(name) ? REDIS : [])])]));
const SUPERVISOR_ENV = new Set([...COMMON, ...RECEIPTS, ...DASHBOARD,
    'OBSERVABILITY_DISABLED', 'CRON_WORKER_RESTART_DELAY_MS']);
const KEY = Symbol.for('saas.native-cron-fixture');
let fakePid = 900000;

// Read only identity. Environment values are never written to fixture logs.
export function processIdentity(pid) {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/);
    return { parentPid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
        effectiveUid: Number(status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1]),
        effectiveGid: Number(status.match(/^Gid:\s+\d+\s+(\d+)/m)?.[1]),
        processGroup: Number(fields[2]) };
}

export function assertNativeMetadata(row) {
    assert.equal(row.binary, NATIVE[row.worker], 'Rust owns the registered binary');
    assert.equal(row.uid, 65534); assert.equal(row.gid, 65534);
    assert.deepEqual(row.args, row.worker === 'stream-activity'
        ? ['--batch-size', '500', '--telemetry-json', ...(row.args.includes('--once') ? ['--once'] : [])]
        : ['--telemetry-json', ...(row.args.includes('--once') ? ['--once'] : [])]);
    assert(Array.isArray(row.envKeys));
    assert(row.envKeys.every(key => ENV[row.worker].has(key)), 'per-worker environment is allowlisted');
    assert.equal(new Set(row.envKeys).size, row.envKeys.length);
}

// A small streaming parser: bounded line storage, no retained raw child output.
// Events without pid in the current Rust schema are tied to its live generation.
export function diagnosticParser({ selected, rustPid, record, frameEvent }) {
    const live = new Map();
    let pending = '', discarding = false;
    function accept(line) {
        if (!line.startsWith('cron_index:')) return;
        let row;
        try { row = JSON.parse(line.slice('cron_index:'.length)); }
        catch { throw new Error('Malformed Rust supervisor diagnostic'); }
        if (['start', 'shutdown', 'stopped'].includes(row.event)) return;
        const worker = row.worker || row.name;
        assert(selected.includes(worker), 'unselected native worker diagnostic');
        if (row.name !== undefined) assert.equal(row.name, worker);
        if (row.event === 'spawn') {
            assert(Number.isSafeInteger(row.pid) && row.pid > 0);
            assertNativeMetadata({ ...row, worker });
            live.set(worker, row.pid);
            let identity = {};
            try { identity = processIdentity(row.pid); }
            catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; } // a short-lived failure fixture may already be reaped
            if (identity.parentPid !== undefined) {
                assert.equal(identity.parentPid, rustPid, 'native child belongs to Rust, not Node');
                assert.equal(identity.effectiveUid, 65534); assert.equal(identity.effectiveGid, 65534);
                assert.equal(identity.processGroup, rustPid, 'native remains in bridge-owned group');
            }
            record({ event: 'spawn', worker, pid: row.pid, rustSupervisor: rustPid, native: true,
                command: row.binary, requestedCommand: row.binary, args: row.args,
                uid: row.uid, gid: row.gid, envKeys: [...row.envKeys].sort(), restartCount: row.restartCount, ...identity });
        } else if (['batch', 'health'].includes(row.event)) {
            const pid = row.pid ?? live.get(worker);
            assert.equal(pid, live.get(worker), 'progress belongs to current native generation');
            assert(row.frame && row.frame.event === row.event);
            const phases = worker === 'raid-analytics'
                ? ['claimMs', 'followQueriesMs', 'followWriteMs', 'period7Ms', 'period30Ms', 'reciprocityMs', 'publishMs', 'releaseMs']
                : worker === 'follow-defense-baseline'
                    ? ['queueMs', 'claimMs', 'ledgerMs', 'streamsMs', 'attacksMs', 'publishMs', 'rescheduleMs'] : [];
            const fields = row.event === 'batch' ? ['event', 'events', 'durationMs', 'success', ...(phases.length ? ['phases'] : [])]
                : worker === 'stream-activity' ? ['event', 'success', 'hasPending', 'oldestPendingAgeMs', 'checkpointSeq', 'activeBatchEvents', 'lastSuccessAgeMs']
                    : ['event', 'success', 'dueChannels', 'oldestDueAgeMs', 'lastSuccessAgeMs'];
            assert(Object.keys(row.frame).every(key => fields.includes(key)), 'strict diagnostic frame fields');
            if (row.frame.phases) assert(Object.keys(row.frame.phases).every(key => phases.includes(key)), 'strict diagnostic phase fields');
            assert(row.event !== 'health' || ['stream-activity', 'raid-analytics', 'follow-defense-baseline'].includes(worker));
            assert.equal(typeof row.frame.success, 'boolean');
            const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15;
            for (const [key, value] of Object.entries(row.frame)) {
                if (['event', 'success', 'hasPending', 'phases'].includes(key) || value === null) continue;
                assert(number(value), 'numeric diagnostic metadata');
            }
            if (row.frame.phases) assert(Object.values(row.frame.phases).every(number));
            if ('hasPending' in row.frame) assert.equal(typeof row.frame.hasPending, 'boolean');
            if (row.event === 'batch') {
                assert(Number.isSafeInteger(row.frame.events)); assert(number(row.frame.durationMs));
                assert(row.frame.success || row.frame.events === 0);
            }
            // Rust validates the protocol; copy only its frame, never arbitrary diagnostic keys.
            assert(Buffer.byteLength(JSON.stringify(row.frame)) <= 1024);
            record({ event: frameEvent || row.event, worker, pid, rustSupervisor: rustPid, frame: row.frame });
        } else if (row.event === 'exit') {
            if (row.pid !== null) {
                assert.equal(row.pid, live.get(worker)); live.delete(worker);
            }
            record({ event: 'exit', worker, pid: row.pid, code: row.signal ? null : row.code,
                signal: typeof row.signal === 'number' ? ({ 9: 'SIGKILL', 15: 'SIGTERM', 2: 'SIGINT' }[row.signal] || row.signal) : row.signal,
                restarting: row.restarting, failedSpawn: row.failedSpawn, rustSupervisor: rustPid });
        } else if (row.event === 'error') {
            assert(typeof row.code === 'string' && row.code.length <= 40 && /^[A-Z_0-9]+$/.test(row.code), 'sanitized error code');
            assert(['spawn', 'stdout', 'terminate', 'kill', 'wait', 'exit'].includes(row.step), 'sanitized process step');
            record({ event: row.step === 'spawn' ? 'spawn-failed' : 'error', worker,
                requestedCommand: NATIVE[worker], code: row.code, step: row.step, rustSupervisor: rustPid });
        } else if (row.event === 'disabled') {
            record({ event: 'disabled', worker, rustSupervisor: rustPid });
        } else if (['restart', 'kill'].includes(row.event)) {
            record({ event: row.event, worker, restartCount: row.restartCount, delayMs: row.delayMs, rustSupervisor: rustPid });
        } else throw new Error('Unexpected Rust supervisor diagnostic');
    }
    return chunk => {
        // Iterate chunks in bounded pieces so a large data event cannot grow pending.
        for (const piece of String(chunk).split(/(?<=\n)/)) {
            if (discarding) { if (piece.endsWith('\n')) discarding = false; continue; }
            if (pending.length + piece.length > 8192) {
                pending = ''; discarding = !piece.endsWith('\n'); continue;
            }
            pending += piece;
            if (pending.endsWith('\n')) { const line = pending.slice(0, -1); pending = ''; accept(line); }
        }
    };
}

function inert(worker, record, once = false) {
    const child = new EventEmitter(); child.pid = fakePid++;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false; child.exitCode = null; child.signalCode = null;
    child.kill = () => {
        if (child.killed) return true;
        child.killed = true;
        setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); });
        return true;
    };
    queueMicrotask(() => { child.emit('spawn'); if (once) child.kill(); });
    record({ event: 'spawn', worker, native: false, pid: child.pid, command: 'inert-fixture-worker' });
    return child;
}

export function createFixtureSpawn(config, spawn = actualSpawn) {
    let launched = false;
    const record = config.record || (value => appendFileSync(config.log, JSON.stringify({
        supervisor: process.pid, scope: config.scope || 'main', at: Date.now(), ...value,
    }) + '\n'));
    return (command, args = [], options = {}) => {
        if (command === '/usr/local/bin/cron_index') {
            assert(!launched, 'Node starts exactly one Rust supervisor'); launched = true;
            assert.equal(options.detached, true); assert.equal(options.uid, 65534); assert.equal(options.gid, 65534);
            assert(options.env && Object.keys(options.env).every(key => SUPERVISOR_ENV.has(key)),
                'Rust bridge environment must exclude Node options and unrelated secrets');
            assert(args.every(arg => ['--once', '--events-json'].includes(arg)), 'unexpected bridge launch arguments');
            const selected = config.selected;
            assert(selected.length && selected.every(name => Object.hasOwn(NATIVE, name)));
            assert.equal(new Set(selected).size, selected.length);
            const actualArgs = [...args.filter(arg => arg !== '--events-json'), '--workers', selected.join(','), '--events-json'];
            // Production inherits stdout. The fixture captures only this pipe
            // to observe the index's validated events without touching workers.
            const child = spawn(command, actualArgs, { ...options, stdio: ['ignore', 'pipe', 'inherit'] });
            record({ event: 'rust-supervisor', worker: 'cron_index', pid: child.pid,
                command, args: actualArgs, uid: options.uid, gid: options.gid,
                envKeys: Object.keys(options.env).sort(), selected });
            assert(child.stdout, 'bridge must expose diagnostic stdout');
            const parse = diagnosticParser({ selected, rustPid: child.pid, record, frameEvent: config.frameEvent });
            child.stdout.on('data', chunk => {
                try { parse(chunk); }
                catch (error) {
                    // A failed fixture assertion must not strand the detached group.
                    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
                    throw error;
                }
            });
            child.on('exit', (code, signal) => record({ event: 'rust-supervisor-exit', worker: 'cron_index', pid: child.pid, code, signal }));
            return child;
        }
        assert(!Object.values(NATIVE).includes(command), 'Node must never launch individual native workers');
        const worker = options.env?.CRON_WORKER_NAME;
        assert(worker && !Object.hasOwn(NATIVE, worker), 'unexpected child in isolated fixture');
        if (worker === config.typescriptWorker) {
            const child = spawn(process.execPath, [config.typescriptEntry, ...args.filter(arg => ['--once', '--dry-run'].includes(arg))], { ...options,
                env: { PATH: process.env.PATH, CRON_WORKER_NAME: worker }, stdio: ['ignore', 'pipe', 'pipe'] });
            record({ event: 'spawn', worker, native: false, actualTypescript: true, pid: child.pid,
                command: process.execPath, requestedCommand: command });
            child.once('exit', (code, signal) => record({ event: 'exit', worker, pid: child.pid, code, signal }));
            return child;
        }
        return inert(worker, record, args.includes('--once') || args.includes('--dry-run'));
    };
}

export function installCronFixture(config) {
    if (!process.argv[1]?.endsWith('/dist/workers/cron.index.js')) return;
    const uri = new URL(process.env.MONGO_URI || '');
    const scope = process.env[config.scopeEnv] || 'main';
    const relay = config.reconnect && scope === 'reconnect' && process.env.DRAGONFLY_HOST === '127.0.0.1'
        && /^\d+$/.test(process.env.DRAGONFLY_PORT || '') && Number(process.env.DRAGONFLY_PORT) > 0
        && Number(process.env.DRAGONFLY_PORT) <= 65535;
    assert(uri.hostname === 'mongo' && new RegExp(`^/${config.databasePrefix}[a-zA-Z0-9_]+$`).test(uri.pathname)
        && ((process.env.DRAGONFLY_HOST === 'redis' && process.env.DRAGONFLY_PORT === '6379') || relay),
    'Cron fixture requires disposable Mongo/Redis aliases and scoped fixture database');
    globalThis.fetch = async () => { throw new Error('Outbound provider request blocked by cron fixture'); };
    if (config.faults) installCandidateFaults(config.faults);
    globalThis[KEY] = createFixtureSpawn({ ...config, scope });
    const helper = import.meta.url;
    registerHooks({ resolve(specifier, context, nextResolve) {
        // Covers the entrypoint and an imported bridge; helper itself is outside dist.
        if (specifier === 'node:child_process' && context.parentURL?.includes('/dist/')) {
            return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
                `export * from 'node:child_process'; export { fixtureSpawn as spawn } from ${JSON.stringify(helper)};`) };
        }
        return nextResolve(specifier, context);
    } });
}
export const fixtureSpawn = (...args) => globalThis[KEY](...args);

// Test-only filesystem substitution, guarded independently of the preload.
// This runs only inside a disposable candidate; no runtime command override exists.
export function installCandidateFaults(faults) {
    const uri = new URL(process.env.MONGO_URI || '');
    assert.equal(uri.hostname, 'mongo'); assert(/_fixture_[a-zA-Z0-9_]+$/.test(uri.pathname));
    assert.equal(process.env.DRAGONFLY_HOST, 'redis');
    assert.equal(process.env.DRAGONFLY_PORT, '6379');
    assert.equal(process.getuid(), 0, 'candidate filesystem fault injection requires container root');
    readFileSync('/tmp/saas-fixtures/cron-boot.mjs');
    const owned = [];
    const restore = () => {
        for (const { binary, backup, replaced } of owned.splice(0).reverse()) {
            if (replaced) unlinkSync(binary);
            renameSync(backup, binary);
        }
    };
    try {
        for (const [worker, fault] of Object.entries(faults)) {
            assert(Object.hasOwn(NATIVE, worker));
            assert(fault === 'missing' || [7, 17].includes(fault));
            const binary = NATIVE[worker], backup = `${binary}.fixture-${process.pid}`;
            renameSync(binary, backup);
            const item = { binary, backup, replaced: false }; owned.push(item);
            if (fault !== 'missing') {
                writeFileSync(binary, `#!/bin/sh\nexit ${fault}\n`, { flag: 'wx', mode: 0o755 }); item.replaced = true;
            }
        }
    } catch (error) { restore(); throw error; }
    process.once('exit', restore);
    return () => { process.removeListener('exit', restore); restore(); };
}

export function rustRegistry({ env = process.env, once = false, names } = {}) {
    const result = spawnSync('/usr/local/bin/cron_index', ['--dry-run', ...(once ? ['--once'] : []),
        ...(names ? ['--workers', names.join(',')] : [])], { env, uid: 65534, gid: 65534,
        encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    assert.equal(result.status, 0, 'real Rust registry dry-run must succeed');
    const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1);
    assert(lines[0].startsWith('cron_index:'));
    const row = JSON.parse(lines[0].slice('cron_index:'.length)); assert.equal(row.event, 'dry-run');
    for (const worker of row.workers) assertNativeMetadata(worker);
    return row.workers;
}

export function assertSelectedNatives(rows, selected) {
    for (const row of rows.filter(row => row.event === 'spawn' && row.native)) {
        assert(selected.includes(row.worker), 'unselected native must be absent, never a fake');
        assert(Number.isSafeInteger(row.rustSupervisor) && row.rustSupervisor > 0);
        assert.notEqual(row.supervisor, row.rustSupervisor, 'Node and Rust supervisor identities differ');
    }
    const bridges = rows.filter(row => row.event === 'rust-supervisor');
    assert.equal(bridges.length, 1); assert.deepEqual(bridges[0].selected, selected);
    for (const worker of Object.keys(NATIVE).filter(name => !selected.includes(name))) {
        assert(!rows.some(row => row.worker === worker), `${worker} must be unselected`);
    }
}
