import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowLeft,
  Calendar,
  Check,
  Clock,
  Clapperboard,
  Loader,
  LucideAngularModule,
  Play,
  RefreshCw,
  Sparkles,
  X,
  Zap
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { LoadingIndicatorComponent } from '../../components/loading';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { ClipRecommendation, ClipRecommendationCandidate, TwitchVodInfo } from './clip-recommendations.model';
import { ClipRecommendationsService } from './clip-recommendations.service';

@Component({
  selector: 'app-clip-recommendations-page',
  imports: [RouterLink, DatePipe, DecimalPipe, LucideAngularModule, LoadingIndicatorComponent],
  templateUrl: './clip-recommendations-page.component.html',
  styleUrl: './clip-recommendations-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipRecommendationsPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly api = inject(ClipRecommendationsService);
  private readonly toastService = inject(ToastService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private hasLoadedOnce = false;
  private readonly completedSeen = new Set<string>();
  /** VODs currently queued for analysis (by vodId) — local only, cleared on successful queue. */
  private readonly queuedVodIds = new Set<string>();

  readonly sparklesIcon = Sparkles;
  readonly arrowLeftIcon = ArrowLeft;
  readonly videoIcon = Clapperboard;
  readonly refreshIcon = RefreshCw;
  readonly clockIcon = Clock;
  readonly checkIcon = Check;
  readonly xIcon = X;
  readonly calendarIcon = Calendar;
  readonly playIcon = Play;
  readonly loaderIcon = Loader;
  readonly zapIcon = Zap;

  readonly streamer = signal('');
  readonly channelID = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadingVods = signal(true);
  readonly queueingVodId = signal<string | null>(null);
  readonly savingConfig = signal(false);
  readonly recommendations = signal<ClipRecommendation[]>([]);
  readonly vods = signal<TwitchVodInfo[]>([]);
  readonly total = signal(0);
  readonly autoAnalyzeEnabled = signal(false);
  readonly canAutoAnalyze = signal(false);
  readonly planTier = signal<'free' | 'premium' | 'pro'>('free');

  readonly approvedCandidates = computed(() =>
    this.recommendations().flatMap((item) => item.candidates.filter((candidate) => candidate.videoApproved))
  );

  readonly hasProcessingJob = computed(() =>
    this.recommendations().some((item) => item.status === 'pending' || item.status === 'processing')
  );

  readonly hasVods = computed(() => this.vods().length > 0);
  readonly hasRecommendations = computed(() => this.recommendations().length > 0);

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
      if (channelID) {
        void Promise.all([this.loadAll(false), this.loadVods(false)]);
        this.startPolling();
      } else {
        this.loading.set(false);
        this.loadingVods.set(false);
      }
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
      }

      const items = listResponse.data?.items ?? [];
      this.notifyCompletedJobs(items);
      this.recommendations.set(items);
      this.total.set(listResponse.data?.total ?? 0);
      if (showToast) {
        this.toastService.success(this.t('clipRecommendations.toasts.refreshedTitle'), this.t('clipRecommendations.toasts.refreshedMessage'));
      }
    } catch {
      this.toastService.error(this.t('clipRecommendations.errors.loadTitle'), this.t('clipRecommendations.errors.loadMessage'));
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
        this.toastService.error(this.t('clipRecommendations.errors.vodsLoadTitle'), this.t('clipRecommendations.errors.vodsLoadMessage'));
      }
    } finally {
      this.loadingVods.set(false);
    }
  }

  async toggleAutoAnalyze(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID || !this.canAutoAnalyze()) return;
    const nextValue = !this.autoAnalyzeEnabled();
    this.savingConfig.set(true);
    try {
      await firstValueFrom(this.api.updateConfig(channelID, nextValue));
      this.autoAnalyzeEnabled.set(nextValue);
      this.toastService.success(this.t('clipRecommendations.toasts.configTitle'), this.t('clipRecommendations.toasts.configMessage'));
    } catch {
      this.toastService.error(this.t('clipRecommendations.errors.configTitle'), this.t('clipRecommendations.errors.configMessage'));
    } finally {
      this.savingConfig.set(false);
    }
  }

  async queueAnalysis(vod: TwitchVodInfo): Promise<void> {
    const channelID = this.channelID();
    if (!channelID || !vod?.id || this.queueingVodId() === vod.id) return;
    this.queuedVodIds.add(vod.id);
    this.queueingVodId.set(vod.id);
    try {
      const response = await firstValueFrom(this.api.queue(channelID, vod.id));
      this.toastService.success(
        this.t('clipRecommendations.toasts.queuedTitle'),
        this.t('clipRecommendations.toasts.queuedMessage', {
          title: this.truncate(vod.title, 48),
          credits: response.data?.estimatedCostCredits ?? 2500
        })
      );
      await Promise.all([this.loadAll(false), this.loadVods(false)]);
    } catch {
      this.toastService.error(this.t('clipRecommendations.errors.queueTitle'), this.t('clipRecommendations.errors.queueMessage'));
    } finally {
      this.queuedVodIds.delete(vod.id);
      // Keep last highlight for a moment so the button visibly settles.
      if (this.queueingVodId() === vod.id) {
        this.queueingVodId.set(null);
      }
    }
  }

  async setCandidateStatus(recommendationID: string, candidateID: string, action: 'confirm' | 'deny'): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;
    try {
      await firstValueFrom(this.api.setCandidateStatus(channelID, recommendationID, candidateID, action));
      this.toastService.success(
        action === 'confirm' ? this.t('clipRecommendations.toasts.confirmedTitle') : this.t('clipRecommendations.toasts.deniedTitle'),
        action === 'confirm' ? this.t('clipRecommendations.toasts.confirmedMessage') : this.t('clipRecommendations.toasts.deniedMessage')
      );
      await this.loadAll(false);
    } catch {
      this.toastService.error(this.t('clipRecommendations.errors.actionTitle'), this.t('clipRecommendations.errors.actionMessage'));
    }
  }

  isQueued(vod: TwitchVodInfo): boolean {
    return this.queuedVodIds.has(vod.id);
  }

  formatDurationLabel(duration: string): string {
    const normalized = String(duration || '').trim();
    if (!normalized) return '';
    // Twitch returns durations like "2h34m22s" — prettify for display.
    const hours = Number(normalized.match(/(\d+)h/)?.[1] || 0);
    const minutes = Number(normalized.match(/(\d+)m/)?.[1] || 0);
    const seconds = Number(normalized.match(/(\d+)s/)?.[1] || 0);
    if (hours > 0) {
      return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
  }

  formatTimestamp(seconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  trackRecommendation(_index: number, item: ClipRecommendation): string {
    return item._id;
  }

  trackCandidate(_index: number, item: ClipRecommendationCandidate): string {
    return item._id;
  }

  trackVod(_index: number, item: TwitchVodInfo): string {
    return item.id;
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.hasProcessingJob()) {
        void this.loadAll(false);
      }
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

  private truncate(value: string, max = 60): string {
    const trimmed = String(value || '').trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}\u2026` : trimmed;
  }
}