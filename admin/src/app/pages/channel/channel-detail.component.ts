import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin, catchError, of } from 'rxjs';

import {
  ChannelApiService,
  type AiCreditsData,
  type ChannelOverview,
  type ChannelUser
} from '../../services/channel-api.service';
import { AdminApiService } from '../../services/admin-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-channel-detail',
  templateUrl: './channel-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SkeletonComponent, ConfirmModalComponent]
})
export class ChannelDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly channelApi = inject(ChannelApiService);
  private readonly adminApi = inject(AdminApiService);
  private readonly toast = inject(ToastService);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly overview = signal<ChannelOverview | null>(null);

  // AI credit usage snapshot (used / limit / balance / available) for the details card.
  // null = not yet loaded or fetch failed (render "Not available").
  readonly aiCredits = signal<AiCreditsData | null>(null);

  // Reminder modal state
  readonly showReminderModal = signal(false);
  readonly isSendingReminder = signal(false);

  readonly creditPresets = [25000, 125000, 500000] as const;
  readonly customCreditAmount = signal('');
  readonly creditReason = signal('admin_manual_credit_grant');
  readonly isGrantingCredits = signal(false);

  readonly channelID = computed(() => this.route.snapshot.paramMap.get('channelID') || '');

  readonly infoCards = computed(() => {
    const overview = this.overview();
    const user = overview?.user;
    if (!user) return [];

    return [
      {
        label: 'Plan',
        value: user.plan_tier.toUpperCase(),
        icon: 'plan',
        class: this.getPlanClass(user.plan_tier)
      },
      {
        label: 'Status',
        value: user.isLive ? 'LIVE' : 'OFFLINE',
        subvalue: user.isLive ? `${this.formatNumber(user.liveViewers)} viewers` : undefined,
        icon: user.isLive ? 'live' : 'offline',
        class: user.isLive ? 'info-card--live' : 'info-card--offline'
      },
      {
        label: 'Active',
        value: user.actived ? 'YES' : 'NO',
        icon: user.actived ? 'check' : 'x',
        class: user.actived ? 'info-card--success' : 'info-card--error'
      },
      {
        label: 'Permissions',
        value: user.up_to_date_permissions ? 'OK' : 'UPDATE',
        icon: user.up_to_date_permissions ? 'shield' : 'alert',
        class: user.up_to_date_permissions ? 'info-card--success' : 'info-card--warning'
      }
    ];
  });

  readonly statItems = computed(() => {
    const overview = this.overview();
    if (!overview) return [];

    return [
      { label: 'Commands', value: overview.commandsCount, link: `/channels/${this.channelID()}/commands` },
      { label: 'Eventsubs', value: overview.eventsubsCount, link: `/channels/${this.channelID()}/eventsubs` },
      { label: 'Rewards', value: overview.rewardsCount, link: null },
      { label: 'Triggers', value: overview.triggersCount, link: null },
      { label: 'Timers', value: overview.timersCount, link: null },
      { label: 'Files', value: overview.filesCount, link: null },
      { label: 'Memories', value: overview.memoriesCount, link: null },
    ];
  });

  // --- AI credit usage (Details card) -----------------------------------
  readonly aiCreditsUsed = computed(() => this.aiCredits()?.used ?? 0);
  readonly aiCreditsLimit = computed(() => this.aiCredits()?.limit ?? 0);
  readonly aiCreditsBalance = computed(() => this.aiCredits()?.balance ?? 0);
  readonly aiCreditsAvailable = computed(() => this.aiCredits()?.available ?? false);
  readonly aiCreditsPercent = computed(() => {
    const used = this.aiCreditsUsed();
    const limit = this.aiCreditsLimit();
    if (!limit || limit <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  });
  readonly aiCreditsExhausted = computed(() => {
    const data = this.aiCredits();
    if (!data) return false;
    return data.available && data.balance <= 0;
  });
  readonly aiCreditsLabel = computed(() =>
    `${this.formatCredits(this.aiCreditsUsed())} / ${this.formatCredits(this.aiCreditsLimit())}`
  );
  /**
   * Visual treatment for the credit usage bar, mirrored from the public dashboard:
   * - free  : neutral (no plan tier styling)
   * - premium: subtle gold (purple-tinted)
   * - pro   : stronger gold (amber)
   * Exhausted state is applied on top of the tier style.
   */
  readonly aiCreditsFillClass = computed(() => {
    const tier = this.overview()?.user?.plan_tier ?? 'free';
    if (tier === 'pro') return 'credit-usage__fill credit-usage__fill--pro';
    if (tier === 'premium') return 'credit-usage__fill credit-usage__fill--premium';
    return 'credit-usage__fill';
  });
  readonly aiCreditsItemClass = computed(() => {
    const tier = this.overview()?.user?.plan_tier ?? 'free';
    if (this.aiCreditsExhausted()) return 'detail-item detail-item--credits detail-item--credits-exhausted';
    if (tier === 'pro') return 'detail-item detail-item--credits detail-item--credits-pro';
    if (tier === 'premium') return 'detail-item detail-item--credits detail-item--credits-premium';
    return 'detail-item detail-item--credits';
  });

  ngOnInit(): void {
    this.loadChannelOverview();
  }

  loadChannelOverview(): void {
    const channelID = this.channelID();
    if (!channelID) {
      this.error.set('No channel ID provided');
      this.toast.error('No channel ID provided');
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    this.aiCredits.set(null);

    // Fetch user separately first to ensure we have the channel
    this.channelApi.getChannel(channelID).subscribe({
      next: (user) => {
        if (!user) {
          this.error.set('Channel not found');
          this.toast.error('Channel not found');
          this.isLoading.set(false);
          return;
        }

        // Now fetch the other data
        this.fetchAdditionalData(user);
      },
      error: (err) => {
        this.error.set('Failed to load channel data');
        this.toast.error('Failed to load channel - check console');
        this.isLoading.set(false);
        console.error('Error loading channel:', err);
      }
    });
  }

  private fetchAdditionalData(user: ChannelUser): void {
    const channelID = this.channelID();

    forkJoin({
      commands: this.channelApi.getChannelCommands(channelID, 1, 1).pipe(
        catchError((err) => {
          console.error('Commands API failed:', err);
          this.toast.warning('Failed to load commands count');
          return of({ data: { rows: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 1 } } });
        })
      ),
      eventsubs: this.channelApi.getChannelEventsubs(channelID, 1, 1).pipe(
        catchError((err) => {
          console.error('Eventsubs API failed:', err);
          this.toast.warning('Failed to load eventsubs count');
          return of({ data: { rows: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 1 } } });
        })
      ),
      rewards: this.channelApi.getChannelRewards(channelID).pipe(
        catchError((err) => {
          console.error('Rewards API failed:', err);
          return of({ data: { rewards: [] } });
        })
      ),
      triggers: this.channelApi.getChannelTriggers(channelID).pipe(
        catchError((err) => {
          console.error('Triggers API failed:', err);
          return of({ data: { triggers: [] } });
        })
      ),
      timers: this.channelApi.getChannelTimers(channelID).pipe(
        catchError((err) => {
          console.error('Timers API failed:', err);
          return of({ data: { timers: [] } });
        })
      ),
      files: this.channelApi.getChannelFiles(channelID).pipe(
        catchError((err) => {
          console.error('Files API failed:', err);
          return of({ data: { files: [] } });
        })
      ),
      memories: this.channelApi.getChannelMemories(channelID).pipe(
        catchError((err) => {
          console.error('Memories API failed:', err);
          return of({ data: { memories: [] } });
        })
      ),
      aiCredits: this.channelApi.getChannelAiCredits(channelID).pipe(
        catchError((err) => {
          console.warn('AI credits API failed:', err);
          return of(null);
        })
      ),
    }).subscribe({
      next: (results) => {
        const overview: ChannelOverview = {
          user,
          commandsCount: results.commands.data.pagination.total,
          eventsubsCount: results.eventsubs.data.pagination.total,
          rewardsCount: results.rewards.data.rewards?.length || 0,
          triggersCount: results.triggers.data.triggers?.length || 0,
          timersCount: results.timers.data.timers?.length || 0,
          filesCount: results.files.data.files?.length || 0,
          memoriesCount: results.memories.data.memories?.length || 0,
        };

        this.aiCredits.set(results.aiCredits);
        this.overview.set(overview);
        this.isLoading.set(false);
        this.toast.success(`Loaded channel: ${user.channel}`);
      },
      error: (err) => {
        this.error.set('Failed to load some channel data');
        this.toast.error('Failed to load some channel data');
        this.isLoading.set(false);
        console.error('Error loading additional channel data:', err);
      }
    });
  }

  formatNumber(value: number): string {
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
    return value.toLocaleString();
  }

  formatCredits(value: number): string {
    return this.formatNumber(value).replace('.0', '');
  }

  onCustomCreditInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.customCreditAmount.set(input?.value ?? '');
  }

  onCreditReasonInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.creditReason.set(input?.value ?? '');
  }

  grantPresetCredits(credits: number): void {
    this.grantCredits(credits);
  }

  grantCustomCredits(): void {
    const credits = Math.floor(Number(this.customCreditAmount()));
    this.grantCredits(credits);
  }

  private grantCredits(credits: number): void {
    const channelID = this.channelID();
    if (!channelID || this.isGrantingCredits()) return;

    if (!Number.isFinite(credits) || credits <= 0) {
      this.toast.error('Enter a positive credit amount');
      return;
    }

    this.isGrantingCredits.set(true);
    const reason = this.creditReason().trim() || 'admin_manual_credit_grant';

    this.channelApi.grantAiCredits(channelID, credits, reason).subscribe({
      next: (response) => {
        this.isGrantingCredits.set(false);
        const granted = response.data?.granted ?? credits;
        const after = response.data?.after;
        const suffix = after ? ` New available: ${this.formatCredits(after.balance)}.` : '';
        this.toast.success(`Granted ${this.formatCredits(granted)} AI credits.${suffix}`);
        this.customCreditAmount.set('');
      },
      error: (err) => {
        this.isGrantingCredits.set(false);
        this.toast.error(err?.error?.message || 'Failed to grant AI credits');
      }
    });
  }

  formatDate(date: Date | string | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleDateString();
  }

  getPlanClass(plan: string): string {
    switch (plan) {
      case 'pro': return 'info-card--pro';
      case 'premium': return 'info-card--premium';
      default: return 'info-card--free';
    }
  }

  // --- Send real production activation reminder (admin action) ---
  openSendReminder(): void {
    this.showReminderModal.set(true);
  }

  closeReminderModal(): void {
    if (this.isSendingReminder()) return;
    this.showReminderModal.set(false);
  }

  confirmSendReminder(): void {
    const channelID = this.channelID();
    if (!channelID) return;

    this.isSendingReminder.set(true);

    this.adminApi.sendReminder(channelID).subscribe({
      next: (res) => {
        this.isSendingReminder.set(false);
        this.showReminderModal.set(false);
        const msg = res?.data?.message || 'Reminder sent';
        this.toast.success(msg);
        // Refresh overview to pick up updated reminder_sent_at if backend returns it
        this.loadChannelOverview();
      },
      error: (err) => {
        this.isSendingReminder.set(false);
        const message = err?.error?.message || 'Failed to send reminder';
        this.toast.error(message);
      }
    });
  }

  getReminderSentAt(): string {
    const o = this.overview();
    const raw = o?.user?.reminder_sent_at;
    if (!raw) return '-';
    return this.formatDate(raw as any);
  }

  isUserActive(): boolean {
    return !!this.overview()?.user?.actived;
  }
}
