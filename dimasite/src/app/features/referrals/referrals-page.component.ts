import { ChangeDetectionStrategy, Component, computed, effect, inject, OnDestroy, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { ReferralCodeRecord, ReferralStatsData } from '../../models/referrals.model';
import { LanguageService } from '../../services/language.service';
import { ReferralsApiService } from '../../services/referrals-api.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

@Component({
  selector: 'app-referrals-page',
  imports: [RouterLink],
  templateUrl: './referrals-page.component.html',
  styleUrl: './referrals-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReferralsPageComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly referralsApi = inject(ReferralsApiService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly numberFormatter = new Intl.NumberFormat();
  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  private readonly referralCodePattern = /^[a-z0-9_]{1,16}$/;
  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );
  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({
          streamer,
          channelID: null,
          status: 'idle'
        });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({
          streamer,
          channelID,
          status: 'resolved' as const
        })),
        startWith({
          streamer,
          channelID: null,
          status: 'loading' as const
        })
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
  readonly session = this.sessionAuth.session;
  readonly ownerChannelID = computed(() => this.session()?.appUser.twitch_user_id ?? '');
  readonly ownerLogin = computed(() => (this.session()?.twitchUser.login || '').trim().toLowerCase());
  readonly isOwnerView = computed(() => {
    const streamer = this.streamer().trim().toLowerCase();
    const channelID = this.channelID();
    const ownerChannelID = this.ownerChannelID();
    const ownerLogin = this.ownerLogin();

    if (streamer && ownerLogin && streamer === ownerLogin) {
      return true;
    }

    return Boolean(channelID) && channelID === ownerChannelID;
  });
  readonly planTier = computed(() => {
    const fromStats = this.stats()?.planType;
    if (fromStats === 'PREMIUM') return 'premium' as const;
    if (fromStats === 'PRO') return 'pro' as const;
    const tier = this.session()?.appUser.plan_tier ?? 'free';
    if (tier === 'premium' || tier === 'pro') return tier;
    return 'free' as const;
  });
  readonly stats = signal<ReferralStatsData | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly draftCode = signal('');
  readonly draftLabel = signal('');
  readonly formError = signal<string | null>(null);
  readonly isSubmitting = signal(false);
  readonly isCreateModalOpen = signal(false);
  readonly copiedCodeID = signal<string | null>(null);
  readonly pendingDeleteIDs = signal<string[]>([]);
  readonly hasCodes = computed(() => (this.stats()?.codes.length ?? 0) > 0);
  readonly isAtLimit = computed(() => (this.stats()?.codesRemaining ?? 0) <= 0);
  readonly canSubmit = computed(() => {
    const code = this.normalizedDraftCode();
    return this.isOwnerView() && !this.isSubmitting() && !this.isAtLimit() && this.referralCodePattern.test(code);
  });
  readonly planLabel = computed(() => {
    const planType = this.stats()?.planType;

    if (planType === 'PREMIUM') {
      return this.t('referrals.plan.premium');
    }

    if (planType === 'PRO') {
      return this.t('referrals.plan.pro');
    }

    return this.t('referrals.plan.free');
  });

  private lastLoadedKey = '';
  private copiedResetHandle: number | null = null;

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();

      if (resolution.status === 'idle') {
        this.loading.set(false);
        this.stats.set(null);
        this.errorMessage.set(this.t('referrals.errors.channelNotResolved'));
        this.lastLoadedKey = '';
        return;
      }

      if (resolution.status === 'loading') {
        this.loading.set(true);
        return;
      }

      if (!resolution.channelID) {
        this.loading.set(false);
        this.stats.set(null);
        this.errorMessage.set(this.t('referrals.errors.channelNotResolved'));
        this.lastLoadedKey = '';
        return;
      }

      const loadKey = `${resolution.channelID}:${this.isOwnerView() ? 'owner' : 'admin'}`;
      if (this.lastLoadedKey === loadKey) {
        return;
      }

      this.lastLoadedKey = loadKey;
      void this.loadStats(resolution.channelID);
    });
  }

  ngOnDestroy(): void {
    if (this.copiedResetHandle !== null) {
      window.clearTimeout(this.copiedResetHandle);
      this.copiedResetHandle = null;
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  normalizedDraftCode(): string {
    return this.draftCode().trim().toLowerCase();
  }

  onCodeInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    this.draftCode.set(target.value.replace(/\s+/g, '').toLowerCase());
    this.formError.set(null);
  }

  onLabelInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    this.draftLabel.set(target.value);
    this.formError.set(null);
  }

  openCreateModal(): void {
    if (!this.isOwnerView()) {
      return;
    }

    this.formError.set(null);
    this.isCreateModalOpen.set(true);
  }

  closeCreateModal(): void {
    if (this.isSubmitting()) {
      return;
    }

    this.isCreateModalOpen.set(false);
    this.formError.set(null);
  }

  onCreateModalBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeCreateModal();
    }
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) {
      return;
    }

    await this.loadStats(channelID);
  }

  async createCode(): Promise<void> {
    const channelID = this.channelID();
    const code = this.normalizedDraftCode();
    const label = this.draftLabel().trim();

    if (!channelID || !this.isOwnerView()) {
      this.formError.set(this.t('referrals.errors.ownerOnly'));
      return;
    }

    if (!this.referralCodePattern.test(code)) {
      this.formError.set(this.t('referrals.errors.invalidCode'));
      return;
    }

    if (this.isAtLimit()) {
      this.formError.set(this.t('referrals.errors.limitReached'));
      return;
    }

    this.isSubmitting.set(true);
    this.formError.set(null);

    try {
      const response = await firstValueFrom(this.referralsApi.createCode(channelID, { code, label }));

      if (response.error || !response.data) {
        throw new Error(response.message || this.t('referrals.errors.createFailed'));
      }

      this.draftCode.set('');
      this.draftLabel.set('');
      this.isCreateModalOpen.set(false);
      await this.loadStats(channelID);
      this.toastService.success(
        this.t('referrals.toasts.createdTitle'),
        this.t('referrals.toasts.createdMessage', { code: response.data.code.toUpperCase() })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('referrals.errors.createFailed');
      this.formError.set(message);
      this.toastService.error(this.t('referrals.toasts.errorTitle'), message);
    } finally {
      this.isSubmitting.set(false);
    }
  }

  async deleteCode(record: ReferralCodeRecord): Promise<void> {
    const channelID = this.channelID();

    if (!channelID || !this.isOwnerView() || this.isDeleting(record._id)) {
      return;
    }

    const confirmed = window.confirm(
      this.t('referrals.actions.deleteConfirm', { code: record.code.toUpperCase() })
    );

    if (!confirmed) {
      return;
    }

    this.pendingDeleteIDs.update((ids) => [...ids, record._id]);

    try {
      const response = await firstValueFrom(this.referralsApi.deleteCode(channelID, record._id));

      if (response.error) {
        throw new Error(response.message || this.t('referrals.errors.deleteFailed'));
      }

      await this.loadStats(channelID);
      this.toastService.success(
        this.t('referrals.toasts.deletedTitle'),
        this.t('referrals.toasts.deletedMessage', { code: record.code.toUpperCase() })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('referrals.errors.deleteFailed');
      this.toastService.error(this.t('referrals.toasts.errorTitle'), message);
    } finally {
      this.pendingDeleteIDs.update((ids) => ids.filter((id) => id !== record._id));
    }
  }

  isDeleting(codeId: string): boolean {
    return this.pendingDeleteIDs().includes(codeId);
  }

  formatNumber(value: number): string {
    return this.numberFormatter.format(Math.max(0, Math.round(value)));
  }

  formatDate(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return this.t('common.notAvailable');
    }

    return this.dateFormatter.format(parsed);
  }

  cardDisplayName(record: ReferralCodeRecord): string {
    return record.label.trim() || record.code.toUpperCase();
  }

  isCopied(record: ReferralCodeRecord): boolean {
    return this.copiedCodeID() === record._id;
  }

  async copyReferralLink(record: ReferralCodeRecord): Promise<void> {
    const referralUrl = `https://domdimabot.com/r/${record.code.toLowerCase()}`;

    try {
      await this.writeTextToClipboard(referralUrl);
      this.copiedCodeID.set(record._id);

      if (this.copiedResetHandle !== null) {
        window.clearTimeout(this.copiedResetHandle);
      }

      this.copiedResetHandle = window.setTimeout(() => {
        this.copiedCodeID.set(null);
        this.copiedResetHandle = null;
      }, 1800);

      this.toastService.success(
        this.t('referrals.toasts.copiedTitle'),
        this.t('referrals.toasts.copiedMessage', { code: record.code.toUpperCase() })
      );
    } catch {
      this.toastService.error(this.t('referrals.toasts.errorTitle'), this.t('referrals.errors.copyFailed'));
    }
  }

  cardHue(record: ReferralCodeRecord): number {
    const seed = `${record.label.trim().toLowerCase()}::${record.code.trim().toLowerCase()}`;
    let hash = 0;

    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }

    return hash % 360;
  }

  private async loadStats(channelID: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(this.referralsApi.getStats(channelID));

      if (response.error || !response.data) {
        throw new Error(response.message || this.t('referrals.errors.loadFailed'));
      }

      this.stats.set(response.data);
      this.formError.set(null);
    } catch (error) {
      this.stats.set(null);
      this.errorMessage.set(error instanceof Error ? error.message : this.t('referrals.errors.loadFailed'));
    } finally {
      this.loading.set(false);
    }
  }

  private async writeTextToClipboard(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.setAttribute('readonly', 'true');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    document.body.appendChild(textArea);
    textArea.select();

    const copied = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (!copied) {
      throw new Error('Clipboard copy failed');
    }
  }
}
