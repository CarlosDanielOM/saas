import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router } from '@angular/router';
import posthog from 'posthog-js';
import { filter } from 'rxjs';

import { environment } from '../../environments/environment';
import { SessionAuthService, StoredSession } from './session-auth.service';

type AnalyticsPrimitive = string | number | boolean | null | undefined;
type AnalyticsProperties = Record<string, AnalyticsPrimitive>;

function privateSourcePath(path: string): boolean {
  try { path = decodeURIComponent(path.split(/[?#]/)[0]); } catch { /* Match a malformed path conservatively below. */ }
  return /^\/(?:pet|overlays)(?:\/|$)/.test(path);
}
const privateSourceUrl = /(^|[\s"'(<=>\[])(?:https?:\/\/[^\s/"'<>]+)?\/(?:pet|overlays)(?=\/|[?#]|$)[^\s"'<>]*/g;
// The SDK adds previous-page/referrer/session-entry properties itself. Scrub
// those too when a later public event follows a private browser-source route.
function redactPrivateSourceUrls(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const redacted = value.replace(privateSourceUrl, '$1/private-source');
    if (redacted !== value) return redacted;
    try {
      const decoded = decodeURIComponent(value), safe = decoded.replace(privateSourceUrl, '$1/private-source');
      return safe !== decoded ? safe : value;
    } catch { return value; }
  }
  if (depth > 16) return null;
  if (Array.isArray(value)) return value.map(item => redactPrivateSourceUrls(item, depth + 1));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPrivateSourceUrls(item, depth + 1)]));
  }
  return value;
}

@Injectable({
  providedIn: 'root'
})
export class AnalyticsService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly title = inject(Title);

  private readonly initialized = signal(false);
  private trackingStarted = false;
  private lastTrackedUrl: string | null = null;
  private hasIdentifiedUser = false;
  private privateNavigation = false;
  private recordingPaused = false;

  constructor() {
    effect(() => {
      if (!this.initialized() || !this.isBrowser() || this.isPrivateOverlay()) {
        return;
      }

      const session = this.sessionAuth.session();
      if (!session) {
        if (this.hasIdentifiedUser) {
          posthog.reset();
          this.hasIdentifiedUser = false;
        }
        return;
      }

      const distinctId = session.appUser.twitch_user_id || session.twitchUser.id;
      if (!distinctId) {
        return;
      }

      posthog.identify(distinctId, this.buildIdentifyProperties(session));
      this.hasIdentifiedUser = true;
    });
  }

  initialize(): void {
    if (!this.isBrowser() || this.initialized() || this.isPrivateOverlay()) {
      return;
    }

    posthog.init(environment.POSTHOG_KEY, {
      api_host: environment.POSTHOG_HOST,
      defaults: environment.POSTHOG_DEFAULTS,
      capture_pageview: false,
      capture_pageleave: true,
      // Source capabilities must never enter analytics, including pageleave and
      // SDK-generated previous/referrer properties on a later public route.
      autocapture: { url_ignorelist: [/\/(?:pet|overlays)(?:\/|$)/] },
      before_send: event => !event || this.isPrivateOverlay() ? null :
        { ...event, properties: redactPrivateSourceUrls(event.properties) as typeof event.properties },
    });

    if (this.shouldDisableCapture()) {
      posthog.opt_out_capturing();
    }

    this.initialized.set(true);
    this.startRouteTracking();
    queueMicrotask(() => {
      this.capturePageView(this.router.url || window.location.pathname);
    });
  }

  capture(eventName: string, properties: AnalyticsProperties = {}): void {
    if (!this.canTrack()) {
      return;
    }

    posthog.capture(eventName, {
      ...this.buildSharedProperties(),
      ...properties,
    });
  }

  private startRouteTracking(): void {
    if (this.trackingStarted) {
      return;
    }

    this.trackingStarted = true;
    this.router.events
      .pipe(
        filter(event => event instanceof NavigationStart || event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(event => {
        if (event instanceof NavigationStart) {
          this.privateNavigation = privateSourcePath(event.url);
          if (this.privateNavigation && !this.recordingPaused && posthog.config.disable_session_recording !== true) {
            this.recordingPaused = true; posthog.stopSessionRecording();
          }
          return;
        }
        this.privateNavigation = event instanceof NavigationEnd ? privateSourcePath(event.urlAfterRedirects) : privateSourcePath(window.location.pathname);
        if (!this.privateNavigation && this.recordingPaused) { this.recordingPaused = false; posthog.startSessionRecording(); }
        if (event instanceof NavigationEnd) this.capturePageView(event.urlAfterRedirects);
      });
  }

  private capturePageView(url: string): void {
    const normalizedUrl = this.normalizeUrl(url);

    if (!this.canTrack() || this.lastTrackedUrl === normalizedUrl) {
      return;
    }

    this.lastTrackedUrl = normalizedUrl;
    posthog.capture('$pageview', {
      ...this.buildSharedProperties(normalizedUrl),
      $current_url: window.location.href,
    });
  }

  private buildIdentifyProperties(session: StoredSession): AnalyticsProperties {
    return {
      email: session.twitchUser.email || session.appUser.email,
      name: session.twitchUser.display_name || session.appUser.name || session.twitchUser.login,
      username: session.twitchUser.login,
      display_name: session.twitchUser.display_name,
      twitch_user_id: session.appUser.twitch_user_id || session.twitchUser.id,
      plan_tier: session.appUser.plan_tier,
      actived: session.appUser.actived,
      chat_enabled: session.appUser.chat_enabled,
      has_permissions: session.appUser.has_permissions,
      up_to_date_permissions: session.appUser.up_to_date_permissions,
      administrating_count: session.appUser.administrating.length,
      preferred_language: session.appUser.language ?? undefined,
    };
  }

  private buildSharedProperties(url = this.router.url): AnalyticsProperties {
    const session = this.sessionAuth.getSessionSnapshot();
    const snapshot = this.getDeepestSnapshot(this.router.routerState.snapshot.root);
    const streamer = this.findParam(this.router.routerState.snapshot.root, 'streamer');
    const refCode = this.findParam(this.router.routerState.snapshot.root, 'refCode');
    const authenticatedAccessRole = this.resolveAuthenticatedAccessRole(session, streamer, url);

    return {
      page_category: this.resolvePageCategory(url),
      route_path: snapshot.routeConfig?.path ?? '',
      route_title: this.title.getTitle() || undefined,
      current_path: url,
      streamer: streamer || undefined,
      referral_code: refCode || undefined,
      authenticated: Boolean(session),
      plan_tier: session?.appUser.plan_tier ?? 'anonymous',
      viewer_channel_id: session?.appUser.twitch_user_id ?? session?.twitchUser.id ?? undefined,
      authenticated_access_role: authenticatedAccessRole,
    };
  }

  private resolveAuthenticatedAccessRole(
    session: StoredSession | null,
    streamer: string | null,
    url: string
  ): AnalyticsPrimitive {
    if (!session) {
      return 'anonymous';
    }

    const normalizedStreamer = streamer?.trim().toLowerCase();
    const ownerLogin = session.twitchUser.login?.trim().toLowerCase();
    const ownerChannelID = session.appUser.twitch_user_id?.trim().toLowerCase();

    if (!normalizedStreamer) {
      return this.resolvePageCategory(url) === 'authenticated' ? 'authenticated' : undefined;
    }

    if (normalizedStreamer === ownerLogin || normalizedStreamer === ownerChannelID) {
      return 'owner';
    }

    return 'admin';
  }

  private getDeepestSnapshot(snapshot: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
    let current = snapshot;
    while (current.firstChild) {
      current = current.firstChild;
    }

    return current;
  }

  private findParam(snapshot: ActivatedRouteSnapshot, key: string): string | null {
    let current: ActivatedRouteSnapshot | null = snapshot;
    while (current) {
      const value = current.paramMap.get(key);
      if (value) {
        return value;
      }
      current = current.firstChild;
    }

    return null;
  }

  private resolvePageCategory(url: string): string {
    if (!url || url === '/') {
      return 'landing';
    }

    if (url.startsWith('/login')) {
      return 'login';
    }

    if (url.startsWith('/commands/')) {
      return 'public_commands';
    }

    if (url.startsWith('/tip/')) {
      return 'tip';
    }

    if (url.startsWith('/r/')) {
      return 'referral';
    }

    const errorPages: Record<string, string> = {
      '/401': 'unauthorized',
      '/500': 'server_error',
      '/503': 'unavailable'
    };
    const errorPage = errorPages[url.split('?')[0]];
    if (errorPage) {
      return errorPage;
    }

    if (url.startsWith('/403')) {
      return 'forbidden';
    }

    if (url.startsWith('/404')) {
      return 'not_found';
    }

    const segments = url.split('?')[0].split('/').filter(Boolean);
    return segments[1] || 'authenticated';
  }

  private normalizeUrl(url: string): string {
    return url.split('#')[0]?.split('?')[0] || '/';
  }

  private canTrack(): boolean {
    return this.initialized() && this.isBrowser() && !this.shouldDisableCapture();
  }

  private shouldDisableCapture(): boolean {
    if (!this.isBrowser()) {
      return true;
    }

    return this.isPrivateOverlay() || ['localhost', '127.0.0.1', 'dima.local'].includes(window.location.hostname);
  }

  private isPrivateOverlay(): boolean {
    return this.isBrowser() && (this.privateNavigation || privateSourcePath(window.location.pathname));
  }

  private isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }
}
