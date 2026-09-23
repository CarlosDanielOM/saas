import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { LinksService } from './links.service';
import { AiCreditsData } from './channel-api.service';

export type UsageCategory = 'tts' | 'ai_chat' | 'ai_agent' | 'memory' | 'clip_recommendation'
  | 'credit_adjustment' | 'other' | 'uncategorized';

export interface UsagePeriod {
  source: string;
  from: string;
  to: string;
  totalDayCount: number;
  elapsedDayCount: number;
}

export interface UsageSummary {
  planTier: 'free' | 'premium' | 'pro';
  credits: AiCreditsData;
  billingPeriod: UsagePeriod;
  ledger: { status: 'ready' | 'pending'; coverageStart: string | null } | null;
  pacing: {
    status: string;
    averageDailyCredits: number;
    projectedPeriodCredits: number;
    remainingPeriodDays: number;
  } | null;
  analytics: {
    itemizationStartedAt: string;
    totalSpentCredits: number;
    averageDailySpentCredits: number;
    grantedCredits: number;
    netConsumedCredits: number;
    transactionCount: number;
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
