import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { catchError, interval, of, startWith, Subject, switchMap, takeUntil, tap } from 'rxjs';

import {
  DashboardAccessResponse,
  DashboardBootstrapResponse,
  DashboardLiveStatusResponse,
  LiveSessionMetrics
} from '../models/dashboard.model';
import { LinksService } from './links.service';
import { WebsocketService } from './websocket.service';

interface DashboardSnapshotPayload {
  channelID: string;
  connectedAt: string;
  isLive: boolean;
  liveSession?: LiveSessionMetrics;
}

interface StreamStatusPayload {
  channelID: string;
  isLive: boolean;
  checkedAt: string;
  liveSession?: LiveSessionMetrics;
}

@Injectable({
  providedIn: 'root'
})
export class DashboardApiService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly websocketService = inject(WebsocketService);
  private readonly stopLivePoll$ = new Subject<void>();
  private currentChannelID: string | null = null;
  private wsUnsubscribe: (() => void) | null = null;

  readonly bootstrapData = signal<DashboardBootstrapResponse | null>(null);
  readonly liveStatus = signal<DashboardLiveStatusResponse | null>(null);
  readonly liveSessionMetrics = signal<LiveSessionMetrics | null>(null);
  readonly loading = signal(false);
  readonly connectionStatus = signal<'connected' | 'connecting' | 'disconnected'>('disconnected');

  getBootstrap(channelID: string) {
    this.loading.set(true);
    this.connectionStatus.set('connecting');

    return this.http
      .get<DashboardBootstrapResponse>(`${this.linksService.getApiUrl()}/dashboard/${channelID}/bootstrap`)
      .pipe(
        tap((response) => {
          this.bootstrapData.set(response);
          this.connectionStatus.set('connected');
          this.loading.set(false);
        }),
        catchError(() => {
          this.connectionStatus.set('disconnected');
          this.loading.set(false);
          return of({
            error: true,
            status: 500,
            message: 'Failed to load dashboard bootstrap data',
            data: undefined
          } as DashboardBootstrapResponse);
        })
      );
  }

  getLiveStatus(channelID: string) {
    return this.http.get<DashboardLiveStatusResponse>(
      `${this.linksService.getApiUrl()}/dashboard/${channelID}/live-status`
    );
  }

  getAccess(channelID: string) {
    return this.http.get<DashboardAccessResponse>(
      `${this.linksService.getApiUrl()}/dashboard/${channelID}/access`
    );
  }

  startLiveStatusPolling(channelID: string, intervalMs = 45000): void {
    this.stopLiveStatusPolling();
    this.currentChannelID = channelID;

    // Connect to WebSocket for real-time updates
    this.connectWebSocket(channelID);

    // Keep HTTP polling as fallback for initial load and reconnection
    interval(intervalMs)
      .pipe(
        startWith(0),
        switchMap(() => this.getLiveStatus(channelID)),
        tap((response) => {
          this.liveStatus.set(response);
          if (response.data?.liveSession) {
            this.liveSessionMetrics.set(response.data.liveSession);
          }
          this.connectionStatus.set('connected');
        }),
        catchError(() => {
          this.connectionStatus.set('disconnected');
          return of(null);
        }),
        takeUntil(this.stopLivePoll$)
      )
      .subscribe();
  }

  private connectWebSocket(channelID: string): void {
    // Clean up existing connection
    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
    }

    const namespace = `/dashboard/${channelID}`;

    // Listen for dashboard snapshot (initial connection)
    this.websocketService.on<DashboardSnapshotPayload>(namespace, 'dashboard-snapshot', (data) => {
      if (data.liveSession) {
        this.liveSessionMetrics.set(data.liveSession);
      }
    });

    // Listen for stream status updates
    this.websocketService.on<StreamStatusPayload>(namespace, 'stream-status', (data) => {
      if (data.liveSession) {
        this.liveSessionMetrics.set(data.liveSession);
      }
    });
  }

  stopLiveStatusPolling(): void {
    this.stopLivePoll$.next();
    if (this.currentChannelID) {
      this.websocketService.disconnect(`/dashboard/${this.currentChannelID}`);
      this.currentChannelID = null;
    }
    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
    }
  }

  ngOnDestroy(): void {
    this.stopLiveStatusPolling();
  }

  toggleChat(channelID: string, enabled: boolean) {
    return this.http.post<{ error: boolean; message: string; data?: { chatEnabled: boolean } }>(
      `${this.linksService.getApiUrl()}/users/chat/${channelID}`,
      { enabled }
    );
  }
}
