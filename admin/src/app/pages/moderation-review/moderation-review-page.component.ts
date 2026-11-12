import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  ModerationReviewApiService,
  type ReviewKind,
  type ReviewLabel,
  type ReviewRow,
  type ReviewState,
} from '../../services/moderation-review-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';

const KINDS: ReviewKind[] = ['contradiction', 'near_miss', 'ban'];
const CATEGORY_NAMES: Record<string, string> = {
  spam: 'Spam / scams',
  ads: 'Ads / sales',
  self_promotion: 'Self-promotion',
  profanity: 'Profanity',
  insults: 'Insults',
};
/** Chat protection never bans when the overall check is under this share. */
const MIN_OVERALL = 0.3;

@Component({
  selector: 'app-moderation-review-page',
  templateUrl: './moderation-review-page.component.html',
  styleUrl: './moderation-review-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SkeletonComponent, RouterLink],
})
export class ModerationReviewPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ModerationReviewApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly statusLine = viewChild<ElementRef<HTMLElement>>('statusLine');
  private readonly subscriptions = new Subscription();
  private request?: Subscription;

  readonly kinds = [
    { key: 'contradiction' as ReviewKind, label: 'Contradictions', hint: 'A category passed the ban bar, but the overall check said the message was fine, so nobody was banned.' },
    { key: 'near_miss' as ReviewKind, label: 'Near misses', hint: 'A category scored 50% or more and the classifier decided against a ban.' },
    { key: 'ban' as ReviewKind, label: 'Bans', hint: 'The classifier decided to ban. Each card says whether the ban was carried out.' },
  ];
  readonly kind = signal<ReviewKind>('contradiction');
  readonly state = signal<ReviewState>('pending');
  readonly page = signal(1);
  /** The queue the cards on screen belong to. It trails `kind`/`state` while a new queue loads. */
  readonly shown = signal<{ kind: ReviewKind; state: ReviewState } | null>(null);
  readonly rows = signal<ReviewRow[]>([]);
  readonly counts = signal<Record<ReviewKind, number> | null>(null);
  readonly total = signal(0);
  readonly totalPages = signal(1);
  readonly loading = signal(true);
  readonly failed = signal(false);
  /** Cards with a verdict being saved (by first decision ID): their buttons are off until the server answers. */
  readonly saving = signal<ReadonlySet<string>>(new Set());

  readonly waiting = computed(() => {
    const counts = this.counts();
    return counts ? KINDS.reduce((sum, kind) => sum + counts[kind], 0) : null;
  });
  readonly kindHint = computed(() => this.kinds.find((item) => item.key === this.kind())!.hint);

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const kind = params.get('kind') as ReviewKind;
        this.kind.set(KINDS.includes(kind) ? kind : 'contradiction');
        this.state.set(params.get('state') === 'labelled' ? 'labelled' : 'pending');
        this.page.set(Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
        // Cards of another queue must not stay clickable while this one loads.
        const shown = this.shown();
        if (shown && (shown.kind !== this.kind() || shown.state !== this.state())) {
          this.rows.set([]);
          this.shown.set(null);
        }
        this.load();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.request?.unsubscribe();
  }

  load(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.failed.set(false);
    const kind = this.kind();
    const state = this.state();
    this.request = this.api.list(kind, state, this.page()).subscribe({
      next: ({ data }) => {
        this.rows.set(data.rows);
        this.shown.set({ kind, state });
        this.counts.set(data.counts);
        this.total.set(data.pagination.total);
        this.totalPages.set(data.pagination.totalPages);
        this.loading.set(false);
        // A verdict on the last card of the last page leaves that page empty: step back.
        if (!data.rows.length && this.page() > 1) this.go({ page: Math.min(this.page() - 1, data.pagination.totalPages) });
      },
      error: () => {
        this.loading.set(false);
        this.failed.set(true);
      },
    });
  }

  go(change: { kind?: ReviewKind; state?: ReviewState; page?: number }): void {
    const kind = change.kind ?? this.kind();
    const state = change.state ?? this.state();
    const page = change.page ?? 1;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { kind: kind === 'contradiction' ? null : kind, state: state === 'pending' ? null : state, page: page > 1 ? page : null },
    });
  }

  setVerdict(row: ReviewRow, label: ReviewLabel | null): void {
    const shown = this.shown();
    const key = row.ids[0];
    if (!shown || this.saving().has(key)) return;
    this.saving.update((set) => new Set(set).add(key));
    this.subscriptions.add(
      this.api.label(shown.kind, row.ids, label).subscribe({
        next: ({ data }) => {
          this.done(key);
          const copies = data.updated > 1 ? ` on ${data.updated} copies` : '';
          this.toast.success(label ? `Saved${copies}: ${label === 'violation' ? 'should be a ban' : 'should not be a ban'}.` : `Verdict removed${copies}.`);
          // The answered card leaves the list; keep keyboard and screen-reader users at a known place.
          this.statusLine()?.nativeElement.focus();
          this.load();
        },
        error: () => {
          this.done(key);
          this.toast.error('The verdict was not saved. Try again.');
        },
      }),
    );
  }

  private done(key: string): void {
    this.saving.update((set) => {
      const next = new Set(set);
      next.delete(key);
      return next;
    });
  }

  private scored(row: ReviewRow): Array<{ name: string; value: number }> {
    return Object.entries(row.latest.scores)
      .filter(([key, value]) => key !== 'safe' && key !== 'violation' && typeof value === 'number')
      .map(([key, value]) => ({ name: CATEGORY_NAMES[key] || key, value }))
      .sort((a, b) => b.value - a.value);
  }

  /** The categories the classifier scored, highest first. Never rounded up: 84.96% must not read as the 85% bar. */
  categories(row: ReviewRow): Array<{ name: string; percent: number }> {
    return this.scored(row).map((item) => ({ name: item.name, percent: this.floor(item.value) }));
  }

  floor(value: number | undefined): number {
    return Math.floor((value ?? 0) * 1000 + 1e-6) / 10;
  }

  round(value: number | undefined): number {
    return Math.round((value ?? 0) * 1000) / 10;
  }

  /** One plain sentence: what the classifier saw and what happened. Compared on the stored scores, not the rounded ones. */
  reason(row: ReviewRow): string {
    const top = this.scored(row)[0];
    if (!top) return 'No category scores were stored for this review.';
    const safe = row.latest.scores['safe'] ?? 0;
    const overall = this.round(1 - safe);
    const bar = row.latest.thresholdPercent;
    const score = `${top.name} scored ${this.floor(top.value)}%`;
    const kind = this.shown()?.kind;
    if (kind === 'ban') {
      const outcome =
        row.latest.consequence.status === 'cancelled'
          ? 'The ban was cancelled before it ran.'
          : row.latest.consequence.success === false
            ? 'Twitch refused the ban.'
            : row.latest.consequence.status === 'executed'
              ? 'The chatter was banned.'
              : 'The ban had not been carried out when this was recorded.';
      return `The classifier said ban: ${score} (bar ${bar}%), overall check ${overall}%. ${outcome}`;
    }
    if (kind === 'contradiction') {
      return `${score}, over the ${bar}% bar, but the overall check was only ${overall}% (it needs ${MIN_OVERALL * 100}%). Not banned.`;
    }
    if (top.value < bar / 100) return `${score}, under the ${bar}% bar. Not banned.`;
    if (safe >= top.value) return `${score}, but the classifier was ${this.round(safe)}% sure the message was safe. Not banned.`;
    return `${score} with the overall check at ${overall}%. Not banned.`;
  }

  when(value: string): string {
    const date = new Date(value);
    const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  ordinal(row: ReviewRow): string {
    if (row.latest.reviewSource === 'spam_continuous') return 'later message';
    return row.latest.messageOrdinal === 3 ? 'third message' : row.latest.messageOrdinal === 2 ? 'second message' : 'first message';
  }

  /** What the collapsed chat section holds, so the operator knows whether to open it. */
  chatSummary(row: ReviewRow): string {
    const parts: string[] = [];
    if (row.contexts.length) parts.push(row.contexts.length === 1 ? '1 chat' : `${row.contexts.length} different chats`);
    if (row.withoutContext) parts.push(`${row.withoutContext} with none`);
    return parts.join(', ');
  }
}
