import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { LucideAngularModule, Moon, RefreshCw, ShieldAlert, Zap, Sun } from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-authenticated-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, LucideAngularModule],
  templateUrl: './authenticated-layout.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscapeKey()'
  }
})
export class AuthenticatedLayoutComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly linksService = inject(LinksService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);
  private readonly profileMenu = viewChild<ElementRef<HTMLElement>>('profileMenu');
  private readonly mobileMenu = viewChild<ElementRef<HTMLElement>>('mobileMenu');

  readonly session = this.sessionAuth.session;
  readonly streamer = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('streamer') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('streamer') ?? '' }
  );
  readonly userName = computed(() => {
    const current = this.session();
    return current?.twitchUser.display_name || current?.twitchUser.login || 'Streamer';
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

  readonly moonIcon = Moon;
  readonly sunIcon = Sun;
  readonly activateIcon = Zap;
  readonly reauthenticateIcon = ShieldAlert;
  readonly updatePermissionsIcon = RefreshCw;

  t(key: string): string {
    return this.languageService.translate(key);
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

    const params = new URLSearchParams({
      state: username,
      action
    });

    this.closeProfileMenu();
    this.closeMobileMenu();
    window.location.href = `${this.linksService.getApiUrl()}/auth/authorize?${params.toString()}`;
  }

  logout(): void {
    this.closeProfileMenu();
    this.closeMobileMenu();
    this.sessionAuth.clearSession();
    void this.router.navigateByUrl('/');
  }
}
