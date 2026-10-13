import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  AiUsageApiService,
  UsageAdjustmentTotal,
  UsageCategory,
  UsageSummary,
  UsageTransaction,
} from '../../services/ai-usage-api.service';
import { ChannelApiService } from '../../services/channel-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { buildUsageDisplay } from './usage-display';

const CATEGORIES: UsageCategory[] = [
  'tts',
  'ai_chat',
  'ai_agent',
  'memory',
  'clip_recommendation',
  'credit_adjustment',
  'other',
  'uncategorized',
];

type Tone = 'ok' | 'warn' | 'live' | 'muted';

/** Plain names for adjustment receipts: `group` for totals, `row` for one entry. */
const ADJUSTMENTS: Record<string, { group: string; row: string }> = {
  native_grant: { group: 'Unclassified credits', row: 'Unclassified credit grant' },
  subscription_credits: { group: 'Subscription credits', row: 'Subscription credits' },
  gifted_credits: { group: 'Gifted credits', row: 'Gifted credits' },
  manual_grant: { group: 'Admin grants', row: 'Admin credit grant' },
  monthly_reset: { group: 'Monthly resets', row: 'Monthly reset' },
  purchased_pack: { group: 'Purchased credits', row: 'Purchased credits' },
  refund: { group: 'Refunds', row: 'Refund' },
  correction: { group: 'Corrections', row: 'Balance correction' },
  activation: { group: 'Activation credits', row: 'Activation credits' },
  other: { group: 'Other adjustments', row: 'Credit adjustment' },
};

@Component({
  selector: 'app-channel-usage',
  imports: [RouterLink, IconComponent, SkeletonComponent],
  templateUrl: './channel-usage.component.html',
  styleUrl: './channel-usage.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelUsageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AiUsageApiService);
  private readonly channelApi = inject(ChannelApiService);
  private requestVersion = 0;
  private transactionVersion = 0;
  readonly channelID = this.route.snapshot.paramMap.get('channelID') || '';
  readonly channelName = signal<string | null>(null);
  readonly summary = signal<UsageSummary | null>(null);
  private readonly cycleSummary = signal<UsageSummary | null>(null);
  readonly display = computed(() => {
    const cycle = this.cycleSummary();
    return cycle ? buildUsageDisplay(cycle) : null;
  });
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly rangeError = signal<string | null>(null);
  readonly transactions = signal<UsageTransaction[]>([]);
  readonly transactionsLoading = signal(false);
  readonly transactionsError = signal<string | null>(null);
  readonly nextCursor = signal<string | null>(null);
  readonly category = signal<UsageCategory | null>(null);
  readonly categories = CATEGORIES;
  readonly from = signal('');
  readonly to = signal('');
  readonly customRange = signal(false);
  readonly maxDaily = computed(() =>
    Math.max(1, ...(this.summary()?.analytics.daily.map((day) => day.credits) ?? [])),
  );
  /** Grants and other balance adjustments, largest first. */
  readonly adjustments = computed<UsageAdjustmentTotal[]>(() =>
    [...(this.summary()?.analytics.adjustments ?? [])]
      .filter((item) => item.transactionCount > 0)
      .sort((a, b) => b.grantedCredits + b.debitedCredits - (a.grantedCredits + a.debitedCredits)),
  );
  readonly usedPercent = computed(() => {
    const credits = this.display()?.credits;
    if (!credits?.available || !credits.limit) return 0;
    return Math.min(100, Math.max(0, Math.round((credits.used / credits.limit) * 100)));
  });
  readonly hasUnclassifiedCredits = computed(() => this.adjustments().some(item => item.type === 'native_grant'));

  /** The page's answer: will this channel run out, and when? */
  readonly forecast = computed<{ tone: Tone; title: string; text: string } | null>(() => {
    const data = this.summary();
    if (!data) return null;
    const display = this.display();
    if (!display) return null;
    const credits = display.credits;
    const pace = display.pacing;
    if (!data.credits.available) {
      return {
        tone: 'muted',
        title: 'No credit account yet',
        text: "This channel has no billing account linked, so there's no balance to forecast.",
      };
    }
    if (!credits) {
      return { tone: 'muted', title: 'Credit history still syncing',
        text: 'The remaining-credit estimate and forecast will appear when the current period’s activity is ready.' };
    }
    const left = this.format(credits.balance);
    if (!pace) {
      return { tone: 'muted', title: `${left} credits left`, text: 'Not enough history to forecast yet.' };
    }
    const resetIn = this.days(pace.remainingPeriodDays);
    const daily = this.format(pace.averageDailyCredits);
    if (pace.status === 'exhausted' || credits.balance <= 0) {
      if (display.estimated) {
        return { tone: 'live', title: 'Estimated allowance fully used',
          text: `Recorded activity has used this period’s allowance. The period resets in ${resetIn}.` };
      }
      return {
        tone: 'live',
        title: 'Out of credits',
        text: `AI replies and paid voices are paused until the period resets in ${resetIn}, unless credits are added.`,
      };
    }
    if (pace.status === 'no_usage') {
      return {
        tone: 'muted',
        title: 'No AI usage lately',
        text: `${left} credits are waiting. The period resets in ${resetIn}.`,
      };
    }
    const runout = pace.estimatedDaysUntilExhaustion;
    if ((pace.expectedToExhaustWithinPeriod || pace.status === 'over_pace') && runout != null) {
      const gap = Math.max(1, Math.round(pace.remainingPeriodDays - runout));
      return {
        tone: runout <= 3 ? 'live' : 'warn',
        title: `On pace to run out in ~${this.days(Math.max(1, Math.floor(runout)))}`,
        text: `Using about ${daily} credits a day — that's ${this.days(gap)} before the period resets.`,
      };
    }
    return {
      tone: 'ok',
      title: 'On track for this period',
      text: `Using about ${daily} credits a day, ${this.format(pace.projectedPeriodCredits)} projected of ${this.format(credits.limit)} by the reset in ${resetIn}.`,
    };
  });

  constructor() {
    void this.load();
    this.channelApi.getChannel(this.channelID).subscribe({
      next: (user) => this.channelName.set(user?.channel ?? null),
      error: () => this.channelName.set(null),
    });
  }

  format(value: number): string {
    return new Intl.NumberFormat('en-US').format(Math.round(value));
  }
  compact(value: number): string {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
      Math.round(value),
    );
  }
  days(count: number): string {
    return `${count} ${count === 1 ? 'day' : 'days'}`;
  }
  label(category: UsageCategory): string {
    return {
      tts: 'Text to speech',
      ai_chat: 'AI chat',
      ai_agent: 'AI agent',
      memory: 'Memory',
      clip_recommendation: 'Clip recommendations',
      credit_adjustment: 'Grants & adjustments',
      other: 'Other',
      uncategorized: 'Uncategorized',
    }[category];
  }
  /** Date-only strings are local calendar days; don't let UTC parsing shift them. */
  private toDate(value: string): Date {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return day ? new Date(+day[1], +day[2] - 1, +day[3]) : new Date(value);
  }
  shortDate(value: string): string {
    return this.toDate(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  date(value: string): string {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  longDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  /** Only negative credits add to the balance; positive adjustments are debits. */
  isCredit(item: UsageTransaction): boolean {
    return item.credits < 0;
  }
  adjustmentGroup(type: string): string {
    return (ADJUSTMENTS[type] ?? ADJUSTMENTS['other']).group;
  }
  /** Rows say what happened to the balance; the raw operation stays secondary. */
  describe(item: UsageTransaction): { title: string; meta: string; raw: string | null } {
    if (item.entryKind !== 'adjustment') {
      return {
        title: this.label(item.category),
        meta: item.model ? `${item.operation} · ${item.model}` : item.operation,
        raw: null,
      };
    }
    const added = this.isCredit(item);
    if (['subscription_credits', 'purchased_pack', 'gifted_credits'].includes(item.adjustmentType || '') && added) {
      const lifetime = item.operation === 'permanent_credit_grant' ? 'Carries over until used'
        : item.operation === 'period_credit_grant' ? 'Ends at the period reset' : 'Added to balance';
      return { title: ADJUSTMENTS[item.adjustmentType!].row, meta: lifetime, raw: item.operation };
    }
    if (item.adjustmentType === 'native_grant' && added) {
      if (item.operation === 'permanent_credit_grant')
        return { title: 'Unclassified credit grant', meta: 'Permanent · source not matched', raw: item.operation };
      if (item.operation === 'period_credit_grant')
        return { title: 'Unclassified credit grant', meta: 'Period · source not matched', raw: item.operation };
    }
    return {
      title: (ADJUSTMENTS[item.adjustmentType || 'other'] ?? ADJUSTMENTS['other']).row,
      meta: added ? 'Added to balance' : 'Removed from balance',
      raw: item.operation,
    };
  }
  /** Spent plus debits minus grants; negative means more was granted than used. */
  net(value: number): string {
    return value < 0 ? `${this.compact(-value)} more granted than used` : `${this.compact(value)} net used`;
  }
  onFrom(event: Event): void {
    this.from.set((event.target as HTMLInputElement).value);
  }
  onTo(event: Event): void {
    this.to.set((event.target as HTMLInputElement).value);
  }

  async load(): Promise<void> {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.error.set(null);
    this.rangeError.set(null);
    this.summary.set(null);
    this.cycleSummary.set(null);
    this.transactions.set([]);
    this.nextCursor.set(null);
    this.transactionsError.set(null);
    try {
      const response = await firstValueFrom(this.api.getSummary(this.channelID, this.range()));
      if (response.error || !response.data) throw new Error(response.message || "Couldn't load usage");
      if (version !== this.requestVersion) return;
      let cycle = response.data;
      // A date filter changes activity totals, never the current balance or forecast.
      if (cycle.planTier === 'free' && this.customRange()) {
        const current = await firstValueFrom(this.api.getSummary(this.channelID, {
          timezone: this.range().timezone,
        }));
        if (current.error || !current.data) throw new Error(current.message || "Couldn't load current period");
        if (version !== this.requestVersion) return;
        cycle = current.data;
      }
      this.cycleSummary.set(cycle);
      this.summary.set(response.data);
      await this.loadTransactions(true);
    } catch (error) {
      if (version === this.requestVersion) this.error.set(this.message(error));
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }

  applyRange(): void {
    if (!this.from() || !this.to() || this.from() > this.to()) {
      this.rangeError.set('Choose a start date on or before the end date.');
      return;
    }
    this.customRange.set(true);
    void this.load();
  }

  resetRange(): void {
    this.customRange.set(false);
    this.from.set('');
    this.to.set('');
    void this.load();
  }

  selectCategory(category: UsageCategory | null): void {
    if (this.category() === category) return;
    this.category.set(category);
    this.transactions.set([]);
    this.nextCursor.set(null);
    void this.loadTransactions(true);
  }

  loadMore(): void {
    void this.loadTransactions(false);
  }

  private range(): { from?: string; to?: string; timezone: string } {
    return {
      ...(this.customRange() ? { from: this.from(), to: this.to() } : {}),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    };
  }

  async loadTransactions(reset: boolean): Promise<void> {
    if (this.transactionsLoading() && !reset) return;
    const transactionVersion = ++this.transactionVersion;
    const version = this.requestVersion;
    const category = this.category();
    this.transactionsLoading.set(true);
    this.transactionsError.set(null);
    try {
      const response = await firstValueFrom(
        this.api.getTransactions(this.channelID, {
          ...this.range(),
          category: category || undefined,
          cursor: reset ? undefined : this.nextCursor() || undefined,
          limit: 25,
        }),
      );
      if (response.error || !response.data)
        throw new Error(response.message || "Couldn't load transactions");
      if (
        version !== this.requestVersion ||
        category !== this.category() ||
        transactionVersion !== this.transactionVersion
      )
        return;
      this.transactions.update((current) =>
        reset ? response.data.items : [...current, ...response.data.items],
      );
      this.nextCursor.set(response.data.nextCursor);
    } catch (error) {
      if (version === this.requestVersion && transactionVersion === this.transactionVersion)
        this.transactionsError.set(this.message(error));
    } finally {
      if (transactionVersion === this.transactionVersion) this.transactionsLoading.set(false);
    }
  }

  private message(error: unknown): string {
    const response = error as { error?: { message?: string }; message?: string };
    return response?.error?.message || response?.message || "Couldn't load usage";
  }
}
