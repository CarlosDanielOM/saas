import { Directive, input, output } from '@angular/core';

/**
 * Click guard for action buttons: the first click runs right away, more clicks within
 * `throttleMs` (default 1 s) are ignored, so a double-click can't send two actions
 * (e.g. add the bot to chat and remove it again).
 *
 * `<button (appThrottleClick)="save()">` instead of `(click)`.
 */
@Directive({
  selector: '[appThrottleClick]',
  host: { '(click)': 'onClick($event)' }
})
export class ThrottleClickDirective {
  readonly throttleMs = input(1000);
  readonly appThrottleClick = output<MouseEvent>();

  private lastAt = -Infinity;

  onClick(event: MouseEvent): void {
    const now = performance.now();
    if (now - this.lastAt < this.throttleMs()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    this.lastAt = now;
    this.appThrottleClick.emit(event);
  }
}
