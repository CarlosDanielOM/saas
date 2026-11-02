import path from 'path';
import dotenv from 'dotenv';
import { CLIP_CLAIM_SCRIPTS } from '../utils/ai/clip_recommendations/clip_recommendation_claims.js';

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
const RECONCILIATION_INTERVAL_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATIONS_RECONCILIATION_INTERVAL_MS) || 15 * 60 * 1000);
const RECONCILIATION_BATCH_SIZE = Math.max(1, Math.floor(Number(process.env.CLIP_RECOMMENDATIONS_RECONCILIATION_BATCH_SIZE) || 25));
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
            maxJobAgeSeconds: JOB_MAX_AGE_SECONDS,
            reconciliationIntervalMs: RECONCILIATION_INTERVAL_MS,
            reconciliationBatchSize: RECONCILIATION_BATCH_SIZE
        }, null, 2));
        return;
    }

    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const { error: logError, info: logInfo, warn: logWarn } = await import('../utils/logger.js');
    const { parseCronQueueJob, serializeCronQueueJob } = await import('../utils/cron_jobs_queue.js');
    const { fetchLatestVodForChannel, runVodClipRecommendationWorkflow } = await import('../utils/ai/clip_recommendations/vod_clip_recommendation_runner.js');
    const { getClipJobFailureDisposition, getClipWorkflowFailureDisposition, shouldStopAfterHeartbeatFailure } = await import('../utils/ai/clip_recommendations/vod_clip_recommender_policy.js');
    const { reconcileClipRecommendations } = await import('../utils/ai/clip_recommendations/clip_recommendation_reconciliation.js');
    const { claimDurableCronJob, completeDurableCronJob, retryDurableCronJob, deadDurableCronJob, uncertainDurableCronJob, renewDurableCronJobClaim, assertDurableCronJobClaim, recoverDurableCronJobs } = await import('../utils/durable_cron_jobs.js');
    type Claim = import('../utils/durable_cron_jobs.js').DurableCronJobClaim;
    let activeClaim: Claim | null = null;
    let durableLeaseLost = false;
    let durableTransitionAttempted = false;

    function requireOwnership(result: unknown): void {
        if (result !== -1) return;
        lockLost = true;
        shutdownRequested = true;
        throw new Error('Clip worker no longer owns the queue lease');
    }

    async function assertActive(): Promise<void> {
        if (lockLost || !await refreshWorkerLock(lockOwnerId)) requireOwnership(-1);
        if (activeClaim && (durableLeaseLost || !await assertDurableCronJobClaim(activeClaim))) throw new Error('Clip Mongo claim lost');
    }

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

    async function acknowledgePhysical(rawPayload: string): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const result = await cache.eval(CLIP_CLAIM_SCRIPTS.acknowledge, {
            keys: [LOCK_KEY, CLIP_RECOMMENDATIONS_PROCESSING_KEY], arguments: [lockOwnerId, rawPayload]
        });
        requireOwnership(result);
    }

    async function acknowledgeClaim(rawPayload: string, _dedupeKey?: string): Promise<void> {
        durableTransitionAttempted = true;
        if (!activeClaim || !await completeDurableCronJob(activeClaim)) throw new Error('Clip claim completion lost');
        activeClaim = null;
        await acknowledgePhysical(rawPayload);
    }

    async function requeueClaim(rawPayload: string, replacementPayload = rawPayload): Promise<void> {
        const job = parseCronQueueJob(replacementPayload);
        if (!activeClaim || !job) throw new Error('Missing durable clip claim or retry payload');
        const notBefore = Number(job.data?.notBeforeUnix || 0) * 1000;
        const due = new Date(Math.max(Date.now() + REQUEUE_DELAY_MS, notBefore));
        durableTransitionAttempted = true;
        if (!await retryDurableCronJob(activeClaim, job, due)) throw new Error('Clip claim retry lost');
        activeClaim = null;
        await acknowledgePhysical(rawPayload);
    }

    async function deadLetterClaim(rawPayload: string, deadLetterPayload: string, _dedupeKey?: string): Promise<void> {
        if (activeClaim) {
            durableTransitionAttempted = true;
            if (!await deadDurableCronJob(activeClaim, 'Clip job failed or expired')) throw new Error('Clip claim dead-letter transition lost');
            activeClaim = null;
            // Mongo is authoritative; retain the Redis operator view best-effort.
            try { const cache = await getDragonflyClient('ClipRecommendationsWorker'); await cache.rPush(CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY, deadLetterPayload); }
            catch (error) { console.error('Clip dead-letter mirror failed', error); }
            await acknowledgePhysical(rawPayload);
            return;
        }
        // Malformed/unsupported legacy payloads have no durable business intent.
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        const result = await cache.eval(CLIP_CLAIM_SCRIPTS.deadLetter, {
            keys: [LOCK_KEY, CLIP_RECOMMENDATIONS_PROCESSING_KEY, CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY],
            arguments: [lockOwnerId, rawPayload, deadLetterPayload]
        });
        requireOwnership(result);
    }

    async function recoverInterruptedClaims(): Promise<number> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        let recovered = 0;
        while (recovered < 100) {
            const result = await cache.eval(CLIP_CLAIM_SCRIPTS.recover, {
                keys: [LOCK_KEY, CLIP_RECOMMENDATIONS_PROCESSING_KEY, CLIP_RECOMMENDATIONS_QUEUE_KEY],
                arguments: [lockOwnerId]
            });
            requireOwnership(result);
            if (!result) break;
            recovered += 1;
        }
        return recovered;
    }

    let reconciliationRunning = false;
    async function reconcileRecoverableRecommendations(): Promise<number> {
        if (reconciliationRunning || shutdownRequested) return 0;
        reconciliationRunning = true;
        try {
            await assertActive();
            return await reconcileClipRecommendations({
                batchSize: RECONCILIATION_BATCH_SIZE,
                intervalMs: RECONCILIATION_INTERVAL_MS,
                shouldContinue: () => !shutdownRequested
            });
        } finally {
            reconciliationRunning = false;
        }
    }

    async function processJob(rawPayload: string, job: NonNullable<ReturnType<typeof parseCronQueueJob>>): Promise<void> {
        const channelID = normalizeValue(job.channelID || job.accountID || job.data?.channelID);
        const nowUnix = Math.floor(Date.now() / 1000);
        const notBeforeUnix = Number(job.data?.notBeforeUnix || 0);
        const requestedAtUnix = Math.floor(Date.parse(job.requestedAt) / 1000);

        if (!Number.isFinite(requestedAtUnix) || nowUnix - requestedAtUnix > JOB_MAX_AGE_SECONDS) {
            await deadLetterClaim(rawPayload, serializeCronQueueJob(job), job.dedupeKey);
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Stale clip recommendation job moved to dead letter without processing',
                jobID: job.id,
                requestedAt: job.requestedAt
            }, { channelId: channelID || undefined, destination: 'console' });
            return;
        }

        if (!channelID) {
            await deadLetterClaim(rawPayload, serializeCronQueueJob(job), job.dedupeKey);
            await logWarn({ worker: 'clip_recommendations', message: 'Job without channel ID moved to dead letter', jobID: job.id }, { destination: 'console' });
            return;
        }

        if (notBeforeUnix > nowUnix) {
            await requeueClaim(rawPayload, serializeCronQueueJob(job));
            return;
        }

        let vodUrl = normalizeValue(job.data?.vodUrl);
        let vodID = normalizeValue(job.data?.vodID);
        let vodDurationMinutes = Number(job.data?.vodDurationMinutes || 0);
        if (vodUrl === `twitch-latest:${channelID}`) {
            await assertActive();
            const vod = await fetchLatestVodForChannel(channelID);
            if (!vod) {
                const disposition = getClipJobFailureDisposition(job, JOB_MAX_ATTEMPTS);
                if (disposition.action === 'requeue') {
                    await requeueClaim(rawPayload, serializeCronQueueJob(disposition.job));
                    await logWarn({ worker: 'clip_recommendations', message: 'No recent Twitch VOD found; requeued job', attempt: disposition.attempt }, { channelId: channelID, destination: 'console' });
                    return;
                }

                await deadLetterClaim(rawPayload, serializeCronQueueJob(job), job.dedupeKey);
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
            source: normalizeValue(job.data?.originalSource || job.data?.source) === 'stream_offline' ? 'stream_offline' : 'manual',
            requestedBy: normalizeValue(job.requestedBy),
            queueJobID: normalizeValue(job.data?.recommendationQueueJobID) || job.id,
            recoveryOnly: Boolean(normalizeValue(job.data?.recommendationQueueJobID)),
            cleanupOnly: job.data?.recoveryMode === 'cleanup',
            assertActive,
            vodDurationMinutes
        });

        if (!result.error) {
            await acknowledgeClaim(rawPayload, job.dedupeKey);
            await logInfo({ worker: 'clip_recommendations', message: 'Processed VOD clip recommendation job', job, result }, { channelId: channelID, destination: 'console' });
            return;
        }

        const disposition = getClipWorkflowFailureDisposition(job, JOB_MAX_ATTEMPTS, result.retryable);
        if (disposition.action === 'requeue') {
            await requeueClaim(rawPayload, serializeCronQueueJob(disposition.job));
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Failed workflow requeued for recovery',
                attempt: disposition.attempt,
                result
            }, { channelId: channelID, destination: 'console' });
            return;
        }

        await deadLetterClaim(rawPayload, serializeCronQueueJob(job), job.dedupeKey);
        await logWarn({
            worker: 'clip_recommendations',
            message: 'Non-retryable workflow or exhausted retries moved to dead letter',
            attempt: disposition.attempt,
            result
        }, { channelId: channelID, destination: 'console' });
    }

    async function startQueueConsumerLoop(): Promise<void> {
        const cache = await getDragonflyClient('ClipRecommendationsWorker');
        let nextRecoveryAt = 0;
        while (!shutdownRequested) {
            if (Date.now() >= nextRecoveryAt) {
                const recoveredClaims = await recoverInterruptedClaims();
                const recovery = await recoverDurableCronJobs(CLIP_RECOMMENDATIONS_QUEUE_KEY, { limit: 100 });
                nextRecoveryAt = recoveredClaims === 100 || recovery.examined === 100 || recovery.uncertain === 100 ? 0 : Date.now() + 30_000;
            }
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
            if (shutdownRequested) break;

            const payload = parseCronQueueJob(rawPayload);
            if (!payload || payload.job !== CLIP_RECOMMENDATION_ANALYSIS_JOB) {
                await deadLetterClaim(
                    rawPayload,
                    payload ? serializeCronQueueJob(payload) : rawPayload,
                    payload?.dedupeKey
                );
                if (RUN_ONCE) break;
                continue;
            }

            let canonicalJob = payload;
            let didClaim = false;
            try {
                const claimed = await claimDurableCronJob(payload, CLIP_RECOMMENDATIONS_QUEUE_KEY, lockOwnerId);
                if (claimed.status !== 'claimed') {
                    await acknowledgePhysical(rawPayload);
                    if (RUN_ONCE) break;
                    continue;
                }
                activeClaim = claimed.claim;
                didClaim = true;
                canonicalJob = claimed.job;
                durableLeaseLost = false;
                durableTransitionAttempted = false;
                const renewal = setInterval(() => {
                    const renewing = activeClaim;
                    if (!renewing) return;
                    void renewDurableCronJobClaim(renewing).then(ok => { if (!ok && activeClaim === renewing) durableLeaseLost = true; }).catch(() => { if (activeClaim === renewing) durableLeaseLost = true; });
                }, 60_000);
                renewal.unref?.();
                try { await processJob(rawPayload, claimed.job); }
                finally { clearInterval(renewal); }

                if (RUN_ONCE) break;
            } catch (error) {
                if (!activeClaim && !didClaim && !lockLost) {
                    const result = await cache.eval(CLIP_CLAIM_SCRIPTS.requeue, {
                        keys: [LOCK_KEY, CLIP_RECOMMENDATIONS_PROCESSING_KEY, CLIP_RECOMMENDATIONS_QUEUE_KEY],
                        arguments: [lockOwnerId, rawPayload, rawPayload]
                    });
                    requireOwnership(result);
                    await sleep(1000);
                }
                if (!activeClaim || lockLost || durableLeaseLost || durableTransitionAttempted) {
                    await logError({ worker: 'clip_recommendations', message: 'Claim or acknowledgement lost; retaining transport payload', error: error instanceof Error ? error.message : String(error) }, { destination: 'console' });
                    if (lockLost || durableLeaseLost || durableTransitionAttempted) { shutdownRequested = true; break; }
                    continue;
                }
                // An unexpected exception can follow an accepted external effect.
                // Keep the ambiguity visible instead of blindly replaying it.
                const message = error instanceof Error ? error.message : String(error);
                if (!await uncertainDurableCronJob(activeClaim, message)) throw new Error('Clip uncertain transition lost');
                activeClaim = null;
                await acknowledgePhysical(rawPayload);
                await logError({ worker: 'clip_recommendations', message: 'Clip job outcome uncertain',
                    jobID: canonicalJob.id, error: message }, { destination: 'console' });
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

    let reconciliationTimer: NodeJS.Timeout | null = null;
    try {
        const recoveredClaims = await recoverInterruptedClaims();
        const reconciledRecommendations = await reconcileRecoverableRecommendations();
        await logInfo({
            worker: 'clip_recommendations',
            message: 'Worker initialized',
            queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY,
            recoveredClaims,
            reconciledRecommendations
        }, { destination: 'console' });
        reconciliationTimer = setInterval(() => {
            void reconcileRecoverableRecommendations().then(async (enqueued) => {
                if (enqueued > 0) {
                    await logInfo({
                        worker: 'clip_recommendations',
                        message: 'Queued clip recommendation recovery jobs',
                        enqueued
                    }, { destination: 'console' });
                }
            }).catch(async (error) => {
                await logError({
                    worker: 'clip_recommendations',
                    message: 'Clip recommendation reconciliation failed',
                    error: error instanceof Error ? error.message : String(error)
                }, { destination: 'console' });
            });
        }, RECONCILIATION_INTERVAL_MS);
        reconciliationTimer.unref?.();
        await startQueueConsumerLoop();
        if (lockLost) {
            await logWarn({ worker: 'clip_recommendations', message: 'Worker lock lost. Exiting after current work.' }, { destination: 'console' });
        }
    } finally {
        if (reconciliationTimer) clearInterval(reconciliationTimer);
        clearInterval(heartbeat);
        await releaseWorkerLock(lockOwnerId);
    }
}

main().catch((error) => {
    console.error({ worker: 'clip_recommendations', message: 'Failed to bootstrap worker', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
