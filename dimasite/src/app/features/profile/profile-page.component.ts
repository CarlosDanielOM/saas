import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AccountApiService } from '../../services/account-api.service';
import { BillingService } from '../../services/billing.service';

import { LanguageService, SupportedLanguage } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemePreference, ThemeService } from '../../services/theme.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LfIconComponent, LfIconName } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ProfileShortcut {
  key: string;
  icon: LfIconName;
  path: string;
}

/** Danger zone actions. Both act on the signed-in account, never on a channel the user only helps on. */
export type DangerAction = 'reset' | 'delete';

const SHORTCUTS: readonly ProfileShortcut[] = [
  { key: 'settings', icon: 'users', path: 'settings' },
  { key: 'usage', icon: 'trend', path: 'usage' },
  { key: 'credits', icon: 'zap', path: 'credits' },
  { key: 'modules', icon: 'grid', path: 'modules' }
];

@Component({
  selector: 'app-profile-page',
  templateUrl: './profile-page.component.html',
  styleUrl: './profile-page.component.css',
  imports: [RouterLink, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'closeDanger()'
  }
})
export class ProfilePageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly billingService = inject(BillingService);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly accountApi = inject(AccountApiService);
  private readonly toast = inject(ToastService);
  private readonly dangerDialog = viewChild<ElementRef<HTMLElement>>('dangerDialog');
  private dangerTrigger: HTMLElement | null = null;

  readonly shortcuts = SHORTCUTS;
  readonly language = this.languageService.currentLanguage;
  readonly theme = this.themeService.theme;
  readonly backPath = computed(() => ['/', (getRouteParam(this.route, 'streamer') ?? this.login()).trim().toLowerCase(), 'dashboard']);

  readonly isLoading = computed(() => this.sessionAuth.session() === null);
  readonly planTier = computed(() => {
    const tier = this.sessionAuth.session()?.appUser.plan_tier ?? 'free';
    if (tier === 'premium' || tier === 'pro') {
      return tier;
    }
    return 'free';
  });
  readonly showUpgradeCta = computed(() => this.planTier() !== 'pro');
  readonly canManageSubscription = computed(() => this.planTier() !== 'free');
  readonly portalOpening = signal(false);
  readonly portalError = signal(false);
  readonly emailVisible = signal(false);

  readonly dangerAction = signal<DangerAction | null>(null);
  readonly dangerConfirmText = signal('');
  readonly dangerBusy = signal(false);
  readonly dangerError = signal(false);
  readonly dangerSubmitAttempted = signal(false);
  /** The user must type their own Twitch login (any case) before the final button works. */
  readonly dangerConfirmMatches = computed(
    () => !!this.login() && this.dangerConfirmText().trim().replace(/^@/, '').toLowerCase() === this.login()
  );

  readonly login = computed(() => (this.sessionAuth.session()?.twitchUser.login || '').trim().toLowerCase());
  readonly displayName = computed(() => {
    const session = this.sessionAuth.session();
    return (
      session?.twitchUser.display_name ||
      session?.appUser.name ||
      session?.twitchUser.login ||
      '—'
    );
  });
  readonly email = computed(
    () => this.sessionAuth.session()?.twitchUser.email || this.sessionAuth.session()?.appUser.email || ''
  );
  readonly maskedEmail = computed(() => {
    const value = this.email().trim();
    if (!value) {
      return '';
    }
    const at = value.indexOf('@');
    if (at <= 0) {
      return '••••••••';
    }
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const localMask = local.length <= 2 ? '••' : `${local[0]}${'•'.repeat(Math.min(local.length - 1, 8))}`;
    const domainParts = domain.split('.');
    const domainMask = domainParts
      .map((part, index) => {
        if (!part) return part;
        if (index === domainParts.length - 1) return part;
        return `${part[0] ?? ''}•••`;
      })
      .join('.');
    return `${localMask}@${domainMask}`;
  });
  readonly emailDisplay = computed(() => {
    if (!this.email()) {
      return this.t('common.notAvailable');
    }
    return this.emailVisible() ? this.email() : this.maskedEmail();
  });
  readonly avatarUrl = computed(() => this.sessionAuth.session()?.twitchUser.profile_image_url || null);
  readonly initials = computed(() => {
    const name = this.displayName().trim();
    if (!name || name === '—') {
      return '?';
    }
    return name.slice(0, 1).toUpperCase();
  });

  constructor() {
    effect(() => {
      const dialog = this.dangerDialog();
      if (dialog) queueMicrotask(() => dialog.nativeElement.focus());
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  planTierLabel(): string {
    const tier = this.planTier();
    if (tier === 'pro') {
      return this.t('navbar.planPro');
    }
    if (tier === 'premium') {
      return this.t('navbar.planPremium');
    }
    return this.t('navbar.planFree');
  }

  upgradeCtaLabel(): string {
    return this.planTier() === 'free'
      ? this.t('profile.subscription.upgradeCta')
      : this.t('profile.subscription.upgradeToProCta');
  }

  planUntilLabel(): string | null {
    const until = this.sessionAuth.session()?.appUser.plan_tier_until;
    if (!until) {
      return null;
    }
    const date = new Date(until);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return this.t('profile.meta.planUntil', {
      date: date.toLocaleDateString(this.languageService.currentLanguage() === 'es' ? 'es' : 'en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
    });
  }

  toggleEmailVisibility(): void {
    if (!this.email()) {
      return;
    }
    this.emailVisible.update((visible) => !visible);
  }

  shortcutPath(shortcut: ProfileShortcut): string[] {
    return ['/', this.login(), shortcut.path];
  }

  setLanguage(language: SupportedLanguage): void {
    this.languageService.setLanguage(language);
  }

  setTheme(theme: ThemePreference): void {
    this.themeService.setTheme(theme);
  }

  onUpgradeClick(): void {
    void this.upgradeService.promptUpgradeForAnyPlan('profile_page');
  }

  async openBillingPortal(): Promise<void> {
    if (this.portalOpening()) {
      return;
    }
    this.portalOpening.set(true);
    this.portalError.set(false);
    try {
      const response = await firstValueFrom(
        this.billingService.createPortalSession({
          returnUrl: `${window.location.origin}${window.location.pathname}`
        })
      );
      if (response.error || !response.data?.url) {
        throw new Error(response.message || 'Missing portal URL');
      }
      window.location.assign(response.data.url);
    } catch {
      this.portalError.set(true);
      this.portalOpening.set(false);
    }
  }

  openDanger(action: DangerAction, event: Event): void {
    this.dangerTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.dangerConfirmText.set('');
    this.dangerError.set(false);
    this.dangerSubmitAttempted.set(false);
    this.dangerAction.set(action);
  }

  closeDanger(): void {
    if (!this.dangerAction() || this.dangerBusy()) {
      return;
    }
    this.dangerAction.set(null);
    const trigger = this.dangerTrigger;
    this.dangerTrigger = null;
    if (trigger) queueMicrotask(() => trigger.focus());
  }

  onDangerInput(event: Event): void {
    this.dangerConfirmText.set((event.target as HTMLInputElement).value);
    this.dangerError.set(false);
  }

  async confirmDanger(): Promise<void> {
    const action = this.dangerAction();
    if (!action || this.dangerBusy()) {
      return;
    }
    this.dangerSubmitAttempted.set(true);
    if (!this.dangerConfirmMatches()) {
      return;
    }

    this.dangerBusy.set(true);
    this.dangerError.set(false);
    try {
      const request = action === 'reset' ? this.accountApi.factoryReset() : this.accountApi.deleteAccount();
      const response = await firstValueFrom(request);
      if (response.error) {
        throw new Error(response.message || 'Account action failed');
      }
    } catch {
      this.dangerBusy.set(false);
      this.dangerError.set(true);
      return;
    }

    this.dangerBusy.set(false);
    if (action === 'reset') {
      this.dangerAction.set(null);
      this.dangerTrigger = null;
      this.toast.success(this.t('profile.danger.reset.doneTitle'), this.t('profile.danger.reset.doneCopy'));
      return;
    }

    this.dangerAction.set(null);
    this.dangerTrigger = null;
    this.sessionAuth.clearSession();
    this.toast.success(this.t('profile.danger.delete.doneTitle'), this.t('profile.danger.delete.doneCopy'));
    // The login page is the only signed-out page that shows toasts.
    void this.router.navigateByUrl('/login');
  }
}
