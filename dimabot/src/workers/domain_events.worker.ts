import path from 'node:path';
import dotenv from 'dotenv';
import { DOMAIN_EVENT_CONSUMERS } from '../domain_events/domain_event_consumers.js';
import {
    DomainEventExecutionSupervisor, DomainEventPollSignal, forkDomainEventConsumer,
    type DomainEventChildMessage
} from '../utils/domain_event_execution.js';
import { DomainEventWakeups, domainEventWakeups, domainEventWakeupsEnabled } from '../utils/domain_event_wakeups.js';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function setting(name: string, fallback: number, min: number, max = 2_147_483_647): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
}

const POLL_INTERVAL_MS = setting('DOMAIN_EVENTS_POLL_INTERVAL_MS', 1000, 250);
const BATCH_SIZE = setting('DOMAIN_EVENTS_BATCH_SIZE', 100, 1, 500);
const MAX_ATTEMPTS = setting('DOMAIN_EVENTS_MAX_ATTEMPTS', 5, 1);
const LEASE_MS = setting('DOMAIN_EVENTS_LEASE_MS', 60_000, 5000);
const CONFIG = {
    executionTimeoutMs: setting('DOMAIN_EVENTS_EXECUTION_TIMEOUT_MS', 120_000, 1000),
    operationTimeoutMs: setting('DOMAIN_EVENTS_OPERATION_TIMEOUT_MS', 60_000, POLL_INTERVAL_MS + 1000),
    leaseSafetyMs: Math.max(500, Math.floor(LEASE_MS / 6)),
    shutdownGraceMs: setting('DOMAIN_EVENTS_SHUTDOWN_GRACE_MS', 5000, 100),
    restartDelayMs: setting('DOMAIN_EVENTS_RESTART_DELAY_MS', 1000, 100)
};
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
const consumerArgs = process.argv.slice(2).filter((arg) => arg.startsWith('--consumer'));
const consumerID = consumerArgs[0]?.slice('--consumer='.length);
const definition = DOMAIN_EVENT_CONSUMERS.find(({ consumer }) => consumer === consumerID);
if (consumerArgs.length && (consumerArgs.length !== 1 || !consumerArgs[0].startsWith('--consumer=') || !definition)) {
    throw new Error('Invalid internal --consumer ID');
}
if (definition && !DRY_RUN && !process.send) throw new Error('--consumer requires a supervised IPC child');

let shutdownRequested = false;
let supervisor: DomainEventExecutionSupervisor | undefined;
let shutdownTask: Promise<void> | undefined;
const pollSignal = new DomainEventPollSignal();
let wakeups: DomainEventWakeups | undefined;
let watchdog: NodeJS.Timeout | undefined;
const receiveWake = (message: unknown): void => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'wake') pollSignal.wake();
};

function send(message: DomainEventChildMessage): Promise<void> {
    if (!process.connected || !process.send) process.exit(1);
    return new Promise((resolve) => {
        process.send!(message, (error: Error | null) => {
            if (error) process.exit(1);
            resolve();
        });
    });
}

async function shutdown(code: number): Promise<void> {
    if (shutdownTask) return shutdownTask;
    shutdownRequested = true;
    pollSignal.stop();
    wakeups?.stop();
    domainEventWakeups.stop();
    process.off('message', receiveWake);
    shutdownTask = (async () => {
        // Keep the watchdog running until every child exit is observed, even if
        // the dispatch/connect await that received the signal never settles.
        await supervisor?.stop();
        clearInterval(watchdog);
        const forceExit = setTimeout(() => process.exit(code), CONFIG.shutdownGraceMs);
        forceExit.unref();
        try {
            const { default: mongoose } = await import('mongoose');
            await mongoose.disconnect();
        } finally {
            process.exit(code);
        }
    })();
    return shutdownTask;
}

async function bootstrap(): Promise<void> {
    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'domain_events', message: 'Dry run mode - resolved configuration',
            config: {
                pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS,
                leaseMs: LEASE_MS, ...CONFIG, isolation: 'persistent-child-per-consumer',
                maxChildren: DOMAIN_EVENT_CONSUMERS.length,
                wakeups: domainEventWakeupsEnabled() ? 'redis-hints-with-mongo-polling-fallback' : 'mongo-polling-only',
                consumer: consumerID ?? null, runOnce: RUN_ONCE,
                consumers: DOMAIN_EVENT_CONSUMERS.map(({ consumer, topics, schemaVersions }) => ({ consumer, topics, schemaVersions }))
            }
        }, null, 2));
        return;
    }

    const requestShutdown = (): void => {
        shutdownRequested = true;
        pollSignal.stop();
        if (!definition) void shutdown(0);
        // A child finishes its current delivery; the parent's grace watchdog
        // kills it if that delivery (or the event loop) cannot finish in time.
    };
    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);
    if (definition) process.once('disconnect', () => process.exit(1));
    process.once('exit', () => supervisor?.killAll());

    if (!RUN_ONCE && domainEventWakeupsEnabled()) {
        if (definition) process.on('message', receiveWake);
        else {
            wakeups = new DomainEventWakeups({ onWake: () => pollSignal.wake() });
            wakeups.start();
        }
    }

    const [{ getMongoDBConnection }, { dispatchDomainEvents, drainDomainEvents }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'),
        import('../utils/domain_event_consumer.js')
    ]);

    if (shutdownRequested) return shutdown(0);
    if (!definition && !RUN_ONCE) startSupervisor();
    await getMongoDBConnection(`DomainEventsWorker:${consumerID ?? 'dispatcher'}`);
    if (shutdownRequested) return shutdown(0);

    if (definition) {
        do {
            send({ type: 'draining' });
            try {
                const result = await drainDomainEvents({
                    ...definition, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS, leaseMs: LEASE_MS,
                    runtime: {
                        shouldStop: () => shutdownRequested,
                        beforeClaim: () => send({ type: 'beforeClaim' }),
                        claimed: (lease) => send({ type: 'claimed', lease }),
                        renewed: (lease) => send({ type: 'renewed', lease }),
                        finished: () => send({ type: 'finished' }),
                        leaseLost: (error) => {
                            // No awaited logging/cleanup: the handler must not resume effects.
                            console.error(`Domain event lease lost (${consumerID}): ${error.message}`);
                            process.exit(1);
                        }
                    }
                });
                if (shutdownRequested) break;
                if (result.ready >= BATCH_SIZE || result.scanned >= BATCH_SIZE) continue;
                if (RUN_ONCE) {
                    await send({ type: 'drained' });
                    break;
                }
            } catch (error) {
                console.warn(`Domain event consumer ${consumerID} failed: ${String(error)}`);
                if (RUN_ONCE) throw error;
            }
            send({ type: 'polling' });
            await pollSignal.wait(POLL_INTERVAL_MS);
        } while (!shutdownRequested);
    } else {
        do {
            let dispatched = 0;
            try {
                dispatched = await dispatchDomainEvents(DOMAIN_EVENT_CONSUMERS, BATCH_SIZE);
                if (dispatched > 0 && domainEventWakeupsEnabled()) supervisor?.wake();
            } catch (error) {
                console.warn(`Domain event dispatch failed: ${String(error)}`);
                if (RUN_ONCE) throw error;
            }
            if (shutdownRequested) break;
            if (RUN_ONCE) {
                // Children start only after the once batch is durably dispatched.
                startSupervisor();
                if (!await supervisor!.waitForDrain()) throw new Error('One or more consumer drains failed');
                break;
            }
            if (dispatched < BATCH_SIZE) await pollSignal.wait(POLL_INTERVAL_MS);
        } while (!shutdownRequested);
    }
    await shutdown(0);
}

function startSupervisor(): void {
    supervisor = new DomainEventExecutionSupervisor(
        DOMAIN_EVENT_CONSUMERS.map(({ consumer }) => consumer), CONFIG,
        (consumer) => forkDomainEventConsumer(new URL(import.meta.url), consumer, RUN_ONCE), RUN_ONCE
    );
    watchdog = setInterval(() => supervisor!.tick(), 100);
    watchdog.unref();
    supervisor.tick();
}

bootstrap().catch((error) => {
    console.error(JSON.stringify({ worker: 'domain_events', message: 'Domain event worker failed', error: String(error) }));
    void shutdown(1);
});
