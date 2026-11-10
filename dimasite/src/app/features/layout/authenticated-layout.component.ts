import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { catchError, distinctUntilChanged, forkJoin, map, of, switchMap } from 'rxjs';
import { Coins, Gift, Languages, LogOut, LucideAngularModule, Moon, RefreshCw, ShieldAlert, Sparkles, Sun, User, Zap } from 'lucide-angular';

import { AnalyticsService } from '../../services/analytics.service';
import { BotAccessService } from '../../services/bot-access.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LayoutFocusService } from '../../services/layout-focus.service';
import { PendingActionsQueueService } from '../../services/pending-actions-queue.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { ToastContainerComponent } from '../../shared/toast-container/toast-container.component';
import { UpgradeModalComponent } from '../../shared/upgrade-modal/upgrade-modal.component';

@Component({
  selector: 'app-authenticated-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, LucideAngularModule, ToastContainerComponent, UpgradeModalComponent, BrandLogoComponent],
  templateUrl: './authenticated-layout.component.html',
  styleUrl: './authenticated-layout.component.css',
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
  readonly botAccess = inject(BotAccessService);
  /** Full-screen pages such as Overlay Studio hide the navbar while they are open. */
  readonly focus = inject(LayoutFocusService).active;
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
  readonly navigationAccess = signal({ commands: false, settings: false });
  private readonly navigationIdentity = computed(() => {
    const current = this.session();
    return `${current?.appUser.twitch_user_id ?? ''}:${current?.twitchUser.login ?? ''}`;
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
  readonly planTier = computed(() => this.sessionAuth.getPlanTierForStreamer(this.streamer()));
  readonly planBadgeClass = computed(
    () => `auth-navbar__plan-badge auth-navbar__plan-badge--${this.planTier()}`
  );
  readonly isProfileMenuOpen = signal(false);
  readonly isMobileMenuOpen = signal(false);
  /**
   * Fix-it CTA for streamers who already gave full access and lost it. A new streamer
   * (no full access yet) gets the chat control instead; full access is offered in the
   * menu and next to the features that need it.
   */
  readonly permissionCtaState = computed<'reauthenticate' | 'update' | null>(() => {
    const appUser = this.session()?.appUser;
    if (!appUser || !appUser.actived) {
      return null;
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

    if (state === 'reauthenticate') {
      return 'auth-navbar__cta-btn auth-navbar__cta-btn--reauthenticate';
    }

    return 'auth-navbar__cta-btn auth-navbar__cta-btn--update';
  });
  readonly permissionCtaIcon = computed(() => {
    const state = this.permissionCtaState();

    if (state === 'reauthenticate') {
      return this.reauthenticateIcon;
    }

    return this.updatePermissionsIcon;
  });
  /** Owner on their own channel, nothing to fix: the navbar slot adds/removes the bot from chat. */
  readonly showChatControl = computed(() =>
    Boolean(this.session()) && !this.hasPermissionCta() && !this.isViewingManagedChannel() && Boolean(this.botAccess.ownChannelID())
  );
  /** "Remove" asks for a second tap: the bot stops answering chat right away. */
  readonly chatLeaveConfirm = signal(false);
  private chatLeaveConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  readonly chatControlState = computed<'out' | 'needs-ok' | 'in' | 'confirm' | 'busy'>(() => {
    if (this.botAccess.chatBusy()) return 'busy';
    if (!this.botAccess.chatEnabled()) return this.botAccess.chatNeedsTwitchOk() ? 'needs-ok' : 'out';
    return this.chatLeaveConfirm() ? 'confirm' : 'in';
  });
  readonly chatControlLabel = computed(() => {
    this.languageService.currentLanguage();
    switch (this.chatControlState()) {
      case 'busy': return this.t(this.botAccess.chatEnabled() ? 'botAccess.chat.removing' : 'botAccess.chat.adding');
      case 'needs-ok': return this.t('botAccess.chat.allow');
      case 'in': return this.t('botAccess.chat.inChat');
      case 'confirm': return this.t('botAccess.chat.confirmRemove');
      default: return this.t('botAccess.chat.add');
    }
  });
  readonly chatControlAria = computed(() => {
    this.languageService.currentLanguage();
    const state = this.chatControlState();
    if (state === 'in') return this.t('botAccess.chat.inChatAria');
    return this.chatControlLabel();
  });
  /** Full access not given yet: offered in the menus instead of taking over the navbar. */
  readonly showFullAccessMenuItem = computed(() =>
    Boolean(this.session()) && !this.session()?.appUser.actived && !this.isViewingManagedChannel()
  );
  readonly showUpgradeOption = computed(() => !this.isViewingManagedChannel() && this.planTier() !== 'pro');
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
  readonly creditsIcon = Coins;
  readonly giftIcon = Gift;
  readonly languageIcon = Languages;
  readonly logoutIcon = LogOut;
  readonly profileIcon = User;

  constructor() {
    effect((onCleanup) => {
      this.navigationIdentity();
      const streamer = this.streamer().trim().toLowerCase();
      const current = untracked(this.session);
      if (!current || !streamer) {
        this.navigationAccess.set({ commands: false, settings: false });
        return;
      }

      if (streamer === current.twitchUser.login?.toLowerCase() || streamer === current.appUser.twitch_user_id) {
        this.navigationAccess.set({ commands: true, settings: true });
        return;
      }

      this.navigationAccess.set({ commands: false, settings: false });
      const subscription = untracked(() => this.sessionAuth.resolveChannelID(streamer).pipe(
        switchMap((channelID) => channelID
          ? forkJoin({
              commands: this.sessionAuth.checkPermission(channelID, 'commands:view'),
              settings: this.sessionAuth.checkPermission(channelID, 'admins:view')
            })
          : of({ commands: false, settings: false })),
        catchError(() => of({ commands: false, settings: false }))
      ).subscribe((access) => this.navigationAccess.set(access)));
      onCleanup(() => subscription.unsubscribe());
    });

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

      // Other tabs may remember a different channel. Do not react to their
      // preference changes by continually writing this tab's channel back.
      untracked(() => this.sessionAuth.setLastViewedStreamer(streamer));
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
      // Back from approving chat access on Twitch: add the bot as the streamer asked.
      untracked(() => this.botAccess.resumePendingJoin());
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

  onChatControl(): void {
    switch (this.chatControlState()) {
      case 'busy':
        return;
      case 'needs-ok':
        this.botAccess.allowChatOnTwitch();
        return;
      case 'out':
        void this.botAccess.setChat(true);
        return;
      case 'in':
        this.chatLeaveConfirm.set(true);
        this.clearChatLeaveTimer();
        this.chatLeaveConfirmTimer = setTimeout(() => this.chatLeaveConfirm.set(false), 4000);
        return;
      case 'confirm':
        this.clearChatLeaveTimer();
        this.chatLeaveConfirm.set(false);
        void this.botAccess.setChat(false);
        return;
    }
  }

  openFullAccessFromMenu(): void {
    this.closeProfileMenu();
    this.closeMobileMenu();
    this.botAccess.startFullAccess('navbar_menu');
  }

  private clearChatLeaveTimer(): void {
    if (this.chatLeaveConfirmTimer) {
      clearTimeout(this.chatLeaveConfirmTimer);
      this.chatLeaveConfirmTimer = null;
    }
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
