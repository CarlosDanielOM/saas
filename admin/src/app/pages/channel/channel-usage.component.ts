import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  AiUsageApiService,
  UsageCategory,
  UsageSummary,
  UsageTransaction,
} from '../../services/ai-usage-api.service';
import { ChannelApiService } from '../../services/channel-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

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
  readonly usedPercent = computed(() => {
    const credits = this.summary()?.credits;
    if (!credits?.available || !credits.limit) return 0;
    return Math.min(100, Math.max(0, Math.round((credits.used / credits.limit) * 100)));
  });

  /** The page's answer: will this channel run out, and when? */
  readonly forecast = computed<{ tone: Tone; title: string; text: string } | null>(() => {
    const data = this.summary();
    if (!data) return null;
    const credits = data.credits;
    const pace = data.pacing;
    const left = this.format(credits.balance);
    if (!credits.available) {
      return {
        tone: 'muted',
        title: 'No credit account yet',
        text: "This channel has no billing account linked, so there's no balance to forecast.",
      };
    }
    if (!pace) {
      return { tone: 'muted', title: `${left} credits left`, text: 'Not enough history to forecast yet.' };
    }
    const resetIn = this.days(pace.remainingPeriodDays);
    const daily = this.format(pace.averageDailyCredits);
    if (pace.status === 'exhausted' || credits.balance <= 0) {
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
      credit_adjustment: 'Credit adjustments',
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
  isCredit(item: UsageTransaction): boolean {
    return item.entryKind === 'adjustment' || item.credits < 0;
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
    this.transactions.set([]);
    this.nextCursor.set(null);
    this.transactionsError.set(null);
    try {
      const response = await firstValueFrom(this.api.getSummary(this.channelID, this.range()));
      if (response.error || !response.data) throw new Error(response.message || "Couldn't load usage");
      if (version !== this.requestVersion) return;
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
