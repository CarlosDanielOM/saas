import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const INTERVAL_MS = Math.max(250, Number(process.env.FOLLOW_DEFENSE_WORKER_INTERVAL_MS || 1000));
const LOCK_KEY = String(process.env.FOLLOW_DEFENSE_WORKER_LOCK_KEY || 'worker:follow-defense:lock');
const LOCK_TTL_SECONDS = Math.max(30, Number(process.env.FOLLOW_DEFENSE_WORKER_LOCK_TTL_SECONDS || 120));
const LOCK_RETRY_MS = Math.max(1000, Number(process.env.FOLLOW_DEFENSE_WORKER_LOCK_RETRY_MS || 5000));

const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) {
    console.log(JSON.stringify({
        worker: 'follow_defense',
        message: 'Dry run mode - resolved configuration',
        config: {
            intervalMs: INTERVAL_MS,
            runOnce: RUN_ONCE,
            dryRun: DRY_RUN,
            lockKey: LOCK_KEY,
            lockTtlSeconds: LOCK_TTL_SECONDS,
            lockRetryMs: LOCK_RETRY_MS,
            nodeEnv: process.env.NODE_ENV || 'development'
        }
    }, null, 2));
    process.exit(0);
}

let shutdownRequested = false;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap(): Promise<void> {
    const [
        { getDragonflyClient },
        { getMongoDBConnection },
        { processFollowDefenseQueue, expireFollowDefenseModes },
        { error: logError, info: logInfo, warn: logWarn }
    ] = await Promise.all([
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/databases/mongodb.database.js'),
        import('../utils/follow_defense.js'),
        import('../utils/logger.js')
    ]);

    await getMongoDBConnection();

    async function acquireWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('FollowDefenseWorker');
        const result = await cache.set(LOCK_KEY, lockOwnerId, {
            NX: true,
            EX: LOCK_TTL_SECONDS
        });
        return result === 'OK';
    }

    async function refreshWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('FollowDefenseWorker');
        const activeOwner = await cache.get(LOCK_KEY);
        if (activeOwner !== lockOwnerId) {
            return false;
        }
        await cache.expire(LOCK_KEY, LOCK_TTL_SECONDS);
        return true;
    }

    async function releaseWorkerLock(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('FollowDefenseWorker');
        const activeOwner = await cache.get(LOCK_KEY);
        if (activeOwner === lockOwnerId) {
            await cache.del(LOCK_KEY);
        }
    }

    async function runTick(lockOwnerId: string): Promise<void> {
        const lockIsValid = await refreshWorkerLock(lockOwnerId);
        if (!lockIsValid) {
            throw new Error('Worker lock lost; another follow defense worker appears active');
        }

        const processed = await processFollowDefenseQueue();
        const expired = await expireFollowDefenseModes();
        if (processed > 0 || expired > 0) {
            await logInfo({
                worker: 'follow_defense',
                message: 'Processed follow defense tick',
                processed,
                expired
            }, { destination: 'console' });
        }
    }

    const lockOwnerId = `${process.pid}-${Date.now()}`;

    while (!shutdownRequested) {
        const acquired = await acquireWorkerLock(lockOwnerId);
        if (!acquired) {
            await logWarn({
                worker: 'follow_defense',
                message: 'Another follow defense worker is active; waiting for lock'
            }, { destination: 'console' });
            if (RUN_ONCE) return;
            await sleep(LOCK_RETRY_MS);
            continue;
        }

        await logInfo({
            worker: 'follow_defense',
            message: 'Follow defense worker lock acquired',
            lockOwnerId
        }, { destination: 'console' });

        try {
            do {
                await runTick(lockOwnerId);
                if (RUN_ONCE) break;
                await sleep(INTERVAL_MS);
            } while (!shutdownRequested);
        } catch (error) {
            await logError({
                worker: 'follow_defense',
                message: 'Follow defense worker loop failed',
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            }, { destination: 'console' });
            if (RUN_ONCE) {
                throw error;
            }
        } finally {
            await releaseWorkerLock(lockOwnerId);
        }

        if (!RUN_ONCE && !shutdownRequested) {
            await sleep(LOCK_RETRY_MS);
        }
    }
}

process.on('SIGTERM', () => {
    shutdownRequested = true;
});

process.on('SIGINT', () => {
    shutdownRequested = true;
});

bootstrap().catch((error) => {
    console.error('Fatal follow defense worker error:', error);
    process.exit(1);
});
