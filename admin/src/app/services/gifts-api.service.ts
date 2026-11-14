import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, httpParams } from './api-util';

/**
 * Gifted AI credits: a viewer or streamer buys a credit pack for another channel. Three stages, run by the
 * bot's gift worker: the buyer pays in a Polar checkout → the bot delivers the credits to the recipient (a
 * free Polar order that grants permanent credits) → the bot announces the gift in the recipient's chat.
 *
 * Backend: `dimabot/src/server/routes/admin_site/gifts.route.ts` (mirror of these types).
 */

/**
 * Stored status.
 * - awaiting_payment: checkout open, the buyer hasn't paid (yet).
 * - payment_received / delivering: paid, credits on their way.
 * - delivered: credits granted (the chat announcement may still be pending or stopped).
 * - needs_support: paid, but delivery failed 5+ times. Only when `paid`; an unpaid `needs_support` is an old
 *   flag from before 2026-11-13 and means the buyer never paid.
 * - expired: the buyer never paid and the checkout expired (Polar keeps it open 24 hours). Nothing is owed.
 */
export type GiftStatus = 'awaiting_payment' | 'payment_received' | 'delivering' | 'delivered' | 'needs_support' | 'expired';

/** List filters. `needs_support` = paid and stuck; `in_progress` = paid, being delivered. */
export type GiftFilter = 'needs_support' | 'in_progress' | 'awaiting_payment' | 'delivered' | 'expired' | 'all';

export interface GiftRow {
  /** 64-char hex id. */
  id: string;
  status: GiftStatus;
  /** True once the buyer's payment was received. */
  paid: boolean;
  /** `channelID` is null when the buyer's account no longer has a Twitch channel. */
  buyer: { login: string; channelID: string | null };
  recipient: { login: string; displayName: string; channelID: string };
  credits: number;
  /** What the credits are worth at 100,000 credits per USD. */
  creditsUSD: number;
  /** What the buyer was charged before tax, in the currency's minor unit (cents). */
  priceAmount: number;
  /** Lower-case ISO currency, e.g. `usd`. */
  priceCurrency: string;
  /** ISO times. */
  createdAt: string;
  paidAt: string | null;
  deliveryStartedAt: string | null;
  deliveredAt: string | null;
  expiredAt: string | null;
  announcedAt: string | null;
  /** The bot stopped trying to announce it (held by chat moderation, or 5 failed sends). */
  announcementStoppedAt: string | null;
  announcementAttempts: number;
  /** Failed attempts at the current stage. */
  attempts: number;
  /** The last failure, in the bot's words (English, technical). Null when the last step worked. */
  lastError: string | null;
  /** When the bot looks at it next; null when there's nothing left to do. */
  nextAttemptAt: string | null;
  /** The bot is working on it right now. */
  processing: boolean;
  /** Polar references for finding the purchase in the Polar dashboard (never customer ids or secrets). */
  refs: {
    checkoutId: string | null;
    paidOrderId: string | null;
    deliveryCheckoutId: string | null;
    deliveryOrderId: string | null;
    grantId: string | null;
  };
}

export interface GiftList {
  rows: GiftRow[];
  /** Cursor for the next page; null at the end. */
  next: string | null;
  /** Count per filter for the same channel scope (ignores the status filter). */
  counts: Record<GiftFilter, number>;
}

export interface GiftQuery {
  status?: GiftFilter;
  /** Twitch channel id or login: gifts that channel sent or received. */
  channel?: string;
  cursor?: string;
  /** 1–50, default 25. */
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class GiftsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly base = `${this.links.getApiUrl()}/admin-site/gifts`;

  list(query: GiftQuery = {}): Observable<Envelope<GiftList>> {
    return this.http.get<Envelope<GiftList>>(this.base, { params: httpParams(query) });
  }

  get(id: string): Observable<Envelope<GiftRow>> {
    return this.http.get<Envelope<GiftRow>>(`${this.base}/${encodeURIComponent(id)}`);
  }

  /**
   * Ask the bot to run the next delivery step of a paid, undelivered gift now instead of waiting for its
   * retry timer. The bot still verifies the payment and never delivers twice. 409 (with a plain message) when
   * the gift was never paid, is already delivered, or is being processed right now.
   */
  retry(id: string): Observable<Envelope<GiftRow>> {
    return this.http.post<Envelope<GiftRow>>(`${this.base}/${encodeURIComponent(id)}/retry`, {});
  }
}
