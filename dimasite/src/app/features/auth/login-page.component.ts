import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { DashboardApiService } from '../../services/dashboard-api.service';
import { AnalyticsService } from '../../services/analytics.service';
import { BillingContextData, BillingService } from '../../services/billing.service';
import { CheckoutIntentService } from '../../services/checkout-intent.service';
import { LanguageService } from '../../services/language.service';
import { AuthLoginError, SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { ToastService } from '../../services/toast.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { ToastContainerComponent } from '../../shared/toast-container/toast-container.component';
import { PendingActionsQueueService } from '../../services/pending-actions-queue.service';

type LoginStage =
  | 'idle'
  | 'validating'
  | 'syncing'
  | 'permissions'
  | 'dashboard'
  | 'redirecting'
  | 'error';

const LOGIN_RESET_REDIRECT_DELAY_MS = 3000;
const LOGIN_RESET_TOAST_DURATION_MS = LOGIN_RESET_REDIRECT_DELAY_MS + 200;

@Component({
  selector: 'app-login-page',
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideAngularModule, ToastContainerComponent, BrandLogoComponent]
})
export class LoginPageComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly analytics = inject(AnalyticsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly checkoutIntent = inject(CheckoutIntentService);
  private readonly languageService = inject(LanguageService);
  private readonly themeService = inject(ThemeService);
  private readonly billingService = inject(BillingService);
  private readonly dashboardApi = inject(DashboardApiService);
  private readonly toastService = inject(ToastService);
  private readonly pendingActionsQueue = inject(PendingActionsQueueService);
  private lastQuerySignature: string | null = null;
  private redirectTimeoutHandle: number | null = null;
  private hasAutoTriggeredLogin = false;

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  readonly stage = signal<LoginStage>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly debugLines = signal<string[]>([]);
  readonly mockLoginEnabled = this.sessionAuth.isMockLoginEnabled();

  readonly progress = computed(() => {
    switch (this.stage()) {
      case 'validating':
        return 16;
      case 'syncing':
        return 38;
      case 'permissions':
        return 64;
      case 'dashboard':
        return 84;
      case 'redirecting':
        return 100;
      default:
        return 0;
    }
  });

  readonly stageLabel = computed(() => this.t(`login.stages.${this.stage()}`));

  readonly isBusy = computed(() => {
    const current = this.stage();
    return current !== 'idle' && current !== 'error';
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cancelPendingLoginReset();
    });
  }

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((query) => {
      const signature = this.buildQuerySignature(query);
      if (signature === this.lastQuerySignature) {
        return;
      }

      this.lastQuerySignature = signature;

      // Auto-trigger login for admin flow
      const returnTo = this.getAdminReturnTo();
      if (returnTo && !this.hasAutoTriggeredLogin && !query.get('code')) {
        this.hasAutoTriggeredLogin = true;
        void this.triggerAdminLogin(returnTo);
        return;
      }

      // Handle email-triggered actions (e.g. activation link "already activated").
      // We use the standardized pendingActionsQueue (sessionStorage backed) so that
      // actions survive OAuth round-trips and page reloads. The authenticated layout
      // drains the queue once a valid session is present.
      const emailAction = query.get('emailAction');
      if (emailAction === 'alreadyActivated') {
        this.pendingActionsQueue.pushAction({
          type: 'toast',
          tone: 'success',
          titleKey: 'login.toast.alreadyActivatedTitle',
          messageKey: 'login.toast.alreadyActivatedMessage'
        });
        // Clean the URL so it doesn't stick around
        void this.router.navigate([], {
          queryParams: { emailAction: null },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      }

      void this.handleQueryState(query);
    });
  }

  /**
   * Automatically trigger admin login flow
   */
  private async triggerAdminLogin(returnTo: string): Promise<void> {
    this.stage.set('validating');
    this.analytics.capture('auth_started', {
      source: 'admin_redirect',
    });
    this.sessionAuth.startTwitchLoginWithState(`admin-${returnTo}`);
  }

  t(key: string): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key);
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

  loginWithTwitch(): void {
    this.analytics.capture('auth_started', {
      source: 'login_page',
    });

    // Check if this is an admin login flow
    const returnTo = this.getAdminReturnTo();
    if (returnTo) {
      // Use admin state format: admin-{returnUrl}
      this.sessionAuth.startTwitchLoginWithState(`admin-${returnTo}`);
    } else {
      this.sessionAuth.startTwitchLogin();
    }
  }

  /**
   * Get admin return URL from query params if present
   */
  private getAdminReturnTo(): string | null {
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    if (returnTo && returnTo.includes('admin.domdimabot.com')) {
      return returnTo;
    }
    return null;
  }

  private async handleQueryState(query: ParamMap): Promise<void> {
    const code = query.get('code');
    const returnedState = query.get('state');
    const error = query.get('error');
    const debug = query.get('debug');

    this.errorMessage.set(null);

    if (debug) {
      this.pushDebug(`Guard debug: ${debug}`);
      const debugChannel = query.get('channelID');
      const debugStreamer = query.get('streamer');
      const debugPermission = query.get('permission');
      if (debugChannel) {
        this.pushDebug(`Guard channel: ${debugChannel}`);
      }
      if (debugStreamer) {
        this.pushDebug(`Guard streamer: ${debugStreamer}`);
      }
      if (debugPermission) {
        this.pushDebug(`Guard permission: ${debugPermission}`);
      }
    }

    if (error) {
      this.stage.set('error');
      this.analytics.capture('auth_failed', {
        source: 'twitch_oauth',
        reason: error,
        stage: 'oauth_callback',
      });
      this.errorMessage.set(this.t('login.errors.denied'));
      return;
    }

    if (debug) {
      this.applyGuardFailure(debug);
      return;
    }

    // Check if this is an admin login redirect
    if (returnedState?.startsWith('admin-')) {
      void this.completeAdminLogin(code, returnedState);
      return;
    }

    // If returnTo is present (admin flow), don't use existing session - wait for fresh login
    const returnTo = this.getAdminReturnTo();

    this.cancelPendingLoginReset();

    if (!code) {
      // For admin flow, clear any existing session and show login button
      if (returnTo) {
        this.sessionAuth.clearSession();
        this.stage.set('idle');
        return;
      }

      const existingChannel = this.sessionAuth.getPrimaryChannelID();
      this.pushDebug(`No code in URL. Existing channel: ${existingChannel ?? 'none'}`);
      if (existingChannel) {
        void this.resumeAuthenticatedSession(existingChannel);
        return;
      }

      this.stage.set('idle');
      return;
    }

    void this.completeLogin(code, returnedState);
  }

  private async completeLogin(code: string, returnedState: string | null): Promise<void> {
    let sessionEstablished = false;

    try {
      this.stage.set('validating');
      this.pushDebug(`Received code from Twitch. state=${returnedState ?? 'none'}`);
      const expectedState = this.sessionAuth.consumeOAuthState();
      this.pushDebug(`Expected local state=${expectedState ?? 'none'}`);

      if (expectedState && returnedState && expectedState !== returnedState) {
        this.stage.set('error');
        this.errorMessage.set(this.t('login.errors.stateMismatch'));
        return;
      }

      const exchange = await firstValueFrom(this.sessionAuth.exchangeCode(code, returnedState));
      if (exchange.error || !exchange.data) {
        throw new Error(exchange.message || this.t('login.errors.exchangeFailed'));
      }
      this.pushDebug(`Code exchange success. Twitch user id=${exchange.data.twitch_user.id}`);

      this.stage.set('syncing');
      const loginResult = await firstValueFrom(
        this.sessionAuth.loginWithTwitchUser(exchange.data.twitch_user)
      );
      if (loginResult.error || !loginResult.data) {
        throw new Error(loginResult.message || this.t('login.errors.syncFailed'));
      }
      this.pushDebug(`App login success. twitch_user_id=${loginResult.data.twitch_user_id}`);

      this.sessionAuth.completeSession(
        exchange.data.access_token,
        exchange.data.twitch_user,
        loginResult.data
      );
      sessionEstablished = true;
      this.analytics.capture('auth_completed', {
        source: 'oauth_callback',
        primary_channel_id: loginResult.data.twitch_user_id,
        plan_tier: loginResult.data.plan_tier,
        admin_channel_count: loginResult.data.administrating.length,
      });
      this.checkoutIntent.clearPendingReferralCode();

      const primaryChannel = this.resolvePrimaryChannel(
        loginResult.data.twitch_user_id,
        exchange.data.twitch_user.id
      );
      this.pushDebug(`Resolved primary channel=${primaryChannel ?? 'none'}`);

      if (!primaryChannel) {
        throw new Error(this.t('login.errors.noPrimaryChannel'));
      }

      const primaryStreamerLogin = (exchange.data.twitch_user.login || '').trim().toLowerCase();
      if (!primaryStreamerLogin) {
        throw new Error(this.t('login.errors.noPrimaryChannel'));
      }

      const redirectedToCheckout = await this.tryRedirectToCheckout(primaryStreamerLogin);
      if (redirectedToCheckout) {
        return;
      }

      this.stage.set('permissions');

      const channels = [
        primaryChannel,
        ...loginResult.data.administrating.map((entry) => entry.channelID)
      ]
        .map((channel) => this.normalizeChannelID(channel))
        .filter((channel): channel is string => channel !== null);
      const uniqueChannels = [...new Set(channels)];
      this.pushDebug(`Checking permissions for channels=[${uniqueChannels.join(', ')}]`);
      const permissions = ['dashboard:view', 'commands:view', 'settings:view'];

      for (const channel of uniqueChannels) {
        for (const permission of permissions) {
          await firstValueFrom(this.sessionAuth.checkPermission(channel, permission));
        }
      }

      const canOpenDashboard = await firstValueFrom(
        this.sessionAuth.checkPermission(primaryChannel, 'dashboard:view')
      );
      this.pushDebug(`Primary dashboard:view allowed=${String(canOpenDashboard)}`);

      if (!canOpenDashboard) {
        throw new Error(this.t('login.errors.noDashboardAccess'));
      }

      const bootstrap = await firstValueFrom(this.dashboardApi.getBootstrap(primaryChannel));
      if (bootstrap.error) {
        throw new Error(bootstrap.message || this.t('login.errors.dashboardFailed'));
      }

      this.stage.set('dashboard');
      await this.navigateToDashboard(primaryStreamerLogin, primaryChannel);
    } catch (error) {
      this.stage.set('error');

      const authError = error instanceof AuthLoginError ? error : null;
      this.analytics.capture('auth_failed', {
        source: 'oauth_callback',
        reason: error instanceof Error ? error.message : 'unexpected',
        error_code: authError?.code,
        error_type: authError?.errorType,
      });

      if (authError?.code === 'AUTH_MISSING_EMAIL') {
        this.errorMessage.set(this.t('login.errors.emailDenied'));
        this.toastService.warning(
          this.t('login.errors.emailDeniedTitle'),
          this.t('login.errors.emailDeniedMessage'),
          6000
        );
      } else {
        this.errorMessage.set(
          error instanceof Error ? error.message : this.t('login.errors.syncFailed')
        );
      }

      if (!sessionEstablished) {
        this.sessionAuth.clearSession();
      }
    }
  }

  /**
   * Handle admin login flow - redirects to admin.domdimabot.com with session token
   */
  private async completeAdminLogin(code: string | null, returnedState: string | null): Promise<void> {
    if (!code) {
      this.stage.set('error');
      this.errorMessage.set('Missing authorization code');
      return;
    }

    const authCode = code;

    try {
      this.stage.set('validating');

      const expectedState = this.sessionAuth.consumeOAuthState();
      if (expectedState && returnedState && expectedState !== returnedState) {
        this.stage.set('error');
        this.errorMessage.set(this.t('login.errors.stateMismatch'));
        return;
      }

      const exchange = await firstValueFrom(this.sessionAuth.exchangeCode(authCode, returnedState));
      if (exchange.error || !exchange.data) {
        throw new Error(exchange.message || this.t('login.errors.exchangeFailed'));
      }

      this.stage.set('syncing');
      const loginResult = await firstValueFrom(
        this.sessionAuth.loginWithTwitchUser(exchange.data.twitch_user)
      );
      if (loginResult.error || !loginResult.data) {
        throw new Error(loginResult.message || this.t('login.errors.syncFailed'));
      }

      // Store session locally
      this.sessionAuth.completeSession(
        exchange.data.access_token,
        exchange.data.twitch_user,
        loginResult.data
      );

      this.stage.set('redirecting');

      // Parse the return URL from state (format: admin-{returnUrl})
      const returnTo = returnedState?.replace(/^admin-/, '') || 'https://admin.domdimabot.com';

      // Encode session data for transfer to admin panel
      const sessionData = {
        token: exchange.data.access_token,
        twitchUser: exchange.data.twitch_user,
        appUser: loginResult.data
      };
      const encodedToken = btoa(JSON.stringify(sessionData));

      // Redirect to admin panel with session token
      const adminUrl = new URL('/login', returnTo);
      adminUrl.searchParams.set('token', encodedToken);
      window.location.href = adminUrl.toString();
    } catch (error) {
      this.stage.set('error');
      this.errorMessage.set(error instanceof Error ? error.message : this.t('login.errors.syncFailed'));
      this.sessionAuth.clearSession();
    }
  }

  private async resumeAuthenticatedSession(channelID: string): Promise<void> {
    const streamer = this.sessionAuth.toRouteStreamer(channelID);

    try {
      this.stage.set('validating');
      this.pushDebug(`Validating stored session for channel ${channelID}`);
      const isSessionValid = await firstValueFrom(this.sessionAuth.validateSession());
      this.pushDebug(`Stored session valid=${String(isSessionValid)}`);

      if (!isSessionValid) {
        this.analytics.capture('auth_resumed', {
          source: 'stored_session_invalid',
          result: 'expired',
          primary_channel_id: channelID,
        });
        this.sessionAuth.clearSession();
        this.stage.set('error');
        this.errorMessage.set(this.t('login.errors.sessionExpired'));
        this.queueReturnToLogin('session_expired_resume');
        return;
      }

      this.checkoutIntent.clearPendingReferralCode();
      this.analytics.capture('auth_resumed', {
        source: 'stored_session',
        result: 'success',
        primary_channel_id: channelID,
        streamer,
      });

      const redirectedToCheckout = await this.tryRedirectToCheckout(streamer);
      if (redirectedToCheckout) {
        return;
      }

      this.pushDebug(`Existing session detected. Navigating to /${streamer}/dashboard`);
      await this.navigateToDashboard(streamer, channelID);
    } catch (error) {
      this.analytics.capture('auth_failed', {
        source: 'stored_session',
        reason: this.resolveResumeError(error),
        primary_channel_id: channelID,
      });
      this.sessionAuth.clearSession();
      this.stage.set('error');
      this.errorMessage.set(this.resolveResumeError(error));
    }
  }

  private async tryRedirectToCheckout(streamerLogin: string): Promise<boolean> {
    const pendingPlan = this.checkoutIntent.getPendingPlan();
    if (!pendingPlan) {
      return false;
    }

    this.pushDebug(`Pending paid plan detected: ${pendingPlan}`);

    const context = await firstValueFrom(this.billingService.getContext(pendingPlan));
    if (context.error || !context.data) {
      throw new Error(context.message || 'Unable to resolve billing state');
    }

    if (!this.shouldStartCheckout(context.data)) {
      this.pushDebug(`Checkout skipped for scenario=${context.data.scenario}`);
      this.checkoutIntent.clearPendingPlan();
      return false;
    }

    const dashboardUrl = `${window.location.origin}/${encodeURIComponent(streamerLogin)}/dashboard`;
    const checkout = await firstValueFrom(
      this.billingService.createCheckout({
        targetPlan: pendingPlan,
        successUrl: dashboardUrl,
        returnUrl: dashboardUrl
      })
    );

    if (checkout.error || !checkout.data?.checkoutUrl) {
      throw new Error(checkout.message || 'Unable to create checkout');
    }

    this.checkoutIntent.clearPendingPlan();
    this.stage.set('redirecting');
    this.pushDebug(`Redirecting to Polar checkout for ${pendingPlan}`);
    this.analytics.capture('checkout_redirected', {
      source: 'login_flow',
      target_plan: pendingPlan,
      billing_scenario: context.data.scenario,
    });
    window.location.assign(checkout.data.checkoutUrl);
    return true;
  }

  private shouldStartCheckout(context: BillingContextData): boolean {
    return (
      context.scenario === 'new' ||
      context.scenario === 'upgrade' ||
      context.scenario === 'reactivate' ||
      context.scenario === 'returning_winback'
    );
  }

  private pushDebug(line: string): void {
    this.debugLines.update((lines) => [
      ...lines,
      `[${new Date().toISOString()}] ${line}`
    ]);
  }

  private applyGuardFailure(debug: string): void {
    if (debug !== 'not_authenticated') {
      this.analytics.capture('auth_guard_failed', {
        reason: debug,
      });
    }

    if (debug === 'session_invalid' || debug === 'session_validation_error') {
      this.sessionAuth.clearSession();
      this.pushDebug('Stored session cleared after auth validation failed.');
      this.stage.set('error');
      this.errorMessage.set(this.t('login.errors.sessionExpired'));
      this.queueReturnToLogin(debug);
      return;
    }

    if (debug === 'not_authenticated') {
      this.stage.set('idle');
      return;
    }

    this.stage.set('error');

    if (debug === 'permission_denied' || debug === 'permission_check_error') {
      this.errorMessage.set(this.t('login.errors.permissionRedirectFailed'));
      return;
    }

    if (debug === 'unresolved_streamer' || debug === 'missing_channel_param') {
      this.errorMessage.set(this.t('login.errors.navigationFailed'));
      return;
    }

    if (debug === 'mock_login_failed') {
      this.errorMessage.set('Mock login failed. Check MOCK_LOGIN_TOKEN on the API.');
      return;
    }

    this.errorMessage.set(this.t('login.errors.unexpected'));
  }

  private async navigateToDashboard(streamer: string, channelID: string): Promise<void> {
    this.stage.set('redirecting');
    this.pushDebug(`Navigating to /${streamer}/dashboard (id=${channelID})`);

    const didNavigate = await this.router.navigate(['/', streamer, 'dashboard']);
    if (!didNavigate) {
      throw new Error(this.t('login.errors.navigationFailed'));
    }
  }

  private resolveResumeError(error: unknown): string {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = Number((error as { status?: number }).status);
      if (status === 401 || status === 403) {
        return this.t('login.errors.sessionExpired');
      }
    }

    return error instanceof Error ? error.message : this.t('login.errors.unexpected');
  }

  private queueReturnToLogin(reason: string): void {
    this.cancelPendingLoginReset();
    this.pushDebug(
      `Redirecting back to clean login in ${LOGIN_RESET_REDIRECT_DELAY_MS}ms. reason=${reason}`
    );
    this.toastService.warning(
      this.t('login.toast.sessionExpiredTitle'),
      this.t('login.toast.sessionExpiredMessage'),
      LOGIN_RESET_TOAST_DURATION_MS
    );

    this.redirectTimeoutHandle = window.setTimeout(() => {
      this.redirectTimeoutHandle = null;
      void this.router.navigate(['/login'], {
        replaceUrl: true
      });
    }, LOGIN_RESET_REDIRECT_DELAY_MS);
  }

  private cancelPendingLoginReset(): void {
    if (this.redirectTimeoutHandle === null) {
      return;
    }

    window.clearTimeout(this.redirectTimeoutHandle);
    this.redirectTimeoutHandle = null;
  }

  private buildQuerySignature(query: ParamMap): string {
    const keys = ['code', 'state', 'error', 'debug', 'channelID', 'streamer', 'permission'];
    return keys.map((key) => `${key}=${query.get(key) ?? ''}`).join('&');
  }

  private resolvePrimaryChannel(primaryFromLogin: string | undefined, primaryFromTwitch: string): string | null {
    const normalizedLogin = this.normalizeChannelID(primaryFromLogin);
    if (normalizedLogin) {
      return normalizedLogin;
    }

    const normalizedTwitch = this.normalizeChannelID(primaryFromTwitch);
    if (normalizedTwitch) {
      return normalizedTwitch;
    }

    return null;
  }

  private normalizeChannelID(value: string | undefined | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'undefined' || normalized === 'null') {
      return null;
    }

    return normalized;
  }

  extractTimestamp(line: string): string {
    const match = line.match(/^\[([^\]]+)\]/);
    return match ? match[1].split('T')[1]?.split('.')[0] || match[1] : '';
  }

  extractContent(line: string): string {
    return line.replace(/^\[[^\]]+\]\s*/, '');
  }
}
