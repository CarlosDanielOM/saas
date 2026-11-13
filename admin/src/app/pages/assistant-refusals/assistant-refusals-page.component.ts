import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { AssistantRefusalsApiService, type AssistantRefusal } from '../../services/assistant-refusals-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

const ROLE_NAMES: Record<string, string> = { user: 'Streamer', assistant: 'Assistant', tool: 'Tool result', summary: 'Earlier summary' };

/**
 * Site assistant: Expert answers the safety filter declined (Standard answered instead, the person paid 2 more).
 * Answers "what was asked, and why might it have been declined?". Read only, owner only, newest first.
 */
@Component({
  selector: 'app-assistant-refusals-page',
  templateUrl: './assistant-refusals-page.component.html',
  styleUrl: './assistant-refusals-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SkeletonComponent, RouterLink],
})
export class AssistantRefusalsPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(AssistantRefusalsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly subscriptions = new Subscription();
  private request?: Subscription;

  readonly page = signal(1);
  readonly channel = signal<string | null>(null);
  readonly rows = signal<AssistantRefusal[]>([]);
  readonly counts = signal<{ week: number; total: number } | null>(null);
  readonly total = signal(0);
  readonly totalPages = signal(1);
  readonly loading = signal(true);
  readonly failed = signal(false);

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const channel = params.get('channel');
        this.channel.set(channel && /^\d{1,20}$/.test(channel) ? channel : null);
        this.page.set(Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
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
    this.request = this.api.list(this.page(), this.channel()).subscribe({
      next: ({ data }) => {
        this.rows.set(data.rows);
        this.counts.set(data.counts);
        this.total.set(data.pagination.total);
        this.totalPages.set(data.pagination.totalPages);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  go(change: { page?: number; channel?: string | null }): void {
    const channel = change.channel !== undefined ? change.channel : this.channel();
    const page = change.page ?? (change.channel !== undefined ? 1 : this.page());
    void this.router.navigate([], { queryParams: { channel: channel || null, page: page > 1 ? page : null } });
  }

  /** How it was declined, in plain words. */
  how(row: AssistantRefusal): string {
    if (row.source === 'error') return 'The request was refused before any answer (an error from the provider or OpenRouter).';
    return row.partial ? 'It started answering, then the safety filter stopped it.' : 'The safety filter stopped it before it wrote anything.';
  }

  /** Raw signals worth seeing (finish reasons, error type, moderation reasons). */
  signals(row: AssistantRefusal): string[] {
    const out: string[] = [];
    if (row.finishReason) out.push(`finish: ${row.finishReason}`);
    if (row.nativeFinishReason) out.push(`provider: ${row.nativeFinishReason}`);
    if (row.detail?.errorType) out.push(`error type: ${row.detail.errorType}`);
    for (const reason of row.detail?.reasons ?? []) out.push(`reason: ${reason}`);
    return out;
  }

  roleName(role: string): string {
    return ROLE_NAMES[role] ?? role;
  }

  when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}
