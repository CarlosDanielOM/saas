import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, firstValueFrom, of } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { DashboardApiService } from '../../services/dashboard-api.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import {
  ClipRecommendation,
  ClipRecommendationCandidate,
  ClipRecommendationConfig,
  TwitchVodInfo
} from './clip-recommendations.model';
import { ClipRecommendationsService } from './clip-recommendations.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { LazyVideoFrameDirective } from '../triggers/lazy-video-frame.directive';

type Pricing = ClipRecommendationConfig['pricing'];

interface PreviewState {
  recommendation: ClipRecommendation;
  candidate: ClipRecommendationCandidate;
}

const DEFAULT_PRICING: Pricing = { baseCredits: 2750, baseMinutes: 60, extraCreditsPerMinute: 50 };

@Component({
  selector: 'app-clip-recommendations-page',
  imports: [RouterLink, LfIconComponent, LazyVideoFrameDirective],
  templateUrl: './clip-recommendations-page.component.html',
  styleUrl: './clip-recommendations-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' }
})
export class ClipRecommendationsPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly api = inject(ClipRecommendationsService);
  private readonly dashboardApi = inject(DashboardApiService);
  private readonly toastService = inject(ToastService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private hasLoadedOnce = false;
  private readonly completedSeen = new Set<string>();

  private readonly confirmDialog = viewChild<ElementRef<HTMLElement>>('confirmDialog');
  private readonly previewDialog = viewChild<ElementRef<HTMLElement>>('previewDialog');

  readonly streamer = signal('');
  readonly channelID = signal<string | null>(null);
  readonly canManage = signal(false);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly loadingVods = signal(true);
  readonly queueingVodId = signal<string | null>(null);
  readonly savingConfig = signal(false);
  readonly recommendations = signal<ClipRecommendation[]>([]);
  readonly vods = signal<TwitchVodInfo[]>([]);
  readonly autoAnalyzeEnabled = signal(false);
  readonly canAutoAnalyze = signal(false);
  readonly planTier = signal<'free' | 'premium' | 'pro'>('free');
  readonly pricing = signal<Pricing>(DEFAULT_PRICING);
  readonly creditBalance = signal<number | null>(null);
  readonly pendingCandidates = signal<ReadonlySet<string>>(new Set());
  readonly confirmingVod = signal<TwitchVodInfo | null>(null);
  readonly preview = signal<PreviewState | null>(null);
  readonly showRejected = signal<ReadonlySet<string>>(new Set());

  readonly modulesPath = computed(() => ['/', this.streamer(), 'modules']);
  readonly creditsPath = computed(() => ['/', this.streamer(), 'credits']);

  readonly toReviewCount = computed(() =>
    this.recommendations().reduce((sum, item) => sum + this.reviewable(item).length, 0)
  );
  readonly keptCount = computed(() =>
    this.recommendations().reduce(
      (sum, item) => sum + item.candidates.filter((c) => c.status === 'confirmed').length,
      0
    )
  );
  readonly hasProcessingJob = computed(() =>
    this.recommendations().some((item) => this.isRunning(item))
  );

  /** VOD id → newest analysis of it, so the VOD list can say "Analyzed" / "Analyzing…". */
  readonly analysisByVod = computed(() => {
    const map = new Map<string, ClipRecommendation>();
    for (const item of this.recommendations()) {
      if (item.vodID && !map.has(item.vodID)) map.set(item.vodID, item);
    }
    return map;
  });
  readonly vodById = computed(() => new Map(this.vods().map((vod) => [vod.id, vod])));

  constructor() {
    effect(() => {
      const dialog = this.confirmDialog() ?? this.previewDialog();
      if (dialog) queueMicrotask(() => dialog.nativeElement.focus());
    });
  }

  ngOnInit(): void {
    const streamer = (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase();
    this.streamer.set(streamer);
    if (!streamer) {
      this.loading.set(false);
      this.loadingVods.set(false);
      return;
    }

    this.sessionAuth.resolveChannelID(streamer).subscribe((channelID) => {
      this.channelID.set(channelID);
      this.canManage.set(false);
      if (!channelID) {
        this.loading.set(false);
        this.loadingVods.set(false);
        return;
      }
      this.sessionAuth
        .checkPermission(channelID, 'clips:manage')
        .pipe(catchError(() => of(false)))
        .subscribe((allowed) => {
          if (this.channelID() === channelID) this.canManage.set(allowed);
        });
      this.dashboardApi.getAiCredits(channelID).subscribe((response) => {
        const data = response?.data;
        this.creditBalance.set(data?.available ? Math.max(0, Number(data.balance) || 0) : null);
      });
      void Promise.all([this.loadAll(false), this.loadVods(false)]);
      this.startPolling();
    });
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  async refresh(): Promise<void> {
    await Promise.all([this.loadAll(false), this.loadVods(false)]);
  }

  async loadAll(showToast = true): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;
    this.loading.set(true);
    try {
      const [configResponse, listResponse] = await Promise.all([
        firstValueFrom(this.api.getConfig(channelID)),
        firstValueFrom(this.api.list(channelID))
      ]);

      if (configResponse.data) {
        this.autoAnalyzeEnabled.set(configResponse.data.autoAnalyzeEnabled);
        this.canAutoAnalyze.set(configResponse.data.canAutoAnalyze);
        this.planTier.set(configResponse.data.planTier);
        if (configResponse.data.pricing) this.pricing.set(configResponse.data.pricing);
      }

      const items = listResponse.data?.items ?? [];
      this.notifyCompletedJobs(items);
      this.recommendations.set(items);
      this.loadError.set(false);
      if (showToast) {
        this.toastService.success(
          this.t('clipRecommendations.toasts.refreshedTitle'),
          this.t('clipRecommendations.toasts.refreshedMessage')
        );
      }
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
      this.hasLoadedOnce = true;
    }
  }

  async loadVods(showToast = true): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;
    this.loadingVods.set(true);
    try {
      const response = await firstValueFrom(this.api.listVods(channelID, 7));
      this.vods.set(response.data?.vods ?? []);
      if (showToast) {
        this.toastService.success(
          this.t('clipRecommendations.toasts.vodsLoadedTitle'),
          this.t('clipRecommendations.toasts.vodsLoadedMessage', { count: response.data?.vods?.length ?? 0 })
        );
      }
    } catch {
      this.vods.set([]);
      if (showToast) {
        this.toastService.error(
          this.t('clipRecommendations.errors.vodsLoadTitle'),
          this.t('clipRecommendations.errors.vodsLoadMessage')
        );
      }
    } finally {
      this.loadingVods.set(false);
    }
  }

  async toggleAutoAnalyze(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID || !this.canManage() || !this.canAutoAnalyze()) return;
    const nextValue = !this.autoAnalyzeEnabled();
    this.autoAnalyzeEnabled.set(nextValue);
    this.savingConfig.set(true);
    try {
      await firstValueFrom(this.api.updateConfig(channelID, nextValue));
      this.toastService.success(
        this.t('clipRecommendations.toasts.configTitle'),
        nextValue ? this.t('clipRecommendations.v2.autoOnToast') : this.t('clipRecommendations.v2.autoOffToast')
      );
    } catch {
      this.autoAnalyzeEnabled.set(!nextValue);
      this.toastService.error(
        this.t('clipRecommendations.errors.configTitle'),
        this.t('clipRecommendations.errors.configMessage')
      );
    } finally {
      this.savingConfig.set(false);
    }
  }

  askAnalyze(vod: TwitchVodInfo): void {
    if (!this.canManage() || this.queueingVodId()) return;
    this.confirmingVod.set(vod);
  }

  async confirmAnalyze(): Promise<void> {
    const vod = this.confirmingVod();
    const channelID = this.channelID();
    if (!vod || !channelID || !this.canManage()) return;
    this.confirmingVod.set(null);
    this.queueingVodId.set(vod.id);
    try {
      await firstValueFrom(this.api.queue(channelID, vod.id));
      this.toastService.success(
        this.t('clipRecommendations.toasts.queuedTitle'),
        this.t('clipRecommendations.v2.queuedToast')
      );
      await this.loadAll(false);
    } catch (error) {
      const alreadyQueued = error instanceof HttpErrorResponse && error.status === 409;
      this.toastService.error(
        this.t('clipRecommendations.errors.queueTitle'),
        alreadyQueued ? this.t('clipRecommendations.v2.alreadyQueued') : this.t('clipRecommendations.errors.queueMessage')
      );
    } finally {
      if (this.queueingVodId() === vod.id) this.queueingVodId.set(null);
    }
  }

  async setCandidateStatus(
    recommendation: ClipRecommendation,
    candidate: ClipRecommendationCandidate,
    action: 'confirm' | 'deny'
  ): Promise<void> {
    const channelID = this.channelID();
    if (!channelID || !this.canManage() || this.isPending(candidate)) return;
    const next = action === 'confirm' ? 'confirmed' : 'denied';
    const previous = candidate.status;
    this.patchCandidate(recommendation._id, candidate._id, next);
    this.pendingCandidates.update((set) => new Set(set).add(candidate._id));
    try {
      const response = await firstValueFrom(
        this.api.setCandidateStatus(channelID, recommendation._id, candidate._id, action)
      );
      if (response.data) this.replaceRecommendation(response.data);
      this.toastService.success(
        action === 'confirm' ? this.t('clipRecommendations.v2.keptToast') : this.t('clipRecommendations.v2.skippedToast'),
        action === 'confirm' ? this.t('clipRecommendations.v2.keptToastCopy') : this.t('clipRecommendations.v2.skippedToastCopy')
      );
    } catch {
      this.patchCandidate(recommendation._id, candidate._id, previous);
      this.toastService.error(
        this.t('clipRecommendations.errors.actionTitle'),
        this.t('clipRecommendations.errors.actionMessage')
      );
    } finally {
      this.pendingCandidates.update((set) => {
        const copy = new Set(set);
        copy.delete(candidate._id);
        return copy;
      });
    }
  }

  openPreview(recommendation: ClipRecommendation, candidate: ClipRecommendationCandidate): void {
    if (!candidate.previewUrl) return;
    this.preview.set({ recommendation, candidate });
  }

  closePreview(): void {
    this.preview.set(null);
  }

  onEscape(): void {
    if (this.preview()) this.preview.set(null);
    else if (this.confirmingVod()) this.confirmingVod.set(null);
  }

  toggleRejected(recommendationID: string): void {
    this.showRejected.update((set) => {
      const copy = new Set(set);
      if (copy.has(recommendationID)) copy.delete(recommendationID);
      else copy.add(recommendationID);
      return copy;
    });
  }

  // ── View helpers ──────────────────────────────────────────

  isRunning(item: ClipRecommendation): boolean {
    return item.status === 'pending' || item.status === 'processing';
  }

  isPending(candidate: ClipRecommendationCandidate): boolean {
    return this.pendingCandidates().has(candidate._id);
  }

  /** Moments that passed the video check and are waiting for the streamer's decision. */
  reviewable(item: ClipRecommendation): ClipRecommendationCandidate[] {
    return item.candidates.filter(
      (c) => c.videoApproved && c.status !== 'confirmed' && c.status !== 'denied'
    );
  }

  shownCandidates(item: ClipRecommendation): ClipRecommendationCandidate[] {
    const all = this.showRejected().has(item._id);
    return item.candidates
      .filter((c) => all || c.videoApproved)
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds);
  }

  rejectedCount(item: ClipRecommendation): number {
    return item.candidates.filter((c) => !c.videoApproved).length;
  }

  candidateState(candidate: ClipRecommendationCandidate): 'kept' | 'skipped' | 'review' | 'rejected' {
    if (candidate.status === 'confirmed') return 'kept';
    if (candidate.status === 'denied') return 'skipped';
    return candidate.videoApproved ? 'review' : 'rejected';
  }

  analysisTitle(item: ClipRecommendation): string {
    const vod = this.vodById().get(item.vodID);
    return vod?.title?.trim() || this.t('clipRecommendations.v2.streamOn', { date: this.formatDate(item.created_at) });
  }

  analysisThumb(item: ClipRecommendation): string {
    return this.thumb(this.vodById().get(item.vodID)?.thumbnailUrl ?? '');
  }

  /** One plain sentence on where this analysis stands. */
  analysisOutcome(item: ClipRecommendation): string {
    if (item.status === 'pending') return this.t('clipRecommendations.v2.outcome.pending');
    if (item.status === 'processing') return this.t('clipRecommendations.v2.outcome.processing');
    if (item.status === 'failed') return this.failureReason(item);
    const found = item.candidates.filter((c) => c.videoApproved).length;
    if (found === 0) return this.t('clipRecommendations.v2.outcome.none');
    const review = this.reviewable(item).length;
    const kept = item.candidates.filter((c) => c.status === 'confirmed').length;
    const parts = [
      found === 1 ? this.t('clipRecommendations.v2.outcome.foundOne') : this.t('clipRecommendations.v2.outcome.found', { count: found })
    ];
    if (review) parts.push(this.t('clipRecommendations.v2.outcome.toReview', { count: review }));
    if (kept) parts.push(this.t('clipRecommendations.v2.outcome.kept', { count: kept }));
    return parts.join(' · ');
  }

  failureReason(item: ClipRecommendation): string {
    const raw = String(item.errorMessage || '');
    if (/not enough ai credits/i.test(raw)) return this.t('clipRecommendations.v2.fail.credits');
    if (/zero candidates/i.test(raw)) return this.t('clipRecommendations.v2.fail.nothing');
    if (/billing/i.test(raw)) return this.t('clipRecommendations.v2.fail.billing');
    return this.t('clipRecommendations.v2.fail.generic');
  }

  failedForCredits(item: ClipRecommendation): boolean {
    return item.status === 'failed' && /not enough ai credits/i.test(String(item.errorMessage || ''));
  }

  analysisCostLabel(item: ClipRecommendation): string {
    if (item.status !== 'completed' || !item.costCredits) return '';
    return this.t('clipRecommendations.v2.charged', { credits: this.formatNumber(item.costCredits) });
  }

  estimate(minutes: number): number {
    const { baseCredits, baseMinutes, extraCreditsPerMinute } = this.pricing();
    const total = Math.max(1, Math.ceil(Number(minutes || 0)));
    return baseCredits + Math.max(0, total - baseMinutes) * extraCreditsPerMinute;
  }

  canAfford(vod: TwitchVodInfo): boolean {
    const balance = this.creditBalance();
    return balance === null || balance >= this.estimate(vod.durationMinutes);
  }

  vodState(vod: TwitchVodInfo): 'running' | 'done' | 'new' {
    const analysis = this.analysisByVod().get(vod.id);
    if (!analysis || analysis.status === 'failed') return 'new';
    return this.isRunning(analysis) ? 'running' : 'done';
  }

  /** Twitch link that opens the VOD at the moment, where the streamer can make the clip. */
  vodLink(item: ClipRecommendation, candidate: ClipRecommendationCandidate): string {
    const base = item.vodUrl || (item.vodID ? `https://www.twitch.tv/videos/${item.vodID}` : '');
    if (!base) return '';
    const s = Math.max(0, Math.floor(candidate.startSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${base}${base.includes('?') ? '&' : '?'}t=${h}h${m}m${sec}s`;
  }

  thumb(url: string): string {
    return String(url || '')
      .replace('%{width}', '320')
      .replace('%{height}', '180');
  }

  formatDuration(duration: string): string {
    const normalized = String(duration || '').trim();
    if (!normalized) return '';
    const hours = Number(normalized.match(/(\d+)h/)?.[1] || 0);
    const minutes = Number(normalized.match(/(\d+)m/)?.[1] || 0);
    const seconds = Number(normalized.match(/(\d+)s/)?.[1] || 0);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  formatMinutes(total: number): string {
    const minutes = Math.max(0, Math.round(Number(total) || 0));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  formatTimestamp(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  clipLength(candidate: ClipRecommendationCandidate): number {
    return Math.max(1, Math.round(candidate.endSeconds - candidate.startSeconds));
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(this.languageService.getCurrentLanguage() === 'es' ? 'es' : 'en', {
      month: 'short',
      day: 'numeric'
    });
  }

  formatNumber(value: number): string {
    return Math.round(value).toLocaleString(this.languageService.getCurrentLanguage() === 'es' ? 'es' : 'en');
  }

  // ── Internals ─────────────────────────────────────────────

  private patchCandidate(recommendationID: string, candidateID: string, status: ClipRecommendationCandidate['status']): void {
    this.recommendations.update((items) =>
      items.map((item) =>
        item._id !== recommendationID
          ? item
          : { ...item, candidates: item.candidates.map((c) => (c._id === candidateID ? { ...c, status } : c)) }
      )
    );
  }

  private replaceRecommendation(next: ClipRecommendation): void {
    if (!next?._id || !Array.isArray(next.candidates)) return;
    this.recommendations.update((items) => items.map((item) => (item._id === next._id ? next : item)));
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.hasProcessingJob()) void this.loadAll(false);
    }, 30000);
  }

  private notifyCompletedJobs(items: ClipRecommendation[]): void {
    for (const item of items) {
      if (item.status !== 'completed') continue;
      const wasSeen = this.completedSeen.has(item._id);
      this.completedSeen.add(item._id);
      if (this.hasLoadedOnce && !wasSeen) {
        this.toastService.success(
          this.t('clipRecommendations.toasts.completedTitle'),
          this.t('clipRecommendations.toasts.completedMessage', { count: item.approvedCount })
        );
      }
    }
  }
}
