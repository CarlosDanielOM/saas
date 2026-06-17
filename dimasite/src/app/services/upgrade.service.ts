import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AnalyticsService } from './analytics.service';
import { BillingService } from './billing.service';
import {
  type UpgradeChoice,
  type UpgradePromptData,
  type UpgradeTierOffer,
  UpgradeModalService
} from './upgrade-modal.service';
import { SessionAuthService } from './session-auth.service';
import { LanguageService } from './language.service';
import {
  type ModuleId,
  type ModuleTierRequirement,
  type PlanTier,
  MODULE_TIER_REQUIREMENTS,
  getAvailableUpgradeTiers,
  getRequiredTierForModule,
  isModuleAccessible
} from '../features/modules/module-tier.model';

export type UpgradePromptResult =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'already_subscribed' }
  | { readonly kind: 'redirected'; readonly tier: 'premium' | 'pro' }
  | { readonly kind: 'error'; readonly message: string };

const PREMIUM_BENEFITS: readonly string[] = [
  '125,000 AI credits / month',
  'Human-like TTS voices',
  'Memory learning from chat',
  'Public or private upload visibility',
  'Priority support'
];

const PRO_BENEFITS: readonly string[] = [
  '500,000 AI credits / month',
  'Voice cloning TTS',
  'Learns from chat + stream summaries',
  'Public or private upload visibility',
  'Priority+ support',
  'Custom SO overlay design'
];

@Injectable({
  providedIn: 'root'
})
export class UpgradeService {
  private readonly analytics = inject(AnalyticsService);
  private readonly billingService = inject(BillingService);
  private readonly modalService = inject(UpgradeModalService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly languageService = inject(LanguageService);

  async promptUpgradeForModule(input: {
    moduleId: ModuleId;
    source: string;
  }): Promise<UpgradePromptResult> {
    const req = MODULE_TIER_REQUIREMENTS[input.moduleId];
    const currentTier = this.getCurrentTier();

    if (isModuleAccessible(req, currentTier)) {
      this.analytics.capture('upgrade_prompt_skipped', {
        module_id: input.moduleId,
        current_tier: currentTier,
        reason: 'already_accessible'
      });
      return { kind: 'skipped' };
    }

    const availableTiers = getAvailableUpgradeTiers(req, currentTier);
    const offers = this.buildOffersForTiers(availableTiers, currentTier);
    const requiredTier = getRequiredTierForModule(req, currentTier);

    this.analytics.capture('upgrade_prompt_opened', {
      module_id: input.moduleId,
      module_name: req.displayName,
      source: input.source,
      current_tier: currentTier,
      required_tier: requiredTier,
      offered_tiers: availableTiers.join(',')
    });

    return this.runPrompt(
      {
        moduleId: input.moduleId,
        moduleName: req.displayName,
        requiredTier,
        currentTier,
        offers,
        state: 'offer',
        source: input.source
      },
      input.source
    );
  }

  async promptUpgradeForAnyPlan(source: string): Promise<UpgradePromptResult> {
    const currentTier = this.getCurrentTier();
    const moduleId: ModuleId = 'analytics';
    const req = MODULE_TIER_REQUIREMENTS[moduleId];

    if (currentTier === 'pro') {
      this.analytics.capture('upgrade_prompt_skipped', {
        source,
        current_tier: currentTier,
        reason: 'already_max_tier'
      });
      return { kind: 'skipped' };
    }

    const availableTiers: ('premium' | 'pro')[] = currentTier === 'free' ? ['premium', 'pro'] : ['pro'];
    const offers = this.buildOffersForTiers(availableTiers, currentTier);
    const requiredTier: PlanTier = currentTier === 'free' ? 'premium' : 'pro';

    this.analytics.capture('upgrade_prompt_opened', {
      source,
      current_tier: currentTier,
      required_tier: requiredTier,
      offered_tiers: availableTiers.join(',')
    });

    return this.runPrompt(
      {
        moduleId,
        moduleName: req.displayName,
        requiredTier,
        currentTier,
        offers,
        state: 'offer',
        source
      },
      source
    );
  }

  private async runPrompt(data: UpgradePromptData, source: string): Promise<UpgradePromptResult> {
    return new Promise<UpgradePromptResult>((resolve) => {
      this.modalService.open(data, (choice) => {
        this.handleChoice(choice, data, source, resolve).catch(() => {
          resolve({ kind: 'error', message: 'unexpected_error' });
        });
      });
    });
  }

  private async handleChoice(
    choice: UpgradeChoice,
    data: UpgradePromptData,
    source: string,
    resolve: (result: UpgradePromptResult) => void
  ): Promise<void> {
    if (choice.kind === 'cancel') {
      this.analytics.capture('upgrade_prompt_cancelled', {
        module_id: data.moduleId,
        source
      });
      this.modalService.close();
      resolve({ kind: 'cancelled' });
      return;
    }

    if (choice.kind === 'already_subscribed') {
      this.analytics.capture('upgrade_prompt_already_subscribed_dismissed', {
        module_id: data.moduleId,
        source
      });
      this.modalService.close();
      resolve({ kind: 'already_subscribed' });
      return;
    }

    if (choice.kind === 'retry') {
      const retryTier = data.lastAttemptedTier;
      if (!retryTier) {
        this.modalService.close();
        resolve({ kind: 'cancelled' });
        return;
      }
      this.analytics.capture('upgrade_retry_clicked', {
        module_id: data.moduleId,
        source,
        tier: retryTier
      });
      await this.processSubscribe(retryTier, data, source, resolve);
      return;
    }

    await this.processSubscribe(choice.tier, data, source, resolve);
  }

  private async processSubscribe(
    tier: 'premium' | 'pro',
    data: UpgradePromptData,
    source: string,
    resolve: (result: UpgradePromptResult) => void
  ): Promise<void> {
    this.modalService.setLastAttemptedTier(tier);
    this.modalService.updateState('loading');
    this.analytics.capture('upgrade_tier_selected', {
      tier,
      module_id: data.moduleId,
      source
    });

    try {
      const context = await firstValueFrom(this.billingService.getContext(tier));
      if (context.error || !context.data) {
        throw new Error(context.message ?? 'Unable to resolve billing state');
      }

      if (context.data.scenario === 'active_no_change') {
        this.analytics.capture('upgrade_prompt_already_subscribed', {
          tier,
          module_id: data.moduleId,
          source
        });
        this.modalService.updateState('already_subscribed');
        return;
      }

      if (context.data.scenario === 'returning_winback') {
        this.modalService.updateState('winback');
      } else if (context.data.scenario === 'reactivate') {
        this.modalService.updateState('reactivate');
      }

      const baseUrl = window.location.origin + window.location.pathname;
      const successUrl = `${baseUrl}?upgrade=success&tier=${tier}`;
      const returnUrl = baseUrl;

      const checkout = await firstValueFrom(
        this.billingService.createCheckout({
          targetPlan: tier,
          successUrl,
          returnUrl
        })
      );

      if (checkout.error || !checkout.data?.checkoutUrl) {
        throw new Error(checkout.message ?? 'Unable to create checkout');
      }

      this.analytics.capture('checkout_redirected', {
        source: 'upgrade_modal',
        target_plan: tier,
        billing_scenario: context.data.scenario,
        module_id: data.moduleId
      });

      this.modalService.close();
      window.location.assign(checkout.data.checkoutUrl);
      resolve({ kind: 'redirected', tier });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unable to start checkout';
      this.modalService.updateState('error', errorMessage);
      this.analytics.capture('upgrade_checkout_error', {
        module_id: data.moduleId,
        tier,
        source,
        error: errorMessage
      });
    }
  }

  private buildOffersForTiers(
    tiers: readonly ('premium' | 'pro')[],
    currentTier: PlanTier
  ): UpgradeTierOffer[] {
    return tiers.map((tier) => this.buildOffer(tier, currentTier));
  }

  private buildOffer(tier: 'premium' | 'pro', currentTier: PlanTier): UpgradeTierOffer {
    const recommended = tier === 'pro' && currentTier === 'free';
    const benefits = tier === 'pro' ? PRO_BENEFITS : PREMIUM_BENEFITS;

    let ctaLabel: string;
    if (currentTier === 'free') {
      ctaLabel = tier === 'pro'
        ? this.t('upgradeModal.tiers.pro.cta')
        : this.t('upgradeModal.tiers.premium.cta');
    } else if (currentTier === 'premium' && tier === 'pro') {
      ctaLabel = this.t('upgradeModal.tiers.pro.upgradeCta');
    } else {
      ctaLabel = tier === 'pro'
        ? this.t('upgradeModal.tiers.pro.cta')
        : this.t('upgradeModal.tiers.premium.cta');
    }

    return {
      tier,
      name: tier === 'pro'
        ? this.t('upgradeModal.tiers.pro.name')
        : this.t('upgradeModal.tiers.premium.name'),
      priceLabel: tier === 'pro'
        ? this.t('upgradeModal.tiers.pro.price')
        : this.t('upgradeModal.tiers.premium.price'),
      benefits,
      recommended,
      ctaLabel
    };
  }

  private getCurrentTier(): PlanTier {
    return this.sessionAuth.session()?.appUser.plan_tier ?? 'free';
  }

  private t(key: string): string {
    return this.languageService.translate(key);
  }
}
