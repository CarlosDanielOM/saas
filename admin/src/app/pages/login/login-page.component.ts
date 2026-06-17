import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { SessionAuthService } from '../../services/session-auth.service';

type LoginStage = 'idle' | 'validating' | 'syncing' | 'redirecting' | 'error';

@Component({
  selector: 'app-login-page',
  templateUrl: './login-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: []
})
export class LoginPageComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);

  readonly stage = signal<LoginStage>('idle');
  readonly errorMessage = signal<string | null>(null);

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((query) => {
      void this.handleQueryState(query);
    });
  }

  /**
   * Redirect to main site login, which will handle OAuth and redirect back with token
   */
  loginWithTwitch(): void {
    // Redirect to main site's login page with returnTo parameter
    const returnTo = encodeURIComponent('https://admin.domdimabot.com');
    window.location.href = `https://domdimabot.com/login?returnTo=${returnTo}`;
  }

  private async handleQueryState(query: ParamMap): Promise<void> {
    // Check if we were redirected from main site with a token
    const token = query.get('token');
    if (token) {
      void this.handleTokenFromMainSite(token);
      return;
    }

    const error = query.get('error');

    this.errorMessage.set(null);

    if (error) {
      this.stage.set('error');
      this.errorMessage.set('Twitch authorization was denied. Please try again.');
      return;
    }

    // No code/token - show idle state
    const existingChannel = this.sessionAuth.getPrimaryChannelID();
    if (existingChannel) {
      void this.resumeAuthenticatedSession();
      return;
    }

    this.stage.set('idle');
  }

  /**
   * Handle token passed from domdimabot.com after admin login
   */
  private async handleTokenFromMainSite(token: string): Promise<void> {
    try {
      this.stage.set('validating');

      // Decode the token from URL (it's base64 encoded JSON)
      const decoded = JSON.parse(atob(token));

      if (!decoded.token || !decoded.twitchUser || !decoded.appUser) {
        throw new Error('Invalid token data');
      }

      // Store the session
      this.sessionAuth.completeSession(
        decoded.token,
        decoded.twitchUser,
        decoded.appUser
      );

      this.stage.set('redirecting');

      // Clean up URL
      await this.router.navigate([], {
        queryParams: { token: null },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });

      await this.router.navigate(['/dashboard']);
    } catch (err) {
      this.stage.set('error');
      this.errorMessage.set('Failed to restore session from main site.');
      this.sessionAuth.clearSession();
    }
  }

  private async resumeAuthenticatedSession(): Promise<void> {
    await this.router.navigate(['/dashboard']);
  }
}