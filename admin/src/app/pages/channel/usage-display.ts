import type { AiCreditsData } from '../../services/channel-api.service';
import type { UsageSummary } from '../../services/ai-usage-api.service';

interface UsageDisplay {
  credits: AiCreditsData;
  pacing: UsageSummary['pacing'];
}

/**
 * The billing snapshot is the spendable balance, shared with channel detail.
 * Receipt totals describe activity and may include earlier grants or resets;
 * they must never replace current credits, even while history is syncing.
 */
export function buildUsageDisplay(cycle: UsageSummary): UsageDisplay {
  return { credits: cycle.credits, pacing: cycle.pacing };
}
