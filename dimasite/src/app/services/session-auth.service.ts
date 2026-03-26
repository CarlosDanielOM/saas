import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, map, Observable, of, tap, throwError } from 'rxjs';

import { CheckoutIntentService } from './checkout-intent.service';
import { LinksService } from './links.service';
import { LanguageService, type SupportedLanguage } from './language.service';

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
  language?: SupportedLanguage | null;
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

interface StoredSessionRecord {
  version?: number;
  token?: string;
  createdAt?: string;
  expiresAt?: string;
  twitchUser?: TwitchUserProfile;
  appUser?: AppLoginData;
  permissions?: Record<string, boolean>;
}

export interface StoredSession {
  version: 2;
  token: string;
  createdAt: string;
  expiresAt: string;
  twitchUser: TwitchUserProfile;
  appUser: AppLoginData;
  permissions: Record<string, boolean>;
}

@Injectable({
  providedIn: 'root'
})
export class SessionAuthService {
  private readonly http = inject(HttpClient);
  private readonly checkoutIntent = inject(CheckoutIntentService);
  private readonly linksService = inject(LinksService);
  private readonly languageService = inject(LanguageService);
  private readonly storageKey = 'dimasite.session.v1';
  private readonly lastViewedStreamerKey = 'dimasite.last-viewed-streamer.v1';
  private readonly oauthStateKey = 'dimasite.oauth.state';
  private readonly sessionTtlMs = 230 * 60 * 1000;
  private readonly storageSyncHandler = (event: StorageEvent): void => {
    if (
      event.key !== null &&
      event.key !== this.storageKey &&
      event.key !== this.lastViewedStreamerKey
    ) {
      return;
    }

    this.session.set(this.readSession());
    this.lastViewedStreamer.set(this.readLastViewedStreamer());
  };

  readonly session = signal<StoredSession | null>(this.readSession());
  readonly lastViewedStreamer = signal<string | null>(this.readLastViewedStreamer());
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
    const referralCode = this.checkoutIntent.getPendingReferralCode();

    return this.http.post<ApiEnvelope<AppLoginData>>(`${this.linksService.getApiUrl()}/auth/login`, {
      id: twitchUser.id,
      name: twitchUser.display_name || twitchUser.login,
      email: twitchUser.email,
      language: this.languageService.getCurrentLanguage(),
      referralCode: referralCode || undefined
    });
  }

  fetchSessionFromServer(): Observable<ApiEnvelope<AuthSessionResponse>> {
    return this.http.get<ApiEnvelope<AuthSessionResponse>>(`${this.linksService.getApiUrl()}/auth/session`);
  }

  validateSession(): Observable<boolean> {
    const current = this.getSessionSnapshot();
    if (!current) {
      return of(false);
    }

    return this.fetchSessionFromServer().pipe(
      tap((response) => {
        if (response.error || !response.data) {
          return;
        }

        this.persistSession({
          ...current,
          appUser: response.data.app,
          twitchUser: response.data.twitch
        });
        this.syncLanguageFromSession(response.data.app.language);
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
          const allowed = Boolean(response.data?.allowed) && !response.error;
          this.cachePermissionDecision(key, allowed);
        }),
        map((response) => Boolean(response.data?.allowed) && !response.error),
        catchError((error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 403) {
            this.cachePermissionDecision(key, false);
            return of(false);
          }

          return throwError(() => error);
        })
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

    const current = this.getSessionSnapshot();
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
    const current = this.getSessionSnapshot();
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
      version: 2,
      token,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      twitchUser,
      appUser,
      permissions: {}
    });
    this.syncLanguageFromSession(appUser.language);
  }

  clearSession(): void {
    this.session.set(null);
    this.lastViewedStreamer.set(null);
    localStorage.removeItem(this.storageKey);
    localStorage.removeItem(this.lastViewedStreamerKey);
  }

  setLastViewedStreamer(streamer: string): void {
    const normalizedStreamer = streamer.trim().toLowerCase();
    if (!normalizedStreamer || !this.getSessionSnapshot()) {
      return;
    }

    if (this.lastViewedStreamer() === normalizedStreamer) {
      return;
    }

    this.lastViewedStreamer.set(normalizedStreamer);
    localStorage.setItem(this.lastViewedStreamerKey, normalizedStreamer);
  }

  getLastViewedStreamerSnapshot(): string | null {
    return this.lastViewedStreamer();
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

  private cachePermissionDecision(key: string, allowed: boolean): void {
    const existing = this.session();
    if (!existing) {
      return;
    }

    this.persistSession({
      ...existing,
      permissions: {
        ...existing.permissions,
        [key]: allowed
      }
    });
  }

  private readLastViewedStreamer(): string | null {
    const value = localStorage.getItem(this.lastViewedStreamerKey)?.trim().toLowerCase();
    return value || null;
  }

  private syncLanguageFromSession(language: SupportedLanguage | null | undefined): void {
    if (language === 'en' || language === 'es') {
      this.languageService.setLanguage(language);
    }
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
      appUser: session.appUser,
      permissions: session.permissions ?? {}
    };
  }

  private isSessionExpired(session: Pick<StoredSession, 'expiresAt'>): boolean {
    return Date.parse(session.expiresAt) <= Date.now();
  }
}
