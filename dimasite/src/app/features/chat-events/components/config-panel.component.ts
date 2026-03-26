import { ChangeDetectionStrategy, Component, input, output, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Crown, Save, Trash2 } from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { ChatEventPendingAction, ConfigControl, ChatEvent, CheerTier, PlanTier } from '../chat-events.model';
import { TierEditorComponent } from './tier-editor.component';

@Component({
  selector: 'app-config-panel',
  imports: [FormsModule, LucideAngularModule, TierEditorComponent],
  template: `
    <div class="config-panel">
      <h4 class="config-panel__title">{{ t('chatEvents.configuration') }}</h4>

      <div class="config-panel__controls">
        @for (control of event()?.config; track control.id) {
          @if (shouldShowControl(control)) {
            <div class="config-panel__control">
              <label [for]="'control-' + control.id" class="config-panel__label">
                <span>{{ getControlLabel(control.label) }}</span>
                @if (control.id === 'cheerTiers') {
                  <lucide-icon [name]="crownIcon" class="config-panel__label-icon"></lucide-icon>
                }
              </label>

              @switch (control.type) {
                @case ('text') {
                    <input
                      type="text"
                      [id]="'control-' + control.id"
                      [(ngModel)]="control.value"
                      [disabled]="isBusy()"
                      [placeholder]="control.placeholder || ''"
                      class="config-panel__input" />
                }
                @case ('number') {
                    <input
                      type="number"
                      [id]="'control-' + control.id"
                      [(ngModel)]="control.value"
                      [disabled]="isBusy()"
                      class="config-panel__input config-panel__input--number" />
                }
                @case ('checkbox') {
                  <div class="config-panel__checkbox-wrapper">
                    <input
                      type="checkbox"
                      [id]="'control-' + control.id"
                      [(ngModel)]="control.value"
                      [disabled]="isBusy()"
                      class="config-panel__checkbox" />
                    <label [for]="'control-' + control.id" class="config-panel__checkbox-label">
                      {{ t('chatEvents.enabled') }}
                    </label>
                  </div>
                }
                @case ('message-tiers') {
                  @if (isCheerTierArray(control.value)) {
                    <app-tier-editor
                      [tiers]="control.value"
                      [tierLimits]="event()?.tierLimits"
                      [userPlan]="userPlan()"
                      [disabled]="isBusy()"
                      (tiersChange)="onTiersChange(control, $event)" />
                  }
                }
              }
            </div>
          }
        }
      </div>

      <div class="config-panel__actions">
        <button
          type="button"
          class="config-panel__btn config-panel__btn--delete"
          [class.config-panel__btn--pending]="isDeleting()"
          [class.config-panel__btn--disabled]="!canDelete()"
          [disabled]="!canDelete() || isBusy()"
          [title]="!canDelete() ? t('chatEvents.tooltips.deleteNotAllowed') : t('chatEvents.deleteEvent')"
          (click)="onDelete()">
          <lucide-icon [name]="trashIcon" class="config-panel__btn-icon"></lucide-icon>
          {{ isDeleting() ? t('chatEvents.pending.deleting') : t('chatEvents.deleteEvent') }}
        </button>

        <button
          type="button"
          class="config-panel__btn config-panel__btn--save"
          [class.config-panel__btn--pending]="isSaving()"
          [disabled]="isBusy()"
          (click)="onSave()">
          <lucide-icon [name]="saveIcon" class="config-panel__btn-icon"></lucide-icon>
          {{ isSaving() ? t('chatEvents.pending.saving') : t('chatEvents.saveChanges') }}
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConfigPanelComponent {
  private readonly languageService = inject(LanguageService);

  readonly event = input<ChatEvent | undefined>(undefined);
  readonly userPlan = input.required<PlanTier>();
  readonly pendingAction = input<ChatEventPendingAction>('none');
  readonly save = output<void>();
  readonly delete = output<void>();

  readonly crownIcon = Crown;
  readonly saveIcon = Save;
  readonly trashIcon = Trash2;

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

    const sourceControl = event.config.find(c => c.id === control.showIf!.controlId);

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
    this.delete.emit();
  }
}
