import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowRight,
  BarChart3,
  Lock,
  LucideAngularModule,
  Sparkles,
  Users
} from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

@Component({
  selector: 'app-analytics-hub-page',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './analytics-hub-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AnalyticsHubPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);

  readonly sparklesIcon = Sparkles;
  readonly analyticsIcon = BarChart3;
  readonly followersIcon = Users;
  readonly arrowIcon = ArrowRight;
  readonly lockIcon = Lock;

  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    const sessionStreamer = this.sessionAuth.session()?.twitchUser.login;
    return (routeStreamer || sessionStreamer || '').trim().toLowerCase();
  });
  readonly planTier = computed(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
  readonly hasPaidAccess = computed(() => this.planTier() !== 'free');
  readonly followLedgerLink = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules', 'analytics', 'follows'] : ['/'];
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  openLockedNotice(): void {
    this.toastService.warning(this.t('common.premiumFeature'), this.t('common.premiumSubscriptionRequired'));
  }
}
