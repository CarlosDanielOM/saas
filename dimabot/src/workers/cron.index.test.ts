import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn as spawnType } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WORKERS, WorkerSupervisor, resolveNativeRuntimes, resolveWorkerLaunch, type SupervisorConfig, type WorkerDefinition } from './cron.index.js';

const stream = WORKERS.find(worker => worker.name === 'stream-activity')!;
const raid = WORKERS.find(worker => worker.name === 'raid-analytics')!;
const config: SupervisorConfig = { runtime: 'node', once: false, dryRun: false, restartDelayMs: 5 };
class FakeChild extends EventEmitter {
    pid = 123;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    stdout = new PassThrough();
    signals: NodeJS.Signals[] = [];
    closeOnTerm = false;
    kill(signal: NodeJS.Signals): boolean {
        this.signals.push(signal);
        if (signal === 'SIGKILL' || this.closeOnTerm) queueMicrotask(() => this.finish(0, signal));
        return true;
    }
    finish(code = 0, signal: NodeJS.Signals | null = null): void {
        this.exitCode = code; this.signalCode = signal;
        this.emit('exit', code, signal); this.emit('close', code, signal); this.stdout.destroy();
    }
}
function fixture(once = false, definitions: WorkerDefinition[] = [stream]) {
    const children: FakeChild[] = [], metrics: string[] = [];
    let stops = 0;
    const supervisor = new WorkerSupervisor({ ...config, once }, definitions, {
        spawn: ((..._args: unknown[]) => {
            const child = new FakeChild(); children.push(child);
            queueMicrotask(() => child.emit('spawn'));
            return child as unknown as ChildProcess;
        }) as typeof spawnType,
        metrics: () => () => { stops++; },
        info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
        observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
    });
    return { supervisor, children, metrics, stops: () => stops };
}

test('only two known projectors use Rust; flags, privilege drop and environment are explicit', () => {
    assert.equal(WORKERS.filter(worker => worker.name === 'stream-activity').length, 1);
    const env = { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', SECRET_KEY: 'secret', TWITCH_TOKEN: 'private', DRAGONFLY_HOST: 'redis' };
    const native = resolveWorkerLaunch(stream, { ...config, once: true, dryRun: true }, env, 0);
    assert.equal(native.command, '/usr/local/bin/stream_activity');
    assert.deepEqual(native.args, ['--batch-size', '500', '--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(native.options.env, { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC' });
    assert.equal(native.options.uid, 65534); assert.equal(native.options.gid, 65534);
    assert.equal(resolveWorkerLaunch(stream, config, env, 1000).options.uid, undefined);
    const nativeRaid = resolveWorkerLaunch(raid, { ...config, once: true, dryRun: true }, env, 0);
    assert.equal(nativeRaid.command, '/usr/local/bin/raid_analytics');
    assert.deepEqual(nativeRaid.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(nativeRaid.options.env, native.options.env);
    assert.equal(nativeRaid.options.uid, 65534); assert.equal(nativeRaid.options.gid, 65534);
    for (const definition of WORKERS.filter(worker => worker !== stream && worker !== raid)) assert(!resolveWorkerLaunch(definition, config, env, 0).native);
    assert(!resolveWorkerLaunch(stream, { ...config, streamActivityRuntime: 'typescript' }, env, 0).native);
    assert(!resolveWorkerLaunch(stream, { ...config, runtime: 'tsx' }, env, 0).native);
    assert(resolveWorkerLaunch(stream, { ...config, runtime: 'tsx', streamActivityRuntime: 'rust' }, env, 0).native);
    assert(!resolveWorkerLaunch(raid, { ...config, raidAnalyticsRuntime: 'typescript' }, env, 0).native);
    assert(!resolveWorkerLaunch(raid, { ...config, runtime: 'tsx' }, env, 0).native);
    assert(resolveWorkerLaunch(raid, { ...config, runtime: 'tsx', raidAnalyticsRuntime: 'rust' }, env, 0).native);
    assert(resolveWorkerLaunch(raid, { ...config, streamActivityRuntime: 'typescript' }, env, 0).native);
    assert(resolveWorkerLaunch(stream, { ...config, raidAnalyticsRuntime: 'typescript' }, env, 0).native);
    assert(!resolveWorkerLaunch({ ...raid, name: 'constructor' }, config, env, 0).native);
    const tsRaid = resolveWorkerLaunch(raid, { ...config, runtime: 'tsx' }, env, 0);
    assert.equal(tsRaid.command, 'tsx');
    assert(tsRaid.args[0].endsWith('/src/workers/raid_analytics.worker.ts'));
    const jsRaid = resolveWorkerLaunch(raid, { ...config, raidAnalyticsRuntime: 'typescript' }, env, 0);
    assert.equal(jsRaid.command, process.execPath);
    assert(jsRaid.args[0].endsWith('/workers/raid_analytics.worker.js'));
    assert.equal(jsRaid.options.env?.CRON_WORKER_NAME, 'raid-analytics');
});

test('both runtime environment selectors reject invalid values before bootstrap starts workers', () => {
    assert.deepEqual(resolveNativeRuntimes({ STREAM_ACTIVITY_RUNTIME: 'rust', RAID_ANALYTICS_RUNTIME: 'typescript' }),
        { streamActivityRuntime: 'rust', raidAnalyticsRuntime: 'typescript' });
    assert.deepEqual(resolveNativeRuntimes({}), { streamActivityRuntime: undefined, raidAnalyticsRuntime: undefined });
    for (const key of ['STREAM_ACTIVITY_RUNTIME', 'RAID_ANALYTICS_RUNTIME']) {
        for (const value of ['', 'Rust', '/tmp/arbitrary']) assert.throws(() => resolveNativeRuntimes({ [key]: value }), new RegExp(key));
    }
});

test('error plus exit and close schedule one restart, stop metrics, and never fall back to TS', async () => {
    const f = fixture(); f.supervisor.start(); await delay(0);
    const first = f.children[0];
    first.emit('error', new Error('fixture error'));
    first.finish(1);
    await delay(15);
    assert.equal(f.children.length, 2);
    assert.equal(f.supervisor.workers[0].restartCount, 1);
    assert.equal(f.stops(), 1);
    // A late stale close cannot clear the current child's health slot.
    first.emit('close', 1, null);
    assert.equal(f.supervisor.workers[0].process, f.children[1]);
    f.children[1].closeOnTerm = true;
    await f.supervisor.shutdown('SIGTERM', 50);
    assert.equal(f.stops(), 2);
    assert.equal(f.metrics.filter(name => name.endsWith('.restarts')).length, 1);
});

test('failed spawn close exits once mode and does not restart', async () => {
    const f = fixture(true); f.supervisor.start();
    f.children[0].emit('error', new Error('missing binary'));
    f.children[0].emit('close', -2, null);
    await f.supervisor.wait(); await delay(15);
    assert.equal(f.supervisor.workers[0].exitCode, 1);
    assert.equal(f.children.length, 1);
});

test('shutdown cancels pending restart and waits for graceful close before its deadline', async () => {
    const f = fixture(); f.supervisor.start(); await delay(0);
    const child = f.children[0];
    let complete = false;
    const closing = f.supervisor.shutdown('SIGTERM', 100).then(() => { complete = true; });
    await delay(15);
    assert(!complete); assert.deepEqual(child.signals, ['SIGTERM']);
    child.finish(); await closing; await delay(15);
    assert.equal(f.children.length, 1); assert.equal(f.stops(), 1);
    const pending = fixture(); pending.supervisor.start(); pending.children[0].finish(1);
    await pending.supervisor.shutdown('SIGTERM', 50); await delay(15);
    assert.equal(pending.children.length, 1);
});

test('shutdown kills only surviving task children after the deadline', async () => {
    const f = fixture(); f.supervisor.start(); await delay(0);
    await f.supervisor.shutdown('SIGTERM', 15); await delay(0);
    assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(f.supervisor.workers[0].process, null);
    assert.equal(f.stops(), 1);
});

test('raid restart and telemetry stay independent of stream activity and fence late output', async () => {
    const f = fixture(false, [stream, raid]); f.supervisor.start(); await delay(0);
    const [streamChild, raidChild] = f.children;
    const frame = 'raid_analytics:{"event":"batch","events":1,"durationMs":2,"success":true}\n';
    raidChild.stdout.write(frame);
    assert(f.metrics.includes('raid_analytics_rust.batch_channels'));
    assert(!f.metrics.includes('stream_activity_rust.batch_channels'));
    const before = f.metrics.length;
    raidChild.emit('error', new Error('fixture error'));
    raidChild.stdout.write(frame);
    raidChild.finish(1);
    await delay(15);
    assert.equal(f.children.length, 3);
    assert.equal(f.supervisor.workers[0].process, streamChild);
    assert.equal(f.supervisor.workers[0].restartCount, 0);
    assert.equal(f.supervisor.workers[1].restartCount, 1);
    assert.deepEqual(f.metrics.slice(before), ['raid_analytics_rust.errors', 'raid_analytics_rust.restarts']);
    for (const child of [streamChild, f.children[2]]) child.closeOnTerm = true;
    const closing = f.supervisor.shutdown('SIGTERM', 50);
    f.children[2].stdout.write(frame);
    await closing;
    assert.equal(f.metrics.filter(name => name === 'raid_analytics_rust.batch_channels').length, 1);
    assert.equal(f.stops(), 3);
});

test('synchronous native raid spawn failure records its own error and restart', async () => {
    const metrics: string[] = [];
    const supervisor = new WorkerSupervisor(config, [raid], {
        spawn: (() => { throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); }) as typeof spawnType,
        info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
        observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
    });
    supervisor.start();
    assert.equal(supervisor.workers[0].exitCode, 1);
    assert.deepEqual(metrics, ['raid_analytics_rust.errors', 'raid_analytics_rust.restarts']);
    await supervisor.shutdown('SIGTERM', 50);
    await delay(15);
    assert.equal(supervisor.workers[0].restartCount, 1);
});

test('native output can drain after exit but cannot emit telemetry after close', async () => {
    const f = fixture(true, [raid]); f.supervisor.start(); await delay(0);
    const child = f.children[0];
    const frame = 'raid_analytics:{"event":"batch","events":1,"durationMs":2,"success":true}\n';
    child.emit('exit', 0, null);
    child.stdout.write(frame);
    assert.equal(f.metrics.filter(name => name === 'raid_analytics_rust.batch_channels').length, 1);
    child.emit('close', 0, null);
    child.stdout.write(frame);
    assert.equal(f.metrics.filter(name => name === 'raid_analytics_rust.batch_channels').length, 1);
    child.stdout.destroy();
    await f.supervisor.wait();
});
