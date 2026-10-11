import { Directive, ElementRef, OnInit, inject, input } from '@angular/core';

/**
 * Starts every CSS animation under this element `duelClock` ms into its timeline.
 * The value is read once, when the element is created: the arena re-creates keyed
 * elements on every seek, so a scrubbed or paused frame shows exactly the right pose
 * while normal playback still runs on the browser's own (smoother) animation clock.
 * Styles opt in with `animation-delay: calc(var(--d, 0ms) - var(--sync, 0ms))`.
 */
@Directive({ selector: '[duelClock]' })
export class DuelClaudeClockDirective implements OnInit {
  readonly duelClock = input.required<number>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  ngOnInit(): void {
    this.element.nativeElement.style.setProperty('--sync', `${Math.max(0, Math.round(this.duelClock()))}ms`);
  }
}
