import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import childProcess, { type ChildProcess, type SpawnOptions, type spawn as spawnType } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import dotenv from 'dotenv';
import type { SupervisorConfig, WorkerDefinition } from './cron.index.js';

// Importing the supervisor must not load environment files or launch anything.
const envMock = mock.method(dotenv, 'config', () => { throw new Error('unexpected environment load'); });
const spawnMock = mock.method(childProcess, 'spawn', () => { throw new Error('unexpected process launch'); });
syncBuiltinESMExports();
const { WORKERS, WorkerSupervisor, CronHost, TYPESCRIPT_SHUTDOWN_MS, resolveWorkerLaunch, resolveSupervisorConfig } = await import('./cron.index.js');
const importCalls = [envMock.mock.callCount(), spawnMock.mock.callCount()];
envMock.mock.restore(); spawnMock.mock.restore(); syncBuiltinESMExports();

const config: SupervisorConfig = { runtime: 'node', once: false, dryRun: false, restartDelayMs: 5000 };
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
        const end = this.now + ms;
        for (;;) {
            const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            this.now = next[1].at; this.timers.delete(next[0]); next[1].callback();
        }
        this.now = end;
    }
}

class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: NodeJS.Signals[] = [];
    closeOnTerm = false;
    constructor(readonly pid: number) { super(); }
    kill(signal: NodeJS.Signals): boolean {
        this.signals.push(signal);
        if (signal === 'SIGKILL' || this.closeOnTerm) queueMicrotask(() => this.finish(signal === 'SIGKILL' ? 1 : 0));
        return true;
    }
    finish(code = 0): void {
        this.exitCode = code; this.emit('exit', code, null); this.emit('close', code, null);
    }
}

function fixture(overrides: Partial<SupervisorConfig> = {}, definitions: WorkerDefinition[] = WORKERS.slice(0, 2),
    env: NodeJS.ProcessEnv = {}) {
    const children: FakeChild[] = [], launches: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const errors: unknown[] = [], signals: [number, NodeJS.Signals][] = [], clock = new Clock();
    const dependencies = {
        spawn: ((command: string, args: string[], options: SpawnOptions) => {
            launches.push({ command, args, options });
            const child = new FakeChild(1000 + children.length); children.push(child);
            queueMicrotask(() => child.emit('spawn'));
            return child as unknown as ChildProcess;
        }) as typeof spawnType,
        signal: (pid: number, signal: NodeJS.Signals) => {
            signals.push([pid, signal]);
            if (pid > 0) {
                const child = children.find(candidate => candidate.pid === pid)!;
                if (child.closeOnTerm) queueMicrotask(() => child.finish());
            }
        },
        getuid: () => 0, env, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        info: async () => ({ success: true }), warn: async () => ({ success: true }),
        error: async (data: unknown) => { errors.push(data); return { success: true }; },
    };
    return { children, launches, errors, signals, clock, dependencies, config: { ...config, ...overrides }, definitions };
}

test('helper imports never read dotenv files or launch processes', () => {
    assert.deepEqual(importCalls, [0, 0]);
});

test('registry contains exactly the remaining 19 TS workers in their existing order', async () => {
    assert.deepEqual(WORKERS.map(worker => worker.name), [
        'goals', 'duel', 'widgets', 'credit-gifts', 'semantic-moderation', 'roulette-actions',
        'follow-defense-actions', 'follow-defense', 'follow-ledger', 'stream-analytics', 'domain-events',
        'eventsub-reconciliation', 'free-credit-reset', 'ai-usage-backfill', 'stream-memory',
        'temporary-roles', 'timer', 'activation-reminder', 'vod-clip-recommender',
    ]);
    assert(WORKERS.every(worker => worker.kind === 'typescript'));
    const f = fixture({}, WORKERS, { EVENTSUB_RECONCILIATION_ENABLED: 'false' });
    const supervisor = new WorkerSupervisor(f.config, f.definitions, f.dependencies);
    supervisor.start(); supervisor.start();
    assert.equal(f.launches.length, 18);
    assert(!f.launches.some(launch => launch.options.env?.CRON_WORKER_NAME === 'eventsub-reconciliation'));
    assert(f.launches.every(launch => launch.command === process.execPath));
    for (const child of f.children) child.closeOnTerm = true;
    await supervisor.shutdown('SIGTERM');
});

test('TS enabled rules disable only the exact false value', async () => {
    const gated = WORKERS.filter(worker => worker.enabledEnv);
    assert.deepEqual(gated.map(worker => worker.enabledEnv), [
        'EVENTSUB_RECONCILIATION_ENABLED', 'FREE_CREDIT_RESET_ENABLED', 'AI_USAGE_BACKFILL_ENABLED',
    ]);
    for (const value of [undefined, 'true', 'False', '0', '', 'false ', 'false']) {
        const f = fixture({ once: true }, gated, Object.fromEntries(gated.map(worker => [worker.enabledEnv!, value])));
        const supervisor = new WorkerSupervisor(f.config, gated, f.dependencies);
        supervisor.start();
        assert.equal(f.children.length, value === 'false' ? 0 : gated.length);
        f.children.forEach(child => child.finish()); await supervisor.wait();
        assert(supervisor.workers.every(worker => worker.exitCode === 0));
    }
});

test('node/tsx selection, complete TS environment, stdio and flag combinations are preserved', () => {
    const env = { SECRET_KEY: 'ts-only', NODE_OPTIONS: '--trace-warnings', OTHER_SETTING: 'preserved',
        CRON_SUPERVISOR: 'wrong', CRON_WORKER_NAME: 'wrong' };
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    for (const runtime of ['node', 'tsx'] as const) for (const once of [false, true]) for (const dryRun of [false, true]) {
        for (const definition of WORKERS) {
            const launch = resolveWorkerLaunch(definition, { ...config, runtime, once, dryRun }, env);
            assert.equal(launch.command, runtime === 'node' ? process.execPath : 'tsx');
            assert.deepEqual(launch.args, [runtime === 'node' ? path.resolve(moduleDirectory, path.basename(definition.distEntry))
                : path.resolve(process.cwd(), definition.sourceEntry), ...(dryRun ? ['--dry-run'] : []), ...(once ? ['--once'] : [])]);
            assert.deepEqual(launch.options, { stdio: 'inherit', env: { ...env, CRON_SUPERVISOR: 'true', CRON_WORKER_NAME: definition.name } });
        }
    }
    assert.equal(env.CRON_SUPERVISOR, 'wrong');
});

test('restart config retains 5s default, 1s minimum and finite-number fallback', () => {
    assert.deepEqual(resolveSupervisorConfig({}, []), config);
    for (const [value, expected] of [['', 5000], ['0', 1000], ['-5', 1000], ['500', 1000],
        [' ', 1000], ['1000', 1000], ['7500', 7500], ['NaN', 5000], ['Infinity', 5000], ['bad', 5000]] as const) {
        assert.equal(resolveSupervisorConfig({ CRON_WORKER_RESTART_DELAY_MS: value }, []).restartDelayMs, expected);
    }
    assert.deepEqual(resolveSupervisorConfig({ CRON_WORKER_RUNTIME: 'tsx' }, ['--dry-run', '--once']),
        { ...config, runtime: 'tsx', dryRun: true, once: true });
    assert.equal(resolveSupervisorConfig({ CRON_WORKER_RUNTIME: 'other' }, []).runtime, 'node');
});

test('TS child failure schedules only its own restart at the existing delay and fences stale events', async () => {
    const f = fixture(), supervisor = new WorkerSupervisor(f.config, f.definitions, f.dependencies);
    supervisor.start(); await flush();
    const [first, sibling] = f.children;
    first.emit('error', new Error('fixture')); first.emit('error', new Error('duplicate')); first.finish(1);
    first.emit('close', 1, null);
    assert.deepEqual(supervisor.workers.map(worker => worker.restartCount), [1, 0]);
    f.clock.advance(4999); assert.equal(f.children.length, 2);
    f.clock.advance(1); assert.equal(f.children.length, 3);
    assert.equal(supervisor.workers[1].process, sibling);
    first.emit('close', 0, null); first.emit('error', new Error('late'));
    assert.equal(supervisor.workers[0].process, f.children[2]);
    assert.equal(f.errors.length, 1);
    sibling.closeOnTerm = true; f.children[2].closeOnTerm = true;
    await supervisor.shutdown('SIGTERM');
});

test('TS synchronous and asynchronous spawn failures aggregate in once mode without retry', async () => {
    const f = fixture({ once: true }), supervisor = new WorkerSupervisor(f.config, f.definitions, {
        ...f.dependencies, spawn: ((...args: Parameters<typeof spawnType>) => {
            if (f.launches.length === 0) {
                f.launches.push({ command: 'fixture', args: [], options: {} }); throw new Error('missing');
            }
            return f.dependencies.spawn(...args);
        }) as typeof spawnType,
    });
    supervisor.start();
    f.children[0].emit('error', new Error('failed exec')); f.children[0].emit('close', -2, null);
    await supervisor.wait(); f.clock.advance(50000);
    assert.deepEqual(supervisor.workers.map(worker => worker.exitCode), [1, 1]);
    assert.deepEqual(supervisor.workers.map(worker => worker.restartCount), [0, 0]);
    assert.equal(f.launches.length, 2);
});

test('TS synchronous launch failure keeps the same delayed self-healing path in normal mode', async () => {
    const f = fixture(); let attempts = 0;
    const supervisor = new WorkerSupervisor(f.config, f.definitions, { ...f.dependencies,
        spawn: ((...args: Parameters<typeof spawnType>) => {
            if (++attempts === 1) throw Object.assign(new Error('fixture'), { code: 'ENOENT' });
            return f.dependencies.spawn(...args);
        }) as typeof spawnType });
    supervisor.start(); assert.equal(attempts, 2); assert.equal(f.children.length, 1);
    f.clock.advance(4999); assert.equal(attempts, 2);
    f.clock.advance(1); assert.equal(attempts, 3);
    assert.deepEqual(supervisor.workers.map(worker => worker.restartCount), [1, 0]);
    f.children.forEach(child => { child.closeOnTerm = true; }); await supervisor.shutdown('SIGTERM');
});

test('TS shutdown cancels pending restarts and shares one 25s grace across children', async () => {
    const f = fixture(), supervisor = new WorkerSupervisor(f.config, f.definitions, f.dependencies);
    supervisor.start(); f.children[0].finish(1);
    const stopping = supervisor.shutdown('SIGTERM');
    assert.equal(supervisor.shutdown('SIGINT'), stopping);
    assert.deepEqual(f.children[1].signals, ['SIGTERM']);
    f.clock.advance(24999); await flush();
    assert.equal(f.children.length, 2); assert.deepEqual(f.children[1].signals, ['SIGTERM']);
    f.clock.advance(1); await stopping; await flush();
    assert.deepEqual(f.children[1].signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(supervisor.workers[1].process, null);
    supervisor.start(); f.clock.advance(50000); assert.equal(f.children.length, 2);
    assert.equal(TYPESCRIPT_SHUTDOWN_MS, 25000);
});

test('normal host launches exactly one Rust owner and only TS workers through the same spawn hook', async () => {
    for (const runtime of ['node', 'tsx'] as const) {
        const f = fixture({ runtime }, WORKERS, { EVENTSUB_RECONCILIATION_ENABLED: 'false', SECRET_KEY: 'ts-only' });
        const host = new CronHost(f.config, WORKERS, f.dependencies);
        host.start(); host.start(); await flush();
        assert.equal(f.launches.length, 19);
        assert.deepEqual(f.launches.filter(launch => launch.command.startsWith('/usr/local/bin/')).map(launch => launch.command),
            ['/usr/local/bin/cron_index']);
        assert.equal(f.launches[0].options.env?.SECRET_KEY, undefined);
        assert(f.launches.slice(1).every(launch => launch.options.env?.SECRET_KEY === 'ts-only'));
        f.children.forEach(child => { child.closeOnTerm = true; });
        assert.equal(await host.shutdown('SIGTERM'), 0); assert.equal(await host.wait(), 0);
    }
});

test('TS restart remains independent of the native index with no Node native sampling or respawn', async () => {
    const f = fixture(), host = new CronHost(f.config, f.definitions, f.dependencies);
    host.start(); const native = f.children[0];
    f.children[1].finish(1); f.clock.advance(5000);
    assert.equal(host.native.process, native); assert.equal(f.children.length, 4);
    assert.deepEqual(f.launches.map(launch => launch.command), ['/usr/local/bin/cron_index', process.execPath, process.execPath, process.execPath]);
    assert.deepEqual(f.signals, []);
    for (const child of [native, f.children[2], f.children[3]]) child.closeOnTerm = true;
    await host.shutdown('SIGTERM');
});

test('host once waits for both owners and propagates either owner failure', async () => {
    for (const [nativeCode, tsCode] of [[0, 0], [1, 0], [0, 1], [4, 9]]) {
        const f = fixture({ once: true }), host = new CronHost(f.config, f.definitions, f.dependencies);
        host.start(); let done = false;
        void host.wait().then(() => { done = true; });
        f.children[0].finish(nativeCode); f.children[1].finish(tsCode); await flush();
        assert(!done); assert(!host.stopping);
        f.children[2].finish();
        assert.equal(await host.wait(), nativeCode === 0 && tsCode === 0 ? 0 : 1);
        assert.equal(await host.shutdown('SIGTERM'), nativeCode === 0 && tsCode === 0 ? 0 : 1);
        f.clock.advance(10000); assert.equal(f.children.length, 3);
        assert.deepEqual(f.signals, [[-f.children[0].pid, 'SIGKILL']]);
    }
});

test('native failed exec in once mode records failure while remaining TS work completes', async () => {
    const f = fixture({ once: true }), host = new CronHost(f.config, f.definitions, f.dependencies);
    host.start(); f.children[0].emit('error', new Error('fixture')); f.children[0].emit('close', -2, null);
    assert(!host.stopping); assert(f.children.slice(1).every(child => child.signals.length === 0));
    f.children.slice(1).forEach(child => child.finish());
    assert.equal(await host.wait(), 1); assert.equal(f.launches.length, 3);
    assert.deepEqual(f.signals, [[-f.children[0].pid, 'SIGKILL']]);
});

test('native index crash, error or clean unexpected exit kills its group and shuts TS down once', async () => {
    for (const event of ['error', 'exit-zero', 'exit-failure', 'close-only']) {
        const f = fixture(), host = new CronHost(f.config, f.definitions, f.dependencies);
        host.start();
        f.children[1].finish(1); // A pending restart must not survive host failure.
        const native = f.children[0];
        f.children[2].closeOnTerm = true;
        if (event === 'error') native.emit('error', new Error('fixture'));
        else if (event === 'close-only') native.emit('close', 0, null);
        else native.finish(event === 'exit-zero' ? 0 : 3);
        native.emit('error', new Error('late')); native.emit('exit', 0, null); native.emit('close', 0, null);
        assert.equal(await host.wait(), 1);
        assert(host.stopping); assert(host.typescript.stopping);
        assert.deepEqual(f.children[2].signals, ['SIGTERM']);
        assert.deepEqual(f.signals, [[-native.pid, 'SIGKILL']]);
        assert.equal(f.errors.length, 1);
        f.clock.advance(100000); host.start(); assert.equal(f.children.length, 3);
    }
});

test('native synchronous startup failure launches no TS children and fails the host', async () => {
    const f = fixture(), host = new CronHost(f.config, f.definitions, { ...f.dependencies,
        spawn: (() => { throw new Error('missing index'); }) as typeof spawnType });
    host.start(); assert.equal(await host.wait(), 1);
    assert.equal(f.children.length, 0); assert.deepEqual(f.signals, []);
    f.clock.advance(50000); host.start(); assert.equal(f.errors.length, 1);
});

test('parallel shutdown gives TS 25s and Rust 28s, then returns failure if the index hangs', async () => {
    const f = fixture(), host = new CronHost(f.config, f.definitions, f.dependencies);
    host.start(); const native = f.children[0];
    let done = false;
    const stopping = host.shutdown('SIGINT');
    assert.equal(host.shutdown('SIGTERM'), stopping);
    void stopping.then(() => { done = true; });
    assert.deepEqual(f.signals, [[native.pid, 'SIGTERM']]);
    assert(f.children.slice(1).every(child => child.signals.length === 1));
    assert.deepEqual(f.clock.delays, [25000, 28000]);
    f.clock.advance(24999); await flush(); assert(!done);
    f.clock.advance(1); await flush();
    assert(f.children.slice(1).every(child => child.signals.includes('SIGKILL')));
    assert.deepEqual(f.signals, [[native.pid, 'SIGTERM']]); assert(!done);
    f.clock.advance(2999); await flush(); assert(!done);
    f.clock.advance(1); assert.equal(await stopping, 1); assert.equal(await host.wait(), 1);
    assert.deepEqual(f.signals, [[native.pid, 'SIGTERM'], [-native.pid, 'SIGKILL']]);
});

test('normal shutdown lets Rust coordinate its full grace and cleans its group after clean exit', async () => {
    const f = fixture(), host = new CronHost(f.config, f.definitions, f.dependencies);
    host.start(); f.children.slice(1).forEach(child => { child.closeOnTerm = true; });
    const stopping = host.shutdown('SIGTERM');
    f.clock.advance(25000); await flush();
    assert.deepEqual(f.signals, [[f.children[0].pid, 'SIGTERM']]);
    f.clock.advance(2000); f.children[0].finish();
    assert.equal(await stopping, 0); assert.equal(await host.wait(), 0);
    f.clock.advance(10000);
    assert.deepEqual(f.signals, [[f.children[0].pid, 'SIGTERM'], [-f.children[0].pid, 'SIGKILL']]);
});

test('dry-run flag semantics reach the Rust owner and TS children without native worker launches', async () => {
    for (const once of [false, true]) {
        const f = fixture({ dryRun: true, once }), host = new CronHost(f.config, f.definitions, f.dependencies);
        host.start();
        const flags = ['--dry-run', ...(once ? ['--once'] : [])];
        assert.deepEqual(f.launches[0].args, flags);
        assert(f.launches.slice(1).every(launch => JSON.stringify(launch.args.slice(1)) === JSON.stringify(flags)));
        f.children[0].finish(); await flush(); assert(!host.stopping);
        if (once) { f.children.slice(1).forEach(child => child.finish()); assert.equal(await host.wait(), 0); }
        else {
            f.children[1].finish(); f.clock.advance(5000);
            assert.equal(f.children.length, 4); // Existing TS dry-run restart behavior.
            for (const child of [f.children[2], f.children[3]]) child.closeOnTerm = true;
            assert.equal(await host.shutdown('SIGTERM'), 0);
        }
        assert.equal(f.launches.filter(launch => launch.command.startsWith('/usr/local/bin/')).length, 1);
    }
});
