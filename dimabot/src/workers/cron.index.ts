import path from 'node:path';
import dotenv from 'dotenv';

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { error as logError, info as logInfo, warn as logWarn } from '../utils/logger.js';
import { startTelemetry } from '../utils/observability/telemetry.js';
import { NativeIndexBridge, type NativeBridgeDependencies } from './cron_native_bridge.js';

export const TYPESCRIPT_SHUTDOWN_MS = 25000;

interface WorkerOptions {
    enabledEnv?: string;
}

export interface TypeScriptWorkerDefinition extends WorkerOptions {
    kind: 'typescript';
    name: string;
    sourceEntry: string;
    distEntry: string;
}

export type WorkerDefinition = TypeScriptWorkerDefinition;

export interface SupervisorConfig {
    runtime: 'tsx' | 'node';
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
    { kind: 'typescript', name: 'goals', sourceEntry: 'src/workers/goals.worker.ts', distEntry: 'dist/workers/goals.worker.js' },
    { kind: 'typescript', name: 'duel', sourceEntry: 'src/workers/duel.worker.ts', distEntry: 'dist/workers/duel.worker.js' },
    { kind: 'typescript', name: 'widgets', sourceEntry: 'src/workers/widgets.worker.ts', distEntry: 'dist/workers/widgets.worker.js' },
    { kind: 'typescript', name: 'credit-gifts', sourceEntry: 'src/workers/credit_gifts.worker.ts', distEntry: 'dist/workers/credit_gifts.worker.js' },
    { kind: 'typescript', name: 'semantic-moderation', sourceEntry: 'src/workers/semantic_moderation.worker.ts', distEntry: 'dist/workers/semantic_moderation.worker.js' },
    { kind: 'typescript', name: 'roulette-actions', sourceEntry: 'src/workers/roulette-actions.worker.ts', distEntry: 'dist/workers/roulette-actions.worker.js' },
    {
        kind: 'typescript',
        name: 'follow-defense-actions',
        sourceEntry: 'src/workers/follow_defense_actions.worker.ts',
        distEntry: 'dist/workers/follow_defense_actions.worker.js'
    },
    {
        kind: 'typescript',
        name: 'follow-defense',
        sourceEntry: 'src/workers/follow_defense.worker.ts',
        distEntry: 'dist/workers/follow_defense.worker.js'
    },
    {
        kind: 'typescript',
        name: 'follow-ledger',
        sourceEntry: 'src/workers/follow_ledger.worker.ts',
        distEntry: 'dist/workers/follow_ledger.worker.js'
    },
    {
        kind: 'typescript',
        name: 'stream-analytics',
        sourceEntry: 'src/workers/stream_analytics.worker.ts',
        distEntry: 'dist/workers/stream_analytics.worker.js'
    },
    {
        kind: 'typescript',
        name: 'domain-events',
        sourceEntry: 'src/workers/domain_events.worker.ts',
        distEntry: 'dist/workers/domain_events.worker.js'
    },
    {
        kind: 'typescript',
        name: 'eventsub-reconciliation',
        sourceEntry: 'src/workers/eventsub_reconciliation.worker.ts',
        distEntry: 'dist/workers/eventsub_reconciliation.worker.js',
        enabledEnv: 'EVENTSUB_RECONCILIATION_ENABLED'
    },
    {
        kind: 'typescript',
        name: 'free-credit-reset',
        sourceEntry: 'src/workers/free_credit_reset.worker.ts',
        distEntry: 'dist/workers/free_credit_reset.worker.js',
        enabledEnv: 'FREE_CREDIT_RESET_ENABLED'
    },
    {
        kind: 'typescript',
        name: 'ai-usage-backfill',
        sourceEntry: 'src/workers/ai_usage_backfill.worker.ts',
        distEntry: 'dist/workers/ai_usage_backfill.worker.js',
        enabledEnv: 'AI_USAGE_BACKFILL_ENABLED'
    },
    {
        kind: 'typescript',
        name: 'stream-memory',
        sourceEntry: 'src/workers/stream_memory.worker.ts',
        distEntry: 'dist/workers/stream_memory.worker.js'
    },
    {
        kind: 'typescript',
        name: 'temporary-roles',
        sourceEntry: 'src/workers/temporary_roles.worker.ts',
        distEntry: 'dist/workers/temporary_roles.worker.js'
    },
    {
        kind: 'typescript',
        name: 'timer',
        sourceEntry: 'src/workers/timer.worker.ts',
        distEntry: 'dist/workers/timer.worker.js'
    },
    {
        kind: 'typescript',
        name: 'activation-reminder',
        sourceEntry: 'src/workers/activation-reminder.worker.ts',
        distEntry: 'dist/workers/activation-reminder.worker.js'
    },
    {
        kind: 'typescript',
        name: 'vod-clip-recommender',
        sourceEntry: 'src/workers/vod_clip_recommender.worker.ts',
        distEntry: 'dist/workers/vod_clip_recommender.worker.js'
    }
];

export function resolveWorkerLaunch(worker: WorkerDefinition, config: SupervisorConfig,
    env: NodeJS.ProcessEnv = process.env): {
    command: string; args: string[]; options: SpawnOptions;
} {
    const flags = [...(config.dryRun ? ['--dry-run'] : []), ...(config.once ? ['--once'] : [])];
    const entry = config.runtime === 'tsx' ? path.resolve(process.cwd(), worker.sourceEntry)
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), path.basename(worker.distEntry));
    return { command: config.runtime === 'tsx' ? 'tsx' : process.execPath, args: [entry, ...flags],
        options: { stdio: 'inherit', env: { ...env, CRON_SUPERVISOR: 'true', CRON_WORKER_NAME: worker.name } } };
}

export interface SupervisorDependencies {
    spawn: typeof spawn;
    info: typeof logInfo;
    warn: typeof logWarn;
    error: typeof logError;
    env: NodeJS.ProcessEnv;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
}

export class WorkerSupervisor {
    readonly workers: ManagedWorker[];
    stopping = false;
    private readonly dependencies: SupervisorDependencies;
    private readonly restarts = new Map<ManagedWorker, ReturnType<typeof setTimeout>>();
    private readonly children = new Map<ChildProcess, Promise<void>>();
    private started = false;
    private shutdownPromise: Promise<void> | undefined;

    constructor(private readonly config: SupervisorConfig, definitions: WorkerDefinition[] = WORKERS,
        dependencies: Partial<SupervisorDependencies> = {}) {
        this.dependencies = { spawn, info: logInfo, warn: logWarn, error: logError,
            env: process.env, setTimeout, clearTimeout, ...dependencies };
        this.workers = definitions.map(definition => ({ definition, process: null, restartCount: 0,
            exitCode: this.enabled(definition) ? null : 0 }));
    }

    private enabled(worker: WorkerDefinition): boolean {
        return !worker.enabledEnv || this.dependencies.env[worker.enabledEnv] !== 'false';
    }

    start(): void {
        if (this.started || this.stopping) return;
        this.started = true;
        for (const managed of this.workers) {
            if (this.enabled(managed.definition)) this.startWorker(managed);
            else void this.dependencies.info({ worker: 'cron_supervisor', message: 'Cron worker disabled; not starting',
                name: managed.definition.name, enabledEnv: managed.definition.enabledEnv }, { destination: 'console' });
        }
    }

    private scheduleRestart(managed: ManagedWorker): void {
        if (this.stopping || this.config.once || this.restarts.has(managed)) return;
        managed.restartCount += 1;
        const timer = this.dependencies.setTimeout(() => {
            this.restarts.delete(managed);
            if (!this.stopping) this.startWorker(managed);
        }, this.config.restartDelayMs);
        this.restarts.set(managed, timer);
    }

    private startWorker(managed: ManagedWorker): void {
        if (this.stopping || managed.process) return;
        const launch = resolveWorkerLaunch(managed.definition, this.config, this.dependencies.env);
        let child: ChildProcess;
        try { child = this.dependencies.spawn(launch.command, launch.args, launch.options); }
        catch (error) {
            managed.exitCode = 1;
            this.workerError(managed, 'spawn', error);
            this.scheduleRestart(managed);
            return;
        }
        managed.process = child;
        let failed = false, finalized = false;
        let resolveClosed!: () => void;
        this.children.set(child, new Promise<void>(resolve => { resolveClosed = resolve; }));
        child.once('spawn', () => {
            if (finalized || this.stopping) return;
            void this.dependencies.info({ worker: 'cron_supervisor', message: 'Started cron worker process',
                name: managed.definition.name, pid: child.pid, runtime: this.config.runtime,
                restartCount: managed.restartCount }, { destination: 'console' });
        });
        child.on('error', error => {
            if (failed || finalized) return;
            failed = true; this.workerError(managed, 'process', error);
        });
        // close follows exit or failed spawn and also waits for pipe teardown.
        // Only this callback retires ownership and schedules a single restart.
        child.once('close', (code, signal) => {
            if (finalized) return;
            finalized = true;
            this.children.delete(child); resolveClosed();
            if (managed.process !== child) return;
            managed.process = null;
            managed.exitCode = failed ? 1 : (code ?? (signal ? 1 : 0));
            void this.dependencies.warn({ worker: 'cron_supervisor', message: 'Cron worker process exited',
                name: managed.definition.name, code: managed.exitCode, signal,
                restarting: !this.stopping && !this.config.once }, { destination: 'console' });
            this.scheduleRestart(managed);
        });
    }

    private workerError(managed: ManagedWorker, step: string, error?: unknown): void {
        const candidate = (error as NodeJS.ErrnoException | undefined)?.code;
        const code = typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/.test(candidate) ? candidate : 'CRON_WORKER_PROCESS';
        void this.dependencies.error({ worker: 'cron_supervisor', message: 'Cron worker process failed',
            name: managed.definition.name, step, code }, { destination: 'console' });
    }

    async wait(): Promise<void> {
        while (this.children.size) await Promise.all([...this.children.values()]);
    }

    shutdown(signal: string, timeoutMs = TYPESCRIPT_SHUTDOWN_MS): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.stopping = true;
        for (const timer of this.restarts.values()) this.dependencies.clearTimeout(timer);
        this.restarts.clear();
        void this.dependencies.info({ worker: 'cron_supervisor', message: 'Shutting down cron supervisor', signal,
            workers: this.workers.map(worker => ({ name: worker.definition.name, pid: worker.process?.pid ?? null })) }, { destination: 'console' });
        const children = [...this.children.keys()];
        const signalChildren = (signal: NodeJS.Signals): void => {
            for (const child of children) {
                if (this.children.has(child) && child.exitCode === null && child.signalCode === null) child.kill(signal);
            }
        };
        this.shutdownPromise = (async () => {
            signalChildren('SIGTERM');
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.all(children.map(child => this.children.get(child))),
                    new Promise<void>(resolve => { deadline = this.dependencies.setTimeout(resolve, timeoutMs); }),
                ]);
            } finally {
                if (deadline !== undefined) this.dependencies.clearTimeout(deadline);
                signalChildren('SIGKILL');
            }
        })();
        return this.shutdownPromise;
    }
}

export function resolveSupervisorConfig(env: NodeJS.ProcessEnv = process.env,
    args: string[] = process.argv.slice(2)): SupervisorConfig {
    const configuredDelay = Number(env.CRON_WORKER_RESTART_DELAY_MS || 5000);
    return {
        runtime: env.CRON_WORKER_RUNTIME === 'tsx' ? 'tsx' : 'node',
        once: args.includes('--once'), dryRun: args.includes('--dry-run'),
        restartDelayMs: Number.isFinite(configuredDelay) ? Math.max(1000, configuredDelay) : 5000,
    };
}

export interface CronHostDependencies extends SupervisorDependencies {
    signal: NativeBridgeDependencies['signal'];
    getuid: NativeBridgeDependencies['getuid'];
}

/** PID 1 coordinates the two owners; TypeScript can retire after its last migration. */
export class CronHost {
    readonly typescript: WorkerSupervisor;
    readonly native: NativeIndexBridge;
    stopping = false;
    private started = false;
    private failed = false;
    private shutdownPromise: Promise<number> | undefined;
    private resolveCompletion!: (code: number) => void;
    private readonly completion = new Promise<number>(resolve => { this.resolveCompletion = resolve; });

    constructor(private readonly config: SupervisorConfig, definitions: WorkerDefinition[] = WORKERS,
        dependencies: Partial<CronHostDependencies> = {}) {
        this.typescript = new WorkerSupervisor(config, definitions, dependencies);
        // Pass the same spawn binding used by TS workers for exact-candidate
        // fixture interception. Only this one fixed index launch crosses over.
        this.native = new NativeIndexBridge(config, {
            spawn, ...dependencies,
            onFailure: failure => {
                this.failed = true;
                void (dependencies.error ?? logError)({ worker: 'cron_supervisor',
                    message: 'Rust cron index failed; stopping cron host', step: failure.step,
                    code: failure.code }, { destination: 'console' });
                void this.shutdown('native-index-failure');
            },
        });
    }

    start(): void {
        if (this.started || this.stopping) return;
        this.started = true;
        this.native.start();
        if (!this.stopping) this.typescript.start();
        if (this.config.once) {
            void Promise.all([this.typescript.wait(), this.native.wait()]).then(() => {
                if (!this.stopping) this.resolveCompletion(this.native.exitCode === 0 &&
                    this.typescript.workers.every(worker => worker.exitCode === 0) ? 0 : 1);
            });
        }
    }

    wait(): Promise<number> { return this.completion; }

    shutdown(signal: string): Promise<number> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.stopping = true;
        // Run both grace periods concurrently: 25 seconds for TS children and
        // 28 for Rust coordination, within Compose's existing 30-second budget.
        this.shutdownPromise = Promise.all([this.typescript.shutdown(signal), this.native.shutdown()]).then(() => {
            const code = this.failed || this.native.exitCode !== 0 ||
                (this.config.once && this.typescript.workers.some(worker => worker.exitCode !== 0)) ? 1 : 0;
            this.resolveCompletion(code);
            return code;
        });
        return this.shutdownPromise;
    }
}

async function bootstrap(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
    const config = resolveSupervisorConfig();
    startTelemetry();
    const host = new CronHost(config);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => { void host.shutdown(signal); });
    }
    await logInfo({ worker: 'cron_supervisor', message: 'Starting cron supervisor', runtime: config.runtime,
        restartDelayMs: config.restartDelayMs, workers: WORKERS.filter(worker => !worker.enabledEnv || process.env[worker.enabledEnv] !== 'false').map(worker => worker.name),
        mode: config.once ? 'once' : 'normal', dryRun: config.dryRun }, { destination: 'console' });
    host.start();
    process.exit(await host.wait());
}

// Importing the bounded supervisor helpers for tests must not load env or spawn.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    void bootstrap().catch(async () => {
        await logError({ worker: 'cron_supervisor', message: 'Failed to bootstrap cron supervisor' }, { destination: 'console' });
        process.exit(1);
    });
}
