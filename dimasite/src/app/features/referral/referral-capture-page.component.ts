import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AnalyticsService } from '../../services/analytics.service';
import { CheckoutIntentService } from '../../services/checkout-intent.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';

interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

@Component({
  selector: 'app-referral-capture-page',
  template: '<section aria-live="polite" aria-busy="true"></section>',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReferralCapturePageComponent implements OnInit {
  private readonly analytics = inject(AnalyticsService);
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly linksService = inject(LinksService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly checkoutIntent = inject(CheckoutIntentService);

  async ngOnInit(): Promise<void> {
    const refCode = (this.route.snapshot.paramMap.get('refCode') || '').trim().toLowerCase();

    if (!refCode || this.sessionAuth.hasValidSession()) {
      this.checkoutIntent.clearPendingReferralCode();
      await this.router.navigate(['/']);
      return;
    }

    try {
      const response = await firstValueFrom(
        this.http.get<ApiEnvelope<{ valid: boolean }>>(
          `${this.linksService.getApiUrl()}/referrals/validate/${encodeURIComponent(refCode)}`
        )
      );

      if (!response.error && response.data?.valid) {
        this.checkoutIntent.setPendingReferralCode(refCode);
        this.analytics.capture('referral_code_captured', {
          referral_code: refCode,
          result: 'valid',
        });
      } else {
        this.checkoutIntent.clearPendingReferralCode();
        this.analytics.capture('referral_code_rejected', {
          referral_code: refCode,
          result: 'invalid',
        });
      }
    } catch {
      this.checkoutIntent.clearPendingReferralCode();
      this.analytics.capture('referral_code_rejected', {
        referral_code: refCode,
        result: 'request_failed',
      });
    }

    await this.router.navigate(['/']);
  }
}
