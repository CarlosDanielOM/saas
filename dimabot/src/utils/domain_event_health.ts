import type { PipelineStage } from 'mongoose';
import { DomainEventDeliverySchema, type DomainEventDeliveryStatus } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';

export const DOMAIN_EVENT_HEALTH_LIMIT = 10_000;
export const DOMAIN_EVENT_HEALTH_MAX_TIME_MS = 1_000;
export const DOMAIN_EVENT_HEALTH_EXPIRY_WINDOW_MS = 60 * 60_000;

const STATUSES: DomainEventDeliveryStatus[] = ['pending', 'processing', 'retry', 'succeeded', 'skipped', 'dead'];

interface HealthAggregate {
    count: number;
    oldestAt: Date | null;
    oldestReadyAt?: Date | null;
    dueRetries?: number;
    staleProcessing?: number;
    approachingExpiry: number;
    expired: number;
    prerequisiteMissing?: number;
    ownerUnresolved?: number;
    subjectUnresolved?: number;
    maxLastAttemptDurationMs?: number | null;
}

// Admin-on-demand only: no payloads, lookups, collection-wide size scans, or cache.
// Each indexed status bucket is independently capped so successful history cannot
// crowd retries out of the sample. At the cap, counts and ages are lower bounds.
export async function getDomainEventHealth(consumer?: string, now = new Date()) {
    const soon = new Date(now.getTime() + DOMAIN_EVENT_HEALTH_EXPIRY_WINDOW_MS);
    const countIf = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
    const expiry = {
        approachingExpiry: countIf({ $and: [{ $gt: ['$expiresAt', now] }, { $lte: ['$expiresAt', soon] }] }),
        expired: countIf({ $lte: ['$expiresAt', now] })
    };
    const summarize = (row?: HealthAggregate) => {
        const { oldestAt, oldestReadyAt, ...counts } = row ?? {
            count: 0, oldestAt: null, approachingExpiry: 0, expired: 0
        };
        return {
            ...counts,
            capped: counts.count >= DOMAIN_EVENT_HEALTH_LIMIT,
            oldestAgeMs: oldestAt ? Math.max(0, now.getTime() - new Date(oldestAt).getTime()) : null,
            oldestReadyAgeMs: oldestReadyAt ? Math.max(0, now.getTime() - new Date(oldestReadyAt).getTime()) : null
        };
    };
    const [deliveries, dispatch] = await Promise.all([
        Promise.all(STATUSES.map(async status => {
            const active = ['pending', 'processing', 'retry'].includes(status);
            const due = { $lte: [{ $ifNull: ['$nextAttemptAt', now] }, now] };
            const stale = { $lte: [{ $ifNull: ['$lockedUntil', now] }, now] };
            const ready = status === 'pending' ? true : status === 'retry' ? due : status === 'processing' ? stale : false;
            const missing = { $eq: ['$lastErrorCode', 'prerequisite_missing'] };
            const pipeline: PipelineStage[] = [
                { $match: { status, ...(consumer ? { consumer } : {}) } },
                { $limit: DOMAIN_EVENT_HEALTH_LIMIT },
                { $group: {
                    _id: null,
                    count: { $sum: 1 },
                    oldestAt: { $min: '$createdAt' },
                    oldestReadyAt: { $min: { $cond: [ready, '$createdAt', null] } },
                    dueRetries: countIf(status === 'retry' ? due : false),
                    staleProcessing: countIf(status === 'processing' ? stale : false),
                    ...(active ? expiry : { approachingExpiry: { $sum: 0 }, expired: { $sum: 0 } }),
                    prerequisiteMissing: countIf(missing),
                    ownerUnresolved: countIf({ $and: [missing, { $eq: ['$lastPrerequisiteKind', 'owner'] }] }),
                    subjectUnresolved: countIf({ $and: [missing, { $eq: ['$lastPrerequisiteKind', 'subject'] }] }),
                    maxLastAttemptDurationMs: { $max: '$lastAttemptDurationMs' }
                } },
                { $project: { _id: 0 } }
            ];
            const rows = await DomainEventDeliverySchema.aggregate<HealthAggregate>(pipeline).option({
                maxTimeMS: DOMAIN_EVENT_HEALTH_MAX_TIME_MS, allowDiskUse: false,
                hint: consumer ? { consumer: 1, status: 1, nextAttemptAt: 1 } : { status: 1 }
            });
            return [status, {
                dueRetries: 0, staleProcessing: 0, prerequisiteMissing: 0, ownerUnresolved: 0,
                subjectUnresolved: 0, maxLastAttemptDurationMs: null, ...summarize(rows[0])
            }] as const;
        })),
        DomainEventSchema.aggregate<HealthAggregate>([
            { $match: { dispatchPending: true } },
            { $limit: DOMAIN_EVENT_HEALTH_LIMIT },
            { $group: { _id: null, count: { $sum: 1 }, oldestAt: { $min: '$journaledAt' }, ...expiry } },
            { $project: { _id: 0 } }
        ]).option({ maxTimeMS: DOMAIN_EVENT_HEALTH_MAX_TIME_MS, allowDiskUse: false, hint: { dispatchPending: 1, _id: 1 } })
    ]);
    return {
        asOf: now.toISOString(),
        consumer: consumer || null,
        scope: 'retained-deliveries; dispatch is global; independent reads, not a snapshot',
        limits: {
            documentsPerBucket: DOMAIN_EVENT_HEALTH_LIMIT,
            maxTimeMSPerQuery: DOMAIN_EVENT_HEALTH_MAX_TIME_MS,
            approachingExpiryWindowMs: DOMAIN_EVENT_HEALTH_EXPIRY_WINDOW_MS
        },
        semantics: 'When capped, counts and maximum ages/durations are lower bounds over an unordered sample. Delivery ages use createdAt; ready age is the age of currently ready work, not time overdue. Dispatch age uses journaledAt. Only succeeded is success. Owner/subject signals use the last prerequisite failure, not journal identity presence. Legacy unclassified failures are not inferred.',
        deliveries: Object.fromEntries(deliveries),
        dispatchPending: summarize(dispatch[0])
    };
}
