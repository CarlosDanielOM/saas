import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, httpParams } from './api-util';

/**
 * Referrals of one person (a channel's account). A referral lives on the invited person: who invited them
 * (`referredBy`) and with which of the inviter's codes. Backend: `dimabot/src/server/routes/admin_site/referrals.route.ts`.
 *
 * Rules the page must explain in plain words:
 * - The inviter earns referral rewards only while the code is one of the inviter's active codes (`rewardsReferrer`).
 * - The invited person gets the 10% discount on a first subscription only when they signed up with a code
 *   (`discount`). A referrer set by the owner (`source: 'manual'`) never gives that discount.
 * - Rewards already paid stay where they are when a referrer is changed or removed.
 */

/** `manual` = set by the owner here; `code` = signed up with a code; `unknown` = an old row with neither. */
export type ReferralSource = 'manual' | 'code' | 'unknown';

export interface ReferralPerson {
  userId: string;
  login: string;
  channelID: string;
  plan: 'free' | 'premium' | 'pro';
}

export interface ReferredBy {
  userId: string;
  /** Null when the inviter's account was deleted. */
  login: string | null;
  channelID: string | null;
  /** The inviter's code this referral counts under; null = none (the inviter earns no rewards for it). */
  code: string | null;
  source: ReferralSource;
  /** When the owner set it by hand (ISO); null for sign-ups with a code. */
  setAt: string | null;
  /** The inviter is rewarded when this person pays (code still one of the inviter's active codes). */
  rewardsReferrer: boolean;
  /** This person gets the 10% first-subscription discount (signed up with a code, not set by hand). */
  discount: boolean;
}

export interface ReferralCode {
  code: string;
  label: string;
  active: boolean;
  /** People who signed up with this code (or were added under it). */
  signups: number;
  /** People who paid at least once under this code (from reward receipts). */
  conversions: number;
  createdAt: string | null;
}

export interface ReferredPerson {
  userId: string;
  login: string;
  channelID: string | null;
  plan: 'free' | 'premium' | 'pro';
  code: string | null;
  source: ReferralSource;
  signedUpAt: string | null;
  /** AI credits the inviter earned from this person so far. */
  creditsEarned: number;
}

export interface Referrals {
  person: ReferralPerson;
  referredBy: ReferredBy | null;
  /** The person's own referral codes, oldest first (inactive ones included). */
  codes: ReferralCode[];
  /** People this person invited, newest first (one page). */
  referred: ReferredPerson[];
  referredTotal: number;
  /** AI credits the person earned from everyone they invited. */
  creditsEarnedTotal: number;
  /** Cursor for the next page of `referred`; null at the end. */
  next: string | null;
}

export interface SetReferrer {
  /** The inviter's Twitch channel id or login; null removes the referrer. */
  referrer: string | null;
  /** One of the inviter's codes; omitted = the inviter's oldest active code (none: stored without a code). */
  code?: string;
  /** Needed to move someone who already has a different inviter (409 otherwise, with a message naming them). */
  replace?: boolean;
  /**
   * The inviter's user id the page showed (null = nobody). When it changed meanwhile, nothing is written and the
   * API answers 409 "Who invited them changed since this page loaded…". Always send it.
   */
  expectedReferrer?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ReferralsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly base = `${this.links.getApiUrl()}/admin-site/users`;

  get(channelID: string, cursor?: string): Observable<Envelope<Referrals>> {
    return this.http.get<Envelope<Referrals>>(`${this.base}/${encodeURIComponent(channelID)}/referrals`, { params: httpParams({ cursor }) });
  }

  /**
   * Set, move or remove who invited the person on `channelID`. The answer is the person's fresh `Referrals`
   * (first page) and a plain message ("Now invited by …"). Always marks the referral as set by hand.
   */
  setReferrer(channelID: string, body: SetReferrer): Observable<Envelope<Referrals>> {
    return this.http.put<Envelope<Referrals>>(`${this.base}/${encodeURIComponent(channelID)}/referrer`, body);
  }
}
