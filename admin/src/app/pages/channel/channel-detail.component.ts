import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, catchError, of } from 'rxjs';

import {
  ChannelApiService,
  type AiCreditsData,
  type ChannelOverview,
} from '../../services/channel-api.service';
import { AdminApiService } from '../../services/admin-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { PetDiagnosticsComponent } from './pet-diagnostics.component';
import { ChannelWorkspaceService } from './channel-workspace.service';
import { ChannelDayStatsComponent } from './channel-day-stats.component';

/** The grant endpoint rejects anything above this (MAX_AI_CREDIT_GRANT). */
const MAX_GRANT = 5_000_000;

interface HealthIssue {
  key: string;
  tone: 'warn' | 'live';
  title: string;
  text: string;
}

@Component({
  selector: 'app-channel-detail',
  templateUrl: './channel-detail.component.html',
  styleUrls: ['./channel-page.component.css', './channel-detail.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SkeletonComponent, ConfirmModalComponent, IconComponent, PetDiagnosticsComponent, ChannelDayStatsComponent],
})
export class ChannelDetailComponent implements OnInit {
  private readonly ws = inject(ChannelWorkspaceService);
  private readonly channelApi = inject(ChannelApiService);
  private readonly adminApi = inject(AdminApiService);
  private readonly toast = inject(ToastService);

  readonly countsLoading = signal(true);
  readonly error = signal<string | null>(null);
  /** Counts of what they have set up; the channel itself comes from the workspace frame. */
  private readonly counts = signal<Omit<ChannelOverview, 'user'> | null>(null);
  readonly overview = computed<ChannelOverview | null>(() => {
    const user = this.ws.user();
    const counts = this.counts();
    return user && counts ? { user, ...counts } : null;
  });
  readonly isLoading = computed(() => this.countsLoading() || !this.ws.user());

  // AI credit usage snapshot (used / limit / balance / available) for the details card.
  // null = not yet loaded or fetch failed (render "Not available").
  readonly aiCredits = signal<AiCreditsData | null>(null);

  // Reminder modal state
  readonly showReminderModal = signal(false);
  readonly isSendingReminder = signal(false);

  readonly creditPresets = [25000, 200000, 800000] as const;
  readonly customCreditAmount = signal('');
  readonly creditReason = signal('');
  readonly announceInChat = signal(true);
  readonly isGrantingCredits = signal(false);
  // Granting is a two-step flow: pick the amount, then confirm in the dialog.
  readonly grantOpen = signal(false);
  readonly grantPreset = signal<number | null>(200000);
  readonly grantSubmitAttempted = signal(false);
  readonly grantAmount = computed(() => {
    const preset = this.grantPreset();
    if (preset !== null) return preset;
    const custom = Math.floor(Number(this.customCreditAmount()));
    return Number.isFinite(custom) ? custom : 0;
  });
  readonly grantError = computed(() => {
    const amount = this.grantAmount();
    if (amount <= 0) return 'Enter how many credits to add.';
    if (amount > MAX_GRANT) return `You can add up to ${this.formatExact(MAX_GRANT)} credits at once.`;
    return null;
  });

  readonly channelID = this.ws.channelID;

  /** What's wrong with this channel, in plain words, with the consequence. */
  readonly issues = computed<HealthIssue[]>(() => {
    const user = this.overview()?.user;
    if (!user) return [];
    const issues: HealthIssue[] = [];
    if (!user.actived) {
      issues.push({
        key: 'bot',
        tone: 'warn',
        title: "Bot isn't active",
        text: "They haven't finished setup, so the bot isn't in their channel. A reminder email walks them through it.",
      });
    }
    if (!user.has_permissions) {
      issues.push({
        key: 'access',
        tone: 'live',
        title: 'No Twitch access',
        text: 'The bot has no Twitch permissions for this channel. They need to sign in on domdimabot.com.',
      });
    } else if (!user.up_to_date_permissions) {
      issues.push({
        key: 'access',
        tone: 'warn',
        title: 'Twitch access is out of date',
        text: 'Some features need newer Twitch permissions. Ask them to sign in again on domdimabot.com.',
      });
    }
    if (!user.chat_enabled) {
      issues.push({
        key: 'chat',
        tone: 'warn',
        title: 'Chat messages are off',
        text: "The bot won't post alerts or replies in their chat.",
      });
    }
    if (this.aiCreditsExhausted()) {
      issues.push({
        key: 'credits',
        tone: 'live',
        title: 'Out of AI credits',
        text: 'AI replies and paid voices are paused until credits refill or you grant more.',
      });
    }
    return issues;
  });

  readonly statItems = computed(() => {
    const overview = this.overview();
    if (!overview) return [];
    const id = this.channelID();
    const user = overview.user;
    return [
      {
        label: 'Commands',
        value: overview.commandsCount,
        icon: 'command',
        meta: 'Chat commands and their access levels',
        link: `/channels/${id}/commands`,
      },
      {
        label: 'Twitch events',
        value: overview.eventsubsCount,
        icon: 'bolt',
        meta:
          user.eventsubsDisabledCount > 0
            ? `${user.eventsubsDisabledCount} turned off · connect or test events`
            : 'Follows, subs, raids… connect or test them',
        link: `/channels/${id}/eventsubs`,
      },
      { label: 'Rewards', value: overview.rewardsCount, icon: 'gift', meta: 'Channel point rewards', link: null },
      { label: 'Triggers', value: overview.triggersCount, icon: 'play', meta: 'Sounds and videos viewers can play', link: null },
      { label: 'Timers', value: overview.timersCount, icon: 'timer', meta: 'Repeating chat messages', link: null },
      { label: 'Files', value: overview.filesCount, icon: 'image', meta: 'Uploaded media', link: null },
      { label: 'Memories', value: overview.memoriesCount, icon: 'sparkles', meta: 'What the AI remembers', link: null },
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
  readonly aiCreditsLabel = computed(
    () =>
      `${this.formatCredits(this.aiCreditsUsed())} / ${this.formatCredits(this.aiCreditsLimit())}`,
  );
  readonly planTier = computed(() => this.overview()?.user?.plan_tier ?? 'free');
  /** Can't grant without a billing (Polar) account; null credits = unknown, so allow it. */
  readonly canGrant = computed(() => {
    const credits = this.aiCredits();
    return !credits || credits.available;
  });

  ngOnInit(): void {
    this.loadChannelOverview();
  }

  loadChannelOverview(): void {
    const channelID = this.channelID();
    if (!channelID) return;

    this.countsLoading.set(true);
    this.error.set(null);
    this.aiCredits.set(null);

    forkJoin({
      commands: this.channelApi.getChannelCommands(channelID, 1, 1).pipe(
        catchError((err) => {
          console.error('Commands API failed:', err);
          this.toast.warning('Failed to load commands count');
          return of({
            data: { rows: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 1 } },
          });
        }),
      ),
      eventsubs: this.channelApi.getChannelEventsubs(channelID, 1, 1).pipe(
        catchError((err) => {
          console.error('Eventsubs API failed:', err);
          this.toast.warning('Failed to load eventsubs count');
          return of({
            data: { rows: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 1 } },
          });
        }),
      ),
      rewards: this.channelApi.getChannelRewards(channelID).pipe(catchError(() => of({ data: { rewards: [] } }))),
      triggers: this.channelApi.getChannelTriggers(channelID).pipe(catchError(() => of({ data: { triggers: [] } }))),
      timers: this.channelApi.getChannelTimers(channelID).pipe(catchError(() => of({ data: { timers: [] } }))),
      files: this.channelApi.getChannelFiles(channelID).pipe(catchError(() => of({ data: { files: [] } }))),
      memories: this.channelApi.getChannelMemories(channelID).pipe(catchError(() => of({ data: { memories: [] } }))),
      aiCredits: this.channelApi.getChannelAiCredits(channelID).pipe(
        catchError((err) => {
          console.warn('AI credits API failed:', err);
          return of(null);
        }),
      ),
    }).subscribe({
      next: (results) => {
        this.counts.set({
          commandsCount: results.commands.data.pagination.total,
          eventsubsCount: results.eventsubs.data.pagination.total,
          rewardsCount: results.rewards.data.rewards?.length || 0,
          triggersCount: results.triggers.data.triggers?.length || 0,
          timersCount: results.timers.data.timers?.length || 0,
          filesCount: results.files.data.files?.length || 0,
          memoriesCount: results.memories.data.memories?.length || 0,
        });
        this.aiCredits.set(results.aiCredits);
        this.countsLoading.set(false);
      },
      error: (err) => {
        this.error.set("Couldn't load this channel's details. Check your connection and try again.");
        this.countsLoading.set(false);
        console.error('Error loading channel details:', err);
      },
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

  formatExact(value: number): string {
    return Math.round(value).toLocaleString('en-US');
  }

  onCustomCreditInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.customCreditAmount.set(input?.value ?? '');
    this.grantPreset.set(null);
  }

  onCreditReasonInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.creditReason.set(input?.value ?? '');
  }

  selectPreset(credits: number): void {
    this.grantPreset.set(credits);
    this.customCreditAmount.set('');
  }

  openGrant(): void {
    this.grantSubmitAttempted.set(false);
    this.announceInChat.set(true);
    this.grantOpen.set(true);
  }

  closeGrant(): void {
    if (this.isGrantingCredits()) return;
    this.grantOpen.set(false);
  }

  confirmGrant(): void {
    this.grantSubmitAttempted.set(true);
    if (this.grantError()) return;
    this.grantCredits(this.grantAmount());
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

    this.channelApi.grantAiCredits(channelID, credits, reason, this.announceInChat()).subscribe({
      next: (response) => {
        this.isGrantingCredits.set(false);
        const granted = response.data?.granted ?? credits;
        const after = response.data?.after;
        if (after) {
          const current = this.aiCredits();
          this.aiCredits.set({
            ...(current ?? { version: 1, meterId: '', updatedAt: new Date().toISOString() }),
            used: after.used,
            limit: after.limit,
            balance: after.balance,
            available: true,
          } as AiCreditsData);
        }
        const suffix = after ? ` They now have ${this.formatCredits(after.balance)} left.` : '';
        const announcement = response.data?.chatAnnouncement;
        if (announcement === 'failed') {
          this.toast.warning(`Added ${this.formatCredits(granted)} AI credits.${suffix} Chat announcement failed. Do not repeat the grant.`, 10000);
        } else {
          const chatSuffix = announcement === 'sent' ? ' Announced in chat.' : announcement === 'skipped' ? ' No chat message sent.' : '';
          this.toast.success(`Added ${this.formatCredits(granted)} AI credits.${suffix}${chatSuffix}`);
        }
        this.customCreditAmount.set('');
        this.creditReason.set('');
        this.grantPreset.set(200000);
        this.grantOpen.set(false);
      },
      error: (err) => {
        this.isGrantingCredits.set(false);
        this.toast.error(err?.error?.message || "Couldn't add AI credits");
      },
    });
  }

  async copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.toast.success(`Copied ${label}`);
    } catch {
      this.toast.error('Could not copy — select it and copy manually');
    }
  }

  formatDate(date: Date | string | undefined): string {
    if (!date) return '—';
    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
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
        // Refresh the channel quietly to pick up the new reminder_sent_at (the header stays).
        this.ws.load(true);
      },
      error: (err) => {
        this.isSendingReminder.set(false);
        const message = err?.error?.message || 'Failed to send reminder';
        this.toast.error(message);
      },
    });
  }

  getReminderSentAt(): string {
    const o = this.overview();
    const raw = o?.user?.reminder_sent_at;
    if (!raw) return 'Never';
    return this.formatDate(raw as Date);
  }

  isUserActive(): boolean {
    return !!this.overview()?.user?.actived;
  }
}
