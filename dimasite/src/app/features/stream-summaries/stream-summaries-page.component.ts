import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { MemoryActionResult, MemoryProposal, StreamSummary } from '../../models/stream-summary.model';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { StreamSummaryApiService } from '../../services/stream-summary-api.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

/** Plain-language outcome of one summary, shown as its status chip. */
export type SummaryOutcome = 'saved' | 'nothing' | 'short' | 'processing' | 'failed' | 'cleanup';

/** The runner stores this English placeholder when a stream is under the length/chat thresholds. */
const BELOW_THRESHOLD_PREFIX = 'Stream did not meet summary thresholds';

/** Skip reasons from the memory runner, grouped into explanations a streamer understands. */
function skipReasonKey(reason: string | undefined): string {
  const value = reason ?? '';
  if (value === 'learning_disabled') return 'learningOff';
  if (value.endsWith('_confidence_below_threshold')) return 'notSure';
  if (value.startsWith('auto_apply_') && value.endsWith('_disabled')) return 'autoOff';
  if (value === 'memory_too_new_for_delete' || value === 'memory_recently_used_or_updated') return 'stillUsed';
  if (value === 'max_deletes_per_run_reached') return 'limit';
  if (value === 'memory_not_found' || value === 'missing_target_memory_id') return 'gone';
  return 'other';
}

@Component({
  selector: 'app-stream-summaries-page',
  imports: [RouterLink, DecimalPipe, LfIconComponent],
  templateUrl: './stream-summaries-page.component.html',
  styleUrl: './stream-summaries-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StreamSummariesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly summariesApi = inject(StreamSummaryApiService);

  readonly streamerParam$ = this.route.paramMap.pipe(
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
        map((channelID) => ({ streamer, channelID, status: 'resolved' as const })),
        startWith({ streamer, channelID: null, status: 'loading' as const })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

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
  readonly modulePath = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });

  readonly planTier = computed(() => {
    return this.sessionAuth.getPlanTierForStreamer(this.streamer());
  });

  readonly summaries = signal<StreamSummary[]>([]);
  readonly totalCount = signal(0);
  readonly currentPage = signal(1);
  readonly pageSize = signal(10);
  readonly isLoading = signal(false);
  readonly selectedSummary = signal<StreamSummary | null>(null);
  readonly showDetailOnMobile = signal(false);
  readonly loadError = signal(false);
  readonly loaded = signal(false);
  readonly memoriesPath = computed(() => ['/', this.streamer(), 'modules', 'memories']);

  readonly hasSummaries = computed(() => this.summaries().length > 0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalCount() / this.pageSize()) || 1));

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();
      const page = this.currentPage();
      const limit = this.pageSize();

      if (resolution.status === 'resolved' && resolution.channelID) {
        void this.loadSummaries(resolution.channelID, page, limit);
      }
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  private locale(): string {
    return this.languageService.currentLanguage() === 'es' ? 'es' : 'en';
  }

  formatDate(dateString: string): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(this.locale(), { weekday: 'short', month: 'short', day: 'numeric' });
  }

  formatTime(dateString: string): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(this.locale(), { hour: 'numeric', minute: '2-digit' });
  }

  formatDuration(minutes: number): string {
    const total = Math.max(0, Math.round(minutes || 0));
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (!hours) return this.t('streamSummaries.v2.minutes', { m: rest });
    return this.t('streamSummaries.v2.hoursMinutes', { h: hours, m: rest });
  }

  formatNumber(value: number): string {
    return (value || 0).toLocaleString(this.locale());
  }

  isMaintenance(summary: StreamSummary): boolean {
    return summary.source === 'weekly_maintenance' || summary.source === 'monthly_maintenance';
  }

  isBelowThreshold(summary: StreamSummary): boolean {
    return summary.status === 'noop' && !summary.proposed_actions.length && (summary.recap || '').startsWith(BELOW_THRESHOLD_PREFIX);
  }

  outcome(summary: StreamSummary): SummaryOutcome {
    if (summary.status === 'pending') return 'processing';
    if (summary.status === 'failed') return 'failed';
    if (this.isBelowThreshold(summary)) return 'short';
    if (summary.status === 'applied') return 'saved';
    return this.isMaintenance(summary) ? 'cleanup' : 'nothing';
  }

  outcomeLabel(summary: StreamSummary): string {
    const outcome = this.outcome(summary);
    if (outcome === 'saved') {
      const count = summary.totals?.applied ?? 0;
      return this.t(count === 1 ? 'streamSummaries.v2.outcome.savedOne' : 'streamSummaries.v2.outcome.saved', { count });
    }
    return this.t('streamSummaries.v2.outcome.' + outcome);
  }

  title(summary: StreamSummary): string {
    if (this.isMaintenance(summary)) {
      return this.t(summary.source === 'weekly_maintenance' ? 'streamSummaries.v2.weeklyCleanup' : 'streamSummaries.v2.monthlyCleanup');
    }
    if (this.isBelowThreshold(summary)) return this.t('streamSummaries.v2.shortTitle');
    return summary.headline || this.t('streamSummaries.list.noHeadline');
  }

  resultFor(summary: StreamSummary, index: number): MemoryActionResult | null {
    return summary.applied_actions?.[index] ?? null;
  }

  resultLabel(summary: StreamSummary, index: number): string {
    const result = this.resultFor(summary, index);
    if (!result) return this.t('streamSummaries.v2.result.notTried');
    if (result.status === 'applied') return this.t('streamSummaries.v2.result.saved');
    if (result.status === 'failed') return this.t('streamSummaries.v2.result.failed');
    return this.t('streamSummaries.v2.skip.' + skipReasonKey(result.reason));
  }

  actionLabel(proposal: MemoryProposal): string {
    return this.t('streamSummaries.v2.action.' + (proposal.action || 'noop'));
  }

  selectSummary(summary: StreamSummary): void {
    this.selectedSummary.set(summary);
    this.showDetailOnMobile.set(true);
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 960px)').matches) {
      window.scrollTo({ top: 0 });
    }
  }

  retry(): void {
    const channelID = this.channelID();
    if (channelID) void this.loadSummaries(channelID, this.currentPage(), this.pageSize());
  }

  closeDetailMobile(): void {
    this.showDetailOnMobile.set(false);
  }

  changePage(newPage: number): void {
    if (newPage < 1 || newPage > this.totalPages()) return;
    this.currentPage.set(newPage);
  }

  private async loadSummaries(channelID: string, page: number, limit: number): Promise<void> {
    this.isLoading.set(true);
    this.loadError.set(false);
    const skip = (page - 1) * limit;

    try {
      const result = await firstValueFrom(this.summariesApi.getSummaries(channelID, limit, skip));
      const items = result.items ?? [];
      this.summaries.set(items);
      this.totalCount.set(result.total ?? items.length);

      const selected = this.selectedSummary();
      const stillVisible = selected && items.some((item) => item._id === selected._id);
      if (!stillVisible) {
        this.selectedSummary.set(items[0] ?? null);
      }
    } catch {
      this.loadError.set(true);
    } finally {
      this.isLoading.set(false);
      this.loaded.set(true);
    }
  }
}
