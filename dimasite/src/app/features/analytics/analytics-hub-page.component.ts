import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Lock,
  LucideAngularModule,
  Sparkles,
  Users,
  Zap,
} from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

@Component({
  selector: 'app-analytics-hub-page',
  imports: [RouterLink, LucideAngularModule],
  styleUrl: './analytics-hub-page.component.css',
  templateUrl: './analytics-hub-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalyticsHubPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly upgradeService = inject(UpgradeService);

  readonly sparklesIcon = Sparkles;
  readonly followersIcon = Users;
  readonly arrowIcon = ArrowRight;
  readonly lockIcon = Lock;
  readonly backIcon = ArrowLeft;
  readonly activityIcon = Activity;
  readonly zapIcon = Zap;

  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    const sessionStreamer = this.sessionAuth.session()?.twitchUser.login;
    return (routeStreamer || sessionStreamer || '').trim().toLowerCase();
  });
  readonly planTier = computed(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
  readonly hasPaidAccess = computed(() => this.planTier() !== 'free');
  readonly modulesLink = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });
  readonly followLedgerLink = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules', 'analytics', 'follows'] : ['/'];
  });
  readonly planTierLabel = computed(() => {
    const tier = this.planTier();
    if (tier === 'pro') {
      return this.t('navbar.planPro');
    }
    if (tier === 'premium') {
      return this.t('navbar.planPremium');
    }
    return this.t('navbar.planFree');
  });
  readonly planStatusLabel = computed(() =>
    this.hasPaidAccess()
      ? this.t('analyticsHub.panel.paidPlan')
      : this.t('analyticsHub.panel.freePlan'),
  );

  t(key: string): string {
    return this.languageService.translate(key);
  }

  openLockedNotice(): void {
    void this.upgradeService.promptUpgradeForModule({
      moduleId: 'analytics.follows',
      source: 'analytics_hub',
    });
  }
}
