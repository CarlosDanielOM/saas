import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { distinctUntilChanged, map } from 'rxjs';
import { LucideAngularModule, Moon, RefreshCw, ShieldAlert, Sparkles, Sun, Zap } from 'lucide-angular';

import { AnalyticsService } from '../../services/analytics.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { PendingActionsQueueService } from '../../services/pending-actions-queue.service';
import { ToastContainerComponent } from '../../shared/toast-container/toast-container.component';
import { UpgradeModalComponent } from '../../shared/upgrade-modal/upgrade-modal.component';

@Component({
  selector: 'app-authenticated-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, LucideAngularModule, ToastContainerComponent, UpgradeModalComponent],
  templateUrl: './authenticated-layout.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscapeKey()'
  }
})
export class AuthenticatedLayoutComponent {
  private readonly analytics = inject(AnalyticsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly linksService = inject(LinksService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);
  private readonly toastService = inject(ToastService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly pendingActionsQueue = inject(PendingActionsQueueService);
  private readonly profileMenu = viewChild<ElementRef<HTMLElement>>('profileMenu');
  private readonly mobileMenu = viewChild<ElementRef<HTMLElement>>('mobileMenu');

  private readonly queryParams = toSignal(
    this.route.queryParamMap.pipe(
      map((params) => ({
        upgrade: params.get('upgrade'),
        tier: params.get('tier')
      })),
      distinctUntilChanged((prev, next) =>
        prev.upgrade === next.upgrade && prev.tier === next.tier
      )
    ),
    { initialValue: { upgrade: null, tier: null } }
  );

  readonly session = this.sessionAuth.session;
  readonly streamer = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('streamer') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('streamer') ?? '' }
  );
  readonly userName = computed(() => {
    const current = this.session();
    return current?.twitchUser.display_name || current?.twitchUser.login || 'Streamer';
  });
  readonly ownerStreamer = computed(() => {
    const current = this.session();
    const login = current?.twitchUser.login?.trim().toLowerCase();
    return login || current?.appUser.twitch_user_id || '';
  });
  readonly isViewingManagedChannel = computed(() => {
    const current = this.session();
    const routeStreamer = this.streamer().trim().toLowerCase();
    if (!current || !routeStreamer) {
      return false;
    }

    const ownerLogin = current.twitchUser.login?.trim().toLowerCase() || '';
    const ownerChannelID = current.appUser.twitch_user_id?.trim().toLowerCase() || '';

    return routeStreamer !== ownerLogin && routeStreamer !== ownerChannelID;
  });
  readonly currentDashboardLink = computed(() => {
    const activeStreamer = this.streamer().trim();

    return ['/', activeStreamer, 'dashboard'];
  });
  readonly myDashboardLink = computed(() => {
    const ownerStreamer = this.ownerStreamer();

    return ['/', ownerStreamer, 'dashboard'];
  });
  readonly userAvatar = computed(() => this.session()?.twitchUser.profile_image_url ?? '');
  readonly planTier = computed(() => this.session()?.appUser.plan_tier ?? 'free');
  readonly planBadgeClass = computed(
    () => `auth-navbar__plan-badge auth-navbar__plan-badge--${this.planTier()}`
  );
  readonly isProfileMenuOpen = signal(false);
  readonly isMobileMenuOpen = signal(false);
  readonly permissionCtaState = computed<'activate' | 'reauthenticate' | 'update' | null>(() => {
    const appUser = this.session()?.appUser;
    if (!appUser) {
      return null;
    }

    if (!appUser.actived) {
      return 'activate';
    }

    if (!appUser.has_permissions) {
      return 'reauthenticate';
    }

    if (!appUser.up_to_date_permissions) {
      return 'update';
    }

    return null;
  });
  readonly hasPermissionCta = computed(() => this.permissionCtaState() !== null);
  readonly permissionCtaLabel = computed(() => {
    // Access currentLanguage to create dependency for re-computation
    this.languageService.currentLanguage();
    const state = this.permissionCtaState();
    if (state === 'activate') {
      return this.t('navbar.activateBot');
    }

    if (state === 'reauthenticate') {
      return this.t('navbar.reauthenticate');
    }

    if (state === 'update') {
      return this.t('navbar.updatePermissions');
    }

    return '';
  });
  readonly permissionCtaButtonClass = computed(() => {
    const state = this.permissionCtaState();

    if (state === 'activate') {
      return 'auth-navbar__cta-btn auth-navbar__cta-btn--activate';
    }

    if (state === 'reauthenticate') {
      return 'auth-navbar__cta-btn auth-navbar__cta-btn--reauthenticate';
    }

    return 'auth-navbar__cta-btn auth-navbar__cta-btn--update';
  });
  readonly permissionCtaIcon = computed(() => {
    const state = this.permissionCtaState();

    if (state === 'activate') {
      return this.activateIcon;
    }

    if (state === 'reauthenticate') {
      return this.reauthenticateIcon;
    }

    return this.updatePermissionsIcon;
  });
  readonly showUpgradeOption = computed(() => this.planTier() !== 'pro');
  readonly upgradeMenuLabel = computed(() => {
    this.languageService.currentLanguage();
    return this.planTier() === 'free'
      ? this.t('navbar.upgrade')
      : this.t('navbar.upgradeToPro');
  });

  readonly moonIcon = Moon;
  readonly sunIcon = Sun;
  readonly activateIcon = Zap;
  readonly reauthenticateIcon = ShieldAlert;
  readonly updatePermissionsIcon = RefreshCw;
  readonly sparklesIcon = Sparkles;

  constructor() {
    effect(() => {
      const tier = this.planTier();
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-plan-tier', tier);
      }
    });

    effect(() => {
      const current = this.session();
      const streamer = this.streamer().trim().toLowerCase();
      if (!current || !streamer) {
        return;
      }

      this.sessionAuth.setLastViewedStreamer(streamer);
    });

    effect(() => {
      const params = this.queryParams();
      if (params.upgrade !== 'success') {
        return;
      }

      const tier = params.tier === 'premium' || params.tier === 'pro' ? params.tier : 'pro';
      const tierLabel = tier === 'pro'
        ? this.t('navbar.planPro')
        : this.t('navbar.planPremium');

      this.analytics.capture('upgrade_completed_returned', { tier });
      this.toastService.success(
        this.t('upgradeModal.successToast.title'),
        this.t('upgradeModal.successToast.body', { tier: tierLabel })
      );

      this.sessionAuth.validateSession().subscribe({
        error: () => undefined
      });
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { upgrade: null, tier: null },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });
    });

    // Consume the standardized pending actions queue once a valid session exists.
    // The queue is sessionStorage-backed and survives reloads / OAuth round-trips.
    // Producers (login page, future email flows, etc.) push typed actions (toast, redirect, ...).
    // We drain the queue exactly once per layout instance.
    effect(() => {
      const currentSession = this.session();
      if (!currentSession) {
        return;
      }

      // Only process once per layout instance (after we have a real session)
      if ((this as any).__pendingQueueProcessed) {
        return;
      }
      (this as any).__pendingQueueProcessed = true;

      // This will also migrate any legacy 'dimasite.pendingEmailAction' entries
      // and then clear the queue after processing.
      this.pendingActionsQueue.processQueue(
        this.router,
        this.toastService,
        this.languageService
      );
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  planTierLabel(): string {
    const tier = this.planTier();
    if (tier === 'premium') {
      return this.t('navbar.planPremium');
    }
    if (tier === 'pro') {
      return this.t('navbar.planPro');
    }
    return this.t('navbar.planFree');
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'EN' : 'ES';
  }

  userInitial(): string {
    return this.userName().charAt(0).toUpperCase();
  }

  toggleProfileMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.closeMobileMenu();
    this.isProfileMenuOpen.update((open) => !open);
  }

  closeProfileMenu(): void {
    this.isProfileMenuOpen.set(false);
  }

  toggleMobileMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.closeProfileMenu();
    this.isMobileMenuOpen.update((open) => !open);
  }

  closeMobileMenu(): void {
    this.isMobileMenuOpen.set(false);
  }

  onEscapeKey(): void {
    this.closeProfileMenu();
    this.closeMobileMenu();
  }

  onDocumentClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (this.isProfileMenuOpen()) {
      const profileMenu = this.profileMenu()?.nativeElement;
      if (profileMenu && !profileMenu.contains(target)) {
        this.closeProfileMenu();
      }
    }

    if (this.isMobileMenuOpen()) {
      const mobileMenu = this.mobileMenu()?.nativeElement;
      if (mobileMenu && !mobileMenu.contains(target)) {
        this.closeMobileMenu();
      }
    }
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleThemeFromMenu(): void {
    this.toggleTheme();
    this.closeProfileMenu();
  }

  toggleThemeFromMobileMenu(): void {
    this.toggleTheme();
    this.closeMobileMenu();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  toggleLanguageFromMenu(): void {
    this.toggleLanguage();
    this.closeProfileMenu();
  }

  toggleLanguageFromMobileMenu(): void {
    this.toggleLanguage();
    this.closeMobileMenu();
  }

  openPermissionCta(): void {
    const action = this.permissionCtaState();
    const username = this.session()?.twitchUser.login?.trim().toLowerCase();

    if (!action || !username) {
      return;
    }

    this.analytics.capture('permission_cta_clicked', {
      action,
      streamer: this.streamer(),
    });

    const params = new URLSearchParams({
      state: username,
      action
    });

    this.closeProfileMenu();
    this.closeMobileMenu();
    window.location.href = `${this.linksService.getApiUrl()}/auth/authorize?${params.toString()}`;
  }

  openUpgradeFromMenu(): void {
    this.closeProfileMenu();
    this.closeMobileMenu();
    void this.upgradeService.promptUpgradeForAnyPlan('profile_dropdown');
  }

  logout(): void {
    this.closeProfileMenu();
    this.closeMobileMenu();
    this.analytics.capture('logout_clicked', {
      streamer: this.streamer(),
    });
    this.sessionAuth.clearSession();
    void this.router.navigateByUrl('/');
  }
}
