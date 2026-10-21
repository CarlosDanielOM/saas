import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { observe } from './telemetry.js';

const SAMPLE_INTERVAL_MS = 10000;
const PROC_LIMIT = 16384;
const PROGRESS_LIMIT = 1024;
// Matches the analytics ingestion numeric ceiling. Never forward unbounded child values.
const NATIVE_METADATA_MAX = 1e15;
const RAID_PHASES = ['claimMs', 'followQueriesMs', 'followWriteMs', 'period7Ms', 'period30Ms', 'reciprocityMs', 'publishMs', 'releaseMs'] as const;
const BASELINE_PHASES = ['queueMs', 'claimMs', 'ledgerMs', 'streamsMs', 'attacksMs', 'publishMs', 'rescheduleMs'] as const;
const NATIVE_BATCH_FIELDS = ['event', 'events', 'durationMs', 'success', 'phases'];
const NATIVE_HEALTH_FIELDS = ['event', 'success', 'dueChannels', 'oldestDueAgeMs', 'lastSuccessAgeMs'];
const BATCH_FIELDS = ['event', 'events', 'durationMs', 'success'];
const STREAM_HEALTH_FIELDS = ['event', 'success', 'hasPending', 'oldestPendingAgeMs', 'checkpointSeq', 'activeBatchEvents', 'lastSuccessAgeMs'];
type Observer = typeof observe;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyFields = (row: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(row).every(key => fields.includes(key));
const metadataNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= NATIVE_METADATA_MAX;

function validPhases(value: unknown, phases: readonly string[]): value is Record<string, number> {
    return record(value) && onlyFields(value, phases) && Object.values(value).every(metadataNumber);
}

function emitNativeHealth(row: Record<string, unknown>, emit: Observer, prefix: string): void {
    if (!onlyFields(row, NATIVE_HEALTH_FIELDS) || typeof row.success !== 'boolean') return;
    // Unknown observations stay absent; a failed query must never fabricate an empty backlog.
    for (const key of ['dueChannels', 'oldestDueAgeMs', 'lastSuccessAgeMs']) {
        if (row[key] != null && !metadataNumber(row[key])) return;
    }
    if (row.dueChannels != null && !Number.isSafeInteger(row.dueChannels)) return;
    if (!row.success && (row.dueChannels != null || row.oldestDueAgeMs != null)) return;
    if (row.dueChannels === 0 && row.oldestDueAgeMs != null) return;
    // One outcome keeps same-bucket mixed probes visible as a fractional/unknown status.
    emit('worker', `${prefix}.health_query`, row.success ? 1 : 0, 'ok', '');
    if (!row.success) emit('worker', `${prefix}.health_errors`, 1, 'error', '');
    // Gauges are independent observations; health_errors alone counts query errors.
    for (const [field, metric] of [
        ['dueChannels', 'backlog_channels'], ['oldestDueAgeMs', 'oldest_due_age_ms'], ['lastSuccessAgeMs', 'last_success_age_ms'],
    ] as const) {
        if (metadataNumber(row[field])) emit('worker', `${prefix}.${metric}`, row[field], 'ok', '');
    }
}

function emitStreamHealth(row: Record<string, unknown>, emit: Observer): void {
    if (!onlyFields(row, STREAM_HEALTH_FIELDS) || typeof row.success !== 'boolean') return;
    const gauges = ['oldestPendingAgeMs', 'checkpointSeq', 'activeBatchEvents', 'lastSuccessAgeMs'] as const;
    for (const key of gauges) if (key in row && !metadataNumber(row[key])) return;
    for (const key of ['checkpointSeq', 'activeBatchEvents']) {
        if (key in row && !Number.isSafeInteger(row[key])) return;
    }
    if (row.success) {
        if (typeof row.hasPending !== 'boolean' || (!row.hasPending && 'oldestPendingAgeMs' in row)) return;
    } else if (['hasPending', 'oldestPendingAgeMs', 'checkpointSeq', 'activeBatchEvents'].some(key => key in row)) return;
    const prefix = NATIVE_WORKERS['stream-activity'].metricPrefix;
    emit('worker', `${prefix}.health_query`, row.success ? 1 : 0, 'ok', '');
    if (!row.success) emit('worker', `${prefix}.health_errors`, 1, 'error', '');
    if (typeof row.hasPending === 'boolean') emit('worker', `${prefix}.pending_work`, row.hasPending ? 1 : 0, 'ok', '');
    for (const [field, metric] of [
        ['oldestPendingAgeMs', 'oldest_pending_age_ms'], ['checkpointSeq', 'checkpoint_seq'],
        ['activeBatchEvents', 'active_batch_events'], ['lastSuccessAgeMs', 'last_success_age_ms'],
    ] as const) {
        if (metadataNumber(row[field])) emit('worker', `${prefix}.${metric}`, row[field], 'ok', '');
    }
}

/** Queue-health thresholds and receipt settings inherited by the native receipts child. */
const AI_USAGE_RECEIPTS_ENV = ['AI_USAGE_RECEIPTS_ENABLED', 'AI_USAGE_RECEIPTS_INTERVAL_MS', 'AI_USAGE_RECEIPTS_BATCH_SIZE',
    'AI_USAGE_RECEIPTS_LOCK_KEY', 'AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS'] as const;
const AI_USAGE_QUEUE_HEALTH_ENV = ['AI_USAGE_QUEUE_MAX_AGE_SECONDS', 'AI_USAGE_PROCESSING_MAX_AGE_SECONDS',
    'AI_USAGE_QUEUE_FAILURE_THRESHOLD'] as const;
// Existing Dragonfly client contract: host and port only, never credentials.
const DRAGONFLY_ENV = ['DRAGONFLY_HOST', 'DRAGONFLY_PORT'] as const;

/** Only these registered workers may use the native launch and telemetry path. */
export const NATIVE_WORKERS = {
    'stream-activity': {
        command: '/usr/local/bin/stream_activity', args: ['--batch-size', '500', '--telemetry-json'],
        runtimeConfig: 'streamActivityRuntime', runtimeEnv: 'STREAM_ACTIVITY_RUNTIME',
        protocol: 'stream_activity:', metricPrefix: 'stream_activity_rust', batchMetric: 'batch_events', maxEvents: 1000, maxDurationMs: 300000,
        extraEnv: [] as readonly string[],
    },
    'follow-defense-baseline': {
        command: '/usr/local/bin/follow_defense_baseline', args: ['--telemetry-json'],
        runtimeConfig: 'followDefenseBaselineRuntime', runtimeEnv: 'FOLLOW_DEFENSE_BASELINE_RUNTIME',
        protocol: 'follow_defense_baseline:', metricPrefix: 'follow_defense_baseline_rust', batchMetric: 'batch_channels', maxEvents: 1, maxDurationMs: 300000,
        extraEnv: DRAGONFLY_ENV,
    },
    'roulette-completion': {
        command: '/usr/local/bin/roulette_completion', args: ['--telemetry-json'],
        runtimeConfig: 'rouletteCompletionRuntime', runtimeEnv: 'ROULETTE_COMPLETION_RUNTIME',
        protocol: 'roulette_completion:', metricPrefix: 'roulette_completion_rust', batchMetric: 'batch_channels', maxEvents: 100, maxDurationMs: 300000,
        extraEnv: [] as readonly string[],
    },
    'raid-analytics': {
        command: '/usr/local/bin/raid_analytics', args: ['--telemetry-json'],
        runtimeConfig: 'raidAnalyticsRuntime', runtimeEnv: 'RAID_ANALYTICS_RUNTIME',
        protocol: 'raid_analytics:', metricPrefix: 'raid_analytics_rust', batchMetric: 'batch_channels', maxEvents: 1, maxDurationMs: Number.MAX_VALUE,
        extraEnv: [] as readonly string[],
    },
    'ai-usage-receipts': {
        command: '/usr/local/bin/ai_usage_receipts', args: ['--telemetry-json'],
        runtimeConfig: 'aiUsageReceiptsRuntime', runtimeEnv: 'AI_USAGE_RECEIPTS_RUNTIME',
        protocol: 'ai_usage_receipts:', metricPrefix: 'ai_usage_receipts_rust', batchMetric: 'batch_receipts', maxEvents: 1000, maxDurationMs: 300000,
        extraEnv: [...DRAGONFLY_ENV, ...AI_USAGE_RECEIPTS_ENV, ...AI_USAGE_QUEUE_HEALTH_ENV],
    },
} as const;
export type NativeWorkerName = keyof typeof NATIVE_WORKERS;
export function nativeWorker(name: string): typeof NATIVE_WORKERS[NativeWorkerName] | undefined {
    return Object.hasOwn(NATIVE_WORKERS, name) ? NATIVE_WORKERS[name as NativeWorkerName] : undefined;
}

export interface NativeSnapshot {
    startTicks: bigint;
    cpuTicks: bigint;
    rssBytes: number;
}

/** Linux stat comm can itself contain spaces and parentheses. */
export function parseNativeStat(stat: string, pid: number): Pick<NativeSnapshot, 'startTicks' | 'cpuTicks'> | undefined {
    const opening = stat.indexOf(' (');
    const closing = stat.lastIndexOf(') ');
    if (opening < 1 || closing < opening || stat.slice(0, opening) !== String(pid)) return;
    const fields = stat.slice(closing + 2).trim().split(/\s+/);
    if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || ['Z', 'X', 'x'].includes(fields[0])) return;
    const [user, system, start] = [fields[11], fields[12], fields[19]];
    if (![user, system, start].every(value => /^\d+$/.test(value))) return;
    return { cpuTicks: BigInt(user) + BigInt(system), startTicks: BigInt(start) };
}

export function parseNativeRss(status: string, pid: number): number | undefined {
    if (status.match(/^Pid:\s*(\d+)\s*$/m)?.[1] !== String(pid)) return;
    const rss = status.match(/^VmRSS:\s*(\d+)\s+kB\s*$/m)?.[1];
    if (rss === undefined) return;
    const bytes = Number(rss) * 1024;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

async function boundedProcRead(file: string): Promise<string> {
    const handle = await open(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(PROC_LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > PROC_LIMIT) throw new Error('Oversized native process metadata');
        return buffer.toString('utf8', 0, bytesRead);
    } finally { await handle.close(); }
}

async function readNativeSnapshot(pid: number): Promise<NativeSnapshot | undefined> {
    try {
        const before = parseNativeStat(await boundedProcRead(`/proc/${pid}/stat`), pid);
        if (!before) return;
        const rssBytes = parseNativeRss(await boundedProcRead(`/proc/${pid}/status`), pid);
        const after = parseNativeStat(await boundedProcRead(`/proc/${pid}/stat`), pid);
        if (rssBytes === undefined || !after || before.startTicks !== after.startTicks) return;
        return { ...after, rssBytes };
    } catch { return; } // Missing/exited/permission-denied processes produce no samples.
}

let clockTicks: Promise<number | undefined> | undefined;
function linuxClockTicks(): Promise<number | undefined> {
    clockTicks ??= new Promise(resolve => {
        // Discover the OS tick frequency once; never guess or assume 100 Hz.
        execFile('getconf', ['CLK_TCK'], { timeout: 1000, maxBuffer: 128, env: { PATH: process.env.PATH } }, (error, stdout) => {
            const ticks = Number(stdout.trim());
            resolve(!error && Number.isSafeInteger(ticks) && ticks > 0 ? ticks : undefined);
        });
    });
    return clockTicks;
}

export class NativeCpuTracker {
    private identity: bigint | undefined;
    private previous: { ticks: bigint; at: number } | undefined;
    private replaced = false;

    missing(): void { this.previous = undefined; }

    sample(snapshot: NativeSnapshot, at: number, ticksPerSecond: number | undefined): { rssBytes: number; cpuCores?: number } | undefined {
        if (this.replaced) return;
        this.identity ??= snapshot.startTicks;
        if (this.identity !== snapshot.startTicks) { this.replaced = true; this.previous = undefined; return; }
        const previous = this.previous;
        this.previous = { ticks: snapshot.cpuTicks, at };
        const sample: { rssBytes: number; cpuCores?: number } = { rssBytes: snapshot.rssBytes };
        if (previous && ticksPerSecond && at > previous.at && snapshot.cpuTicks >= previous.ticks) {
            const delta = Number(snapshot.cpuTicks - previous.ticks);
            const cores = delta / ticksPerSecond / ((at - previous.at) / 1000);
            if (Number.isFinite(cores) && cores >= 0) sample.cpuCores = cores;
        }
        return sample;
    }
}

interface SamplerDependencies {
    read: (pid: number) => Promise<NativeSnapshot | undefined>;
    ticks: () => Promise<number | undefined>;
    now: () => number;
    observe: Observer;
    intervalMs: number;
}

/** One in-flight bounded read at a time; stop also fences already pending reads. */
export function startNativeWorkerMetrics(pid: number, dependencies: Partial<SamplerDependencies> = {},
    worker: NativeWorkerName = 'stream-activity'): () => void {
    const metadata = NATIVE_WORKERS[worker];
    const deps: SamplerDependencies = {
        read: readNativeSnapshot, ticks: linuxClockTicks, now: () => performance.now(),
        observe, intervalMs: SAMPLE_INTERVAL_MS, ...dependencies,
    };
    const tracker = new NativeCpuTracker();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => { stopped = true; if (timer) clearTimeout(timer); };
    const sample = async (): Promise<void> => {
        try {
            const ticks = await deps.ticks();
            if (stopped) return;
            const snapshot = await deps.read(pid);
            if (stopped) return;
            if (snapshot) {
                const result = tracker.sample(snapshot, deps.now(), ticks);
                if (!result) { stop(); return; }
                deps.observe('runtime', `${metadata.metricPrefix}.rss_bytes`, result.rssBytes);
                if (result.cpuCores !== undefined) deps.observe('runtime', `${metadata.metricPrefix}.cpu_cores`, result.cpuCores);
            } else { tracker.missing(); }
        } catch { tracker.missing(); }
        finally {
            if (!stopped) { timer = setTimeout(() => { void sample(); }, deps.intervalMs); timer.unref(); }
        }
    };
    if (process.platform === 'linux' && Number.isSafeInteger(pid) && pid > 0) void sample();
    return stop;
}

/** Accept only bounded protocol metadata; arbitrary child output is discarded. */
export function nativeProgressParser(emit: Observer = observe, worker: NativeWorkerName = 'stream-activity'): (chunk: Buffer | string) => void {
    const metadata = NATIVE_WORKERS[worker];
    const phases = worker === 'raid-analytics' ? RAID_PHASES : worker === 'follow-defense-baseline' ? BASELINE_PHASES : undefined;
    // Batch-only protocols accept no health or phase frames and no private fields.
    const batchOnly = worker === 'roulette-completion' || worker === 'ai-usage-receipts';
    let pending = '', discard = false;
    return chunk => {
        // Iterate without concatenating arbitrary pipe chunks into a large buffer.
        for (const byte of chunk) {
            const character = typeof byte === 'number' ? String.fromCharCode(byte) : byte;
            if (character === '\n') {
                if (!discard && pending.startsWith(metadata.protocol)) {
                    try {
                        const value: unknown = JSON.parse(pending.slice(metadata.protocol.length));
                        if (record(value)) {
                            const row = value;
                            if (worker === 'stream-activity') {
                                if (row.event === 'health') { emitStreamHealth(row, emit); pending = ''; discard = false; continue; }
                                if (!onlyFields(row, BATCH_FIELDS)) { pending = ''; discard = false; continue; }
                            }
                            if (batchOnly && !onlyFields(row, BATCH_FIELDS)) {
                                pending = ''; discard = false; continue;
                            }
                            if (phases) {
                                if (row.event === 'health') { emitNativeHealth(row, emit, metadata.metricPrefix); pending = ''; discard = false; continue; }
                                if (!onlyFields(row, NATIVE_BATCH_FIELDS) || ('phases' in row && !validPhases(row.phases, phases))) {
                                    pending = ''; discard = false; continue;
                                }
                            }
                            if (row.event === 'batch' && typeof row.events === 'number' && Number.isInteger(row.events)
                                && row.events >= 0 && row.events <= metadata.maxEvents && typeof row.durationMs === 'number'
                                && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= metadata.maxDurationMs
                                && typeof row.success === 'boolean' && (row.success || row.events === 0)) {
                                const outcome = row.success ? (row.events > 0 ? 'ok' : 'idle') : 'error';
                                emit('worker', `${metadata.metricPrefix}.${metadata.batchMetric}`, row.events, outcome);
                                emit('queue_run', `${metadata.metricPrefix}.project_batch`, row.durationMs, outcome);
                                if (phases && validPhases(row.phases, phases)) {
                                    for (const phase of phases) {
                                        const duration = row.phases[phase];
                                        if (duration !== undefined) emit('queue_run', `${metadata.metricPrefix}.phase.${phase}`, duration, outcome, '');
                                    }
                                }
                            }
                        }
                    } catch { /* Invalid frames never leave the process. */ }
                }
                pending = ''; discard = false;
            } else if (!discard) {
                if (pending.length >= PROGRESS_LIMIT) { pending = ''; discard = true; }
                else pending += character;
            }
        }
    };
}
