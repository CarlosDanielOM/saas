import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const LOCK_KEY = String(process.env.CLIP_RECOMMENDATIONS_WORKER_LOCK_KEY || 'worker:clip-recommendations:lock');
const LOCK_TTL_SECONDS = Math.max(120, Number(process.env.CLIP_RECOMMENDATIONS_WORKER_LOCK_TTL_SECONDS || 1800));
const LOCK_RETRY_MS = Math.max(2000, Number(process.env.CLIP_RECOMMENDATIONS_WORKER_LOCK_RETRY_MS || 10000));
const QUEUE_BLOCK_TIMEOUT_SECONDS = Math.max(1, Number(process.env.CLIP_RECOMMENDATIONS_QUEUE_BLOCK_TIMEOUT_SECONDS || 5));
const JOB_MAX_ATTEMPTS = Math.max(1, Number(process.env.CLIP_RECOMMENDATIONS_JOB_MAX_ATTEMPTS || 2));
const HEARTBEAT_FAILURE_LIMIT = Math.max(2, Math.floor(Number(process.env.CLIP_RECOMMENDATIONS_HEARTBEAT_FAILURE_LIMIT) || 3));
const REQUEUE_DELAY_MS = Math.max(800, Number(process.env.CLIP_RECOMMENDATIONS_REQUEUE_DELAY_MS || 5000));
const JOB_MAX_AGE_SECONDS = Math.max(300, Number(process.env.CLIP_RECOMMENDATIONS_JOB_MAX_AGE_SECONDS) || 24 * 60 * 60);
const DRY_RUN = process.argv.includes('--dry-run');
const RUN_ONCE = process.argv.includes('--once');

let shutdownRequested = false;

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

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

const ACKNOWLEDGE_CLAIM_SCRIPT = `
return redis.call('LREM', KEYS[1], 1, ARGV[1])
`;

const REQUEUE_CLAIM_SCRIPT = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) > 0 then
    return redis.call('LPUSH', KEYS[2], ARGV[2])
end
return 0
`;

async function main(): Promise<void> {
    const {
        CLIP_RECOMMENDATION_ANALYSIS_JOB,
        CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY,
        CLIP_RECOMMENDATIONS_PROCESSING_KEY,
        CLIP_RECOMMENDATIONS_QUEUE_KEY
    } = await import('../utils/ai/clip_recommendations/clip_recommendations_queue.js');

    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'clip_recommendations',
            queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY,
            processingKey: CLIP_RECOMMENDATIONS_PROCESSING_KEY,
            deadLetterKey: CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY,
            lockKey: LOCK_KEY,
            job: CLIP_RECOMMENDATION_ANALYSIS_JOB,
            maxJobAgeSeconds: JOB_MAX_AGE_SECONDS
        }, null, 2));
        return;
    }

    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const { error: logError, info: logInfo, warn: logWarn } = await import('../utils/logger.js');
    const { clearCronJobDedupeByKey, parseCronQueueJob, serializeCronQueueJob } = await import('../utils/cron_jobs_queue.js');
    const { fetchLatestVodForChannel, runVodClipRecommendationWorkflow } = await import('../utils/ai/clip_recommendations/vod_clip_recommendation_runner.js');
    const { getClipJobFailureDisposition, shouldStopAfterHeartbeatFailure } = await import('../utils/ai/clip_recommendations/vod_clip_recommender_policy.js');

    async function acquireWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const result = await cache.set(LOCK_KEY, lockOwnerId, { NX: true, EX: LOCK_TTL_SECONDS });
        return result === 'OK';
    }

    async function refreshWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const result = await cache.eval(EXTEND_LOCK_SCRIPT, {
            keys: [LOCK_KEY],
            arguments: [lockOwnerId, String(LOCK_TTL_SECONDS)]
        });
        return Number(result) === 1;
    }

    async function releaseWorkerLock(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [LOCK_KEY], arguments: [lockOwnerId] });
    }

    async function requeueJob(job: NonNullable<ReturnType<typeof parseCronQueueJob>>): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.lPush(CLIP_RECOMMENDATIONS_QUEUE_KEY, serializeCronQueueJob(job));
    }

    async function acknowledgeClaim(rawPayload: string): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.eval(ACKNOWLEDGE_CLAIM_SCRIPT, {
            keys: [CLIP_RECOMMENDATIONS_PROCESSING_KEY],
            arguments: [rawPayload]
        });
    }

    async function requeueClaim(rawPayload: string, replacementPayload = rawPayload): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.eval(REQUEUE_CLAIM_SCRIPT, {
            keys: [CLIP_RECOMMENDATIONS_PROCESSING_KEY, CLIP_RECOMMENDATIONS_QUEUE_KEY],
            arguments: [rawPayload, replacementPayload]
        });
    }

    async function recoverInterruptedClaims(): Promise<number> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        let recovered = 0;
        while (await cache.sendCommand(['RPOPLPUSH', CLIP_RECOMMENDATIONS_PROCESSING_KEY, CLIP_RECOMMENDATIONS_QUEUE_KEY])) {
            recovered += 1;
        }
        return recovered;
    }

    async function processJob(job: NonNullable<ReturnType<typeof parseCronQueueJob>>): Promise<void> {
        const channelID = normalizeValue(job.channelID || job.accountID || job.data?.channelID);
        const nowUnix = Math.floor(Date.now() / 1000);
        const notBeforeUnix = Number(job.data?.notBeforeUnix || 0);
        const requestedAtUnix = Math.floor(Date.parse(job.requestedAt) / 1000);

        if (!Number.isFinite(requestedAtUnix) || nowUnix - requestedAtUnix > JOB_MAX_AGE_SECONDS) {
            const cache = await getDragonflyClient('ClipRecommendationsWorker');
            await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(job));
            await clearCronJobDedupeByKey(job.dedupeKey);
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Stale clip recommendation job moved to dead letter without processing',
                jobID: job.id,
                requestedAt: job.requestedAt
            }, { channelId: channelID || undefined, destination: 'console' });
            return;
        }

        if (!channelID) {
            const cache = await getDragonflyClient('ClipRecommendationsWorker');
            await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(job));
            await clearCronJobDedupeByKey(job.dedupeKey);
            await logWarn({ worker: 'clip_recommendations', message: 'Job without channel ID moved to dead letter', jobID: job.id }, { destination: 'console' });
            return;
        }

        if (notBeforeUnix > nowUnix) {
            await requeueJob(job);
            await sleep(REQUEUE_DELAY_MS);
            return;
        }

        let vodUrl = normalizeValue(job.data?.vodUrl);
        let vodID = normalizeValue(job.data?.vodID);
        let vodDurationMinutes = Number(job.data?.vodDurationMinutes || 0);
        if (vodUrl === `twitch-latest:${channelID}`) {
            const vod = await fetchLatestVodForChannel(channelID);
            if (!vod) {
                const disposition = getClipJobFailureDisposition(job, JOB_MAX_ATTEMPTS);
                if (disposition.action === 'requeue') {
                    await requeueJob(disposition.job);
                    await logWarn({ worker: 'clip_recommendations', message: 'No recent Twitch VOD found; requeued job', attempt: disposition.attempt }, { channelId: channelID, destination: 'console' });
                    return;
                }

                const cache = await getDragonflyClient('ClipRecommendationsWorker');
                await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(job));
                await clearCronJobDedupeByKey(job.dedupeKey);
                await logWarn({ worker: 'clip_recommendations', message: 'No recent Twitch VOD found; moved job to dead letter', attempt: disposition.attempt }, { channelId: channelID, destination: 'console' });
                return;
            }
            vodUrl = vod.url;
            vodID = vod.id;
            vodDurationMinutes = vod.durationMinutes || vodDurationMinutes;
        }

        const result = await runVodClipRecommendationWorkflow({
            channelID,
            channel: normalizeValue(job.data?.channel),
            sessionID: normalizeValue(job.data?.sessionID),
            streamID: normalizeValue(job.data?.streamID),
            vodID,
            vodUrl,
            source: normalizeValue(job.data?.source) === 'stream_offline' ? 'stream_offline' : 'manual',
            requestedBy: normalizeValue(job.requestedBy),
            queueJobID: job.id,
            vodDurationMinutes
        });

        if (!result.error) {
            await clearCronJobDedupeByKey(job.dedupeKey);
            await logInfo({ worker: 'clip_recommendations', message: 'Processed VOD clip recommendation job', job, result }, { channelId: channelID, destination: 'console' });
            return;
        }

        const disposition = getClipJobFailureDisposition(job, JOB_MAX_ATTEMPTS);
        if (result.retryable !== false && disposition.action === 'requeue') {
            await requeueJob(disposition.job);
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Failed workflow requeued for recovery',
                attempt: disposition.attempt,
                result
            }, { channelId: channelID, destination: 'console' });
            return;
        }

        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(job));
        await clearCronJobDedupeByKey(job.dedupeKey);
        await logWarn({
            worker: 'clip_recommendations',
            message: 'Non-retryable workflow or exhausted retries moved to dead letter',
            attempt: disposition.attempt,
            result
        }, { channelId: channelID, destination: 'console' });
    }

    async function startQueueConsumerLoop(): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        while (!shutdownRequested) {
            const rawPayload = await cache.sendCommand([
                'BLMOVE',
                CLIP_RECOMMENDATIONS_QUEUE_KEY,
                CLIP_RECOMMENDATIONS_PROCESSING_KEY,
                'RIGHT',
                'LEFT',
                String(QUEUE_BLOCK_TIMEOUT_SECONDS)
            ]) as string | null;
            if (!rawPayload) {
                if (RUN_ONCE) break;
                continue;
            }
            if (shutdownRequested) {
                await requeueClaim(rawPayload);
                break;
            }

            const payload = parseCronQueueJob(rawPayload);
            if (!payload || payload.job !== CLIP_RECOMMENDATION_ANALYSIS_JOB) {
                await cache.rPush(
                    CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY,
                    payload ? serializeCronQueueJob(payload) : rawPayload
                );
                if (payload) await clearCronJobDedupeByKey(payload.dedupeKey);
                await acknowledgeClaim(rawPayload);
                if (RUN_ONCE) break;
                continue;
            }

            try {
                await processJob(payload);
                await acknowledgeClaim(rawPayload);
                if (RUN_ONCE) break;
            } catch (error) {
                const disposition = getClipJobFailureDisposition(payload, JOB_MAX_ATTEMPTS);
                if (disposition.action === 'requeue') {
                    await requeueClaim(rawPayload, serializeCronQueueJob(disposition.job));
                    await logError({
                        worker: 'clip_recommendations',
                        message: 'Queue job crashed and was returned to the queue',
                        attempt: disposition.attempt,
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined
                    }, { destination: 'console' });
                } else {
                    await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(payload));
                    await acknowledgeClaim(rawPayload);
                    await clearCronJobDedupeByKey(payload.dedupeKey);
                    await logError({
                        worker: 'clip_recommendations',
                        message: 'Queue job crashed after exhausting retries and was moved to dead letter',
                        attempt: disposition.attempt,
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined
                    }, { destination: 'console' });
                }
                if (RUN_ONCE) break;
            }
        }
    }

    const lockOwnerId = `${process.pid}-${Date.now()}`;
    await getDragonflyClient('ClipRecommendationsWorker');
    await getMongoDBConnection('ClipRecommendationsWorker');
    let lockAcquired = await acquireWorkerLock(lockOwnerId);
    while (!lockAcquired) {
        await logWarn({ worker: 'clip_recommendations', message: 'Another worker is active. Waiting for lock.', retryInMs: LOCK_RETRY_MS }, { destination: 'console' });
        await sleep(LOCK_RETRY_MS);
        if (shutdownRequested) return;
        lockAcquired = await acquireWorkerLock(lockOwnerId);
    }

    let lockLost = false;
    let consecutiveHeartbeatFailures = 0;
    const heartbeat = setInterval(() => {
        void refreshWorkerLock(lockOwnerId).then((refreshed) => {
            if (refreshed) {
                consecutiveHeartbeatFailures = 0;
                return;
            }
            lockLost = true;
            shutdownRequested = true;
        }).catch(async (error) => {
            consecutiveHeartbeatFailures += 1;
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Worker lock heartbeat failed',
                consecutiveFailures: consecutiveHeartbeatFailures,
                failureLimit: HEARTBEAT_FAILURE_LIMIT,
                error: error instanceof Error ? error.message : String(error)
            }, { destination: 'console' });
            if (shouldStopAfterHeartbeatFailure(consecutiveHeartbeatFailures, HEARTBEAT_FAILURE_LIMIT)) {
                lockLost = true;
                shutdownRequested = true;
            }
        });
    }, Math.max(5_000, Math.floor(LOCK_TTL_SECONDS * 1000 / (HEARTBEAT_FAILURE_LIMIT + 1))));
    heartbeat.unref?.();

    const shutdown = async (signal: string): Promise<void> => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        await logInfo({ worker: 'clip_recommendations', message: 'Shutting down worker', signal }, { destination: 'console' });
    };
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

    try {
        const recoveredClaims = await recoverInterruptedClaims();
        await logInfo({
            worker: 'clip_recommendations',
            message: 'Worker initialized',
            queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY,
            recoveredClaims
        }, { destination: 'console' });
        await startQueueConsumerLoop();
        if (lockLost) {
            await logWarn({ worker: 'clip_recommendations', message: 'Worker lock lost. Exiting after current work.' }, { destination: 'console' });
        }
    } finally {
        clearInterval(heartbeat);
        await releaseWorkerLock(lockOwnerId);
    }
}

main().catch((error) => {
    console.error({ worker: 'clip_recommendations', message: 'Failed to bootstrap worker', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
