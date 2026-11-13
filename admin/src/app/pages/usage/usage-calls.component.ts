import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { UsageApiService, type UsageFilters, type UsageTransaction } from '../../services/usage-api.service';
import { dateTime, formatCreditValue, formatCredits, formatUSD, relativeTime } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { CATEGORY_LABEL, adjustmentLabel, quantityText, sourceLabel, transactionLine } from './usage-labels';

const PAGE = 40;

/** "Every call": the receipts themselves, newest or most expensive first, with "Load more". */
@Component({
  selector: 'app-usage-calls',
  templateUrl: './usage-calls.component.html',
  styleUrl: './usage-calls.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent],
})
export class UsageCallsComponent implements OnDestroy {
  private readonly api = inject(UsageApiService);
  readonly filters = input.required<UsageFilters>();
  readonly sort = input<'newest' | 'credits'>('newest');
  readonly kinds = input<'usage' | 'all'>('usage');
  readonly sortChange = output<'newest' | 'credits'>();
  readonly kindsChange = output<'usage' | 'all'>();
  readonly clear = output<void>();

  readonly rows = signal<UsageTransaction[]>([]);
  readonly cursor = signal<string | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly moreFailed = signal(false);
  /** The rows on screen belong to an older query while a new one loads. */
  readonly stale = signal(false);
  private request?: Subscription;

  readonly line = transactionLine;
  readonly when = (at: string) => (Date.now() - new Date(at).getTime() < 48 * 3_600_000 ? relativeTime(at) : dateTime(at));
  readonly fullTime = dateTime;
  readonly value = formatCreditValue;
  readonly usd = formatUSD;
  readonly categoryLabel = (tx: UsageTransaction) => CATEGORY_LABEL[tx.category] ?? 'Other';
  readonly source = sourceLabel;
  readonly adjustment = adjustmentLabel;
  readonly quantity = (tx: UsageTransaction) => quantityText(tx.quantity, tx.unit);
  readonly operation = (tx: UsageTransaction) => tx.operation.replace(/_/g, ' ');

  /** "Most expensive" only goes 500 rows deep. */
  readonly deepEnd = computed(() => this.sort() === 'credits' && !this.cursor() && this.rows().length >= 500);

  constructor() {
    effect(() => {
      const query = { ...this.filters(), sort: this.sort(), kinds: this.kinds() };
      untracked(() => this.load(query, null));
    });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }

  credits(tx: UsageTransaction): string {
    return tx.credits < 0 ? `+${formatCredits(-tx.credits)}` : formatCredits(tx.credits);
  }

  retry(): void {
    this.load({ ...this.filters(), sort: this.sort(), kinds: this.kinds() }, null);
  }

  more(): void {
    const cursor = this.cursor();
    if (cursor && !this.loading()) this.load({ ...this.filters(), sort: this.sort(), kinds: this.kinds() }, cursor);
  }

  private load(query: UsageFilters & { sort: 'newest' | 'credits'; kinds: 'usage' | 'all' }, cursor: string | null): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    if (cursor) this.moreFailed.set(false);
    else {
      this.failed.set(false);
      this.stale.set(this.rows().length > 0);
    }
    const { sort, kinds, ...filters } = query;
    this.request = this.api
      .transactions({ ...filters, sort: sort === 'credits' ? 'credits' : null, entryKind: kinds === 'all' ? 'all' : null, cursor, limit: PAGE })
      .subscribe({
        next: ({ data }) => {
          if (cursor) {
            const seen = new Set(this.rows().map((row) => row.id));
            this.rows.update((rows) => [...rows, ...data.items.filter((row) => !seen.has(row.id))]);
          } else this.rows.set(data.items);
          this.cursor.set(data.nextCursor);
          this.stale.set(false);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          if (cursor) this.moreFailed.set(true);
          else {
            this.failed.set(true);
            this.stale.set(false);
          }
        },
      });
  }
}
