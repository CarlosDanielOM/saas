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
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { AvatarComponent } from '../../shared/avatar/avatar.component';

interface SiteAnalyticsSnapshot {
  registeredUsers: number;
  liveUsers: number;
  authorizedAccounts: number;
  totalMessages: number;
  totalCommands: number;
  totalLiveViewers: number;
}

@Component({
  selector: 'app-dashboard-page',
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SkeletonComponent, RouterLink, IconComponent, AvatarComponent],
})
export class DashboardPageComponent implements OnInit, OnDestroy {
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly adminApi = inject(AdminApiService);

  readonly user = computed(() => this.sessionAuth.getSessionSnapshot()?.twitchUser);
  readonly appUser = computed(() => this.sessionAuth.getSessionSnapshot()?.appUser);

  // Analytics state
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
  /** Problems an admin can act on, with where to go to fix them. */
  readonly attention = computed(() => {
    const s = this.health();
    if (!s) return [];
    return [
      {
        key: 'bots',
        count: s.inactiveBots,
        label: s.inactiveBots === 1 ? 'Bot not active' : 'Bots not active',
        meta: "They signed up but the bot isn't on in their channel. A reminder email can help.",
        icon: 'power',
        query: { sort: 'actived', order: 'asc' },
      },
      {
        key: 'permissions',
        count: s.permissionsNeedUpdate,
        label: 'Twitch access out of date',
        meta: 'They need to sign in again so the bot gets the Twitch permissions it needs.',
        icon: 'key',
        query: { sort: 'has_permissions', order: 'asc' },
      },
    ];
  });
  readonly attentionTotal = computed(() =>
    this.attention().reduce((sum, item) => sum + item.count, 0),
  );
  readonly firstName = computed(() => this.user()?.display_name || 'there');

  refreshAnalytics(): void {
    void this.fetchAnalyticsSnapshot();
  }

  refreshAll(): void {
    this.refreshAnalytics();
    this.loadHealth();
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
  }

  ngOnDestroy(): void {
    this.healthRequest?.unsubscribe();
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

  formatNumber(value: number): string {
    if (value >= 1000000) {
      return (value / 1000000).toFixed(1) + 'M';
    }
    if (value >= 1000) {
      return (value / 1000).toFixed(1) + 'K';
    }
    return value.toLocaleString();
  }
}
