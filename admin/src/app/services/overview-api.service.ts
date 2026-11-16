import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope } from './api-util';
import { FeedItem, FeedKindCount } from './feed-api.service';

/** Where AI money goes. `protection` = chat protection reviews, `voice` = text to speech. */
export type SpendFeature = 'voice' | 'ai_chat' | 'memory' | 'protection' | 'assistant' | 'docs' | 'other';

/**
 * Things that need the operator. A key is only listed when its count is above zero.
 * - verdicts_waiting: chat protection messages waiting for a verdict in the review queue.
 * - failed_24h: feed rows that failed in the last 24 hours.
 * - dead_deliveries: Twitch events one of the bot's consumers gave up on.
 * - usage_import_stuck: usage history imports that stopped retrying.
 * - polar_unsent: channels with usage not yet reported to billing.
 * - gifts_need_support: gifted credit purchases that could not be delivered.
 * - credits_exhausted: channels with no AI credits left.
 * - compat_removable: pieces of old-version overlay/Studio code no page has needed for 14 days (System → Versions).
 */
export type AttentionKey =
  | 'verdicts_waiting' | 'failed_24h' | 'dead_deliveries' | 'usage_import_stuck'
  | 'polar_unsent' | 'gifts_need_support' | 'credits_exhausted' | 'compat_removable';

export interface AdminOverview {
  generatedAt: string;
  /** The last 24 hours. */
  day: {
    from: string;
    to: string;
    kinds: FeedKindCount[];
    /** Channels with at least one feed row. */
    activeChannels: number;
    /** AI credits charged to channels. 100,000 credits = 1 USD. */
    credits: number;
    /** What providers charged us, where the bot records it (chat protection, assistant, docs). */
    providerUSD: number;
  };
  /** The last 14 UTC days, oldest first; days with nothing are included as zeros. */
  daily: Array<{ date: string; events: number; problems: number; credits: number; providerUSD: number }>;
  /** The last 7 days, biggest spend first. */
  features: Array<{
    feature: SpendFeature;
    /** Requests, reviews, messages or questions. */
    count: number;
    failed: number;
    /** Credits charged to channels; 0 for features that are free to streamers (assistant, docs, included reviews). */
    credits: number;
    /** Provider cost in USD when recorded; null when the bot does not record it for this feature. */
    providerUSD: number | null;
  }>;
  /** The last 24 hours, busiest first, at most 8. */
  topChannels: Array<{ channelID: string; channel: string | null; events: number; problems: number; credits: number }>;
  attention: Array<{ key: AttentionKey; count: number }>;
  /** The newest 8 feed rows. */
  recent: FeedItem[];
  /** Parts that could not be loaded in time ('feed', 'usage', 'decisions', 'assistant', 'docs', 'attention'). */
  partial: string[];
}

@Injectable({ providedIn: 'root' })
export class OverviewApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  /** `GET /admin-site/overview` */
  get(): Observable<Envelope<AdminOverview>> {
    return this.http.get<Envelope<AdminOverview>>(`${this.links.getApiUrl()}/admin-site/overview`);
  }
}
