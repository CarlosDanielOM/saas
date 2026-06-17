import { Injectable, computed, signal } from '@angular/core';

import {
  type ModuleId,
  type PlanTier
} from '../features/modules/module-tier.model';

export type UpgradePromptState =
  | 'offer'
  | 'loading'
  | 'already_subscribed'
  | 'error'
  | 'winback'
  | 'reactivate';

export interface UpgradeTierOffer {
  readonly tier: 'premium' | 'pro';
  readonly name: string;
  readonly priceLabel: string;
  readonly benefits: readonly string[];
  readonly recommended: boolean;
  readonly ctaLabel: string;
}

export interface UpgradePromptData {
  readonly moduleId: ModuleId;
  readonly moduleName: string;
  readonly requiredTier: PlanTier;
  readonly currentTier: PlanTier;
  readonly offers: readonly UpgradeTierOffer[];
  readonly state: UpgradePromptState;
  readonly source: string;
  readonly errorMessage?: string;
  readonly lastAttemptedTier?: 'premium' | 'pro';
}

export type UpgradeChoice =
  | { readonly kind: 'subscribe'; readonly tier: 'premium' | 'pro' }
  | { readonly kind: 'already_subscribed' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'retry' };

type ChoiceHandler = (choice: UpgradeChoice) => void;

@Injectable({
  providedIn: 'root'
})
export class UpgradeModalService {
  private readonly _currentPrompt = signal<UpgradePromptData | null>(null);
  private choiceHandler: ChoiceHandler | null = null;

  readonly currentPrompt = computed(() => this._currentPrompt());
  readonly isOpen = computed(() => this._currentPrompt() !== null);

  open(data: UpgradePromptData, onChoice: ChoiceHandler): void {
    if (this.choiceHandler) {
      this.choiceHandler({ kind: 'cancel' });
    }
    this._currentPrompt.set(data);
    this.choiceHandler = onChoice;
  }

  updateState(state: UpgradePromptState, errorMessage?: string): void {
    const current = this._currentPrompt();
    if (!current) {
      return;
    }
    this._currentPrompt.set({
      ...current,
      state,
      errorMessage: errorMessage ?? current.errorMessage
    });
  }

  setLastAttemptedTier(tier: 'premium' | 'pro'): void {
    const current = this._currentPrompt();
    if (!current) {
      return;
    }
    this._currentPrompt.set({ ...current, lastAttemptedTier: tier });
  }

  emitChoice(choice: UpgradeChoice): void {
    if (!this.choiceHandler) {
      return;
    }
    const handler = this.choiceHandler;
    this.choiceHandler = null;
    handler(choice);
  }

  close(): void {
    if (this.choiceHandler) {
      this.choiceHandler({ kind: 'cancel' });
      this.choiceHandler = null;
    }
    this._currentPrompt.set(null);
  }
}
