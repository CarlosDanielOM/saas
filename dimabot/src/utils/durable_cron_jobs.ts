import { randomUUID } from 'node:crypto';
import { CronJobIntentSchema, type ICronJobIntent } from '../schemas/cron_job_intent.schema.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import type { CronQueueJob } from './cron_jobs_queue.js';

export const DURABLE_CRON_LEASE_MS = 5 * 60_000;
const REPUBLISH_INTERVAL_MS = 30_000;
const MAX_RECOVERY_BATCH = 100;
const QUEUE_SCAN_LIMIT = 1000;
const WRITE = { writeConcern: { w: 1, j: true } };

// One atomic operation avoids losing the payload between the queue check and push.
// The bounded search can permit duplicates deep in a backlog; the Mongo claim fences them.
export const PUBLISH_DURABLE_CRON_JOB = `
local found = redis.call('LPOS', KEYS[1], ARGV[1], 'MAXLEN', ARGV[2])
if not found then redis.call('LPUSH', KEYS[1], ARGV[1]) end
if KEYS[2] then redis.call('SET', KEYS[2], '1') end
if found then return 0 else return 1 end
`;

export interface DurableCronJobClaim { intentId: string; queueKey: string; owner: string; token: string }
export type DurableClaimResult =
    | { status: 'claimed'; job: CronQueueJob; claim: DurableCronJobClaim }
    | { status: 'busy' | 'terminal'; job: CronQueueJob };
export interface PrepareDurableCronJobOptions {
    dedupeSeconds: number;
    acceptanceKey?: string;
    legacyAccepted?: boolean;
}
export interface PreparedDurableCronJob {
    job: CronQueueJob;
    created: boolean;
    accepted: boolean;
    status: ICronJobIntent['status'];
}

export function durableAutomaticAcceptanceKey(job: CronQueueJob): string | undefined {
    const session = typeof job.data?.sessionID === 'string' ? job.data.sessionID.trim() : '';
    const channel = typeof job.channelID === 'string' ? job.channelID.trim() : '';
    if (job.data?.source !== 'stream_offline' || !session || !channel) return undefined;
    return `cron:jobs:accepted:${job.job}:${channel}:${session}`;
}

function activeKey(job: CronQueueJob, queueKey: string): string {
    return `${queueKey}\0${job.dedupeKey || `job:${job.id}`}`;
}

// Legacy Redis payloads do not carry a dedupe duration. Match the originating
// producer's defaults when adopting them, including clip reconciliation.
function legacyDedupeSeconds(job: CronQueueJob): number {
    const configured = job.job === 'stream-memory-summary' ? Number(process.env.STREAM_MEMORY_SUMMARY_DEDUPE_SECONDS || 12 * 3600)
        : job.job === 'memory-maintenance-weekly' ? Number(process.env.STREAM_MEMORY_WEEKLY_DEDUPE_SECONDS || 7 * 86400)
        : job.job === 'memory-maintenance-monthly' ? Number(process.env.STREAM_MEMORY_MONTHLY_DEDUPE_SECONDS || 31 * 86400)
        : job.job === 'clip-recommendation-analysis' && job.data?.source === 'recovery' ? 3600
        : Number(process.env.CLIP_RECOMMENDATIONS_DEDUPE_SECONDS || 6 * 3600);
    return Number.isFinite(configured) ? Math.max(60, configured) : 60;
}

function dueAt(job: CronQueueJob, now: Date): Date {
    const unix = Number(job.data?.notBeforeUnix || 0);
    return Number.isFinite(unix) && unix > 0 ? new Date(Math.max(now.getTime(), unix * 1000)) : now;
}

function assertJob(job: CronQueueJob, queueKey: string): void {
    if (!job.id || !job.job || !queueKey || !job.requestedAt) throw new Error('Invalid durable cron job identity');
}

type Model = typeof CronJobIntentSchema;
type Cache = Pick<Awaited<ReturnType<typeof getDragonflyClient>>, 'eval'>;
export interface DurableCronJobDependencies {
    model?: Model;
    cache?: () => Promise<Cache>;
    now?: () => Date;
    uuid?: () => string;
}

export function createDurableCronJobs(dependencies: DurableCronJobDependencies = {}) {
    const model = dependencies.model || CronJobIntentSchema;
    const cache = dependencies.cache || (() => getDragonflyClient('DurableCronJobs'));
    const now = dependencies.now || (() => new Date());
    const uuid = dependencies.uuid || randomUUID;

    async function identity(job: CronQueueJob, queueKey: string): Promise<ICronJobIntent | null> {
        const automaticKey = durableAutomaticAcceptanceKey(job);
        const predicates: Record<string, unknown>[] = [{ jobID: job.id }];
        if (automaticKey) predicates.push({ automaticKey });
        predicates.push({ activeKey: activeKey(job, queueKey) });
        return model.findOne({ queueKey, $or: predicates }).lean() as Promise<ICronJobIntent | null>;
    }

    async function prepare(job: CronQueueJob, queueKey: string, options: PrepareDurableCronJobOptions): Promise<PreparedDurableCronJob> {
        assertJob(job, queueKey);
        await model.init();
        const automaticKey = durableAutomaticAcceptanceKey(job);
        if (options.acceptanceKey && options.acceptanceKey !== automaticKey) throw new Error('Invalid automatic acceptance key');
        if (!Number.isFinite(options.dedupeSeconds) || options.dedupeSeconds <= 0) throw new Error('Invalid dedupe duration');
        const key = activeKey(job, queueKey);
        for (let attempt = 0; attempt < 5; attempt++) {
            const existing = await identity(job, queueKey);
            const at = now();
            if (existing) {
                const terminal = existing.status === 'completed' || existing.status === 'dead' || existing.status === 'legacy_accepted';
                // Automatic acceptance remains authoritative permanently. Active/uncertain
                // work never expires; ordinary terminal dedupe can expire without deleting history.
                if (!automaticKey && existing.activeKey === key && terminal && existing.dedupeUntil <= at && existing.jobID !== job.id) {
                    await model.updateOne({ _id: existing._id, activeKey: key, status: existing.status,
                        dedupeUntil: { $lte: at } }, { $unset: { activeKey: 1 } }, WRITE);
                    continue;
                }
                return { job: existing.payload, created: false, accepted: true, status: existing.status };
            }
            const eligible = dueAt(job, at);
            try {
                await model.create([{
                    jobID: job.id, queueKey, payload: job,
                    status: automaticKey && options.legacyAccepted ? 'legacy_accepted' : 'queued',
                    ...(automaticKey ? { automaticKey } : {}), activeKey: key,
                    dedupeUntil: new Date(at.getTime() + options.dedupeSeconds * 1000),
                    dueAt: eligible, nextPublishAt: eligible
                }], { w: 1, j: true });
                return { job, created: true, accepted: true,
                    status: automaticKey && options.legacyAccepted ? 'legacy_accepted' : 'queued' };
            } catch (error) {
                if ((error as { code?: number }).code !== 11000) throw error;
            }
        }
        throw new Error('Unable to resolve concurrent durable cron job acceptance');
    }

    async function publishIntent(intent: ICronJobIntent): Promise<boolean> {
        const client = await cache();
        return Number(await client.eval(PUBLISH_DURABLE_CRON_JOB, {
            keys: intent.automaticKey ? [intent.queueKey, intent.automaticKey] : [intent.queueKey],
            arguments: [JSON.stringify(intent.payload), String(QUEUE_SCAN_LIMIT)]
        })) === 1;
    }

    async function publish(job: CronQueueJob, queueKey: string): Promise<boolean> {
        const intent = await identity(job, queueKey);
        if (!intent || intent.status !== 'queued' || intent.dueAt > now()) return false;
        return publishIntent(intent);
    }

    async function claim(job: CronQueueJob, queueKey: string, owner: string): Promise<DurableClaimResult> {
        assertJob(job, queueKey);
        await model.init();
        if (!owner) throw new Error('Durable cron job owner is required');
        let intent = await identity(job, queueKey);
        if (!intent) {
            await prepare(job, queueKey, { dedupeSeconds: legacyDedupeSeconds(job) });
            intent = await identity(job, queueKey);
        }
        if (!intent) throw new Error('Durable cron job adoption failed');
        if (!durableAutomaticAcceptanceKey(job) && intent.jobID !== job.id &&
            (intent.status === 'completed' || intent.status === 'dead') && intent.dedupeUntil <= now() &&
            Date.parse(job.requestedAt) >= intent.dedupeUntil.getTime()) {
            // A new legacy producer may reuse an expired ordinary dedupe key.
            // Its request must also postdate that window: a delayed alias from
            // the old acceptance must never become fresh work merely by waiting.
            await prepare(job, queueKey, { dedupeSeconds: legacyDedupeSeconds(job) });
            intent = await identity(job, queueKey);
            if (!intent) throw new Error('Durable cron job readoption failed');
        }
        if (intent.status === 'legacy_accepted' && intent.automaticKey === durableAutomaticAcceptanceKey(job)) {
            // A real old transport payload proves there is work to adopt; a bare old
            // Redis marker does not. CAS allows only one payload to become canonical.
            const adopted = await model.findOneAndUpdate({ _id: intent._id, status: 'legacy_accepted' }, {
                $set: { status: 'queued', payload: job, dueAt: dueAt(job, now()), nextPublishAt: dueAt(job, now()) }
            }, { new: true, ...WRITE }).lean() as ICronJobIntent | null;
            intent = adopted || await model.findById(intent._id).lean() as ICronJobIntent;
        }
        const at = now();
        if (intent.status === 'queued' && intent.dueAt <= at) {
            const token = uuid();
            const claimed = await model.findOneAndUpdate({ _id: intent._id, queueKey, status: 'queued', dueAt: { $lte: at } }, {
                $set: { status: 'processing', owner, token, leaseUntil: new Date(at.getTime() + DURABLE_CRON_LEASE_MS) }
            }, { new: true, ...WRITE }).lean() as ICronJobIntent | null;
            if (claimed) return { status: 'claimed', job: claimed.payload,
                claim: { intentId: String(claimed._id), queueKey, owner, token } };
            intent = await model.findById(intent._id).lean() as ICronJobIntent;
        }
        if (!intent) throw new Error('Durable cron job intent disappeared');
        return { status: intent.status === 'queued' || intent.status === 'processing' ? 'busy' : 'terminal', job: intent.payload };
    }

    function claimFilter(claim: DurableCronJobClaim, at: Date) {
        return { _id: claim.intentId, queueKey: claim.queueKey, status: 'processing',
            owner: claim.owner, token: claim.token, leaseUntil: { $gt: at } };
    }

    async function transition(claim: DurableCronJobClaim, status: 'completed' | 'dead' | 'uncertain', reason = ''): Promise<boolean> {
        const result = await model.updateOne(claimFilter(claim, now()), {
            $set: { status, reason }, $unset: { owner: 1, token: 1, leaseUntil: 1 }
        }, WRITE);
        return result.modifiedCount === 1;
    }

    async function retry(claim: DurableCronJobClaim, job: CronQueueJob, due: Date): Promise<boolean> {
        assertJob(job, claim.queueKey);
        if (!Number.isFinite(due.getTime())) throw new Error('Invalid retry time');
        // Only the claimed canonical payload may be rescheduled.
        const result = await model.updateOne({ ...claimFilter(claim, now()), 'payload.id': job.id, 'payload.job': job.job,
            'payload.channelID': job.channelID || null, automaticKey: durableAutomaticAcceptanceKey(job) || null }, {
            $set: { status: 'queued', payload: job, dueAt: due, nextPublishAt: due },
            $unset: { owner: 1, token: 1, leaseUntil: 1 }
        }, WRITE);
        return result.modifiedCount === 1;
    }

    async function renew(claim: DurableCronJobClaim): Promise<boolean> {
        const at = now();
        const result = await model.updateOne(claimFilter(claim, at), {
            $set: { leaseUntil: new Date(at.getTime() + DURABLE_CRON_LEASE_MS) }
        }, WRITE);
        return result.matchedCount === 1;
    }

    async function assertActive(claim: DurableCronJobClaim): Promise<boolean> {
        return Boolean(await model.exists(claimFilter(claim, now())));
    }

    async function recover(queueKey: string, options: { limit: number }): Promise<{ examined: number; published: number; uncertain: number }> {
        if (!queueKey || !Number.isInteger(options.limit) || options.limit < 1) throw new Error('Invalid recovery scope');
        const limit = Math.min(options.limit, MAX_RECOVERY_BATCH);
        let uncertain = 0;
        let examined = 0;
        let published = 0;
        // A stale lease is ambiguous: the old process may have issued an external
        // effect, so never automatically claim or replay this work.
        for (let i = 0; i < limit; i++) {
            const changed = await model.findOneAndUpdate({ queueKey, status: 'processing', leaseUntil: { $lte: now() } }, {
                $set: { status: 'uncertain', reason: 'processing lease expired' },
                $unset: { owner: 1, token: 1, leaseUntil: 1 }
            }, { sort: { leaseUntil: 1, _id: 1 }, new: true, ...WRITE }).lean();
            if (!changed) break;
            uncertain++;
        }
        for (let i = 0; i < limit; i++) {
            const at = now();
            const item = await model.findOneAndUpdate({ queueKey, status: 'queued', dueAt: { $lte: at }, nextPublishAt: { $lte: at } }, {
                $set: { nextPublishAt: new Date(at.getTime() + REPUBLISH_INTERVAL_MS) }
            }, { sort: { nextPublishAt: 1, _id: 1 }, new: true, ...WRITE }).lean() as ICronJobIntent | null;
            if (!item) break;
            examined++;
            if (await publishIntent(item)) published++;
        }
        return { examined, published, uncertain };
    }

    return { prepare, publish, claim, complete: (claim: DurableCronJobClaim) => transition(claim, 'completed'), retry,
        dead: (claim: DurableCronJobClaim, reason: string) => transition(claim, 'dead', reason),
        uncertain: (claim: DurableCronJobClaim, reason: string) => transition(claim, 'uncertain', reason),
        renew, assertActive, recover };
}

const durable = createDurableCronJobs();
export const prepareDurableCronJob = durable.prepare;
export const publishDurableCronJob = durable.publish;
export const claimDurableCronJob = durable.claim;
export const completeDurableCronJob = durable.complete;
export const retryDurableCronJob = durable.retry;
export const deadDurableCronJob = durable.dead;
export const uncertainDurableCronJob = durable.uncertain;
export const renewDurableCronJobClaim = durable.renew;
export const assertDurableCronJobClaim = durable.assertActive;
export const recoverDurableCronJobs = durable.recover;
