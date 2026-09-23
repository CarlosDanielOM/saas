import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  AiUsageApiService, UsageCategory, UsageSummary, UsageTransaction
} from '../../services/ai-usage-api.service';

const CATEGORIES: UsageCategory[] = [
  'tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation',
  'credit_adjustment', 'other', 'uncategorized'
];

@Component({
  selector: 'app-channel-usage',
  imports: [RouterLink],
  templateUrl: './channel-usage.component.html',
  styleUrl: './channel-usage.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChannelUsageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AiUsageApiService);
  private requestVersion = 0;
  private transactionVersion = 0;
  readonly channelID = this.route.snapshot.paramMap.get('channelID') || '';
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
  readonly maxDaily = computed(() => Math.max(1, ...(this.summary()?.analytics.daily.map(day => day.credits) ?? [])));

  constructor() { void this.load(); }

  format(value: number): string { return new Intl.NumberFormat('en-US').format(Math.round(value)); }
  label(category: UsageCategory): string {
    return ({ tts: 'Text to speech', ai_chat: 'AI chat', ai_agent: 'AI agent',
      memory: 'Memory', clip_recommendation: 'Clip recommendations',
      credit_adjustment: 'Credit adjustments', other: 'Other',
      uncategorized: 'Uncategorized' })[category];
  }
  date(value: string): string { return new Date(value).toLocaleString(); }
  day(value: string): string { return value; }
  onFrom(event: Event): void { this.from.set((event.target as HTMLInputElement).value); }
  onTo(event: Event): void { this.to.set((event.target as HTMLInputElement).value); }

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
      if (response.error || !response.data) throw new Error(response.message || 'Could not load usage');
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
      this.rangeError.set('Choose a valid start and end date.');
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

  loadMore(): void { void this.loadTransactions(false); }

  private range(): { from?: string; to?: string; timezone: string } {
    return {
      ...(this.customRange() ? { from: this.from(), to: this.to() } : {}),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
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
      const response = await firstValueFrom(this.api.getTransactions(this.channelID, {
        ...this.range(), category: category || undefined,
        cursor: reset ? undefined : this.nextCursor() || undefined, limit: 25
      }));
      if (response.error || !response.data) throw new Error(response.message || 'Could not load transactions');
      if (version !== this.requestVersion || category !== this.category() || transactionVersion !== this.transactionVersion) return;
      this.transactions.update(current => reset ? response.data.items : [...current, ...response.data.items]);
      this.nextCursor.set(response.data.nextCursor);
    } catch (error) {
      if (version === this.requestVersion && transactionVersion === this.transactionVersion) this.transactionsError.set(this.message(error));
    } finally {
      if (transactionVersion === this.transactionVersion) this.transactionsLoading.set(false);
    }
  }

  private message(error: unknown): string {
    const response = error as { error?: { message?: string }; message?: string };
    return response?.error?.message || response?.message || 'Could not load usage';
  }
}
