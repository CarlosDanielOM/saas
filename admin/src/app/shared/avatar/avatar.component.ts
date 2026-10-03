import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { AvatarService } from '../../services/avatar.service';

@Component({
  selector: 'app-avatar',
  template: `<span
    class="lf-avatar"
    [class.lf-avatar--live]="live()"
    [class.lf-avatar--lg]="size() === 'lg'"
    aria-hidden="true"
  >
    @if (src() && !failed()) {
      <img [src]="src()" alt="" loading="lazy" (error)="failed.set(true)" />
    } @else {
      {{ (name() || '?').charAt(0) }}
    }
  </span>`,
  styles: [':host { display: inline-flex; flex-shrink: 0; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AvatarComponent {
  private readonly avatars = inject(AvatarService);
  readonly name = input.required<string>();
  readonly live = input(false);
  readonly size = input<'md' | 'lg'>('md');
  /** Only look up real images where there are few avatars on screen. */
  readonly fetch = input(true);
  readonly failed = signal(false);
  readonly src = computed(() => (this.fetch() ? this.avatars.get(this.name())() : null));
}
