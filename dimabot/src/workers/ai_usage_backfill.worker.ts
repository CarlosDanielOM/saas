import path from 'node:path';
import dotenv from 'dotenv';
import { USAGE_QUEUES, claimUsageJob, completeUsageJob, failUsageJob } from '../utils/ai_usage_queue_health.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const ENABLED = process.env.AI_USAGE_BACKFILL_ENABLED !== 'false';
const RUN_ON_START = process.env.AI_USAGE_BACKFILL_RUN_ON_START !== 'false';
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
const REQUEST_DELAY_MS = Math.max(250, Number(process.env.AI_USAGE_BACKFILL_REQUEST_DELAY_MS || 1_000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.AI_USAGE_BACKFILL_MAX_ATTEMPTS || 3));
const QUEUE_WAIT_SECONDS = Math.max(1, Number(process.env.AI_USAGE_BACKFILL_QUEUE_WAIT_SECONDS || 5));
const SWEEP_LOCK_SECONDS = Math.max(300, Number(process.env.AI_USAGE_BACKFILL_SWEEP_LOCK_SECONDS || 86_400));
const SWEEP_LOCK_KEY = 'worker:ai-usage-backfill:daily-sweep';

const RECLAIM_SCRIPT = `
local moved = 0
while true do
  local item = redis.call('LPOP', KEYS[1])
  if not item then return moved end
  redis.call('LPUSH', KEYS[2], item)
  moved = moved + 1
end
`;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayToNextUtcMidnight(now = new Date()): number {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1_000, next.getTime() - now.getTime());
}

async function bootstrap(): Promise<void> {
    if (!ENABLED) {
        console.log(JSON.stringify({ worker: 'ai_usage_backfill', message: 'AI usage backfill worker disabled' }));
        return;
    }
    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'ai_usage_backfill', message: 'Dry run mode - resolved configuration',
            config: { runOnStart: RUN_ON_START, requestDelayMs: REQUEST_DELAY_MS, maxAttempts: MAX_ATTEMPTS }
        }));
        return;
    }

    const [
        { default: UsersSchema },
        queue,
        { syncAiUsageBackfillJob },
        { getDragonflyClient },
        { getMongoDBConnection },
        { error: logError, info: logInfo, warn: logWarn },
        { default: mongoose }
    ] = await Promise.all([
        import('../schemas/users.schema.js'),
        import('../utils/ai_usage_backfill_queue.js'),
        import('../utils/ai_usage_backfill.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/databases/mongodb.database.js'),
        import('../utils/logger.js'),
        import('mongoose')
    ]);
    await getMongoDBConnection('AiUsageBackfillWorker');
    const cache = await getDragonflyClient('AiUsageBackfillWorker');
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const consumerKey = 'worker:ai-usage-backfill:consumer';
    const consumerOwner = `${process.pid}-${Date.now()}`;
    while (await cache.set(consumerKey, consumerOwner, { NX: true, EX: 120 }) !== 'OK') {
        if (RUN_ONCE || stopping) { cache.destroy(); await mongoose.disconnect(); return; }
        await sleep(1000);
    }
    const heartbeat = setInterval(() => {
        void cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0",
            { keys: [consumerKey], arguments: [consumerOwner] }).then(value => { if (Number(value) !== 1) process.exit(1); }).catch(() => process.exit(1));
    }, 30_000);
    heartbeat.unref();
    const releaseConsumer = async () => {
        clearInterval(heartbeat);
        await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [consumerKey], arguments: [consumerOwner] });
    };
    await cache.eval(RECLAIM_SCRIPT, {
        keys: [queue.AI_USAGE_BACKFILL_PROCESSING_KEY, queue.AI_USAGE_BACKFILL_QUEUE_KEY], arguments: []
    });

    async function enqueueSweep(reason: 'daily_sweep' | 'startup_sweep'): Promise<number> {
        const owner = `${process.pid}-${Date.now()}`;
        const acquired = await cache.set(SWEEP_LOCK_KEY, owner, { NX: true, EX: SWEEP_LOCK_SECONDS });
        if (acquired !== 'OK') return 0;
        let enqueued = 0;
        try {
            const users = await UsersSchema.find({
                polar_sh_customer_id: { $type: 'string', $ne: '' },
                accounts: { $elemMatch: { type: 'twitch', id: { $type: 'string', $ne: '' } } }
            }).select('accounts polar_sh_customer_id plan_tier').lean().exec();
            for (const user of users) {
                const channelIDs = [...new Set(user.accounts
                    .filter((account) => account.type === 'twitch' && account.id)
                    .map((account) => String(account.id)))];
                for (const channelID of channelIDs) {
                    const result = await queue.enqueueAiUsageBackfill(cache, {
                        channelID,
                        customerId: user.polar_sh_customer_id,
                        planTier: user.plan_tier,
                        reason
                    });
                    if (result.enqueued) enqueued += 1;
                }
            }
            await logInfo({
                worker: 'ai_usage_backfill', message: 'AI usage backfill sweep queued',
                reason, users: users.length, jobs: enqueued
            }, { destination: 'console' });
            return enqueued;
        } finally {
            await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [SWEEP_LOCK_KEY], arguments: [owner] });
        }
    }

    async function claimJob(): Promise<string | null> {
        return claimUsageJob(cache, USAGE_QUEUES[1]);
    }

    async function processOne(): Promise<boolean> {
        const raw = await claimJob();
        if (!raw) return false;
        const job = queue.parseAiUsageBackfillJob(raw);
        if (!job) {
            await failUsageJob(cache, USAGE_QUEUES[1], raw, true);
            await logWarn({ worker: 'ai_usage_backfill', message: 'Invalid backfill job moved to dead-letter queue' }, { destination: 'console' });
            return true;
        }
        try {
            const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: job.channelID } } }).select('plan_tier polar_sh_customer_id').lean().exec();
            if (!user || user.polar_sh_customer_id !== job.customerId) {
                await completeUsageJob(cache, USAGE_QUEUES[1], raw);
                await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [job.dedupeKey], arguments: [job.id] });
                return true;
            }
            job.planTier = user.plan_tier || 'free';
            const result = await syncAiUsageBackfillJob(job, cache);
            await completeUsageJob(cache, USAGE_QUEUES[1], raw);
            await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [job.dedupeKey], arguments: [job.id] });
            await logInfo({
                worker: 'ai_usage_backfill', message: 'AI usage ledger sync completed',
                jobID: job.id, reason: job.reason, ...result
            }, { channelId: job.channelID, destination: 'console' });
        } catch (caught) {
            const outcome = await failUsageJob(cache, USAGE_QUEUES[1], raw, false, MAX_ATTEMPTS);
            if (outcome === 2) await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [job.dedupeKey], arguments: [job.id] });
            await logError({ worker: 'ai_usage_backfill', message: outcome === 2 ? 'AI usage backfill exhausted retries' : 'AI usage backfill requeued after failure',
                channelID: job.channelID, error: caught instanceof Error ? caught.message : String(caught) }, { destination: 'both' });
        }
        await sleep(REQUEST_DELAY_MS);
        return true;
    }

    async function drainQueue(): Promise<void> {
        while (!stopping && await processOne()) { /* drain sequentially to respect Polar */ }
    }

    function scheduleSweep(): void {
        const delay = delayToNextUtcMidnight();
        setTimeout(async () => {
            try {
                await enqueueSweep('daily_sweep');
            } catch (caught) {
                await logError({
                    worker: 'ai_usage_backfill', message: 'Daily AI usage sweep failed',
                    error: caught instanceof Error ? caught.message : String(caught)
                }, { destination: 'both' });
            }
            scheduleSweep();
        }, delay).unref?.();
    }

    if (RUN_ONCE) {
        await enqueueSweep('startup_sweep');
        await drainQueue();
        await releaseConsumer();
        cache.destroy();
        await mongoose.disconnect();
        return;
    }

    if (RUN_ON_START) await enqueueSweep('startup_sweep');
    scheduleSweep();
    while (!stopping) {
        const processed = await processOne();
        if (!processed) await sleep(QUEUE_WAIT_SECONDS * 1_000);
    }
    await releaseConsumer();
    cache.destroy();
    await mongoose.disconnect();
}

bootstrap().catch((caught) => {
    console.error(JSON.stringify({
        worker: 'ai_usage_backfill', message: 'Failed to bootstrap AI usage backfill worker',
        error: caught instanceof Error ? caught.message : String(caught),
        stack: caught instanceof Error ? caught.stack : undefined
    }, null, 2));
    process.exit(1);
});
