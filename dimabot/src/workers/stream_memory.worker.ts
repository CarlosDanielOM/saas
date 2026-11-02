import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const LOCK_KEY = String(process.env.STREAM_MEMORY_WORKER_LOCK_KEY || 'worker:stream-memory:lock');
const LOCK_TTL_SECONDS = Math.max(120, Number(process.env.STREAM_MEMORY_WORKER_LOCK_TTL_SECONDS || 900));
const LOCK_RETRY_MS = Math.max(2000, Number(process.env.STREAM_MEMORY_WORKER_LOCK_RETRY_MS || 10000));
const CHANNEL_LOCK_PREFIX = String(process.env.STREAM_MEMORY_CHANNEL_LOCK_PREFIX || 'cron:stream-memory:running');
const CHANNEL_LOCK_SECONDS = Math.max(60, Number(process.env.STREAM_MEMORY_CHANNEL_LOCK_SECONDS || 1200));
const MEMORY_PROCESSING_KEY = 'cron:stream-memory:processing';
const QUEUE_BLOCK_TIMEOUT_SECONDS = Math.max(1, Number(process.env.STREAM_MEMORY_QUEUE_BLOCK_TIMEOUT_SECONDS || 5));
const RUN_ON_START = process.env.STREAM_MEMORY_RUN_ON_START !== 'false';
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
const JOB_MAX_ATTEMPTS = Math.max(1, Number(process.env.STREAM_MEMORY_JOB_MAX_ATTEMPTS || 3));
const REQUEUE_DELAY_MS = Math.max(800, Number(process.env.STREAM_MEMORY_REQUEUE_DELAY_MS || 2500));
const WEEKLY_SCHEDULE_UTC_DAY = Math.max(0, Math.min(6, Number(process.env.STREAM_MEMORY_WEEKLY_SCHEDULE_DAY_UTC || 1)));
const WEEKLY_SCHEDULE_UTC_HOUR = Math.max(0, Math.min(23, Number(process.env.STREAM_MEMORY_WEEKLY_SCHEDULE_HOUR_UTC || 0)));
const WEEKLY_SCHEDULE_UTC_MINUTE = Math.max(0, Math.min(59, Number(process.env.STREAM_MEMORY_WEEKLY_SCHEDULE_MINUTE_UTC || 15)));
const MONTHLY_SCHEDULE_UTC_DAY = Math.max(1, Math.min(28, Number(process.env.STREAM_MEMORY_MONTHLY_SCHEDULE_DAY_UTC || 1)));
const MONTHLY_SCHEDULE_UTC_HOUR = Math.max(0, Math.min(23, Number(process.env.STREAM_MEMORY_MONTHLY_SCHEDULE_HOUR_UTC || 0)));
const MONTHLY_SCHEDULE_UTC_MINUTE = Math.max(0, Math.min(59, Number(process.env.STREAM_MEMORY_MONTHLY_SCHEDULE_MINUTE_UTC || 30)));

let shutdownRequested = false;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastWeeklyPeriodScheduled = '';
let lastMonthlyPeriodScheduled = '';

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChannelLockKey(channelID: string): string {
    return `${CHANNEL_LOCK_PREFIX}:${normalizeValue(channelID)}`;
}

async function runDryRun(): Promise<void> {
    const {
        STREAM_MEMORY_QUEUE_KEY,
        STREAM_MEMORY_DEAD_LETTER_KEY,
        STREAM_MEMORY_SUMMARY_JOB,
        STREAM_MEMORY_WEEKLY_JOB,
        STREAM_MEMORY_MONTHLY_JOB,
        getWeeklyMaintenancePeriodToken,
        getMonthlyMaintenancePeriodToken
    } = await import('../utils/ai/memory/stream_memory_queue.js');

    const now = new Date();
    const weeklyToken = getWeeklyMaintenancePeriodToken(now);
    const monthlyToken = getMonthlyMaintenancePeriodToken(now);

    const config = {
        mode: RUN_ONCE ? 'once' : 'scheduler',
        dryRun: true,
        flags: {
            RUN_ONCE,
            RUN_ON_START,
            DRY_RUN
        },
        intervals: {
            LOCK_TTL_SECONDS,
            LOCK_RETRY_MS,
            CHANNEL_LOCK_SECONDS,
            QUEUE_BLOCK_TIMEOUT_SECONDS,
            JOB_MAX_ATTEMPTS,
            REQUEUE_DELAY_MS
        },
        schedule: {
            weekly: {
                utcDay: WEEKLY_SCHEDULE_UTC_DAY,
                utcHour: WEEKLY_SCHEDULE_UTC_HOUR,
                utcMinute: WEEKLY_SCHEDULE_UTC_MINUTE,
                currentPeriodToken: weeklyToken
            },
            monthly: {
                utcDay: MONTHLY_SCHEDULE_UTC_DAY,
                utcHour: MONTHLY_SCHEDULE_UTC_HOUR,
                utcMinute: MONTHLY_SCHEDULE_UTC_MINUTE,
                currentPeriodToken: monthlyToken
            }
        },
        keys: {
            LOCK_KEY,
            CHANNEL_LOCK_PREFIX,
            STREAM_MEMORY_QUEUE_KEY,
            STREAM_MEMORY_DEAD_LETTER_KEY
        },
        jobs: {
            STREAM_MEMORY_SUMMARY_JOB,
            STREAM_MEMORY_WEEKLY_JOB,
            STREAM_MEMORY_MONTHLY_JOB
        },
        environment: {
            NODE_ENV: process.env.NODE_ENV || 'undefined',
            STREAM_MEMORY_WORKER_LOCK_KEY: process.env.STREAM_MEMORY_WORKER_LOCK_KEY || 'worker:stream-memory:lock (default)',
            STREAM_MEMORY_WORKER_LOCK_TTL_SECONDS: process.env.STREAM_MEMORY_WORKER_LOCK_TTL_SECONDS || '900 (default)',
            STREAM_MEMORY_WORKER_LOCK_RETRY_MS: process.env.STREAM_MEMORY_WORKER_LOCK_RETRY_MS || '10000 (default)',
            STREAM_MEMORY_CHANNEL_LOCK_PREFIX: process.env.STREAM_MEMORY_CHANNEL_LOCK_PREFIX || 'cron:stream-memory:running (default)',
            STREAM_MEMORY_CHANNEL_LOCK_SECONDS: process.env.STREAM_MEMORY_CHANNEL_LOCK_SECONDS || '1200 (default)',
            STREAM_MEMORY_QUEUE_BLOCK_TIMEOUT_SECONDS: process.env.STREAM_MEMORY_QUEUE_BLOCK_TIMEOUT_SECONDS || '5 (default)',
            STREAM_MEMORY_RUN_ON_START: process.env.STREAM_MEMORY_RUN_ON_START || 'true (default)',
            STREAM_MEMORY_JOB_MAX_ATTEMPTS: process.env.STREAM_MEMORY_JOB_MAX_ATTEMPTS || '3 (default)',
            STREAM_MEMORY_REQUEUE_DELAY_MS: process.env.STREAM_MEMORY_REQUEUE_DELAY_MS || '2500 (default)',
            STREAM_MEMORY_WEEKLY_SCHEDULE_DAY_UTC: process.env.STREAM_MEMORY_WEEKLY_SCHEDULE_DAY_UTC || '1 (default)',
            STREAM_MEMORY_WEEKLY_SCHEDULE_HOUR_UTC: process.env.STREAM_MEMORY_WEEKLY_SCHEDULE_HOUR_UTC || '0 (default)',
            STREAM_MEMORY_WEEKLY_SCHEDULE_MINUTE_UTC: process.env.STREAM_MEMORY_WEEKLY_SCHEDULE_MINUTE_UTC || '15 (default)',
            STREAM_MEMORY_MONTHLY_SCHEDULE_DAY_UTC: process.env.STREAM_MEMORY_MONTHLY_SCHEDULE_DAY_UTC || '1 (default)',
            STREAM_MEMORY_MONTHLY_SCHEDULE_HOUR_UTC: process.env.STREAM_MEMORY_MONTHLY_SCHEDULE_HOUR_UTC || '0 (default)',
            STREAM_MEMORY_MONTHLY_SCHEDULE_MINUTE_UTC: process.env.STREAM_MEMORY_MONTHLY_SCHEDULE_MINUTE_UTC || '30 (default)'
        }
    };

    console.log(JSON.stringify(config, null, 2));
}

async function main(): Promise<void> {
    if (DRY_RUN) {
        await runDryRun();
        return;
    }

    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const TwitchStreamers = (await import('../classes/twitch_streamers.class.js')).default;
    const { error: logError, info: logInfo, warn: logWarn } = await import('../utils/logger.js');
    const { clearCronJobDedupeByKey, parseCronQueueJob, serializeCronQueueJob } = await import('../utils/cron_jobs_queue.js');
    const {
        STREAM_MEMORY_DEAD_LETTER_KEY,
        STREAM_MEMORY_MONTHLY_JOB,
        STREAM_MEMORY_QUEUE_KEY,
        STREAM_MEMORY_SUMMARY_JOB,
        STREAM_MEMORY_WEEKLY_JOB,
        enqueueMemoryMaintenanceJob,
        getMonthlyMaintenancePeriodToken,
        getWeeklyMaintenancePeriodToken
    } = await import('../utils/ai/memory/stream_memory_queue.js');
    const { runStreamMemoryWorkflow } = await import('../utils/ai/memory/stream_memory_runner.js');
    const { claimDurableCronJob, completeDurableCronJob, retryDurableCronJob, deadDurableCronJob, uncertainDurableCronJob, renewDurableCronJobClaim, assertDurableCronJobClaim, recoverDurableCronJobs } = await import('../utils/durable_cron_jobs.js');
    const { recordStreamMemoryActionMetric, recordStreamMemoryJobMetric } = await import('../utils/observability/bot_runtime_metrics.js');

    async function acquireWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('StreamMemoryWorker');
        const result = await cache.set(LOCK_KEY, lockOwnerId, {
            NX: true,
            EX: LOCK_TTL_SECONDS
        });
        return result === 'OK';
    }

    async function refreshWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('StreamMemoryWorker');
        const owner = await cache.get(LOCK_KEY);
        if (owner !== lockOwnerId) {
            return false;
        }
        await cache.expire(LOCK_KEY, LOCK_TTL_SECONDS);
        return true;
    }

    async function releaseWorkerLock(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('StreamMemoryWorker');
        const owner = await cache.get(LOCK_KEY);
        if (owner === lockOwnerId) {
            await cache.del(LOCK_KEY);
        }
    }

    async function acquireChannelLock(channelID: string, owner: string): Promise<boolean> {
        const cache = await getDragonflyClient('StreamMemoryWorker');
        const lockKey = getChannelLockKey(channelID);
        const lockValue = owner;
        const result = await cache.set(lockKey, lockValue, {
            NX: true,
            EX: CHANNEL_LOCK_SECONDS
        });
        return result === 'OK';
    }

    async function releaseChannelLock(channelID: string, owner: string): Promise<void> {
        const cache = await getDragonflyClient('StreamMemoryWorker');
        await cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", {
            keys: [getChannelLockKey(channelID)], arguments: [owner]
        });
    }

    async function requeueJob(job: ReturnType<typeof parseCronQueueJob>): Promise<void> {
        if (!job) return;
        const cache = await getDragonflyClient('StreamMemoryWorker');
        await cache.rPush(STREAM_MEMORY_QUEUE_KEY, serializeCronQueueJob(job));
    }

    async function scheduleMaintenanceForCadence(cadence: 'weekly' | 'monthly', periodToken: string): Promise<void> {
        const streamerIDs = await TwitchStreamers.getTwitchStreamers();
        if (!streamerIDs.length) {
            return;
        }
        let enqueued = 0;
        for (const channelID of streamerIDs) {
            const result = await enqueueMemoryMaintenanceJob({
                channelID,
                cadence,
                requestedBy: 'stream_memory_worker_scheduler',
                reason: `${cadence}_scheduled`,
                periodToken
            });
            if (result.enqueued) {
                enqueued += 1;
            }
        }
        await logInfo({
            worker: 'stream_memory',
            message: 'Scheduled maintenance jobs for cadence',
            cadence,
            periodToken,
            channels: streamerIDs.length,
            enqueued
        }, { destination: 'console' });
    }

    async function runSchedulerTick(): Promise<void> {
        const now = new Date();
        const utcDay = now.getUTCDay();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();
        const weeklyPeriodToken = getWeeklyMaintenancePeriodToken(now);
        if (utcDay === WEEKLY_SCHEDULE_UTC_DAY
            && utcHour === WEEKLY_SCHEDULE_UTC_HOUR
            && utcMinute >= WEEKLY_SCHEDULE_UTC_MINUTE
            && lastWeeklyPeriodScheduled !== weeklyPeriodToken) {
            lastWeeklyPeriodScheduled = weeklyPeriodToken;
            await scheduleMaintenanceForCadence('weekly', weeklyPeriodToken);
        }
        const monthlyPeriodToken = getMonthlyMaintenancePeriodToken(now);
        if (now.getUTCDate() === MONTHLY_SCHEDULE_UTC_DAY
            && utcHour === MONTHLY_SCHEDULE_UTC_HOUR
            && utcMinute >= MONTHLY_SCHEDULE_UTC_MINUTE
            && lastMonthlyPeriodScheduled !== monthlyPeriodToken) {
            lastMonthlyPeriodScheduled = monthlyPeriodToken;
            await scheduleMaintenanceForCadence('monthly', monthlyPeriodToken);
        }
    }

    function getJobAttempt(job: ReturnType<typeof parseCronQueueJob>): number {
        const attempt = Number(job?.data?.attempt || 1);
        if (!Number.isFinite(attempt) || attempt <= 0) {
            return 1;
        }
        return Math.floor(attempt);
    }

    function withNextAttempt(job: ReturnType<typeof parseCronQueueJob>): ReturnType<typeof parseCronQueueJob> {
        if (!job) return null;
        const current = getJobAttempt(job);
        return {
            ...job,
            data: {
                ...(job.data || {}),
                attempt: current + 1
            }
        };
    }

    async function processJob(physicalJob: NonNullable<ReturnType<typeof parseCronQueueJob>>, owner: string): Promise<boolean> {
        // Claim first: this also adopts legacy Redis-only jobs before any effects.
        const claimed = await claimDurableCronJob(physicalJob, STREAM_MEMORY_QUEUE_KEY, owner);
        if (claimed.status !== 'claimed') return true;
        const { claim, job } = claimed;
        const channelID = normalizeValue(job.channelID || job.accountID || job.data?.channelID);
        const assertActive = async () => {
            if (!await assertDurableCronJobClaim(claim)) throw new Error('Stream memory Mongo claim lost');
        };
        let leaseLost = false;
        let channelLocked = false;
        const channelLockOwner = `${owner}:${claim.token}`;
        const refreshChannelLock = async () => {
            if (!channelLocked) return true;
            const cache = await getDragonflyClient('StreamMemoryWorker');
            const value = await cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0", {
                keys: [getChannelLockKey(channelID)], arguments: [channelLockOwner, String(CHANNEL_LOCK_SECONDS)]
            });
            return Number(value) === 1;
        };
        const heartbeat = setInterval(() => {
            void Promise.all([renewDurableCronJobClaim(claim), refreshChannelLock()]).then(results => { if (results.some(ok => !ok)) leaseLost = true; }).catch(() => { leaseLost = true; });
        }, 60_000);
        heartbeat.unref?.();
        const checkActive = async () => {
            if (leaseLost) throw new Error('Stream memory Mongo claim renewal failed');
            await assertActive();
            if (!await refreshChannelLock()) throw new Error('Stream memory channel lock lost');
        };
        let transitionAttempted = false;
        const transition = async (operation: () => Promise<boolean>) => {
            transitionAttempted = true;
            if (!await operation()) throw new Error('Stream memory claim transition lost');
        };
        try {
            if (!channelID) { await transition(() => deadDurableCronJob(claim, 'Missing channel ID')); return true; }
            const notBeforeUnix = Number(job.data?.notBeforeUnix || 0);
            if (notBeforeUnix > Date.now() / 1000) {
                await transition(() => retryDurableCronJob(claim, job, new Date(notBeforeUnix * 1000)));
                return true;
            }
            channelLocked = await acquireChannelLock(channelID, channelLockOwner);
            if (!channelLocked) {
                await transition(() => retryDurableCronJob(claim, job, new Date(Date.now() + REQUEUE_DELAY_MS)));
                return true;
            }
            const source = job.job === STREAM_MEMORY_SUMMARY_JOB ? 'stream_offline' : job.job === STREAM_MEMORY_WEEKLY_JOB ? 'weekly_maintenance' : 'monthly_maintenance';
            const startedAt = Date.now();
            await checkActive();
            const result = await runStreamMemoryWorkflow({
                channelID, sessionID: normalizeValue(job.data?.sessionID), streamID: normalizeValue(job.data?.streamID),
                source, assertActive: checkActive
            });
            await checkActive();
            if (!result.error) await transition(() => completeDurableCronJob(claim));
            else if (result.uncertain) await transition(() => uncertainDurableCronJob(claim, result.message || 'Workflow result uncertain'));
            else if (getJobAttempt(job) < JOB_MAX_ATTEMPTS) await transition(() => retryDurableCronJob(claim, withNextAttempt(job)!, new Date(Date.now() + REQUEUE_DELAY_MS)));
            else {
                await transition(() => deadDurableCronJob(claim, result.message || 'Memory workflow failed'));
                // Mongo is authoritative; this preserves the legacy operator view best-effort.
                try { const cache = await getDragonflyClient('StreamMemoryWorker'); await cache.rPush(STREAM_MEMORY_DEAD_LETTER_KEY, serializeCronQueueJob(job)); }
                catch (error) { console.error('Memory dead-letter mirror failed', error); }
            }
            await recordStreamMemoryJobMetric({ channelID, jobType: job.job, source, status: result.status, failed: result.error, latencyMs: Date.now() - startedAt });
            return true;
        } catch (error) {
            // Once work starts, an exception may follow an accepted AI, memory or
            // email effect. Never automatically rerun an unreceipted operation.
            const recorded = !transitionAttempted && await uncertainDurableCronJob(claim, error instanceof Error ? error.message : String(error)).catch(() => false);
            await logError({ worker: 'stream_memory', message: 'Job outcome uncertain', jobID: job.id,
                error: error instanceof Error ? error.message : String(error) }, { channelId: channelID || undefined, destination: 'console' });
            return recorded;
        } finally {
            clearInterval(heartbeat);
            if (channelLocked) await releaseChannelLock(channelID, channelLockOwner);
        }
    }

    async function startQueueConsumerLoop(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('StreamMemoryWorker');
        let nextRecoveryAt = 0;
        while (!shutdownRequested) {
            const lockIsValid = await refreshWorkerLock(lockOwnerId);
            if (!lockIsValid) {
                await logWarn({
                    worker: 'stream_memory',
                    message: 'Worker lock is no longer valid. Exiting queue consumer.'
                }, { destination: 'console' });
                break;
            }
            try {
                if (Date.now() >= nextRecoveryAt) {
                    // Recover only between jobs while this worker owns the Redis lock.
                    let moved = 0;
                    while (moved < 100 && await cache.rPopLPush(MEMORY_PROCESSING_KEY, STREAM_MEMORY_QUEUE_KEY)) moved++;
                    const recovery = await recoverDurableCronJobs(STREAM_MEMORY_QUEUE_KEY, { limit: 100 });
                    nextRecoveryAt = moved === 100 || recovery.examined === 100 || recovery.uncertain === 100 ? 0 : Date.now() + 30_000;
                }
                const raw = await cache.sendCommand(['BLMOVE', STREAM_MEMORY_QUEUE_KEY, MEMORY_PROCESSING_KEY, 'LEFT', 'RIGHT', String(QUEUE_BLOCK_TIMEOUT_SECONDS)]) as string | null;
                if (!raw) continue;
                const payload = parseCronQueueJob(raw);
                if (!payload) {
                    await logWarn({
                        worker: 'stream_memory',
                        message: 'Discarding invalid stream memory payload',
                        raw
                    }, { destination: 'console' });
                    await cache.lRem(MEMORY_PROCESSING_KEY, 1, raw);
                    continue;
                }
                if (![STREAM_MEMORY_SUMMARY_JOB, STREAM_MEMORY_WEEKLY_JOB, STREAM_MEMORY_MONTHLY_JOB].includes(payload.job)) {
                    await cache.rPush(STREAM_MEMORY_DEAD_LETTER_KEY, serializeCronQueueJob(payload));
                    await cache.lRem(MEMORY_PROCESSING_KEY, 1, raw);
                    await logWarn({
                        worker: 'stream_memory',
                        message: 'Unsupported stream memory job moved to dead-letter queue',
                        job: payload.job,
                        jobID: payload.id
                    }, { destination: 'console' });
                    continue;
                }
                try {
                    if (await processJob(payload, lockOwnerId)) await cache.lRem(MEMORY_PROCESSING_KEY, 1, raw);
                } catch (error) {
                    // Adoption failed before effects. Preserve a legacy payload for retry.
                    await cache.eval("if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end if redis.call('LREM', KEYS[2], 1, ARGV[2]) > 0 then return redis.call('LPUSH', KEYS[3], ARGV[2]) end return 0", {
                        keys: [LOCK_KEY, MEMORY_PROCESSING_KEY, STREAM_MEMORY_QUEUE_KEY], arguments: [lockOwnerId, raw]
                    });
                    throw error;
                }
            } catch (error) {
                await logError({
                    worker: 'stream_memory',
                    message: 'Queue consumer loop error',
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                }, { destination: 'console' });
                await sleep(1000);
            }
        }
    }

    async function bootstrap(): Promise<void> {
        const lockOwnerId = `${process.pid}-${Date.now()}`;
        await getDragonflyClient('StreamMemoryWorker');
        await getMongoDBConnection('StreamMemoryWorker');
        await TwitchStreamers.getTwitchAccountsFromDB();
        let lockAcquired = await acquireWorkerLock(lockOwnerId);
        while (!lockAcquired) {
            await logWarn({
                worker: 'stream_memory',
                message: 'Another stream memory worker is active. Waiting for lock.',
                lockKey: LOCK_KEY,
                retryInMs: LOCK_RETRY_MS
            }, { destination: 'console' });
            await sleep(LOCK_RETRY_MS);
            if (shutdownRequested) {
                return;
            }
            lockAcquired = await acquireWorkerLock(lockOwnerId);
        }
        const shutdown = async (signal: string): Promise<void> => {
            if (shutdownRequested) {
                return;
            }
            shutdownRequested = true;
            if (schedulerTimer) {
                clearInterval(schedulerTimer);
                schedulerTimer = null;
            }
            await logInfo({
                worker: 'stream_memory',
                message: 'Shutting down stream memory worker',
                signal
            }, { destination: 'console' });
            await releaseWorkerLock(lockOwnerId);
            process.exit(0);
        };
        process.once('SIGINT', () => {
            void shutdown('SIGINT');
        });
        process.once('SIGTERM', () => {
            void shutdown('SIGTERM');
        });
        await logInfo({
            worker: 'stream_memory',
            message: 'Stream memory worker initialized',
            runOnStart: RUN_ON_START,
            runOnce: RUN_ONCE,
            queueKey: STREAM_MEMORY_QUEUE_KEY,
            deadLetterKey: STREAM_MEMORY_DEAD_LETTER_KEY,
            lockKey: LOCK_KEY
        }, { destination: 'console' });
        if (RUN_ONCE) {
            await runSchedulerTick();
            await releaseWorkerLock(lockOwnerId);
            return;
        }
        if (RUN_ON_START) {
            await runSchedulerTick();
        }
        schedulerTimer = setInterval(() => {
            void runSchedulerTick().catch(async (error) => {
                await logError({
                    worker: 'stream_memory',
                    message: 'Scheduler tick failed',
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                }, { destination: 'console' });
            });
        }, 60_000);
        await startQueueConsumerLoop(lockOwnerId);
        await releaseWorkerLock(lockOwnerId);
    }

    await bootstrap();
}

main().catch(async (error) => {
    console.error({
        worker: 'stream_memory',
        message: 'Failed to bootstrap stream memory worker',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
});
