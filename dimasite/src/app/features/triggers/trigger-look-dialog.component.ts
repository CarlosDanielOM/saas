import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, input, output, viewChild } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { OverlayEditorComponent } from '../overlays/overlay-editor.component';
import type { TriggerLookClosed, TriggerLookTarget } from './triggers.model';

/**
 * Full-screen dialog of the Triggers page: the Overlay Studio editor in look mode for one trigger. The editor chunk
 * loads only when this opens (`@defer`), and the editor gets no Overlay Studio state (channel admins use it too).
 */
@Component({
  selector: 'app-trigger-look-dialog',
  imports: [OverlayEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './trigger-look-dialog.component.css',
  host: { '(document:focusin)': 'keepFocus($event)' },
  template: `
    <div class="tld" role="dialog" aria-modal="true" tabindex="-1" [attr.aria-label]="t('triggers.look.dialogLabel', { name: target().name })">
      @defer (on immediate) {
        <app-overlay-editor #editor [look]="target()" (lookClosed)="closed.emit($event)" />
      } @placeholder {
        <p class="tld__state" role="status">{{ t('triggers.look.opening') }}</p>
      } @loading {
        <p class="tld__state" role="status">{{ t('triggers.look.opening') }}</p>
      } @error {
        <div class="tld__state" role="alert">
          <p>{{ t('triggers.look.openFailed') }}</p>
          <div class="tld__actions">
            <button type="button" class="tld__btn tld__btn--primary" (click)="retry()">{{ t('triggers.look.retry') }}</button>
            <button type="button" class="tld__btn" (click)="closed.emit({ triggerId: target().triggerId, changed: false, look: null })">{{ t('common.close') }}</button>
          </div>
        </div>
      }
    </div>`
})
export class TriggerLookDialogComponent {
  readonly target = input.required<TriggerLookTarget>();
  readonly closed = output<TriggerLookClosed>();
  private readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /** The editor once its chunk has loaded (typed loosely so the page doesn't import the editor eagerly). */
  private readonly editor = viewChild<{ lookCanLeave(): boolean }>('editor');

  /** In-app navigation away from the page: the open look decides (unsaved changes ask, a running save waits). */
  canLeave(): boolean { return this.editor()?.lookCanLeave() ?? true; }

  constructor() {
    const opener = document.activeElement as HTMLElement | null, root = document.documentElement, overflow = root.style.overflow;
    // The page under the dialog doesn't scroll while it is open.
    root.style.overflow = 'hidden';
    afterNextRender(() => (this.host.querySelector('.tld') as HTMLElement | null)?.focus({ preventScroll: true }));
    inject(DestroyRef).onDestroy(() => { root.style.overflow = overflow; opener?.focus?.({ preventScroll: true }); });
  }

  t(key: string, params?: Record<string, string | number>): string { this.language.currentLanguage(); return this.language.translate(key, params); }

  /** A chunk that failed to download stays failed in this page; loading the page again fetches it anew. */
  retry(): void { location.reload(); }

  /** Focus never wanders to the Triggers page behind the dialog. */
  keepFocus(event: FocusEvent): void {
    const target = event.target as Node | null;
    if (target && !this.host.contains(target)) (this.host.querySelector('.tld') as HTMLElement | null)?.focus({ preventScroll: true });
  }
}
