import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export const NATIVE_INDEX_DEFINITION = Object.freeze({ name: 'cron_index', command: '/usr/local/bin/cron_index' });
export const NATIVE_BRIDGE_SHUTDOWN_MS = 28000;

// The bridge passes the union needed by the index and its registered children.
// Rust owns each worker's narrower allowlist; no native registry lives in Node.
export const NATIVE_INDEX_ENV_KEYS = [
    'MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'DRAGONFLY_HOST', 'DRAGONFLY_PORT', 'CLIENT_ID', 'CLIENT_SECRET',
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
    'AI_USAGE_RECEIPTS_ENABLED', 'AI_USAGE_RECEIPTS_INTERVAL_MS', 'AI_USAGE_RECEIPTS_BATCH_SIZE',
    'AI_USAGE_RECEIPTS_LOCK_KEY', 'AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS',
    'AI_USAGE_QUEUE_MAX_AGE_SECONDS', 'AI_USAGE_PROCESSING_MAX_AGE_SECONDS', 'AI_USAGE_QUEUE_FAILURE_THRESHOLD',
    'OBSERVABILITY_DISABLED', 'CRON_WORKER_RESTART_DELAY_MS',
] as const;

export interface NativeBridgeConfig {
    once: boolean;
    dryRun: boolean;
}

export interface NativeBridgeFailure {
    step: 'spawn' | 'error' | 'exit' | 'close';
    code: number;
}

export interface NativeBridgeDependencies {
    spawn: typeof spawn;
    signal: (pid: number, signal: NodeJS.Signals) => unknown;
    getuid: () => number | undefined;
    env: NodeJS.ProcessEnv;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    onFailure: (failure: NativeBridgeFailure) => void;
}

export function resolveNativeIndexLaunch(config: NativeBridgeConfig, env: NodeJS.ProcessEnv = process.env,
    uid: number | undefined = process.getuid?.()): { command: string; args: string[]; options: SpawnOptions } {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of NATIVE_INDEX_ENV_KEYS) if (env[key] !== undefined) childEnv[key] = env[key];
    return {
        command: NATIVE_INDEX_DEFINITION.command,
        args: [...(config.dryRun ? ['--dry-run'] : []), ...(config.once ? ['--once'] : [])],
        options: { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: childEnv,
            ...(uid === 0 ? { uid: 65534, gid: 65534 } : {}) },
    };
}

/** Own exactly one detached Rust index, never its individual workers or metrics. */
export class NativeIndexBridge {
    process: ChildProcess | null = null;
    exitCode: number | null = null;
    private readonly dependencies: NativeBridgeDependencies;
    private started = false;
    private stopping = false;
    private finished = false;
    private groupId: number | undefined;
    private groupCleaned = false;
    private termSent = false;
    private shutdownPromise: Promise<void> | undefined;
    private resolveCompletion!: () => void;
    private readonly completion = new Promise<void>(resolve => { this.resolveCompletion = resolve; });

    constructor(private readonly config: NativeBridgeConfig, dependencies: Partial<NativeBridgeDependencies> = {}) {
        this.dependencies = { spawn, signal: (pid, signal) => process.kill(pid, signal),
            getuid: () => process.getuid?.(), env: process.env, setTimeout, clearTimeout,
            onFailure: () => {}, ...dependencies };
    }

    start(): void {
        if (this.started || this.stopping) return;
        this.started = true;
        const launch = resolveNativeIndexLaunch(this.config, this.dependencies.env, this.dependencies.getuid());
        let child: ChildProcess;
        try { child = this.dependencies.spawn(launch.command, launch.args, launch.options); }
        catch { this.finish(1, 'spawn', true); return; }
        this.process = child;
        // Capture only the PID returned by our own detached spawn. Never signal 0,
        // a configured PID, or a process group discovered from another process.
        const captureGroup = (): void => {
            if (this.groupId === undefined && Number.isSafeInteger(child.pid) && child.pid! > 1) this.groupId = child.pid;
        };
        captureGroup();
        child.once('spawn', () => {
            captureGroup();
            if (this.finished) this.cleanupGroup();
            else if (this.stopping) this.terminateIndex();
        });
        // Keep an error listener after completion to fence duplicate/late events.
        child.on('error', () => { this.finish(1, 'error', true); });
        child.once('exit', (code, signal) => { this.finish(code ?? (signal ? 1 : 0), 'exit'); });
        child.once('close', (code, signal) => { this.finish(code ?? (signal ? 1 : 0), 'close'); });
    }

    private cleanupGroup(): boolean {
        if (this.groupId === undefined || this.groupCleaned) return true;
        this.groupCleaned = true;
        try { this.dependencies.signal(-this.groupId, 'SIGKILL'); return true; }
        catch (error) { return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'; }
    }

    private finish(code: number, step: NativeBridgeFailure['step'], failed = false): void {
        if (this.finished) return;
        this.finished = true;
        const unexpected = !this.stopping && !this.config.once && !this.config.dryRun;
        const cleaned = this.cleanupGroup();
        this.exitCode = failed || unexpected || !cleaned ? 1 : code;
        this.process = null;
        this.resolveCompletion();
        // Cleanup precedes the host failure callback. Restarting an index over
        // surviving native children is deliberately not a recovery path.
        if (unexpected) this.dependencies.onFailure({ step, code: this.exitCode });
    }

    private terminateIndex(): void {
        if (this.finished || this.termSent || this.groupId === undefined) return;
        this.termSent = true;
        // Only the index receives TERM: it coordinates its children's 25s drain.
        try { this.dependencies.signal(this.groupId, 'SIGTERM'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') this.finish(1, 'error', true);
        }
    }

    wait(): Promise<void> { return this.completion; }

    shutdown(timeoutMs = NATIVE_BRIDGE_SHUTDOWN_MS): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.stopping = true;
        if (!this.started) this.finish(0, 'close');
        this.shutdownPromise = this.drain(timeoutMs);
        return this.shutdownPromise;
    }

    private async drain(timeoutMs: number): Promise<void> {
        if (this.finished) return;
        this.terminateIndex();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([this.completion, new Promise<void>(resolve => {
                deadline = this.dependencies.setTimeout(() => {
                    this.finish(1, 'error', true);
                    resolve();
                }, timeoutMs);
            })]);
        } finally {
            if (deadline !== undefined) this.dependencies.clearTimeout(deadline);
        }
    }
}
