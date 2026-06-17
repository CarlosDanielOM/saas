import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { catchError, interval, of, startWith, Subject, switchMap, takeUntil, tap } from 'rxjs';

import {
  DashboardAccessResponse,
  DashboardBootstrapResponse,
  DashboardLiveStatusResponse,
  LiveSessionMetrics,
  AiCreditsData,
  AiCreditsResponse
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
  private readonly stopAiCreditsPoll$ = new Subject<void>();
  private currentChannelID: string | null = null;
  private wsUnsubscribe: (() => void) | null = null;

  readonly bootstrapData = signal<DashboardBootstrapResponse | null>(null);
  readonly liveStatus = signal<DashboardLiveStatusResponse | null>(null);
  readonly liveSessionMetrics = signal<LiveSessionMetrics | null>(null);
  readonly aiCredits = signal<AiCreditsData | null>(null);
  readonly loading = signal(false);
  readonly connectionStatus = signal<'connected' | 'connecting' | 'disconnected'>('disconnected');

  resetState(): void {
    this.bootstrapData.set(null);
    this.liveStatus.set(null);
    this.liveSessionMetrics.set(null);
    this.aiCredits.set(null);
    this.loading.set(false);
    this.connectionStatus.set('disconnected');
  }

  private syncBootstrapHistory(isLive: boolean, liveSession: LiveSessionMetrics | null): void {
    const current = this.bootstrapData();
    if (!current?.data) {
      return;
    }

    this.bootstrapData.set({
      ...current,
      data: {
        ...current.data,
        isLive,
        liveSession,
        streamHistory: current.data.streamHistory
      }
    });
  }

  private refreshBootstrap(channelID: string): void {
    this.http
      .get<DashboardBootstrapResponse>(`${this.linksService.getApiUrl()}/dashboard/${channelID}/bootstrap`)
      .pipe(
        catchError(() => of(null))
      )
      .subscribe((response) => {
        if (!response?.data) {
          return;
        }

        this.bootstrapData.set(response);
        this.liveStatus.set({
          error: response.error,
          status: response.status,
          message: response.message,
          data: {
            isLive: response.data.isLive,
            checkedAt: new Date().toISOString(),
            stream: response.data.liveStream,
            liveSession: response.data.liveSession
          }
        });
        this.liveSessionMetrics.set(response.data.liveSession ?? null);
      });
  }

  private applyLiveUpdate(channelID: string, payload: { isLive: boolean; checkedAt?: string; liveSession?: LiveSessionMetrics | null }): void {
    const previousIsLive = this.liveStatus()?.data?.isLive ?? this.bootstrapData()?.data?.isLive ?? false;
    const liveSession = payload.liveSession ?? null;

    this.liveStatus.set({
      error: false,
      status: 200,
      message: 'Live status updated',
      data: {
        isLive: payload.isLive,
        checkedAt: payload.checkedAt ?? new Date().toISOString(),
        stream: this.liveStatus()?.data?.stream ?? this.bootstrapData()?.data?.liveStream ?? null,
        liveSession
      }
    });
    this.liveSessionMetrics.set(liveSession);
    this.syncBootstrapHistory(payload.isLive, liveSession);

    if (previousIsLive && !payload.isLive) {
      this.refreshBootstrap(channelID);
    }
  }

  getBootstrap(channelID: string) {
    this.loading.set(true);
    this.connectionStatus.set('connecting');

    return this.http
      .get<DashboardBootstrapResponse>(`${this.linksService.getApiUrl()}/dashboard/${channelID}/bootstrap`)
      .pipe(
        tap((response) => {
          this.bootstrapData.set(response);
          this.liveStatus.set({
            error: response.error,
            status: response.status,
            message: response.message,
            data: response.data
              ? {
                  isLive: response.data.isLive,
                  checkedAt: new Date().toISOString(),
                  stream: response.data.liveStream,
                  liveSession: response.data.liveSession
                }
              : undefined
          });
          this.liveSessionMetrics.set(response.data?.liveSession ?? null);
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
          this.applyLiveUpdate(channelID, {
            isLive: response.data?.isLive ?? false,
            checkedAt: response.data?.checkedAt,
            liveSession: response.data?.liveSession ?? null
          });
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
    const unsubscribers: Array<() => void> = [];

    // Listen for dashboard snapshot (initial connection)
    unsubscribers.push(this.websocketService.on<DashboardSnapshotPayload>(namespace, 'dashboard-snapshot', (data) => {
      this.applyLiveUpdate(channelID, {
        isLive: data.isLive,
        checkedAt: data.connectedAt,
        liveSession: data.liveSession ?? null
      });
    }));

    // Listen for stream status updates
    unsubscribers.push(this.websocketService.on<StreamStatusPayload>(namespace, 'stream-status', (data) => {
      this.applyLiveUpdate(channelID, {
        isLive: data.isLive,
        checkedAt: data.checkedAt,
        liveSession: data.liveSession ?? null
      });
    }));

    this.wsUnsubscribe = () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
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
    this.stopAiCreditsPolling();
  }

  toggleChat(channelID: string, enabled: boolean) {
    return this.http.post<{ error: boolean; message: string; data?: { chatEnabled: boolean } }>(
      `${this.linksService.getApiUrl()}/users/chat/${channelID}`,
      { enabled }
    );
  }

  getAiCredits(channelID: string) {
    return this.http.get<AiCreditsResponse>(
      `${this.linksService.getApiUrl()}/billing/ai-credits?channelID=${encodeURIComponent(channelID)}`
    ).pipe(
      catchError(() => of({
        error: true,
        status: 500,
        message: 'Failed to load AI credits',
        data: undefined
      } as AiCreditsResponse))
    );
  }

  startAiCreditsPolling(channelID: string, intervalMs = 60000): void {
    this.stopAiCreditsPolling();

    // Initial fetch (webhook or 5min cache will usually serve it)
    this.getAiCredits(channelID).subscribe((response) => {
      if (response?.data) {
        this.aiCredits.set(response.data);
      }
    });

    interval(intervalMs)
      .pipe(
        switchMap(() => this.getAiCredits(channelID)),
        tap((response) => {
          if (response?.data) {
            this.aiCredits.set(response.data);
          }
        }),
        catchError(() => of(null)),
        takeUntil(this.stopAiCreditsPoll$)
      )
      .subscribe();
  }

  stopAiCreditsPolling(): void {
    this.stopAiCreditsPoll$.next();
  }
}
