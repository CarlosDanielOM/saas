import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import { SiteStats } from '../models/site-stats.model';

/**
 * Public site analytics (metrics + live channels).
 * Always hits production API so the landing page shows real data under
 * ng serve, local preview, and production deploys.
 */
const LIVE_ANALYTICS_API = 'https://api.domdimabot.com';

interface SiteAnalyticsSnapshotDto {
  registeredUsers?: unknown;
  liveUsers?: unknown;
  authorizedAccounts?: unknown;
  totalMessages?: unknown;
  totalCommands?: unknown;
  totalLiveViewers?: unknown;
  liveChannels?: unknown;
}

export interface LiveChannelBoardEntry {
  channelID: string;
  channel: string;
  viewers: number;
  profileImageUrl: string;
  botPlatforms: Array<'twitch' | 'kick'>;
}

@Injectable({ providedIn: 'root' })
export class SiteAnalyticsService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  readonly siteStats = signal<SiteStats>({
    registeredUsers: 0,
    liveUsers: 0,
    botActiveAccounts: 0,
    messagesReceived: 0,
    totalCommands: 0,
    totalLiveViewer: 0
  });

  readonly liveChannels = signal<LiveChannelBoardEntry[]>([]);
  readonly connectionStatus = signal<'connected' | 'reconnecting' | 'disconnected'>(
    'disconnected'
  );

  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private started = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.teardown());
  }

  /**
   * Idempotent — safe to call from multiple consumers.
   * Browser-only: during prerender/SSR no snapshot is fetched and no SSE
   * connection is opened, so live telemetry is never baked into static HTML.
   */
  start(): void {
    if (!this.isBrowser || this.started) {
      return;
    }
    this.started = true;
    void this.fetchSnapshot();
    this.connectStream();
  }

  private teardown(): void {
    this.eventSource?.close();
    this.eventSource = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.started = false;
    this.connectionStatus.set('disconnected');
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const response = await fetch(`${LIVE_ANALYTICS_API}/config/site/analytics`);
      if (!response.ok) {
        return;
      }

      const envelope = (await response.json()) as { data?: SiteAnalyticsSnapshotDto };
      if (envelope.data) {
        this.applySnapshot(envelope.data);
      }
    } catch {
      // stream retries recover state
    }
  }

  private connectStream(): void {
    this.eventSource?.close();

    this.connectionStatus.set('reconnecting');
    this.eventSource = new EventSource(`${LIVE_ANALYTICS_API}/config/site/analytics/stream`);

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.connectionStatus.set('connected');
    };

    this.eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as SiteAnalyticsSnapshotDto;
        this.applySnapshot(payload);
        this.connectionStatus.set('connected');
      } catch {
        // ignore bad payload
      }
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.reconnectAttempts += 1;
      this.connectionStatus.set(
        this.reconnectAttempts > 3 ? 'disconnected' : 'reconnecting'
      );
      void this.fetchSnapshot();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      if (this.isBrowser && this.started) {
        this.connectStream();
      }
    }, 3500);
  }

  private applySnapshot(payload: SiteAnalyticsSnapshotDto): void {
    this.siteStats.set({
      registeredUsers: this.safeNumber(payload.registeredUsers),
      liveUsers: this.safeNumber(payload.liveUsers),
      botActiveAccounts: this.safeNumber(payload.authorizedAccounts),
      messagesReceived: this.safeNumber(payload.totalMessages),
      totalCommands: this.safeNumber(payload.totalCommands),
      totalLiveViewer: this.safeNumber(payload.totalLiveViewers)
    });

    this.liveChannels.set(this.normalizeLiveChannels(payload.liveChannels));
  }

  private safeNumber(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(0, Math.floor(parsed));
  }

  private normalizeLiveChannels(value: unknown): LiveChannelBoardEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const raw = entry as Record<string, unknown>;

        const botPlatforms = Array.isArray(raw['botPlatforms'])
          ? raw['botPlatforms']
              .map((p) => String(p).toLowerCase())
              .filter((p): p is 'twitch' | 'kick' => p === 'twitch' || p === 'kick')
          : [];

        return {
          channelID: String(raw['channelID'] || ''),
          channel: String(raw['channel'] || raw['channelID'] || '').trim(),
          viewers: this.safeNumber(raw['viewers']),
          profileImageUrl: String(raw['profileImageUrl'] || ''),
          botPlatforms
        };
      })
      .filter((e): e is LiveChannelBoardEntry => Boolean(e && e.channel))
      .sort((a, b) => b.viewers - a.viewers);
  }
}
