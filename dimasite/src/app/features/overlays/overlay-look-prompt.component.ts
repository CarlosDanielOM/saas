import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, input, output } from '@angular/core';

export interface LookPromptAction { id: string; label: string; kind?: 'primary' | 'danger' | 'plain' }

/**
 * A small alert dialog of the look editor ("unsaved changes", "remove look"): says what happens, offers explained
 * choices. Escape and the backdrop choose `cancel`; Tab stays inside.
 */
@Component({
  selector: 'app-overlay-look-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay-look-prompt.component.css',
  host: { '(keydown)': 'onKeydown($event)' },
  template: `
    <div class="lp-backdrop" aria-hidden="true" (click)="chosen.emit(cancel())"></div>
    <section class="lp-panel" role="alertdialog" aria-modal="true" aria-labelledby="lp-title" aria-describedby="lp-message">
      <h2 class="lp-title" id="lp-title">{{ heading() }}</h2>
      <p class="lp-message" id="lp-message">{{ message() }}</p>
      <div class="lp-actions">
        @for (action of actions(); track action.id) {
          <button type="button" class="lp-btn" [class.lp-btn--primary]="action.kind === 'primary'" [class.lp-btn--danger]="action.kind === 'danger'"
            [attr.data-action]="action.id" [disabled]="busy()" (click)="chosen.emit(action.id)">{{ action.label }}</button>
        }
      </div>
    </section>`
})
export class OverlayLookPromptComponent {
  readonly heading = input.required<string>();
  readonly message = input.required<string>();
  readonly actions = input.required<LookPromptAction[]>();
  /** The choice for Escape / backdrop (keep editing, cancel). */
  readonly cancel = input('cancel');
  readonly busy = input(false);
  readonly chosen = output<string>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    const opener = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
    inject(DestroyRef).onDestroy(() => opener?.focus?.({ preventScroll: true }));
    afterNextRender(() => (this.host.querySelector(`[data-action="${this.cancel()}"]`) as HTMLElement | null ?? this.host.querySelector('button'))?.focus());
  }
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!this.busy()) this.chosen.emit(this.cancel()); return; }
    if (event.key !== 'Tab') return;
    const buttons = [...this.host.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    if (!buttons.length) return;
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}
