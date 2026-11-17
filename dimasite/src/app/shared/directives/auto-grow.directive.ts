import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Directive, ElementRef, HostListener, PLATFORM_ID, afterNextRender, effect, inject, input } from '@angular/core';

/**
 * Makes a `<textarea>` as tall as its text (up to its CSS `max-height`), so a long message wraps and
 * shows in full instead of being clipped on one line. Bind the text, `[appAutoGrow]="value"`, so it
 * also re-measures when the value changes from code. When empty it fits its placeholder.
 *
 * It measures again when the box gets a width or its width changes (a phone rotated, a panel that
 * was hidden), and when the placeholder changes (the language was switched).
 */
@Directive({
  selector: 'textarea[appAutoGrow]'
})
export class AutoGrowDirective {
  private readonly element = inject<ElementRef<HTMLTextAreaElement>>(ElementRef).nativeElement;
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);
  readonly appAutoGrow = input<unknown>('');
  private timer: ReturnType<typeof setTimeout> | null = null;
  private width = -1;

  constructor() {
    // ngModel writes the new value a tick after the binding changes: measure after that.
    effect(() => {
      this.appAutoGrow();
      if (!this.isBrowser) return;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.fit(); });
    });
    afterNextRender(() => {
      this.fit();
      const resize = new ResizeObserver(() => {
        // Only a width change moves the line breaks; reacting to our own height changes would loop.
        const width = this.element.clientWidth;
        if (width === this.width) return;
        this.width = width;
        this.fit();
      });
      resize.observe(this.element);
      const placeholder = new MutationObserver(() => this.fit());
      placeholder.observe(this.element, { attributes: true, attributeFilter: ['placeholder'] });
      this.destroyRef.onDestroy(() => { resize.disconnect(); placeholder.disconnect(); });
    });
    this.destroyRef.onDestroy(() => { if (this.timer !== null) clearTimeout(this.timer); });
  }

  @HostListener('input')
  fit(): void {
    const element = this.element;
    if (!this.isBrowser || !element.isConnected || element.clientWidth === 0) return;
    element.style.height = 'auto';
    const borders = element.offsetHeight - element.clientHeight;
    element.style.height = `${Math.max(element.scrollHeight, this.placeholderHeight()) + borders}px`;
  }

  /**
   * Height the placeholder needs when the box is empty (often the default message, shown in full).
   * Measured on a hidden copy: the real box's value is never touched, so typing, undo and
   * keyboards that compose text are left alone.
   */
  private placeholderHeight(): number {
    const element = this.element;
    if (element.value || !element.placeholder || !element.parentElement) return 0;
    const copy = element.cloneNode(false) as HTMLTextAreaElement;
    copy.removeAttribute('id');
    copy.removeAttribute('placeholder');
    copy.setAttribute('aria-hidden', 'true');
    copy.tabIndex = -1;
    copy.value = element.placeholder;
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', height: 'auto', width: `${element.offsetWidth}px`, left: '0', top: '0' });
    element.parentElement.appendChild(copy);
    const height = copy.scrollHeight;
    copy.remove();
    return height;
  }
}
