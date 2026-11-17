import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AutoGrowDirective } from '../../../shared/directives/auto-grow.directive';

import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import {
  ChatEvent,
  ChatEventPendingAction,
  ConfigControl,
  PlanTier
} from '../chat-events.model';
import { BitsRulesPanelComponent } from '../../bits-rules/bits-rules-panel.component';

@Component({
  selector: 'app-config-panel',
  imports: [FormsModule, BitsRulesPanelComponent, AutoGrowDirective],
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
  readonly canManage = input(false);
  readonly channelId = input<string | null>(null);
  /** Overlay Studio link for the Bits rules panel (channel owner only). */
  readonly overlayLink = input<string[] | null>(null);
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

  readonly hasBitsRules = computed(() => this.event()?.config?.some(control => control.type === 'message-tiers') ?? false);

  readonly isChatNotification = computed(() => this.event()?.type === 'channel.chat.notification');

  isWatchStreakMessage(control: ConfigControl): boolean {
    return this.isChatNotification() && (control.dbId || control.id) === 'message';
  }

  isModiversaryMessage(control: ConfigControl): boolean {
    return this.isChatNotification() && (control.dbId || control.id) === 'modiversaryMessage';
  }

  getNotificationHelpKey(control: ConfigControl): string {
    return this.isModiversaryMessage(control) ? 'chatEvents.modiversary' : 'chatEvents.watchStreak';
  }

  getControlPlaceholder(control: ConfigControl): string {
    return this.isWatchStreakMessage(control) || this.isModiversaryMessage(control)
      ? this.t(this.getNotificationHelpKey(control) + '.defaultMessage')
      : control.placeholder || '';
  }

  /**
   * A chat message is one line: every line break (a paste, the Enter key of a phone keyboard) becomes
   * one space, in the box itself and in the saved value together, so what is shown is what is saved.
   * Nothing else is touched (other spaces stay), and the caret stays where it was. Text still being
   * composed by the keyboard is left alone until it is committed.
   */
  onTextInput(control: ConfigControl, event: Event): void {
    const box = event.target as HTMLTextAreaElement;
    if ((event as InputEvent).isComposing) return;
    const breaks = /\r\n?|\n/g;
    if (breaks.test(box.value)) {
      const caret = box.value.slice(0, box.selectionStart ?? box.value.length).replace(breaks, ' ').length;
      box.value = box.value.replace(breaks, ' ');
      box.setSelectionRange(caret, caret);
    }
    control.value = box.value;
  }

  /** Enter never adds a line; while the keyboard is composing text, Enter is what commits it. */
  onEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (!key.isComposing && key.keyCode !== 229) key.preventDefault();
  }

  restoreDefault(control: ConfigControl): void {
    if (!this.canManage() || this.isBusy()) return;
    // Empty means the default in the channel's language, including future changes.
    control.value = '';
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  getControlLabel(label: { en: string; es: string }): string {
    if (!label || typeof label !== 'object') {
      return this.t('chatEvents.invalidLabel');
    }
    const lang = this.languageService.getCurrentLanguage();
    return (label[lang] || label.en) || this.t('chatEvents.invalidLabel');
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

  onSave(): void {
    if (!this.canManage()) return;
    this.save.emit();
  }

  onDelete(): void {
    if (!this.canManage()) return;
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
