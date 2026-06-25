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
const REQUEUE_DELAY_MS = Math.max(800, Number(process.env.CLIP_RECOMMENDATIONS_REQUEUE_DELAY_MS || 5000));
const DRY_RUN = process.argv.includes('--dry-run');
const RUN_ONCE = process.argv.includes('--once');

let shutdownRequested = false;

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const { error: logError, info: logInfo, warn: logWarn } = await import('../utils/logger.js');
    const { clearCronJobDedupeByKey, parseCronQueueJob, serializeCronQueueJob } = await import('../utils/cron_jobs_queue.js');
    const {
        CLIP_RECOMMENDATION_ANALYSIS_JOB,
        CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY,
        CLIP_RECOMMENDATIONS_QUEUE_KEY
    } = await import('../utils/ai/clip_recommendations/clip_recommendations_queue.js');
    const { fetchLatestVodForChannel, runVodClipRecommendationWorkflow } = await import('../utils/ai/clip_recommendations/vod_clip_recommendation_runner.js');

    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'clip_recommendations',
            queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY,
            deadLetterKey: CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY,
            lockKey: LOCK_KEY,
            job: CLIP_RECOMMENDATION_ANALYSIS_JOB
        }, null, 2));
        return;
    }

    async function acquireWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const result = await cache.set(LOCK_KEY, lockOwnerId, { NX: true, EX: LOCK_TTL_SECONDS });
        return result === 'OK';
    }

    async function refreshWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const owner = await cache.get(LOCK_KEY);
        if (owner !== lockOwnerId) return false;
        await cache.expire(LOCK_KEY, LOCK_TTL_SECONDS);
        return true;
    }

    async function releaseWorkerLock(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const owner = await cache.get(LOCK_KEY);
        if (owner === lockOwnerId) {
            await cache.del(LOCK_KEY);
        }
    }

    async function requeueJob(job: NonNullable<ReturnType<typeof parseCronQueueJob>>): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.rPush(CLIP_RECOMMENDATIONS_QUEUE_KEY, serializeCronQueueJob(job));
    }

    function getJobAttempt(job: NonNullable<ReturnType<typeof parseCronQueueJob>>): number {
        const attempt = Number(job.data?.attempt || 1);
        return Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
    }

    function withNextAttempt(job: NonNullable<ReturnType<typeof parseCronQueueJob>>): NonNullable<ReturnType<typeof parseCronQueueJob>> {
        return {
            ...job,
            data: {
                ...(job.data || {}),
                attempt: getJobAttempt(job) + 1
            }
        };
    }

    async function processJob(job: NonNullable<ReturnType<typeof parseCronQueueJob>>): Promise<void> {
        const channelID = normalizeValue(job.channelID || job.accountID || job.data?.channelID);
        const nowUnix = Math.floor(Date.now() / 1000);
        const notBeforeUnix = Number(job.data?.notBeforeUnix || 0);

        if (!channelID) {
            await logWarn({ worker: 'clip_recommendations', message: 'Discarding job without channel ID', job }, { destination: 'console' });
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
                const attempt = getJobAttempt(job);
                if (attempt < JOB_MAX_ATTEMPTS) {
                    await requeueJob(withNextAttempt(job));
                    await logWarn({ worker: 'clip_recommendations', message: 'No recent Twitch VOD found; requeued job', attempt }, { channelId: channelID, destination: 'console' });
                    return;
                }

                const cache = await getDragonflyClient('ClipRecommendationsWorker');
                await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(job));
                await clearCronJobDedupeByKey(job.dedupeKey);
                await logWarn({ worker: 'clip_recommendations', message: 'No recent Twitch VOD found; moved job to dead letter', attempt }, { channelId: channelID, destination: 'console' });
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
            vodDurationMinutes
        });

        if (!result.error) {
            await clearCronJobDedupeByKey(job.dedupeKey);
            await logInfo({ worker: 'clip_recommendations', message: 'Processed VOD clip recommendation job', job, result }, { channelId: channelID, destination: 'console' });
            return;
        }

        const attempt = getJobAttempt(job);
        if (attempt < JOB_MAX_ATTEMPTS) {
            await requeueJob(withNextAttempt(job));
            await logWarn({ worker: 'clip_recommendations', message: 'Requeued failed job', attempt, result }, { channelId: channelID, destination: 'console' });
            return;
        }

        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(job));
        await clearCronJobDedupeByKey(job.dedupeKey);
        await logWarn({ worker: 'clip_recommendations', message: 'Max retries reached; moved job to dead letter', attempt, result }, { channelId: channelID, destination: 'console' });
    }

    async function startQueueConsumerLoop(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        while (!shutdownRequested) {
            const lockIsValid = await refreshWorkerLock(lockOwnerId);
            if (!lockIsValid) {
                await logWarn({ worker: 'clip_recommendations', message: 'Worker lock lost. Exiting.' }, { destination: 'console' });
                break;
            }

            try {
                const result = await cache.blPop(CLIP_RECOMMENDATIONS_QUEUE_KEY, QUEUE_BLOCK_TIMEOUT_SECONDS);
                if (!result) {
                    if (RUN_ONCE) break;
                    continue;
                }

                const payload = parseCronQueueJob(result.element);
                if (!payload || payload.job !== CLIP_RECOMMENDATION_ANALYSIS_JOB) {
                    if (payload) {
                        await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, serializeCronQueueJob(payload));
                        await clearCronJobDedupeByKey(payload.dedupeKey);
                    }
                    continue;
                }

                await processJob(payload);
                if (RUN_ONCE) break;
            } catch (error) {
                await logError({
                    worker: 'clip_recommendations',
                    message: 'Queue consumer loop error',
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                }, { destination: 'console' });
                await sleep(1000);
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

    const shutdown = async (signal: string): Promise<void> => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        await logInfo({ worker: 'clip_recommendations', message: 'Shutting down worker', signal }, { destination: 'console' });
        await releaseWorkerLock(lockOwnerId);
        process.exit(0);
    };
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

    await logInfo({ worker: 'clip_recommendations', message: 'Worker initialized', queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY }, { destination: 'console' });
    await startQueueConsumerLoop(lockOwnerId);
    await releaseWorkerLock(lockOwnerId);
}

main().catch((error) => {
    console.error({ worker: 'clip_recommendations', message: 'Failed to bootstrap worker', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
