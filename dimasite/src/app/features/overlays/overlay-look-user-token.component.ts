import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, effect, inject, input, output, viewChild } from '@angular/core';
import { LucideAngularModule, UserPlus } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';

/** The token a trigger look's text uses for whoever fired the trigger. */
export const LOOK_USER_TOKEN = '$(user)';

/**
 * Look mode: one action next to a text object's template that inserts `$(user)` (who fired the trigger) at the
 * field's cursor, or appends it when the field wasn't in use. The host applies the new text through its normal edit
 * path (one undo step); focus goes back to the field with the cursor right after the token.
 */
@Component({
  selector: 'app-overlay-look-user-token', changeDetection: ChangeDetectionStrategy.OnPush, imports: [LucideAngularModule],
  template: `<button #button type="button" class="insert" (pointerdown)="remember()" (mousedown)="$event.preventDefault()" (click)="insert()" (blur)="caret = null">
    <lucide-icon [name]="icon" [size]="16" aria-hidden="true" /><span>{{ t('lookInsertUser') }}</span><code>{{ token }}</code>
  </button>`,
  styleUrl: './overlay-look-user-token.component.css'
})
export class OverlayLookUserTokenComponent {
  /** The text template field this action writes into. */
  readonly field = input.required<HTMLTextAreaElement>();
  /** The new template text (the host records it as one edit). */
  readonly inserted = output<string>();
  readonly icon = UserPlus;
  readonly token = LOOK_USER_TOKEN;
  private readonly language = inject(LanguageService);
  private readonly injector = inject(Injector);
  private readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('button');
  /** The field's selection when focus went from it straight to this button (pointer or Tab); dropped when focus moves on. */
  caret: { start: number; end: number } | null = null;
  /** Bumped by every insert and every keystroke in the field: a deferred cursor fix only applies if nothing came after it. */
  private version = 0;

  constructor() {
    effect(onCleanup => {
      const field = this.field();
      // Another text object (another field): nothing remembered from the previous one applies.
      this.caret = null;
      const blur = (event: FocusEvent) => { this.caret = event.relatedTarget === this.button().nativeElement ? this.selection(field) : null; };
      const typed = () => { this.version++; };
      field.addEventListener('blur', blur); field.addEventListener('input', typed);
      onCleanup(() => { field.removeEventListener('blur', blur); field.removeEventListener('input', typed); });
    });
  }

  t(key: string): string { this.language.currentLanguage(); return this.language.translate('overlayStudio.' + key); }

  remember(): void {
    const field = this.field();
    if (document.activeElement === field) this.caret = this.selection(field);
  }

  insert(): void {
    const field = this.field(), value = field.value;
    const caret = this.caret ?? (document.activeElement === field ? this.selection(field) : null);
    this.caret = null;
    let next: string, at: number;
    if (caret) {
      next = value.slice(0, caret.start) + this.token + value.slice(caret.end); at = caret.start + this.token.length;
    } else {
      // Not in the field: append, with a space when the text doesn't end with one.
      const gap = value && !/\s$/.test(value) ? ' ' : '';
      next = value + gap + this.token; at = next.length;
    }
    // Field and model change together, so a second insert or a keystroke before the next render builds on this text.
    field.value = next;
    field.focus({ preventScroll: true });
    field.setSelectionRange(at, at);
    this.inserted.emit(next);
    // Should the re-render still move the cursor, put it back, unless the field was edited (or inserted into) since.
    const stamp = ++this.version;
    afterNextRender({ write: () => {
      if (stamp !== this.version || !field.isConnected || field.value !== next || document.activeElement !== field) return;
      if (field.selectionStart !== at || field.selectionEnd !== at) field.setSelectionRange(at, at);
    } }, { injector: this.injector });
  }

  private selection(field: HTMLTextAreaElement): { start: number; end: number } {
    const length = field.value.length;
    return { start: Math.min(field.selectionStart ?? length, length), end: Math.min(field.selectionEnd ?? length, length) };
  }
}
