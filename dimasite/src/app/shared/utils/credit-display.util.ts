import type { AiCreditsData } from '../../models/dashboard.model';
import type { AiUsageSummaryData } from '../../models/usage.model';

/** Never fall back to the inflated Free snapshot when display history is unavailable. */
export function creditDisplay(credits: AiCreditsData | null, planTier: string) {
  if (planTier === 'free' && credits?.available) {
    return credits.display ?? { estimated: true, credits: null };
  }
  return { estimated: false, credits };
}

export function usageCreditDisplay(summary: AiUsageSummaryData | null) {
  if (!summary) return { estimated: false, credits: null, pacing: null };
  if (summary.planTier === 'free' && summary.creditDisplay) return summary.creditDisplay;
  const display = creditDisplay(summary.credits, summary.planTier);
  return { ...display, pacing: display.estimated ? null : summary.pacing };
}
