import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, map, Observable, of, tap } from 'rxjs';

import { LinksService } from './links.service';

interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

interface TwitchUserProfile {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
  email?: string;
}

interface AppLoginData {
  name: string;
  email: string;
  plan_tier: 'free' | 'premium' | 'pro';
  plan_tier_until?: string | null;
  actived: boolean;
  chat_enabled: boolean;
  twitch_user_id: string;
  has_permissions: boolean;
  up_to_date_permissions: boolean;
  administrating: Array<{ channelID: string; channelName: string }>;
}

interface AuthSessionResponse {
  twitch: TwitchUserProfile;
  app: AppLoginData;
}

interface ExchangeCodeData {
  access_token: string;
  refresh_token: string;
  twitch_user: TwitchUserProfile;
  state: string | null;
}

export interface StoredSession {
  version: 1;
  token: string;
  createdAt: string;
  twitchUser: TwitchUserProfile;
  appUser: AppLoginData;
  permissions: Record<string, boolean>;
}

@Injectable({
  providedIn: 'root'
})
export class SessionAuthService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly storageKey = 'dimasite.session.v1';
  private readonly oauthStateKey = 'dimasite.oauth.state';

  readonly session = signal<StoredSession | null>(this.readSession());
  readonly token = computed(() => this.session()?.token ?? null);
  readonly isAuthenticated = computed(() => Boolean(this.session()?.token));

  startTwitchLogin(): void {
    const state = this.createOAuthState();
    localStorage.setItem(this.oauthStateKey, state);
    window.location.href = this.linksService.getTwitchAuthUrl(state);
  }

  consumeOAuthState(): string | null {
    const value = localStorage.getItem(this.oauthStateKey);
    localStorage.removeItem(this.oauthStateKey);
    return value;
  }

  exchangeCode(code: string, state: string | null): Observable<ApiEnvelope<ExchangeCodeData>> {
    return this.http.post<ApiEnvelope<ExchangeCodeData>>(`${this.linksService.getApiUrl()}/auth/exchange-code`, {
      code,
      state,
      redirectUri: `${window.location.origin}/login`
    });
  }

  loginWithTwitchUser(twitchUser: TwitchUserProfile): Observable<ApiEnvelope<AppLoginData>> {
    return this.http.post<ApiEnvelope<AppLoginData>>(`${this.linksService.getApiUrl()}/auth/login`, {
      id: twitchUser.id,
      name: twitchUser.display_name || twitchUser.login,
      email: twitchUser.email
    });
  }

  fetchSessionFromServer(): Observable<ApiEnvelope<AuthSessionResponse>> {
    return this.http.get<ApiEnvelope<AuthSessionResponse>>(`${this.linksService.getApiUrl()}/auth/session`);
  }

  validateSession(): Observable<boolean> {
    return this.fetchSessionFromServer().pipe(
      tap((response) => {
        if (response.error || !response.data || !this.session()) {
          return;
        }

        const current = this.session();
        if (!current) {
          return;
        }

        this.persistSession({
          ...current,
          appUser: response.data.app,
          twitchUser: response.data.twitch
        });
      }),
      map((response) => !response.error && Boolean(response.data))
    );
  }

  checkPermission(channelID: string, permission: string): Observable<boolean> {
    const key = `${channelID}:${permission}`;
    return this.http
      .get<ApiEnvelope<{ allowed: boolean }>>(
        `${this.linksService.getApiUrl()}/auth/access/${channelID}?permission=${encodeURIComponent(permission)}`
      )
      .pipe(
        tap((response) => {
          const existing = this.session();
          if (!existing) {
            return;
          }

          const allowed = Boolean(response.data?.allowed) && !response.error;
          this.persistSession({
            ...existing,
            permissions: {
              ...existing.permissions,
              [key]: allowed
            }
          });
        }),
        map((response) => Boolean(response.data?.allowed) && !response.error)
      );
  }

  resolveChannelID(streamerParam: string): Observable<string | null> {
    const normalizedParam = streamerParam.trim().toLowerCase();
    if (!normalizedParam) {
      return of(null);
    }

    if (/^\d+$/.test(normalizedParam)) {
      return of(normalizedParam);
    }

    const current = this.session();
    if (current) {
      const ownLogin = (current.twitchUser.login || '').trim().toLowerCase();
      if (ownLogin && ownLogin === normalizedParam) {
        return of(current.appUser.twitch_user_id);
      }

      for (const adminChannel of current.appUser.administrating) {
        const byName = (adminChannel.channelName || '').trim().toLowerCase();
        const byId = (adminChannel.channelID || '').trim().toLowerCase();
        if (byName === normalizedParam || byId === normalizedParam) {
          return of(adminChannel.channelID);
        }
      }
    }

    return this.http
      .get<ApiEnvelope<{ id: string; username: string }>>(
        `${this.linksService.getApiUrl()}/users?username=${encodeURIComponent(normalizedParam)}`
      )
      .pipe(
        map((response) => response.data?.id ?? null),
        catchError(() => of(null))
      );
  }

  toRouteStreamer(channelID: string, fallbackName?: string): string {
    const current = this.session();
    if (!current) {
      return fallbackName?.trim().toLowerCase() || channelID;
    }

    if (current.appUser.twitch_user_id === channelID) {
      return (current.twitchUser.login || '').trim().toLowerCase() || channelID;
    }

    const adminChannel = current.appUser.administrating.find((entry) => entry.channelID === channelID);
    if (adminChannel) {
      return (adminChannel.channelName || '').trim().toLowerCase() || channelID;
    }

    return fallbackName?.trim().toLowerCase() || channelID;
  }

  completeSession(token: string, twitchUser: TwitchUserProfile, appUser: AppLoginData): void {
    this.persistSession({
      version: 1,
      token,
      createdAt: new Date().toISOString(),
      twitchUser,
      appUser,
      permissions: {}
    });
  }

  clearSession(): void {
    this.session.set(null);
    localStorage.removeItem(this.storageKey);
  }

  getPrimaryChannelID(): string | null {
    const current = this.session();
    if (!current) {
      return null;
    }

    return current.appUser.twitch_user_id || current.twitchUser.id || null;
  }

  private createOAuthState(): string {
    return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  }

  private readSession(): StoredSession | null {
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  private persistSession(session: StoredSession): void {
    this.session.set(session);
    localStorage.setItem(this.storageKey, JSON.stringify(session));
  }
}
