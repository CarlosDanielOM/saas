import { createClient, type RedisClientOptions } from 'redis';

const CHANNEL = 'domain-events:wakeup:v1';

export function domainEventWakeupsEnabled(): boolean {
    return process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED?.toLowerCase() !== 'false';
}

export interface DomainEventWakeupClient {
    connect(): Promise<unknown>;
    publish(channel: string, message: string): Promise<unknown>;
    subscribe(channel: string, listener: () => void): Promise<unknown>;
    on(event: 'error' | 'ready', listener: () => void): unknown;
    destroy(): void;
    unref?(): unknown;
}

interface WakeupOptions {
    onWake?: () => void;
    createClient?: (options: RedisClientOptions) => DomainEventWakeupClient;
    timeoutMs?: number;
    retryMs?: number;
    idleMs?: number;
}

/** Hints only: one connection, one command, and one pending bit, never an event queue. */
export class DomainEventWakeups {
    private client?: DomainEventWakeupClient;
    private ready = false;
    private busy = false;
    private pending = false;
    private stopped = false;
    private listening = false;
    private scheduled?: NodeJS.Immediate;
    private deadline?: NodeJS.Timeout;
    private retry?: NodeJS.Timeout;
    private idle?: NodeJS.Timeout;
    private readonly timeoutMs: number;

    constructor(private readonly options: WakeupOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? 500;
    }

    start(): void {
        if (this.stopped || !domainEventWakeupsEnabled() || !this.options.onWake) return;
        this.listening = true;
        this.schedule();
    }

    publish(): void {
        if (this.stopped || !domainEventWakeupsEnabled() || this.retry || this.options.onWake) return;
        this.pending = true;
        clearTimeout(this.idle);
        this.schedule();
    }

    private schedule(): void {
        if (this.scheduled || this.stopped || this.retry || this.busy) return;
        // Even cold client creation/connection is outside the producer's journal ACK.
        this.scheduled = setImmediate(() => {
            this.scheduled = undefined;
            this.pump();
        });
        this.scheduled.unref();
    }

    private pump(): void {
        if (this.stopped || this.busy || this.retry) return;
        if (!this.client) {
            try {
                const client = (this.options.createClient ?? createClient)({
                    url: `redis://${process.env.DRAGONFLY_HOST}:${process.env.DRAGONFLY_PORT}`,
                    socket: { connectTimeout: this.timeoutMs, reconnectStrategy: false },
                    disableOfflineQueue: true,
                    commandsQueueMaxLength: 4
                });
                this.client = client;
                client.on('error', () => { if (this.client === client) this.failed(); });
                // A TCP connect may complete after stop/destroy; do not revive that client.
                client.on('ready', () => { if (this.client !== client) this.destroy(client); });
                client.unref?.();
                this.run(client, () => client.connect(), () => {
                    this.ready = true;
                    if (this.listening) {
                        this.run(client, () => client.subscribe(CHANNEL, () => {
                            if (this.client === client && !this.stopped) this.options.onWake?.();
                        }), () => undefined);
                    } else {
                        this.pump();
                    }
                });
            } catch {
                this.failed();
            }
            return;
        }
        if (this.ready && this.pending) {
            const client = this.client;
            this.pending = false;
            this.run(client, () => client.publish(CHANNEL, '1'), () => {
                if (this.pending) this.schedule();
                else {
                    this.idle = setTimeout(() => this.reset(), this.options.idleMs ?? 30_000);
                    this.idle.unref();
                }
            });
        }
    }

    private run(client: DomainEventWakeupClient, operation: () => Promise<unknown>, done: () => void): void {
        this.busy = true;
        // Destroy actually flushes node-redis's command queue, unlike Promise.race.
        this.deadline = setTimeout(() => { if (this.client === client) this.failed(); }, this.timeoutMs);
        this.deadline.unref();
        try {
            void operation().then(() => {
                if (this.client !== client) { this.destroy(client); return; }
                clearTimeout(this.deadline);
                this.busy = false;
                done();
            }).catch(() => { if (this.client === client) this.failed(); });
        } catch {
            if (this.client === client) this.failed();
        }
    }

    private destroy(client: DomainEventWakeupClient): void {
        try { client.destroy(); } catch { /* Already closed. Hints must not affect Mongo. */ }
    }

    private reset(): void {
        clearTimeout(this.deadline);
        clearTimeout(this.idle);
        const client = this.client;
        this.client = undefined;
        this.ready = this.busy = this.pending = false;
        if (client) this.destroy(client);
    }

    private failed(): void {
        this.reset();
        if (this.stopped || this.retry) return;
        // Subscribers retry independently of Mongo; publishers drop failed hints and cool down.
        this.retry = setTimeout(() => {
            this.retry = undefined;
            if (this.listening) this.schedule();
        }, this.options.retryMs ?? 1000);
        this.retry.unref();
    }

    stop(): void {
        this.stopped = true;
        if (this.scheduled) clearImmediate(this.scheduled);
        clearTimeout(this.retry);
        this.reset();
    }
}

export const domainEventWakeups = new DomainEventWakeups();
