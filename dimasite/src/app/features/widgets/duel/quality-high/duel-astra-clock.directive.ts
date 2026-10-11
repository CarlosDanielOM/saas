import { Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';

/** One battle clock drives the entire SVG/CSS rig: pause and reverse scrubbing
 * reconstruct the same frame. No timers, RAF loops, or live-service connections. */
@Directive({ selector: '[astraClock]' })
export class DuelAstraClockDirective {
  readonly astraClock = input.required<number>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterRenderEffect(() => {
      const time = this.astraClock();
      for (const animation of this.element.nativeElement.getAnimations({ subtree: true })) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (!(target instanceof Element)) continue;
        const origin = Number(target.closest('[data-clock-origin]')?.getAttribute('data-clock-origin') ?? 0);
        animation.pause();
        animation.currentTime = Math.max(0, time - origin);
      }
    });
  }
}
