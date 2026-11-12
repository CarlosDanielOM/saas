import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';

/** Which chat-protection decisions the operator is looking at. */
export type ReviewKind = 'contradiction' | 'near_miss' | 'ban';
export type ReviewState = 'pending' | 'labelled';
/** The operator's verdict: this message should be a ban, or should not. */
export type ReviewLabel = 'violation' | 'allow';

export interface ReviewChatLine {
  username: string;
  message: string;
  isBroadcaster: boolean;
}

export interface ReviewRow {
  messageText: string;
  /** The streamer had invited viewers to share their links, which changes what counts as self-promotion. */
  invited: boolean;
  label: ReviewLabel | null;
  reviewedAt: string | null;
  /** The decisions this card stands for. A verdict is saved on exactly these. */
  ids: string[];
  count: number;
  /** Copies that came after other chat than the card shows; they come up on a later card. */
  more: number;
  channels: number;
  /** How many of the copies had no chat in the minute before them. */
  withoutContext: number;
  /** Every distinct chat that preceded one of the copies. */
  contexts: Array<{ copies: number; channel: string; lines: ReviewChatLine[] }>;
  latest: {
    id: string;
    channelID: string;
    channel: string;
    username: string;
    createdAt: string;
    model: string;
    verdict: 'allow' | 'violation' | 'uncertain';
    status: string;
    reviewSource: string;
    messageOrdinal: number | null;
    consequence: { status: string; action: string | null; success: boolean | null };
    thresholdPercent: number;
    categories: string[];
    scores: Record<string, number>;
  };
}

export interface ReviewList {
  rows: ReviewRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  /** Cards still waiting for a verdict, per queue. */
  counts: Record<ReviewKind, number>;
}

@Injectable({ providedIn: 'root' })
export class ModerationReviewApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly url = () => `${this.links.getApiUrl()}/admin-site/moderation-reviews`;

  list(kind: ReviewKind, state: ReviewState, page: number): Observable<{ data: ReviewList }> {
    const query = new URLSearchParams({ kind, state, page: String(page), limit: '20' });
    return this.http.get<{ data: ReviewList }>(`${this.url()}?${query}`);
  }

  /** Saves the verdict on exactly these decisions; `null` clears it. */
  label(kind: ReviewKind, ids: string[], label: ReviewLabel | null): Observable<{ data: { updated: number } }> {
    return this.http.put<{ data: { updated: number } }>(this.url(), { kind, ids, label });
  }
}
