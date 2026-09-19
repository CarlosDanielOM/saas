import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, switchMap } from 'rxjs';

import {
  AiUsageCapabilities,
  AiUsageCategoryBreakdown,
  AiUsagePacing,
  AiUsagePacingStatus,
  AiUsagePeriodSource,
  AiUsagePlanTier,
  AiUsageReceiptCategory,
  AiUsageSummaryData,
  AiUsageTransaction
} from '../../models/usage.model';
import { BillingService, CreditPackCatalogData, CreditPackOffer } from '../../services/billing.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { UsageApiService } from '../../services/usage-api.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

type UsageTier = 'premium' | 'pro';

const TRANSACTION_PAGE_SIZE = 25;

const TRANSACTION_CATEGORIES: AiUsageReceiptCategory[] = [
  'tts',
  'ai_chat',
  'ai_agent',
  'memory',
  'clip_recommendation',
  'credit_adjustment',
  'other',
  'uncategorized'
];

@Component({
  selector: 'app-usage-page',
  imports: [RouterLink, LfIconComponent],
  templateUrl: './usage-page.component.html',
  styleUrl: './usage-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UsagePageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly usageApi = inject(UsageApiService);
  private readonly billingService = inject(BillingService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly numberFormatter = new Intl.NumberFormat();
  private readonly formatterCache = new Map<string, Intl.DateTimeFormat>();
  private readonly timeZone = this.resolveTimeZone();
  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );
  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({ streamer, channelID: null, status: 'idle' });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({ streamer, channelID, status: 'resolved' as const }))
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private lastLoadedKey = '';

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });
  readonly channelResolution = toSignal(this.channelID$, {
    initialValue: {
      streamer: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase(),
      channelID: null,
      status: 'loading'
    } satisfies ChannelResolutionState
  });
  readonly channelID = computed(() => this.channelResolution().channelID);

  readonly summary = signal<AiUsageSummaryData | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);

  readonly transactions = signal<AiUsageTransaction[]>([]);
  readonly transactionsLoading = signal(false);
  readonly transactionsError = signal<string | null>(null);
  readonly nextCursor = signal<string | null>(null);
  readonly selectedCategory = signal<AiUsageReceiptCategory | null>(null);
  readonly categoryFilters = TRANSACTION_CATEGORIES;

  readonly credits = computed(() => this.summary()?.credits ?? null);
  readonly creditsAvailable = computed(() => this.credits()?.available ?? false);
  readonly creditsUsed = computed(() => this.credits()?.used ?? 0);
  readonly creditsLimit = computed(() => this.credits()?.limit ?? 0);
  readonly creditsBalance = computed(() => this.credits()?.balance ?? 0);
  readonly creditPercent = computed(() => {
    const limit = this.creditsLimit();
    if (limit <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round((this.creditsUsed() / limit) * 100)));
  });
  readonly creditsExhausted = computed(() => {
    const data = this.credits();
    if (!data) {
      return false;
    }
    return data.status === 'exhausted' || (data.available && data.balance <= 0);
  });

  readonly planTier = computed<AiUsagePlanTier>(() => {
    const fromSummary = this.summary()?.planTier;
    if (fromSummary) {
      return fromSummary;
    }
    const tier = this.sessionAuth.getPlanTierForStreamer(this.streamer());
    return tier === 'premium' || tier === 'pro' ? tier : 'free';
  });

  readonly capabilities = computed<AiUsageCapabilities>(() => {
    const fromSummary = this.summary()?.capabilities;
    if (fromSummary) {
      return fromSummary;
    }
    return this.fallbackCapabilities(this.planTier());
  });
  readonly hasAnalytics = computed(() => this.capabilities().dailySpend || this.capabilities().categoryBreakdown);
  readonly hasTransactions = computed(() => this.capabilities().transactions);

  readonly packCatalog = signal<CreditPackCatalogData | null>(null);
  readonly recommendedPack = computed(() => {
    const overage = this.pacing()?.projectedOverageCredits ?? 0;
    const owner = this.sessionAuth.session()?.twitchUser.login.toLowerCase();
    if (!Number.isFinite(overage) || overage <= 0 || owner !== this.streamer()) return null;
    const catalog = this.packCatalog();
    return catalog?.offers
      .filter(pack => pack.eligible && pack.credits >= overage
        && (pack.kind !== 'recharge' || catalog.hasActivePaidSubscription))
      .sort((a, b) => a.priceAmount - b.priceAmount || a.credits - b.credits)[0] ?? null;
  });

  readonly pacing = computed<AiUsagePacing | null>(() => this.summary()?.pacing ?? null);
  readonly billingPeriod = computed(() => this.summary()?.billingPeriod ?? null);
  readonly analytics = computed(() => this.summary()?.analytics ?? null);
  readonly dailySpend = computed(() => this.analytics()?.daily ?? []);
  readonly dailySpendRows = computed(() => [...this.dailySpend()].reverse());
  readonly dailyMax = computed(() => Math.max(1, ...this.dailySpend().map((point) => point.credits)));
  readonly categories = computed<AiUsageCategoryBreakdown[]>(() => this.analytics()?.categories ?? []);

  readonly periodElapsedPercent = computed(() => {
    const period = this.billingPeriod();
    if (!period || period.totalDayCount <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round((period.elapsedDayCount / period.totalDayCount) * 100)));
  });

  readonly loadingMore = computed(() => this.transactionsLoading() && this.transactions().length > 0);
  readonly transactionsEmpty = computed(
    () => !this.transactionsLoading() && !this.transactionsError() && this.transactions().length === 0
  );

  constructor() {
    void this.loadPackCatalog();
    effect(() => {
      const resolution = this.channelResolution();

      if (resolution.status === 'idle') {
        this.loading.set(false);
        this.errorMessage.set(this.t('usage.errors.channelNotResolved'));
        this.lastLoadedKey = '';
        return;
      }

      if (resolution.status === 'loading') {
        this.loading.set(true);
        return;
      }

      if (!resolution.channelID) {
        this.loading.set(false);
        this.errorMessage.set(this.t('usage.errors.channelNotResolved'));
        this.lastLoadedKey = '';
        return;
      }

      if (this.lastLoadedKey === resolution.channelID) {
        return;
      }

      this.lastLoadedKey = resolution.channelID;
      void this.loadSummary(resolution.channelID);
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  dashboardLink(): string[] {
    return ['/', this.streamer(), 'dashboard'];
  }

  creditStoreLink(): string[] {
    return ['/', this.streamer(), 'credits'];
  }

  planTierLabel(): string {
    const tier = this.planTier();
    if (tier === 'pro') {
      return this.t('usage.plans.pro');
    }
    if (tier === 'premium') {
      return this.t('usage.plans.premium');
    }
    return this.t('usage.plans.free');
  }

  lockedTierLabel(tier: UsageTier): string {
    return this.t(`usage.plans.${tier}`);
  }

  formatCredits(value: number): string {
    const safe = Math.max(0, Math.round(value));
    if (safe < 1000) {
      return this.numberFormatter.format(safe);
    }
    const k = safe / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }

  formatNumber(value: number, maximumFractionDigits = 0): string {
    return new Intl.NumberFormat(this.getLocale(), { maximumFractionDigits }).format(
      Math.max(0, value)
    );
  }

  formatPercent(value: number): string {
    return `${Math.round(value)}%`;
  }

  formatDayLabel(value: string): string {
    const date = this.parseDayKey(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return this.dateFormatter({ month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  formatDateTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return this.dateFormatter({
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  formatFullDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return this.dateFormatter({ month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }

  pacingStatusLabel(status: AiUsagePacingStatus): string {
    return this.t(`usage.pacing.status.${status}`);
  }

  periodSourceLabel(source: AiUsagePeriodSource): string {
    return this.t(`usage.period.source.${source}`);
  }

  categoryLabel(category: AiUsageReceiptCategory): string {
    return this.t(`usage.categories.${category}`);
  }

  categoryBarWidth(category: AiUsageCategoryBreakdown): number {
    return Math.min(100, Math.max(0, category.percentage));
  }

  dailyBarWidth(point: { credits: number }): number {
    return this.dailyMax() > 0 ? Math.max(0, Math.round((point.credits / this.dailyMax()) * 100)) : 0;
  }

  isAdjustment(transaction: AiUsageTransaction): boolean {
    return transaction.entryKind === 'adjustment' || transaction.credits < 0;
  }

  transactionAmount(transaction: AiUsageTransaction): string {
    if (this.isAdjustment(transaction)) {
      return `+${this.formatCredits(Math.abs(transaction.credits))}`;
    }
    return this.formatCredits(transaction.credits);
  }

  transactionQuantity(transaction: AiUsageTransaction): string | null {
    if (transaction.quantity === null || !transaction.unit) {
      return null;
    }
    return this.t('usage.transactions.quantity', {
      quantity: this.formatNumber(transaction.quantity, 2),
      unit: this.t(`usage.units.${transaction.unit}`)
    });
  }

  setCategory(category: AiUsageReceiptCategory | null): void {
    if (this.selectedCategory() === category) {
      return;
    }

    this.selectedCategory.set(category);
    const channelID = this.channelID();
    if (channelID && this.hasTransactions()) {
      void this.loadTransactions(channelID, true);
    }
  }

  loadMore(): void {
    const channelID = this.channelID();
    if (!channelID || !this.nextCursor() || this.transactionsLoading()) {
      return;
    }

    void this.loadTransactions(channelID, false);
  }

  retry(): void {
    const channelID = this.channelID();
    if (!channelID) {
      return;
    }

    void this.loadSummary(channelID);
  }

  openUpgrade(): void {
    void this.upgradeService.promptUpgradeForAnyPlan('usage_page');
  }

  formatPackPrice(pack: CreditPackOffer): string {
    return new Intl.NumberFormat(this.getLocale(), {
      style: 'currency', currency: pack.priceCurrency.toUpperCase(),
      minimumFractionDigits: 0, maximumFractionDigits: 2
    }).format(pack.priceAmount / 100);
  }

  private async loadPackCatalog(): Promise<void> {
    try {
      const response = await firstValueFrom(this.billingService.getCreditPacks());
      this.packCatalog.set(!response.error && response.data ? response.data : null);
    } catch {
      // Usage remains available when the optional store recommendation cannot load.
      this.packCatalog.set(null);
    }
  }

  private async loadSummary(channelID: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.transactions.set([]);
    this.transactionsError.set(null);
    this.nextCursor.set(null);
    this.selectedCategory.set(null);

    try {
      const response = await firstValueFrom(
        this.usageApi.getSummary(channelID, { timeZone: this.timeZone })
      );

      if (response.error || !response.data) {
        throw new Error(response.message || this.t('usage.errors.loadFailed'));
      }

      this.summary.set(response.data);

      if (response.data.capabilities.transactions) {
        await this.loadTransactions(channelID, true);
      }
    } catch (error) {
      this.summary.set(null);
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('usage.errors.loadFailed')
      );
    } finally {
      this.loading.set(false);
    }
  }

  private async loadTransactions(channelID: string, reset: boolean): Promise<void> {
    this.transactionsLoading.set(true);
    this.transactionsError.set(null);

    try {
      const response = await firstValueFrom(
        this.usageApi.getTransactions(channelID, {
          timeZone: this.timeZone,
          category: this.selectedCategory() ?? undefined,
          cursor: reset ? undefined : this.nextCursor() ?? undefined,
          limit: TRANSACTION_PAGE_SIZE
        })
      );

      if (response.error || !response.data) {
        throw new Error(response.message || this.t('usage.transactions.errorTitle'));
      }

      this.transactions.update((current) =>
        reset ? response.data!.items : [...current, ...response.data!.items]
      );
      this.nextCursor.set(response.data.nextCursor);
    } catch (error) {
      this.transactionsError.set(
        error instanceof Error ? error.message : this.t('usage.transactions.errorTitle')
      );
    } finally {
      this.transactionsLoading.set(false);
    }
  }

  private fallbackCapabilities(planTier: AiUsagePlanTier): AiUsageCapabilities {
    return {
      balance: true,
      pacing: true,
      dailySpend: planTier === 'premium' || planTier === 'pro',
      categoryBreakdown: planTier === 'premium' || planTier === 'pro',
      transactions: planTier === 'pro'
    };
  }

  private getLocale(): string {
    return this.languageService.currentLanguage() === 'es' ? 'es-ES' : 'en-US';
  }

  private dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${this.getLocale()}|${JSON.stringify(options)}`;
    const cached = this.formatterCache.get(key);
    if (cached) {
      return cached;
    }

    const formatter = new Intl.DateTimeFormat(this.getLocale(), options);
    this.formatterCache.set(key, formatter);
    return formatter;
  }

  private parseDayKey(value: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return new Date(value);
    }

    const [, year, month, day] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  private resolveTimeZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }
}
