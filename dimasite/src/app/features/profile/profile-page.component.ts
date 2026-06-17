import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideAngularModule, Sparkles } from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LoadingIndicatorComponent } from '../../components/loading';

@Component({
  selector: 'app-profile-page',
  imports: [LucideAngularModule, LoadingIndicatorComponent],
  templateUrl: './profile-page.component.html',
  styleUrl: './profile-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly upgradeService = inject(UpgradeService);

  readonly sparklesIcon = Sparkles;
  readonly isLoading = computed(() => this.sessionAuth.session() === null);
  readonly planTier = computed(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
  readonly planBadgeClass = computed(() => `profile-plan-badge profile-plan-badge--${this.planTier()}`);
  readonly showUpgradeCta = computed(() => this.planTier() !== 'pro');

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

  onUpgradeClick(): void {
    void this.upgradeService.promptUpgradeForAnyPlan('profile_page');
  }
}
