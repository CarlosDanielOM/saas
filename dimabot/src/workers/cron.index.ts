import path from 'node:path';
import dotenv from 'dotenv';

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { error as logError, info as logInfo, warn as logWarn } from '../utils/logger.js';
import { observe, recordLog, startTelemetry } from '../utils/observability/telemetry.js';
import { NATIVE_WORKERS, nativeWorker, nativeProgressParser, startNativeWorkerMetrics, type NativeWorkerName } from '../utils/observability/native_worker_metrics.js';

export interface WorkerDefinition {
    name: string;
    sourceEntry: string;
    distEntry: string;
    enabledEnv?: string;
}

export interface SupervisorConfig {
    runtime: 'tsx' | 'node';
    streamActivityRuntime?: string;
    raidAnalyticsRuntime?: string;
    followDefenseBaselineRuntime?: string;
    rouletteCompletionRuntime?: string;
    aiUsageReceiptsRuntime?: string;
    once: boolean;
    dryRun: boolean;
    restartDelayMs: number;
}

export interface ManagedWorker {
    definition: WorkerDefinition;
    process: ChildProcess | null;
    restartCount: number;
    exitCode: number | null;
}

export const WORKERS: WorkerDefinition[] = [
    { name: 'dashboard-activity', sourceEntry: 'src/workers/dashboard_activity.worker.ts', distEntry: 'dist/workers/dashboard_activity.worker.js' },
    { name: 'raid-analytics', sourceEntry: 'src/workers/raid_analytics.worker.ts', distEntry: 'dist/workers/raid_analytics.worker.js' },
    { name: 'stream-activity', sourceEntry: 'src/workers/stream_activity.worker.ts', distEntry: 'dist/workers/stream_activity.worker.js' },
    { name: 'goals', sourceEntry: 'src/workers/goals.worker.ts', distEntry: 'dist/workers/goals.worker.js' },
    { name: 'duel', sourceEntry: 'src/workers/duel.worker.ts', distEntry: 'dist/workers/duel.worker.js' },
    { name: 'widgets', sourceEntry: 'src/workers/widgets.worker.ts', distEntry: 'dist/workers/widgets.worker.js' },
    { name: 'credit-gifts', sourceEntry: 'src/workers/credit_gifts.worker.ts', distEntry: 'dist/workers/credit_gifts.worker.js' },
    { name: 'semantic-moderation', sourceEntry: 'src/workers/semantic_moderation.worker.ts', distEntry: 'dist/workers/semantic_moderation.worker.js' },
    { name: 'roulette-actions', sourceEntry: 'src/workers/roulette-actions.worker.ts', distEntry: 'dist/workers/roulette-actions.worker.js' },
    { name: 'roulette-completion', sourceEntry: 'src/workers/roulette.worker.ts', distEntry: 'dist/workers/roulette.worker.js' },
    { name: 'follow-defense-baseline', sourceEntry: 'src/workers/follow_defense_baseline.worker.ts', distEntry: 'dist/workers/follow_defense_baseline.worker.js' },
    { name: 'raid-sessions', sourceEntry: 'src/workers/raid_sessions.worker.ts', distEntry: 'dist/workers/raid_sessions.worker.js' },
    {
        name: 'follow-defense-actions',
        sourceEntry: 'src/workers/follow_defense_actions.worker.ts',
        distEntry: 'dist/workers/follow_defense_actions.worker.js'
    },
    {
        name: 'follow-defense',
        sourceEntry: 'src/workers/follow_defense.worker.ts',
        distEntry: 'dist/workers/follow_defense.worker.js'
    },
    {
        name: 'follow-ledger',
        sourceEntry: 'src/workers/follow_ledger.worker.ts',
        distEntry: 'dist/workers/follow_ledger.worker.js'
    },
    {
        name: 'stream-analytics',
        sourceEntry: 'src/workers/stream_analytics.worker.ts',
        distEntry: 'dist/workers/stream_analytics.worker.js'
    },
    {
        name: 'domain-events',
        sourceEntry: 'src/workers/domain_events.worker.ts',
        distEntry: 'dist/workers/domain_events.worker.js'
    },
    {
        name: 'eventsub-reconciliation',
        sourceEntry: 'src/workers/eventsub_reconciliation.worker.ts',
        distEntry: 'dist/workers/eventsub_reconciliation.worker.js',
        enabledEnv: 'EVENTSUB_RECONCILIATION_ENABLED'
    },
    {
        name: 'free-credit-reset',
        sourceEntry: 'src/workers/free_credit_reset.worker.ts',
        distEntry: 'dist/workers/free_credit_reset.worker.js',
        enabledEnv: 'FREE_CREDIT_RESET_ENABLED'
    },
    {
        name: 'ai-usage-receipts',
        sourceEntry: 'src/workers/ai_usage_receipts.worker.ts',
        distEntry: 'dist/workers/ai_usage_receipts.worker.js',
        enabledEnv: 'AI_USAGE_RECEIPTS_ENABLED'
    },
    {
        name: 'ai-usage-backfill',
        sourceEntry: 'src/workers/ai_usage_backfill.worker.ts',
        distEntry: 'dist/workers/ai_usage_backfill.worker.js',
        enabledEnv: 'AI_USAGE_BACKFILL_ENABLED'
    },
    {
        name: 'stream-memory',
        sourceEntry: 'src/workers/stream_memory.worker.ts',
        distEntry: 'dist/workers/stream_memory.worker.js'
    },
    {
        name: 'temporary-roles',
        sourceEntry: 'src/workers/temporary_roles.worker.ts',
        distEntry: 'dist/workers/temporary_roles.worker.js'
    },
    {
        name: 'timer',
        sourceEntry: 'src/workers/timer.worker.ts',
        distEntry: 'dist/workers/timer.worker.js'
    },
    {
        name: 'activation-reminder',
        sourceEntry: 'src/workers/activation-reminder.worker.ts',
        distEntry: 'dist/workers/activation-reminder.worker.js'
    },
    {
        name: 'vod-clip-recommender',
        sourceEntry: 'src/workers/vod_clip_recommender.worker.ts',
        distEntry: 'dist/workers/vod_clip_recommender.worker.js'
    }
];

export function resolveWorkerLaunch(worker: WorkerDefinition, config: SupervisorConfig,
    env: NodeJS.ProcessEnv = process.env, uid: number | undefined = process.getuid?.()): {
    command: string; args: string[]; options: SpawnOptions; native: boolean;
} {
    const metadata = nativeWorker(worker.name);
    const selectedRuntime = metadata ? config[metadata.runtimeConfig] : undefined;
    const native = Boolean(metadata && (selectedRuntime === 'rust'
        || (selectedRuntime !== 'typescript' && config.runtime !== 'tsx')));
    const flags = [...(config.dryRun ? ['--dry-run'] : []), ...(config.once ? ['--once'] : [])];
    if (native && metadata) {
        const childEnv: NodeJS.ProcessEnv = {};
        const allowed = ['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', ...metadata.extraEnv];
        for (const key of allowed) {
            if (env[key] !== undefined) childEnv[key] = env[key];
        }
        return { command: metadata.command, args: [...metadata.args, ...flags],
            options: { stdio: ['ignore', 'pipe', 'inherit'], env: childEnv, ...(uid === 0 ? { uid: 65534, gid: 65534 } : {}) }, native };
    }
    const entry = config.runtime === 'tsx' ? path.resolve(process.cwd(), worker.sourceEntry)
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), path.basename(worker.distEntry));
    return { command: config.runtime === 'tsx' ? 'tsx' : process.execPath, args: [entry, ...flags],
        options: { stdio: 'inherit', env: { ...env, CRON_SUPERVISOR: 'true', CRON_WORKER_NAME: worker.name } }, native };
}

interface SupervisorDependencies {
    spawn: typeof spawn;
    metrics: typeof startNativeWorkerMetrics;
    progress: typeof nativeProgressParser;
    info: typeof logInfo;
    warn: typeof logWarn;
    error: typeof logError;
    observe: typeof observe;
    recordLog: typeof recordLog;
}

export class WorkerSupervisor {
    readonly workers: ManagedWorker[];
    stopping = false;
    private readonly dependencies: SupervisorDependencies;
    private readonly restarts = new Map<ManagedWorker, ReturnType<typeof setTimeout>>();
    private readonly children = new Map<ChildProcess, Promise<void>>();
    private readonly stopSampling = new Map<ChildProcess, () => void>();

    constructor(private readonly config: SupervisorConfig, definitions: WorkerDefinition[] = WORKERS,
        dependencies: Partial<SupervisorDependencies> = {}) {
        this.dependencies = { spawn, metrics: startNativeWorkerMetrics, progress: nativeProgressParser,
            info: logInfo, warn: logWarn, error: logError, observe, recordLog, ...dependencies };
        this.workers = definitions.map(definition => ({ definition, process: null, restartCount: 0,
            exitCode: this.enabled(definition) ? null : 0 }));
    }

    private enabled(worker: WorkerDefinition): boolean {
        return !worker.enabledEnv || process.env[worker.enabledEnv] !== 'false';
    }

    start(): void {
        for (const managed of this.workers) {
            if (this.enabled(managed.definition)) this.startWorker(managed);
            else void this.dependencies.info({ worker: 'cron_supervisor', message: 'Cron worker disabled; not starting',
                name: managed.definition.name, enabledEnv: managed.definition.enabledEnv }, { destination: 'console' });
        }
    }

    private scheduleRestart(managed: ManagedWorker, native: boolean): void {
        if (this.stopping || this.config.once || this.restarts.has(managed)) return;
        managed.restartCount += 1;
        if (native) this.dependencies.observe('worker', `${nativeWorker(managed.definition.name)!.metricPrefix}.restarts`, 1, 'error');
        const timer = setTimeout(() => {
            this.restarts.delete(managed);
            if (!this.stopping) this.startWorker(managed);
        }, this.config.restartDelayMs);
        this.restarts.set(managed, timer);
    }

    private startWorker(managed: ManagedWorker): void {
        if (this.stopping || managed.process) return;
        const launch = resolveWorkerLaunch(managed.definition, this.config);
        let child: ChildProcess;
        try { child = this.dependencies.spawn(launch.command, launch.args, launch.options); }
        catch (error) {
            managed.exitCode = 1;
            this.workerError(managed, launch.native, 'spawn', error);
            this.scheduleRestart(managed, launch.native);
            return;
        }
        managed.process = child;
        let stopMetrics: (() => void) | undefined;
        let failed = false, exited = false, finalized = false;
        let resolveClosed!: () => void;
        this.children.set(child, new Promise<void>(resolve => { resolveClosed = resolve; }));
        const stop = (): void => { stopMetrics?.(); stopMetrics = undefined; };
        this.stopSampling.set(child, stop);
        child.once('spawn', () => {
            if (launch.native && child.pid && !this.stopping && !exited && !failed) {
                stopMetrics = this.dependencies.metrics(child.pid, {}, managed.definition.name as NativeWorkerName);
            }
            void this.dependencies.info({ worker: 'cron_supervisor', message: 'Started cron worker process',
                name: managed.definition.name, pid: child.pid, runtime: launch.native ? 'rust' : this.config.runtime,
                restartCount: managed.restartCount }, { destination: 'console' });
        });
        if (launch.native && child.stdout) {
            const progress = this.dependencies.progress(this.dependencies.observe, managed.definition.name as NativeWorkerName);
            child.stdout.on('data', chunk => {
                // Pipes may drain after exit; close is the ownership fence.
                if (!this.stopping && !failed && !finalized && managed.process === child) progress(chunk);
            });
        }
        child.once('error', error => { failed = true; stop(); this.workerError(managed, launch.native, 'process', error); });
        child.once('exit', () => { exited = true; stop(); });
        // close follows exit or failed spawn and also waits for pipe teardown.
        // Only this callback retires ownership and schedules a single restart.
        child.once('close', (code, signal) => {
            if (finalized) return;
            finalized = true; stop();
            this.stopSampling.delete(child);
            this.children.delete(child); resolveClosed();
            if (managed.process !== child) return;
            managed.process = null;
            managed.exitCode = failed ? 1 : (code ?? (signal ? 1 : 0));
            if (launch.native && !failed && managed.exitCode !== 0 && !this.stopping) {
                this.workerError(managed, true, 'exit');
            }
            void this.dependencies.warn({ worker: 'cron_supervisor', message: 'Cron worker process exited',
                name: managed.definition.name, code: managed.exitCode, signal,
                restarting: !this.stopping && !this.config.once }, { destination: 'console' });
            this.scheduleRestart(managed, launch.native);
        });
    }

    private workerError(managed: ManagedWorker, native: boolean, step: string, error?: unknown): void {
        const candidate = (error as NodeJS.ErrnoException | undefined)?.code;
        const code = typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/.test(candidate) ? candidate : 'NATIVE_WORKER_PROCESS';
        void this.dependencies.error({ worker: 'cron_supervisor', message: 'Cron worker process failed',
            name: managed.definition.name, step, code }, { destination: 'console' });
        if (native) {
            const prefix = nativeWorker(managed.definition.name)!.metricPrefix;
            this.dependencies.observe('worker', `${prefix}.errors`, 1, 'error');
            this.dependencies.recordLog('error', { function: prefix, step, code });
        }
    }

    async wait(): Promise<void> {
        while (this.workers.some(worker => worker.process !== null)) await new Promise(resolve => setTimeout(resolve, 50));
    }

    async shutdown(signal: string, timeoutMs = 25000): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        for (const timer of this.restarts.values()) clearTimeout(timer);
        this.restarts.clear();
        void this.dependencies.info({ worker: 'cron_supervisor', message: 'Shutting down cron supervisor', signal,
            workers: this.workers.map(worker => ({ name: worker.definition.name, pid: worker.process?.pid ?? null })) }, { destination: 'console' });
        const children = [...this.children.keys()];
        for (const stop of this.stopSampling.values()) stop();
        const signalChildren = (signal: NodeJS.Signals): void => {
            for (const child of children) {
                if (this.children.has(child) && child.exitCode === null && child.signalCode === null) child.kill(signal);
            }
        };
        signalChildren('SIGTERM');
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.all(children.map(child => this.children.get(child))),
            new Promise<void>(resolve => { deadline = setTimeout(resolve, timeoutMs); }),
        ]);
        if (deadline) clearTimeout(deadline);
        signalChildren('SIGKILL');
    }
}

export function resolveNativeRuntimes(env: NodeJS.ProcessEnv): Pick<SupervisorConfig, 'streamActivityRuntime' | 'raidAnalyticsRuntime' | 'followDefenseBaselineRuntime' | 'rouletteCompletionRuntime' | 'aiUsageReceiptsRuntime'> {
    const result: Pick<SupervisorConfig, 'streamActivityRuntime' | 'raidAnalyticsRuntime' | 'followDefenseBaselineRuntime' | 'rouletteCompletionRuntime' | 'aiUsageReceiptsRuntime'> = {};
    for (const metadata of Object.values(NATIVE_WORKERS)) {
        const value = env[metadata.runtimeEnv];
        if (value !== undefined && !['rust', 'typescript'].includes(value)) {
            throw new Error(`${metadata.runtimeEnv} must be rust or typescript`);
        }
        result[metadata.runtimeConfig] = value;
    }
    return result;
}

async function bootstrap(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
    const runtimes = resolveNativeRuntimes(process.env);
    const configuredDelay = Number(process.env.CRON_WORKER_RESTART_DELAY_MS || 5000);
    const config: SupervisorConfig = {
        runtime: process.env.CRON_WORKER_RUNTIME === 'tsx' ? 'tsx' : 'node', ...runtimes,
        once: process.argv.includes('--once'), dryRun: process.argv.includes('--dry-run'),
        restartDelayMs: Number.isFinite(configuredDelay) ? Math.max(1000, configuredDelay) : 5000,
    };
    startTelemetry();
    const supervisor = new WorkerSupervisor(config);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => { void supervisor.shutdown(signal).then(() => process.exit(0)); });
    }
    await logInfo({ worker: 'cron_supervisor', message: 'Starting cron supervisor', runtime: config.runtime,
        streamActivityRuntime: config.streamActivityRuntime || (config.runtime === 'tsx' ? 'typescript' : 'rust'),
        raidAnalyticsRuntime: config.raidAnalyticsRuntime || (config.runtime === 'tsx' ? 'typescript' : 'rust'),
        followDefenseBaselineRuntime: config.followDefenseBaselineRuntime || (config.runtime === 'tsx' ? 'typescript' : 'rust'),
        rouletteCompletionRuntime: config.rouletteCompletionRuntime || (config.runtime === 'tsx' ? 'typescript' : 'rust'),
        aiUsageReceiptsRuntime: config.aiUsageReceiptsRuntime || (config.runtime === 'tsx' ? 'typescript' : 'rust'),
        restartDelayMs: config.restartDelayMs, workers: WORKERS.filter(worker => !worker.enabledEnv || process.env[worker.enabledEnv] !== 'false').map(worker => worker.name),
        mode: config.once ? 'once' : 'normal', dryRun: config.dryRun }, { destination: 'console' });
    supervisor.start();
    if (config.once) {
        await supervisor.wait();
        if (!supervisor.stopping) process.exit(supervisor.workers.every(worker => worker.exitCode === 0) ? 0 : 1);
    }
}

// Importing the bounded supervisor helpers for tests must not load env or spawn.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    void bootstrap().catch(async () => {
        await logError({ worker: 'cron_supervisor', message: 'Failed to bootstrap cron supervisor' }, { destination: 'console' });
        process.exit(1);
    });
}
