import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { observe } from './telemetry.js';

const SAMPLE_INTERVAL_MS = 10000;
const PROC_LIMIT = 16384;
const PROGRESS_LIMIT = 1024;
const METRIC_PREFIX = 'stream_activity_rust';
type Observer = typeof observe;

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
export function startNativeWorkerMetrics(pid: number, dependencies: Partial<SamplerDependencies> = {}): () => void {
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
                deps.observe('runtime', `${METRIC_PREFIX}.rss_bytes`, result.rssBytes);
                if (result.cpuCores !== undefined) deps.observe('runtime', `${METRIC_PREFIX}.cpu_cores`, result.cpuCores);
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
export function nativeProgressParser(emit: Observer = observe): (chunk: Buffer | string) => void {
    let pending = '', discard = false;
    return chunk => {
        // Iterate without concatenating arbitrary pipe chunks into a large buffer.
        for (const byte of chunk) {
            const character = typeof byte === 'number' ? String.fromCharCode(byte) : byte;
            if (character === '\n') {
                if (!discard && pending.startsWith('stream_activity:')) {
                    try {
                        const value: unknown = JSON.parse(pending.slice('stream_activity:'.length));
                        if (value && typeof value === 'object') {
                            const row = value as Record<string, unknown>;
                            if (row.event === 'batch' && typeof row.events === 'number' && Number.isInteger(row.events)
                                && row.events >= 0 && row.events <= 1000 && typeof row.durationMs === 'number'
                                && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= 300000
                                && typeof row.success === 'boolean' && (row.success || row.events === 0)) {
                                const outcome = row.success ? (row.events > 0 ? 'ok' : 'idle') : 'error';
                                emit('worker', `${METRIC_PREFIX}.batch_events`, row.events, outcome);
                                emit('queue_run', `${METRIC_PREFIX}.project_batch`, row.durationMs, outcome);
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
