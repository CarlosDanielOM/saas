import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  template: `
    <div
      class="skeleton"
      [class.skeleton--circle]="variant() === 'circle'"
      [class.skeleton--rect]="variant() === 'rect'"
      [class.skeleton--text]="variant() === 'text'"
      [style.width]="width()"
      [style.height]="height()"
    ></div>
  `,
  styles: [`
    .skeleton {
      background: linear-gradient(
        90deg,
        rgba(55, 65, 81, 0.4) 0%,
        rgba(55, 65, 81, 0.7) 50%,
        rgba(55, 65, 81, 0.4) 100%
      );
      background-size: 200% 100%;
      animation: shimmer 1.5s ease-in-out infinite;
      border-radius: 0.375rem;
    }

    .skeleton--circle {
      border-radius: 50%;
    }

    .skeleton--rect {
      border-radius: 0.75rem;
    }

    .skeleton--text {
      border-radius: 0.25rem;
      height: 1rem;
    }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SkeletonComponent {
  readonly variant = input<'bar' | 'circle' | 'rect' | 'text'>('bar');
  readonly width = input<string>('100%');
  readonly height = input<string | undefined>(undefined);
}
