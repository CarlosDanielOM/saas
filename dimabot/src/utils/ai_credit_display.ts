import type { IUsers } from '../schemas/users.schema.js';
import type { AiCreditsData } from './billing.js';
import { buildAiUsagePacing, resolveAiUsagePeriod, type AiUsageBillingPeriod } from './ai_usage_receipts.js';
import { getAiUsageRetentionDays, type AiUsagePacingHistory } from './ai_usage_ledger.js';
import { getAiUsageDashboard } from './ai_usage_dashboard.js';
import { usageLedgerStatus } from './ai_usage_queries.js';

interface DisplayActivity {
    totalSpentCredits: number;
    grantedCredits: number;
    adjustmentDebitedCredits?: number;
}
interface DisplayCycle {
    billingPeriod: AiUsageBillingPeriod;
    summary: DisplayActivity;
    history?: AiUsagePacingHistory | null;
    ledger: { status: string } | null;
}

/** A UI estimate only. The raw billing snapshot, cache and enforcement are never changed. */
export function buildFreeAiCreditDisplay(credits: AiCreditsData, cycle: DisplayCycle) {
    if (cycle.ledger?.status !== 'ready') return { estimated: true, credits: null, pacing: null };
    const limit = Math.max(credits.limit, cycle.summary.grantedCredits);
    const used = Math.max(0, cycle.summary.totalSpentCredits + (cycle.summary.adjustmentDebitedCredits ?? 0));
    const balance = Math.max(0, limit - used);
    const displayCredits: AiCreditsData = { ...credits, used, limit, balance,
        status: balance <= 0 ? 'exhausted' : 'available' };
    return { estimated: true, credits: displayCredits,
        pacing: buildAiUsagePacing({ credits: displayCredits, billingPeriod: cycle.billingPeriod,
            history: cycle.history, historyComplete: true }) };
}

export async function getFreeAiCreditDisplay(
    user: Pick<IUsers, 'plan_tier' | 'polar_sh_customer_id' | 'created_at'>,
    channelID: string,
    credits: AiCreditsData,
    existingCycle?: DisplayCycle
) {
    if (user.plan_tier !== 'free' || !credits.available || !user.polar_sh_customer_id) return undefined;
    if (existingCycle) return buildFreeAiCreditDisplay(credits, existingCycle);
    try {
        const period = await resolveAiUsagePeriod({ freePeriodAnchor: user.created_at,
            timeZone: 'UTC', maxDays: getAiUsageRetentionDays('free') });
        const readInput = { channelID, customerId: user.polar_sh_customer_id, planTier: 'free',
            accountCreatedAt: user.created_at, window: period.window };
        const ledger = await usageLedgerStatus(readInput);
        const dashboard = await getAiUsageDashboard(readInput);
        return buildFreeAiCreditDisplay(credits, { billingPeriod: period.billingPeriod,
            summary: dashboard.summary, history: dashboard.history, ledger });
    } catch {
        // A reporting failure must not remove the existing raw billing response.
        console.warn('Free credit display is temporarily unavailable');
        return { estimated: true, credits: null, pacing: null };
    }
}
