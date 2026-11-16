import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { IconComponent } from '../../shared/icon/icon.component';
import { environment } from '../../../environments/environment';

import { SessionAuthService } from '../../services/session-auth.service';
import {
  AdminApiService,
  type AdminUserRow,
  type AdminUsersSummary,
} from '../../services/admin-api.service';
import { OverviewApiService, type AdminOverview, type AttentionKey } from '../../services/overview-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { FeedListComponent } from '../../shared/feed/feed-list.component';
import { clockTime, formatCompact, formatNumber, plural } from '../../shared/format';
import { OvDayComponent } from './ov-day.component';
import { OvSpendComponent } from './ov-spend.component';
import { OvTrendComponent } from './ov-trend.component';
import { OvChannelsComponent } from './ov-channels.component';

interface SiteAnalyticsSnapshot {
  registeredUsers: number;
  liveUsers: number;
  authorizedAccounts: number;
  totalMessages: number;
  totalCommands: number;
  totalLiveViewers: number;
}

type AttentionId = AttentionKey | 'bots' | 'permissions';

interface AttentionRow {
  key: AttentionId;
  count: number;
  icon: string;
  title: string;
  why: string;
  /** Where the tap goes; null when there is no page for it yet. */
  link: string | null;
  query: Record<string, string> | null;
  where: string;
}

/**
 * Everything that can need the owner, worst first: money someone paid for and did not get, then things
 * that broke, then billing and data that fell behind, then streamers who could use a hand.
 */
const ATTENTION: Record<AttentionId, Omit<AttentionRow, 'key' | 'count' | 'title'> & { title: (count: number) => string }> = {
  gifts_need_support: {
    icon: 'gift',
    title: (n) => `${plural(n, 'gifted credit purchase')} could not be delivered`,
    why: 'Someone paid and the credits never arrived.',
    link: '/gifts',
    query: { status: 'needs_support' },
    where: 'Gifts',
  },
  failed_24h: {
    icon: 'alert',
    title: (n) => `${plural(n, 'thing')} failed in the last 24 hours`,
    why: "They should have worked and didn't.",
    link: '/activity',
    query: { outcome: 'failed', range: '24h' },
    where: 'Activity',
  },
  dead_deliveries: {
    icon: 'twitch',
    title: (n) => `${plural(n, 'Twitch event')} a part of the bot gave up on`,
    why: 'An alert or reward never ran for them.',
    link: '/observability',
    query: { tab: 'queues' },
    where: 'Queues',
  },
  polar_unsent: {
    icon: 'dollar',
    title: (n) => `${plural(n, 'channel')} ${n === 1 ? 'has' : 'have'} usage not yet sent to billing`,
    why: "That usage isn't charged yet.",
    link: '/observability',
    query: { tab: 'queues' },
    where: 'Queues',
  },
  usage_import_stuck: {
    icon: 'history',
    title: (n) => `${plural(n, 'usage history import')} ${n === 1 ? 'is' : 'are'} stuck`,
    why: 'Usage history has gaps until they run.',
    link: '/observability',
    query: { tab: 'queues' },
    where: 'Queues',
  },
  credits_exhausted: {
    icon: 'credits',
    title: (n) => `${plural(n, 'channel')} ${n === 1 ? 'is' : 'are'} out of AI credits`,
    why: 'Their paid AI features have stopped.',
    link: '/users',
    query: null,
    where: 'Users',
  },
  verdicts_waiting: {
    icon: 'shield',
    title: (n) => `${plural(n, 'chat protection message')} ${n === 1 ? 'waits' : 'wait'} for your verdict`,
    why: 'Your verdicts keep its judgement in check.',
    link: '/moderation-review',
    query: null,
    where: 'Review',
  },
  permissions: {
    icon: 'key',
    title: (n) => `${plural(n, 'channel')} ${n === 1 ? 'needs' : 'need'} to reconnect Twitch`,
    why: 'Some bot features stop until they sign in.',
    link: '/users',
    query: { sort: 'has_permissions', order: 'asc' },
    where: 'Users',
  },
  bots: {
    icon: 'power',
    title: (n) => (n === 1 ? "1 bot isn't active" : `${formatNumber(n)} bots aren't active`),
    why: 'Signed up, bot never turned on. A reminder can help.',
    link: '/users',
    query: { sort: 'actived', order: 'asc' },
    where: 'Users',
  },
  // Housekeeping, never urgent: nothing breaks while the code stays, and nothing is removed automatically.
  compat_removable: {
    icon: 'tag',
    title: (n) => `${plural(n, 'piece')} of old-version code can be removed`,
    why: 'No page that needs it has been seen for 14 days. Ask an agent to remove it.',
    link: '/observability',
    query: { tab: 'versions' },
    where: 'System',
  },
};
const ATTENTION_ORDER = Object.keys(ATTENTION) as AttentionId[];

/** Plain names for the parts the overview API can fail to load. */
const PART_NAME: Record<string, string> = {
  feed: 'activity numbers',
  usage: 'usage numbers',
  decisions: 'chat protection numbers',
  assistant: 'assistant numbers',
  docs: 'docs AI numbers',
  attention: 'some of the "needs you" checks',
};

const REFRESH_MS = 30_000;

/** How many attention rows a phone shows before "Show more". */
const ATTENTION_FIRST = 4;

@Component({
  selector: 'app-dashboard-page',
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SkeletonComponent,
    RouterLink,
    IconComponent,
    AvatarComponent,
    FeedListComponent,
    OvDayComponent,
    OvSpendComponent,
    OvTrendComponent,
    OvChannelsComponent,
  ],
})
export class DashboardPageComponent implements OnInit, OnDestroy {
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly adminApi = inject(AdminApiService);
  private readonly overviewApi = inject(OverviewApiService);

  readonly user = computed(() => this.sessionAuth.getSessionSnapshot()?.twitchUser);
  readonly appUser = computed(() => this.sessionAuth.getSessionSnapshot()?.appUser);

  // Public live counters (SSE + snapshot)
  readonly analytics = signal<SiteAnalyticsSnapshot>({
    registeredUsers: 0,
    liveUsers: 0,
    authorizedAccounts: 0,
    totalMessages: 0,
    totalCommands: 0,
    totalLiveViewers: 0,
  });
  readonly analyticsConnectionStatus = signal<'connected' | 'reconnecting' | 'disconnected'>(
    'disconnected',
  );
  readonly isInitialLoading = signal(true);
  readonly hasSnapshot = signal(false);
  readonly snapshotError = signal(false);

  // Channel health comes from the admin directory (top live channels + totals).
  readonly health = signal<AdminUsersSummary | null>(null);
  readonly liveRows = signal<AdminUserRow[]>([]);
  readonly healthLoading = signal(true);
  readonly healthError = signal(false);
  private healthRequest?: Subscription;

  // The owner's overview: one call, refreshed every 30 s while the tab is visible.
  readonly overview = signal<AdminOverview | null>(null);
  readonly overviewLoading = signal(true);
  /** The last attempt failed (with data: we show the previous numbers; without: an error block). */
  readonly overviewFailed = signal(false);
  readonly overviewAt = signal<number | null>(null);
  private overviewRequest?: Subscription;
  private lastOverviewAttempt = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible' && Date.now() - this.lastOverviewAttempt >= REFRESH_MS) this.loadOverview();
  };

  readonly tools = [
    {
      route: '/email-test',
      icon: 'mail',
      label: 'Test an email',
      description: 'Send yourself any email to check how it looks.',
    },
    {
      route: '/read-tool',
      icon: 'files',
      label: 'Read a server file',
      description: 'Open a file on the server without SSH.',
    },
  ];
  readonly metrics = computed(() => [
    { label: 'Registered users', value: this.analytics().registeredUsers, note: 'Signed up' },
    {
      label: 'Authorized accounts',
      value: this.analytics().authorizedAccounts,
      note: 'Connected to Twitch',
    },
    { label: 'Messages processed', value: this.analytics().totalMessages, note: 'All time' },
    { label: 'Commands executed', value: this.analytics().totalCommands, note: 'All time' },
  ]);

  /**
   * On a phone a long list of things to look at pushes the rest of the page far down: the worst few are
   * shown and the rest are one tap away. A wide screen has the room, so it starts open.
   */
  readonly attentionOpen = signal(typeof matchMedia === 'function' && matchMedia('(min-width: 960px)').matches);
  readonly attentionShown = computed(() => (this.attentionOpen() ? this.attention() : this.attention().slice(0, ATTENTION_FIRST)));
  readonly attentionHidden = computed(() => this.attention().length - this.attentionShown().length);

  /** Everything that needs the owner, from the overview and the users summary, worst first. */
  readonly attention = computed<AttentionRow[]>(() => {
    const counts = new Map<AttentionId, number>();
    for (const item of this.overview()?.attention ?? []) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
    const health = this.health();
    if (health) {
      counts.set('bots', health.inactiveBots);
      counts.set('permissions', health.permissionsNeedUpdate);
    }
    return ATTENTION_ORDER.filter((key) => (counts.get(key) ?? 0) > 0).map((key) => {
      const count = counts.get(key)!;
      const { title, ...rest } = ATTENTION[key];
      return { key, count, ...rest, title: title(count) };
    });
  });

  /** First load: wait for both sources before answering, so the answer doesn't flip a second later. */
  readonly answerLoading = computed(
    () =>
      (this.overviewLoading() && !this.overview() && !this.overviewFailed()) ||
      (this.healthLoading() && !this.health() && !this.healthError()),
  );

  /** What could not be checked, in plain words; empty when every check ran. */
  readonly unchecked = computed(() => {
    const missing: string[] = [];
    const overview = this.overview();
    if (!overview) missing.push('failures, queues and billing');
    else if (overview.partial.includes('attention')) missing.push('some queues and billing');
    if (!this.health()) missing.push('bots and Twitch access');
    return missing;
  });

  /** "Dima did 6,571 things in the last 24 hours; 170 didn't go as planned." */
  readonly handledLine = computed(() => {
    const kinds = this.overview()?.day.kinds;
    if (!kinds) return "Today's numbers couldn't be loaded yet.";
    const total = kinds.reduce((sum, kind) => sum + kind.total, 0);
    const problems = kinds.reduce((sum, kind) => sum + kind.problems, 0);
    if (!total) return 'Nothing recorded in the last 24 hours yet.';
    return `Dima did ${plural(total, 'thing')} in the last 24 hours${problems ? `; ${formatNumber(problems)} didn't go as planned.` : ', all as planned.'}`;
  });

  readonly answer = computed(() => {
    const items = this.attention();
    if (items.length) {
      return {
        tone: 'warn' as const,
        icon: 'alert',
        title: `${plural(items.length, 'thing')} ${items.length === 1 ? 'needs' : 'need'} you`,
        text: this.handledLine(),
      };
    }
    const unchecked = this.unchecked();
    if (unchecked.length) {
      return {
        tone: 'muted' as const,
        icon: 'info',
        title: 'Nothing flagged so far',
        text: `Couldn't check ${unchecked.join(' or ')} right now. Try Refresh in a moment.`,
      };
    }
    return {
      tone: 'ok' as const,
      icon: 'ok',
      title: 'Everything looks good',
      text: `Checked failures, Twitch deliveries, billing, usage imports, gifted credits, AI credits, the review queue, ${plural(this.health()?.totalChannels ?? 0, 'bot')} and Twitch access.`,
    };
  });

  readonly partialNotice = computed(() => {
    const parts = [...new Set((this.overview()?.partial ?? []).map((part) => PART_NAME[part] ?? `${part} numbers`))];
    if (!parts.length) return null;
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `${list.charAt(0).toUpperCase()}${list.slice(1)} couldn't be loaded. The rest is up to date.`;
  });

  readonly updatedAt = computed(() => {
    const at = this.overviewAt();
    return at ? clockTime(at) : null;
  });

  readonly anyLoading = computed(() => this.healthLoading() || this.overviewLoading());
  readonly firstName = computed(() => this.user()?.display_name || 'there');

  refreshAnalytics(): void {
    void this.fetchAnalyticsSnapshot();
  }

  refreshAll(): void {
    this.refreshAnalytics();
    this.loadHealth();
    this.loadOverview();
  }

  loadOverview(): void {
    // Never stack requests: a tick or a tap while one is on its way waits for that one.
    if (this.overviewRequest && !this.overviewRequest.closed) return;
    this.lastOverviewAttempt = Date.now();
    this.overviewLoading.set(true);
    this.overviewRequest = this.overviewApi.get().subscribe({
      next: (response) => {
        this.overview.set(response.data);
        this.overviewAt.set(Date.now());
        this.overviewFailed.set(false);
        this.overviewLoading.set(false);
      },
      error: () => {
        this.overviewFailed.set(true);
        this.overviewLoading.set(false);
      },
    });
  }

  loadHealth(): void {
    this.healthRequest?.unsubscribe();
    this.healthLoading.set(true);
    this.healthError.set(false);
    this.healthRequest = this.adminApi
      .getUsers({ page: 1, limit: 6, sortBy: 'liveViewers', sortOrder: 'desc' })
      .subscribe({
        next: (response) => {
          this.health.set(response.data.summary);
          this.liveRows.set(response.data.rows.filter((row) => row.isLive));
          this.healthLoading.set(false);
        },
        error: () => {
          this.healthError.set(true);
          this.healthLoading.set(false);
        },
      });
  }

  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  ngOnInit(): void {
    this.fetchAnalyticsSnapshot();
    this.connectAnalyticsStream();
    this.loadHealth();
    this.loadOverview();
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.loadOverview();
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    this.healthRequest?.unsubscribe();
    this.overviewRequest?.unsubscribe();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.eventSource?.close();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }

  private connectAnalyticsStream(): void {
    this.eventSource?.close();
    this.eventSource = new EventSource(`${environment.DIMA_API}/config/site/analytics/stream`);
    this.analyticsConnectionStatus.set('reconnecting');

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.analyticsConnectionStatus.set('connected');
    };

    this.eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as Partial<SiteAnalyticsSnapshot>;
        if (!payload || typeof payload !== 'object') return;
        this.applyAnalyticsSnapshot(payload);
        this.analyticsConnectionStatus.set('connected');
      } catch {
        /* Keep the last valid snapshot if a stream event is malformed. */
      }
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.reconnectAttempts += 1;
      this.analyticsConnectionStatus.set(
        this.reconnectAttempts > 3 ? 'disconnected' : 'reconnecting',
      );
      this.fetchAnalyticsSnapshot();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connectAnalyticsStream();
    }, 3500);
  }

  private async fetchAnalyticsSnapshot(): Promise<void> {
    try {
      const response = await fetch(`${environment.DIMA_API}/config/site/analytics`);
      if (!response.ok) {
        this.snapshotError.set(true);
        this.isInitialLoading.set(false);
        return;
      }

      const envelope = (await response.json()) as { data?: Partial<SiteAnalyticsSnapshot> };
      if (!envelope.data) {
        this.snapshotError.set(true);
        this.isInitialLoading.set(false);
        return;
      }

      this.applyAnalyticsSnapshot(envelope.data);
      this.isInitialLoading.set(false);
    } catch {
      this.snapshotError.set(true);
      this.isInitialLoading.set(false);
    }
  }

  private applyAnalyticsSnapshot(payload: Partial<SiteAnalyticsSnapshot>): void {
    this.hasSnapshot.set(true);
    this.snapshotError.set(false);
    this.isInitialLoading.set(false);
    this.analytics.update((current) => ({
      ...current,
      registeredUsers: this.safeNumber(payload.registeredUsers ?? current.registeredUsers),
      liveUsers: this.safeNumber(payload.liveUsers ?? current.liveUsers),
      authorizedAccounts: this.safeNumber(payload.authorizedAccounts ?? current.authorizedAccounts),
      totalMessages: this.safeNumber(payload.totalMessages ?? current.totalMessages),
      totalCommands: this.safeNumber(payload.totalCommands ?? current.totalCommands),
      totalLiveViewers: this.safeNumber(payload.totalLiveViewers ?? current.totalLiveViewers),
    }));
  }

  private safeNumber(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(0, Math.floor(parsed));
  }

  /** Compact for the big live figures and totals ("5.1M"); whole numbers under 1,000. */
  formatNumber(value: number): string {
    return formatCompact(value);
  }
}
