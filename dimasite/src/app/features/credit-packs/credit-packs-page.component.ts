import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import {
  BillingService,
  type CreditPackCatalogData,
  type CreditPackOffer
} from '../../services/billing.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';

@Component({
  selector: 'app-credit-packs-page',
  imports: [RouterLink, LfIconComponent],
  templateUrl: './credit-packs-page.component.html',
  styleUrl: './credit-packs-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CreditPacksPageComponent {
  private readonly billingService = inject(BillingService);
  private readonly languageService = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly upgradeService = inject(UpgradeService);

  readonly catalog = signal<CreditPackCatalogData | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly checkingOutId = signal<string | null>(null);
  readonly purchaseCompleted = signal(
    this.route.snapshot.queryParamMap.get('credits') === 'success'
  );

  readonly streamer = computed(
    () => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  );
  readonly planTier = computed(() =>
    this.catalog()?.planTier
    ?? this.sessionAuth.getPlanTierForStreamer(this.streamer())
  );
  readonly creditPacks = computed(() =>
    this.catalog()?.offers.filter((offer) => offer.kind === 'credits') ?? []
  );
  readonly rechargePacks = computed(() =>
    this.catalog()?.offers.filter((offer) => offer.kind === 'recharge') ?? []
  );
  readonly hasActivePaidSubscription = computed(
    () => this.catalog()?.hasActivePaidSubscription ?? false
  );
  readonly rechargeExpiryLabel = computed(() => {
    const days = this.catalog()?.rechargeExpiryDays;
    if (days === null || days === undefined) {
      return this.t('creditPacks.recharge.expires');
    }
    if (days <= 0) {
      return this.t('creditPacks.recharge.expiresToday');
    }
    if (days === 1) {
      return this.t('creditPacks.recharge.expiresInDay');
    }
    return this.t('creditPacks.recharge.expiresInDays', { days });
  });

  constructor() {
    if (this.purchaseCompleted()) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { credits: null, checkout_id: null },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });
    }
    void this.loadCatalog();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  usageLink(): string[] {
    return ['/', this.streamer(), 'usage'];
  }

  formatCredits(value: number): string {
    return new Intl.NumberFormat(this.locale(), {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(value);
  }

  formatPrice(pack: CreditPackOffer): string {
    return new Intl.NumberFormat(this.locale(), {
      style: 'currency',
      currency: pack.priceCurrency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(pack.priceAmount / 100);
  }

  packName(pack: CreditPackOffer): string {
    return this.t(`creditPacks.sizes.${pack.size}`);
  }

  async startCheckout(pack: CreditPackOffer): Promise<void> {
    if (!pack.eligible) {
      await this.upgradeService.promptUpgradeForAnyPlan('credit_pack_store');
      return;
    }
    if (this.checkingOutId()) {
      return;
    }

    this.checkingOutId.set(pack.id);
    this.errorMessage.set(null);
    try {
      const pageUrl = `${window.location.origin}${window.location.pathname}`;
      const response = await firstValueFrom(
        this.billingService.createCreditPackCheckout({
          productId: pack.id,
          successUrl: `${pageUrl}?credits=success&checkout_id={CHECKOUT_ID}`,
          returnUrl: pageUrl
        })
      );
      if (response.error || !response.data?.checkoutUrl) {
        throw new Error(response.message || this.t('creditPacks.errors.checkout'));
      }

      window.location.assign(response.data.checkoutUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('creditPacks.errors.checkout');
      this.errorMessage.set(message);
      this.toastService.error(this.t('creditPacks.errors.checkoutTitle'), message);
      this.checkingOutId.set(null);
    }
  }

  openUpgrade(): void {
    void this.upgradeService.promptUpgradeForAnyPlan('credit_pack_store_locked_recharge');
  }

  retry(): void {
    void this.loadCatalog();
  }

  private async loadCatalog(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const response = await firstValueFrom(this.billingService.getCreditPacks());
      if (response.error || !response.data) {
        throw new Error(response.message || this.t('creditPacks.errors.load'));
      }
      this.catalog.set(response.data);
    } catch (error) {
      this.catalog.set(null);
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('creditPacks.errors.load')
      );
    } finally {
      this.loading.set(false);
    }
  }

  private locale(): string {
    return this.languageService.currentLanguage() === 'es' ? 'es-ES' : 'en-US';
  }
}
