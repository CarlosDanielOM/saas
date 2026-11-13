import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, httpParams } from './api-util';

/**
 * AI usage across every channel, from the usage receipts (one receipt per charged call: a voice request,
 * an AI reply, a memory summary, a charged chat protection review).
 *
 * Money: credits are what the channel was charged; 100,000 credits = 1 USD (1,000 credits = 1 cent).
 * `providerUSD` is what the provider charged us, and is only set where the bot records it.
 */
export type UsageCategoryKey = 'tts' | 'ai_chat' | 'ai_agent' | 'memory' | 'clip_recommendation' | 'other' | 'uncategorized';

export interface UsageActor {
  id: string | null;
  login: string | null;
  name: string | null;
}

export interface UsageFilters {
  /** Twitch channel id. */
  channel?: string | null;
  /** Chatter Twitch id (the viewer whose message or redemption caused the usage). */
  actor?: string | null;
  category?: UsageCategoryKey | null;
  provider?: string | null;
  model?: string | null;
  /** Where it came from: ast (commands; also rewards on receipts from before rewards had their own source), redemption (rewards), pet, voice_preview, oauth_desktop, chat, moderation… */
  source?: string | null;
  /** ISO times. Default: the last 7 days. Free channels keep 30 days of receipts, Premium 60, Pro 90. */
  from?: string | null;
  to?: string | null;
}

export interface UsageTotals {
  /** Charged calls. */
  count: number;
  credits: number;
  /** Sum of the provider cost where recorded; `providerKnown` = how many of the calls had one. */
  providerUSD: number;
  providerKnown: number;
}

export interface UsageSummary {
  from: string;
  to: string;
  /** `withActor` = how many of the calls name the viewer who caused them (recorded since this console shipped). */
  totals: UsageTotals & { channels: number; chatters: number; withActor: number };
  /** Credits added in the range (grants, packs, monthly resets), as a positive number. */
  granted: number;
  /** Biggest first. */
  byCategory: Array<UsageTotals & { category: UsageCategoryKey }>;
  /** Biggest first, at most 20. `model` is null when the receipt has none (older voice requests). */
  byModel: Array<UsageTotals & { category: UsageCategoryKey; provider: string; model: string | null }>;
  /** Biggest first, at most 12. */
  bySource: Array<UsageTotals & { category: UsageCategoryKey; source: string }>;
  /** Biggest first, at most 25. */
  byChannel: Array<UsageTotals & { channelID: string; channel: string | null; planTier: 'free' | 'premium' | 'pro' | null }>;
  /** Biggest first, at most 25. Only receipts that name a chatter count (recorded since this console shipped). */
  byActor: Array<UsageTotals & { actor: UsageActor }>;
  /** One row per UTC day in the range, oldest first, zeros included. */
  daily: Array<{ date: string; count: number; credits: number; providerUSD: number }>;
}

export interface UsageTransaction {
  id: string;
  at: string;
  channelID: string;
  channel: string | null;
  entryKind: 'usage' | 'adjustment';
  category: UsageCategoryKey | 'credit_adjustment';
  operation: string;
  source: string | null;
  adjustmentType: string | null;
  provider: string;
  model: string | null;
  /** Voice id or name for voice requests, when recorded. */
  voice: string | null;
  quantity: number | null;
  unit: 'characters' | 'tokens' | 'minutes' | null;
  /** Positive = charged, negative = credits added. */
  credits: number;
  providerUSD: number | null;
  actor: UsageActor | null;
}

export interface UsageTransactionQuery extends UsageFilters {
  /** Default 'usage'. 'adjustment' lists grants and resets; 'all' both. */
  entryKind?: 'usage' | 'adjustment' | 'all' | null;
  /** 'credits' = most expensive first (first page only goes deep: no cursor past 500 rows). */
  sort?: 'newest' | 'credits' | null;
  cursor?: string | null;
  /** Default 40, at most 100. */
  limit?: number;
}

export interface UsageTransactionPage {
  items: UsageTransaction[];
  nextCursor: string | null;
}

@Injectable({ providedIn: 'root' })
export class UsageApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly url = () => `${this.links.getApiUrl()}/admin-site/usage`;

  /** `GET /admin-site/usage/summary` */
  summary(filters: UsageFilters = {}): Observable<Envelope<UsageSummary>> {
    return this.http.get<Envelope<UsageSummary>>(`${this.url()}/summary`, { params: httpParams(filters) });
  }

  /** `GET /admin-site/usage/transactions` */
  transactions(query: UsageTransactionQuery = {}): Observable<Envelope<UsageTransactionPage>> {
    return this.http.get<Envelope<UsageTransactionPage>>(`${this.url()}/transactions`, { params: httpParams(query) });
  }
}
