import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  template: `<span
    class="lf-skel"
    [style.border-radius]="variant() === 'circle' ? '999px' : null"
    [style.width]="width()"
    [style.height]="height() || '1rem'"
  ></span>`,
  styles: [':host { display: block; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkeletonComponent {
  readonly variant = input<'bar' | 'circle' | 'rect' | 'text'>('bar');
  readonly width = input<string>('100%');
  readonly height = input<string | undefined>(undefined);
}
