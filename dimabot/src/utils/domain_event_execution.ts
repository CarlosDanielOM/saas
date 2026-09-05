import { fork, type ChildProcess } from 'node:child_process';
import type { DomainEventExecutionLease } from './domain_event_consumer.js';

export interface DomainEventExecutionConfig {
    executionTimeoutMs: number;
    operationTimeoutMs: number;
    leaseSafetyMs: number;
    shutdownGraceMs: number;
    restartDelayMs: number;
}

export type DomainEventChildMessage =
    | { type: 'polling' | 'draining' | 'beforeClaim' | 'finished' | 'drained' }
    | { type: 'claimed' | 'renewed'; lease: DomainEventExecutionLease };

export interface DomainEventChild {
    on(event: 'message', listener: (message: DomainEventChildMessage) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    kill(signal: NodeJS.Signals): boolean;
}

export function forkDomainEventConsumer(entry: URL, consumer: string, once: boolean): ChildProcess {
    return fork(entry, [`--consumer=${consumer}`, ...(once ? ['--once'] : [])], {
        // tsx installs its loader here; dropping these arguments breaks source workers.
        execArgv: process.execArgv,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
}

interface ConsumerProcess {
    child?: DomainEventChild;
    deadline: number;
    lease?: DomainEventExecutionLease;
    executionDeadline?: number;
    killing: boolean;
    drained: boolean;
    done: boolean;
}

/** One slot per registry entry. A killed slot is never reusable before exit. */
export class DomainEventExecutionSupervisor {
    private readonly slots = new Map<string, ConsumerProcess>();
    private stopping = false;
    private shutdownDeadline = Infinity;
    private failed = false;
    private resolveDrained!: (success: boolean) => void;
    private readonly drained = new Promise<boolean>((resolve) => { this.resolveDrained = resolve; });
    private resolveStopped!: () => void;
    private readonly stopped = new Promise<void>((resolve) => { this.resolveStopped = resolve; });

    constructor(
        consumers: readonly string[],
        private readonly config: DomainEventExecutionConfig,
        private readonly spawn: (consumer: string) => DomainEventChild,
        private readonly once = false,
        private readonly now = Date.now,
        private readonly report: (consumer: string, reason: string) => void = (consumer, reason) => {
            console.warn(JSON.stringify({ worker: 'domain_events', consumer, message: reason }));
        }
    ) {
        if (new Set(consumers).size !== consumers.length) throw new Error('Duplicate domain event consumer IDs');
        for (const consumer of consumers) {
            this.slots.set(consumer, { deadline: 0, killing: false, drained: false, done: false });
        }
    }

    tick(): void {
        const now = this.now();
        for (const [consumer, slot] of this.slots) {
            if (!slot.child) {
                if (!this.stopping && !slot.done && now >= slot.deadline) this.start(consumer, slot);
                continue;
            }
            if (slot.killing) continue;
            const deadline = Math.min(
                slot.deadline,
                slot.executionDeadline ?? Infinity,
                slot.lease ? slot.lease.lockedUntil - this.config.leaseSafetyMs : Infinity,
                this.shutdownDeadline
            );
            if (now >= deadline) this.kill(consumer, slot, 'Execution, lease, or shutdown watchdog expired');
        }
        this.checkDone();
    }

    private start(consumer: string, slot: ConsumerProcess): void {
        slot.killing = false;
        slot.drained = false;
        slot.lease = undefined;
        slot.executionDeadline = undefined;
        slot.deadline = this.now() + this.config.operationTimeoutMs;
        try {
            const child = this.spawn(consumer);
            slot.child = child;
            child.on('message', (message: DomainEventChildMessage) => {
                if (slot.child !== child || slot.killing || !message || typeof message !== 'object') return;
                // Late IPC must never revive an already expired execution.
                if (this.now() >= Math.min(slot.deadline, slot.executionDeadline ?? Infinity,
                    slot.lease ? slot.lease.lockedUntil - this.config.leaseSafetyMs : Infinity)) {
                    this.kill(consumer, slot, 'Late lifecycle message after watchdog deadline');
                    return;
                }
                switch (message.type) {
                    case 'claimed':
                        if (slot.lease || !Number.isFinite(message.lease?.lockedUntil) || !message.lease.leaseToken) {
                            this.kill(consumer, slot, 'Invalid or overlapping execution lease');
                            return;
                        }
                        slot.lease = message.lease;
                        slot.executionDeadline = this.now() + this.config.executionTimeoutMs;
                        slot.deadline = Infinity;
                        break;
                    case 'renewed':
                        if (!slot.lease || message.lease?.leaseToken !== slot.lease.leaseToken ||
                            !Number.isFinite(message.lease.lockedUntil)) {
                            this.kill(consumer, slot, 'Invalid execution lease renewal');
                            return;
                        }
                        slot.lease = message.lease;
                        break;
                    case 'finished':
                        slot.lease = undefined;
                        slot.executionDeadline = undefined;
                        slot.deadline = this.now() + this.config.operationTimeoutMs;
                        break;
                    case 'drained':
                        slot.drained = true;
                        slot.deadline = this.now() + this.config.shutdownGraceMs;
                        break;
                    case 'polling':
                    case 'draining':
                    case 'beforeClaim':
                        if (!slot.lease) slot.deadline = this.now() + this.config.operationTimeoutMs;
                        break;
                }
                this.tick();
            });
            child.on('error', (error: Error) => {
                if (slot.child !== child) return;
                this.report(consumer, `Child process error: ${error.message}`);
                // A failed spawn has no PID and emits close rather than exit.
                this.kill(consumer, slot, 'Child process failed');
            });
            const exited = (code: number | null): void => {
                if (slot.child !== child) return;
                slot.child = undefined;
                slot.done = this.once;
                if (this.once && (!slot.drained || code !== 0 || slot.killing)) this.failed = true;
                slot.deadline = this.now() + this.config.restartDelayMs;
                this.checkDone();
            };
            child.on('exit', exited);
            child.on('close', exited);
        } catch (error) {
            this.report(consumer, `Unable to fork consumer: ${String(error)}`);
            slot.deadline = this.now() + this.config.restartDelayMs;
            slot.done = this.once;
            this.failed = true;
        }
    }

    private kill(consumer: string, slot: ConsumerProcess, reason: string): void {
        slot.killing = true;
        this.report(consumer, reason);
        slot.child?.kill('SIGKILL');
    }

    private checkDone(): void {
        if (this.once && [...this.slots.values()].every((slot) => slot.done)) this.resolveDrained(!this.failed);
        if (this.stopping && [...this.slots.values()].every((slot) => !slot.child)) this.resolveStopped();
    }

    waitForDrain(): Promise<boolean> { return this.drained; }

    stop(): Promise<void> {
        if (!this.stopping) {
            this.stopping = true;
            this.shutdownDeadline = this.now() + this.config.shutdownGraceMs;
            for (const slot of this.slots.values()) {
                if (!slot.killing) slot.child?.kill('SIGTERM');
            }
            this.checkDone();
        }
        return this.stopped;
    }

    killAll(): void {
        this.stopping = true;
        for (const [consumer, slot] of this.slots) {
            if (slot.child && !slot.killing) this.kill(consumer, slot, 'Parent exiting');
        }
    }
}
