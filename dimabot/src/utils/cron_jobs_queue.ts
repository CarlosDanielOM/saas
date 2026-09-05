import { randomUUID } from 'node:crypto';
import { getDragonflyClient } from './databases/dragonfly.database.js';

export const CRON_JOBS_QUEUE_KEY = 'cron:jobs:queue';
export const CRON_JOBS_DEAD_LETTER_KEY = 'cron:jobs:dead-letter';
export const CRON_JOBS_DEDUPE_PREFIX = 'cron:jobs:dedupe';

const DEFAULT_DEDUPE_SECONDS = Math.max(60, Number(process.env.CRON_JOBS_DEDUPE_SECONDS || 900));

const ENQUEUE_DEDUPLICATED_JOB = `
if KEYS[3] and redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
if KEYS[3] then
    local accepted = redis.pcall('SET', KEYS[3], '1')
    if type(accepted) == 'table' and accepted.err then
        redis.call('DEL', KEYS[1])
        return redis.error_reply(accepted.err)
    end
end
local pushed = redis.pcall('LPUSH', KEYS[2], ARGV[2])
if type(pushed) == 'table' and pushed.err then
    redis.call('DEL', KEYS[1])
    if KEYS[3] then redis.call('DEL', KEYS[3]) end
    return redis.error_reply(pushed.err)
end
return 1
`;

export interface CronQueueJob {
    id: string;
    job: string;
    requestedAt: string;
    requestedBy?: string;
    userID?: string;
    accountID?: string;
    channelID?: string;
    data?: Record<string, unknown>;
    dedupeKey?: string;
}

export interface EnqueueCronJobInput {
    job: string;
    requestedBy?: string;
    userID?: string;
    accountID?: string;
    channelID?: string;
    data?: Record<string, unknown>;
    dedupeToken?: string;
    dedupeSeconds?: number;
    queueKey?: string;
}

export interface EnqueueCronJobResult {
    enqueued: boolean;
    message: string;
    job: CronQueueJob;
}

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function buildDefaultDedupeToken(input: EnqueueCronJobInput): string {
    return [
        normalizeValue(input.job),
        normalizeValue(input.channelID),
        normalizeValue(input.userID),
        normalizeValue(input.accountID)
    ].filter((value) => value.length > 0).join(':');
}

export function getCronJobDedupeKey(token: string): string {
    const normalizedToken = normalizeValue(token);
    return `${CRON_JOBS_DEDUPE_PREFIX}:${normalizedToken}`;
}

export function serializeCronQueueJob(job: CronQueueJob): string {
    return JSON.stringify(job);
}

export function parseCronQueueJob(payload: string): CronQueueJob | null {
    try {
        const parsed = JSON.parse(payload) as Partial<CronQueueJob>;
        const job = normalizeValue(parsed.job);
        if (!job) {
            return null;
        }
        return {
            id: normalizeValue(parsed.id) || randomUUID(),
            job,
            requestedAt: normalizeValue(parsed.requestedAt) || new Date().toISOString(),
            requestedBy: normalizeValue(parsed.requestedBy) || undefined,
            userID: normalizeValue(parsed.userID) || undefined,
            accountID: normalizeValue(parsed.accountID) || undefined,
            channelID: normalizeValue(parsed.channelID) || undefined,
            data: parsed.data && typeof parsed.data === 'object' ? parsed.data : undefined,
            dedupeKey: normalizeValue(parsed.dedupeKey) || undefined
        };
    } catch {
        return null;
    }
}

export async function enqueueCronJob(input: EnqueueCronJobInput): Promise<EnqueueCronJobResult> {
    const normalizedJob = normalizeValue(input.job);
    if (!normalizedJob) {
        return {
            enqueued: false,
            message: 'Invalid cron job name',
            job: {
                id: randomUUID(),
                job: '',
                requestedAt: new Date().toISOString()
            }
        };
    }

    const job: CronQueueJob = {
        id: randomUUID(),
        job: normalizedJob,
        requestedAt: new Date().toISOString(),
        requestedBy: normalizeValue(input.requestedBy) || undefined,
        userID: normalizeValue(input.userID) || undefined,
        accountID: normalizeValue(input.accountID) || undefined,
        channelID: normalizeValue(input.channelID) || undefined,
        data: input.data
    };

    const dedupeToken = normalizeValue(input.dedupeToken) || buildDefaultDedupeToken(input);
    const dedupeSeconds = Math.max(60, Number(input.dedupeSeconds || DEFAULT_DEDUPE_SECONDS));
    const queueKey = normalizeValue(input.queueKey) || CRON_JOBS_QUEUE_KEY;

    const client = await getDragonflyClient('CronJobsQueue');

    if (dedupeToken) {
        const dedupeKey = getCronJobDedupeKey(dedupeToken);
        job.dedupeKey = dedupeKey;
        // Automatic session jobs are one-shot. Keep acceptance separate from the TTL
        // marker that workers delete, covering response loss before the Mongo step receipt.
        const acceptanceKey = input.data?.source === 'stream_offline' && normalizeValue(input.data.sessionID)
            ? `cron:jobs:accepted:${normalizedJob}:${job.channelID || ''}:${normalizeValue(input.data.sessionID)}` : undefined;
        // One server-side operation: a marker must never acknowledge an unpushed job.
        const dedupeResult = await client.eval(ENQUEUE_DEDUPLICATED_JOB, {
            keys: acceptanceKey ? [dedupeKey, queueKey, acceptanceKey] : [dedupeKey, queueKey],
            arguments: [String(dedupeSeconds), serializeCronQueueJob(job)]
        });
        if (Number(dedupeResult) === 0) {
            return {
                enqueued: false,
                message: 'Cron job already queued recently',
                job
            };
        }
    } else {
        await client.lPush(queueKey, serializeCronQueueJob(job));
    }

    return {
        enqueued: true,
        message: 'Cron job queued',
        job
    };
}

export async function clearCronJobDedupeByKey(dedupeKey?: string): Promise<void> {
    const key = normalizeValue(dedupeKey);
    if (!key) {
        return;
    }
    const client = await getDragonflyClient('CronJobsQueue');
    await client.del(key);
}
