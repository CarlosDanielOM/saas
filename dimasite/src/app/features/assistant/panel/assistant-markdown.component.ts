import { ChangeDetectionStrategy, Component, ElementRef, SecurityContext, ViewEncapsulation, effect, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

import { LanguageService } from '../../../services/language.service';
import { renderAssistantMarkdown } from '../assistant-markdown';

/**
 * Renders an assistant answer with the safe Markdown renderer (everything escaped first), then
 * runs Angular's HTML sanitizer as a second fence. Code blocks get a Copy button in their bar.
 */
@Component({
  selector: 'app-assistant-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: '',
  host: {
    class: 'am',
    '[attr.aria-busy]': 'streaming() ? "true" : null',
    '(click)': 'onClick($event)',
  },
  styleUrl: './assistant-markdown.component.css',
})
export class AssistantMarkdownComponent {
  readonly text = input.required<string>();
  readonly streaming = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly i18n = inject(LanguageService);
  private readonly copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

  constructor() {
    effect(() => {
      const html = this.sanitizer.sanitize(SecurityContext.HTML, renderAssistantMarkdown(this.text())) ?? '';
      const copy = this.i18n.translate('assistant.markdown.copy');
      const element = this.host.nativeElement;
      element.innerHTML = html;
      element.querySelectorAll<HTMLElement>('.am-code').forEach((box) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'am-copy';
        button.textContent = copy;
        box.querySelector('.am-code__bar')?.append(button);
      });
    });
  }

  async onClick(event: MouseEvent): Promise<void> {
    const button = (event.target as Element | null)?.closest<HTMLElement>('.am-copy');
    if (!button || !this.host.nativeElement.contains(button)) return;
    const code = button.closest('.am-code')?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = this.i18n.translate('assistant.markdown.copied');
      clearTimeout(this.copiedTimers.get(button));
      this.copiedTimers.set(
        button,
        setTimeout(() => (button.textContent = this.i18n.translate('assistant.markdown.copy')), 1500),
      );
    } catch {
      button.textContent = this.i18n.translate('assistant.markdown.copyFailed');
    }
  }
}
