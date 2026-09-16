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
import { firstValueFrom, map } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { CreateRewardModalComponent } from './components/create-reward-modal.component';
import {
  PlanTier,
  Redemption,
  RedemptionCreateRequest,
  RedemptionUpdateRequest,
  TwitchRedemption,
} from './redemptions.model';
import { RedemptionsService } from './redemptions.service';

@Component({
  selector: 'app-redemptions-page',
  imports: [RouterLink, CreateRewardModalComponent, ConfirmationModalComponent],
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
  private readonly toastService = inject(ToastService);

  private cooldownTimer: number | null = null;

  readonly streamer = toSignal(
    this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer'))),
    { initialValue: getRouteParam(this.route, 'streamer') },
  );
  readonly channelID = signal<string | null>(null);

  readonly customRedemptions = signal<Redemption[]>([]);
  readonly twitchRedemptions = signal<TwitchRedemption[]>([]);
  readonly isLoading = signal(true);
  readonly isLoadingTwitch = signal(false);

  readonly refreshCooldown = signal(0);
  readonly twitchRefreshCooldown = signal(0);

  readonly isCreateModalOpen = signal(false);
  readonly redemptionToEdit = signal<Redemption | null>(null);
  readonly showDeleteModal = signal(false);
  readonly redemptionToDelete = signal<Redemption | null>(null);

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.session()?.appUser?.plan_tier ?? 'free';
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  readonly canEditPremiumFields = computed(() => this.userPlan() !== 'none');

  readonly uniqueTwitchRedemptions = computed(() => {
    const customTitles = new Set(
      this.customRedemptions()
        .map((redemption) => redemption.title.toLowerCase().trim())
        .filter((title) => title.length > 0),
    );

    return this.twitchRedemptions().filter(
      (redemption) => !customTitles.has(redemption.title.toLowerCase().trim()),
    );
  });

  readonly enabledCustomCount = computed(
    () => this.customRedemptions().filter((r) => r.isEnabled).length,
  );

  readonly deleteModalMessage = computed(() => {
    const redemption = this.redemptionToDelete();
    return redemption
      ? this.t('redemptions.deleteConfirmation', { title: redemption.title })
      : this.t('redemptions.deleteFallback');
  });

  async ngOnInit(): Promise<void> {
    const routeStreamer = this.streamer() ?? '';
    const resolvedChannelId = routeStreamer
      ? await firstValueFrom(this.sessionAuth.resolveChannelID(routeStreamer))
      : this.sessionAuth.getPrimaryChannelID();

    if (!resolvedChannelId) {
      this.isLoading.set(false);
      this.toastService.error(this.t('redemptions.errors.loadTitle'), this.t('redemptions.errors.loadMessage'));
      return;
    }

    this.channelID.set(resolvedChannelId);
    this.loadRedemptions(resolvedChannelId);
    this.loadTwitchRedemptions(resolvedChannelId);
    this.startCooldownTimers();
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

  loadRedemptions(channelId: string, forceRefresh = false): void {
    this.isLoading.set(true);

    this.redemptionsService.getRedemptions(channelId, forceRefresh).subscribe({
      next: (redemptions) => {
        this.customRedemptions.set(redemptions);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
        this.toastService.error(this.t('redemptions.errors.loadTitle'), this.t('redemptions.errors.loadMessage'));
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

  refreshAll(): void {
    if (this.refreshCooldown() > 0) {
      this.toastService.warning(
        this.t('redemptions.cooldownTitle'),
        this.t('redemptions.cooldownMessage', { seconds: this.refreshCooldown() }),
      );
      return;
    }

    const channelId = this.channelID();
    if (!channelId) return;

    this.loadRedemptions(channelId, true);
    this.loadTwitchRedemptions(channelId, true);
    this.refreshCooldown.set(30);
    this.twitchRefreshCooldown.set(30);

    this.toastService.success(this.t('redemptions.refreshSuccessTitle'), this.t('redemptions.refreshSuccessMessage'));
  }

  refreshTwitch(): void {
    if (this.twitchRefreshCooldown() > 0) {
      this.toastService.warning(
        this.t('redemptions.cooldownTitle'),
        this.t('redemptions.cooldownMessage', { seconds: this.twitchRefreshCooldown() }),
      );
      return;
    }

    const channelId = this.channelID();
    if (!channelId) return;

    this.loadTwitchRedemptions(channelId, true);
    this.twitchRefreshCooldown.set(30);

    this.toastService.success(this.t('redemptions.refreshSuccessTitle'), this.t('redemptions.refreshSuccessMessage'));
  }

  private startCooldownTimers(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
    }

    this.cooldownTimer = window.setInterval(() => {
      this.refreshCooldown.update((v) => Math.max(0, v - 1));
      this.twitchRefreshCooldown.update((v) => Math.max(0, v - 1));
    }, 1000);
  }

  openCreateModal(): void {
    this.redemptionToEdit.set(null);
    this.isCreateModalOpen.set(true);
  }

  openEditModal(redemption: Redemption): void {
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
    const channelId = this.channelID();
    if (!channelId) return;

    this.redemptionsService.createRedemption(channelId, data).subscribe({
      next: () => {
        this.loadRedemptions(channelId, true);
        this.toastService.success(this.t('redemptions.createSuccessTitle'), this.t('redemptions.createSuccessMessage'));
      },
      error: () => {},
    });
  }

  onRewardUpdated(event: { id: string; data: RedemptionUpdateRequest }): void {
    const channelId = this.channelID();
    if (!channelId) return;

    this.redemptionsService.updateRedemption(channelId, event.id, event.data).subscribe({
      next: () => {
        this.customRedemptions.update((reds) =>
          reds.map((redemption) =>
            this.getRedemptionId(redemption) === event.id ||
            redemption.rewardID === event.id ||
            redemption.id === event.id
              ? { ...redemption, ...event.data }
              : redemption,
          ),
        );
        this.toastService.success(this.t('redemptions.updateSuccessTitle'), this.t('redemptions.updateSuccessMessage'));
      },
      error: () => {},
    });
  }

  toggleEnabled(redemption: Redemption): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const redemptionId = this.getRedemptionId(redemption);

    const newValue = !redemption.isEnabled;

    this.redemptionsService
      .updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'isEnabled', newValue)
      .subscribe({
        next: () => {
          this.customRedemptions.update((reds) =>
            reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, isEnabled: newValue } : r)),
          );
          const title = newValue ? this.t('redemptions.enabledTitle') : this.t('redemptions.disabledTitle');
          const message = newValue ? this.t('redemptions.enabledMessage') : this.t('redemptions.disabledMessage');
          this.toastService.success(title, message);
        },
        error: () => {},
      });
  }

  deleteRedemption(redemption: Redemption): void {
    this.redemptionToDelete.set(redemption);
    this.showDeleteModal.set(true);
  }

  closeDeleteModal(): void {
    this.showDeleteModal.set(false);
    this.redemptionToDelete.set(null);
  }

  confirmDeleteRedemption(): void {
    const redemption = this.redemptionToDelete();
    if (!redemption) {
      this.closeDeleteModal();
      return;
    }

    const channelId = this.channelID();
    if (!channelId) {
      this.closeDeleteModal();
      return;
    }
    const redemptionId = this.getRedemptionId(redemption);

    this.redemptionsService.deleteRedemption(channelId, redemption.rewardID || redemption.id).subscribe({
      next: () => {
        this.customRedemptions.update((reds) => reds.filter((r) => this.getRedemptionId(r) !== redemptionId));
        this.closeDeleteModal();
        this.toastService.success(this.t('redemptions.deleteSuccessTitle'), this.t('redemptions.deleteSuccessMessage'));
      },
      error: () => {
        this.closeDeleteModal();
      },
    });
  }

  onDocumentEscape(): void {
    if (this.isCreateModalOpen()) {
      this.closeRewardModal();
    }
  }

  getCardColor(redemption: Redemption): string {
    const color = redemption.background_color?.trim();
    if (!color) return '#6366f1';

    const hexPattern = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    const rgbPattern = /^rgb\((\s*\d+\s*,){2}\s*\d+\s*\)$/;
    const rgbaPattern = /^rgba\((\s*\d+\s*,){3}\s*(0|0?\.\d+|1)\s*\)$/;

    return hexPattern.test(color) || rgbPattern.test(color) || rgbaPattern.test(color) ? color : '#6366f1';
  }
}
