import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import { CheerTier, PlanTier, TierInfoMessage, TierLimits } from '../chat-events.model';
import { ChatEventsService } from '../chat-events.service';

@Component({
  selector: 'app-tier-editor',
  imports: [],
  styleUrl: './tier-editor.component.css',
  templateUrl: './tier-editor.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TierEditorComponent {
  private readonly languageService = inject(LanguageService);
  private readonly toastService = inject(ToastService);
  private readonly chatEventsService = inject(ChatEventsService);

  readonly tiers = input.required<CheerTier[]>();
  readonly tierLimits = input<TierLimits | undefined>(undefined);
  readonly userPlan = input.required<PlanTier>();
  readonly disabled = input(false);
  readonly tiersChange = output<CheerTier[]>();

  readonly canAdd = computed(() => {
    return this.chatEventsService.canAddTier(this.tierLimits(), this.tiers(), this.userPlan());
  });

  readonly tierInfoMessage = computed((): TierInfoMessage | null => {
    if (this.canAdd()) {
      return null;
    }

    const limit = this.chatEventsService.getTierLimit(this.tierLimits(), this.userPlan());

    if (this.userPlan() === 'none') {
      return {
        message: this.t('chatEvents.tierInfo.premiumFeature'),
        level: 'upsell-premium'
      };
    }

    if (this.userPlan() === 'premium') {
      return {
        message: this.t('chatEvents.tierInfo.upgradePrompt', { limit }),
        level: 'upsell-pro'
      };
    }

    return {
      message: this.t('chatEvents.tierInfo.maxReached', { limit }),
      level: 'limit-reached'
    };
  });

  readonly addTierTooltip = computed(() => {
    if (this.canAdd()) {
      return this.t('chatEvents.tooltips.addTierDefault');
    }

    const limit = this.chatEventsService.getTierLimit(this.tierLimits(), this.userPlan());

    if (this.userPlan() === 'none') {
      return this.t('chatEvents.tooltips.addTierRequiresPremium');
    }
    if (this.userPlan() === 'premium') {
      return this.t('chatEvents.tooltips.addTierUpgradePrompt', { limit });
    }
    return this.t('chatEvents.tooltips.addTierMaxReached', { limit });
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  addTier(): void {
    if (this.disabled()) {
      return;
    }

    if (!this.canAdd()) {
      this.toastService.info(this.t('chatEvents.toasts.limitReachedTitle'), this.addTierTooltip());
      return;
    }

    const newTier: CheerTier = {
      id: `tier-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: this.t('chatEvents.newTier'),
      message: '',
      minAmount: 0,
      maxAmount: 0
    };

    this.tiersChange.emit([...this.tiers(), newTier]);

    this.toastService.success(
      this.t('chatEvents.toasts.tierAddedTitle'),
      this.t('chatEvents.toasts.tierAddedMsg')
    );
  }

  removeTier(tierId: string): void {
    if (this.disabled()) {
      return;
    }

    this.tiersChange.emit(this.tiers().filter((t) => t.id !== tierId));

    this.toastService.success(
      this.t('chatEvents.toasts.tierRemovedTitle'),
      this.t('chatEvents.toasts.tierRemovedMsg')
    );
  }

  updateTier(tierId: string, field: keyof CheerTier, event: Event): void {
    if (this.disabled()) {
      return;
    }

    const input = event.target as HTMLInputElement;
    const value = field === 'name' || field === 'message' ? input.value : parseInt(input.value, 10) || 0;

    this.tiersChange.emit(
      this.tiers().map((tier) => (tier.id === tierId ? { ...tier, [field]: value } : tier))
    );
  }
}
