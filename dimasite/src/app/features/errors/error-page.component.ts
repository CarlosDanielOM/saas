import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  KeyRound,
  LockKeyhole,
  LucideAngularModule,
  Moon,
  RefreshCw,
  Sun,
  type LucideIconData
} from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { CHANNEL_ADMIN_PERMISSION_GROUPS } from '../settings/channel-admin-permissions';

export type ErrorCode = '401' | '403' | '404' | '500' | '503';

type RouterLinkValue = string | string[];

interface ErrorAction {
  label: string;
  link?: RouterLinkValue;
  action?: 'retry' | 'back';
  icon?: LucideIconData;
}

const ERROR_CODES: readonly ErrorCode[] = ['401', '403', '404', '500', '503'];
/** Seconds before the 503 page retries on its own. */
const AUTO_RETRY_SECONDS = 30;

/**
 * One page for every error state (401/403/404/500/503). Route data: `code`, and
 * `embeddedLayout` when rendered inside the authenticated shell (no own navbar).
 * Query params: `from` (the page that failed), `permission` (403), `reason=expired` (401).
 */
@Component({
  selector: 'app-error-page',
  imports: [RouterLink, LucideAngularModule, BrandLogoComponent],
  templateUrl: './error-page.component.html',
  styleUrl: './error-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ErrorPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;
  readonly lockIcon = LockKeyhole;
  readonly keyIcon = KeyRound;
  readonly retryIcon = RefreshCw;
  readonly autoRetrySeconds = AUTO_RETRY_SECONDS;

  readonly session = this.sessionAuth.session;
  readonly code = signal<ErrorCode>(this.resolveCode());
  readonly isEmbedded = signal(Boolean(this.route.snapshot.data['embeddedLayout']));
  readonly from = signal(this.safeInternalPath(this.route.snapshot.queryParamMap.get('from')));
  readonly permission = signal(this.route.snapshot.queryParamMap.get('permission')?.trim() ?? '');
  readonly isExpired = signal(this.route.snapshot.queryParamMap.get('reason') === 'expired');
  readonly routeStreamer = signal(
    (this.route.snapshot.paramMap.get('streamer') ?? this.route.snapshot.parent?.paramMap.get('streamer') ?? '').trim()
  );

  /** 503 auto-retry countdown; null when stopped. */
  readonly retryIn = signal<number | null>(null);
  private retryTimer: number | null = null;

  readonly ns = computed(() => `errors.e${this.code()}`);

  readonly title = computed(() => {
    if (this.code() === '401' && this.isExpired()) {
      return this.tk('titleExpired');
    }
    if (this.code() === '403' && this.permission() === 'channel:owner') {
      return this.tk('titleOwner');
    }
    return this.tk('title');
  });

  readonly message = computed(() => {
    const code = this.code();
    if (code === '401') {
      return this.tk(this.isExpired() ? 'messageExpired' : 'message');
    }
    if (code === '403') {
      if (this.permission() === 'channel:owner') {
        return this.tk('messageOwner', { channel: this.channelName() });
      }
      const area = this.permissionArea();
      return area && this.channelName() && this.permission() !== 'dashboard:view'
        ? this.tk('messageArea', { channel: this.channelName(), area: area.label })
        : this.tk('message');
    }
    if (code === '404') {
      return this.tk(this.session() ? 'messageSignedIn' : 'message');
    }
    return this.tk('message');
  });

  /** Human label for a 403 permission, e.g. "Bot settings · View". */
  readonly permissionArea = computed(() => {
    const permission = this.permission();
    if (!permission || permission === 'channel:owner') {
      return null;
    }
    const group = CHANNEL_ADMIN_PERMISSION_GROUPS.find(
      (entry) => entry.view.includes(permission) || entry.manage.includes(permission)
    );
    if (!group) {
      return null;
    }
    const level = group.view.includes(permission) ? 'view' : 'manage';
    return {
      label: this.t(`settings.admins.permissions.categories.${group.key}`),
      level: this.t(`settings.admins.permissions.${level}`)
    };
  });

  readonly channelName = computed(() => this.resolveDashboardName(this.routeStreamer()) || this.routeStreamer());

  readonly ownStreamer = computed(() => {
    const current = this.session();
    if (!current) {
      return '';
    }
    return this.sessionAuth.toRouteStreamer(current.appUser.twitch_user_id || current.twitchUser.id);
  });

  readonly ownName = computed(() => {
    const current = this.session();
    return current?.twitchUser.display_name?.trim() || current?.twitchUser.login?.trim() || '';
  });

  readonly primary = computed<ErrorAction>(() => {
    const code = this.code();
    if (code === '401') {
      return { label: this.tk('actions.signIn'), link: '/login', icon: this.keyIcon };
    }
    if (code === '500' || code === '503') {
      return { label: this.tk('actions.retry'), action: 'retry', icon: this.retryIcon };
    }
    if (this.session()) {
      // 403 inside a channel: that channel's dashboard (the user may still have dashboard access).
      if (code === '403' && this.routeStreamer() && this.permission() !== 'dashboard:view') {
        return {
          label: this.t('errors.actions.dashboardNamed', { name: this.channelName() }),
          link: ['/', this.routeStreamer(), 'dashboard']
        };
      }
      return this.ownDashboardAction();
    }
    return { label: this.t('errors.actions.home'), link: '/' };
  });

  readonly secondary = computed<ErrorAction | null>(() => {
    const code = this.code();
    if (code === '401') {
      return { label: this.t('errors.actions.home'), link: '/' };
    }
    if (code === '500' || code === '503') {
      return this.session() ? this.ownDashboardAction() : { label: this.t('errors.actions.home'), link: '/' };
    }
    if (!this.session()) {
      return { label: this.t('errors.actions.signIn'), link: '/login' };
    }
    const primaryLink = JSON.stringify(this.primary().link);
    const own = this.ownDashboardAction();
    if (JSON.stringify(own.link) !== primaryLink) {
      return own;
    }
    return { label: this.t('errors.actions.home'), link: '/' };
  });

  constructor() {
    if (this.code() === '503') {
      this.startAutoRetry();
    }
    this.destroyRef.onDestroy(() => this.stopAutoRetry());
  }

  t(key: string, params?: Record<string, string | number>): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key, params);
  }

  tk(suffix: string, params?: Record<string, string | number>): string {
    return this.t(`${this.ns()}.${suffix}`, params);
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'English · ES' : 'Español · EN';
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  run(action: ErrorAction): void {
    if (action.action === 'retry') {
      this.retry();
    }
  }

  retry(): void {
    this.stopAutoRetry();
    const from = this.from();
    if (from) {
      window.location.assign(from);
    } else {
      window.location.reload();
    }
  }

  stopAutoRetry(): void {
    if (this.retryTimer !== null) {
      window.clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryIn.set(null);
  }

  private startAutoRetry(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.retryIn.set(AUTO_RETRY_SECONDS);
    this.retryTimer = window.setInterval(() => {
      const next = (this.retryIn() ?? 0) - 1;
      if (next <= 0) {
        this.retry();
        return;
      }
      this.retryIn.set(next);
    }, 1000);
  }

  private ownDashboardAction(): ErrorAction {
    const streamer = this.ownStreamer();
    if (!streamer) {
      return { label: this.t('errors.actions.home'), link: '/' };
    }
    const name = this.ownName();
    return {
      label: name ? this.t('errors.actions.myDashboardNamed', { name }) : this.t('errors.actions.myDashboard'),
      link: ['/', streamer, 'dashboard']
    };
  }

  private resolveCode(): ErrorCode {
    const code = String(this.route.snapshot.data['code'] ?? '404') as ErrorCode;
    return ERROR_CODES.includes(code) ? code : '404';
  }

  /** Only same-site paths, so `from` can't be used as an open redirect. */
  private safeInternalPath(value: string | null): string {
    const path = value?.trim() ?? '';
    return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '';
  }

  private resolveDashboardName(streamer: string): string {
    const current = this.session();
    const normalized = streamer.trim().toLowerCase();
    if (!current || !normalized) {
      return '';
    }
    const ownerLogin = current.twitchUser.login?.trim().toLowerCase() || '';
    const ownerID = current.appUser.twitch_user_id?.trim().toLowerCase() || '';
    if (normalized === ownerLogin || normalized === ownerID) {
      return current.twitchUser.display_name?.trim() || current.twitchUser.login?.trim() || streamer;
    }
    const managed = current.appUser.administrating.find(
      (entry) =>
        normalized === (entry.channelName?.trim().toLowerCase() || '') ||
        normalized === (entry.channelID?.trim().toLowerCase() || '')
    );
    return managed?.channelName?.trim() || '';
  }
}
