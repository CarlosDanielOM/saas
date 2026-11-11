import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { AssistantStore } from '../assistant.store';
import type { ChangeView } from '../assistant.types';
import { relativeTime } from '../assistant-view';
import { AssistantDiffComponent } from './assistant-diff.component';

/** Changes tab: what the assistant changed (owner: everyone's; admin: their own), with Undo. */
@Component({
  selector: 'app-assistant-changes',
  imports: [AssistantDiffComponent, ThrottleClickDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './assistant-changes.component.html',
  styleUrl: './assistant-changes.component.css',
})
export class AssistantChangesComponent {
  readonly store = inject(AssistantStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(LanguageService);
  private readonly auth = inject(SessionAuthService);

  readonly confirming = signal<string | null>(null);
  readonly owner = computed(() => this.store.status()?.role === 'owner');
  private readonly me = computed(() => this.auth.session()?.twitchUser.id ?? '');
  private readonly locale = computed(() => (this.i18n.currentLanguage() === 'es' ? 'es-MX' : 'en'));

  constructor() {
    if (this.store.changesState() === 'idle') void this.store.loadChanges();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  actor(change: ChangeView): string {
    if (change.actor.id === this.me()) return this.t('assistant.changes.you');
    return change.actor.displayName || change.actor.login;
  }

  when(at: number): string {
    return relativeTime(at, Date.now(), this.locale());
  }

  undoneText(change: ChangeView): string {
    if (!change.undone) return '';
    const by = change.undone.by.id === this.me() ? this.t('assistant.changes.you') : change.undone.by.login;
    return this.t('assistant.changes.undoneBy', { who: by, when: this.when(change.undone.at) });
  }

  undoError(change: ChangeView): string {
    const error = this.store.undoErrors()[change.id];
    if (!error) return '';
    if (error.code === 'undo_conflict') return this.t('assistant.changes.conflict');
    const key = `assistant.errors.${error.code}`;
    const text = this.t(key);
    return text === key ? error.message || this.t('assistant.errors.unknown') : text;
  }

  /** Current values the server sent with a 409, when it did (`data.current`). */
  conflictNow(change: ChangeView): Record<string, unknown> | null {
    const error = this.store.undoErrors()[change.id];
    const data = error?.code === 'undo_conflict' ? (error.data as Record<string, unknown> | null) : null;
    const current = data && typeof data === 'object' ? data['current'] : null;
    return current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : null;
  }

  async undo(change: ChangeView): Promise<void> {
    await this.store.undo(change.id);
    this.confirming.set(null);
    // The confirm buttons are gone: move focus to the row's title so the result is read next.
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-change-id="${change.id}"] .ch-title`)?.focus());
  }
}
