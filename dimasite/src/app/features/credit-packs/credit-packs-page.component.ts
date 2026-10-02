import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { AiUsageSummaryData } from '../../models/usage.model';
import {
  BillingService,
  type CreditPackCatalogData,
  type CreditPackKind,
  type CreditPackOffer
} from '../../services/billing.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { UsageApiService } from '../../services/usage-api.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';

/** Credits per smallest currency unit, the basis for every value comparison on this page. */
function packRate(pack: CreditPackOffer): number {
  return pack.priceAmount > 0 ? pack.credits / pack.priceAmount : 0;
}

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
  private readonly usageApi = inject(UsageApiService);

  readonly recommendedId = this.route.snapshot.queryParamMap.get('recommended');

  readonly catalog = signal<CreditPackCatalogData | null>(null);
  readonly usage = signal<AiUsageSummaryData | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly checkingOutId = signal<string | null>(null);
  readonly selectedKind = signal<CreditPackKind>('credits');
  readonly purchaseCompleted = signal(
    this.route.snapshot.queryParamMap.get('credits') === 'success'
  );

  readonly streamer = computed(
    () => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  );
  readonly purchaserLogin = computed(
    () => (this.sessionAuth.session()?.twitchUser.login ?? '').trim().toLowerCase()
  );
  readonly canPurchase = computed(() =>
    Boolean(this.purchaserLogin() && this.purchaserLogin() === this.streamer())
  );
  readonly isManagingDifferentAccount = computed(() => {
    const purchaser = this.purchaserLogin();
    const streamer = this.streamer();
    return Boolean(purchaser && streamer && purchaser !== streamer);
  });
  readonly planTier = computed(() =>
    this.catalog()?.planTier
    ?? this.sessionAuth.getPlanTierForStreamer(this.streamer())
  );
  readonly hasActivePaidSubscription = computed(
    () => this.catalog()?.hasActivePaidSubscription ?? false
  );
  readonly visiblePacks = computed(() =>
    this.catalog()?.offers.filter((offer) => offer.kind === this.selectedKind()) ?? []
  );

  /** How many more credits a recharge gives than a permanent pack at the same price. */
  readonly rechargeAdvantage = computed(() => {
    const offers = this.catalog()?.offers ?? [];
    const permanent = offers.filter((offer) => offer.kind === 'credits');
    let best = 0;
    for (const recharge of offers.filter((offer) => offer.kind === 'recharge')) {
      const match = permanent.find((offer) =>
        offer.priceAmount === recharge.priceAmount && offer.priceCurrency === recharge.priceCurrency
      );
      if (match && match.credits > 0) {
        best = Math.max(best, Math.round((recharge.credits / match.credits - 1) * 100));
      }
    }
    return best;
  });

  readonly bestValueId = computed(() => {
    const packs = this.visiblePacks();
    if (packs.length < 2) return null;
    return packs.reduce((best, pack) => (packRate(pack) > packRate(best) ? pack : best)).id;
  });

  /** Cheapest eligible pack that covers the shortfall projected for this billing period. */
  readonly pacedRecommendationId = computed(() => {
    const overage = this.usage()?.pacing?.projectedOverageCredits ?? 0;
    const catalog = this.catalog();
    if (!catalog || !Number.isFinite(overage) || overage <= 0) return null;
    return catalog.offers
      .filter((pack) => pack.eligible && pack.credits >= overage)
      .sort((a, b) => a.priceAmount - b.priceAmount || a.credits - b.credits)[0]?.id ?? null;
  });
  readonly recommendedPackId = computed(() => {
    const offers = this.catalog()?.offers ?? [];
    const fromLink = offers.find((pack) => pack.id === this.recommendedId && pack.eligible);
    return fromLink?.id ?? this.pacedRecommendationId();
  });
  readonly featuredId = computed(() => {
    const recommended = this.recommendedPackId();
    if (recommended && this.visiblePacks().some((pack) => pack.id === recommended)) {
      return recommended;
    }
    return this.bestValueId();
  });

  readonly balance = computed(() => {
    const credits = this.usage()?.credits;
    return credits?.available ? Math.max(0, credits.balance) : null;
  });
  readonly balanceNote = computed<{ text: string; warn: boolean } | null>(() => {
    const summary = this.usage();
    if (!summary) return null;
    if (summary.credits.status === 'exhausted' || (summary.credits.available && summary.credits.balance <= 0)) {
      return { text: this.t('creditPacks.balance.empty'), warn: true };
    }
    const days = summary.pacing?.estimatedDaysUntilExhaustion;
    if (days === null || days === undefined || !Number.isFinite(days)) return null;
    const rounded = Math.max(0, Math.floor(days));
    return {
      text: rounded <= 1
        ? this.t('creditPacks.balance.dayLeft')
        : this.t('creditPacks.balance.daysLeft', { days: rounded }),
      warn: rounded <= 7
    };
  });

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
  readonly rechargeExpiryHeadline = computed(() => {
    const days = this.catalog()?.rechargeExpiryDays;
    if (days === null || days === undefined) {
      return this.t('creditPacks.recharge.expiryAlertNone');
    }
    if (days <= 0) {
      return this.t('creditPacks.recharge.expiryAlertToday');
    }
    if (days === 1) {
      return this.t('creditPacks.recharge.expiryAlertDay');
    }
    return this.t('creditPacks.recharge.expiryAlertDays', { days });
  });
  readonly rechargeExpiryDate = computed<string | null>(() => {
    const value = this.catalog()?.rechargeExpiresAt;
    if (!value) {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return new Intl.DateTimeFormat(this.locale(), { dateStyle: 'medium' }).format(date);
  });
  readonly rechargeExpiresSoon = computed(() => {
    const days = this.catalog()?.rechargeExpiryDays;
    return days !== null && days !== undefined && days <= 7;
  });

  private usageRequested = false;

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

    // Purchases always land on the signed-in account, so show that account's balance.
    effect(() => {
      const channelID = this.sessionAuth.session()?.appUser.twitch_user_id;
      if (!channelID || !this.canPurchase() || this.usageRequested) return;
      this.usageRequested = true;
      void this.loadUsage(channelID);
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  usageLink(): string[] {
    return ['/', this.streamer(), 'usage'];
  }

  selectKind(kind: CreditPackKind): void {
    this.selectedKind.set(kind);
  }

  formatCredits(value: number): string {
    return new Intl.NumberFormat(this.locale(), {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(value);
  }

  formatPrice(pack: CreditPackOffer): string {
    return this.formatMoney(pack.priceAmount, pack.priceCurrency);
  }

  packName(pack: CreditPackOffer): string {
    return this.t(`creditPacks.sizes.${pack.size}`);
  }

  /** Extra credits per dollar compared with the smallest pack of the same type. */
  bonusPercent(pack: CreditPackOffer): number {
    const rates = (this.catalog()?.offers ?? [])
      .filter((offer) => offer.kind === pack.kind)
      .map(packRate)
      .filter((rate) => rate > 0);
    if (!rates.length) return 0;
    return Math.max(0, Math.round((packRate(pack) / Math.min(...rates) - 1) * 100));
  }

  perUnitLabel(pack: CreditPackOffer): string {
    return this.t('creditPacks.perUnit', {
      credits: this.formatCredits(packRate(pack) * 100),
      unit: this.formatMoney(100, pack.priceCurrency)
    });
  }

  /** Days this pack would last at the purchaser's recent average spend. */
  paceDays(pack: CreditPackOffer): number | null {
    const average = this.usage()?.pacing?.averageDailyCredits ?? 0;
    if (!Number.isFinite(average) || average <= 0) return null;
    const days = Math.floor(pack.credits / average);
    return days >= 1 ? days : null;
  }

  /**
   * Recharge credits the purchaser would not get through before they expire,
   * at their recent average spend. Null when everything should get used.
   */
  unusedBeforeExpiry(pack: CreditPackOffer): number | null {
    const catalog = this.catalog();
    const average = this.usage()?.pacing?.averageDailyCredits ?? 0;
    const days = catalog?.rechargeExpiryDays;
    if (pack.kind !== 'recharge' || !catalog?.hasActivePaidSubscription) return null;
    if (days === null || days === undefined || !Number.isFinite(average) || average <= 0) return null;
    const unused = Math.round(pack.credits - average * Math.max(0, days));
    return unused > 0 ? unused : null;
  }

  async startCheckout(pack: CreditPackOffer): Promise<void> {
    if (!this.canPurchase()) return;
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
      this.selectedKind.set(this.initialKind(response.data));
    } catch (error) {
      this.catalog.set(null);
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('creditPacks.errors.load')
      );
    } finally {
      this.loading.set(false);
    }
  }

  private async loadUsage(channelID: string): Promise<void> {
    try {
      const response = await firstValueFrom(this.usageApi.getSummary(channelID));
      if (!response.error && response.data) {
        this.usage.set(response.data);
      }
    } catch {
      // The balance is a convenience; the store works without it.
    }
  }

  private initialKind(catalog: CreditPackCatalogData): CreditPackKind {
    const linked = catalog.offers.find((offer) => offer.id === this.recommendedId);
    if (linked) return linked.kind;
    return catalog.hasActivePaidSubscription ? 'recharge' : 'credits';
  }

  private formatMoney(amount: number, currency: string): string {
    return new Intl.NumberFormat(this.locale(), {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(amount / 100);
  }

  private locale(): string {
    return this.languageService.currentLanguage() === 'es' ? 'es-ES' : 'en-US';
  }
}
