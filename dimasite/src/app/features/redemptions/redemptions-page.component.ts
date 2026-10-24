import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, firstValueFrom, forkJoin, map, of } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { TriggersService } from '../triggers/triggers.service';
import { CreateRewardModalComponent } from './components/create-reward-modal.component';
import {
  PlanTier,
  Redemption,
  RedemptionCreateRequest,
  RedemptionUpdateRequest,
  RewardUpdateResult,
  TwitchRedemption,
} from './redemptions.model';
import { RedemptionsService } from './redemptions.service';

const REFRESH_COOLDOWN_SECONDS = 30;
const SEARCH_THRESHOLD = 6;

@Component({
  selector: 'app-redemptions-page',
  imports: [RouterLink, CreateRewardModalComponent, LfIconComponent],
  styleUrl: './redemptions-page.component.css',
  templateUrl: './redemptions-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onDocumentEscape()',
  },
})
export class RedemptionsPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly redemptionsService = inject(RedemptionsService);
  private readonly triggersService = inject(TriggersService);
  private readonly toastService = inject(ToastService);

  private cooldownTimer: number | null = null;

  readonly streamer = toSignal(
    this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer'))),
    { initialValue: getRouteParam(this.route, 'streamer') },
  );
  readonly channelID = signal<string | null>(null);

  readonly customRedemptions = signal<Redemption[]>([]);
  readonly twitchRedemptions = signal<TwitchRedemption[]>([]);
  /** rewardID -> trigger name, for rewards that play a trigger. */
  readonly triggerByReward = signal<Record<string, string>>({});
  readonly isLoading = signal(true);
  readonly isLoadingTwitch = signal(false);
  readonly loadFailed = signal(false);
  readonly canManage = signal(false);
  readonly permissionLoaded = signal(false);

  readonly refreshCooldown = signal(0);
  /** Ticks every second so "Ready in …" counts down. */
  readonly now = signal(Date.now());
  readonly bulkPausing = signal(false);
  readonly searchQuery = signal('');
  readonly togglingId = signal<string | null>(null);

  readonly isCreateModalOpen = signal(false);
  readonly redemptionToEdit = signal<Redemption | null>(null);
  readonly redemptionToDelete = signal<Redemption | null>(null);
  readonly deleting = signal(false);

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.getPlanTierForStreamer(this.streamer());
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  readonly canEditPremiumFields = computed(() => this.userPlan() !== 'none');

  /** Our rewards with Twitch's live copy merged in (colour, icon, flags DomDimaBot doesn't store). */
  readonly rewards = computed(() => {
    const twitchById = new Map(this.twitchRedemptions().map((reward) => [reward.id, reward]));
    return this.customRedemptions().map((reward) => {
      const live = twitchById.get(reward.rewardID || reward.id);
      if (!live) return reward;
      const cooldown = live.global_cooldown_setting;
      const perStream = live.max_per_stream_setting;
      const perViewer = live.max_per_user_per_stream_setting;
      return {
        ...reward,
        cost: Number.isFinite(live.cost) ? live.cost : reward.cost,
        background_color: live.background_color || reward.background_color,
        userInput: live.is_user_input_required ?? reward.userInput,
        skipQueue: live.should_redemptions_skip_request_queue ?? reward.skipQueue,
        imageUrl: live.image?.url_2x || live.default_image?.url_2x || undefined,
        isPaused: Boolean(live.is_paused),
        cooldown: cooldown ? (cooldown.is_enabled ? cooldown.global_cooldown_seconds : 0) : reward.cooldown,
        maxPerStream: perStream?.is_enabled ? perStream.max_per_stream : 0,
        maxPerUserPerStream: perViewer?.is_enabled ? perViewer.max_per_user_per_stream : 0,
        redeemedThisStream: live.redemptions_redeemed_current_stream ?? null,
        isInStock: live.is_in_stock ?? true,
        cooldownEndsAt: live.cooldown_expires_at ?? null,
      };
    });
  });

  readonly filteredRewards = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return this.rewards();
    return this.rewards().filter(
      (reward) => reward.title.toLowerCase().includes(query) || reward.prompt.toLowerCase().includes(query),
    );
  });

  readonly showSearch = computed(() => this.customRedemptions().length > SEARCH_THRESHOLD);

  /** Rewards made in the Twitch dashboard: Twitch only lets the app that made a reward change it. */
  readonly twitchOnlyRewards = computed(() => {
    const ownIds = new Set(this.customRedemptions().map((reward) => reward.rewardID || reward.id));
    const ownTitles = new Set(this.customRedemptions().map((reward) => reward.title.toLowerCase().trim()));
    return this.twitchRedemptions().filter(
      (reward) => !ownIds.has(reward.id) && !ownTitles.has(reward.title.toLowerCase().trim()),
    );
  });

  readonly enabledCustomCount = computed(() => this.customRedemptions().filter((r) => r.isEnabled).length);

  /** On rewards viewers can redeem right now (for "Pause all"). */
  readonly pausableRewards = computed(() => this.rewards().filter((r) => r.isEnabled && !r.isPaused));
  readonly pausedRewards = computed(() => this.rewards().filter((r) => r.isPaused));

  readonly twitchDashboardUrl = computed(
    () => `https://dashboard.twitch.tv/u/${encodeURIComponent(this.streamer() || '')}/viewer-rewards/channel-points/rewards`,
  );

  readonly deleteTrigger = computed(() => {
    const reward = this.redemptionToDelete();
    return reward ? this.linkedTrigger(reward) : null;
  });

  async ngOnInit(): Promise<void> {
    const routeStreamer = this.streamer() ?? '';
    const resolvedChannelId = routeStreamer
      ? await firstValueFrom(this.sessionAuth.resolveChannelID(routeStreamer))
      : this.sessionAuth.getPrimaryChannelID();

    if (!resolvedChannelId) {
      this.isLoading.set(false);
      this.loadFailed.set(true);
      return;
    }

    this.channelID.set(resolvedChannelId);
    void this.loadPermission(resolvedChannelId);
    this.loadRedemptions(resolvedChannelId);
    // Live state (sold out, cooling down, paused) changes during a stream: always ask Twitch.
    this.loadTwitchRedemptions(resolvedChannelId, true);
    this.loadLinkedTriggers(resolvedChannelId);
    this.startCooldownTimer();
  }

  ngOnDestroy(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  getRedemptionId(redemption: Pick<Redemption, 'id' | 'rewardID' | 'eventsubID' | 'title'>): string {
    return redemption.id || redemption.rewardID || redemption.eventsubID || redemption.title;
  }

  private async loadPermission(channelID: string): Promise<void> {
    try {
      this.canManage.set(await firstValueFrom(this.sessionAuth.checkPermission(channelID, 'rewards:manage')));
    } catch {
      this.canManage.set(false);
    } finally {
      this.permissionLoaded.set(true);
    }
  }

  loadRedemptions(channelId: string, forceRefresh = false): void {
    this.isLoading.set(true);
    this.loadFailed.set(false);

    this.redemptionsService.getRedemptions(channelId, forceRefresh).subscribe({
      next: (redemptions) => {
        this.customRedemptions.set(redemptions);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
        this.loadFailed.set(true);
      },
    });
  }

  loadTwitchRedemptions(channelId: string, forceRefresh = false): void {
    this.isLoadingTwitch.set(true);

    this.redemptionsService.getTwitchRedemptions(channelId, forceRefresh).subscribe({
      next: (redemptions) => {
        this.twitchRedemptions.set(redemptions);
        this.isLoadingTwitch.set(false);
      },
      error: () => {
        this.isLoadingTwitch.set(false);
        this.toastService.error(
          this.t('redemptions.errors.loadTwitchTitle'),
          this.t('redemptions.errors.loadTwitchMessage'),
        );
      },
    });
  }

  /** Optional cross-link; editors without trigger access simply don't see it. */
  private loadLinkedTriggers(channelId: string): void {
    this.triggersService.getTriggers(channelId).subscribe({
      next: (triggers) => {
        const linked: Record<string, string> = {};
        for (const trigger of triggers) {
          if (trigger.rewardID) linked[trigger.rewardID] = trigger.name;
        }
        this.triggerByReward.set(linked);
      },
      error: () => this.triggerByReward.set({}),
    });
  }

  linkedTrigger(reward: Redemption): string | null {
    return this.triggerByReward()[reward.rewardID || reward.id] ?? null;
  }

  refreshAll(): void {
    const channelId = this.channelID();
    if (!channelId || this.refreshCooldown() > 0) return;

    this.loadRedemptions(channelId, true);
    this.loadTwitchRedemptions(channelId, true);
    this.loadLinkedTriggers(channelId);
    this.refreshCooldown.set(REFRESH_COOLDOWN_SECONDS);
  }

  private startCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
    }

    this.cooldownTimer = window.setInterval(() => {
      if (this.refreshCooldown() > 0) this.refreshCooldown.update((v) => Math.max(0, v - 1));
      this.now.set(Date.now());
    }, 1000);
  }

  retry(): void {
    const channelId = this.channelID();
    if (channelId) {
      this.loadRedemptions(channelId, true);
      this.loadTwitchRedemptions(channelId, true);
    }
  }

  openCreateModal(): void {
    if (!this.canManage()) return;
    this.redemptionToEdit.set(null);
    this.isCreateModalOpen.set(true);
  }

  openEditModal(redemption: Redemption): void {
    if (!this.canManage()) return;
    this.redemptionToEdit.set(redemption);
    this.isCreateModalOpen.set(true);
  }

  closeRewardModal(): void {
    this.isCreateModalOpen.set(false);
    this.redemptionToEdit.set(null);
  }

  onRewardModalOpenChange(isOpen: boolean): void {
    this.isCreateModalOpen.set(isOpen);
    if (!isOpen) {
      this.redemptionToEdit.set(null);
    }
  }

  onRewardCreated(data: RedemptionCreateRequest): void {
    if (!this.canManage()) return;
    const channelId = this.channelID();
    if (!channelId) return;

    this.redemptionsService.createRedemption(channelId, data).subscribe({
      next: () => {
        this.loadRedemptions(channelId, true);
        this.loadTwitchRedemptions(channelId, true);
        this.toastService.success(this.t('redemptions.createSuccessTitle'), this.t('redemptions.createSuccessMessage', { title: data.title }));
      },
      error: () => {},
    });
  }

  onRewardUpdated(event: { id: string; data: RedemptionUpdateRequest }): void {
    if (!this.canManage()) return;
    const channelId = this.channelID();
    if (!channelId) return;

    this.redemptionsService.updateRedemption(channelId, event.id, event.data).subscribe({
      next: (result) => {
        this.customRedemptions.update((reds) =>
          reds.map((redemption) =>
            (redemption.rewardID || redemption.id) === event.id ? { ...redemption, ...event.data } : redemption,
          ),
        );
        this.applyTwitchCopy(event.id, result, (reward) => ({
          ...reward,
          background_color: event.data.background_color ?? reward.background_color,
          is_user_input_required: event.data.userInput ?? reward.is_user_input_required,
          should_redemptions_skip_request_queue: event.data.skipQueue ?? reward.should_redemptions_skip_request_queue,
        }));
        this.toastService.success(this.t('redemptions.updateSuccessTitle'), this.t('redemptions.updateSuccessMessage'));
      },
      error: () => {},
    });
  }

  /** Optimistic on/off with rollback. */
  toggleEnabled(redemption: Redemption, input?: HTMLInputElement): void {
    if (!this.canManage() || this.togglingId()) return;
    const channelId = this.channelID();
    if (!channelId) return;
    const rewardId = redemption.rewardID || redemption.id;
    const newValue = !redemption.isEnabled;
    const setEnabled = (value: boolean) =>
      this.customRedemptions.update((reds) =>
        reds.map((r) => ((r.rewardID || r.id) === rewardId ? { ...r, isEnabled: value } : r)),
      );

    setEnabled(newValue);
    this.togglingId.set(rewardId);
    this.redemptionsService.updateRedemptionField(channelId, rewardId, 'isEnabled', newValue).subscribe({
      next: (result) => {
        this.applyTwitchCopy(rewardId, result, (reward) => ({ ...reward, is_enabled: newValue }));
        this.togglingId.set(null);
      },
      error: () => {
        setEnabled(!newValue);
        // The binding may never have seen the optimistic value, so reset the box itself.
        if (input) input.checked = !newValue;
        this.togglingId.set(null);
      },
    });
  }

  /** Twitch's reply is the truth for limits/pause; fall back to a local patch if it didn't send one. */
  private applyTwitchCopy(
    rewardId: string,
    result: RewardUpdateResult,
    fallback: (reward: TwitchRedemption) => TwitchRedemption,
  ): void {
    this.twitchRedemptions.update((reds) =>
      reds.map((reward) => (reward.id === rewardId ? (result.twitch ?? fallback(reward)) : reward)),
    );
  }

  private setPausedLocally(ids: Set<string>, paused: boolean): void {
    this.twitchRedemptions.update((reds) => reds.map((r) => (ids.has(r.id) ? { ...r, is_paused: paused } : r)));
  }

  /** Paused rewards stay on the menu but can't be redeemed. Optimistic with rollback. */
  togglePaused(reward: Redemption): void {
    if (!this.canManage() || this.togglingId() || this.bulkPausing()) return;
    const channelId = this.channelID();
    if (!channelId) return;
    const rewardId = reward.rewardID || reward.id;
    const paused = !reward.isPaused;
    const ids = new Set([rewardId]);

    this.setPausedLocally(ids, paused);
    this.togglingId.set(rewardId);
    this.redemptionsService.updateRedemption(channelId, rewardId, { isPaused: paused }).subscribe({
      next: (result) => {
        this.applyTwitchCopy(rewardId, result, (r) => ({ ...r, is_paused: paused }));
        this.togglingId.set(null);
        this.toastService.success(
          this.t(paused ? 'redemptions.pause.pausedTitle' : 'redemptions.pause.resumedTitle'),
          this.t(paused ? 'redemptions.pause.pausedOne' : 'redemptions.pause.resumedOne', { title: reward.title }),
        );
      },
      error: () => {
        this.setPausedLocally(ids, !paused);
        this.togglingId.set(null);
      },
    });
  }

  /** "Going on a break": pause (or resume) every reward DomDimaBot manages in one go. */
  setAllPaused(paused: boolean): void {
    if (!this.canManage() || this.bulkPausing() || this.togglingId()) return;
    const channelId = this.channelID();
    const targets = paused ? this.pausableRewards() : this.pausedRewards();
    if (!channelId || !targets.length) return;
    const ids = new Set(targets.map((r) => r.rewardID || r.id));

    this.bulkPausing.set(true);
    this.setPausedLocally(ids, paused);
    forkJoin(
      targets.map((reward) => {
        const rewardId = reward.rewardID || reward.id;
        return this.redemptionsService.updateRedemption(channelId, rewardId, { isPaused: paused }, { silent: true }).pipe(
          map((result) => ({ rewardId, result })),
          catchError(() => of({ rewardId, result: null })),
        );
      }),
    ).subscribe((outcomes) => {
      const failed = new Set(outcomes.filter((o) => !o.result).map((o) => o.rewardId));
      for (const outcome of outcomes) {
        if (outcome.result) this.applyTwitchCopy(outcome.rewardId, outcome.result, (r) => ({ ...r, is_paused: paused }));
      }
      if (failed.size) this.setPausedLocally(failed, !paused);
      this.bulkPausing.set(false);

      const done = outcomes.length - failed.size;
      if (failed.size) {
        this.toastService.error(
          this.t('redemptions.errors.saveTitle'),
          this.t(paused ? 'redemptions.pause.someFailedPause' : 'redemptions.pause.someFailedResume', { count: failed.size }),
        );
      }
      if (done) {
        const note = paused && this.twitchOnlyRewards().length ? ` ${this.t('redemptions.pause.twitchOnlyNote')}` : '';
        this.toastService.success(
          this.t(paused ? 'redemptions.pause.pausedTitle' : 'redemptions.pause.resumedTitle'),
          this.t(paused ? 'redemptions.pause.pausedMany' : 'redemptions.pause.resumedMany', { count: done }) + note,
        );
      }
    });
  }

  /** Seconds until the shared cooldown ends (0 = ready). */
  cooldownLeft(reward: Redemption): number {
    if (!reward.cooldownEndsAt) return 0;
    const ends = Date.parse(reward.cooldownEndsAt);
    return Number.isFinite(ends) ? Math.max(0, Math.ceil((ends - this.now()) / 1000)) : 0;
  }

  deleteRedemption(redemption: Redemption): void {
    if (!this.canManage()) return;
    this.redemptionToDelete.set(redemption);
  }

  closeDeleteModal(): void {
    if (this.deleting()) return;
    this.redemptionToDelete.set(null);
  }

  confirmDeleteRedemption(): void {
    if (!this.canManage()) return;
    const redemption = this.redemptionToDelete();
    const channelId = this.channelID();
    if (!redemption || !channelId) {
      this.redemptionToDelete.set(null);
      return;
    }
    const rewardId = redemption.rewardID || redemption.id;

    this.deleting.set(true);
    this.redemptionsService.deleteRedemption(channelId, rewardId).subscribe({
      next: () => {
        this.customRedemptions.update((reds) => reds.filter((r) => (r.rewardID || r.id) !== rewardId));
        this.twitchRedemptions.update((reds) => reds.filter((r) => r.id !== rewardId));
        this.deleting.set(false);
        this.redemptionToDelete.set(null);
        this.toastService.success(this.t('redemptions.deleteSuccessTitle'), this.t('redemptions.deleteSuccessMessage', { title: redemption.title }));
      },
      error: () => {
        this.deleting.set(false);
        this.redemptionToDelete.set(null);
      },
    });
  }

  onDocumentEscape(): void {
    if (this.redemptionToDelete()) {
      this.closeDeleteModal();
    } else if (this.isCreateModalOpen()) {
      this.closeRewardModal();
    }
  }

  formatPoints(cost: number): string {
    return this.t('redemptions.points', { count: Number(cost || 0).toLocaleString(this.languageService.currentLanguage()) });
  }

  formatCooldown(seconds: number): string {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return this.t('redemptions.time.seconds', { n: total });
    if (total < 3600) {
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return rest ? this.t('redemptions.time.minutesSeconds', { m: minutes, s: rest }) : this.t('redemptions.time.minutes', { n: minutes });
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes ? this.t('redemptions.time.hoursMinutes', { h: hours, m: minutes }) : this.t('redemptions.time.hours', { n: hours });
  }

  rewardColor(color: string | undefined): string {
    const value = color?.trim() || '';
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : '#9146ff';
  }

  /** Dark or light icon/text on the reward colour, like Twitch does. */
  rewardInk(color: string | undefined): string {
    let hex = this.rewardColor(color).slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.55 ? '#14151a' : '#ffffff';
  }

  twitchImage(reward: TwitchRedemption): string | null {
    return reward.image?.url_2x || reward.default_image?.url_2x || null;
  }
}
