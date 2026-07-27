import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import {
  ChatEvent,
  ChatEventPendingAction,
  CheerTier,
  ConfigControl,
  PlanTier
} from '../chat-events.model';
import { TierEditorComponent } from './tier-editor.component';

@Component({
  selector: 'app-config-panel',
  imports: [FormsModule, TierEditorComponent],
  styleUrl: './config-panel.component.css',
  templateUrl: './config-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConfigPanelComponent {
  private readonly languageService = inject(LanguageService);
  private readonly toastService = inject(ToastService);

  readonly event = input<ChatEvent | undefined>(undefined);
  readonly userPlan = input.required<PlanTier>();
  readonly pendingAction = input<ChatEventPendingAction>('none');
  readonly save = output<void>();
  readonly delete = output<void>();

  readonly canDelete = computed(() => {
    const event = this.event();
    if (!event?.config || event.config.length === 0) {
      return true;
    }
    return event.config[0].canDisable !== false;
  });

  readonly isSaving = computed(() => this.pendingAction() === 'saving');
  readonly isDeleting = computed(() => this.pendingAction() === 'deleting');
  readonly isBusy = computed(() => this.isSaving() || this.isDeleting());

  t(key: string): string {
    return this.languageService.translate(key);
  }

  getControlLabel(label: { en: string; es: string }): string {
    if (!label || typeof label !== 'object') {
      return 'Invalid label';
    }
    const lang = this.languageService.getCurrentLanguage();
    return label[lang] ?? label.en ?? 'Invalid label';
  }

  shouldShowControl(control: ConfigControl): boolean {
    const event = this.event();
    if (!control.showIf) {
      return true;
    }

    if (!event?.config) {
      return false;
    }

    const sourceControl = event.config.find((c) => c.id === control.showIf!.controlId);

    if (!sourceControl) {
      return false;
    }

    const requiredValue = control.showIf.is;
    if (typeof requiredValue === 'boolean') {
      return !!sourceControl.value === requiredValue;
    }

    return sourceControl.value === requiredValue;
  }

  isCheerTierArray(value: unknown): value is CheerTier[] {
    return Array.isArray(value);
  }

  onTiersChange(control: ConfigControl, tiers: CheerTier[]): void {
    control.value = tiers;
  }

  onSave(): void {
    this.save.emit();
  }

  onDelete(): void {
    if (!this.canDelete()) {
      this.toastService.info(
        this.t('chatEvents.toasts.deleteNotAllowedTitle'),
        this.t('chatEvents.toasts.deleteNotAllowedMsg')
      );
      return;
    }
    this.delete.emit();
  }
}
