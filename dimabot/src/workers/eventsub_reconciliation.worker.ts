import path from 'node:path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const INTERVAL_MS = Math.max(60 * 60_000, Number(process.env.EVENTSUB_RECONCILIATION_INTERVAL_MS || 6 * 60 * 60_000));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.EVENTSUB_RECONCILIATION_REQUEST_DELAY_MS || 250));
const LOCK_KEY = String(process.env.EVENTSUB_RECONCILIATION_LOCK_KEY || 'worker:eventsub-reconciliation:lock');
const LOCK_TTL_SECONDS = Math.max(600, Number(process.env.EVENTSUB_RECONCILIATION_LOCK_TTL_SECONDS || 3 * 60 * 60));
const MISSING_GRACE_MS = Math.max(60_000, Number(process.env.EVENTSUB_RECONCILIATION_MISSING_GRACE_MS || 12 * 60 * 60_000));
const UNHEALTHY_CIRCUIT_BREAKER_RATIO = Math.min(1, Math.max(0, Number(process.env.EVENTSUB_RECONCILIATION_UNHEALTHY_RATIO || 0.25)));
const UNHEALTHY_CIRCUIT_BREAKER_MIN_COUNT = Math.max(1, Number(process.env.EVENTSUB_RECONCILIATION_UNHEALTHY_MIN_COUNT || 5));
const RUN_ON_START = process.env.EVENTSUB_RECONCILIATION_RUN_ON_START !== 'false';
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

const EXTEND_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

async function bootstrap(): Promise<void> {
    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'eventsub_reconciliation',
            message: 'Dry run mode - resolved configuration',
            config: { intervalMs: INTERVAL_MS, requestDelayMs: REQUEST_DELAY_MS, missingGraceMs: MISSING_GRACE_MS, unhealthyCircuitBreakerRatio: UNHEALTHY_CIRCUIT_BREAKER_RATIO, unhealthyCircuitBreakerMinCount: UNHEALTHY_CIRCUIT_BREAKER_MIN_COUNT, lockKey: LOCK_KEY, lockTtlSeconds: LOCK_TTL_SECONDS, runOnStart: RUN_ON_START, runOnce: RUN_ONCE }
        }, null, 2));
        return;
    }

    const [
        { default: TwitchStreamers },
        { getDragonflyClient },
        { getMongoDBConnection },
        { reconcileEventsubs },
        { error: logError, info: logInfo },
        { default: mongoose }
    ] = await Promise.all([
        import('../classes/twitch_streamers.class.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/databases/mongodb.database.js'),
        import('../utils/eventsub_reconciliation.js'),
        import('../utils/logger.js'),
        import('mongoose')
    ]);

    await getMongoDBConnection('EventsubReconciliationWorker');
    await TwitchStreamers.getTwitchAccountsFromDB();
    const cache = await getDragonflyClient('EventsubReconciliationWorker');
    let shutdownRequested = false;
    let activeOwner = '';
    let resolveShutdown: (() => void) | undefined;
    const shutdownSignal = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    const releaseLock = async (owner: string): Promise<void> => {
        await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [LOCK_KEY], arguments: [owner] });
    };
    const shutdown = async (): Promise<void> => {
        shutdownRequested = true;
        resolveShutdown?.();
        if (activeOwner) await releaseLock(activeOwner);
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });

    const run = async (): Promise<void> => {
        const owner = `${process.pid}-${Date.now()}`;
        const acquired = await cache.set(LOCK_KEY, owner, { NX: true, EX: LOCK_TTL_SECONDS });
        if (acquired !== 'OK') return;
        activeOwner = owner;
        let lockLost = false;
        const heartbeat = setInterval(() => {
            void (async () => {
                const extended = await cache.eval(EXTEND_LOCK_SCRIPT, {
                    keys: [LOCK_KEY],
                    arguments: [owner, String(LOCK_TTL_SECONDS)]
                });
                if (Number(extended) !== 1) lockLost = true;
            })().catch(() => { lockLost = true; });
        }, Math.max(5_000, Math.floor(LOCK_TTL_SECONDS * 1000 / 3)));
        heartbeat.unref?.();
        try {
            const result = await reconcileEventsubs({
                requestDelayMs: REQUEST_DELAY_MS,
                missingGraceMs: MISSING_GRACE_MS,
                unhealthyCircuitBreakerRatio: UNHEALTHY_CIRCUIT_BREAKER_RATIO,
                unhealthyCircuitBreakerMinCount: UNHEALTHY_CIRCUIT_BREAKER_MIN_COUNT,
                shouldContinue: async () => !shutdownRequested
                    && !lockLost
                    && await cache.get(LOCK_KEY) === owner
            });
            await logInfo({ worker: 'eventsub_reconciliation', message: 'EventSub reconciliation completed', ...result }, { destination: 'console' });
        } catch (error) {
            if (shutdownRequested || lockLost) return;
            await logError({
                worker: 'eventsub_reconciliation',
                message: 'EventSub reconciliation failed',
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            }, { destination: 'both' });
        } finally {
            clearInterval(heartbeat);
            await releaseLock(owner);
            if (activeOwner === owner) activeOwner = '';
        }
    };

    if (RUN_ONCE) {
        await run();
        cache.destroy();
        await mongoose.disconnect();
        return;
    }
    if (RUN_ON_START) {
        await run();
    }
    while (!shutdownRequested) {
        await Promise.race([sleep(INTERVAL_MS), shutdownSignal]);
        if (!shutdownRequested) await run();
    }
    cache.destroy();
    await mongoose.disconnect();
}

bootstrap().catch((error) => {
    console.error(JSON.stringify({
        worker: 'eventsub_reconciliation',
        message: 'Failed to bootstrap EventSub reconciliation worker',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    }, null, 2));
    process.exit(1);
});
