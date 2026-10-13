import type { AiCreditsData } from '../../services/channel-api.service';
import type { UsageSummary } from '../../services/ai-usage-api.service';

interface UsageDisplay {
  credits: AiCreditsData | null;
  pacing: UsageSummary['pacing'];
  estimated: boolean;
}

/** Presentation only. Never changes the API's billing snapshot or credit enforcement. */
export function buildUsageDisplay(cycle: UsageSummary, now = Date.now()): UsageDisplay {
  const estimated = cycle.planTier === 'free' && cycle.credits.available &&
    cycle.billingPeriod.source === 'free_monthly';
  if (!estimated) return { credits: cycle.credits, pacing: cycle.pacing, estimated: false };
  // Imported history can be incomplete; don't turn partial receipts into a full balance.
  if (cycle.ledger?.status !== 'ready') return { credits: null, pacing: null, estimated: true };

  const limit = Math.max(cycle.credits.limit, cycle.analytics.grantedCredits);
  const used = Math.max(0, cycle.analytics.totalSpentCredits + (cycle.analytics.adjustmentDebitedCredits ?? 0));
  const balance = Math.max(0, limit - used);
  const credits = { ...cycle.credits, limit, used, balance };
  const pace = cycle.pacing;
  if (!pace) return { credits, pacing: null, estimated: true };

  const start = Date.parse(cycle.billingPeriod.startsAt ?? '');
  const end = Date.parse(cycle.billingPeriod.endsAt ?? '');
  const elapsedDays = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? Math.max(1, (Math.min(now, end) - start) / 86_400_000)
    : Math.max(1, cycle.billingPeriod.elapsedDayCount);
  const averageDailyCredits = pace.forecastRateBasis === 'retention_history'
    ? pace.averageDailyCredits : used / elapsedDays;
  const runout = balance <= 0 ? 0 : averageDailyCredits > 0 ? balance / averageDailyCredits : null;
  const expectedToExhaustWithinPeriod = runout !== null && runout < pace.remainingPeriodDays;
  const pacing = {
    ...pace,
    status: balance <= 0 ? 'exhausted' : averageDailyCredits <= 0 ? 'no_usage'
      : expectedToExhaustWithinPeriod ? 'over_pace' : 'within_pace',
    averageDailyCredits,
    projectedPeriodCredits: Math.round(used + averageDailyCredits * pace.remainingPeriodDays),
    expectedToExhaustWithinPeriod,
    estimatedDaysUntilExhaustion: expectedToExhaustWithinPeriod && runout !== null
      ? Math.round(runout * 10) / 10 : null,
  };
  return { credits, pacing, estimated: true };
}
