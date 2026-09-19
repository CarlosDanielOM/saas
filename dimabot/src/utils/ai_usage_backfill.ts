import type { RedisClientType } from 'redis';

import type { AiUsageBackfillJob } from './ai_usage_backfill_queue.js';
import { backfillAiUsageLedger, getAiUsageLedgerState, getAiUsageRetentionDays } from './ai_usage_ledger.js';
import { fetchAiUsageTransactions, type AiUsageWindow } from './ai_usage_receipts.js';

const DAY_MS = 86_400_000;
const INCREMENTAL_OVERLAP_DAYS = Math.max(1, Number(process.env.AI_USAGE_BACKFILL_OVERLAP_DAYS || 2));
const FRESHNESS_MS = Math.max(60_000, Number(process.env.AI_USAGE_BACKFILL_FRESHNESS_MS || DAY_MS));

export interface AiUsageBackfillResult {
    status: 'synced' | 'fresh';
    channelID: string;
    coverageStart: string;
    fetchedFrom: string | null;
    transactionCount: number;
}

export async function syncAiUsageBackfillJob(
    job: AiUsageBackfillJob,
    cache: RedisClientType,
    now = new Date()
): Promise<AiUsageBackfillResult> {
    const requestedStart = new Date(job.coverageStart);
    const retentionFloor = new Date(now.getTime() - getAiUsageRetentionDays(job.planTier) * DAY_MS);
    const coverageStart = requestedStart > retentionFloor ? requestedStart : retentionFloor;
    const state = await getAiUsageLedgerState({ channelID: job.channelID, customerId: job.customerId });
    const needsEarlierCoverage = !state || state.coverageStart.getTime() > coverageStart.getTime();
    const isFresh = state && now.getTime() - state.backfilledAt.getTime() < FRESHNESS_MS;
    if (!needsEarlierCoverage && isFresh) {
        return {
            status: 'fresh', channelID: job.channelID,
            coverageStart: state.coverageStart.toISOString(), fetchedFrom: null, transactionCount: 0
        };
    }

    const overlapStart = state
        ? new Date(Math.max(retentionFloor.getTime(), state.backfilledAt.getTime() - INCREMENTAL_OVERLAP_DAYS * DAY_MS))
        : coverageStart;
    const fetchStart = needsEarlierCoverage && coverageStart < overlapStart ? coverageStart : overlapStart;
    const window: AiUsageWindow = {
        from: fetchStart.toISOString().slice(0, 10),
        to: now.toISOString().slice(0, 10),
        timeZone: 'UTC',
        startTimestamp: fetchStart,
        endTimestampExclusive: now,
        days: []
    };
    const transactions = await fetchAiUsageTransactions(job.customerId, window);
    await backfillAiUsageLedger({
        channelID: job.channelID,
        customerId: job.customerId,
        planTier: job.planTier,
        coverageStart,
        rebuildStart: fetchStart,
        transactions,
        now
    });
    await cache.incr(`twitch:${job.channelID}:ai:usage-receipts:generation`);
    return {
        status: 'synced', channelID: job.channelID,
        coverageStart: coverageStart.toISOString(), fetchedFrom: fetchStart.toISOString(),
        transactionCount: transactions.length
    };
}
