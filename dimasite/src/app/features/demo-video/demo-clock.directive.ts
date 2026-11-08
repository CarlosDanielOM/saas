import { Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';

/**
 * Drives every CSS/Web animation under it from the scene clock, like the duel's astraClock: each animation is
 * paused and set to `t - origin`, where origin is the nearest `data-clock-origin` (the ms its element appeared).
 * Animations without an origin start when first seen. Subtrees marked `data-self-clock` (duel, alert replay)
 * already seek their own animations from scene time and are left alone.
 * Result: the same frame for the same t, in a browser preview (scrubbing works) and in the frame-by-frame recorder.
 */
@Directive({ selector: '[demoClock]' })
export class DemoClockDirective {
  readonly demoClock = input.required<number>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly firstSeen = new WeakMap<Animation, number>();

  constructor() {
    afterRenderEffect(() => {
      const t = this.demoClock();
      for (const animation of this.host.getAnimations({ subtree: true })) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (!(target instanceof Element) || target.closest('[data-self-clock]')) continue;
        const marked = target.closest('[data-clock-origin]')?.getAttribute('data-clock-origin');
        let origin = marked === undefined || marked === null ? NaN : Number(marked);
        if (!Number.isFinite(origin)) {
          origin = this.firstSeen.get(animation) ?? t;
          this.firstSeen.set(animation, origin);
        }
        animation.pause();
        animation.currentTime = Math.max(0, t - origin);
      }
    });
  }
}
