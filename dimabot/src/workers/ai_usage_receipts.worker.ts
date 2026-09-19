import path from 'node:path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const INTERVAL_MS = Math.max(250, Number(process.env.AI_USAGE_RECEIPTS_INTERVAL_MS || 1_000));
const BATCH_SIZE = Math.max(1, Math.min(1_000, Number(process.env.AI_USAGE_RECEIPTS_BATCH_SIZE || 200)));
const LOCK_KEY = String(process.env.AI_USAGE_RECEIPTS_LOCK_KEY || 'worker:ai-usage-receipts:lock');
const LOCK_TTL_SECONDS = Math.max(30, Number(process.env.AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS || 300));
const ENABLED = process.env.AI_USAGE_RECEIPTS_ENABLED !== 'false';
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

const CLAIM_SCRIPT = `
local item = redis.call('RPOP', KEYS[1])
if item then redis.call('LPUSH', KEYS[2], item) end
return item
`;
const RECLAIM_SCRIPT = `
local moved = 0
while true do
    local item = redis.call('RPOP', KEYS[1])
    if not item then return moved end
    redis.call('LPUSH', KEYS[2], item)
    moved = moved + 1
end
`;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
const EXTEND_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 0
`;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap(): Promise<void> {
    if (!ENABLED) {
        console.log(JSON.stringify({ worker: 'ai_usage_receipts', message: 'AI usage receipts worker disabled', enabled: false }));
        return;
    }
    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'ai_usage_receipts', message: 'Dry run mode - resolved configuration',
            config: { intervalMs: INTERVAL_MS, batchSize: BATCH_SIZE, lockKey: LOCK_KEY, lockTtlSeconds: LOCK_TTL_SECONDS }
        }));
        return;
    }

    const [
        { default: UsersSchema },
        { AI_USAGE_RECEIPT_PROCESSING_KEY, AI_USAGE_RECEIPT_QUEUE_KEY, parseQueuedAiUsageReceipt, persistAiUsageReceipt },
        { getDragonflyClient },
        { getMongoDBConnection },
        { error: logError, info: logInfo },
        { default: mongoose }
    ] = await Promise.all([
        import('../schemas/users.schema.js'),
        import('../utils/ai_usage_ledger.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/databases/mongodb.database.js'),
        import('../utils/logger.js'),
        import('mongoose')
    ]);

    await getMongoDBConnection('AiUsageReceiptsWorker');
    const cache = await getDragonflyClient('AiUsageReceiptsWorker');
    let shutdownRequested = false;
    let resolveShutdown: (() => void) | undefined;
    const shutdownSignal = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    const planCache = new Map<string, { tier: 'free' | 'premium' | 'pro'; expiresAt: number }>();
    const shutdown = () => {
        shutdownRequested = true;
        resolveShutdown?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    const resolvePlan = async (channelID: string): Promise<'free' | 'premium' | 'pro'> => {
        const cached = planCache.get(channelID);
        if (cached && cached.expiresAt > Date.now()) return cached.tier;
        const user = await UsersSchema.findOne({
            accounts: { $elemMatch: { type: 'twitch', id: channelID } }
        }).select('plan_tier').lean().exec();
        const tier = user?.plan_tier === 'pro' ? 'pro' : user?.plan_tier === 'premium' ? 'premium' : 'free';
        planCache.set(channelID, { tier, expiresAt: Date.now() + 60_000 });
        return tier;
    };

    const run = async (): Promise<void> => {
        const owner = `${process.pid}-${Date.now()}`;
        const acquired = await cache.set(LOCK_KEY, owner, { NX: true, EX: LOCK_TTL_SECONDS });
        if (acquired !== 'OK') return;
        let lockLost = false;
        const heartbeat = setInterval(() => {
            void cache.eval(EXTEND_LOCK_SCRIPT, {
                keys: [LOCK_KEY], arguments: [owner, String(LOCK_TTL_SECONDS)]
            }).then((value) => { if (Number(value) !== 1) lockLost = true; }).catch(() => { lockLost = true; });
        }, Math.max(5_000, Math.floor(LOCK_TTL_SECONDS * 1000 / 3)));
        heartbeat.unref?.();
        const counts = { processed: 0, inserted: 0, duplicates: 0, expired: 0, invalid: 0, failed: 0 };
        try {
            await cache.eval(RECLAIM_SCRIPT, {
                keys: [AI_USAGE_RECEIPT_PROCESSING_KEY, AI_USAGE_RECEIPT_QUEUE_KEY], arguments: []
            });
            while (!shutdownRequested && !lockLost && counts.processed < BATCH_SIZE) {
                const raw = await cache.eval(CLAIM_SCRIPT, {
                    keys: [AI_USAGE_RECEIPT_QUEUE_KEY, AI_USAGE_RECEIPT_PROCESSING_KEY], arguments: []
                });
                if (typeof raw !== 'string' || !raw) break;
                counts.processed += 1;
                const receipt = parseQueuedAiUsageReceipt(raw);
                if (!receipt) {
                    counts.invalid += 1;
                    await cache.rPush(`${AI_USAGE_RECEIPT_QUEUE_KEY}:dead`, raw);
                    await cache.lRem(AI_USAGE_RECEIPT_PROCESSING_KEY, 1, raw);
                    continue;
                }
                try {
                    const result = await persistAiUsageReceipt(receipt, await resolvePlan(receipt.channelID));
                    if (result === 'inserted') counts.inserted += 1;
                    else if (result === 'duplicate') counts.duplicates += 1;
                    else counts.expired += 1;
                    await cache.lRem(AI_USAGE_RECEIPT_PROCESSING_KEY, 1, raw);
                    await cache.incr(`twitch:${receipt.channelID}:ai:usage-receipts:generation`);
                } catch (caught) {
                    counts.failed += 1;
                    await logError({
                        worker: 'ai_usage_receipts', message: 'Receipt persistence failed; claim retained for retry',
                        channelID: receipt.channelID,
                        error: caught instanceof Error ? caught.message : String(caught)
                    }, { destination: 'both' });
                    break;
                }
            }
            if (counts.processed > 0 || RUN_ONCE) {
                await logInfo({ worker: 'ai_usage_receipts', message: 'AI usage receipt batch completed', ...counts }, { destination: 'console' });
            }
        } finally {
            clearInterval(heartbeat);
            await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [LOCK_KEY], arguments: [owner] });
        }
    };

    if (RUN_ONCE) {
        await run();
        cache.destroy();
        await mongoose.disconnect();
        return;
    }
    while (!shutdownRequested) {
        await run();
        await Promise.race([sleep(INTERVAL_MS), shutdownSignal]);
    }
    cache.destroy();
    await mongoose.disconnect();
}

bootstrap().catch((caught) => {
    console.error(JSON.stringify({
        worker: 'ai_usage_receipts', message: 'Failed to bootstrap AI usage receipts worker',
        error: caught instanceof Error ? caught.message : String(caught),
        stack: caught instanceof Error ? caught.stack : undefined
    }, null, 2));
    process.exit(1);
});
