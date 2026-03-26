import { Injectable } from '@angular/core';

export type PendingPaidPlan = 'premium' | 'pro';

const PENDING_PLAN_KEY = 'billing.pendingPlan';
const PENDING_PLAN_AT_KEY = 'billing.pendingPlanAt';
const PENDING_REFERRAL_KEY = 'referral.pendingCode';
const PENDING_REFERRAL_AT_KEY = 'referral.pendingCodeAt';

const PENDING_PLAN_TTL_MS = 1000 * 60 * 60 * 24;
const PENDING_REFERRAL_TTL_MS = 1000 * 60 * 60 * 24 * 30;

@Injectable({
  providedIn: 'root'
})
export class CheckoutIntentService {
  getPendingPlan(): PendingPaidPlan | null {
    const value = this.readTimedValue(PENDING_PLAN_KEY, PENDING_PLAN_AT_KEY, PENDING_PLAN_TTL_MS);
    if (value === 'premium' || value === 'pro') {
      return value;
    }

    this.clearPendingPlan();
    return null;
  }

  setPendingPlan(plan: PendingPaidPlan): void {
    sessionStorage.setItem(PENDING_PLAN_KEY, plan);
    sessionStorage.setItem(PENDING_PLAN_AT_KEY, String(Date.now()));
  }

  clearPendingPlan(): void {
    sessionStorage.removeItem(PENDING_PLAN_KEY);
    sessionStorage.removeItem(PENDING_PLAN_AT_KEY);
  }

  getPendingReferralCode(): string | null {
    const value = this.readTimedValue(PENDING_REFERRAL_KEY, PENDING_REFERRAL_AT_KEY, PENDING_REFERRAL_TTL_MS);
    if (value && /^[a-z0-9_]{1,16}$/.test(value)) {
      return value;
    }

    this.clearPendingReferralCode();
    return null;
  }

  setPendingReferralCode(code: string): void {
    const normalizedCode = code.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,16}$/.test(normalizedCode)) {
      this.clearPendingReferralCode();
      return;
    }

    sessionStorage.setItem(PENDING_REFERRAL_KEY, normalizedCode);
    sessionStorage.setItem(PENDING_REFERRAL_AT_KEY, String(Date.now()));
  }

  clearPendingReferralCode(): void {
    sessionStorage.removeItem(PENDING_REFERRAL_KEY);
    sessionStorage.removeItem(PENDING_REFERRAL_AT_KEY);
  }

  private readTimedValue(valueKey: string, timestampKey: string, maxAgeMs: number): string | null {
    const value = sessionStorage.getItem(valueKey);
    const rawTimestamp = sessionStorage.getItem(timestampKey);

    if (!value || !rawTimestamp) {
      return null;
    }

    const timestamp = Number(rawTimestamp);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > maxAgeMs) {
      sessionStorage.removeItem(valueKey);
      sessionStorage.removeItem(timestampKey);
      return null;
    }

    return value;
  }
}
