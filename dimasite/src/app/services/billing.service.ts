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
}
