import path from 'node:path';
import dotenv from 'dotenv';
import type { RedisClientType } from 'redis';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const POLL_INTERVAL_MS = Math.max(250, Number(process.env.DOMAIN_EVENTS_POLL_INTERVAL_MS || 1000));
const BATCH_SIZE = Math.max(1, Math.min(500, Number(process.env.DOMAIN_EVENTS_BATCH_SIZE || 100)));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.DOMAIN_EVENTS_MAX_ATTEMPTS || 5));
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

let shutdownRequested = false;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap(): Promise<void> {
    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'domain_events',
            message: 'Dry run mode - resolved configuration',
            config: {
                pollIntervalMs: POLL_INTERVAL_MS,
                batchSize: BATCH_SIZE,
                maxAttempts: MAX_ATTEMPTS,
                runOnce: RUN_ONCE
            }
        }, null, 2));
        return;
    }

    const [
        { getMongoDBConnection },
        { getDragonflyClient },
        { drainDomainEvents },
        { applyStreamAnalyticsDomainEvent },
        { DOMAIN_EVENTS_WAKEUP_STREAM },
        { info: logInfo, warn: logWarn }
    ] = await Promise.all([
        import('../utils/databases/mongodb.database.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/domain_event_consumer.js'),
        import('../domain_events/stream_analytics_events.js'),
        import('../utils/domain_events.js'),
        import('../utils/logger.js')
    ]);

    await getMongoDBConnection('DomainEventsWorker');

    let wakeupClient: RedisClientType | null = null;
    const connectWakeupClient = async (): Promise<RedisClientType | null> => {
        try {
            const baseClient = await getDragonflyClient('DomainEventsWorker');
            const duplicate = baseClient.duplicate();
            duplicate.on('error', () => undefined);
            await duplicate.connect();
            return duplicate;
        } catch (error) {
            await logWarn({
                worker: 'domain_events',
                message: 'Dragonfly wake-up stream unavailable; Mongo polling remains active',
                error: error instanceof Error ? error.message : String(error)
            }, { destination: 'console' });
            return null;
        }
    };

    const shutdown = (signal: string): void => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        wakeupClient?.destroy();
        wakeupClient = null;
        void logInfo({
            worker: 'domain_events',
            message: 'Shutdown requested',
            signal
        }, { destination: 'console' });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    wakeupClient = await connectWakeupClient();
    await logInfo({
        worker: 'domain_events',
        message: 'Domain event consumer initialized',
        pollIntervalMs: POLL_INTERVAL_MS,
        batchSize: BATCH_SIZE,
        maxAttempts: MAX_ATTEMPTS
    }, { destination: 'console' });

    while (!shutdownRequested) {
        const result = await drainDomainEvents({
            consumer: 'stream-analytics-v1',
            topics: ['channel'],
            handler: applyStreamAnalyticsDomainEvent,
            batchSize: BATCH_SIZE,
            maxAttempts: MAX_ATTEMPTS
        });

        if (RUN_ONCE) break;
        if (result.scanned >= BATCH_SIZE) continue;

        if (!wakeupClient?.isReady) {
            await sleep(POLL_INTERVAL_MS);
            wakeupClient = await connectWakeupClient();
            continue;
        }

        try {
            await wakeupClient.xRead({
                key: DOMAIN_EVENTS_WAKEUP_STREAM,
                id: '$'
            }, {
                BLOCK: POLL_INTERVAL_MS,
                COUNT: 1
            });
        } catch (error) {
            wakeupClient.destroy();
            wakeupClient = null;
            await logWarn({
                worker: 'domain_events',
                message: 'Dragonfly wake-up read failed; falling back to Mongo polling',
                error: error instanceof Error ? error.message : String(error)
            }, { destination: 'console' });
            await sleep(POLL_INTERVAL_MS);
        }
    }
    wakeupClient?.destroy();
}

bootstrap().catch((error) => {
    console.error(JSON.stringify({
        worker: 'domain_events',
        message: 'Domain event worker failed',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    }, null, 2));
    process.exit(1);
});
