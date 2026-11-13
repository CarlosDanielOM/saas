import path from 'node:path';
import dotenv from 'dotenv';
import { setTimeout as sleep } from 'node:timers/promises';
import { drainTelemetry } from '../utils/observability/telemetry.js';
import { workerMetrics, type WorkerHealth, type WorkerPhases } from '../utils/observability/worker_metrics.js';

export const HEALTH_INTERVAL_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 2_000;

export interface PassOutcome {
    /** Units of work done, reported as the worker's batch metric. */
    events: number;
    phases?: WorkerPhases;
    /**
     * The pass ran to the end but part of it failed (an item was requeued, a refresh errored).
     * It is reported as a failed batch, yet never ends the process on its own.
     */
    failed?: boolean;
}

export interface WorkerRuntime<T extends PassOutcome> {
    /** One bounded unit of work. Throwing marks the pass as failed. */
    pass(): Promise<T>;
    /** Milliseconds to wait before the next pass; 0 starts it right away. `null` is a failed pass. */
    delayMs(outcome: T | null): number;
    /** Backlog probe for the admin health card, run between passes at most every 30 s. */
    health?(): Promise<WorkerHealth>;
}

export interface WorkerOptions<T extends PassOutcome> {
    /** Log label, e.g. `raid-analytics`. */
    name: string;
    /** Metric prefix: the entry file name without `.worker.ts`, which the supervisor uses for restarts too. */
    prefix: string;
    batchMetric: string;
    /** Printed for `--dry-run`, which never connects to anything. */
    dryRun: string;
    /** `exit` ends the process on a failed pass so the supervisor restarts it; `retry` logs and keeps going. */
    onFailure: 'exit' | 'retry';
    /** Startup or a pass running longer than this exits: a stalled operation must not outlive its lease. */
    watchdogMs?: number;
    /**
     * Connects and returns the loop. Import database modules here, not at the top of the entry file.
     * `stopping` aborts on SIGTERM/SIGINT so a long pass can stop between items.
     */
    setup(stopping: AbortSignal): Promise<WorkerRuntime<T>>;
}

/** Idle polling backs off 1 s, 2 s, 4 s, then 5 s; any work makes the next pass start at once. */
export function idleBackoff(): (worked: boolean) => number {
    let next = 1000;
    return worked => {
        if (worked) { next = 1000; return 0; }
        const wait = next;
        next = Math.min(next * 2, 5000);
        return wait;
    };
}

/**
 * Like `idleBackoff`, but also waits 1 s after every `burst` consecutive passes that did work,
 * and after a failed one, so a long backlog is drained in bounded bursts.
 */
export function burstBackoff(burst: number): (outcome: PassOutcome | null) => number {
    let idle = idleBackoff(), run = 0;
    return outcome => {
        if (!outcome || outcome.failed) { idle = idleBackoff(); run = 0; return 1000; }
        if (outcome.events === 0) { run = 0; return idle(false); }
        idle(true);
        if (++run < burst) return 0;
        run = 0; return 1000;
    };
}

export interface WorkerLoopDependencies {
    args: string[];
    exit: (code: number) => void;
    onSignal: (listener: () => void) => void;
    now: () => number;
    log: (message: string, error?: unknown) => void;
    flush: () => Promise<void>;
    metrics: ReturnType<typeof workerMetrics>;
    loadEnv: () => void;
}

/**
 * The loop every supervised cron worker shares: batch and health metrics, a watchdog, and a
 * shutdown that never cancels the pass in flight (the supervisor allows 25 s before SIGKILL).
 */
export async function runWorker<T extends PassOutcome>(options: WorkerOptions<T>,
    overrides: Partial<WorkerLoopDependencies> = {}): Promise<void> {
    const deps: WorkerLoopDependencies = {
        args: process.argv.slice(2), exit: code => process.exit(code), now: () => performance.now(),
        onSignal: listener => { process.once('SIGTERM', listener); process.once('SIGINT', listener); },
        log: (message, error) => { console.error(`${options.name}: ${message}`, ...(error === undefined ? [] : [error])); },
        flush: drainTelemetry, metrics: workerMetrics(options.prefix, options.batchMetric),
        loadEnv: () => {
            if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve('.env.local') });
            dotenv.config();
        },
        ...overrides,
    };
    if (deps.args.includes('--dry-run')) { console.log(options.dryRun); return; }
    deps.loadEnv();
    const once = deps.args.includes('--once');
    const stop = new AbortController();
    deps.onSignal(() => stop.abort());

    const guarded = async <R>(work: () => Promise<R>, what: string, onStall?: () => void): Promise<R> => {
        if (!options.watchdogMs) return work();
        const timer = setTimeout(() => {
            deps.log(`${what} exceeded the ${options.watchdogMs! / 1000}-second watchdog`);
            onStall?.();
            // Report the stall when possible, but never let a hung flush keep the process alive.
            setTimeout(() => deps.exit(1), 4000).unref();
            void deps.flush().finally(() => deps.exit(1));
        }, options.watchdogMs);
        try { return await work(); } finally { clearTimeout(timer); }
    };

    let worker: WorkerRuntime<T>;
    try { worker = await guarded(() => options.setup(stop.signal), 'startup'); }
    catch (error) { deps.log('startup failed', error); deps.exit(1); return; }

    let lastSuccess: number | undefined, lastHealth: number | undefined, exitCode = 0;
    while (!stop.signal.aborted) {
        if (worker.health && (lastHealth === undefined || deps.now() - lastHealth >= HEALTH_INTERVAL_MS)) {
            // A failed or slow probe never fails a pass and never reports a made-up empty backlog.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const values = await Promise.race([worker.health(), new Promise<null>(resolve => {
                timer = setTimeout(() => resolve(null), HEALTH_TIMEOUT_MS);
            })]).catch(() => null).finally(() => clearTimeout(timer));
            lastHealth = deps.now();
            deps.metrics.health(values, lastSuccess === undefined ? undefined : deps.now() - lastSuccess);
            if (stop.signal.aborted) break;
        }
        const started = deps.now();
        let outcome: T | null = null, failedPhases: WorkerPhases | undefined;
        try { outcome = await guarded(worker.pass, 'pass', () => deps.metrics.batch(0, deps.now() - started, false)); }
        catch (error) {
            deps.log('pass failed', error);
            // An error may carry the phases that completed before it (see RaidProjectionError).
            const phases = (error as { phases?: unknown } | null)?.phases;
            if (phases && typeof phases === 'object') failedPhases = phases as WorkerPhases;
        }
        const succeeded = outcome !== null && !outcome.failed;
        deps.metrics.batch(outcome?.events ?? 0, deps.now() - started, succeeded, outcome?.phases ?? failedPhases);
        if (succeeded && outcome!.events > 0) lastSuccess = deps.now();
        if (!outcome && options.onFailure === 'exit') { exitCode = 1; break; }
        if (once) { exitCode = succeeded ? 0 : 1; break; }
        const delay = worker.delayMs(outcome);
        // Even with ready work, yield once so signals and lease heartbeats are served between passes.
        if (delay > 0) await sleep(delay, undefined, { signal: stop.signal }).catch(() => {});
        else await new Promise(resolve => setImmediate(resolve));
    }
    await deps.flush();
    deps.exit(exitCode);
}
