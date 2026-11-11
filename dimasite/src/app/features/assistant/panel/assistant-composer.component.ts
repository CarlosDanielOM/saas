import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { UpgradeService } from '../../../services/upgrade.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { AssistantStore, MAX_MESSAGE_CHARS } from '../assistant.store';
import { clockTime } from '../assistant-view';

const MAX_HEIGHT = 168;

/** Message box: Send; while a turn runs, Steer (or Queue for after) and Stop. Shows messages left today. */
@Component({
  selector: 'app-assistant-composer',
  imports: [ThrottleClickDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './assistant-composer.component.html',
  styleUrl: './assistant-composer.component.css',
})
export class AssistantComposerComponent {
  readonly store = inject(AssistantStore);
  private readonly i18n = inject(LanguageService);
  private readonly upgrade = inject(UpgradeService);
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  readonly max = MAX_MESSAGE_CHARS;
  readonly draft = signal('');
  readonly queueMode = signal(false);

  readonly mode = computed(() => (this.store.running() ? (this.queueMode() ? 'queue' : 'steer') : 'send'));
  readonly tooLong = computed(() => this.draft().length > MAX_MESSAGE_CHARS);
  readonly canSend = computed(() => !!this.draft().trim() && !this.tooLong() && !this.store.atLimit() && !!this.store.channelId() && !this.store.sending());
  readonly sendLabel = computed(() => this.t(`assistant.composer.${this.mode()}`));
  readonly locale = computed(() => (this.i18n.currentLanguage() === 'es' ? 'es-MX' : 'en'));
  readonly resetAt = computed(() => {
    const limits = this.store.limits();
    return limits ? clockTime(limits.resetsAt, this.locale()) : '';
  });
  readonly leftText = computed(() => {
    const limits = this.store.limits();
    const remaining = this.store.remaining();
    if (!limits || remaining === null) return '';
    return this.t('assistant.limits.left', { left: remaining, limit: limits.limit, time: this.resetAt() });
  });
  readonly lowOnMessages = computed(() => {
    const limits = this.store.limits();
    const remaining = this.store.remaining();
    return !!limits && remaining !== null && remaining > 0 && remaining <= Math.max(2, Math.ceil(limits.limit * 0.1));
  });
  /** Only the owner can change the plan; Pro is the top plan. */
  readonly canUpgrade = computed(() => this.store.status()?.role === 'owner' && !!this.store.limits() && this.store.limits()!.plan !== 'pro');
  readonly upgradeText = computed(() =>
    this.t(this.store.limits()?.plan === 'premium' ? 'assistant.limits.upgradePro' : 'assistant.limits.upgradePremium'),
  );
  readonly errorText = computed(() => {
    const error = this.store.sendError();
    if (!error) return '';
    const key = `assistant.errors.${error.code}`;
    const text = this.t(key);
    return text === key ? error.message || this.t('assistant.errors.unknown') : text;
  });
  readonly hint = computed(() => (this.store.running() ? this.t(`assistant.composer.hint.${this.mode()}`) : ''));

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  focus(): void {
    this.input()?.nativeElement.focus({ preventScroll: true });
  }

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    if (this.store.sendError()) this.store.sendError.set(null);
    this.grow();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      // A held-down Enter must not send twice (the draft is cleared on the first one anyway).
      if (!event.repeat) void this.submit();
    }
  }

  async submit(): Promise<void> {
    if (!this.canSend()) return;
    const text = this.draft().trim();
    const mode = this.mode();
    this.setDraft('');
    const sent = await this.store.send(text, mode);
    if (!sent && !this.draft()) this.setDraft(text);
    if (sent) this.queueMode.set(false);
  }

  toggleQueue(): void {
    this.queueMode.update((value) => !value);
  }

  stop(): void {
    void this.store.stop();
  }

  openUpgrade(): void {
    void this.upgrade.promptUpgradeForAnyPlan('site_assistant_limit');
  }

  /** Put text in the box for the person to edit and send (example prompts don't spend a message). */
  prefill(text: string): void {
    this.setDraft(text);
    this.focus();
  }

  private setDraft(text: string): void {
    this.draft.set(text);
    const element = this.input()?.nativeElement;
    if (element && element.value !== text) element.value = text;
    this.grow();
  }

  private grow(): void {
    const element = this.input()?.nativeElement;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }
}
