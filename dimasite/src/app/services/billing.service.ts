import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { PendingPaidPlan } from './checkout-intent.service';

interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export type BillingScenario =
  | 'new'
  | 'upgrade'
  | 'change'
  | 'returning_winback'
  | 'reactivate'
  | 'active_no_change';

export interface BillingContextData {
  planTier: 'free' | 'premium' | 'pro';
  hasActiveSubscription: boolean;
  hasAnySubscriptionHistory: boolean;
  inactivityMonths: number;
  isWinbackEligible: boolean;
  scenario: BillingScenario;
  activeSubscriptionId?: string;
  activeProductId?: string;
  targetProductId?: string;
  isReferralEligible: boolean;
}

export interface BillingCheckoutData {
  checkoutUrl: string;
  checkoutId: string;
  scenario: BillingScenario;
  appliedDiscount: {
    id: string | null;
    code: string | null;
    reason: 'referral' | 'promo' | 'winback' | 'upgrade' | 'change' | null;
  };
  allowDiscountCodes: boolean;
}

export interface BillingPortalData {
  sessionId: string;
  url: string;
  expiresAt: string;
}

export type CreditPackKind = 'credits' | 'recharge';
export type CreditPackSize = 'sample' | 'small' | 'starter' | 'medium';

export interface CreditPackOffer {
  id: string;
  name: string;
  kind: CreditPackKind;
  size: CreditPackSize;
  credits: number;
  rollover: boolean;
  priceAmount: number;
  priceCurrency: string;
  eligible: boolean;
  eligibilityReason: 'paid_plan_required' | null;
}

export interface CreditPackCatalogData {
  planTier: 'free' | 'premium' | 'pro';
  hasActivePaidSubscription: boolean;
  rechargeExpiresAt: string | null;
  rechargeExpiryDays: number | null;
  offers: CreditPackOffer[];
}

export interface CreditPackCheckoutData {
  checkoutId: string;
  checkoutUrl: string;
  offer: CreditPackOffer;
}

export interface GiftPackOffer {
  id: string;
  name: string;
  credits: number;
  rollover: true;
  priceAmount: number;
  priceCurrency: string;
}

export interface GiftPackCatalogData {
  offers: GiftPackOffer[];
}

export interface GiftRecipient {
  id: string;
  login: string;
  displayName: string;
  avatarUrl?: string | null;
}

export interface GiftPackCheckoutRequest {
  productId: string;
  recipientId: string;
  acknowledgeNoRefunds: true;
  /** Stable for one purchase intent so retries never open a second checkout. */
  requestId: string;
  successUrl?: string;
  returnUrl?: string;
}

export interface GiftPackCheckoutData {
  giftId: string;
  checkoutId: string;
  checkoutUrl: string;
  offer: GiftPackOffer;
  recipient: GiftRecipient;
}

export type GiftStatus =
  | 'awaiting_payment'
  | 'payment_received'
  | 'delivering'
  | 'delivered'
  | 'needs_support';

export interface GiftStatusData {
  id: string;
  status: GiftStatus;
  recipient: Pick<GiftRecipient, 'id' | 'login' | 'displayName'>;
  credits: number;
  paidAt: string | null;
  deliveredAt: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class BillingService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getContext(targetPlan: PendingPaidPlan): Observable<ApiEnvelope<BillingContextData>> {
    return this.http.get<ApiEnvelope<BillingContextData>>(
      `${this.linksService.getApiUrl()}/billing/context?targetPlan=${encodeURIComponent(targetPlan)}`
    );
  }

  createCheckout(request: {
    targetPlan: PendingPaidPlan;
    successUrl?: string;
    returnUrl?: string;
  }): Observable<ApiEnvelope<BillingCheckoutData>> {
    return this.http.post<ApiEnvelope<BillingCheckoutData>>(
      `${this.linksService.getApiUrl()}/billing/checkout`,
      request
    );
  }

  /** Opens Polar's customer portal: change plan, cancel, payment method, invoices. */
  createPortalSession(request: { returnUrl?: string }): Observable<ApiEnvelope<BillingPortalData>> {
    return this.http.post<ApiEnvelope<BillingPortalData>>(
      `${this.linksService.getApiUrl()}/billing/portal`,
      request
    );
  }

  getCreditPacks(): Observable<ApiEnvelope<CreditPackCatalogData>> {
    return this.http.get<ApiEnvelope<CreditPackCatalogData>>(
      `${this.linksService.getApiUrl()}/billing/credit-packs`
    );
  }

  createCreditPackCheckout(request: {
    productId: string;
    successUrl?: string;
    returnUrl?: string;
  }): Observable<ApiEnvelope<CreditPackCheckoutData>> {
    return this.http.post<ApiEnvelope<CreditPackCheckoutData>>(
      `${this.linksService.getApiUrl()}/billing/credit-packs/checkout`,
      request
    );
  }

  getGiftPacks(): Observable<ApiEnvelope<GiftPackCatalogData>> {
    return this.http.get<ApiEnvelope<GiftPackCatalogData>>(
      `${this.linksService.getApiUrl()}/billing/gift-packs`
    );
  }

  searchGiftRecipients(query: string): Observable<ApiEnvelope<GiftRecipient[]>> {
    return this.http.get<ApiEnvelope<GiftRecipient[]>>(
      `${this.linksService.getApiUrl()}/billing/gift-packs/recipients`,
      { params: { query } }
    );
  }

  findGiftRecipient(login: string): Observable<ApiEnvelope<GiftRecipient>> {
    return this.http.get<ApiEnvelope<GiftRecipient>>(
      `${this.linksService.getApiUrl()}/billing/gift-packs/recipient`,
      { params: { login } }
    );
  }

  createGiftPackCheckout(request: GiftPackCheckoutRequest): Observable<ApiEnvelope<GiftPackCheckoutData>> {
    return this.http.post<ApiEnvelope<GiftPackCheckoutData>>(
      `${this.linksService.getApiUrl()}/billing/gift-packs/checkout`,
      request
    );
  }

  getGift(giftId: string): Observable<ApiEnvelope<GiftStatusData>> {
    return this.http.get<ApiEnvelope<GiftStatusData>>(
      `${this.linksService.getApiUrl()}/billing/gift-packs/${encodeURIComponent(giftId)}`
    );
  }
}
