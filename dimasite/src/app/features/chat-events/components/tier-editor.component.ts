import { ChangeDetectionStrategy, Component, input, output, computed, inject } from '@angular/core';
import { LucideAngularModule, Crown, Trash2, PlusCircle } from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import { CheerTier, TierLimits, PlanTier, TierInfoMessage } from '../chat-events.model';
import { ChatEventsService } from '../chat-events.service';

@Component({
  selector: 'app-tier-editor',
  imports: [LucideAngularModule],
  template: `
    @if (tiers().length > 0) {
      <div class="tier-editor__tiers">
        @for (tier of tiers(); track tier.id) {
          <div 
            class="tier-editor__tier">
            
            <button
              type="button"
              class="tier-editor__remove-btn"
              [disabled]="disabled()"
              (click)="removeTier(tier.id)"
              [attr.aria-label]="t('chatEvents.tierRemoveAria', { name: tier.name })">
              <lucide-icon [name]="trashIcon" class="tier-editor__remove-icon"></lucide-icon>
            </button>

            <div class="tier-editor__tier-grid">
              <!-- Tier Name -->
              <div class="tier-editor__field tier-editor__field--full">
                <label [for]="'tier-name-' + tier.id" class="tier-editor__label">
                  {{ t('chatEvents.tierName') }}
                </label>
                <input
                  [id]="'tier-name-' + tier.id"
                  type="text"
                  [value]="tier.name"
                  [disabled]="disabled()"
                  (input)="updateTier(tier.id, 'name', $event)"
                  class="tier-editor__input"
                  [placeholder]="t('chatEvents.tierNamePlaceholder')" />
              </div>

              <!-- Min Amount -->
              <div class="tier-editor__field">
                <label [for]="'tier-min-' + tier.id" class="tier-editor__label">
                  {{ t('chatEvents.minBits') }}
                </label>
                <input
                  [id]="'tier-min-' + tier.id"
                  type="number"
                  [value]="tier.minAmount"
                  [disabled]="disabled()"
                  (input)="updateTier(tier.id, 'minAmount', $event)"
                  class="tier-editor__input tier-editor__input--number"
                  min="0" />
              </div>

              <!-- Max Amount -->
              <div class="tier-editor__field">
                <label [for]="'tier-max-' + tier.id" class="tier-editor__label">
                  {{ t('chatEvents.maxBits') }}
                </label>
                <input
                  [id]="'tier-max-' + tier.id"
                  type="number"
                  [value]="tier.maxAmount"
                  [disabled]="disabled()"
                  (input)="updateTier(tier.id, 'maxAmount', $event)"
                  class="tier-editor__input tier-editor__input--number"
                  min="0" />
              </div>

              <!-- Message -->
              <div class="tier-editor__field tier-editor__field--full">
                <label [for]="'tier-msg-' + tier.id" class="tier-editor__label">
                  {{ t('chatEvents.message') }}
                </label>
                <input
                  [id]="'tier-msg-' + tier.id"
                  type="text"
                  [value]="tier.message"
                  [disabled]="disabled()"
                  (input)="updateTier(tier.id, 'message', $event)"
                  class="tier-editor__input"
                  [placeholder]="t('chatEvents.messagePlaceholder')" />
              </div>
            </div>
          </div>
        }
      </div>
    }

    <!-- Add Tier Button -->
    <button
      type="button"
      class="tier-editor__add-btn"
      [class.tier-editor__add-btn--disabled]="disabled() || !canAdd()"
      [disabled]="disabled() || !canAdd()"
      [title]="addTierTooltip()"
      (click)="addTier()">
      <lucide-icon [name]="plusCircleIcon" class="tier-editor__add-icon"></lucide-icon>
      <span>{{ t('chatEvents.addMessageTier') }}</span>
    </button>

    <!-- Tier Info Message -->
    @if (tierInfoMessage()) {
      <div 
        class="tier-editor__info"
        [class.tier-editor__info--upsell]="tierInfoMessage()?.level === 'upsell-premium' || tierInfoMessage()?.level === 'upsell-pro'"
        [class.tier-editor__info--limit]="tierInfoMessage()?.level === 'limit-reached'">
        @if (tierInfoMessage()?.level === 'upsell-premium') {
          <lucide-icon [name]="crownIcon" class="tier-editor__info-icon tier-editor__info-icon--premium"></lucide-icon>
        } @else if (tierInfoMessage()?.level === 'upsell-pro') {
          <div class="tier-editor__info-icon tier-editor__info-icon--pro-wrapper">
            <lucide-icon [name]="crownIcon" class="tier-editor__info-icon tier-editor__info-icon--pro"></lucide-icon>
            <span class="tier-editor__info-icon-plus">+</span>
          </div>
        }
        <span class="tier-editor__info-text">{{ tierInfoMessage()?.message }}</span>
      </div>
    }
  `,
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

  readonly crownIcon = Crown;
  readonly trashIcon = Trash2;
  readonly plusCircleIcon = PlusCircle;

  readonly canAdd = computed(() => {
    return this.chatEventsService.canAddTier(
      this.tierLimits(),
      this.tiers(),
      this.userPlan()
    );
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
      this.toastService.info(
        this.t('chatEvents.toasts.limitReachedTitle'),
        this.addTierTooltip()
      );
      return;
    }

    const newTier: CheerTier = {
      id: `tier-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: this.t('chatEvents.newTier'),
      message: '',
      minAmount: 0,
      maxAmount: 0
    };

    const updatedTiers = [...this.tiers(), newTier];
    this.tiersChange.emit(updatedTiers);

    this.toastService.success(
      this.t('chatEvents.toasts.tierAddedTitle'),
      this.t('chatEvents.toasts.tierAddedMsg')
    );
  }

  removeTier(tierId: string): void {
    if (this.disabled()) {
      return;
    }

    const updatedTiers = this.tiers().filter(t => t.id !== tierId);
    this.tiersChange.emit(updatedTiers);

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
    const value = field === 'name' || field === 'message' 
      ? input.value 
      : parseInt(input.value, 10) || 0;

    const updatedTiers = this.tiers().map(tier => {
      if (tier.id === tierId) {
        return { ...tier, [field]: value };
      }
      return tier;
    });

    this.tiersChange.emit(updatedTiers);
  }
}
