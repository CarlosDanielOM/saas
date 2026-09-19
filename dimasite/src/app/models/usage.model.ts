import { AiCreditsData, ApiEnvelope } from './dashboard.model';

export type AiUsagePlanTier = 'free' | 'premium' | 'pro';

export type AiUsageEntryKind = 'usage' | 'adjustment';

export type AiUsageUnit = 'characters' | 'tokens' | 'minutes';

export type AiUsageResourceType =
  | 'speech'
  | 'voice_preview'
  | 'llm_generation'
  | 'vod_analysis';

export type AiUsageReceiptCategory =
  | 'tts'
  | 'ai_chat'
  | 'ai_agent'
  | 'memory'
  | 'clip_recommendation'
  | 'credit_adjustment'
  | 'other'
  | 'uncategorized';

export type AiUsagePeriodSource =
  | 'subscription'
  | 'free_monthly'
  | 'rolling_30_day'
  | 'custom';

export type AiUsagePacingStatus =
  | 'no_usage'
  | 'within_pace'
  | 'over_pace'
  | 'exhausted';

export interface AiUsageCapabilities {
  balance: boolean;
  pacing: boolean;
  dailySpend: boolean;
  categoryBreakdown: boolean;
  transactions: boolean;
}

export interface AiUsageBillingPeriod {
  source: AiUsagePeriodSource;
  startsAt: string;
  endsAt: string;
  endExclusive: boolean;
  from: string;
  to: string;
  totalDayCount: number;
  elapsedDayCount: number;
}

export interface AiUsagePacing {
  status: AiUsagePacingStatus;
  forecastBasis: 'current_billing_period' | 'current_free_credit_period';
  quotaUsedPercent: number;
  averageDailyCredits: number;
  projectedPeriodCredits: number;
  projectedQuotaUsedPercent: number;
  projectedOverageCredits: number;
  remainingPeriodDays: number;
  dailyCreditsToLastPeriod: number;
  expectedToExhaustWithinPeriod: boolean;
  estimatedDaysUntilExhaustion: number | null;
  estimatedExhaustionAt: string | null;
}

export interface AiUsageDailyPoint {
  date: string;
  credits: number;
  transactionCount: number;
}

export interface AiUsageCategoryBreakdown {
  category: AiUsageReceiptCategory;
  credits: number;
  transactionCount: number;
  percentage: number;
}

export interface AiUsageSummary {
  schemaVersion: number;
  itemizationStartedAt: string;
  period: {
    from: string;
    to: string;
    timeZone: string;
    dayCount: number;
  };
  totalSpentCredits: number;
  averageDailySpentCredits: number;
  grantedCredits: number;
  netConsumedCredits: number;
  transactionCount: number;
  daily: AiUsageDailyPoint[];
  categories: AiUsageCategoryBreakdown[];
}

export interface AiUsageTransaction {
  id: string;
  requestId: string | null;
  occurredAt: string;
  entryKind: AiUsageEntryKind;
  category: AiUsageReceiptCategory;
  operation: string;
  provider: string;
  model: string | null;
  quantity: number | null;
  unit: AiUsageUnit | null;
  credits: number;
  resourceType: AiUsageResourceType | null;
  resourceId: string | null;
  itemized: boolean;
}

export interface AiUsageSummaryData {
  planTier: AiUsagePlanTier;
  capabilities: AiUsageCapabilities;
  credits: AiCreditsData;
  billingPeriod: AiUsageBillingPeriod;
  pacing: AiUsagePacing | null;
  analytics: AiUsageSummary | null;
}

export interface AiUsageTransactionsData {
  planTier: AiUsagePlanTier;
  capabilities: AiUsageCapabilities;
  period: {
    from: string;
    to: string;
    timeZone: string;
    dayCount: number;
  };
  billingPeriod: AiUsageBillingPeriod;
  category: AiUsageReceiptCategory | null;
  items: AiUsageTransaction[];
  nextCursor: string | null;
}

export type AiUsageSummaryResponse = ApiEnvelope<AiUsageSummaryData>;
export type AiUsageTransactionsResponse = ApiEnvelope<AiUsageTransactionsData>;
