import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions, spawn as spawnType } from 'node:child_process';
import { NativeIndexBridge, NATIVE_INDEX_DEFINITION, NATIVE_INDEX_ENV_KEYS, NATIVE_BRIDGE_SHUTDOWN_MS,
    resolveNativeIndexLaunch, type NativeBridgeConfig, type NativeBridgeDependencies, type NativeBridgeFailure } from './cron_native_bridge.js';

const config: NativeBridgeConfig = { once: false, dryRun: false };
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

class Clock {
    now = 0;
    delays: number[] = [];
    private next = 1;
    private timers = new Map<number, { at: number; callback: () => void }>();
    setTimeout = ((callback: () => void, ms = 0) => {
        const id = this.next++;
        this.delays.push(ms); this.timers.set(id, { at: this.now + ms, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
        this.timers.delete(id as unknown as number);
    }) as typeof clearTimeout;
    advance(ms: number): void {
        this.now += ms;
        for (const [id, timer] of [...this.timers]) if (timer.at <= this.now) {
            this.timers.delete(id); timer.callback();
        }
    }
}

class FakeChild extends EventEmitter {
    pid: number | undefined = 4321;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
        this.exitCode = code; this.signalCode = signal;
        this.emit('exit', code, signal); this.emit('close', code, signal);
    }
}

function fixture(overrides: Partial<NativeBridgeConfig> = {}, deps: Partial<NativeBridgeDependencies> = {}) {
    const child = new FakeChild(), clock = new Clock();
    const launches: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const signals: [number, NodeJS.Signals][] = [], failures: NativeBridgeFailure[] = [], order: string[] = [];
    const bridge = new NativeIndexBridge({ ...config, ...overrides }, {
        spawn: ((command: string, args: string[], options: SpawnOptions) => {
            launches.push({ command, args, options }); return child as unknown as ChildProcess;
        }) as typeof spawnType,
        signal: (pid, signal) => { signals.push([pid, signal]); order.push(`${pid}:${signal}`); },
        onFailure: failure => { failures.push(failure); order.push('host-failure'); },
        getuid: () => 0, env: {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ...deps,
    });
    return { bridge, child, clock, launches, signals, failures, order };
}

test('bridge launch is one fixed detached unprivileged index with inherited stdout/stderr', () => {
    assert.deepEqual(NATIVE_INDEX_DEFINITION, { name: 'cron_index', command: '/usr/local/bin/cron_index' });
    assert(Object.isFrozen(NATIVE_INDEX_DEFINITION));
    for (const once of [false, true]) for (const dryRun of [false, true]) {
        const launch = resolveNativeIndexLaunch({ once, dryRun }, {}, 0);
        assert.deepEqual(launch, { command: '/usr/local/bin/cron_index',
            args: [...(dryRun ? ['--dry-run'] : []), ...(once ? ['--once'] : [])],
            options: { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: {}, uid: 65534, gid: 65534 } });
        for (const uid of [1000, 65534]) {
            const options = resolveNativeIndexLaunch({ once, dryRun }, {}, uid).options;
            assert.equal(options.uid, undefined); assert.equal(options.gid, undefined);
        }
    }
});

test('start uses the injected identity and environment without changing the TS host identity', async () => {
    const f = fixture({ once: true }, { getuid: () => 1000, env: { MONGO_URI: 'fixture', SECRET_KEY: 'ts-only' } });
    f.bridge.start();
    assert.equal(f.launches[0].options.uid, undefined); assert.equal(f.launches[0].options.gid, undefined);
    assert.deepEqual(f.launches[0].options.env, { MONGO_URI: 'fixture' });
    f.child.finish(); await f.bridge.wait();
});

test('bridge receives exactly the required environment union, never general credentials or Node settings', () => {
    const expectedKeys = [
        'MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
        'DRAGONFLY_HOST', 'DRAGONFLY_PORT', 'CLIENT_ID', 'CLIENT_SECRET',
        'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
        'AI_USAGE_RECEIPTS_ENABLED', 'AI_USAGE_RECEIPTS_INTERVAL_MS', 'AI_USAGE_RECEIPTS_BATCH_SIZE',
        'AI_USAGE_RECEIPTS_LOCK_KEY', 'AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS',
        'AI_USAGE_QUEUE_MAX_AGE_SECONDS', 'AI_USAGE_PROCESSING_MAX_AGE_SECONDS', 'AI_USAGE_QUEUE_FAILURE_THRESHOLD',
        'OBSERVABILITY_DISABLED', 'CRON_WORKER_RESTART_DELAY_MS',
    ];
    assert.deepEqual([...NATIVE_INDEX_ENV_KEYS].sort(), expectedKeys.sort());
    const expectedEnv = Object.fromEntries(expectedKeys.map(key => [key, `fixture-${key}`]));
    const excluded = ['SECRET_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
        'DRAGONFLY_PASSWORD', 'TWITCH_TOKEN', 'TWITCH_BOT_TOKEN', 'TWITCH_CLIENT_SECRET',
        'POLAR_ACCESS_TOKEN', 'STRIPE_SECRET_KEY', 'CRON_SUPERVISOR', 'CRON_WORKER_NAME',
        'CRON_WORKER_RUNTIME', 'HOME', 'RUST_LOG', 'OTHER_SETTING', 'AI_USAGE_UNRECOGNIZED'];
    const env = { ...expectedEnv, ...Object.fromEntries(excluded.map(key => [key, 'never-inherit'])) };
    const launch = resolveNativeIndexLaunch(config, env, 0);
    assert.deepEqual(launch.options.env, expectedEnv);
    assert.deepEqual(resolveNativeIndexLaunch(config, { MONGO_URI: 'fixture', PATH: '/usr/bin', LANG: '' }, 1000).options.env,
        { MONGO_URI: 'fixture', PATH: '/usr/bin', LANG: '' });
    assert.equal(launch.args.includes('--events-json'), false);
    assert.equal(launch.args.includes('--env-file'), false);
    assert.equal(env.SECRET_KEY, 'never-inherit');
});

test('start is idempotent and never respawns an index after it exits', async () => {
    const f = fixture(); f.bridge.start(); f.bridge.start();
    assert.equal(f.launches.length, 1); assert.equal(f.bridge.process, f.child);
    f.child.finish(); await f.bridge.wait(); f.bridge.start();
    assert.equal(f.launches.length, 1); assert.equal(f.bridge.exitCode, 1);
    assert.equal(f.failures.length, 1);
});

test('normal index failure cleans its entire captured group before failing the host exactly once', async () => {
    for (const event of ['error', 'exit', 'exit-zero', 'close', 'signal']) {
        const f = fixture(); f.bridge.start();
        if (event === 'error') f.child.emit('error', new Error('fixture'));
        else if (event === 'close') f.child.emit('close', 0, null);
        else f.child.finish(event === 'exit-zero' ? 0 : event === 'signal' ? null : 3, event === 'signal' ? 'SIGKILL' : null);
        f.child.emit('error', new Error('late')); f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
        await f.bridge.wait();
        assert.deepEqual(f.signals, [[-4321, 'SIGKILL']]);
        assert.deepEqual(f.order, ['-4321:SIGKILL', 'host-failure']);
        assert.equal(f.bridge.exitCode, 1); assert.equal(f.bridge.process, null); assert.equal(f.failures.length, 1);
        await f.bridge.shutdown(); f.clock.advance(28000); assert.equal(f.signals.length, 1);
    }
});

test('once and dry-run exits are finite, keep failure status, and still remove orphan group members', async () => {
    for (const overrides of [{ once: true }, { dryRun: true }, { once: true, dryRun: true }]) for (const code of [0, 7]) {
        const f = fixture(overrides); f.bridge.start(); f.child.finish(code); await f.bridge.wait();
        assert.equal(f.bridge.exitCode, code); assert.equal(f.failures.length, 0);
        assert.deepEqual(f.signals, [[-4321, 'SIGKILL']]);
    }
});

test('shutdown signals only the index PID, waits up to 28s, then kills its group', async () => {
    const f = fixture(); f.bridge.start();
    const stopping = f.bridge.shutdown(); let done = false;
    assert.equal(f.bridge.shutdown(), stopping);
    void stopping.then(() => { done = true; });
    assert.deepEqual(f.signals, [[4321, 'SIGTERM']]); assert.deepEqual(f.clock.delays, [28000]);
    f.clock.advance(25000); await flush(); assert(!done); assert.equal(f.signals.length, 1);
    f.clock.advance(2999); await flush(); assert(!done); assert.equal(f.signals.length, 1);
    f.clock.advance(1); await stopping;
    assert.deepEqual(f.signals, [[4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
    assert.equal(f.bridge.exitCode, 1); assert.equal(f.failures.length, 0);
    f.child.finish(); f.child.emit('error', new Error('late')); assert.equal(f.signals.length, 2);
    assert.equal(NATIVE_BRIDGE_SHUTDOWN_MS, 28000);
});

test('clean shutdown after the native drain cancels the outer timeout and cleans remaining children', async () => {
    const f = fixture(); f.bridge.start(); const stopping = f.bridge.shutdown();
    f.clock.advance(27000); f.child.finish();
    await stopping; f.clock.advance(10000);
    assert.equal(f.bridge.exitCode, 0); assert.equal(f.failures.length, 0);
    assert.deepEqual(f.signals, [[4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
});

test('startup exceptions and failed exec close cannot leave a restart timer or unowned children', async () => {
    const f = fixture({}, { spawn: (() => { throw new Error('missing'); }) as typeof spawnType });
    f.bridge.start(); await f.bridge.wait(); await f.bridge.shutdown();
    assert.equal(f.bridge.exitCode, 1); assert.equal(f.failures.length, 1); assert.deepEqual(f.signals, []);
    assert.deepEqual(f.clock.delays, []);
    for (const pid of [undefined, 0, 1, -2, NaN, 1.5]) {
        const failed = fixture(); failed.child.pid = pid; failed.bridge.start();
        failed.child.emit('error', new Error('failed exec')); failed.child.emit('close', -2, null);
        await failed.bridge.wait(); await failed.bridge.shutdown();
        assert.equal(failed.bridge.exitCode, 1); assert.equal(failed.failures.length, 1);
        assert.deepEqual(failed.signals, []);
    }
});

test('cleanup uses only the originally captured PID and ignores stale exit/close events', async () => {
    const f = fixture({ once: true }); f.bridge.start(); f.child.pid = 9999;
    f.child.finish(); await f.bridge.wait(); f.child.emit('close', 0, null);
    assert.deepEqual(f.signals, [[-4321, 'SIGKILL']]);
});

test('shutdown before spawn notification still terminates only the newly captured index', async () => {
    const f = fixture(); f.child.pid = undefined; f.bridge.start();
    const stopping = f.bridge.shutdown(); assert.deepEqual(f.signals, []);
    f.child.pid = 7654; f.child.emit('spawn');
    assert.deepEqual(f.signals, [[7654, 'SIGTERM']]);
    f.child.finish(); await stopping;
    assert.deepEqual(f.signals, [[7654, 'SIGTERM'], [-7654, 'SIGKILL']]);
    assert.equal(f.bridge.exitCode, 0);
});

test('failed-start terminal fence also cleans a PID arriving in a late spawn event', async () => {
    const f = fixture(); f.child.pid = undefined; f.bridge.start();
    f.child.emit('error', new Error('fixture')); await f.bridge.wait();
    f.child.pid = 8765; f.child.emit('spawn'); f.child.emit('close', 0, null);
    assert.deepEqual(f.signals, [[-8765, 'SIGKILL']]); assert.equal(f.failures.length, 1);
});

test('already-gone groups are harmless but denied cleanup remains a failed once result', async () => {
    for (const [code, expected] of [['ESRCH', 0], ['EPERM', 1]] as const) {
        const f = fixture({ once: true }, { signal: () => { throw Object.assign(new Error('fixture'), { code }); } });
        f.bridge.start(); f.child.finish(); await f.bridge.wait();
        assert.equal(f.bridge.exitCode, expected);
    }
});

test('shutdown before start prevents any later launch', async () => {
    const f = fixture(); await f.bridge.shutdown(); f.bridge.start();
    assert.equal(f.bridge.exitCode, 0); assert.equal(f.launches.length, 0); assert.deepEqual(f.signals, []);
});
