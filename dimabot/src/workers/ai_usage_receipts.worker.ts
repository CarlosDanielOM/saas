import { runWorker } from './worker_loop.js';

const finite = (value: string | undefined, fallback: number) => Number.isFinite(Number(value || fallback)) ? Number(value || fallback) : fallback;
const INTERVAL_MS = Math.max(250, finite(process.env.AI_USAGE_RECEIPTS_INTERVAL_MS, 1_000));
const BATCH_SIZE = Math.max(1, Math.min(1_000, Math.ceil(finite(process.env.AI_USAGE_RECEIPTS_BATCH_SIZE, 200))));
const LOCK_KEY = String(process.env.AI_USAGE_RECEIPTS_LOCK_KEY || 'worker:ai-usage-receipts:lock');
const LOCK_TTL_SECONDS = Math.max(30, Math.floor(finite(process.env.AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS, 300)));
// Initialization, each receipt and each maintenance step get their own bound; a whole batch may take longer.
const UNIT_LIMIT_MS = 20_000;
const MAINTENANCE_MS = 10_000;

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

class UnitTimeout extends Error { constructor() { super('AI usage operation exceeded its 20-second watchdog'); } }
/** A stalled step fails the pass, and the supervisor restarts the worker; claimed jobs are reclaimed, never dropped. */
async function unit<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new UnitTimeout()), UNIT_LIMIT_MS); })]); }
    finally { clearTimeout(timer); }
}

if (process.env.AI_USAGE_RECEIPTS_ENABLED === 'false') {
    console.log(JSON.stringify({ worker: 'ai_usage_receipts', message: 'AI usage receipts worker disabled', enabled: false }));
} else await runWorker({
    name: 'ai-usage-receipts', prefix: 'ai_usage_receipts', batchMetric: 'batch_receipts',
    dryRun: JSON.stringify({ worker: 'ai_usage_receipts', message: 'Dry run mode - resolved configuration',
        config: { intervalMs: INTERVAL_MS, batchSize: BATCH_SIZE, lockKey: LOCK_KEY, lockTtlSeconds: LOCK_TTL_SECONDS } }),
    // Only storage failures and watchdog timeouts throw; a receipt that fails is requeued or dead-lettered in place.
    onFailure: 'exit',
    async setup(stopping) {
        const [
            { default: UsersSchema },
            { AI_USAGE_RECEIPT_PROCESSING_KEY, AI_USAGE_RECEIPT_QUEUE_KEY, parseQueuedAiUsageReceipt, persistAiUsageReceipt },
            { USAGE_QUEUES, claimUsageJob, completeUsageJob, failUsageJob, monitorAiUsageQueues },
            { refreshAiUsageDashboards },
            { getDragonflyClient }, { getMongoDBConnection }, { error: logError, info: logInfo },
        ] = await Promise.all([
            import('../schemas/users.schema.js'), import('../utils/ai_usage_ledger.js'), import('../utils/ai_usage_queue_health.js'),
            import('../utils/ai_usage_dashboard.js'), import('../utils/databases/dragonfly.database.js'),
            import('../utils/databases/mongodb.database.js'), import('../utils/logger.js'),
        ]);
        const [, cache] = await unit(Promise.all([getMongoDBConnection('AiUsageReceiptsWorker'), getDragonflyClient('AiUsageReceiptsWorker')]));
        const once = process.argv.includes('--once'), queue = USAGE_QUEUES[0];
        const planCache = new Map<string, { tier: 'free' | 'premium' | 'pro'; expiresAt: number }>();
        const resolvePlan = async (channelID: string): Promise<'free' | 'premium' | 'pro'> => {
            const cached = planCache.get(channelID);
            if (cached && cached.expiresAt > Date.now()) return cached.tier;
            const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean().exec();
            const tier = user?.plan_tier === 'pro' ? 'pro' : user?.plan_tier === 'premium' ? 'premium' : 'free';
            planCache.set(channelID, { tier, expiresAt: Date.now() + 60_000 });
            return tier;
        };

        /** `null` when the queue is empty; otherwise whether this receipt was fully handled. */
        const processNext = async (counts: Record<string, number>): Promise<boolean | null> => {
            const raw = await claimUsageJob(cache, queue);
            if (typeof raw !== 'string' || !raw) return null;
            counts.processed += 1;
            const receipt = parseQueuedAiUsageReceipt(raw);
            if (!receipt) {
                counts.invalid += 1;
                await failUsageJob(cache, queue, raw, true);
                return false;
            }
            try {
                const result = await persistAiUsageReceipt(receipt, await resolvePlan(receipt.channelID));
                counts[result === 'inserted' ? 'inserted' : result === 'duplicate' ? 'duplicates' : 'expired'] += 1;
                await completeUsageJob(cache, queue, raw);
                await cache.incr(`twitch:${receipt.channelID}:ai:usage-receipts:generation`);
                return true;
            } catch (caught) {
                counts.failed += 1;
                await failUsageJob(cache, queue, raw);
                await logError({
                    worker: 'ai_usage_receipts', message: 'Receipt persistence failed; requeued or retained in dead letters',
                    channelID: receipt.channelID, error: caught instanceof Error ? caught.message : String(caught)
                }, { destination: 'both' });
                return false;
            }
        };

        const runBatch = async (): Promise<{ processed: number; success: boolean; ready: boolean }> => {
            const idle = { processed: 0, success: true, ready: false };
            if (stopping.aborted) return idle;
            const owner = `${process.pid}-${Date.now()}`;
            if (await unit(cache.set(LOCK_KEY, owner, { NX: true, EX: LOCK_TTL_SECONDS })) !== 'OK') return idle;
            let lockLost = false;
            const heartbeat = setInterval(() => {
                void cache.eval(EXTEND_LOCK_SCRIPT, { keys: [LOCK_KEY], arguments: [owner, String(LOCK_TTL_SECONDS)] })
                    .then(value => { if (Number(value) !== 1) lockLost = true; }).catch(() => { lockLost = true; });
            }, Math.max(5_000, Math.floor(LOCK_TTL_SECONDS * 1000 / 3)));
            heartbeat.unref();
            const counts = { processed: 0, inserted: 0, duplicates: 0, expired: 0, invalid: 0, failed: 0 };
            let success = true, released = false, failure: unknown;
            try {
                if (!stopping.aborted) {
                    await unit(cache.eval(RECLAIM_SCRIPT, { keys: [AI_USAGE_RECEIPT_PROCESSING_KEY, AI_USAGE_RECEIPT_QUEUE_KEY], arguments: [] }));
                    while (!stopping.aborted && !lockLost && counts.processed < BATCH_SIZE) {
                        const handled = await unit(processNext(counts));
                        if (handled === null) break;
                        success &&= handled;
                    }
                }
                if (counts.processed > 0 || once) {
                    await logInfo({ worker: 'ai_usage_receipts', message: 'AI usage receipt batch completed', ...counts }, { destination: 'console' });
                }
            } catch (caught) { failure = caught ?? new Error('AI usage receipt batch failed'); }
            finally { clearInterval(heartbeat); }
            // After a watchdog timeout the stalled step may still be running, so the lock keeps its TTL.
            if (failure instanceof UnitTimeout) throw failure;
            try { released = Number(await unit(cache.eval(RELEASE_LOCK_SCRIPT, { keys: [LOCK_KEY], arguments: [owner] }))) === 1; }
            catch (caught) { failure ??= caught; }
            if (failure) throw failure;
            // Continue at once only after a clean, full batch whose lock was still ours when released. A partial
            // batch already saw the queue empty, and a failed one keeps the normal interval so retries are paced.
            const ready = success && counts.processed === BATCH_SIZE && !stopping.aborted && !lockLost && released;
            return { processed: counts.processed, success, ready };
        };

        let lastMaintenance = 0;
        const maintain = async (): Promise<void> => {
            if (stopping.aborted || (!once && Date.now() - lastMaintenance < MAINTENANCE_MS)) return;
            await refreshAiUsageDashboards(20, { stopping: () => stopping.aborted, bound: unit });
            if (stopping.aborted) return;
            await unit(monitorAiUsageQueues(cache));
            lastMaintenance = Date.now();
        };

        return {
            async pass() {
                const batch = await runBatch();
                await maintain();
                return { events: batch.success ? batch.processed : 0, failed: !batch.success, ready: batch.ready };
            },
            delayMs: outcome => outcome?.ready ? 0 : INTERVAL_MS,
        };
    },
});
