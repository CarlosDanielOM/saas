import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { DashboardApiService } from '../../services/dashboard-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { LoginLoader3DComponent, type LoaderStage } from './login-loader-3d.component';

type LoginStage =
  | 'idle'
  | 'validating'
  | 'syncing'
  | 'permissions'
  | 'dashboard'
  | 'redirecting'
  | 'error';

@Component({
  selector: 'app-login-page',
  templateUrl: './login-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LoginLoader3DComponent]
})
export class LoginPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly languageService = inject(LanguageService);
  private readonly dashboardApi = inject(DashboardApiService);

  readonly stage = signal<LoginStage>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly debugLines = signal<string[]>([]);

  readonly loaderStage = computed<LoaderStage>(() => {
    const current = this.stage();
    if (current === 'idle' || current === 'error') {
      return 'validating';
    }
    return current;
  });

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

  ngOnInit(): void {
    const query = this.route.snapshot.queryParamMap;
    const code = query.get('code');
    const returnedState = query.get('state');
    const error = query.get('error');
    const debug = query.get('debug');

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
      this.errorMessage.set(this.t('login.errors.denied'));
      return;
    }

    if (!code) {
      const existingChannel = this.sessionAuth.getPrimaryChannelID();
      this.pushDebug(`No code in URL. Existing channel: ${existingChannel ?? 'none'}`);
      if (existingChannel) {
        void this.router.navigate(['/', existingChannel, 'dashboard']);
        return;
      }

      this.stage.set('idle');
      return;
    }

    void this.completeLogin(code, returnedState);
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  loginWithTwitch(): void {
    this.sessionAuth.startTwitchLogin();
  }

  private async completeLogin(code: string, returnedState: string | null): Promise<void> {
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

      this.stage.set('permissions');
      const primaryChannel = this.resolvePrimaryChannel(
        loginResult.data.twitch_user_id,
        exchange.data.twitch_user.id
      );
      this.pushDebug(`Resolved primary channel=${primaryChannel ?? 'none'}`);

      if (!primaryChannel) {
        throw new Error(this.t('login.errors.noPrimaryChannel'));
      }

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

      const primaryStreamerLogin = (exchange.data.twitch_user.login || '').trim().toLowerCase();
      if (!primaryStreamerLogin) {
        throw new Error(this.t('login.errors.noPrimaryChannel'));
      }

      this.stage.set('dashboard');
      const bootstrap = await firstValueFrom(this.dashboardApi.getBootstrap(primaryChannel));
      if (bootstrap.error) {
        throw new Error(bootstrap.message || this.t('login.errors.dashboardFailed'));
      }

      this.stage.set('redirecting');
      this.pushDebug(`Navigating to /${primaryStreamerLogin}/dashboard (id=${primaryChannel})`);
      await this.router.navigate(['/', primaryStreamerLogin, 'dashboard']);
    } catch (error) {
      this.stage.set('error');
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('login.errors.unexpected')
      );
      this.sessionAuth.clearSession();
    }
  }

  private pushDebug(line: string): void {
    this.debugLines.update((lines) => [
      ...lines,
      `[${new Date().toISOString()}] ${line}`
    ]);
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
