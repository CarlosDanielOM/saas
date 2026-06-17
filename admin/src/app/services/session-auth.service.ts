import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, map, Observable, of, tap, throwError } from 'rxjs';

import { LinksService } from './links.service';

interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  code?: string;
  type?: string;
  data?: T;
}

export interface AuthLoginError extends Error {
  code?: string;
  errorType?: string;
  status?: number;
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

interface ExchangeCodeData {
  access_token: string;
  refresh_token: string;
  twitch_user: TwitchUserProfile;
  state: string | null;
}

interface StoredSessionRecord {
  version?: number;
  token?: string;
  createdAt?: string;
  expiresAt?: string;
  twitchUser?: TwitchUserProfile;
  appUser?: AppLoginData;
}

export interface StoredSession {
  version: 2;
  token: string;
  createdAt: string;
  expiresAt: string;
  twitchUser: TwitchUserProfile;
  appUser: AppLoginData;
}

@Injectable({
  providedIn: 'root'
})
export class SessionAuthService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly storageKey = 'dima-admin.session.v1';
  private readonly oauthStateKey = 'dima-admin.oauth.state';
  private readonly sessionTtlMs = 230 * 60 * 1000;

  private readonly storageSyncHandler = (): void => {
    this.session.set(this.readSession());
  };

  readonly session = signal<StoredSession | null>(this.readSession());
  readonly token = computed(() => this.session()?.token ?? null);
  readonly isAuthenticated = computed(() => Boolean(this.session()?.token));

  constructor() {
    window.addEventListener('storage', this.storageSyncHandler);
  }

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
    const normalizedLogin = (twitchUser.login || '').trim().toLowerCase();

    return this.http.post<ApiEnvelope<AppLoginData>>(`${this.linksService.getApiUrl()}/auth/login`, {
      id: twitchUser.id,
      name: normalizedLogin,
      login: normalizedLogin,
      email: twitchUser.email
    }).pipe(
      map((response) => {
        if (response.error || !response.data) {
          const error = new Error(response.message || 'Login failed') as AuthLoginError;
          error.code = response.code;
          error.errorType = response.type;
          error.status = response.status;
          throw error;
        }
        return response;
      })
    );
  }

  completeSession(token: string, twitchUser: TwitchUserProfile, appUser: AppLoginData): void {
    this.persistSession({
      version: 2,
      token,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      twitchUser,
      appUser
    });
  }

  clearSession(): void {
    this.session.set(null);
    localStorage.removeItem(this.storageKey);
  }

  hasValidSession(): boolean {
    return Boolean(this.getSessionSnapshot()?.token);
  }

  getSessionSnapshot(): StoredSession | null {
    const current = this.session();
    if (!current) {
      return null;
    }

    if (this.isSessionExpired(current)) {
      this.clearSession();
      return null;
    }

    return current;
  }

  getPrimaryChannelID(): string | null {
    const current = this.getSessionSnapshot();
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
      const parsed = JSON.parse(raw) as StoredSessionRecord;
      const normalized = this.normalizeStoredSession(parsed);

      if (!normalized) {
        localStorage.removeItem(this.storageKey);
        return null;
      }

      if (parsed.version !== normalized.version || parsed.expiresAt !== normalized.expiresAt) {
        localStorage.setItem(this.storageKey, JSON.stringify(normalized));
      }

      return normalized;
    } catch {
      localStorage.removeItem(this.storageKey);
      return null;
    }
  }

  private persistSession(session: StoredSession): void {
    this.session.set(session);
    localStorage.setItem(this.storageKey, JSON.stringify(session));
  }

  private normalizeStoredSession(session: StoredSessionRecord): StoredSession | null {
    if (!session.token || !session.createdAt || !session.twitchUser || !session.appUser) {
      return null;
    }

    const createdAtMs = Date.parse(session.createdAt);
    if (!Number.isFinite(createdAtMs)) {
      return null;
    }

    const expiresAtMs = session.expiresAt ? Date.parse(session.expiresAt) : createdAtMs + this.sessionTtlMs;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }

    return {
      version: 2,
      token: session.token,
      createdAt: session.createdAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      twitchUser: session.twitchUser,
      appUser: session.appUser
    };
  }

  private isSessionExpired(session: Pick<StoredSession, 'expiresAt'>): boolean {
    return Date.parse(session.expiresAt) <= Date.now();
  }
}