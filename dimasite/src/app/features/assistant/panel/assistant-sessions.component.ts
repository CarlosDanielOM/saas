import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, output, signal } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { AssistantStore } from '../assistant.store';
import { relativeTime } from '../assistant-view';

/** Chat list layer inside the panel: open, start new, delete (with an inline confirm). */
@Component({
  selector: 'app-assistant-sessions',
  imports: [LfIconComponent, ThrottleClickDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="as-head">
      <h3 class="as-title" id="assistant-chats-title" tabindex="-1">{{ t('assistant.sessions.title') }}</h3>
      <button type="button" class="as-btn as-btn--primary" (appThrottleClick)="startNew()">
        <app-lf-icon name="plus" [size]="15" />{{ t('assistant.sessions.new') }}
      </button>
      <button type="button" class="as-icon" [attr.aria-label]="t('assistant.sessions.close')" (click)="closed.emit()">
        <app-lf-icon name="close" [size]="16" />
      </button>
    </div>
    <p class="as-note">{{ t('assistant.sessions.kept') }}</p>

    @switch (store.sessionsState()) {
      @case ('loading') {
        <p class="as-state" role="status">{{ t('assistant.sessions.loading') }}</p>
      }
      @case ('error') {
        <div class="as-state" role="alert">
          <p>{{ t('assistant.sessions.loadFailed') }}</p>
          <button type="button" class="as-btn" (appThrottleClick)="store.loadSessions()">{{ t('assistant.retry') }}</button>
        </div>
      }
      @default {
        @if (!store.sessions().length) {
          <p class="as-state">{{ t('assistant.sessions.empty') }}</p>
        } @else {
          <ul class="as-list" [attr.aria-labelledby]="'assistant-chats-title'">
            @for (session of store.sessions(); track session.id) {
              <li class="as-row" [class.as-row--current]="session.id === store.sessionId()">
                @if (confirming() === session.id) {
                  <div class="as-confirm" role="group" [attr.aria-label]="t('assistant.sessions.deleteConfirm', { title: titleOf(session.title) })">
                    <p>{{ t('assistant.sessions.deleteConfirm', { title: titleOf(session.title) }) }}</p>
                    <div class="as-confirm__actions">
                      <button type="button" class="as-btn" (click)="confirming.set(null)">{{ t('assistant.cancel') }}</button>
                      <button type="button" class="as-btn as-btn--danger" [disabled]="deleting() === session.id" (appThrottleClick)="remove(session.id)">{{ t('assistant.sessions.delete') }}</button>
                    </div>
                  </div>
                } @else {
                  <button type="button" class="as-open" [attr.aria-current]="session.id === store.sessionId() ? 'true' : null" (appThrottleClick)="open(session.id)">
                    <span class="as-open__title">{{ titleOf(session.title) }}</span>
                    <span class="as-open__meta">
                      @if (session.activeTurnId) {
                        <span class="as-live">{{ t('assistant.sessions.working') }}</span> ·
                      }
                      {{ when(session.updatedAt) }}
                    </span>
                  </button>
                  <button type="button" class="as-icon" [attr.aria-label]="t('assistant.sessions.deleteLabel', { title: titleOf(session.title) })" (click)="confirming.set(session.id)">
                    <app-lf-icon name="trash" [size]="15" />
                  </button>
                }
              </li>
            }
          </ul>
        }
      }
    }
    @if (failed()) {
      <p class="as-error" role="alert">{{ t('assistant.sessions.deleteFailed') }}</p>
    }
  `,
  styleUrl: './assistant-sessions.component.css',
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class AssistantSessionsComponent {
  readonly closed = output<void>();
  readonly picked = output<void>();

  readonly store = inject(AssistantStore);
  private readonly i18n = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly confirming = signal<string | null>(null);
  readonly deleting = signal<string | null>(null);
  readonly failed = signal(false);
  private readonly locale = computed(() => (this.i18n.currentLanguage() === 'es' ? 'es-MX' : 'en'));

  constructor() {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('.as-title')?.focus());
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  titleOf(title: string): string {
    return title?.trim() || this.t('assistant.sessions.untitled');
  }

  when(at: number): string {
    return relativeTime(at, Date.now(), this.locale());
  }

  open(sessionId: string): void {
    if (sessionId !== this.store.sessionId()) void this.store.openSession(sessionId);
    this.picked.emit();
  }

  startNew(): void {
    this.store.newChat();
    this.picked.emit();
  }

  async remove(sessionId: string): Promise<void> {
    this.deleting.set(sessionId);
    this.failed.set(false);
    const ok = await this.store.deleteSession(sessionId);
    this.deleting.set(null);
    this.confirming.set(null);
    this.failed.set(!ok);
    // The row (and the button that had focus) is gone: keep focus in the list.
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.as-title')?.focus());
  }

  onEscape(event: Event): void {
    event.stopPropagation();
    if (this.confirming()) this.confirming.set(null);
    else this.closed.emit();
  }
}
