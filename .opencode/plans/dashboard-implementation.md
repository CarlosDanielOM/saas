# Dashboard Implementation Plan
**DomDimaBot v21 - Phase 2**

---

## Overview

This plan covers complete implementation of the dashboard section for the new v21 DomDimaBot website. The dashboard will display real-time analytics, KPIs, trends, and stream performance using actual backend API contracts and WebSocket connections.

**Target:** `/home/cdom/saas/dimasite/src/app/features/dashboard/`
**Reference:** `/home/cdom/saas/dima-site/` (Angular v17 - for UI/UX patterns)
**Backend:** Existing API at `dimabot` (no backend changes needed)
**Angular Version:** v21
**Implementation Status:** Read-only planning phase

---

## Architecture Overview

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     User Browser                          │
└───────────────────────────┬───────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────┐
        │  Dashboard Component    │
        └───────────┬───────────────┘
                    │
                    ├──────────────────────────────┐
                    │                                │
        ┌───────────┴──────────┐      │      ┌──────────┐
        │                         │      │      │
        ▼                         │      │      ▼
   ┌─────┴────┬──────────────┴───┐      │
   │                      │      │      │      │
   │                      │      │      │      │
   │  Signals  ──┤  │      │      │      │      │
   │                      │      │      │      │      │
   │  │      │      │      │      │      │
   │  ▼      ▼      ▼      ▼      ▼      │
   │  ┌──────────┬──────────┬──────────┬──────────┐
   │  │         │         │         │         │
   │  │ KPIs   │  Charts  │  Updates  │  │
   │  │ (viewers,│(trend)│(live)   │(state)  │
   │  │  subs,   │      │  │         │
   │  │  etc.)  │      │      │         │
   │  └─────────┴──────────┴───────────┘
   │                      │      │      │
   │  └──────────────────────┴──────────────────────┘
   │                      │
   └──────────────────────┴──────────────────────────────┘
        │                 │
        │                 │
   │        ┌────────┴────────────────────────────────┐
   │        │                                     │
   │        │      ┌──────────┬───────────┐    │
   │        │      │         │         │    │
   │        │      ▼         │ ▼         │    │
   │        │    Services Layer (Singleton)   │    │
   │        │  │         │         │    │
   │        │  │  │         │         │    │
   │        │  │  │         │         │    │
   │        │  │  │         │         │    │
   │        │  │  │         │         │    │    │
   │  │  │  │  │         │         │    │    │
   │        │  │  │         │         │    │    │
   │        └────────┴─────────┴─────────┴───────────┘    │
   │                             │    │
   │              HTTP Client   │    │    │
   │            (API Calls)│    │    │
   │                 │         │    │    │
   │              └─────────┴    │    │    │
   │                             │    │
   │                   Socket.IO   │    │    │
   │             (Real-time)  │    │    │
   │                 │         │    │    │
   │              └─────────┴─────────────┘    │
   │                             │
   │                 │         │    │
   │           Theme Service   │    │    │
   │            (Dark/Light)  │    │    │
   │                 │         │    │    │
   │              └─────────┴─────────────┘    │
   │                             │
   │                 │         │    │    │
   │           Language Service│    │    │
   │            (EN/ES i18n)   │    │    │
   │                 │         │         │    │
   │              └─────────┴─────────────┘    │
   │                             │
   │                 │         │         │    │
   │           Links Service   │    │    │
   │            (API URLs)   │    │    │
   │                 │         │         │    │
   │              └─────────┴─────────────┘    │
   │                             │
   │                 │         │         │
   │         │    │         │         │
   │         │ │  │         │    │    │
   │         │  │  │         │         │    │
   │         │  │  │         │         │    │
   │    └─────────┴─────────┴─────────────┘
   │                             │
   │        ┌────────────────────────────────────────┐
   │        │      Backend API (dimabot)         │
   │        │              │    │    │    │
   │        │        ┌─────┬───────────┬────────┐│    │
   │        │        │     │     │         │    │  │
   │        │        │     │     │         │    │  │
   │        │        │     │     │         │    │  │  │
   │        │        ▼     │     ▼         │    │  │  │  │
   │        │  │     │     │     │         │  │  │  │
   │        │  │     │     │     │         │  │  │  │  │
   │        │  │     │     │     │         │ │  │  │  │
   │        │  │     │     │     │         │  │  │  │  │
   │        │  │     │     │     │         │  │  │  │  │  │
   │        │   ┌───┴─────┴───────┴───────┘    │  │  │
   │        │   │   │   │  │   │   │   │   │  │  │  │
   │        │   │   │   │   │   │   │  │  │  │  │
   │        │   │   │   │   │   │  │  │ │  │  │  │
   │        │   │   │   │   │   │   │ │  │  │  │  │
   │        │   │   │   │   │   │   │  │  │  │  │
   │        │   │   │  │   │   │    │    │  │  │  │  │  │
   │        │   │  │   │   │   │   │   │  │  │  │  │ 
   │        │   │   │   │   │   │   │  │ │  │  │
   │        │   │   │   app   │   │
   │        │   │   │   │   │   │ │  │  │
   │        │   │   │   │   │  │  │  │  │  │
   │        │   │   │   │   │   │   │  │  │   │
   │        │   │   │   │   │   │    │  │  │  │  │
   │        │   │   │   │   │   │   │  │  │
   │        │        │   │   │   │   │  │  │  │
   │        │        │   │   │   │    │   │    /bootstrap
   │        │   │        │ /live-status
   │        │        │   │     stream-analytics worker
   │        │   │        │     site-analytics utils
   │        │        │        │     MongoDB persistence
   │        │        │   │     /twitch-helix API
   │        │        │        │         │
   │   │        │        │
   │        │   │         │
   │        │   │   │         │
   │        │        │ │   │   │   │  │  │  │
   │        │        │   │         │
   │   │   │   │  │  │
   │        │        │  │         │  │
   │   │        │         │
   │        │        │   │         │   │
   │        │   │         │
   │        │   │         │
   │        │   │  │         │
   │        │   │         │
   │        │   │   │   │  │  │ │
   │        │   │         │
   │   │        │   │   │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │   │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │   │        │         │
   │        │   │         │
   │   │        │         │
   │        │ │         │
   │        │        │         │
   │        │        │         │
   │        │  │         │
   │        │ │         │
   │        │        │         │
   │        │   │         │
   │        │        │         │
   │        │   │         │
   │        │ │         │         │
   │        │ │         │        
   │        │        │         │
   │        │  │         │
   │        │        │         │
   │        │        │         │
   │        │ │ │         │
   │        │ │  │         │
   │        │        │         │
   │        │        │         │
   │        │        │         │
   │   │        │         │
   │        │   │         │
   │   │        │         │
   │        │ │ │         │
   │        │ │ │         │
   │        │ │ │         │
   │        │ │ │         │
   │        │  │         │
   │   │ │ │         │
   │        │ │ │         │
   │        │ │ │         │
   │  │ │ │         │
   │        │ │ │ │         │
   │        │ │ │         │
   │        │        │ │         │
   │   │ │ │ │ │
   │   │ │ │ │ │
   │        │ │ │ │         │
   │        │ │ │         │
   │        │ │ │ │         │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │ │
   │        │ │ │ │         │
   │  │ │ │ │ │
   │        │ │ │         │
   │        │ │ │         │
   │   │ │ │ │         │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │   │ │ │ │ │
   │        │ │ │ │ │
   │   │ │ │ │ │
   │        │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │  │ │ │ │ │
   │ │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │   │ │ │ │ │
   │   │ │ │ │ │
   │        │ │ │ │ │
   │  │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │   │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │ │ │ │ │ │
   │   │ │ │ │ │
   │ │ │ │ │ │
   │ │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
   │ │ │ │ │ │
   │        │ │ │ │ │
   │ │ │ │ │ │
│        └────────────────────────────────────────────┘
```

---

## Backend API Contracts

### Bootstrap Endpoint

**Route:** `GET /dashboard/:channelID/bootstrap`
**Purpose:** Fetch all dashboard data in one call
**Auth:** Required (user must be logged in and has access)
**Response Schema:**
```typescript
{
  error: boolean;
  message?: string;
  status: number;
  data: {
    channel: {
      id: string;
      name: string;
      chatEnabled: boolean;
    },
    isLive: boolean;
    liveStream: TwitchStream | null;
    kpis: DashboardKpis;
    trend: DashboardTrendPoint[];
    streamHistory: DashboardStreamHistoryPoint[];
    subsProgress: number;
    monthlyGoals: {
      followersGoal: number;
      followersCurrent: number;
      followersGoal: number;
    },
    premiumFeatures: string[];
    activeSubs: number;
    avgViewers30d: number;
    streamerRank?: {
      globalRank: number;
      categoryRank: number;
    }
  };
}

interface DashboardKpis {
  activeViewers: number;
  averageViewers30d: number;
  peakViewers30d: number;
  activeFollowers: number;
  averageFollowers30d: number;
  activeSubs: number;
  avgViewers30d: number;
  activeDonations: number;
  totalBits: number;
  totalDonations: number;
  totalDonations30d: number;
  totalCommandsExecuted30d: number;
  messagesReceived30d: number;
  totalFollows30d: number;
  streamUptimeMinutes: number;
}

interface DashboardTrendPoint {
  date: string;
  viewers: number;
  hours: number;
}

interface DashboardStreamHistoryPoint {
  date: string;
  viewers: number;
  hours: number;
  bits: number;
  donations: number;
  follows: number;
  subs: number;
}
```

### Live Status Endpoint

**Route:** `GET /dashboard/:channelID/live-status`
**Purpose:** Poll for current live status
**Auth:** Required
**Response Schema:**
```typescript
{
  error: boolean;
  message?: string;
  status: number;
  data: {
    isLive: boolean;
    checkedAt: string;
    stream: TwitchStream | null;
  };
}

interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  is_mature: boolean;
}
```

### Site Analytics WebSocket

**Namespace:** `/site/analytics/live-channels`
**Events:**
- `live-channels` - Array of currently live channels (name, viewers)

---

## Phase 1: Configuration & Dependencies

### 1.1 Chart Library Selection

**Recommendation:** `ngx-echarts`
- Angular ECharts wrapper
- Rich chart types (line, bar, area, pie, gauge)
- Excellent performance with large datasets
- Reactive with Angular signals
- Extensive customization options
- Good documentation and community support

**Alternative Options:**
- `apexcharts` - Similar to ECharts, also excellent
- `chart.js` - More lightweight, fewer features

**Installation:**
```bash
npm install ngx-echarts echarts
```

**Package.json Updates:**
```json
{
  "dependencies": {
    "ngx-echarts": "^18.0.0",
    "echarts": "^5.5.0"
  }
}
```

### 1.2 Route Mounting

**File:** `/home/cdom/saas/dimasite/src/app/app.routes.ts`

**Add dashboard route:**
```typescript
import { Routes } from '@angular/router';
import { AuthenticatedLayoutComponent } from './features/layout/authenticated-layout.component';

export const routes: Routes = [
  // ... existing routes ...

  {
    path: ':streamer',
    loadComponent: () => import('./features/layout/authenticated-layout.component').then(m => m.AuthenticatedLayoutComponent),
    canActivate: [authenticatedGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
        title: 'Dashboard',
        canActivate: [permissionGuard],
        data: {
          permission: { requiredLevel: 'everyone' }
        }
      },
      // ... other authenticated routes
    ]
  },

  { path: '**', redirectTo: '' }
];
```

### 1.3 Dashboard Guard

**File:** `/home/cdom/saas/dimasite/src/app/guards/dashboard-access.guard.ts`

```typescript
import { Injectable, inject } from '@angular/core';
import {
  CanActivateFn,
  Router,
  ActivatedRouteSnapshot,
  RouterStateSnapshot
} from '@angular/router';
import { UserService } from '../core/services/user.service';
import { DashboardApiService } from '../core/services/dashboard-api.service';
import { BehaviorSubject, combineLatest } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class DashboardAccessGuard {
  private userService = inject(UserService);
  private router = inject(Router);
  private dashboardApi = inject(DashboardApiService);
  private accessCache = new Map<string, { allowed: boolean }>();

  canActivate: CanActivateFn {
    return (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
      const channelID = route.paramMap.get('streamer');
      
      if (!channelID) {
        this.router.navigate(['/']);
        return false;
      }

      return this.checkAccess(channelID);
    };
  }

  private async checkAccess(channelID: string): Promise<boolean> {
    // Check cache first
    if (this.accessCache.has(channelID)) {
      return this.accessCache.get(channelID)!.allowed;
    }

    try {
      const result = await firstValueFrom(
        this.dashboardApi.getAccess(channelID),
        of(false)
      );

      this.accessCache.set(channelID, { allowed: result.data?.allowed ?? false });
      return result.data?.allowed ?? false;
    } catch (error) {
      console.error('Dashboard access check failed:', error);
      return false;
    }
  }
}
```

---

## Phase 2: Core Services

### 2.1 Dashboard API Service

**File:** `/home/cdom/saas/dimasite/src/app/core/services/dashboard-api.service.ts`

```typescript
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, combineLatest, firstValueFrom, map, tap, catchError, of } from 'rxjs';
import { LinksService } from './links.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { DashboardKpis, DashboardTrendPoint, DashboardStreamHistoryPoint } from '../core/models/dashboard.model';

@Injectable({
  providedIn: 'root'
})
export class DashboardApiService {
  private http = inject(HttpClient);
  private linksService = inject(LinksService);
  private userService = inject(UserService);
  private websocketService = inject(WebsocketService);

  // State
  readonly bootstrapData = signal<DashboardBootstrapResponse | null>(null);
  readonly liveStatus = signal<LiveStatusResponse | null>(null);
  readonly channelData = signal<ChannelData | null>(null);
  readonly connectionStatus = signal<'connected' | 'connecting' | 'disconnected'>('disconnected');

  // WebSocket connection
  private dashboardSocket: any = null;
  private liveStatusInterval: any = null;
  private reconnectAttempts = 0;

  getBootstrap(channelID: string) {
    const cached = this.getCachedBootstrap(channelID);
    if (cached) {
      this.bootstrapData.set(cached);
      return of(cached);
    }

    this.http.get<DashboardBootstrapResponse>(
      `${this.linksService.getApiUrl()}/dashboard/${channelID}/bootstrap`
    ).pipe(
      tap(data => this.cacheBootstrap(channelID, data)),
      catchError(error => {
        console.error('Bootstrap fetch failed:', error);
        return of({
          error: true,
          message: 'Failed to load dashboard data',
          status: 500,
          data: null
        } as DashboardBootstrapResponse);
      })
    );
  }

  getLiveStatus(channelID: string) {
    return this.http.get<LiveStatusResponse>(
      `${this.linksService.getApiUrl()}/dashboard/${channelID}/live-status`
    );
  }

  getAccess(channelID: string) {
    return this.http.get<AccessResponse>(
      `${this.linksService.getApiUrl()}/dashboard/${channelID}/access`
    );
  }

  private connectDashboardSocket(channelID: string): void {
    this.connectionStatus.set('connecting');
    this.reconnectAttempts = 0;

    try {
      const namespace = `/dashboard/${channelID}`;
      this.dashboardSocket = this.websocketService.connect(namespace);

      // Initial snapshot
      this.dashboardSocket.on('dashboard-snapshot', (data: DashboardBootstrapResponse) => {
        this.bootstrapData.set(data);
        this.connectionStatus.set('connected');
        this.reconnectAttempts = 0;
      this.startLiveStatusPolling(channelID);
        console.log('[DashboardApiService] Received initial snapshot');
      });

      // Live status updates
      this.dashboardSocket.on('stream-status', (data: LiveStatusResponse) => {
        this.liveStatus.set(data);
        console.log('[DashboardApiService] Stream status updated:', data.data);
      });

      // Error handling
      this.dashboardSocket.on('error', (error: any) => {
        console.error('[DashboardApiService] WebSocket error:', error);
        this.connectionStatus.set('disconnected');
      });

      this.dashboardSocket.on('disconnect', () => {
        console.log('[DashboardApiService] Dashboard socket disconnected');
        this.connectionStatus.set('disconnected');
        this.scheduleReconnect(channelID);
      });

    } catch (error) {
      console.error('[DashboardApiService] Failed to connect dashboard socket:', error);
      this.connectionStatus.set('disconnected');
    }
  }

  private startLiveStatusPolling(channelID: string): void {
    if (this.liveStatusInterval) {
      clearInterval(this.liveStatusInterval);
    }

    // Poll live status every 45 seconds
    this.liveStatusInterval = setInterval(() => {
      this.getLiveStatus(channelID).subscribe({
        next: (response) => {
          if (response.data) {
            this.liveStatus.set(response);
          }
        },
        error: (error) => {
          console.error('[DashboardApiService] Live status poll failed:', error);
        }
      });
    }, 45000);
  }

  private scheduleReconnect(channelID: string): void {
    const delay = Math.min(2 ** this.reconnectAttempts, 30000); // Exponential backoff
    
    setTimeout(() => {
      if (this.reconnectAttempts < 5) {
        this.reconnectAttempts++;
        this.connectDashboardSocket(channelID);
      } else {
        console.log('[DashboardApiService] Max reconnect attempts reached');
      }
    }, delay);
  }

  private disconnect(): void {
    if (this.dashboardSocket) {
      this.websocketService.disconnect(`/dashboard/${this.userService.getUser()?.login}`);
    }
    if (this.liveStatusInterval) {
      clearInterval(this.liveStatusInterval);
      this.liveStatusInterval = null;
    }
    this.connectionStatus.set('disconnected');
  }

  private getCachedBootstrap(channelID: string): DashboardBootstrapResponse | null {
    const cacheKey = `dashboard_bootstrap_${channelID}`;
    const cached = localStorage.getItem(cacheKey);
    return cached ? JSON.parse(cached) : null;
  }

  private cacheBootstrap(channelID: string, data: DashboardBootstrapResponse): void {
    const cacheKey = `dashboard_bootstrap_${channelID}`;
    const cacheEntry = JSON.stringify(data);
    localStorage.setItem(cacheKey, cacheEntry);
    // Set 5 minute TTL
    setTimeout(() => localStorage.removeItem(cacheKey), 300000);
  }

  public dispose(): void {
    this.disconnect();
  }
}
```

### 2.2 Dashboard Models

**File:** `/home/cdom/saas/dimasite/src/app/core/models/dashboard.model.ts`

```typescript
export interface DashboardKpis {
  activeViewers: number;
  averageViewers30d: number;
  peakViewers30d: number;
  activeFollowers: number;
  averageFollowers30d: number;
  activeSubs: number;
  avgViewers30d: number;
  activeDonations: number;
  totalBits: number;
  totalDonations30d: number;
  totalCommandsExecuted30d: number;
  messagesReceived30d: number;
  totalFollows30d: number;
  streamUptimeMinutes: number;
}

export interface DashboardTrendPoint {
  date: string;
  viewers: number;
  hours: number;
}

export interface DashboardStreamHistoryPoint {
  date: string;
  viewers: number;
  hours: number;
  bits: number;
  donations: number;
  follows: number;
  subs: number;
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  is_mature: boolean;
}

export interface ChannelData {
  id: string;
  name: string;
  chatEnabled: boolean;
}

export interface DashboardBootstrapResponse {
  error: boolean;
  message?: string;
  status: number;
  data: {
    channel: ChannelData;
    isLive: boolean;
    liveStream: TwitchStream | null;
    kpis: DashboardKpis;
    trend: DashboardTrendPoint[];
    streamHistory: DashboardStreamHistoryPoint[];
    subsProgress: number;
    monthlyGoals: {
      followersGoal: number;
      followersCurrent: number;
      followersGoal: number;
    },
    premiumFeatures: string[];
    activeSubs: number;
    avgViewers30d: number;
    streamerRank?: {
      globalRank: number;
      categoryRank: number;
    }
  };
}

export interface LiveStatusResponse {
  error: boolean;
  message?: string;
  status: number;
  data: {
    isLive: boolean;
    checkedAt: string;
    stream: TwitchStream | null;
  };
}

export interface AccessResponse {
  error: boolean;
  message?: string;
  status: number;
  data: {
    allowed: boolean;
    role: 'owner' | 'admin';
    channelID: string;
    channelName: string;
    planTier: 'free' | 'premium' | 'pro';
  };
}
```

### 2.3 Chart Config Service

**File:** `/home/cdom/saas/dimasite/src/app/core/services/dashboard-chart-config.service.ts`

```typescript
import { Injectable } from '@angular/core';
import { ThemeService } from './theme.service';

export type ChartColorPalette = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class DashboardChartConfigService {
  constructor(private themeService: ThemeService) {}

  getColors(): ChartColorPalette {
    return this.themeService.isDarkMode() ? 'dark' : 'light';
  }

  getChartTheme() any {
    const isDark = this.themeService.isDarkMode();
    return {
      backgroundColor: 'transparent',
      textColor: isDark ? '#f4edff' : '#27272a',
      axisColor: isDark ? '#71717a' : '#71717a',
      gridColor: isDark ? 'rgba(113,113,122,0.05)' : 'rgba(0,0,0,0.05)',
      tooltip: {
        backgroundColor: isDark ? '#1f1430' : '#ffffff',
        borderColor: isDark ? '#422555' : '#d4d4d4',
        textStyle: { color: isDark ? '#e5e5e5' : '#27272a' }
      },
      dataZoom: [
        {
          type: 'inside',
          dataZoom: [0, 10],
          range: [1, 100],
          textStyle: { fontSize: 12 }
        }
      ]
    };
  }

  getLineChartOptions(): any {
    return {
      ...this.getChartTheme(),
      grid: {
        left: { show: false },
        bottom: { show: false }
      },
      xAxis: {
        type: 'time',
        axisLabel: {
          color: '#71717a'
        },
        axisPointer: {
          type: 'shadow'
        }
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: '#71717a'
        },
        splitLine: {
          show: true,
          lineStyle: { width: 2, type: 'solid' }
        }
      },
      animation: true,
      animationDuration: 500,
      animationEasing: 'cubicOutIn',
      tooltip: {
        trigger: 'axis'
      }
    };
  }

  getAreaChartOptions(): any {
    return {
      ...this.getChartTheme(),
      xAxis: {
        type: 'time',
        boundaryGap: '0',
        axisPointer: {
          type: 'cross'
        }
      },
      yAxis: {
        type: 'value',
        splitLine: {
          show: false
        }
      },
      tooltip: {
        trigger: 'axis'
      },
      series: [
        {
          type: 'line',
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              colorStops: [
                { offset: 0, color: 'rgba(139, 92, 246, 0.3)' },
                { offset: 1, color: 'rgba(139, 92, 246, 0.1)' }
              ]
            }
          },
          lineStyle: { width: 2, type: 'solid' },
          emphasis: 'focus'
        }
      ]
    };
  }

  getBarChartOptions(): any {
    return {
      ...this.getChartTheme(),
      xAxis: {
        type: 'category',
        axisTick: { interval: 0 }
      },
      yAxis: {
        type: 'value',
        splitLine: { show: false }
      },
      tooltip: {
        trigger: 'item',
        axisPointer: { type: 'shadow' }
      }
    };
  }

  getGaugeChartOptions(): any {
    return {
      ...this.getChartTheme(),
      series: [{
        type: 'gauge',
        startAngle: 90,
        endAngle: -270,
        min: 0,
        max: 100,
        splitNumber: 10,
        axisLine: { lineStyle: { width: 2, color: '#71717a' } },
        progress: {
          show: true,
          itemStyle: { color: '#71717a' }
        },
        axisLabel: { show: false },
        detail: { show: false },
        data: [{ value: 50, name: '' }] }
      }];
  }
}
```

---

## Phase 3: Dashboard Component

### 3.1 Component Structure

**File:** `/home/cdom/saas/dimasite/src/app/features/dashboard/dashboard.component.ts`

```typescript
import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { NgxEchartsModule } from 'ngx-echarts';
import { EChartsOption } from 'echarts/core';
import { DashboardApiService } from '../../core/services/dashboard-api.service';
import { DashboardApiService, DashboardKpis, DashboardTrendPoint, DashboardStreamHistoryPoint } from '../../core/services/dashboard-api.service';
import { DashboardChartConfigService } from '../../core/services/dashboard-chart-config.service';
import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';
import { UserService } from '../../core/services/user.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    NgxEchartsModule
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
  changeDetection: 0
})
export class DashboardComponent implements OnInit, OnDestroy {
  // Injected services
  private route = inject(ActivatedRoute);
  private dashboardApi = inject(DashboardApiService);
  private chartConfig = inject(DashboardChartConfigService);
  private languageService = inject(LanguageService);
  private themeService = inject(ThemeService);
  private userService = inject(UserService);

  // Route params
  readonly channelID = computed(() => this.route.snapshot.paramMap.get('streamer') || '');

  // State signals
  readonly bootstrapData = signal<DashboardBootstrapResponse | null>(null);
  readonly liveStatus = signal<LiveStatusResponse | null>(null);
  readonly isLoading = signal(true);
  readonly connectionStatus = computed(() => this.dashboardApi.connectionStatus());
  readonly selectedTimeRange = signal<TimeRange>('7d');

  // Computed values for charts
  readonly kpis = computed(() => this.bootstrapData()?.data?.kpis || this.getEmptyKpis());
  readonly trendData = computed(() => this.bootstrapData()?.data?.trend || []);
  readonly streamHistoryData = computed(() => this.bootstrapData()?.data?.streamHistory || []);
  readonly liveStreamInfo = computed(() => this.bootstrapData()?.data?.liveStream);

  // Chart refs
  private viewersLineChartOption = {} as EChartsOption;
  private viewersAreaChartOption = {} as EChartsOption;
  private streamUptimeGaugeOption = {} as EChartsOption;
  private viewersBarChartOption = {} as EChartsOption;

  ngOnInit(): void {
    this.initCharts();
    this.loadDashboardData();
  }

  ngOnDestroy(): void {
    this.dashboardApi.dispose();
  }

  private initCharts(): void {
    this.viewersLineChartOption = this.chartConfig.getLineChartOptions();
    this.viewersAreaChartOption = this.chartConfig.getAreaChartOptions();
    this.streamUptimeGaugeOption = this.chartConfig.getGaugeChartOptions();
    this.viewersBarChartOption = this.chartConfig.getBarChartOptions();
  }

  private loadDashboardData(): void {
    this.isLoading.set(true);

    this.dashboardApi.getBootstrap(this.channelID() || '').subscribe({
      next: (response) => {
        if (response.data) {
          this.bootstrapData.set(response);
          this.isLoading.set(false);
          this.updateCharts();
        }
      },
      error: (error) => console.error('Dashboard load failed:', error),
      complete: () => this.isLoading.set(false)
    });
  }

  private updateCharts(): void {
    const data = this.bootstrapData()?.data;
    if (!data) return;

    // Update viewers line chart
    this.viewersLineChartOption = {
      ...this.chartConfig.getLineChartOptions(),
      series: [{
        data: data.trend.map(point => [point.date, point.viewers, point.hours]),
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: { color: { type: 'linear' } }
      }]
    };

    // Update viewers area chart
    this.viewersAreaChartOption = {
      ...this.chartConfig.getAreaChartOptions(),
      series: [{
        data: data.trend.map(point => [point.date, point.viewers]),
        type: 'line',
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            colorStops: [
              { offset: 0, color: 'rgba(139, 92, 246, 0.8)' },
              { offset: 1, color: 'rgba(139, 92, 246, 0.3)' }
            ]
          }
        }
      }]
    };

    // Update uptime gauge (assuming 30d goal)
    const uptimePercentage = this.calculateUptimePercentage(data.streamUptimeMinutes);
    this.streamUptimeGaugeOption = {
      ...this.chartConfig.getGaugeChartOptions(),
      series: [{
        data: [{ value: uptimePercentage, name: this.t('dashboard.kpis.streamUptimePercentage') || 'Stream Uptime' }],
        detail: {
          valueFormatter: (value: number) => `${Math.round(value)}%`
        }
      }]
    };
  }

  private calculateUptimePercentage(totalMinutes: number): number {
    // Assuming 12 hour daily goal (720 minutes)
    const dailyGoal = 720;
    return Math.min((totalMinutes / dailyGoal) * 100, 100);
  }

  private getEmptyKpis(): DashboardKpis {
    return {
      activeViewers: 0,
      averageViewers30d: 0,
      peakViewers30d: 0,
      activeFollowers: 0,
      averageFollowers30d: 0,
      activeSubs: 0,
      avgViewers30d: 0,
      activeDonations: 0,
      totalBits: 0,
      totalDonations30d: 0,
      totalCommandsExecuted30d: 0,
      messagesReceived30d: 0,
      totalFollows30d: 0,
      streamUptimeMinutes: 0
    };
  }

  // Translation helper
  t(key: string): string {
    return this.languageService.translate(key);
  }

  getTimeRangeLabel(range: TimeRange): string {
    const labels: {
      '7d': this.t('dashboard.timeRange.last7Days'),
      '30d': this.t('dashboard.timeRange.last30Days'),
      '90d': this.t('dashboard.timeRange.last90Days'),
      'all': this.t('dashboard.timeRange.allTime')
    };
    return labels[range];
  }

  selectTimeRange(range: TimeRange): void {
    this.selectedTimeRange.set(range);
    // TODO: Update charts based on selected time range
  }
}
```

### 3.2 Template

**File:** `/home/cdom/saas/dimasite/src/app/features/dashboard/dashboard.component.html`

```html
<div class="dashboard-shell">
  <!-- Loading State -->
  @if (isLoading()) {
    <div class="dashboard-loading">
      <div class="loading-spinner"></div>
      <p>{{ t('dashboard.loading') }}</p>
    </div>
  }

  @else {
    <!-- Connection Status Banner -->
    @if (connectionStatus() !== 'connected') {
      <div class="connection-status" [class]="'connection-status--' + connectionStatus()">
        <span class="connection-status__icon"></span>
        <span class="connection-status__text">
          @switch (connectionStatus()) {
            @case ('connecting'): {
              {{ t('dashboard.connection.connecting') }}
            }
            @case ('disconnected'): {
              {{ t('dashboard.connection.disconnected') }}
            }
            @case ('reconnecting'): {
              {{ t('dashboard.connection.reconnecting') }}
            }
          }
        </span>
      </div>
    </div>

    <!-- KPIs Grid -->
    <section class="dashboard-section">
      <div class="section-header">
        <h2 class="section-title">{{ t('dashboard.kpis.title') }}</h2>
      </div>

      <div class="kpis-grid">
        <!-- Active Viewers Card -->
        <div class="kpi-card kpi-card--primary">
          <div class="kpi-card__header">
            <lucide-users class="kpi-icon" [ngStyle]="{ color: '#8b5cf6' }"></lucide-users>
            <h3 class="kpi-label">{{ t('dashboard.kpis.activeViewers') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().activeViewers">0</div>
        </div>

        <!-- Average Viewers Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-bar-chart-2 class="kpi-icon" [ngStyle]="{ color: '#a855f7' }"></lucide-bar-chart-2>
            <h3 class="kpi-label">{{ t('dashboard.kpis.averageViewers') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().averageViewers30d">0</div>
          <p class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Peak Viewers Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-trending-up class="kpi-icon" [ngStyle]="{ color: '#c084fc' }"></lucide-trending-up>
            <h3 class="kpi-label">{{ t('dashboard.kpis.peakViewers') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().peakViewers30d">0</div>
          <p class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Active Follows Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-heart class="kpi-icon" [ngStyle]="{ color: '#ef4444' }"></lucide-heart>
            <h3 class="kpi-label">{{ t('dashboard.kpis.activeFollows') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().activeFollows">0</div>
        </div>

        <!-- Average Follows Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-heart class="kpi-icon" [ngStyle]="{ color: '#f472b6' }"></lucide-heart>
            <h3 class="kpi-label">{{ t('dashboard.kpis.averageFollows') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().averageFollowers30d">0</div>
          <p class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Active Subs Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-star class="kpi-icon" [ngStyle]="{ color: '#fbbf24' }"></lucide-star>
            <h3 class="kpi-label">{{ t('dashboard.kpis.activeSubs') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().activeSubs">0</div>
        </div>

        <!-- Avg Viewers 30d Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-users class="kpi-icon" [ngStyle]="{ color: '#06b6d4' }"></lucide-users>
            <h3 class="kpi-label">{{ t('dashboard.kpis.avgViewers') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().avgViewers30d">0</div>
          <p class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Total Bits Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-coins class="kpi-icon" [ngStyle]="{ color: '#f59e0b' }"></lucide-coins>
            <h3 class="kpi-label">{{ t('dashboard.kpis.totalBits') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().totalBits">0</div>
          <div class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Total Donations Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-gift class="kpi-icon" [ngStyle]="{ color: '#10b981' }"></lucide-gift>
            <h3 class="kpi-label">{{ t('dashboard.kpis.totalDonations') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().totalDonations)">$0</div>
          <div class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Commands Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-terminal class="kpi-icon" [ngStyle]="{ color: '#14b8a6' }"></lucide-terminal>
            <h3 class="kpi-label">{{ t('dashboard.kpis.commandsExecuted') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().totalCommandsExecuted30d">0</div>
          <div class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Messages Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-message-square class="kpi-icon" [ngStyle]="{ color: '#06b6d4' }"></lucide-message-square>
            <h3 class="kpi-label">{{ t('dashboard.kpis.messagesReceived') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().messagesReceived30d">0</div>
          <div class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Follows Card -->
        <div class="kpi-card">
          <div class="kpi-card__header">
            <lucide-user-plus class="kpi-icon" [ngStyle]="{ color: '#22c55e' }"></lucide-user-plus>
            <h3 class="kpi-label">{{ t('dashboard.kpis.totalFollows') }}</h3>
          </div>
          <div class="kpi-value" [countUp]="kpis().totalFollows30d">0</div>
          <div class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>

        <!-- Stream Uptime Card -->
        <div class="kpi-card kpi-card--highlight">
          <div class="kpi-card__header">
            <lucide-clock class="kpi-icon" [ngStyle]="{ color: '#8b5cf6' }"></lucide-clock>
            <h3 class="kpi-label">{{ t('dashboard.kpis.streamUptime') }}</h3>
          </div>
          <div class="kpi-value">{{ kpis().streamUptimeMinutes | durationFormat }}</div>
          <p class="kpi-sublabel">{{ t('dashboard.kpis.last30Days') }}</p>
        </div>
        </div>
      </div>
    </section>

    <!-- Charts Section -->
    <section class="dashboard-section">
      <div class="section-header">
        <h2 class="section-title">{{ t('dashboard.charts.title') }}</h2>
        <div class="time-range-selector">
          @for (range of ['7d', '30d', '90d', 'all']; track range) {
            <button
              type="button"
              class="range-btn"
              [class]="'range-btn--active' : ''"
              (click)="selectTimeRange(range)"
            >
              {{ getTimeRangeLabel(range as TimeRange) }}
            </button>
          }
        }
      </div>

      <!-- Viewers Line Chart -->
      <div class="chart-container">
        <h3 class="chart-title">{{ t('dashboard.charts.viewersOverTime') }}</h3>
        <div echarts [ngStyle]="{ height: '400px' }" [options]="viewersLineChartOption"></echarts>
      </div>

      <!-- Viewers Area Chart -->
      <div class="chart-container">
        <h3 class="chart-title">{{ t('dashboard.charts.viewersAreaChart') }}</h3>
        <div echarts [ngStyle]="{ height: '400px' }" [options]="viewersAreaChartOption"></echarts>
      </div>

      <!-- Stream Uptime Gauge -->
      <div class="gauge-container">
        <h3 class="chart-title">{{ t('dashboard.charts.streamUptime') }}</h3>
        <div class="gauge-wrapper">
          <div echarts [ngStyle]="{ height: '300px' }" [options]="streamUptimeGaugeOption"></echarts>
          <p class="gauge-value">{{ Math.round(calculateUptimePercentage()) }}%</p>
          <p class="gauge-label">{{ t('dashboard.charts.monthlyGoal') }}</p>
        </div>
      </div>
    </section>

    <!-- Live Status Section -->
    <section class="dashboard-section">
      <div class="section-header">
        <h2 class="section-title">{{ t('dashboard.liveStatus.title') }}</h2>
      </div>

      <div class="live-status-container">
        @if (liveStatus()?.data?.isLive) {
          <div class="live-status live-status--live">
            <span class="live-status__indicator"></span>
            <span class="live-status__text">{{ t('dashboard.liveStatus.live') }}</span>
          </div>
          <div class="stream-info">
            <h3 class="stream-info__title">{{ liveStreamInfo()?.title }}</h3>
            <p class="stream-info__game">{{ liveStreamInfo()?.game_name }}</p>
            <p class="stream-info__viewers">
              <lucide-eye class="icon"></lucide-eye>
              {{ t('dashboard.liveStatus.viewers') }}: {{ liveStreamInfo()?.viewer_count }}
            </p>
          </div>
        </div>
        @else {
          <div class="live-status live-status--offline">
            <span class="live-status__indicator"></span>
            <span class="live-status__text">{{ t('dashboard.liveStatus.offline') }}</span>
          </div>
          <div class="stream-info-placeholder">
            <p>{{ t('dashboard.liveStatus.noStream') }}</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>
```

### 3.3 Styles

**File:** `/home/cdom/saas/dimasite/src/app/features/dashboard/dashboard.component.css`

```css
:host {
  display: block;
}

.dashboard-shell {
  min-height: 100vh;
  padding: 2rem;
}

/* Loading State */
.dashboard-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}

.loading-spinner {
  width: 40px;
  height:  40px;
  border: 3px solid var(--color-primary);
  border-top: 3px solid var(--color-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  border-top-color: transparent;
  border-right-color: transparent;
}

@keyframes spin {
  to { transform: rotate(0deg); }
  from { transform: rotate(360deg); }
}

/* Connection Status */
.connection-status {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 1rem;
  margin-bottom: 2rem;
  border-radius: 0.5rem;
  font-weight: 600;
}

.connection-status--connecting {
  background: rgba(245, 158, 11, 0.1);
  color: #92400e;
}

.connection-status--disconnected {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.connection-status__icon {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.connection-status--connecting .connection-status__icon {
  animation: spin 1s linear infinite;
}

/* Dashboard Sections */
.dashboard-section {
  margin-bottom: 3rem;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--color-border);
}

.section-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-text);
  text-align: center;
}

.time-range-selector {
  display: flex;
  gap: 0.5rem;
}

.range-btn {
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  transition: all var(--transition-fast);
  cursor: pointer;
}

.range-btn:hover {
  background: var(--color-primary);
  color: #fff;
}

.range-btn--active {
  background: var(--color-primary);
  color: #fff;
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
}

/* KPIs Grid */
.kpis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}

.kpi-card {
  background: var(--color-surface-elevated);
  border-radius: 1rem;
  padding: 1.5rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transition: transform 0.2s var(--transition-base);
  border: 1px solid var(--color-border);
}

.kpi-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.kpi-card--primary {
  background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
  color: #fff;
  border-color: var(--color-primary);
}

.kpi-card--highlight {
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
  color: #fff;
  border-color: var(--color-primary);
  box-shadow: 0 8px 24px rgba(139, 92, 246, 0.25);
}

.kpi-card__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.kpi-icon {
  width: 1.5rem;
  height: 1.5rem;
}

.kpi-label {
  font-size: 0.875rem;
  font-weight:  600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.kpi-value {
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.1;
}

.kpi-sublabel {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.gauge-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
  background: var(--color-surface-alt);
  border-radius: 1rem;
}

.gauge-wrapper {
  width: 100%;
  max-width: 400px;
}

.gauge-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-text);
}

.gauge-label {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin-top: 0.5rem;
  text-align: center;
}

/* Charts */
.chart-container {
  background: var(--color-surface-elevated);
  border-radius: 1rem;
  padding: 1.5rem;
  margin-bottom: 2rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  border: 1px solid var(--color-border);
  min-height: 400px;
}

.chart-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 1rem;
}

/* Live Status */
.live-status-container {
  display: flex;
  align-items: center;
  gap: 2rem;
}

.live-status {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.5rem 2rem;
  border-radius: 1rem;
  font-size: 1.125rem;
  font-weight: 600;
}

.live-status--live {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
}

.live-status--offline {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.live-status__indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #22c55e;
}

.live-status--live .live-status__indicator {
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
   50% {
    opacity: 0.5;
    transform: scale(1.2);
  }
}

.stream-info {
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  text-align: center;
}

.stream-info__title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--color-text);
}

.stream-info__game {
  font-size: 0.9rem;
  color: var(--color-text-muted);
}

.stream-info__viewers {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--color-text);
}

.stream-info-placeholder {
  padding: 2rem;
  text-align: center;
  color: var(--color-text-muted);
}

/* Dark Mode Overrides */
.dark .kpi-card {
  background: rgba(39, 39, 42, 0.8);
  border-color: rgba(139, 92, 246, 0.2);
}

.dark .chart-container {
  background: rgba(31, 41, 55, 0.8);
  border-color: rgba(139, 92, 246, 0.2);
}

.dark .gauge-container {
  background: rgba(31, 41, 55, 0.8);
}

.dark .live-status--live {
  background: rgba(22, 163, 74, 0.1);
  color: #4ade80;
}

.dark .live-status--offline {
  background: rgba(15, 15, 20, 0.1);
  color: #fca5a5;
}
```

---

## Phase 4: Translation Files

### English

**File:** `/home/cdom/saas/dimasite/src/assets/i18n/en.json` (append to existing)

```json
{
  "dashboard": {
    "title": "Dashboard",
    "loading": "Loading dashboard...",
    "connection": {
      "connecting": "Connecting to dashboard...",
      "disconnected": "Disconnected from dashboard",
      "reconnecting": "Reconnecting..."
    },
    "kpis": {
      "title": "Key Performance Indicators",
      "activeViewers": "Active Viewers",
      "averageViewers": "Average Viewers",
      "peakViewers": "Peak Viewers",
      "last30Days": "(last 30 days)",
      "activeFollows": "Active Followers",
      "averageFollowers": "Average Followers",
      "activeSubs": "Active Subscribers",
      "avgViewers": "Avg Viewers (30d)",
      "totalBits": "Total Bits",
      "totalDonations": "Total Donations",
      "commandsExecuted": "Commands Executed",
      "messagesReceived": "Messages Received",
      "totalFollows": "Total Follows",
      "streamUptimePercentage": "Monthly Goal Progress"
    },
    "charts": {
      "title": "Analytics & Trends",
      "viewersOverTime": "Viewers Over Time",
      "viewersAreaChart": "Viewers (Area Chart)",
      "streamUptime": "Stream Uptime",
      "monthlyGoal": "Monthly Goal"
    },
    "liveStatus": {
      "title": "Live Status",
      "live": "Live",
      "offline": "Offline",
      "noStream": "No stream running",
      "viewers": "Viewers",
      "game": "Game"
    },
    "timeRange": {
      "last7Days": "Last 7 Days",
      "last30Days": "Last 30 Days",
      "last90Days": "Last 90 Days",
      "allTime": "All Time"
    }
  }
}
```

### Spanish

**File:** `/home/cdom/saas/dimasite/src/assets/i18n/es.json` (append to existing)

```json
{
  "dashboard": {
    "title": "Panel de Control",
    "loading": "Cargando panel de control...",
    "connection": {
      "connecting": "Conectando al panel...",
      "disconnected": "Desconectado del panel",
      "reconnecting": "Reconectando..."
    },
    "kpis": {
      "title": "Indicadores Clave de Rendimiento",
      "activeViewers": "Espectadores Activos",
      "averageViewers": "Espectadores Promedio",
      "peakViewers": "Pico de Espectadores",
      "last30Days": "(últimos 30 días)",
      "activeFollows": "Seguidores Activos",
      "averageFollowers": "Seguidores Promedio",
      "activeSubs": "Suscriptores Activos",
      "avgViewers": "Promedio de Espectadores (30d)",
      "totalBits": "Total de Bits",
      "totalDonations": "Total de Donaciones",
      "commandsExecuted": "Comandos Ejecutados",
      "messagesReceived": "Mensajes Recibidos",
      "totalFollows": "Total de Seguidores",
      "streamUptimePercentage": "Progreso Meta Mensual"
    },
    "charts": {
      "title": "Análisis y Tendencias",
      "viewersOverTime": "Espectadores a lo Largo del Tiempo",
      "viewersAreaChart": "Espectadores (Gráfico de Área)",
      "streamUptime": "Tiempo de Stream",
      "monthlyGoal": "Meta Mensual"
    },
    "liveStatus": {
      "title": "Estado del Stream",
      "live": "En Vivo",
      "offline": "Desconectado",
      "noStream": "No hay stream en curso",
      "viewers": "Espectadores",
      "game": "Juego"
    },
    "timeRange": {
      "last7Days": "Últimos 7 Días",
      "last30Days": "Últimos 30 Días",
      "last90Days": "Últimos 90 Días",
      "allTime": "Todo el Tiempo"
    }
  }
}
```

---

## Implementation Order

### Week 1 - Foundation

1. **Day 1-2**: Install chart library
   - `npm install ngx-echarts echarts`

2. **Day 3-4**: Update app.routes.ts
   - Add dashboard route with permission guard

3. **Day 5-7**: Create dashboard-access.guard.ts
   - Implement access checking logic

4. **Day 8-10**: Create dashboard models
   - Define all TypeScript interfaces

5. **Day 11-14**: Create dashboard-api.service.ts
   - Implement bootstrap, live status methods
   - WebSocket integration

6. **Day 15-17**: Create dashboard-chart-config.service.ts
   - Theme-aware chart configs

7. **Day 18-22**: Create dashboard.component.ts
   - Component logic with signals
   - Chart initialization
   - Data fetching

8. **Day 23-25**: Create dashboard.component.html
   - KPIs grid layout
   - Charts sections
   - Live status display

9. **Day 26-27**: Create dashboard.component.css
   - Responsive grid layouts
   - Dark mode support
   - Loading states

10. **Day 28-30**: Add translations
   - EN and ES dashboard keys
   - Update existing i18n files

### Week 2 - Integration

11. **Day 1-3**: Test with mock data
   - Verify charts render correctly
   - Test KPIs display
   - Test responsive layout
   - Test dark mode

12. **Day 4-7**: Connect to real API
   - Replace mock with real data
   - Test WebSocket connection
   - Verify live status updates
   - Test data refresh

13. **Day 8-10**: Add more charts
   - Stream history chart
  - Subscription trends
  - Command usage chart
  - Donation tracking

14. **Day 11-14**: Polish & Optimize
   - Performance tuning
   - Error handling
   - Loading states

---

## Testing Checklist

Before moving to next page (commands, settings, etc.), verify:

✅ Dashboard route loads with access check
✅ Bootstrap endpoint returns expected data
✅ WebSocket connects to dashboard namespace
✅ Live status updates received every 45s
✅ KPIs display correctly with count-up animations
✅ Charts render with correct data
✅ Line chart shows viewers trend over time
✅ Area chart fills area under line
✅ Gauge shows uptime percentage
✅ Time range selector updates charts
✅ Live status indicator shows current state
✅ Stream info displays when live
✅ Loading states show during data fetch
✅ Connection status shows and auto-reconnects
✅ Dark mode colors work correctly
✅ Mobile responsive grid (1 column on mobile)
✅ All translations display correctly (EN/ES)
✅ WebSocket reconnection works properly
✅ Data refresh on reload or via WebSocket
✅ Performance is acceptable (smooth 60fps)
✅ No memory leaks in chart disposal
✅ Error handling works (connection, API, chart)
✅ Plan tier indicators work (premium features if any)

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|-------|----------|
| Chart Library | ngx-echarts | Rich features, Angular integration, performant |
| State Management | Signals | Built-in reactive, no extra deps |
| API Client | HttpClient | Standard Angular pattern |
| WebSocket | Socket.IO | Already implemented service |
| Chart Updates | WebSocket (real-time) | Poll live status |
| Data Caching | 5-minute localStorage TTL | Reduce API calls |
| Error Handling | Try-catch | User-friendly messages |
| Authentication | Guard-based | Existing permission system |
| Responsive | Mobile-first | KPI cards stack 1 column |
| Dark Mode | CSS variables | Theme service |

---

## Files to Create

### Core Services:
- `/home/cdom/saas/dimasite/src/app/core/services/dashboard-api.service.ts` (~350 lines)
- `/home/cdom/saas/dimasite/src/app/core/services/dashboard-chart-config.service.ts` (~100 lines)
- `/home/cdom/saas/dimasite/src/app/core/models/dashboard.model.ts` (~150 lines)

### Guards:
- `/home/cdom/saas/dimasite/src/app/guards/dashboard-access.guard.ts` (~120 lines)

### Component:
- `/home/cdom/saas/dimasite/src/app/features/dashboard/dashboard.component.ts` (~200 lines)
- `/home/cdom/saas/dimasite/src/app/features/dashboard/dashboard.component.html` (~200 lines)
- `/home/com/saas/dimasite/src/app/features/dashboard/dashboard.component.css` (~400 lines)

### Translations:
- `/home/cdom/saas/dimasite/src/assets/i18n/en.json` (append dashboard section)
- `/home/cdom/saas/dimasite/src/assets/i18n/es.json` (append dashboard section)

### Updates:
- `/home/cdom/saas/dimasite/src/app/app.routes.ts` (add dashboard route)
- `/home/cdom/saas/dimasite/package.json` (add ngx-echarts)
- `/home/cdom/saas/dimasite/src/app/app.config.ts` (maybe add EChartsModule provider)

**Total: 7 files to create, 2 files to update**

---

## Next Steps After Dashboard

Once dashboard is complete and tested, next implementation plan should cover:

1. **Commands Module** - Command CRUD operations
2. **Settings Page** - User settings
3. **Modules Enhancement** - Improve existing modules (clips, chat events, etc.)

---

## Questions for Implementation

1. **Chart Library:** Should we use ngx-echarts or apexcharts? (recommending ngx-echarts)
2. **Time Ranges:** Should 7d/30d/90d include custom ranges, or preset options?
3. **KPIs:** Should we add more KPIs (e.g., chat rate, mod actions)?
4. **Charts:** Should we add more charts (e.g., subscription retention, command usage)?
5. **Mobile Charts:** How should charts behave on mobile (stack vertically, enable swiping)?
6. **Real-time Updates:** Should charts auto-refresh on WebSocket data, or only on manual time range change?
7. **Error States:** How should API errors be displayed to users?
8. **Data Persistence:** Should dashboard data be cached, or always fetch fresh?
9. **Accessibility:** Should charts have keyboard navigation and ARIA labels?
10. **Performance:** Target FPS for charts? Should animate on data change?

---

## Success Criteria

✅ Dashboard route accessible with proper permissions
✅ Bootstrap endpoint returns all required data
✅ WebSocket connection established and maintains connection
✅ Live status updates received every 45 seconds
✅ KPIs display correctly with formatted numbers
✅ Charts render with smooth animations
✅ Line chart shows viewers over selected time range
✅ Area chart shows filled area under line
✅ Gauge shows stream uptime percentage
✅ Time range selector updates all charts
✅ Live status indicator shows correct state (live/offline)
✅ Stream info displays when stream is live
✅ Loading states show and hide gracefully
✅ Connection status shows and auto-reconnects on failure
✅ Dark mode colors work correctly across dashboard
✅ Mobile responsive layout works on all breakpoints
✅ All translations display correctly in EN/ES
✅ Charts adapt to theme changes
✅ Performance is smooth (no jank during chart updates)
✅ WebSocket reconnection strategy works reliably
✅ Error handling is user-friendly
✅ Data caching reduces unnecessary API calls
✅ Chart disposal prevents memory leaks
✅ Plan tier indicators work (if any premium features exist)
✅ Access guard prevents unauthorized access
✅ System gracefully handles connection failures

---

## Notes for Builder AI

1. **Read API Contracts**: Refer to backend API contracts section for all endpoint schemas
2. **Use Existing Services**: Reuse WebSocketService, LinksService, UserService, LanguageService
3. **Follow Angular v21**: Use signals, standalone components, inject() function
4. **Keep It Modular**: Dashboard component should focus on display, not business logic
5. **Error Handling**: Try-catch everywhere, provide user-friendly messages
6. **Performance**: Lazy load charts only, dispose on destroy
7. **Test Thoroughly**: Test with real API data, not mock data
8. **Be Mobile-First**: KPI grid should stack on mobile
9. **Use Chart Docs**: Read ngx-echarts documentation for advanced usage
10. **Ask Questions**: If anything about API contracts, chart types, or features is unclear

---

Good luck implementing the dashboard! 📊📈📉
