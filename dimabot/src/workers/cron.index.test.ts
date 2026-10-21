import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn as spawnType } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WORKERS, WorkerSupervisor, resolveWorkerLaunch, type SupervisorConfig, type WorkerDefinition } from './cron.index.js';

const stream = WORKERS.find(worker => worker.name === 'stream-activity')!;
const raid = WORKERS.find(worker => worker.name === 'raid-analytics')!;
const baseline = WORKERS.find(worker => worker.name === 'follow-defense-baseline')!;
const roulette = WORKERS.find(worker => worker.name === 'roulette-completion')!;
const receipts = WORKERS.find(worker => worker.name === 'ai-usage-receipts')!;
const sessions = WORKERS.find(worker => worker.name === 'raid-sessions')!;
const dashboard = WORKERS.find(worker => worker.name === 'dashboard-activity')!;
const nativeDefinitions = [stream, raid, baseline, roulette, receipts, sessions, dashboard];
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
function fixture(once = false, definitions: WorkerDefinition[] = [stream], overrides: Partial<SupervisorConfig> = {}) {
    const children: FakeChild[] = [], metrics: string[] = [], commands: string[] = [];
    let stops = 0;
    const supervisor = new WorkerSupervisor({ ...config, once, ...overrides }, definitions, {
        spawn: ((command: string) => {
            commands.push(command);
            const child = new FakeChild(); children.push(child);
            queueMicrotask(() => child.emit('spawn'));
            return child as unknown as ChildProcess;
        }) as typeof spawnType,
        metrics: () => () => { stops++; },
        info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
        observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
    });
    return { supervisor, children, metrics, commands, stops: () => stops };
}

test('only seven known workers use Rust; flags, privilege drop and environment are explicit', () => {
    assert.equal(WORKERS.filter(worker => worker.name === 'stream-activity').length, 1);
    const env = { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', SECRET_KEY: 'secret', TWITCH_TOKEN: 'private', DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' };
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
    const nativeBaseline = resolveWorkerLaunch(baseline, { ...config, once: true, dryRun: true }, env, 0);
    assert.equal(nativeBaseline.command, '/usr/local/bin/follow_defense_baseline');
    assert.deepEqual(nativeBaseline.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(nativeBaseline.options.env, { ...native.options.env, DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' });
    assert.equal(nativeBaseline.options.uid, 65534); assert.equal(nativeBaseline.options.gid, 65534);
    const nativeDashboard = resolveWorkerLaunch(dashboard, { ...config, once: true, dryRun: true }, env, 0);
    assert.equal(nativeDashboard.command, '/usr/local/bin/dashboard_activity');
    assert.deepEqual(nativeDashboard.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(nativeDashboard.options.env, { ...native.options.env, DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' });
    assert.equal(nativeDashboard.options.uid, 65534); assert.equal(nativeDashboard.options.gid, 65534);
    for (const definition of WORKERS.filter(worker => !nativeDefinitions.includes(worker))) assert(!resolveWorkerLaunch(definition, config, env, 0).native);
});

test('dashboard child receives only Twitch credentials, proxy settings and Dragonfly host/port beyond the Mongo environment', () => {
    const env = {
        MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', LANG: 'C', SECRET_KEY: 'secret', TWITCH_TOKEN: 'private',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', DRAGONFLY_PASSWORD: 'private',
        CLIENT_ID: 'fixture-client', CLIENT_SECRET: 'fixture-secret',
        HTTPS_PROXY: 'http://proxy.internal:3128', HTTP_PROXY: 'http://proxy.internal:3128',
        ALL_PROXY: 'socks5://proxy.internal:1080', NO_PROXY: 'localhost,127.0.0.1',
        https_proxy: 'http://lower.internal:3128', http_proxy: 'http://lower.internal:3128',
        all_proxy: 'socks5://lower.internal:1080', no_proxy: 'mongo,redis',
        SSL_CERT_FILE: '/fixtures/ca.pem', SSL_CERT_DIR: '/fixtures/certs',
    };
    const native = resolveWorkerLaunch(dashboard, { ...config, once: true, dryRun: true }, env, 0);
    assert(native.native);
    assert.equal(native.command, '/usr/local/bin/dashboard_activity');
    assert.deepEqual(native.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(native.options.env, {
        MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', LANG: 'C',
        SSL_CERT_FILE: '/fixtures/ca.pem', SSL_CERT_DIR: '/fixtures/certs',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379',
        CLIENT_ID: 'fixture-client', CLIENT_SECRET: 'fixture-secret',
        HTTPS_PROXY: 'http://proxy.internal:3128', HTTP_PROXY: 'http://proxy.internal:3128',
        ALL_PROXY: 'socks5://proxy.internal:1080', NO_PROXY: 'localhost,127.0.0.1',
        https_proxy: 'http://lower.internal:3128', http_proxy: 'http://lower.internal:3128',
        all_proxy: 'socks5://lower.internal:1080', no_proxy: 'mongo,redis',
    });
    assert.equal(native.options.uid, 65534); assert.equal(native.options.gid, 65534);
    assert.equal(resolveWorkerLaunch(dashboard, config, env, 1000).options.uid, undefined);
    // Unset settings stay unset: the child must apply its own defaults.
    assert.deepEqual(resolveWorkerLaunch(dashboard, config, { MONGO_URI: 'fixture-only', PATH: '/usr/bin' }, 1000).options.env,
        { MONGO_URI: 'fixture-only', PATH: '/usr/bin' });
    // No TypeScript fallback entrypoint survives the migration.
    assert(!('sourceEntry' in dashboard) && !('distEntry' in dashboard));
});

const retiredSelectors = ['STREAM_ACTIVITY_RUNTIME', 'RAID_ANALYTICS_RUNTIME', 'FOLLOW_DEFENSE_BASELINE_RUNTIME',
    'ROULETTE_COMPLETION_RUNTIME', 'AI_USAGE_RECEIPTS_RUNTIME'];

test('raid-sessions runs as the sixth native child with only Dragonfly host/port beyond the Mongo environment', () => {
    assert.equal(WORKERS.filter(worker => worker.name === 'raid-sessions').length, 1);
    const env = { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', LANG: 'C', SECRET_KEY: 'secret',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', DRAGONFLY_PASSWORD: 'private', TWITCH_TOKEN: 'private',
        AI_USAGE_RECEIPTS_ENABLED: 'true' };
    const native = resolveWorkerLaunch(sessions, { ...config, once: true, dryRun: true }, env, 0);
    assert(native.native);
    assert.equal(native.command, '/usr/local/bin/raid_sessions');
    assert.deepEqual(native.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(native.options.env, { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', LANG: 'C',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' });
    assert.equal(native.options.uid, 65534); assert.equal(native.options.gid, 65534);
    assert.equal(resolveWorkerLaunch(sessions, config, env, 1000).options.uid, undefined);
    // No TypeScript fallback entrypoint survives the migration.
    assert(!('sourceEntry' in sessions) && !('distEntry' in sessions));
});

test('RAID_SESSIONS_RUNTIME was never a selector and cannot alter the native raid-sessions launch', () => {
    // The five retired keys above had real TypeScript implementations. This key
    // is a hypothetical rollback switch that never existed; it must stay inert
    // rather than imply a restorable TypeScript raid-sessions worker.
    const env = { MONGO_URI: 'fixture-only', PATH: '/usr/bin', DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' };
    const expected = resolveWorkerLaunch(sessions, { ...config, runtime: 'tsx' }, env, 0);
    for (const value of ['typescript', 'rust', '1', '']) {
        const launch = resolveWorkerLaunch(sessions, { ...config, runtime: 'tsx' }, { ...env, RAID_SESSIONS_RUNTIME: value }, 0);
        assert.deepEqual(launch, expected);
        assert(launch.native);
        assert.equal(launch.command, '/usr/local/bin/raid_sessions');
    }
});

test('all seven native definitions have no TypeScript entrypoints and ignore obsolete selectors in both runtimes', () => {
    assert.equal(WORKERS.filter(worker => worker.kind === 'native').length, 7);
    for (const worker of nativeDefinitions) {
        assert.equal(worker.kind, 'native');
        assert(!('sourceEntry' in worker)); assert(!('distEntry' in worker));
        for (const runtime of ['node', 'tsx'] as const) {
            // Stale callers cannot restore the retired configuration switches either.
            const staleConfig = { ...config, runtime, streamActivityRuntime: 'typescript', raidAnalyticsRuntime: 'typescript',
                followDefenseBaselineRuntime: 'typescript', rouletteCompletionRuntime: 'typescript', aiUsageReceiptsRuntime: 'typescript' };
            for (const value of ['typescript', 'rust', '', 'invalid']) {
                const env = { MONGO_URI: 'fixture-only', PATH: '/usr/bin', ...Object.fromEntries(retiredSelectors.map(key => [key, value])) };
                const launch = resolveWorkerLaunch(worker, staleConfig, env, 0);
                assert(launch.native, `${worker.name} must remain native under ${runtime} with retired value ${value}`);
                assert(launch.command.startsWith('/usr/local/bin/'));
                assert(!launch.args.some(arg => /\.(?:ts|js)$/.test(arg)));
                assert.deepEqual(launch.options.env, { MONGO_URI: 'fixture-only', PATH: '/usr/bin' });
            }
        }
    }
});

test('TypeScript definitions retain node and tsx entrypoints, supervisor environment and flags', () => {
    const env = { MONGO_URI: 'fixture-only', SECRET_KEY: 'fixture-secret' };
    for (const worker of WORKERS) {
        if (worker.kind !== 'typescript') continue;
        for (const runtime of ['node', 'tsx'] as const) {
            const launch = resolveWorkerLaunch(worker, { ...config, runtime, once: true, dryRun: true }, env, 0);
            assert.equal(launch.native, false);
            assert.equal(launch.command, runtime === 'tsx' ? 'tsx' : process.execPath);
            assert(launch.args[0].endsWith(runtime === 'tsx' ? worker.sourceEntry : `/workers/${path.basename(worker.distEntry)}`));
            assert.deepEqual(launch.args.slice(1), ['--dry-run', '--once']);
            assert.deepEqual(launch.options.env, { ...env, CRON_SUPERVISOR: 'true', CRON_WORKER_NAME: worker.name });
            assert.equal(launch.options.stdio, 'inherit'); assert.equal(launch.options.uid, undefined);
        }
    }
    const custom: WorkerDefinition = { kind: 'typescript', name: 'constructor', sourceEntry: 'src/custom.ts', distEntry: 'dist/custom.js' };
    assert.equal(resolveWorkerLaunch(custom, config, env, 0).native, false);
});

// The discriminant also protects future registry entries at compile time.
// @ts-expect-error A TypeScript worker must declare its entrypoints.
const missingTypeScriptEntries: WorkerDefinition = { kind: 'typescript', name: 'fixture' };
// @ts-expect-error A native worker cannot retain a TypeScript fallback entrypoint.
const nativeWithFallback: WorkerDefinition = { kind: 'native', name: 'raid-analytics', sourceEntry: 'src/fixture.ts', distEntry: 'dist/fixture.js' };
void missingTypeScriptEntries; void nativeWithFallback;

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

test('baseline missing executable reports errors and retries native without fallback', async () => {
    const commands: string[] = [], metrics: string[] = [];
    const supervisor = new WorkerSupervisor(config, [baseline], {
        spawn: ((command: string) => { commands.push(command); throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); }) as typeof spawnType,
        info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
        observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
    });
    supervisor.start(); await delay(15);
    await supervisor.shutdown('SIGTERM', 50);
    assert(commands.length >= 2);
    assert(commands.every(command => command === '/usr/local/bin/follow_defense_baseline'));
    assert(metrics.includes('follow_defense_baseline_rust.errors'));
    assert(metrics.includes('follow_defense_baseline_rust.restarts'));
});


test('roulette selection retains Mongo-only child privileges', () => {
    assert.equal(WORKERS.filter(worker => worker.name === 'roulette-completion').length, 1);
    const env = { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', SECRET_KEY: 'secret',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', TWITCH_TOKEN: 'private' };
    const native = resolveWorkerLaunch(roulette, { ...config, once: true, dryRun: true }, env, 0);
    assert(native.native);
    assert.equal(native.command, '/usr/local/bin/roulette_completion');
    assert.deepEqual(native.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(native.options.env, { MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC' });
    assert.equal(native.options.uid, 65534); assert.equal(native.options.gid, 65534);
    assert.equal(resolveWorkerLaunch(roulette, config, env, 1000).options.uid, undefined);

});

test('roulette missing executable records errors and retries native without fallback', async () => {
    const commands: string[] = [], metrics: string[] = [];
    const supervisor = new WorkerSupervisor(config, [roulette], {
        spawn: ((command: string) => { commands.push(command); throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); }) as typeof spawnType,
        info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
        observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
    });
    supervisor.start(); await delay(15);
    await supervisor.shutdown('SIGTERM', 50);
    assert(commands.length >= 2);
    assert(commands.every(command => command === '/usr/local/bin/roulette_completion'));
    assert(metrics.includes('roulette_completion_rust.errors'));
    assert(metrics.includes('roulette_completion_rust.restarts'));
});

test('roulette process failure restarts only roulette and fences late telemetry', async () => {
    const f = fixture(false, [stream, raid, baseline, roulette]); f.supervisor.start(); await delay(0);
    const child = f.children[3];
    const frame = 'roulette_completion:{"event":"batch","events":100,"durationMs":2,"success":true}\n';
    child.stdout.write(frame);
    assert(f.metrics.includes('roulette_completion_rust.batch_channels'));
    const before = f.metrics.length;
    child.emit('error', new Error('fixture failure')); child.stdout.write(frame); child.finish(1);
    await delay(15);
    assert.equal(f.children.length, 5);
    assert.deepEqual(f.commands.slice(3), ['/usr/local/bin/roulette_completion', '/usr/local/bin/roulette_completion']);
    assert.deepEqual(f.supervisor.workers.map(worker => worker.restartCount), [0, 0, 0, 1]);
    for (let index = 0; index < 3; index++) assert.equal(f.supervisor.workers[index].process, f.children[index]);
    assert.deepEqual(f.metrics.slice(before), ['roulette_completion_rust.errors', 'roulette_completion_rust.restarts']);
    for (const active of [f.children[0], f.children[1], f.children[2], f.children[4]]) active.closeOnTerm = true;
    const closing = f.supervisor.shutdown('SIGTERM', 50);
    f.children[4].stdout.write(frame); await closing;
    assert.equal(f.metrics.filter(name => name === 'roulette_completion_rust.batch_channels').length, 1);
    assert.equal(f.stops(), 5);
});

test('receipts child receives only its own queue settings, Dragonfly host/port and unprivileged identity', () => {
    assert.equal(WORKERS.filter(worker => worker.name === 'ai-usage-receipts').length, 1);
    const env = {
        MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', LANG: 'C',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', DRAGONFLY_PASSWORD: 'private',
        AI_USAGE_RECEIPTS_ENABLED: 'true', AI_USAGE_RECEIPTS_INTERVAL_MS: '250', AI_USAGE_RECEIPTS_BATCH_SIZE: '50',
        AI_USAGE_RECEIPTS_LOCK_KEY: 'fixture:lock', AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS: '120',
        AI_USAGE_QUEUE_MAX_AGE_SECONDS: '600', AI_USAGE_PROCESSING_MAX_AGE_SECONDS: '600', AI_USAGE_QUEUE_FAILURE_THRESHOLD: '5',
        POLAR_ACCESS_TOKEN: 'private', STRIPE_SECRET_KEY: 'private', TWITCH_TOKEN: 'private', SECRET_KEY: 'private',
    };
    const native = resolveWorkerLaunch(receipts, { ...config, once: true, dryRun: true }, env, 0);
    assert(native.native);
    assert.equal(native.command, '/usr/local/bin/ai_usage_receipts');
    assert.deepEqual(native.args, ['--telemetry-json', '--dry-run', '--once']);
    assert.deepEqual(native.options.env, {
        MONGO_URI: 'fixture-only', PATH: '/usr/bin', TZ: 'UTC', LANG: 'C',
        DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379',
        AI_USAGE_RECEIPTS_ENABLED: 'true', AI_USAGE_RECEIPTS_INTERVAL_MS: '250', AI_USAGE_RECEIPTS_BATCH_SIZE: '50',
        AI_USAGE_RECEIPTS_LOCK_KEY: 'fixture:lock', AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS: '120',
        AI_USAGE_QUEUE_MAX_AGE_SECONDS: '600', AI_USAGE_PROCESSING_MAX_AGE_SECONDS: '600', AI_USAGE_QUEUE_FAILURE_THRESHOLD: '5',
    });
    assert.equal(native.options.uid, 65534); assert.equal(native.options.gid, 65534);
    assert.equal(resolveWorkerLaunch(receipts, config, env, 1000).options.uid, undefined);
    // Unset settings stay unset: the child must apply its own defaults.
    assert.deepEqual(resolveWorkerLaunch(receipts, config, { MONGO_URI: 'fixture-only', PATH: '/usr/bin' }, 1000).options.env,
        { MONGO_URI: 'fixture-only', PATH: '/usr/bin' });

});

test('receipts missing executable records errors and retries native without fallback', async () => {
    const commands: string[] = [], metrics: string[] = [];
    const supervisor = new WorkerSupervisor(config, [receipts], {
        spawn: ((command: string) => { commands.push(command); throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); }) as typeof spawnType,
        info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
        observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
    });
    supervisor.start(); await delay(15);
    await supervisor.shutdown('SIGTERM', 50);
    assert(commands.length >= 2);
    assert(commands.every(command => command === '/usr/local/bin/ai_usage_receipts'));
    assert(metrics.includes('ai_usage_receipts_rust.errors'));
    assert(metrics.includes('ai_usage_receipts_rust.restarts'));
});

test('receipts process failure restarts only receipts and fences late telemetry', async () => {
    const f = fixture(false, [...nativeDefinitions]); f.supervisor.start(); await delay(0);
    const child = f.children[4];
    const frame = 'ai_usage_receipts:{"event":"batch","events":1000,"durationMs":250000,"success":true}\n';
    child.stdout.write(frame);
    assert(f.metrics.includes('ai_usage_receipts_rust.batch_receipts'));
    const before = f.metrics.length;
    child.emit('error', new Error('fixture failure')); child.stdout.write(frame); child.finish(1);
    await delay(15);
    assert.equal(f.children.length, 8);
    assert.deepEqual(f.commands.slice(4), ['/usr/local/bin/ai_usage_receipts', '/usr/local/bin/raid_sessions',
        '/usr/local/bin/dashboard_activity', '/usr/local/bin/ai_usage_receipts']);
    assert.deepEqual(f.supervisor.workers.map(worker => worker.restartCount), [0, 0, 0, 0, 1, 0, 0]);
    for (const index of [0, 1, 2, 3, 5, 6]) assert.equal(f.supervisor.workers[index].process, f.children[index]);
    assert.deepEqual(f.metrics.slice(before), ['ai_usage_receipts_rust.errors', 'ai_usage_receipts_rust.restarts']);
    for (const active of [f.children[0], f.children[1], f.children[2], f.children[3], f.children[5], f.children[6], f.children[7]])
        active.closeOnTerm = true;
    const closing = f.supervisor.shutdown('SIGTERM', 50);
    f.children[7].stdout.write(frame); await closing;
    assert.equal(f.metrics.filter(name => name === 'ai_usage_receipts_rust.batch_receipts').length, 1);
    assert.equal(f.stops(), 8);
});


test('every native worker retries its own executable under node and tsx when binaries are missing', async () => {
    const saved = retiredSelectors.map(key => process.env[key]);
    for (const key of retiredSelectors) process.env[key] = 'typescript';
    try {
        for (const runtime of ['node', 'tsx'] as const) for (const definition of nativeDefinitions) {
            const commands: string[] = [], metrics: string[] = [];
            const supervisor = new WorkerSupervisor({ ...config, runtime }, [definition], {
                spawn: ((command: string) => { commands.push(command); throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); }) as typeof spawnType,
                info: async () => ({ success: true }), warn: async () => ({ success: true }), error: async () => ({ success: true }),
                observe: (_kind, name) => { metrics.push(name); }, recordLog: () => {},
            });
            supervisor.start(); await delay(15);
            await supervisor.shutdown('SIGTERM', 50);
            const expected = resolveWorkerLaunch(definition, { ...config, runtime }).command;
            assert(commands.length >= 2, `${definition.name} retries under ${runtime}`);
            assert(commands.every(command => command === expected));
            assert(metrics.some(name => name.endsWith('.errors')));
            assert(metrics.some(name => name.endsWith('.restarts')));
        }
    } finally {
        retiredSelectors.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    }
});

test('native enabledEnv still prevents a disabled receipts child while starting its sibling', async () => {
    const previous = process.env.AI_USAGE_RECEIPTS_ENABLED;
    process.env.AI_USAGE_RECEIPTS_ENABLED = 'false';
    try {
        const f = fixture(true, [receipts, stream], { runtime: 'tsx' });
        f.supervisor.start(); await delay(0);
        assert.deepEqual(f.commands, ['/usr/local/bin/stream_activity']);
        assert.equal(f.supervisor.workers[0].exitCode, 0);
        f.children[0].closeOnTerm = true;
        await f.supervisor.shutdown('SIGTERM', 50);
    } finally {
        if (previous === undefined) delete process.env.AI_USAGE_RECEIPTS_ENABLED; else process.env.AI_USAGE_RECEIPTS_ENABLED = previous;
    }
});


test('each native child keeps restart isolation, stale-event fencing and shutdown under both launcher modes', async () => {
    // Protocol prefix and batch metric for each of the seven native children; the
    // raid sessions and dashboard activity children are batch-only.
    const protocols = ['stream_activity', 'raid_analytics', 'follow_defense_baseline', 'roulette_completion',
        'ai_usage_receipts', 'raid_sessions', 'dashboard_activity'];
    const batches = ['batch_events', 'batch_channels', 'batch_channels', 'batch_channels', 'batch_receipts', 'batch_items', 'batch_events'];
    for (const runtime of ['node', 'tsx'] as const) for (let index = 0; index < nativeDefinitions.length; index++) {
        const f = fixture(false, nativeDefinitions, { runtime });
        f.supervisor.start(); await delay(0);
        const first = f.children[index], prefix = `${protocols[index]}_rust`;
        const metric = `${prefix}.${batches[index]}`;
        const frame = `${protocols[index]}:{"event":"batch","events":1,"durationMs":2,"success":true}\n`;
        first.stdout.write(frame);
        assert.equal(f.metrics.filter(name => name === metric).length, 1);
        const before = f.metrics.length;
        first.emit('error', new Error('fixture child failure'));
        first.stdout.write(frame); first.finish(1);
        await delay(15);
        const replacement = f.children[nativeDefinitions.length];
        assert.equal(f.children.length, nativeDefinitions.length + 1);
        assert.equal(f.commands[nativeDefinitions.length], f.commands[index]);
        assert.deepEqual(f.metrics.slice(before), [`${prefix}.errors`, `${prefix}.restarts`]);
        assert.equal(f.supervisor.workers[index].restartCount, 1);
        assert.equal(f.supervisor.workers[index].process, replacement);
        first.emit('close', 1, null);
        assert.equal(f.supervisor.workers[index].process, replacement);
        f.supervisor.workers.forEach((worker, sibling) => {
            if (sibling !== index) { assert.equal(worker.process, f.children[sibling]); assert.equal(worker.restartCount, 0); }
            (worker.process as unknown as FakeChild).closeOnTerm = true;
        });
        const closing = f.supervisor.shutdown('SIGTERM', 50);
        replacement.stdout.write(frame); await closing;
        assert.equal(f.metrics.filter(name => name === metric).length, 1);
        assert.equal(f.stops(), nativeDefinitions.length + 1);
        assert(f.supervisor.workers.every(worker => worker.process === null));
    }
});
