import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { LinksService } from './links.service';
import { AiCreditsData } from './channel-api.service';

export type UsageCategory = 'tts' | 'ai_chat' | 'ai_agent' | 'memory' | 'clip_recommendation'
  | 'credit_adjustment' | 'other' | 'uncategorized';

/** Why an adjustment receipt exists. Unknown future values fall back to generic copy. */
export type UsageAdjustmentType = 'native_grant' | 'manual_grant' | 'monthly_reset' | 'purchased_pack'
  | 'subscription_credits' | 'gifted_credits' | 'refund' | 'correction' | 'activation' | 'other';

/** Credits are signed like charges: negative adds to the balance, positive removes from it. */
export interface UsageAdjustmentTotal {
  type: UsageAdjustmentType | string;
  grantedCredits: number;
  debitedCredits: number;
  transactionCount: number;
}

export interface UsagePeriod {
  source: string;
  startsAt?: string;
  endsAt?: string;
  from: string;
  to: string;
  totalDayCount: number;
  elapsedDayCount: number;
}

export interface UsageSummary {
  planTier: 'free' | 'premium' | 'pro';
  credits: AiCreditsData;
  billingPeriod: UsagePeriod;
  /** `pending`: older usage or Polar credit grants are still being imported. */
  ledger: { status: 'ready' | 'pending'; coverageStart: string | null; lastSyncedAt?: string | null } | null;
  pacing: {
    status: 'no_usage' | 'within_pace' | 'over_pace' | 'exhausted' | string;
    averageDailyCredits: number;
    projectedPeriodCredits: number;
    remainingPeriodDays: number;
    forecastRateBasis?: 'current_cycle' | 'retention_history';
    expectedToExhaustWithinPeriod?: boolean;
    estimatedDaysUntilExhaustion?: number | null;
  } | null;
  analytics: {
    itemizationStartedAt: string;
    totalSpentCredits: number;
    averageDailySpentCredits: number;
    grantedCredits: number;
    adjustmentDebitedCredits?: number;
    netConsumedCredits: number;
    transactionCount: number;
    adjustments?: UsageAdjustmentTotal[];
    daily: { date: string; credits: number; transactionCount: number }[];
    categories: { category: UsageCategory; credits: number; transactionCount: number; percentage: number }[];
  };
}

export interface UsageTransaction {
  id: string;
  occurredAt: string;
  entryKind: 'usage' | 'adjustment';
  category: UsageCategory;
  operation: string;
  source?: string | null;
  adjustmentType?: UsageAdjustmentType | string | null;
  provider: string;
  model: string | null;
  quantity: number | null;
  unit: string | null;
  credits: number;
}

interface Envelope<T> { error: boolean; message: string; data: T }

@Injectable({ providedIn: 'root' })
export class AiUsageApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  getSummary(channelID: string, range: { from?: string; to?: string; timezone?: string } = {}) {
    return this.http.get<Envelope<UsageSummary>>(
      `${this.links.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/ai-usage/summary`,
      { params: this.params(range) }
    );
  }

  getTransactions(channelID: string, query: {
    from?: string; to?: string; timezone?: string; category?: string; cursor?: string; limit?: number;
  } = {}) {
    return this.http.get<Envelope<{ items: UsageTransaction[]; nextCursor: string | null }>>(
      `${this.links.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/ai-usage/transactions`,
      { params: this.params(query) }
    );
  }

  private params(query: Record<string, string | number | undefined>): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    return params;
  }
}
