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
import { IconComponent } from '../../shared/icon/icon.component';
import { environment } from '../../../environments/environment';

import { SessionAuthService } from '../../services/session-auth.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

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
  imports: [SkeletonComponent, RouterLink, IconComponent],
})
export class DashboardPageComponent implements OnInit, OnDestroy {
  private readonly sessionAuth = inject(SessionAuthService);

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
  readonly quickLinks = [
    {
      route: '/users',
      icon: 'users',
      label: 'Manage users',
      description: 'Accounts, permissions & channel controls',
      action: 'Open directory',
    },
    {
      route: '/email-test',
      icon: 'mail',
      label: 'Test an email',
      description: 'Check templates, languages & delivery',
      action: 'Open email tools',
    },
    {
      route: '/read-tool',
      icon: 'files',
      label: 'Inspect a file',
      description: 'Read server files from your workspace',
      action: 'Open file reader',
    },
  ];
  readonly metrics = computed(() => [
    {
      label: 'Registered users',
      value: this.analytics().registeredUsers,
      icon: 'users',
      note: 'Across the platform',
    },
    {
      label: 'Authorized accounts',
      value: this.analytics().authorizedAccounts,
      icon: 'shield',
      note: 'Connected to Dima',
    },
    {
      label: 'Messages processed',
      value: this.analytics().totalMessages,
      icon: 'message',
      note: 'Platform total',
    },
    {
      label: 'Commands executed',
      value: this.analytics().totalCommands,
      icon: 'command',
      note: 'Platform total',
    },
  ]);
  refreshAnalytics(): void {
    void this.fetchAnalyticsSnapshot();
  }

  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  ngOnInit(): void {
    this.fetchAnalyticsSnapshot();
    this.connectAnalyticsStream();
  }

  ngOnDestroy(): void {
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
